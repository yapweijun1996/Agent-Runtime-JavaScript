function readFinalSourcePrompt(runState, request) {
  const state = runState && typeof runState === "object" ? runState : {};
  return readNonResumePrompt(state.observationSummary && state.observationSummary.prompt) ||
    readNonResumePrompt(state.originalQuery) ||
    readString$1o(state.todoState && state.todoState.goal) ||
    readNonResumePrompt(state.threadGoalAnchorText) ||
    readNonResumePrompt(request && request.prompt);
}

function readNonResumePrompt(value) {
  const text = readString$1o(value);
  if (/^resume\s+the\s+paused\s+long[-\s]?running\s+task\b/i.test(text)) {
    return "";
  }
  return text;
}

function readString$1o(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { readFinalSourcePrompt, readNonResumePrompt };
