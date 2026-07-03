import { cloneValue } from './utils.js';
import { EXECUTE_SKILL_TOOL_ACTION } from './action-names.js';
import { stampThreadProvenance } from './thread-provenance.js';
import { DEFAULT_TOOL_HISTORY_CAP } from './evidence-policy.js';

// Structured tool-evidence recording, shared by BOTH dispatch paths (single
// action in action-loop-action.js, plan batch in action-loop-plan-actions.js)
// so a host custom evidence action records the same toolContext history in a
// plan as it does standalone (cross-cutting-dispatch-matrix-2026-06-10.md §3).

function isHostCustomEvidenceAction(actionName, runtimeConfig) {
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  if (policy && policy.enabled === false) return false;
  if (policy && policy.structuredToolEvidence === false) return false;
  const customActions = Array.isArray(runtimeConfig && runtimeConfig.customActions)
    ? runtimeConfig.customActions
    : [];
  return customActions.some((action) => action && action.name === actionName);
}

// True for actions whose successful output should be folded into the
// structured tool-evidence context: the bundled-skill tool runner plus any
// host custom evidence action permitted by evidencePolicy.
function shouldRecordStructuredToolEvidence(actionName, runtimeConfig) {
  return actionName === EXECUTE_SKILL_TOOL_ACTION || isHostCustomEvidenceAction(actionName, runtimeConfig);
}

// Resolve the configured tool-history cap from runtimeConfig, falling back to
// the default when unset or invalid. Tolerates raw/normalized config shapes.
function resolveToolHistoryCap(runtimeConfig) {
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  const cap = policy ? policy.toolHistoryCap : undefined;
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_TOOL_HISTORY_CAP;
}

// SSOT for folding a tool/skill output into runState.toolContext: sets
// lastResult AND appends a thread-stamped clone to history, then caps history to
// the `cap` most-recent entries (drop-oldest). A long run calls this once per
// execute_skill_tool / custom evidence action, so without the cap the array
// grew unbounded in RAM (audit H5 / AGRUN-483). Used by BOTH the structured-
// evidence recorder and the plan failure path.
function recordToolContextResult(runState, output, cap) {
  if (!runState || typeof runState !== "object") return;
  if (!runState.toolContext || typeof runState.toolContext !== "object") return;
  if (!Array.isArray(runState.toolContext.history)) {
    runState.toolContext.history = [];
  }
  runState.toolContext.lastResult = cloneValue(output || null);
  runState.toolContext.history.push(
    stampThreadProvenance(cloneValue(output || null), runState)
  );
  const limit = Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_TOOL_HISTORY_CAP;
  if (runState.toolContext.history.length > limit) {
    runState.toolContext.history.splice(0, runState.toolContext.history.length - limit);
  }
}

function recordStructuredToolEvidence(runState, output, runtimeConfig) {
  recordToolContextResult(runState, output, resolveToolHistoryCap(runtimeConfig));
}

export { isHostCustomEvidenceAction, recordStructuredToolEvidence, recordToolContextResult, resolveToolHistoryCap, shouldRecordStructuredToolEvidence };
