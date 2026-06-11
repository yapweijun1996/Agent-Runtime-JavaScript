import { projectSessionContextFromSnapshot, createSessionContextViewFromSnapshot } from '../session/context-snapshot-projection.js';
import { summarizeSessionContextMeta } from '../session/prompt.js';

function refreshProjectedSessionContext(runState) {
  const snapshot = runState && typeof runState === "object"
    ? runState.contextSnapshot
    : null;

  if (!snapshot) {
    if (runState && typeof runState === "object") {
      runState.sessionContextMeta = null;
      runState.sessionContextView = null;
    }
    return;
  }

  const projectedSessionContext = projectSessionContextFromSnapshot(snapshot);
  runState.sessionContextMeta = projectedSessionContext
    ? summarizeSessionContextMeta(projectedSessionContext)
    : null;
  runState.sessionContextView = projectedSessionContext
    ? createSessionContextViewFromSnapshot(snapshot)
    : null;
}

export { refreshProjectedSessionContext };
