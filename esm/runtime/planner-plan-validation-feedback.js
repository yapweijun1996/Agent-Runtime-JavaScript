import { readString } from './semantic-json.js';

function summarizePlanValidationFeedbackForPrompt(observation) {
  if (!observation || typeof observation !== "object") return null;
  const output = observation.output && typeof observation.output === "object"
    ? observation.output
    : null;
  if (!output || output.kind !== "plan_result" || output.ok !== false || output.stage !== "validation") {
    return null;
  }
  const feedback = output.planner_feedback && typeof output.planner_feedback === "object"
    ? output.planner_feedback
    : null;
  const summary = {
    kind: "plan_validation_feedback",
    actionName: readString(observation.actionName) || "plan",
    error: readString(output.error),
    stage: "validation"
  };
  if (feedback) {
    summary.code = readString(feedback.code);
    summary.detail = readString(feedback.detail);
  }
  summary.contract = "type:\"plan\" actions must be independent non-mutating actions whose policy is allow. State-mutating or approval-gated actions need their own standalone type:\"action\" envelope.";
  return summary;
}

export { summarizePlanValidationFeedbackForPrompt };
