# ADR: Per-step debug snapshot carries the convergence family (AGRUN-266)

Status: Accepted — 2026-06-04.

## Context

- agrun exposes the run state to hosts through several read-only surfaces. Three of
  them are meant to be interchangeable views of the same data:
  - **Result snapshot** — `snapshotRunState(runState)` (`src/runtime/state.js`) does a
    full `cloneValue(runState)`, so it keeps the entire `actionPatternConvergence`
    (including the live `readOnlyPlanningState` with `active` / `escalation` /
    `ignoredCount` / `stepsWithoutProductiveProgress`), `terminalRepairState`, and
    `invalidActionConvergence`.
  - **lastRun summary** — `createLastRunSummary` via `projectMetricsRunState`
    (`src/runtime/run-state-projections.js`) carries the same fields, also via
    `cloneValue`.
  - **Per-step debug snapshot** — `createStepRunStateDebugSnapshot`
    (`src/runtime/context.js`), surfaced live to hosts through `onStep` and consumed
    by the browser Inspector via `projectInspectorRunState`
    (`examples/long-task-lab/src/runtime/lab-state.ts`).
- The per-step snapshot does **not** clone the whole run state — it builds
  `snapshot.runState` from an explicit `copyFields` **allowlist** (kept compact on
  purpose for live, per-cycle debugging). That allowlist **omitted**
  `actionPatternConvergence`, `terminalRepairState`, and `invalidActionConvergence`.
- Consequence: while a run was in flight, a host watching `onStep` (and the Inspector,
  which re-projects `snapshot.runState` through `projectInspectorRunState`) saw
  `actionPatternConvergence: undefined`. To know whether read-only-planning convergence
  had fired, hosts were forced into the brittle workaround
  `terminalRepairState.reason === "read_only_planning_with_observable_deficits"` — and
  even `terminalRepairState` was itself absent from the per-step surface, so the
  workaround only happened to work on the result snapshot, not live.
- The live engine already stores the full shape: `updateReadOnlyPlanningState`
  (`src/runtime/action-pattern-convergence.js`) active branch carries `active`,
  `escalation`, `ignoredCount`, and `stepsWithoutProductiveProgress`. The lossy
  `summarizeReadOnlyPlanningState` (which can drop fields when fully idle) is used
  **only** for the planner prompt (LLM-facing `loopState`), never for host snapshots —
  so it was never on this bug's path.
- Affected: `src/runtime/context.js`, `test/unit/step-snapshot-convergence.test.js`,
  `test/smoke.test.js`, `task.md`.

## Decision

- **Make the per-step snapshot a true subset-of-the-same-shape.** Add
  `actionPatternConvergence`, `terminalRepairState`, and `invalidActionConvergence` to
  the `copyFields` allowlist in `createStepRunStateDebugSnapshot`. The loop already
  copies via `cloneValue` + `hasOwnProperty`, so the per-step snapshot now carries the
  **identical raw shape** the result snapshot and lastRun summary already expose — one
  SSOT field shape across all three host surfaces, no parallel projection.
- **Keep the canonical field name `readOnlyPlanningState`.** The host reads
  `snapshot.runState.actionPatternConvergence.readOnlyPlanningState.{active, escalation,
  ignoredCount, stepsWithoutProductiveProgress}`. Inventing a parallel `readOnlyPlanning`
  alias would have *broken* SSOT, not served it.
- **No new projection, no summarizer on this path.** The fix is purely additive to the
  allowlist; the result snapshot and lastRun summary are untouched (no regression). The
  retired `terminalRepairState.reason` workaround still works (that field is now also on
  the per-step surface) but is no longer required.
- **`metrics` deliberately excluded.** It is not part of this bug, and the per-step
  snapshot already exposes `metrics` at its top level (`createStepSnapshot`), so the
  Inspector still has it. The allowlist stays intentionally compact.

## Alternatives

1. **Expose a new summarized `readOnlyPlanning` projection** on the per-step snapshot.
   Rejected: it would give hosts a *different* field name/shape than the result snapshot
   and lastRun summary — the opposite of SSOT — and the lossy summarizer can drop the
   exact fields hosts need when the state is only mildly active.
2. **Route the per-step snapshot through `projectInspectorRunState`** inside the runtime.
   Rejected: that projection is heavier and host-owned (it lives at the example boundary,
   fed by the snapshot); pushing it into the runtime would couple core to an inspector
   shape and still require the source fields to be present first.
3. **Leave it; document the `terminalRepairState.reason` workaround.** Rejected by
   CLAUDE.md (no patch-thinking): reason-string parsing is a brittle, host-facing
   contract that breaks the moment a repair reason is reworded.

## Consequences

- Pros: hosts read read-only-planning convergence live from one SSOT shape; the
  Inspector now shows it mid-run; no result-snapshot/lastRun regression; no new API,
  callback, or projection; the workaround is retired without breaking hosts that still
  use it.
- Cons: the per-step snapshot grows by three cloned sub-objects per step. Negligible —
  they are small, already cloned for the other two surfaces, and only built when a host
  registers `onStep`.
- Risks: low. A future runtime field that hosts must read live still needs an explicit
  allowlist entry — that is the intended, reviewable contract of this surface.

## Verification

- Repro test `test/unit/step-snapshot-convergence.test.js` (wired into the smoke suite
  via `runStepSnapshotConvergenceSmoke` in `test/smoke.test.js`): constructs an **active**
  `readOnlyPlanningState` (`ignoredCount:2`, `stepsWithoutProductiveProgress:3`), drives a
  step through the exported `createPushStep`, captures the `onStep` snapshot, and asserts
  the host reads the four fields from `snapshot.runState` with **no** reason-string
  parsing. Confirmed failing pre-fix (`actionPatternConvergence` was `undefined`), passing
  post-fix. Also asserts SSOT parity (`deepEqual`) against `snapshotRunState` and
  `createLastRunSummary`, deep-clone isolation, and that a fresh not-active run still
  carries the four fields sanely.
- Gates: `npm test` EXIT 0 (`Node smoke test passed.`), `npm run build` EXIT 0,
  `npm run dist:check` EXIT 0 (344 markdown files).

## Rollback

- Remove `actionPatternConvergence`, `terminalRepairState`, and
  `invalidActionConvergence` from the `copyFields` allowlist in
  `createStepRunStateDebugSnapshot`, drop `runStepSnapshotConvergenceSmoke` from
  `test/smoke.test.js`, and delete the repro test. This restores the bug (hosts back on
  the `terminalRepairState.reason` workaround, which itself disappears from the per-step
  surface) and would need this ADR plus the AGRUN-266 task entry flipped back to OPEN.
