import { readPlanActionFallbackArgs } from './plan-args-fallback.js';
import { EXECUTE_SKILL_TOOL_ACTION } from './action-names.js';

function isValidDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  if (value.type === "final" && typeof value.answer === "string" && value.answer.trim().length > 0) {
    return true;
  }

  if (value.type === "clarify" && typeof value.question === "string" && value.question.trim().length > 0) {
    return true;
  }

  if (value.type === "finalize") {
    return true;
  }

  if (value.type === "plan") {
    return Array.isArray(value.actions) && value.actions.length > 0;
  }

  return value.type === "action" && typeof value.name === "string" && value.name.trim().length > 0;
}

function readActionArgs(decision) {
  if (decision.type === "clarify") {
    return { question: decision.question };
  }

  const base = readObject$1(decision.args) || readObject$1(decision.arguments) || {};
  const fallbackArgs = readPlanActionFallbackArgs(decision);
  const actionName = typeof decision.name === "string" ? decision.name.trim() : "";

  if (typeof decision.skillName === "string" && decision.skillName && !base.skillName) {
    base.skillName = decision.skillName;
  }
  if (typeof decision.toolName === "string" && decision.toolName && !base.toolName) {
    base.toolName = decision.toolName;
  }
  if (fallbackArgs) {
    if (actionName === EXECUTE_SKILL_TOOL_ACTION) {
      if (!readObject$1(base.args)) {
        base.args = fallbackArgs;
      }
    } else {
      for (const [key, value] of Object.entries(fallbackArgs)) {
        if (base[key] == null) {
          base[key] = value;
        }
      }
    }
  }

  return base;
}

function readObject$1(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : null;
}

function readDeniedActions(history) {
  return history
    .filter((entry) => entry.kind === "denied" && typeof entry.actionName === "string")
    .map((entry) => entry.actionName);
}

function readFailureMessage(code, actionName) {
  if (code === "PLANNER_ERROR") {
    return "Planner request failed.";
  }

  if (code === "PLANNER_INVALID_ACTION") {
    return "Planner returned an invalid action envelope.";
  }

  if (code === "ACTION_EXECUTE_ERROR") {
    return `Action "${actionName || "unknown"}" failed during execution.`;
  }

  if (code === "APPROVAL_RESOLUTION_ERROR") {
    return "Approval resolution could not resume the requested action.";
  }

  if (code === "MAX_STEPS_EXCEEDED") {
    return "Action loop exceeded maxSteps without reaching a terminal output.";
  }

  if (code === "RUN_DEADLINE_EXCEEDED") {
    return "Action loop exceeded the configured runDeadlineMs without reaching a terminal output.";
  }

  if (code === "COST_BUDGET_EXCEEDED") {
    return "Action loop exceeded the configured maxCostUsd budget without reaching a terminal output.";
  }

  return "Action loop failed.";
}

function nextActionCallId(runState) {
  if (!runState || typeof runState !== "object") {
    return null;
  }
  if (typeof runState.actionCallCounter !== "number" || !Number.isFinite(runState.actionCallCounter)) {
    runState.actionCallCounter = 0;
  }
  runState.actionCallCounter += 1;
  const runId = typeof runState.runId === "string" && runState.runId ? runState.runId : "run";
  const cycle = typeof runState.cycleCount === "number" && Number.isFinite(runState.cycleCount) ? runState.cycleCount : 0;
  return `${runId}-c${cycle}-a${runState.actionCallCounter}`;
}

// AGRUN-204 — No default endpoint. Returns the host-supplied URL when
// present, otherwise an empty string. Downstream `normalizeWebSearchRequest`
// rejects empty endpoints for the SearXNG provider with a clear error.
function readWebSearchEndpoint(rawInput, request) {
  if (request && typeof request === "object" && typeof request.webSearchEndpoint === "string" && request.webSearchEndpoint.trim()) {
    return request.webSearchEndpoint.trim();
  }

  if (rawInput && typeof rawInput === "object" && typeof rawInput.webSearchEndpoint === "string" && rawInput.webSearchEndpoint.trim()) {
    return rawInput.webSearchEndpoint.trim();
  }

  return "";
}

export { isValidDecision, nextActionCallId, readActionArgs, readDeniedActions, readFailureMessage, readWebSearchEndpoint };
