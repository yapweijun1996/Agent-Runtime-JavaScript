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
    actionName: readString$v(observation.actionName) || "plan",
    error: readString$v(output.error),
    stage: "validation"
  };
  if (feedback) {
    summary.code = readString$v(feedback.code);
    summary.detail = readString$v(feedback.detail);
  }
  summary.contract = "type:\"plan\" actions must be independent non-mutating actions whose policy is allow. State-mutating or approval-gated actions need their own standalone type:\"action\" envelope.";
  return summary;
}

function readString$v(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { summarizePlanValidationFeedbackForPrompt };
