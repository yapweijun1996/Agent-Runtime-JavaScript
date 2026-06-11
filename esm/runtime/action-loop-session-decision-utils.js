import { readString } from './semantic-json.js';

// ADR-0026 — Threshold for surfacing the consecutive-failure signal in
// loopState.actionFailureSignal. Pre-ADR-0026 this constant gated a
// runtime force-finalize (push-mode); now it gates a read-only signal.
// AI sees the signal in the next planner prompt and decides whether to
// switch tactics, finalize, or keep retrying.
const CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD = 2;

// ADR-0028 — `readContinuityDecision` deleted along with
// `resolveResearchContinuation`. Runtime no longer authors a
// continuation decision; AI owns the next-action choice.

function isDecisionActionAvailable(decision, availableActions) {
  if (!decision || typeof decision !== "object") {
    return false;
  }

  const actionName = readString(decision.name);
  if (!actionName) {
    return false;
  }

  return (Array.isArray(availableActions) ? availableActions : []).some(
    (action) => action && typeof action === "object" && readString(action.name) === actionName
  );
}

function countConsecutiveActionFailures(actionHistory, actionName) {
  let count = 0;

  for (let index = actionHistory.length - 1; index >= 0; index -= 1) {
    const entry = actionHistory[index];
    if (!entry || typeof entry !== "object") {
      break;
    }

    if (entry.kind === "action_error" && entry.actionName === actionName) {
      count += 1;
      continue;
    }

    if (entry.kind === "planner_invalid_action") {
      continue;
    }

    break;
  }

  return count;
}

// ADR-0026 — Derives the read-only `actionFailureSignal` for the next
// planner prompt. Returns `null` when no action has reached the
// threshold, or `{ actionName, consecutiveCount, threshold }` when
// the most recent action_error tail crosses CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD.
// Caller threads this into loopState; AI decides what to do.
function summarizeActionFailureSignal(actionHistory) {
  if (!Array.isArray(actionHistory) || actionHistory.length === 0) {
    return null;
  }

  // Walk backwards to find the most recent action_error and its actionName.
  let candidateName = null;
  for (let index = actionHistory.length - 1; index >= 0; index -= 1) {
    const entry = actionHistory[index];
    if (!entry || typeof entry !== "object") {
      break;
    }
    if (entry.kind === "action_error") {
      candidateName = readString(entry.actionName) || null;
      break;
    }
    if (entry.kind === "planner_invalid_action") {
      continue;
    }
    // Most recent non-error entry — no signal at the tail.
    return null;
  }

  if (!candidateName) {
    return null;
  }

  const consecutiveCount = countConsecutiveActionFailures(actionHistory, candidateName);
  if (consecutiveCount < CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD) {
    return null;
  }

  return {
    actionName: candidateName,
    consecutiveCount,
    threshold: CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD
  };
}

export { CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD, countConsecutiveActionFailures, isDecisionActionAvailable, summarizeActionFailureSignal };
