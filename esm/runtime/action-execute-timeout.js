import { normalizeActionTimeoutMs, normalizeActionTimeoutBehavior } from './tool-schema.js';

// Shared single-step timeout race for action execute(). Used by BOTH dispatch
// paths — the single-action path (action-loop-action.js) and the plan-mode
// parallel path (action-loop-plan-actions.js) — so a hung execute() (native,
// custom action, or a bundled skill tool's func) can never hang the run.
// Note: the race does not cancel the underlying work; it unblocks the loop and
// surfaces a structured timeout the planner can react to.

const ACTION_TIMEOUT_REASON = "action_timeout";

function executeActionWithTimeout(action, actionContext, actionArgs) {
  const timeoutMs = normalizeActionTimeoutMs(action && action.timeoutMs);
  const timeoutBehavior = normalizeActionTimeoutBehavior(action && action.timeoutBehavior);
  let timeoutId = null;
  // NOTE (audit 2026-06-10 C1, refuted): a late rejection of executePromise after
  // the timeout wins the race is NOT an unhandled rejection — Promise.race below
  // attaches its own reject reaction to executePromise, which marks the rejection
  // handled (it no-ops because the race already settled). No NOOP guard is needed;
  // action-execute-timeout-dangling-rejection.test.js pins this behavior so a
  // future refactor that detaches executePromise from the race would fail loudly.
  const executePromise = Promise.resolve()
    .then(() => action.execute(actionContext, actionArgs))
    .then((rawResult) => ({ rawResult, timedOut: false }));
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      const message = buildActionTimeoutMessage(action && action.name, timeoutMs);
      if (timeoutBehavior === "raise_exception") {
        reject(createActionTimeoutError(message, timeoutMs, timeoutBehavior));
        return;
      }
      resolve({
        message,
        timedOut: true,
        timeoutBehavior,
        timeoutMs
      });
    }, timeoutMs);
  });
  return Promise.race([executePromise, timeoutPromise])
    .finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
}

function createActionTimeoutError(message, timeoutMs, timeoutBehavior) {
  const error = new Error(message);
  error.name = "ActionTimeoutError";
  error.code = ACTION_TIMEOUT_REASON;
  error.timeoutBehavior = timeoutBehavior;
  error.timeoutMs = timeoutMs;
  return error;
}

function buildActionTimeoutMessage(actionName, timeoutMs) {
  return `${actionName || "action"} timed out after ${timeoutMs}ms`;
}

export { ACTION_TIMEOUT_REASON, buildActionTimeoutMessage, createActionTimeoutError, executeActionWithTimeout };
