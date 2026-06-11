# Run-State Export / Import (`exportState` / `importState`) — Design

## 30-second read: why this exists

**一句话**：给正在跑的 agent 存一个**防崩溃的存档**，浏览器标签页崩了、刷新了，能从断点接着跑，而不是从头再来——而且存档里**永远不含 API key**。

**打个比方——游戏的存档点**。agent 跑一个多步长任务就像打一关。以前关打到一半游戏崩了，只能**整关重打**（重新调一遍 LLM、重新花一遍钱）。现在每过一个阶段自动**存档**（`onCheckpoint`）；崩溃重开后从存档点**续关**（`resumeState`），已经打过的步骤不重打。存档文件里绝不写你的密码（`apiKey` 永远不被序列化）。

| | 没有这个 | 有这个 |
|---|---|---|
| 跑到一半页面崩了 | 整个回合从头重跑，钱白花 | 从上次 checkpoint 的 `cycleCount` 续跑，已完成的 cycle 不重跑 |
| 存档安全 | —— | 版本化 + 脱敏的纯 JSON，可直接塞进 IndexedDB；`apiKey` 续跑时由 host 重新提供 |

**为什么重要**：agent 跑在容易崩的浏览器标签页里。崩溃后能续跑是"通用 runtime"的基本盘。**诚实边界**：`resumeState` 恢复的是回合内的 runState（cycle 计数、花费、workspace、待审批…），**不含** actionHistory 和对话历史——要完整对话连续性，得配合 session 存储一起用（见下文 honest scope）。

---

**Status:** P1+P2 DONE (2026-06-10). P1 pure serialization (commit `2d60e1aee`): `exportState`/`importState` + version + redaction + `INVALID_STATE_ENVELOPE` + public exports + `test/unit/run-state-portable.test.js`. P2 loop wiring (commit `9bff3f8bd`): `onCheckpoint` run option + `resumeState` run option threaded via the `options.runState` seam + `ensureLiveEventLedger` re-bind + `test/unit/run-state-resume.test.js`; the session path was a P2 gap fixed in `7a70eb94c` (`test/unit/run-state-resume-session.test.js`). P3 browser demo (`examples/browser/crash-recovery.html` + `src/crash-recovery-demo.ts`) wires `onCheckpoint`→IndexedDB and reload→`resumeState`, live-verified end-to-end (checkpoint at cycle 1 → reload → resume continues 2→3→done at cycle 4, completed cycles not re-run, apiKey never serialized). The host-layer auto-checkpoint helper remains optional/future. Closes the final open item from the 2026-06-10 codebase review: "no public `exportState`/`importState` crash-recovery API (session context snapshots exist, runState not included)". Mirrors `provider-registry-design.md`.

> **Honest scope discovered during P2:** `resumeState` restores the in-flight **runState** (cycleCount/cost/virtualWorkspace/todo/research/OODAE/pendingApproval). It does **NOT** restore `actionHistory` or the conversation — those are not part of runState (`session.actionHistory = options.actionHistory || []`, fresh per invocation). For full conversational continuity, `resumeState` composes with the existing session-store thread hydration + approval-resume paths; on its own it resumes the accumulated state and counters, and the planner restarts its per-turn action memory. `stepCount` is steps-array-bound (per invocation), so the resumable progress counter is **cycleCount**, not stepCount.
**Gap:** A run's in-flight `runState` (accumulated tool results, OODAE cycles, convergence/guardrail counters, cost ledger, `pendingApproval`) lives only inside the `runLoop` call stack. The host receives a full, plain-data snapshot **only after the run finishes** (`result.runState`). If the page/process dies mid-loop — a long multi-step run, or a turn parked at `pendingApproval` — that state is lost and the host can only restart the turn from scratch. The serialization primitive (`snapshotRunState`) and the rehydration seam (`options.runState`) **both already exist internally** but neither is public, versioned, redacted, or wired to a resume entry point. A general agent runtime that runs in a crash-prone browser tab needs a named, documented checkpoint/resume contract.

## Verified anchors (current code)

