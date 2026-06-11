function classifyExecutionClass(inputResolution, contextSnapshot) {
  const inquiryContext = contextSnapshot && typeof contextSnapshot === "object"
    && contextSnapshot.inquiryContext && typeof contextSnapshot.inquiryContext === "object"
    ? contextSnapshot.inquiryContext
    : {};

  if (inquiryContext.pendingClarification && typeof inquiryContext.pendingClarification === "object") {
    return "clarification_gate";
  }

  return "research_loop";
}

export { classifyExecutionClass };
