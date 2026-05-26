# ADR-0036: Typed Event Bus SSE Projection (Optional Node-Mode Surface)

## Context

agrun runtime already emits a typed event ledger (v1 schema with
`{ id, runId, sequence, cycle, ts, mode, visibility, phase, type,
payload }`) via
[src/runtime/runtime-event-ledger.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-event-ledger.js)
and
[src/runtime/runtime-event-classifier.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-event-classifier.js).
Every `pushStep` call dual-writes: legacy `steps[]` plus
`ledger.appendEvent(type, detail, mode)`. The browser Inspector
(InspectorPanel.tsx) reads the ledger to render 7 projections
(OODAE timeline, LLM trace, AI workflow, lifecycle, cost ledger,
evidence graph, runtime summary). This was AGRUN-248-C Phase 1/2,
completed 2026-05-25.

**The gap.** The only external observation surface today is the
`onStep(step, runState)` callback hook, which is **in-process only**.
An engineer running agrun in Node mode (CLI host, evaluation harness,
another process) cannot subscribe to the event stream from outside the
JS runtime. To debug an agrun run that has been going for several
minutes, the engineer either:

1. Waits for the run to finish and reads `agrun_debug_runs/*.md`, or
2. Adds bespoke logging inside their host process around `onStep`, or
3. Re-runs the same task in the browser to use the Inspector.

None of these work for a separate observer process (an external
inspector, an eval CLI, a CI logging service) that the agrun runtime
does not know about.

Empirical evidence (2026-05-25, opencode v1.1.48 vs agrun, same
gemini-3.1-flash-lite + variant=low, same 3000-word prompt; bus.log +
events.jsonl preserved at `/tmp/opencode-3000-test/`):

| Surface                                  | opencode | agrun |
|------------------------------------------|----------|-------|
| Typed event schema                       | yes (TS) | yes (`runtime-event-ledger.js` v1) |
| In-process subscribe                     | yes      | yes (`onStep`) |
| External SSE subscribe                   | yes (`GET /event`) | **no** |
| Per-message JSON storage                 | yes (`storage/message/ses_X/msg_Y.json`) | no (markdown trace only) |
| Live error visibility from outside       | 1 sec via `session.error` event | minutes (host has to surface) |

The opencode run produced a 295KB `events.jsonl` over 4 agent loop
steps — 17 distinct typed event types (`session.created/updated/idle/
error/diff`, `message.updated`, `message.part.updated` with sub-types
text / tool / reasoning / step-start / step-finish, `busy`, `idle`,
`file.edited`, `command.executed`, `server.connected/heartbeat`).
We confirmed empirically that an external client (`curl -N` on the SSE
endpoint) sees the agent loop live as it runs, and a 403 error
surfaced 1 second after the failed model call.

Affected modules / contracts:

- [src/runtime/runtime-event-ledger.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-event-ledger.js)
  — current sink for typed events.
- [src/runtime/runtime-event-classifier.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-event-classifier.js)
  — visibility / phase classification, reused.
- [src/index.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/index.js) — `createRuntime` exports the
  runtime object that hosts use; would gain an optional event-subscribe
  API.
- [node/](node/) — current Node-mode entrypoints; this is where
  an optional SSE adapter would live (NOT in core).
- [agrun_docs/audits/sample-study-runtime-reverse-audit-2026-05-24.md](../audits/sample-study-runtime-reverse-audit-2026-05-24.md)
  — listed typed event stream as P1 for inspector consumers; SSE is
  the external-process complement.

## Decision

Add a **single new in-process subscription API** on the runtime
object, and **a separate, opt-in SSE adapter module** that hosts can
mount on their own HTTP server. The runtime core does NOT ship an
HTTP server; that stays the host's responsibility, preserving the
"Keep runtime simple" CLAUDE.md rule.

### Runtime contract additions