| Piece | Where | What it does today |
|---|---|---|
| Serialization primitive | `src/runtime/state.js:182` `snapshotRunState(runState)` | `cloneValue` deep-clone + re-sanitizes `agentSkillContext`/`recoveryState`, projects `costLedger`, and **deletes the live `eventLedger`** (`:190`) so the snapshot is plain-data cloneable. Exactly the redaction the export envelope needs for the ledger. |
| Result snapshot | `src/runtime/result.js:66-71` `createResultRunStateSnapshot` | `snapshotRunState(runState)` + a separately-read `eventLedger.getEvents()` array → this is what ships as `result.runState`. Today the only public way to obtain a full runState. |
| Rehydration seam | `src/runtime/action-loop-session.js:51` `const runState = options.runState \|\| createRunState(...)` | A pre-built runState injected via `options.runState` **bypasses `createRunState`** and is used as-is. The seam exists; **no top-level run path passes it today** (every `runState: session.runState` in the loop forwards the already-created live state to helpers, not a restored one). |
| Thread hydration (per-turn) | `src/runtime/run-state-thread.js:55` `hydrateRunStateWithThread` | Applies a thread's durable slice (`threadId`, `todoState`, `researchContext`, `goalAnchorText`, compaction window) onto a **fresh** runState at turn start. Restores *cross-turn* continuity, NOT *mid-loop* in-flight state. |
| Partial recovery (today) | `src/session/approval-resume.js` `prepareSessionApprovalResumeInput` | The one existing "resume a parked run" path: rebuilds the provider request from the resume token + session context from the store. Covers ONLY the `pendingApproval` pause; rebuilds context, does **not** restore the accumulated in-flight runState (cost ledger, convergence counters, tool history). |
| Live state to host (mid-run) | `src/runtime/context.js:120,126` `onStep(step, createStepSnapshot(runState))` | `onStep` hands a **partial debug projection** (`oodae.currentPhase`, `phase`, `metrics`, `todoTask`, a debug runState subset) — NOT the full serializable runState. So there is currently no mid-run full-state checkpoint hook. |
| Version stamp | `src/runtime/build-info.js:3` `getRuntimeBuildId()`; stamped at `state.js:83` `runtimeBuildId` | Build identity already on every runState. Reusable as the envelope compatibility key (default `"dev"`). |
| Secret on the request | provider request carries `apiKey` (+ live `signal`/`circuitBreaker`/`providerRegistry`/`fetch` after `action-loop-session.js:29-48`) | If the envelope bundles the request for self-containment, these MUST be stripped — secret + non-serializable live objects. runState itself holds no apiKey. |

## Design constraints (standing decisions this must respect)

