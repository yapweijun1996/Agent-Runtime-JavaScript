# AGRUN-248-C — Runtime Event Ledger SSOT Design (Phase 1)

Date: 2026-05-25
Status: DESIGN FROZEN (Phase 1 only)

Builds on:
- `agrun_docs/audits/sample-study-runtime-reverse-audit-2026-05-24.md` §1
- AGRUN-248-A (commit `5d8123c79`), AGRUN-248-B (commits `1570e0f6d` + `505d27e8b`)
- MCP-KB `production-agent-harness-for-agrun-js` (618e5f0b) kbcid `agrun.runtime`

## 1. PG (Project Goal)

agrun.js is a browser-first general harness agent runtime. Runtime currently
emits two parallel telemetry channels:
- **Steps** via `pushStep(type, detail)` recorded in `runState.steps[]`.
- **Stream events** via `createRuntimeStreamEmitter().emit(type, detail)` →
  host `onStreamEvent` callback.

Inspector compensates with 7 independent `build*Ledger()` projections that
each re-parse `steps[]`. There is no single typed event ledger; no
mode / visibility / phase classification; no SSOT for stream + step
ordering. AGRUN-248-C introduces the **typed event ledger** so all
projections (Inspector, support bundle, replay, host apps) can read one
ordered stream.

Phase 1 is **additive only**: introduce the ledger and dual-write into it.
Inspector and host `onStep` / `onStreamEvent` callbacks are unchanged. A
Phase 2 PR will migrate Inspector ledgers to read the ledger; a Phase 3
PR will expose LangGraph-style mode subscriptions on the host API.

## 2. Current state (verified by source read 2026-05-25)

| Surface | File | Observation |
|---|---|---|
| Step emit path | `src/runtime/context.js:7` `createPushStep` | Push to `steps[]`, run `prepareRuntimeStepDetail` (stamp runId/cycle, record metrics/cost), call `onStep(step, snapshot)`. 149 call sites, 104 unique step types. |
| Step prep | `src/runtime/runtime-events.js` | 111 lines; only runId/cycle stamping + metrics + cost ledger. No ledger entry. |
| Stream emit | `src/runtime/provider-stream-events.js` `createRuntimeStreamEmitter` | Separate emitter; not in `steps[]`. Calls host `onStreamEvent` only. 10 normalized event types (`provider_stream_*`, `action_*`, `tool_*`). |
| Inspector projections | `examples/browser/src/runtime/oodae-packet-ledger.ts` | 7 build*Ledger functions (`buildOodaePacketLedger`, `buildLlmTraceLedger`, `buildInspectorEventStream`, `buildAiWorkflow`, `buildRuntimeLifecycleTrace`, `buildActionResultEnvelopes`, `buildOodaeCycleDebugLedger`), each parses `steps[]` independently. |
| host API | `runtime.js:34-38` | `onStep` + `onStreamEvent` as separate callbacks, no unified subscription. |

## 3. Decisions (user-confirmed 2026-05-25)

1. **Phase 1 only.** Add ledger + classifier + dual-write + Inspector POC
   verification of one ledger reading from `runState.eventLedger`. Do NOT
   migrate the other 6 Inspector projections; do NOT touch host callback
   surface beyond preserving exact backward compatibility.
2. **Pure-function classifier.** `visibility` (`debug` / `user` / `agent`)
   and `phase` (`observe`/`orient`/`decide`/`act`/`evaluate`/`lifecycle`/
   `null`) derived from `type` prefix rules — no per-type enum table. New
   step types are auto-classified by rule, no migration needed.
3. **Dual-write storage.** `pushStep` writes both `steps[]` (untouched) and
   `eventLedger` (new). Stream emitter also appends to ledger. Phase 2 will
   evaluate dropping `steps[]` once all Inspector ledgers project from
   `eventLedger`. v1 keeps both — zero risk to existing read paths.

## 4. SSOT envelope v1

