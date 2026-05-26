# ADR-0038: Per-Message JSON Storage Layer (opencode adoption)

## Context

agrun's debug surface today is `agrun_debug_runs/<timestamp>.{md,jsonl}` — a
single pretty-printed blob per run plus a JSONL trace. Human-friendly but
machine-hostile: extracting a particular message body requires regex
scraping (the parent JSONL pretty-print truncates `content` fields at 500
chars; reproducing the full final candidate text required re-running with
`AGRUN_DEBUG=1` because the default log shipped only previews — see
[opencode-vs-agrun-2026-05-25.md](../learnings-from-sample/opencode-vs-agrun-2026-05-25.md)
section "Known gaps").

opencode demonstrates the alternative pattern. Every assistant turn is
persisted as `~/.local/share/opencode/storage/message/<sessionID>/<msgID>.json`
and each part within that message is its own file under
`storage/part/<msgID>/<prtID>.json`. Parts include the full text body,
tool call inputs/outputs, reasoning blocks, and step-start/step-finish
markers. Post-mortem inspection of any prior run is one `cat` away.

This is also a hard prerequisite for opencode-style **compaction**
(ADR-0039): compaction marks specific old tool outputs as compacted
(`state.time.compacted = Date.now()`) at message-part granularity.
Without per-part storage there is no surface to mark.

Affected modules / contracts:
- [src/runtime/runtime-event-ledger.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-event-ledger.js)
  — the v1 event source; per-message storage subscribes to it.
- [src/runtime/state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) — runState carries
  cycle/turn boundaries; storage uses them to roll up events into messages.
- [src/index.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/index.js) — host options pass a storage
  adapter implementation.
- [src/host/](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/host) — new optional storage adapter package
  (browser IndexedDB, Node FS).
- [agrun_debug_runs/](agrun_debug_runs) — existing pretty-printed
  trace remains for human readability; per-message JSON is the
  machine-friendly complement.

KB cross-references:
- `kb_recall "per-message JSON storage"` returns the differential memo
  from 2026-05-25 (file paths + line numbers for opencode side).
- Roadmap entry: AGRUN-256 in [task.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/task.md) `## Active
  Roadmap`.

## Decision

Add a **storage adapter contract** with two concrete adapters: Node
filesystem under `node/storage-fs.js` and browser IndexedDB under
`host/storage-indexeddb.js`. agrun core stays storage-agnostic. The
adapter receives typed events from `runtime.subscribeEvents`
(ADR-0036) and writes per-message + per-part JSON.

### Storage adapter contract

```js
const adapter = {
  // called once per session creation
  async createSession({ sessionID, runID, parentSessionID, time, model, variant }),

  // called once per assistant turn (boundary derived from event ledger)
  async writeMessage(sessionID, message),

  // called per part inside a message (text, tool, reasoning, step-start, step-finish)
  async writePart(sessionID, msgID, part),

  // session lookup
  async listSessions({ projectID?, limit?, since? }) → Array<{sessionID, time, title}>,
  async getMessages(sessionID) → Array<message>,
  async getParts(sessionID, msgID) → Array<part>,

  // session diff (for replay)
  async appendSessionDiff(sessionID, fileDiff),
  async getSessionDiff(sessionID) → Array<fileDiff>,
};
```

### Message + Part schemas (v1)

```js
Message = {
  id: "msg_<base32 ksuid>",
  sessionID: "ses_<id>",
  runID: "<runID>",         // links to event-ledger runId
  role: "user" | "assistant",
  time: { created: <unix ms> },
  agent: "<agent name>" | null,
  model: { providerID, modelID } | null,
  variant: "low" | "high" | null,
  summary: { title?, diffs: Array<fileDiff> } | null,
};

Part = {
  id: "prt_<base32 ksuid>",
  sessionID: "ses_<id>",
  messageID: "msg_<id>",
  type: "text" | "tool" | "reasoning" | "step-start" | "step-finish",
  // text part:
  text?: string,
  // tool part:
  tool?: string,
  state?: { status: "pending" | "running" | "completed" | "error",
            input?: object, output?: object, error?: string,
            time?: { start, end, compacted? } },
  // reasoning part: only `text` field
  // step-{start,finish}: empty (markers)
};

FileDiff = {
  sessionID: "ses_<id>",
  path: string,
  oldVersion?: number,
  newVersion: number,
  diff: string,           // unified diff
  ts: <unix ms>,
};
```

### Event-to-message rollup logic

`runtime-event-ledger.js` emits per-event records (`type`, `payload`,
`mode`, `cycle`, `runId`, `ts`). A new module
`src/runtime/session-message-store.js`:

1. Subscribes via `runtime.subscribeEvents(handleEvent, {visibility:
   ["user", "agent"]})`. Debug-only events stay in the ledger but
   don't reach storage.
2. Maintains an in-memory map `{sessionID: {pendingMessage, pendingParts}}`.
3. On `cycle-started` → starts a new `assistant` message with new
   `msgID`. On `cycle-completed` → flushes `pendingParts` then
   `writeMessage` (closes the message).
