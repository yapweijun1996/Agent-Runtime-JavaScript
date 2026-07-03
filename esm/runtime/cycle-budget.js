// AGRUN-413 — single source of truth for "is the cycle budget running low?".
//
// The runtime's step budget (maxSteps) is host-configurable and spans a very
// wide range: the default run is only 8 steps (config.js DEFAULT_MAX_STEPS),
// while a long-form research run may set 300+. A FIXED remaining-step threshold
// (the old `remaining <= 10`) does not scale across that range:
//   - an 8-step default run has remaining <= 10 from cycle 0  -> ALWAYS "low"
//   - a 20-step run flags "low" at 10 remaining               -> half its budget
//   - a 300-step run flags "low" at 10 remaining              -> last 3%, too late
//
// The fix is to express "low budget" as a PROPORTION of maxSteps — the final
// CYCLE_LOW_BUDGET_RATIO slice of the run — so the meaning is stable at every
// scale. The ratio mirrors WORKSPACE_LOW_BUDGET_RATIO=0.8 used for workspace
// operation/char budgets in requirement-recovery-evaluator.js (low = within the
// final 20% of the budget), keeping the kernel's "low budget" semantics
// consistent across the cycle, operation and char dimensions.
const CYCLE_LOW_BUDGET_RATIO = 0.2;

// The remaining-step count at or below which the cycle budget counts as "low",
// proportional to maxSteps. Returns 0 for an unknown/non-positive budget so a
// missing maxSteps never spuriously trips "low" (the caller's exhausted check on
// remaining <= 0 owns that case instead).
function lowCycleRemainingThreshold(maxSteps) {
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return 0;
  return Math.ceil(maxSteps * CYCLE_LOW_BUDGET_RATIO);
}

// Classify the cycle budget purely from maxSteps + cycleCount:
//   "unknown"   — no usable maxSteps
//   "exhausted" — no remaining steps
//   "low"       — within the final CYCLE_LOW_BUDGET_RATIO slice
//   "enough"    — otherwise
function readCycleBudgetState(maxSteps, cycleCount) {
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return "unknown";
  const used = Number.isFinite(cycleCount) ? cycleCount : 0;
  const remaining = Math.max(maxSteps - used, 0);
  if (remaining === 0) return "exhausted";
  if (remaining <= lowCycleRemainingThreshold(maxSteps)) return "low";
  return "enough";
}

export { CYCLE_LOW_BUDGET_RATIO, lowCycleRemainingThreshold, readCycleBudgetState };
