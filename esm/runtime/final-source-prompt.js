import { readString } from './semantic-json.js';

function readFinalSourcePrompt(runState, request) {
  const state = runState && typeof runState === "object" ? runState : {};
  return readNonResumePrompt(state.observationSummary && state.observationSummary.prompt) ||
    readNonResumePrompt(state.originalQuery) ||
    readString(state.todoState && state.todoState.goal) ||
    readNonResumePrompt(state.threadGoalAnchorText) ||
    readNonResumePrompt(request && request.prompt);
}

function readNonResumePrompt(value) {
  const text = readString(value);
  if (/^resume\s+the\s+paused\s+long[-\s]?running\s+task\b/i.test(text)) {
    return "";
  }
  return text;
}

export { readFinalSourcePrompt, readNonResumePrompt };
