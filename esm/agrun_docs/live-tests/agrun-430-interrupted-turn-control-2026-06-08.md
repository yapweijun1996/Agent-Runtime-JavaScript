# AGRUN-430 Interrupted Turn Control

Date: 2026-06-08

## Result

AGRUN-430 is completed. The action loop now has an explicit interrupted-turn dispatcher:

- `return_interruption`: the run is still blocked and returns the approval/interruption result.
- `rerun_turn`: the interruption has been resolved and the planner re-enters without burning another cycle/turn count.
- `advance_step`: normal next-cycle behavior.

## Implementation

- Added `InterruptedTurnControl` and `handleInterruptedOutcome()` in `src/runtime/action-loop-session-loop.js`.
- Added `continuingInterruptedTurn` as a one-turn flag on run state and step debug snapshots.
- Approval resume now marks `continuingInterruptedTurn` before calling back into `continueActionLoop()`.
- `beginActionLoopCycle()` accepts `{ continuingInterruptedTurn: true }` and skips cycle/turn increment plus per-turn counter resets for that rerun.
- Stale `interruption` turn control without a pending approval is normalized to `run_again` once, so rerun recovery cannot become a no-cycle infinite loop.

## Verification

Commands passed:

```sh
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/interrupted-turn-control.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js
node test/unit/turn-control.test.js
node test/unit/action-loop-session-terminals.test.js
node test/unit/action-pattern-convergence.test.js
node test/unit/gated-publish-convergence.test.js
node test/concerns/approval-resume.test.js
npm run check
```

## HBR

This is control-flow routing only. The runtime does not choose the next semantic action for the AI. Terminal repair escalation remains upstream and was covered by the gated publish and action-pattern convergence tests.
