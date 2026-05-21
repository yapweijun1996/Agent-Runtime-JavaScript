# Planner Action Surface Hard Veto - 2026-05-16

## Goal

Align planner action-surface filtering with existing convergence contracts:

- Exact same-action no-progress signals must hide the repeated action.
- `readOnlyPlanningState` advisory mode must remain advisory.
- Only `readOnlyPlanningState.escalation="hard_veto"` may hide/block read-only planning actions.
- `terminalRepairState.allowedActions` remains the highest-priority repair contract.

## Implementation Summary

- `src/runtime/planner-action-surface.js`
  - Uses `resolveRepeatedNoProgressActionName()` to hide the exact repeated no-progress action.
  - Applies read-only planning forbidden actions only when `escalation` is `hard_veto`.
  - Keeps terminal repair `allowedActions` as the first filter.
- `src/runtime/action-loop-action.js`
  - Applies the read-only planning preflight block only for `hard_veto`.
- `test/unit/planner-action-surface.test.js`
  - Covers repeated no-progress filtering.
  - Covers advisory mode staying visible.
  - Covers hard-veto filtering.
  - Covers terminal repair overriding overlapping convergence filters.
- `test/unit/plan-validation-recovery.test.js`
  - Uses `hard_veto` for the plan-child action-surface rejection case.

## Verification

Commands run:

```bash
node test/unit/planner-action-surface.test.js
node test/unit/plan-validation-recovery.test.js
node test/unit/action-pattern-convergence.test.js
```

Initial result:

- All targeted tests passed.
- Existing `MODULE_TYPELESS_PACKAGE_JSON` warning still appears.

Full verification:

```bash
npm test
npm run build
npm run dist:check
```

Result:

- `npm test` passed.
- `npm run build` passed with existing Rollup `this` rewrite / circular dependency warnings and Vite chunk-size warning.
- `npm run dist:check` passed.

## Honest Bad Result

Codeloom MCP `audit_diff` timed out after 120s, so impact review used local `rg` caller search instead.

## Harness Boundary

This change does not add prompt/topic/source hardcoding. Runtime only projects existing objective convergence and repair facts into the action surface and preflight gate.