1. New method on the runtime returned by `createRuntime(...)`:

   ```js
   const unsubscribe = runtime.subscribeEvents((event) => { ... }, {
     since: lastSequence,    // resume from a known sequence id (optional)
     types: ['planner-*'],   // glob filter on event.type (optional)
     visibility: ['agent']   // filter on classifier visibility (optional)
   });
   ```

   - `event` is the same v1 typed record already appended to the
     ledger; no new schema.
   - `subscribeEvents` is callable any time after `createRuntime`,
     including during `runtime.run()`. New subscribers receive every
     event from `options.since` onward, and stay live for subsequent
     events until they `unsubscribe`.
   - Backed by a small in-process emitter inside
     `runtime-event-ledger.js` (no third-party EventEmitter dep). The
     emitter is also what `onStep` already calls; `onStep` becomes a
     thin compatibility shim.

2. New optional adapter module
   `node/runtime-sse-adapter.js` that takes a runtime instance and
   returns a request handler compatible with Node's `http` module,
   Express, Fastify, Hono, and the Web Streams `Response` (Bun /
   Cloudflare / Deno). The adapter does:

   ```js
   import { createRuntime } from 'agrun';
   import { createSseHandler } from 'agrun/node/runtime-sse-adapter';

   const runtime = createRuntime({ /* ... */ });
   const sseHandler = createSseHandler(runtime, {
     heartbeatMs: 15000,
     headers: { /* host-controlled CORS, auth */ }
   });

   // host's existing HTTP server mounts it:
   app.get('/event', sseHandler);
   ```

   The adapter:
   - Subscribes to `runtime.subscribeEvents(...)` and writes each
     event as `data: <json>\n\n`.
   - Emits a periodic `server.heartbeat` keepalive.
   - Closes cleanly when the client disconnects.
   - Optional `?since=<sequence>` query param for resume on reconnect.
   - No auth, no rate limiting — host wires those.

3. No change to the event schema. v1 stays v1. The same record is
   what `onStep`, `eventLedger.events`, the new emitter, and the SSE
   adapter all see.

4. No bundled HTTP server. agrun core (`src/`) remains zero-HTTP-deps.
   The adapter ships under `node/` and is only imported when the host
   wants it.

### Host-facing knobs

- No new feature flag. Subscribing is opt-in by importing the API.
- The browser Inspector continues to work unchanged: it uses `onStep`
  via the compatibility shim.
- Hosts that want external observation:
  - Build a tiny Node script (10 lines) that creates the runtime,
    mounts the SSE handler, and starts a server.
  - Point any SSE client (`curl -N`, EventSource, opencode-style
    inspector) at `http://localhost:<port>/event`.

### Out of scope

- Per-message persisted JSON files (the opencode `storage/message/`
  pattern). That is a separate concern about post-mortem replay; it
  belongs in a different ADR. The ledger already gives the data;
  serializing per-message JSON is purely a sink-side decision.
- Permission-backed plan mode (opencode pattern). Separate ADR.
- Subagent child sessions (TaskTool pattern). Separate ADR.
- Compaction as a real turn (opencode pattern). Already partly tracked
  under a different audit; not part of this RFC.
- Cross-language clients (WebSocket, gRPC). SSE is the smallest
  cross-process surface that works in every language and behind every
  proxy.

## Alternatives

1. **Embed an HTTP server in agrun core.** Rejected — violates the
   "Keep runtime simple" CLAUDE.md rule. Adds at minimum
   ~1.5MB to the bundle (Hono / Fastify / Express) and a port concern
   that browser users do not have. The adapter-under-`node/` pattern
   gives the same capability to Node hosts without taxing browser users.

2. **Make `onStep` async-iterable** instead of adding `subscribeEvents`.
   Considered but rejected — async iterators are awkward for
   long-lived streams that may emit thousands of events. Callback +
   `unsubscribe` is simpler and matches the existing `onStep` shape.

3. **Use WebSocket instead of SSE.** Rejected — SSE is unidirectional
   server→client which is exactly what observers need; no client→server
   surface area; works through every HTTP proxy; uses a plain HTTP/1.1
   connection. WebSocket adds upgrade handshake complexity for no gain
   in the observer use case.

4. **Persist events to a file the observer tails** (`tail -f
   agrun-events.jsonl`). Considered as a poor man's bus. Rejected —
   filesystem-only means no cross-machine debugging, no JSON parsing
   guarantee per line if the writer crashes mid-line, no resume
   semantics. SSE solves all three with one connection.

