import { summarizeActionPatternConvergence } from '../action-pattern-convergence.js';
import { summarizeTerminalRepairState } from '../terminal-repair/core.js';
import { summarizeRequirementRecoveryEvaluator } from '../requirement-recovery-evaluator.js';
import { summarizeReadUrlRecoverySignal } from '../read-url-recovery-signal.js';

// Phase B1 (agrun_docs/ROADMAP.md, 2026-07-02) — per-cycle relevance gates for
// the "If loopState.X ..." advisory lines in the planner directive sections.
// Each advisory only helps when its signal can actually appear in this cycle's
// loopState JSON; on idle cycles (fresh runs, simple Q&A turns) the lines are
// dead text that costs tokens and planner latency on every turn (measured:
// planner-compact-directives was 5940 chars / ~24% of a minimal-tier request,
// agrun_docs/audits/agrun-vs-openai-agents-sdk-benchmark-2026-07-02.md §4).
//
// SSOT: gates reuse the SAME summarizers the loopState JSON projection uses
// (planner-prompt.js buildPlannerPrompt), so an advisory line renders exactly
// when its signal renders — the AI is never told about machinery it cannot
// see, and never loses guidance for a signal that is present.
//
// No runState in ctx (host override previews, the frozen default exports,
// prompt fixtures built without state) => every gate is open => full text,
// byte-identical to the pre-gating build.

const ALL_OPEN = Object.freeze({
  actionGuardrail: true,
  convergence: true,
  patchRepair: true,
  readUrlRecovery: true,
  requirementRecovery: true,
  researchAcceptance: true,
  terminalRepair: true
});

function computeDirectiveGates(ctx) {
  const runState = ctx && typeof ctx === "object" ? ctx.runState : null;
  if (!runState || typeof runState !== "object") return ALL_OPEN;

  const convergence = summarizeActionPatternConvergence(runState.actionPatternConvergence) != null;
  const terminalRepair = summarizeTerminalRepairState(runState.terminalRepairState) != null;
  return {
    // Mirrors summarizeActionGuardrailForPrompt (planner-prompt.js — private
    // there; importing it here would be circular): the loopState field renders
    // only for a non-allow latestDecision with a code.
    actionGuardrail: hasActionGuardrailDecision(runState.actionGuardrail),
    convergence,
    // The patch-repair playbook lines only matter once a repair/convergence
    // signal is steering the run toward targeted workspace repair.
    patchRepair: convergence || terminalRepair,
    readUrlRecovery: hasReadUrlRecoveryCondition(runState.readUrlRecoverySignal),
    requirementRecovery: hasRequirementRecoveryCondition(runState.requirementRecoveryEvaluator),
    // The advisory line references acceptanceConvergenceSignal specifically —
    // the evaluator summary itself renders during any research run.
    researchAcceptance: hasResearchAcceptanceSignal(runState.researchAcceptanceEvaluator),
    terminalRepair
  };
}

function hasActionGuardrailDecision(value) {
  const latest = value && typeof value === "object" && value.latestDecision && typeof value.latestDecision === "object"
    ? value.latestDecision
    : null;
  if (!latest) return false;
  const action = typeof latest.action === "string" ? latest.action.trim() : "";
  const code = typeof latest.code === "string" ? latest.code.trim() : "";
  return Boolean(action) && action !== "allow" && Boolean(code);
}

function hasRequirementRecoveryCondition(value) {
  return isRequirementRecoverySummaryActionable(summarizeRequirementRecoveryEvaluator(value));
}

// Exported for the loopState prompt projection (Phase B2): unlike the other
// signal summarizers, summarizeRequirementRecoveryEvaluator returns a full
// idle "tracking" object, so both the advisory-line gate above and the
// loopState JSON pruning key off the same actionable-state predicate.
function isRequirementRecoverySummaryActionable(summary) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.validLimitedAllowed === false) return true;
  const repeated = summary.convergence && typeof summary.convergence === "object"
    ? summary.convergence.repeatedInvalidTerminalCount
    : 0;
  return Number.isFinite(repeated) && repeated >= 1;
}

function hasResearchAcceptanceSignal(value) {
  return Boolean(
    value
    && typeof value === "object"
    && value.acceptanceConvergenceSignal
    && typeof value.acceptanceConvergenceSignal === "object"
  );
}

function hasReadUrlRecoveryCondition(value) {
  const summary = summarizeReadUrlRecoverySignal(value);
  if (!summary) return false;
  return summary.status === "needs_alternate_source" || summary.status === "source_blocked";
}

export { computeDirectiveGates, isRequirementRecoverySummaryActionable };