4. Per event type maps to a Part:
   - `planner-completed` payload becomes a `reasoning` Part.
   - `action-executed` payload becomes a `tool` Part with state from
     the action-result-envelope.
   - `provider-text-delta` is appended to the active text Part.
   - `readinessAudit-observation` is logged as a `reasoning` Part with
     `text = <serialized observation>`.
5. On `workspace_publish_candidate` action result, also calls
   `appendSessionDiff` with the rendered final_candidate.md diff.

### Host wiring

```js
import { createRuntime } from "agrun";
import { createFsStorage } from "agrun/node/storage-fs";

const storage = createFsStorage({ baseDir: "/path/to/storage" });
const runtime = createRuntime({
  storage,             // ← optional; runtime is unchanged if absent
  /* ... */
});
```

When `storage` is present, runtime instantiates `session-message-store`
and wires it to the ledger. When absent, runtime behavior is unchanged
(today's behavior).

### Out of scope

- Cross-machine session sync (opencode has a remote share endpoint;
  agrun does not need this).
- Encryption at rest.
- Session search / full-text index (build on top later if needed).
- Migration of existing `agrun_debug_runs/*.{md,jsonl}` traces. The
  pretty-printed format keeps existing for human reading; new
  per-message JSON is additive.

## Alternatives

1. **One JSON file per session containing all messages and parts.**
   Simpler to write, harder to update partially. opencode's per-part
   files are addressable individually for compaction (mark a single
   tool output as compacted) without rewriting the rest. Rejected:
   per-part addressability is required by ADR-0039.

2. **Store messages in IndexedDB only, no Node FS adapter.** agrun
   ships browser-first. But the cleanest debugging story for engineers
   is filesystem paths they can `grep` and `cat`. Rejected: dual
   adapters is small effort and lets Node hosts inspect with standard
   shell tools.

3. **Keep the markdown trace, add a separate JSONL "messages" file
   per run.** Less granular than per-message files. Rejected:
   doesn't satisfy ADR-0039 (compaction can't mark individual tool
   outputs); also forces consumers to parse JSONL when they need only
   one message.

4. **Adopt opencode's storage path verbatim
   (`~/.local/share/<app>/storage/...`).** Forces XDG-spec compliance
   that browser deployments can't honor. Rejected: agrun lets the
   host pass a `baseDir`; default for Node is
   `process.cwd()/.agrun/storage` and for browser is the IndexedDB
   database `agrun-storage-v1`.

## Consequences

- Pros:
  - Per-message post-mortem inspection without re-running.
  - Compaction (ADR-0039) becomes implementable.
  - `agrun debug` commands (AGRUN-258) can list and replay sessions.
  - External inspector tools can consume storage instead of subscribing
    to a live SSE stream — useful for batch / CI inspection.
  - Existing `agrun_debug_runs/*.{md,jsonl}` traces remain for human
    reading. No regression.

- Cons:
  - One more module (`session-message-store.js`).
  - Two new optional adapters (`node/storage-fs.js`,
    `host/storage-indexeddb.js`).
  - Disk / IDB writes per cycle add a small synchronous cost.
    Mitigation: writes are batched per message close, not per part.

- Risks:
  - Storage adapter contract drift. Mitigation: lock the contract in
    a JSON Schema in `agrun_docs/result-schema.md`.
  - Privacy: per-part files contain raw tool inputs (could include
    user prompts, API keys passed to bash). Mitigation: adapter
    contract includes an optional `redactor(part) → part` hook;
    host-supplied.

## Rollback

- Delete `src/runtime/session-message-store.js`.
- Delete `node/storage-fs.js` and `host/storage-indexeddb.js`.
- Remove `storage` option from `createRuntime` (or accept-and-ignore
  for back-compat).
- No data migration — existing `agrun_debug_runs/*` traces unchanged.
- Purely additive; rollback deletes new code only.

## Verification (when implemented)

- **Unit (storage adapter contract)**:
  `test/unit/storage-fs-adapter.test.js`,
  `test/unit/storage-indexeddb-adapter.test.js` — round-trip a session
  with 3 messages and 8 parts; assert disk layout matches the spec;
  assert `listSessions / getMessages / getParts` return correct shape.

- **Unit (event-to-message rollup)**:
  `test/unit/session-message-store.test.js` — feed synthetic ledger
  events through the store; assert message/part boundaries and part
  type mapping.

- **Smoke (Node E2E)**: extend `test/smoke.test.js` to run a turn
  with FS storage configured; assert message + part files exist and
  parse; assert the per-message reconstruction matches the
  `agrun_debug_runs/*.md` trace it accompanies.

- **Browser regression**: existing Inspector path unchanged; runs
  without storage still work; runs with IndexedDB adapter produce
  retrievable sessions.

- **Performance**: write latency per cycle should add <5 ms on Node
  FS / <20 ms on IndexedDB. Measure with a 30-cycle run.
