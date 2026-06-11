# ADR-0032: Convergence hard_veto overrides terminalRepairState.allowedActions

**Date:** 2026-05-19
**Status:** Accepted
**Ticket:** AGRUN-237-GAP-04

---

## Context

The action loop uses two complementary safety mechanisms:

1. **terminalRepairState.allowedActions** — when terminal repair is active, only the listed actions appear on the LLM's action surface (workspace_write, workspace_replace, etc.). This narrows the surface to recovery-relevant actions.

2. **Convergence states** (readOnlyPlanningState, workspaceMutationGrowthConvergence) — detect oscillation and no-progress loops. They escalate from advisory (prompt pressure) to hard_veto (action removal + preflight block).

E2E run AGRUN-237-GAP-04 v15 revealed that even after `readOnlyPlanningState` reached `escalation: "hard_veto"` with `ignoredCount = 8`, the workspace_write action was NOT blocked. The LLM continued writing destructive overwrites in a 10-cycle oscillation loop.

Root cause: **two independent bypass points** allowed `terminalRepairState.allowedActions` to shadow the hard_veto signal.

---

## Decision

**hard_veto convergence signals override terminalRepairState.allowedActions.**

Advisory-escalation signals do not override the repair allowlist.

Priority order:
```
hard_veto (circuit breaker) > terminalRepairState.allowedActions > advisory
```

---

## Bug Analysis

### Bug 1 — `maybeBlockReadOnlyPlanningLoop` bypass (action-loop-action.js)

```js
// BEFORE (broken):
if (repairAllowedActions.includes(actionName)) return null;  // unconditional bypass

// AFTER (fixed):
if (repairAllowedActions.includes(actionName)) {
  const isHardVetoForAction = state && state.active === true &&
    readString(state.escalation) === "hard_veto" &&
    Array.isArray(state.forbiddenActions) &&
    state.forbiddenActions.map(readString).filter(Boolean).includes(actionName);
  if (!isHardVetoForAction) return null;  // bypass only when NOT in hard_veto
}
// fall through to block
```

### Bug 2 — `selectPlannerActions` early-return order (planner-action-surface.js)

```js
// BEFORE (broken):
if (allowedRepairActions) return allowedRepairActions.has(name);  // before forbidden check

// AFTER (fixed):
if (readOnlyPlanningForbiddenActions?.has(name)) return false;      // hard_veto first
if (workspaceMutationGrowthForbiddenActions?.has(name)) return false;
if (allowedRepairActions) return allowedRepairActions.has(name);    // then repair filter
```

### Bug 3 — `updateWorkspaceMutationGrowthConvergence` stallCount reset (action-pattern-convergence.js)

workspace_append with positive delta was clearing the stallCount in the `!isStall` branch, masking write→append→write oscillation.

Fix: only track `workspace_write` stalls. Other mutations passthrough without modifying stallCount. Destructive writes (`deltaWords < 0`) activate advisory immediately.

---

## Consequences

- hard_veto is now a true circuit breaker: no lower-priority mechanism can re-enable a vetoed action.
- `terminalRepairState.allowedActions` continues to work normally when convergence is below hard_veto threshold.
- workspaceMutationGrowthConvergence stallCount is cleanly scoped to workspace_write; append/replace signals don't pollute it.
- Advisory convergence (escalation !== "hard_veto") still defers to the repair allowlist — advisory is pressure, not a block.

---

## Files Changed

| File | Change |
|------|--------|
| `src/runtime/planner-action-surface.js` | Hard_veto filters before allowedRepairActions; add `resolveWorkspaceMutationGrowthForbiddenActions()` |
| `src/runtime/action-loop-action.js` | `maybeBlockReadOnlyPlanningLoop` checks hard_veto before bypassing |
| `src/runtime/action-pattern-convergence.js` | workspace_write-only stall tracking; `isDestructiveOverwrite` activates advisory on first occurrence |
| `test/unit/planner-action-surface.test.js` | 3 new tests for hard_veto/repair-allowlist interaction |
| `test/unit/action-pattern-convergence.test.js` | Test D updated; Test E added for write-only stall tracking |
| `dist/agrun.js` | Rebuilt |

---

## Related ADRs

- [ADR-0014](./0014-recovery-belongs-to-ai.md) — recovery logic belongs to AI, not hardcoded harness
- [ADR-0026](./0026-zero-residual-push-mode.md) — zero residual push mode; convergence signals are harness observations, not AI decisions
