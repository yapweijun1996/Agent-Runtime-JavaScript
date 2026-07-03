# AGRUN-442 — `examples/browser` becomes a real `runStream` consumer (2026-06-15)

## What shipped

AGRUN-442 slice 1 (PR #201, `ad156b140`) shipped the async-generator engine
(`runtime.runStream` / `session.runStream`, 7 typed `AgentLoopEvent`s) but **no
real consumer used it**. This slice wires the reference consumer:
`examples/browser/src/runtime/agent.ts` `runAgentTurn` now drives every chat turn
through `session.runStream` instead of `session.run`.

Two concrete wins, additive (example-side only — **no `src/` change**):

1. **Real consumer hardens the slice-1 contract.** The example reads the run
   result from the generator's *return value*, dispatches the typed events to an
   optional `onLoopEvent`, and **forwards `onStep`/`onToken`** so the existing
   activity / inspector / todo UI is unchanged.
2. **Real mid-run abort.** The prior path never passed `abortSignal` to
   `session.run` — the Stop button (`useChat.ts`) aborted a controller, but the run
   ran to completion and `chat-turns.ts` merely discarded the result. `runAgentTurn`
   now passes the turn's `abortSignal` into `runStream`, which chains it, so Stop
   **genuinely cancels the in-flight run**.

## Verification

| Check | Result |
|---|---|
| `npm run lint` (example `tsc --noEmit`) | ✅ green — `runStream` typed on `ProviderSessionHandleLike` + `BrowserRuntimeLike`; `AgentLoopEvent` local mirror |
| `npm run test:smoke` (example, 19 smokes) | ✅ all green incl. new `runstream-consumer.smoke.ts`; the existing rich-UI smokes (activity-log, chat-turn-state, inspector-*) prove the `onStep`-driven UI path is unbroken |
| `npm run check` (root: build + dist-check + unit) | ✅ **EXIT=0** |
| Browser boot (Claude Preview, port 3100) | ✅ app renders, "Assistant is idle", **zero console errors** — the new `runStream` code path boots cleanly |

### `runstream-consumer.smoke.ts` — the three pinned contracts (against the real engine `src/runtime/run-event-stream.js`)
- typed events stream in order `phase → tool_start → tool_result → phase → completed`; `phase` carries the OODAE phase, `tool_start` the tool detail.
- the generator's **return value IS the run result** `runAgentTurn` reads (and the `completed` event also carries it).
- `generator.return()` / breaking the loop **aborts the underlying run** (the runner observes its `abortSignal` fire) — the mechanism behind the Stop-button fix.
- host `onStep` / `onToken` are forwarded (rich UI unchanged).

## Notes / scope

- **No new live-status UI.** The example already surfaces live progress via `agentState` and `ActivityPanel` (`getPanelStatus`); a second typed-event badge would be redundant, so per simplicity-first none was added. The typed-event hook (`onLoopEvent`) is wired + smoke-tested and available to hosts.
- **The 515/517/523 live gates were not re-run.** They exercise `src/` (memory extraction, secret redaction) which this example-only change leaves byte-identical; `npm run check` is green, so their behavior is unchanged by construction.
- **A keyed end-to-end provider turn was not driven in-browser**: `BROWSER_DEV_AUTOSEED_KEYS=false` and `.env.local` is tooling-denied, and raw provider keys are not pasted into the preview UI. The streaming + abort behavior is proven at the contract level (smoke against the real engine) and the wiring at the type level (lint); the app boots cleanly with it.
- **Out of scope (unchanged):** native-yield migration of `continueActionLoop` (low-value/high-risk — see plan); the approval-resume path (`resumeApproval`, a resume not a fresh loop); AGRUN-443 executor wiring (deferred earlier).