1. **No secret ever leaves in the envelope.** `apiKey` is re-supplied by the host at resume time, never serialized. Export redacts `apiKey`/`signal`/`circuitBreaker`/`providerRegistry`/`fetch` from any bundled request. This is non-negotiable — a crash-recovery blob is exactly the thing that ends up in IndexedDB/localStorage/logs.
2. **Plain JSON only.** The envelope must survive `JSON.stringify`/`parse` and structured-clone (IndexedDB). Build on `snapshotRunState` (already strips the live `eventLedger` closure object); never embed functions, `AbortSignal`, circuit-breaker instances, or class instances.
3. **Versioned and build-aware.** Stamp `agrunStateVersion` (schema) + `runtimeBuildId` (impl). `importState` validates the schema version (throw on mismatch) and surfaces a build mismatch (resuming a snapshot taken by a different runtime build is best-effort, not guaranteed — say so loudly, don't silently corrupt a run).
4. **Reuse the existing seams; do not fork the loop.** Serialize via `snapshotRunState`; rehydrate via the existing `options.runState` injection point. The new code is a public, validated, redacted *wrapper* around primitives that already work — same posture as the provider registry wrapping the existing dispatch.
5. **runState is necessary but not sufficient for resume.** A resume needs BOTH the restored runState AND the provider request (prompt/provider/model + host-supplied apiKey) AND, for multi-turn, the session context. The API must make this explicit; `importState` returns the runState, the host re-attaches the request. Do not pretend a runState alone resumes a run.
6. **Pure functions, no runtime singleton state.** `exportState`/`importState` are stateless top-level functions (like `defineAction`), not methods that read hidden runtime state — two runtimes on one page must not interfere.

## Proposed API

```js
import { exportState, importState } from "agrun";

// --- checkpoint (host persists this blob; e.g. IndexedDB keyed by sessionId) ---
const result = await runtime.run({ prompt, provider, apiKey, model });
const envelope = exportState(result);          // accepts a run result OR a raw runState
await db.put("agrun-checkpoint", sessionId, envelope);   // plain JSON, no apiKey

// --- resume after a crash / reload ---
const envelope = await db.get("agrun-checkpoint", sessionId);
const resumeState = importState(envelope);     // validates version/build, returns a runState
await runtime.run(
  { prompt, provider, apiKey, model },          // host re-supplies apiKey (never persisted)
  { resumeState }                               // P2 run option → injected via options.runState seam
);
```

Envelope shape (plain JSON):

```js
{
  agrunStateVersion: 1,            // schema version — importState throws on unknown
  runtimeBuildId: "abc1234",       // from getRuntimeBuildId(); import warns on mismatch
  exportedAt: "2026-06-10T...",    // host-supplied or stamped at call time
  runState: { /* snapshotRunState output: plain data, no eventLedger */ },
  events: [ /* optional eventLedger.getEvents() array, for inspector replay */ ],
  request: {                       // optional, REDACTED — for self-contained resume
    provider: "openai", model: "gpt-5-mini", prompt: "..."
    // apiKey / signal / circuitBreaker / providerRegistry / fetch STRIPPED
  }
}
```

- `exportState(input, options?)` — `input` is a run **result** (`{ runState, ... }`) or a raw **runState**; `options.request` optionally bundles the originating request (auto-redacted); `options.includeEvents` (default true) controls the `events` array. Returns the frozen plain envelope. Pure.
- `importState(envelope)` — validates `agrunStateVersion` (throw `INVALID_STATE_ENVELOPE` on unknown/missing), compares `runtimeBuildId` (mismatch → attach a `buildMismatch:true` flag + console-less structured warning on the returned object, NOT a throw — best-effort resume is still useful), returns the plain runState ready for the `options.runState` seam. Throws with a precise message on corruption (mirror `defineAction` strictness).
- `resumeState` run option (P2) — when present, threaded to `createActionLoopSession` as `options.runState`, so the loop continues from the restored state instead of `createRunState`.

## Implementation sketch (mirror the threading of `circuitBreaker` / provider registry)

| Step | File | Change |
|---|---|---|
| 1. New module | `src/runtime/run-state-portable.js` (new) | `exportState(input, options)` + `importState(envelope)` + `STATE_ENVELOPE_VERSION = 1` + `redactRequest(request)`. Imports `snapshotRunState` from `state.js`, `getRuntimeBuildId` from `build-info.js`. |
| 2. Redaction | same | `redactRequest` strips `apiKey`, `signal`, `circuitBreaker`, `providerRegistry`, `fetch`; keeps `provider`/`model`/`prompt`/`conversation`/`parts`. Reuses the deny-list shape the loop already builds. |
| 3. Validation | same | `importState` checks `envelope.agrunStateVersion === STATE_ENVELOPE_VERSION` (throw `createStructuredError(INVALID_STATE_ENVELOPE, ...)`), that `runState` is a non-null object with a `runId`; attaches `buildMismatch` when `runtimeBuildId !== getRuntimeBuildId()`. |
| 4. Public export | `src/index.js` | `export { exportState, importState } from "./runtime/run-state-portable.js";` (next to `continueWith` / `defineAction`). |
| 5. Error code | `src/runtime/errors.js` | Add `INVALID_STATE_ENVELOPE` to `ERROR_CODES`. |
| 6. Resume wiring (P2) | `runtime.js` `run()` → `run-loop.js` → `runActionLoop` → `createActionLoopSession` | Read `runOptions.resumeState`; thread as `options.runState`. When set, **skip** the `run-started` re-seed if the restored state already advanced (`skipRunStarted` already exists at `action-loop-session.js:131`). The restored runState must be re-bound to the live `eventLedger` (it was stripped on export) — re-create the ledger in `createActionLoopSession` when `options.runState` lacks one. |
| 7. Checkpoint hook (P2) | `runtime.js` + `context.js` | Optional `onCheckpoint(envelope)` run option called at each cycle boundary with `exportState` output, so the host persists incrementally instead of only on completion. |

Phases:
- **P1 (pure serialization round-trip):** the `run-state-portable.js` module + version + redaction + public export + `errors.js` code. Unit test proves `importState(exportState(result))` deep-equals the input runState (minus stripped fields) and that `apiKey` never appears in the envelope. **No loop wiring yet** — the deliverable is a verified, redacted, versioned blob the host can persist. Litmus: `grep apiKey` over a serialized envelope → 0 hits; round-trip test green.
- **P2 (resume + checkpoint):** `resumeState` run option threaded through the existing `options.runState` seam + eventLedger re-bind + `onCheckpoint` hook. Integration test: run a multi-step mock-transport turn, capture an `onCheckpoint` envelope mid-loop, build a fresh runtime, `runtime.run(request, { resumeState: importState(envelope) })`, assert it completes from the restored cycle count (does not re-run earlier steps) and the cost ledger carries forward.
- **P3 (optional, later):** a host-layer auto-checkpoint helper (IndexedDB in browser, fs in Node) that wires `onCheckpoint` → storage and offers `resumeIfCheckpointed(sessionId)`. Packaging rides on the existing `host/storage-*` modules.

## Relationship to existing recovery paths

- **Thread hydration** (`hydrateRunStateWithThread`) restores *cross-turn* continuity onto a fresh runState — it stays the path for "new user message in an existing session". `importState` is orthogonal: it restores *within-turn* in-flight state. A full resume may use both (hydrate the thread, then overlay the checkpointed runState).
- **Approval-resume** (`prepareSessionApprovalResumeInput`) stays the path for the human-in-the-loop `pendingApproval` pause; it already round-trips the request via the resume token. `importState` generalizes recovery to *any* cycle boundary, not just the approval pause. They compose: the approval token carries the request, the checkpoint carries the runState.
- **`result.runState`** remains the zero-config checkpoint unit for P1 (covers the "crash after a completed turn" and "persist the parked-at-approval state" cases). P2's `onCheckpoint` adds the mid-loop cadence.

## Out of scope

- Persisting the **transport seam** / live provider objects — by constraint #1/#2 these are stripped and re-supplied. A resumed run gets a fresh circuit breaker (its in-memory failure counts are not part of durable state).
- **Session message store** durability — already handled by `createSessionStore` / IndexedDB / fs storage; this design does not touch message persistence, only runState.
- **Migration across `agrunStateVersion` bumps** — v1 throws on mismatch; a future v2 may add an upgrader. Not built now.
- **Cross-build resume guarantees** — flagged (`buildMismatch`), not guaranteed; the runState shape can change between builds.
- Auto-checkpoint storage wiring (P3) and any UI for it.

## Acceptance

1. ✅ P1: `test/unit/run-state-portable.test.js` — round-trip equality (`importState(exportState(result))` matches the input runState minus stripped fields), `apiKey`/live-object redaction (serialized envelope → 0 secret hits), unknown-version throw, build-mismatch flag (not throw). `npm test` green (commit `2d60e1aee`).
2. ✅ P1: `src/index.js` exports `exportState`/`importState`/`STATE_ENVELOPE_VERSION`; `errors.js` has `INVALID_STATE_ENVELOPE`; envelope is `JSON.stringify`-safe; `build:lib` green, dist exposes the exports.
3. ✅ P2: `resumeState` resumes a mock run from a mid-loop checkpoint without re-running completed cycles (provider invoked once); cycleCount + cost ledger carry forward; `onCheckpoint` fires a mid-run envelope each cycle. `test/unit/run-state-resume.test.js` green; full suite 1677 green; no new circular dep (commit `9bff3f8bd`).
4. ✅ Docs: `usage-quickstart.md` "Crash Recovery" snippet; `public-runtime-api.md` gains the `onCheckpoint`/`resumeState` run-option rows + an `exportState`/`importState`/`STATE_ENVELOPE_VERSION` "Crash Recovery" section + Public Surface mention.
5. ✅ P3 demo: `examples/browser/crash-recovery.html` + `src/crash-recovery-demo.ts` wire `onCheckpoint`→IndexedDB and reload→`resumeState`, live-verified via Claude Preview (crash at cycle 1 → reload shows the interrupted-run banner → resume continues 2→3→done at cycle 4). The host-layer auto-checkpoint helper (a reusable `onCheckpoint`→storage wrapper) remains optional/future.
