import { createStructuredError, ERROR_CODES } from './errors.js';
import { readString } from './semantic-json.js';
import { finishFailure, recordObservation, startEvaluatePhase, completeEvaluatePhase } from './finalizer.js';
import { completePhase } from './oodae.js';
import { readFailureMessage } from './action-loop-utils.js';
import { noteRecoveryAttempt, buildPlannerRepairSignal } from './planner-recovery.js';
import { refreshInvalidActionConvergence, buildInvalidActionConvergenceStepDetail } from './invalid-action-convergence.js';

function handleInvalidPlannerDecision(options) {
  const {
    cycleRecord,
    memoryEntriesAdded,
    normalizedInput,
    plannerResult,
    pushStep,
    rawInput,
    runState,
    runtimeState,
    steps
  } = options;

  // Normalized once here (SSOT) so the diagnostic step and the downstream
  // convergence calls below read the same offending-action name and failure
  // reason rather than re-deriving them with subtly different coercions.
  const rejectedActionName = typeof plannerResult.rejectedActionName === "string"
    ? plannerResult.rejectedActionName
    : null;
  const invalidKind = readString(plannerResult && plannerResult.invalidKind);

  // Diagnostic snapshot of WHY the cycle was invalid and WHAT the model
  // emitted. The raw response body already rides the preceding
  // `planner-responded` step (responseText), but the failure reason
  // (invalidKind) and the offending action name (rejectedActionName) were
  // computed only for downstream convergence and never surfaced on the
  // invalid-action event itself. Without them a reviewer cannot tell an
  // unknown-action loop from a malformed-JSON loop, which is the exact gap
  // the TNO benchmark flagged (Gemini publish/repair invalid-action churn).
  pushStep("planner-invalid-action", {
    cycle: runState.cycleCount,
    invalidActionCount: runState.plannerInvalidCount + 1,
    invalidKind: invalidKind || "invalid_planner_output",
    rejectedActionName,
    repairAttempted: plannerResult.repairAttempted === true,
    responsePreview: readInvalidResponsePreview(plannerResult)
  });
  runState.plannerInvalidCount += 1;
  // AGRUN-486 (audit H8) — tick the repair budget ONLY when the runtime
  // actually spent the extra repair LLM call this cycle and it still failed.
  // After MAX_RECOVERY_RETRIES such cycles, planner.js gates the next repair
  // off (see planner-repair-budget-exhausted). A valid decision clears the
  // streak via resetRecoveryBudget in action-loop-planner.js.
  if (plannerResult.repairAttempted === true) {
    noteRecoveryAttempt(runState, invalidKind || "planner_repair_failed");
  }
  runState.plannerInvalidSignal = createPlannerInvalidSignal(runState, plannerResult);
  if (runState.plannerInvalidSignal.escalation === "hard_veto") {
    pushStep("planner-invalid-signal-escalated", {
      cycle: runState.cycleCount,
      invalidActionCount: runState.plannerInvalidSignal.count,
      requiredEnvelope: runState.plannerInvalidSignal.requiredEnvelope
    });
  }
  // ADR-0034 — surface invalid-action loop as an AI-visible, host-observable
  // signal. Both planner-invalid-action and planner-repair-failed are
  // represented here because handleInvalidPlannerDecision runs once per
  // failed cycle and the planner.js return shape tells us whether repair
  // was attempted. Counters track each event independently and `active`
  // fires off max(consecutiveInvalidCount, consecutiveRepairFailureCount).
  const availableActions = Array.isArray(runState.availableActions) ? runState.availableActions : [];
  const availableAgentSkillIds = Array.isArray(runState.availableAgentSkills)
    ? runState.availableAgentSkills.map((s) => (s && typeof s === "object" && typeof s.name === "string" ? s.name : "")).filter(Boolean)
    : [];
  refreshInvalidActionConvergence(runState, {
    event: "planner_invalid_action",
    actionName: rejectedActionName,
    reason: invalidKind || "invalid_planner_output",
    availableActions,
    availableAgentSkillIds
  });
  if (plannerResult.repairAttempted === true) {
    refreshInvalidActionConvergence(runState, {
      event: "planner_repair_failed",
      actionName: rejectedActionName,
      reason: invalidKind || "planner_repair_failed",
      availableActions,
      availableAgentSkillIds
    });
  }
  pushStep("invalid-action-convergence-refreshed", buildInvalidActionConvergenceStepDetail(runState.invalidActionConvergence));
  recordObservation(
    runState,
    pushStep,
    {
      kind: "planner_invalid_action",
      // AGRUN-476 (audit M9) — guard `response` like the two sibling reads in
      // this file (createPlannerInvalidSignal:145, readInvalidResponsePreview).
      // The planner can legitimately return `response: null` (e.g.
      // createCircuitOpenPlannerResult in planner.js), so a bare
      // `plannerResult.response.text` would throw an uncaught TypeError here
      // and kill the run loop instead of recording the invalid-action
      // observation. readString also normalizes the value to a clean string
      // before it rides into the planner prompt.
      responseText: readString(plannerResult && plannerResult.response && plannerResult.response.text)
    },
    {
      cycle: runState.cycleCount,
      kind: "planner_invalid_action",
      source: "planner"
    }
  );
  completePhase(
    cycleRecord,
    pushStep,
    "decide",
    {
      cycle: runState.cycleCount,
      decisionSource: "planner",
      decisionType: "invalid",
      outcome: "error",
      selectedSkill: null
    }
  );
  completePhase(
    cycleRecord,
    pushStep,
    "act",
    {
      actionName: null,
      approvalStatus: null,
      outcome: "skipped",
      resultKind: "invalid"
    }
  );

  startEvaluatePhase(runState, pushStep, null);
  completeEvaluatePhase(cycleRecord, pushStep, {
    nextPromptState: "retry_planner",
    plannerInvalidSignal: runState.plannerInvalidSignal,
    observationKind: runState.observation.kind,
    outcome: "continue"
  });

  return {
    done: false
  };
}