```js
{
  schemaVersion: "v1",
  id: "evt_<runId>_<sequence>",
  sequence: 1,
  runId: "<runState.runId>",
  cycle: <runState.cycleCount> | null,
  ts: <Date.now()>,
  mode: "step" | "stream",
  visibility: "debug" | "user" | "agent",
  phase: "observe" | "orient" | "decide" | "act" | "evaluate" | "lifecycle" | null,
  type: "action-executed",
  payload: { ...cloned detail... }
}
```

Rules:
- `id` is `evt_<runId>_<sequence>` (or `evt_anonymous_<sequence>` when runId
  is missing). Stable across processes when runId is.
- `sequence` is per-ledger monotonic starting at 1.
- `mode` mirrors the emission channel (`pushStep` → `step`,
  `streamEmitter.emit` → `stream`), so consumers can filter without
  guessing.
- `visibility` / `phase` come from the pure classifier (§5).
- `payload` = `cloneValue(detail)` to keep the ledger immutable from
  caller-side mutation.
- The whole event object is `Object.freeze`d.

## 5. Classifier rules (`runtime-event-classifier.js`)

```js
classifyEvent({ type, mode }) → { visibility, phase }
```

### visibility

Priority order (first match wins):
1. `type` starts with `provider-` or `planner-`, or equals one of
   `action-executing` / `action-executed` / `action-execute-error` →
   `"agent"` (AI decision-loop signals).
2. `type` starts with `phase-`, `cycle-`, or `observation-` → `"agent"`.
3. `type` matches `*-blocked` / `*-error` / `*-failed` / `*-invalid` /
   `*-refreshed` / `*-rejected` → `"user"` (errors and state transitions
   user-visible).
4. Everything else → `"debug"` (default).

### phase

Priority order (first match wins):
1. `type` matches `^phase-(observe|orient|decide|act|evaluate)(-|$)` →
   extracted phase.
2. `type` starts with `provider-` or `planner-` → `"decide"`.
3. `type` starts with `action-` → `"act"`.
4. `type` starts with `observation-` → `"observe"`.
5. `type` starts with `evaluate-` → `"evaluate"`.
6. `type` is one of `run-started` / `run-completed` / `cycle-started` /
   `cycle-completed` → `"lifecycle"`.
7. Default → `null`.

Both functions are pure; tests verify every rule branch + a sample of
real step types (action-executed, planner-requested, observation-recorded,
phase-decide-completed, log, memory-requested, action-guardrail-blocked,
etc.).

`mode` is parameter input, not a classifier output — emitter knows its own
channel.

## 6. Ledger API (`runtime-event-ledger.js`)

```js
export const RUNTIME_EVENT_LEDGER_SCHEMA_VERSION = "v1";

createRuntimeEventLedger({
  runState,           // for runId/cycle stamping
  maxEvents = null    // optional bound; null = unbounded (host concern)
}) → {
  appendEvent({ type, detail, mode }) → event | null,
  getEvents(filter?) → readonly Array<event>,
  size() → number,
  clear() → void
}
```

- `appendEvent` returns the frozen event (or `null` on invalid input).
- `getEvents({ mode?, visibility?, phase?, type?, sinceSequence? })` returns
  a filtered shallow copy (events themselves stay frozen).
- `maxEvents` is a soft FIFO cap — when exceeded the oldest event is
  dropped; sequence numbers keep monotonic regardless.

Storage: an internal `Array<event>` plus a `nextSequence` counter. Frozen
events are safe to share by reference; `getEvents` only copies the array
spine.

## 7. Wiring

