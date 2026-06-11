# AGRUN-311: action-pattern-convergence-refreshed ghost events

Date: 2026-06-08

## Result

Fixed false `action-pattern-convergence-refreshed` debug steps that were emitted when the action-pattern evaluator was only tracking state and had no `convergenceSignal`.

## Root cause

`refreshActionPatternConvergence()` returns the next evaluator object whenever `runState` exists. That object can be truthy while `convergenceSignal` is `null`, for example after a normal first `web_search`:

```json
{
  "status": "tracking",
  "convergenceSignal": null
}
```

Four runtime emission sites checked only `if (evaluator)`, so they pushed `action-pattern-convergence-refreshed` with `patternKind:null` and `forbiddenMove:null`. This polluted simple-task stuck metrics without changing planner behavior.

## Fix

Added `shouldEmitActionPatternConvergenceRefreshed(evaluator)` as the single predicate for debug-step emission. The runtime still updates `runState.actionPatternConvergence` on every refresh, but emits `action-pattern-convergence-refreshed` only when `evaluator.convergenceSignal` exists.

Updated emission sites:

- `src/runtime/action-loop-action.js`
- `src/runtime/action-loop-plan-actions.js`
- `src/runtime/action-loop-session-loop.js`
- `src/runtime/research-finalize-contract.js`

## Verification

- `node --check src/runtime/action-pattern-convergence.js`
- `node --check src/runtime/action-loop-session-loop.js`
- `node --check src/runtime/action-loop-action.js`
- `node --check src/runtime/action-loop-plan-actions.js`
- `node --check src/runtime/research-finalize-contract.js`
- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/mock-provider-plan-loop.test.js`
- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/terminal-repair-state.test.js`

Additional mock runtime smoke:

```json
{
  "convergenceRefreshed": 0
}
```

## Harness boundary

This is observability-only. It does not suppress internal convergence tracking, does not change action selection, and does not rewrite any AI output. It only prevents a non-signal tracking state from being reported as a stuck/convergence event.