function createPlannerInvalidSignal(runState, plannerResult) {
  const count = Number.isInteger(runState && runState.plannerInvalidCount)
    ? runState.plannerInvalidCount
    : 0;
  const responseText = readString(plannerResult && plannerResult.response && plannerResult.response.text);
  return buildPlannerRepairSignal({
    count,
    lastResponsePreview: responseText,
    reason: readString(plannerResult && plannerResult.invalidKind) || "invalid_planner_output",
    source: "planner"
  });
}


// Length-bounded preview of the offending planner response. Prefers the
// assistant text; falls back to a compact dump of the tool calls (the
// common case for native-tool unknown_action_name). NOTE: this only caps
// length — it does NOT redact. The tool-call dump carries raw model-authored
// arguments verbatim, so any host surfacing this step (inspector/progress)
// owns redaction. Capped because full bodies already flow via the trace
// contract.
const INVALID_RESPONSE_PREVIEW_CHARS = 2000;
function readInvalidResponsePreview(plannerResult) {
  const response = plannerResult && typeof plannerResult.response === "object"
    ? plannerResult.response
    : null;
  if (!response) return "";
  const text = readString(response.text);
  if (text) return truncatePreview(text, INVALID_RESPONSE_PREVIEW_CHARS);
  if (Array.isArray(response.toolCalls) && response.toolCalls.length > 0) {
    try {
      return truncatePreview(JSON.stringify(response.toolCalls), INVALID_RESPONSE_PREVIEW_CHARS);
    } catch {
      return "";
    }
  }
  return "";
}

function truncatePreview(value, maxChars) {
  const text = readString(value);
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function finalizeActionLoopFailure(options) {
  const error = createStructuredError(
    options.code,
    readFailureMessage(options.code, options.actionName),
    options.actionName || null,
    options.cause || null
  );
  options.runState.evaluationState = {
    actionName: options.actionName || null,
    clarificationLoopRisk: false,
    hasExternalEvidence: false,
    nextState: "stop",
    openAmbiguity: null,
    outcome: "error"
  };

  return finishFailure({
    cycleRecord: options.cycleRecord,
    error,
    evaluationDetail: {
      errorSource: (
        options.code === ERROR_CODES.PLANNER_ERROR ||
        options.code === ERROR_CODES.PLANNER_INVALID_ACTION
      )
        ? "decide"
        : "act",
      outcome: "error"
    },
    memoryEntriesAdded: options.memoryEntriesAdded,
    normalizedInput: options.normalizedInput,
    output: options.output,
    pushStep: options.pushStep,
    rawInput: options.rawInput,
    runState: options.runState,
    runtimeState: options.runtimeState,
    selectedSkill: null,
    steps: options.steps
  });
}

export { finalizeActionLoopFailure, handleInvalidPlannerDecision };