| File | Change |
|---|---|
| `src/runtime/runtime-event-ledger.js` | new — factory + appendEvent + filtered getEvents + freeze |
| `src/runtime/runtime-event-classifier.js` | new — pure `classifyEvent`, `extractPhaseFromType` |
| `src/runtime/state.js` | runState gains `eventLedger` slot (lazy init); snapshot omits it (host reads via `runState.eventLedger.getEvents()`) |
| `src/runtime/context.js` | `createPushStep` adds `runState.eventLedger.appendEvent({ type, detail: prepared, mode: "step" })` after `prepareRuntimeStepDetail` and before `notifyStep` |
| `src/runtime/provider-stream-events.js` | `createRuntimeStreamEmitter` accepts optional `ledger`; if present, every `emit` also appends with `mode:"stream"` |
| `src/runtime/action-loop-session.js` / `action-loop-session-loop.js` / `action-loop-session-terminals.js` / `runtime-finalize.js` / `provider.js` | thread the ledger into existing `createRuntimeStreamEmitter` / `createProviderStreamEmitter` call sites (~5 sites) |
| `src/runtime/run-loop.js` / `runtime.js` | initialize ledger on runState before first push |
| `test/unit/runtime-event-ledger.test.js` | new — ordering, runId/cycle stamping, mode filter, schemaVersion freeze, maxEvents FIFO |
| `test/unit/runtime-event-classifier.test.js` | new — all visibility / phase rule branches + 10 real type samples |
| `test/smoke.test.js` | wire both runners |

Inspector POC (acceptance only — no production swap):
- `test/unit/runtime-event-ledger-inspector-poc.test.js` proves a tiny
  `buildOodaePacketLedger`-shaped projection can be assembled from
  `eventLedger.getEvents()`. This is **a test fixture**, not a production
  rewrite of Inspector — the 7 real ledgers stay on `steps[]` until
  Phase 2.

## 8. Acceptance (matches audit §1)

- [ ] `onStep` consumers receive byte-identical steps (full npm test green).
- [ ] `onStreamEvent` consumers receive byte-identical events.
- [ ] Ledger ordering test: `mode:"step"` and `mode:"stream"` events
      interleave by `appendEvent` call order; sequence monotonic.
- [ ] Mode / visibility / phase filter tests cover every rule branch.
- [ ] Inspector POC test reconstructs an OODAE packet projection from
      ledger only — proves the data is sufficient.
- [ ] `npm test` / `npm run build` / `npm run dist:check` green.

## 9. Out of scope (explicit)

- Migration of any of the 7 production Inspector `build*Ledger` functions
  to read the ledger.
- LangGraph-style mode subscription host API (`subscribe({ mode })`).
- Removal of `steps[]` array.
- `onStep` / `onStreamEvent` signature changes.
- AI-side replay, persistence, IndexedDB serialization.
- `recordRecoverableActionError` observation cleanup from AGRUN-248-B HBR
  (will be picked up if it overlaps the wiring; otherwise a tiny follow-up
  PR).

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| 149 `pushStep` call sites means classifier mis-classification can pollute Inspector | classifier covered by unit test against a sample of real types; visibility default is the safe one (`debug`) so unknown types do not leak to user |
| `eventLedger` memory growth on long runs | `maxEvents` knob with FIFO drop; default unbounded so behavior is unchanged from current `steps[]` |
| Stream events were never in `steps[]`; merging into ledger means new debug-snapshot consumers may double-count stream events that already appeared as a related step | `mode` field distinguishes; downstream filters by `mode:"step"` to recover `steps[]` semantics |
| Ledger initialization race — first `pushStep` may run before `eventLedger` is initialized | initialize `eventLedger` in `state.js` `createRunState` (predates any pushStep); fall back to no-op append when ledger is missing |
| Inspector POC may show that ledger lacks some field needed by one of the 7 production ledgers | Phase 1 only commits one POC; Phase 2 audit lists field gaps and either adds them to v1 envelope or bumps to v2 |

## 11. HBR (post-design, pre-code)

- Design verified against audit §1 wording but not against AGRUN-248-D
  (planner repair) requirements; if 248-D needs a `repair` phase, this
  classifier's phase set may need extension.
- Memory footprint of ledger is unmeasured. Browser default is unbounded
  (same as `steps[]`); long live runs may need a Phase 2 `maxEvents` policy
  tuning live test.
- POC test is **not** a production swap of Inspector — it only proves the
  data is sufficient. Real Inspector migration is Phase 2 and may discover
  shape gaps that force a v1 envelope adjustment.
