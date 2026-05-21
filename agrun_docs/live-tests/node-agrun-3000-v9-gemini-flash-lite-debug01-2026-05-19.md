# E2E v9 — AGRUN-DEBUG-01 Layer 1+2 Validation (2026-05-19)

## Run Config
- Model: `gemini-3.1-flash-lite`
- plannerMode: `envelope`
- maxSteps: 25 (v9c verification run)
- Command: `GEMINI_MODEL=gemini-3.1-flash-lite NODE_AGRUN_LIVE_MAX_STEPS=25 node test/node-agrun-3000-live.mjs`

## AGRUN-DEBUG-01 Implementation Result

### What Changed (test/node-agrun-3000-live.mjs)

**Layer 1 — `onPlannerDecision` enrichment:**
- Signature changed: `onPlannerDecision(decision, runState)` — uses second arg (raw `session.runState`)
- New fields in `planner_decision` event: `candidateWords`, `budgetState`, `terminalRepairActive`, `terminalRepairEscalation`, `terminalRepairIgnoredCount`, `readOnlyPlanningIgnoredCount`, `cycleCount`

**Layer 2 — `onStep` subscriber:**
- Added `onStep(step, snapshot)` callback
- `snapshot` is `createStepSnapshot(runState)` — NOT raw runState
- Actual state is at `snapshot.runState` (copyFields include: `cycleCount`, `virtualWorkspace`, but NOT `terminalRepairState` / `actionPatternConvergence`)
- Emits `hard_veto_fired` for `terminal-repair-hard-veto-blocked` / `structure-repair-hard-veto-blocked`
- Emits `convergence_block` for advisory blocks

**Key finding (snapshot path bug, fixed):**
- Initial `onStep` read `runState.cycleCount` → `0` (wrong path)
- Root cause: `onStep` receives `createStepSnapshot(runState)`, not raw state
- Fix: read from `snapshot.runState.cycleCount` + compute budgetState from `maxSteps` (closure) - `cycleCount`

## Verified Output (v9c, 25-step)

```json
{
  "actionName": "finalize",
  "budgetState": "enough",
  "candidateWords": 423,
  "cycleCount": 13,
  "event": "convergence_block",
  "ignoredCount": 1,
  "readOnlyPlanningIgnoredCount": 0,
  "reason": "blocked",
  "stepType": "terminal-repair-direct-terminal-blocked"
}
```

All fields now correct:
- `budgetState: "enough"` ✓ (maxSteps=25, cycleCount=13, remaining=12)
- `candidateWords: 423` ✓ (workspace quality stats)
- `cycleCount: 13` ✓ (from snapshot.runState.cycleCount)
- `ignoredCount: 1` ✓ (from step detail)

## v9b Finding — Hard Veto Threshold Gap

During v9b (90-step run, old code), `ignoredCount` reached 23+ with `budgetState: "enough"` — hard_veto NEVER fired because `budgetState === "exhausted"` requires the last step (step 90).

**Pattern observed:**
- Steps 1-12: research + workspace writes
- Step 13+: `finalize` loop — model calls finalize, gets advisory block, calls finalize again
- `ignoredCount` reached 23+ by cycle ~80
- `budgetState` stays "enough" until step 80 (low) and step 90 (exhausted)
- Hard_veto triggers only at step 90 — too late (87 wasted advisory cycles)

**AGRUN-237 PR 2 gap identified:**
Current hard_veto condition: `ignoredCount >= 3` AND `budgetState === "exhausted"`
Problem: `budgetState === "exhausted"` requires remaining steps = 0, which only occurs at the very last cycle. With 90 steps, the model can waste 87 cycles in advisory-ignored finalize loops before hard_veto fires.

**Proposed improvement (AGRUN-237-GAP-01):**
Add a high-water-mark threshold: `ignoredCount >= HIGH_WATER_MARK (e.g., 8)` → hard_veto regardless of budget state.
This would fire at step ~21 instead of step 90, breaking the loop ~70 steps earlier.

## Acceptance Criteria Status

- [x] `planner_decision` events include `candidateWords` + `budgetState` + `cycleCount`
- [x] `convergence_block` event fires when advisory block occurs (ignoredCount, budgetState, candidateWords all correct)
- [x] `hard_veto_fired` event wired (not yet verified in live run — needs budget to exhaust or high-water threshold)
- [x] `npm test` green (810+ PASS 0 FAIL)
- [ ] Hard_veto live validation: needs `budgetState: "exhausted"` OR high-water-mark threshold fix

## Next Steps
1. Implement AGRUN-237-GAP-01: add `ignoredCount >= HIGH_WATER_MARK` as alternative hard_veto trigger
2. Re-run with flash-lite (30 steps) to verify `hard_veto_fired` event appears at step ~10