5. **Wait for a future "agrun serve" mode.** Considered. Rejected —
   the adapter pattern lets hosts integrate now without committing
   the runtime to a long-term server lifecycle, and matches how
   opencode actually evolved (the SSE bus came before a generic
   server abstraction).

## Consequences

- Pros:
  - External processes can subscribe to a running agrun in real time
    (1-line `curl -N` reproduces the opencode debugging workflow).
  - Closes the AGRUN-248-C reverse-audit P1 "inspector consumers
    need a typed stream" gap for the cross-process case.
  - No change to browser-mode behavior; Inspector keeps working
    unchanged via the `onStep` compatibility shim.
  - No new runtime-core dependencies; adapter is opt-in and lives in
    `node/`.
  - The same event schema (v1) powers in-process Inspector AND
    out-of-process SSE — one SSOT, multiple projections.

- Cons:
  - One new public API on the runtime (`subscribeEvents`). API surface
    grows by one method.
  - One new file in `node/` (`runtime-sse-adapter.js`).
  - Hosts that want external observation must wire their own HTTP
    server. (Mitigation: the adapter is framework-agnostic; example
    snippets in docs handle the common 4-5 frameworks.)
  - Heartbeats every 15s use a small fixed bandwidth even when idle.

- Risks:
  - Memory leak risk if a slow subscriber buffers events faster than
    it drains. Mitigation: adapter writes are best-effort + drop
    oldest on backpressure with a `dropped_events` counter event.
  - Sequence numbers must stay monotone across the runtime lifetime
    for resume-from-`since` to work. The ledger already maintains
    `sequence`; verify it survives `runtime.run()` invocations across
    the same runtime instance.

## Rollback

- Delete `runtime.subscribeEvents` and its implementation in
  `runtime-event-ledger.js`. `onStep` reverts to direct callback call
  (its current behavior).
- Delete `node/runtime-sse-adapter.js`.
- Remove the new export from `package.json` `exports` block.
- No data-format changes — the event ledger schema is unchanged, so
  no migration needed.
- This ADR is purely additive; rollback is a deletion of new files
  and one method.

## Verification (when implemented)

- **Unit (in-process subscribe)**: extend
  `test/unit/runtime-event-ledger.test.js` (or create
  `test/unit/runtime-event-subscribe.test.js`):
  - Subscribe before `runtime.run()`, assert N events received with
    matching sequence numbers.
  - Subscribe mid-run, assert no missed events on or after subscribe
    time, and with `since: <known seq>` assert events from that
    sequence forward are replayed once.
  - Type / visibility filter receives only matching events.
  - `unsubscribe()` stops delivery.
  - Multiple concurrent subscribers each get the full stream.

- **Unit (SSE adapter)**: new `test/unit/runtime-sse-adapter.test.js`:
  - Adapter writes `data: <json>\n\n` per event, ends with `\n\n`.
  - Heartbeat fires at `heartbeatMs` cadence.
  - Client disconnect triggers `unsubscribe`.
  - `?since=<seq>` query param resumes from the matching ledger entry.

- **Smoke (Node E2E)**: extend `test/smoke.test.js` or add
  `test/node-sse-smoke.test.js`:
  - Mount adapter on a random port, start runtime, subscribe via
    `fetch` with `accept: text/event-stream`, run a fixture turn,
    assert at least `cycle-started`, `planner-requested`,
    `planner-completed`, and a terminal event are received.

- **Live**: add `test:live:node-sse` script that runs a real
  Node-mode turn against a mock provider with the SSE adapter
  mounted; pipe `curl -N` to a file; assert event ordering and
  schema. Optionally pair with `npm run test:live:node-3000` to
  confirm SSE survives a 30+-cycle long-form run without buffering
  the entire ledger in memory (drop counter stays 0).

- **Browser regression**: existing Inspector test path (Browser smoke)
  must continue passing unchanged. The `onStep` compatibility shim
  is the test surface that proves no regression.

- **Build / dist**: `npm run build && npm run dist:check` succeeds
  with the new export. Browser bundle size does not grow (adapter
  is Node-only).
