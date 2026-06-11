import { applyTodoPlan, createTodoState } from './todo-state.js';
import { normalizeTodoAutopilotConfig } from './todo-autopilot.js';
import { isTodoShapedRun, readString } from './todo-detection.js';

const FAILURE_ITEM_ID = "planner-failed-before-plan";

function maybeCreatePlannerFailureTodoState(runState, config, error) {
  const normalized = normalizeTodoAutopilotConfig(config);
  if (!normalized.enabled) return null;
  if (!isTodoShapedRun(runState)) return null;
  if (!runState || typeof runState !== "object" || runState.todoState) return null;

  const goal = readString(runState.observationSummary && runState.observationSummary.prompt)
    || readString(runState.originalQuery)
    || "Complete the complex task";
  const message = readErrorMessage$3(error);
  const next = applyTodoPlan(createTodoState({ goal }), {
    goal,
    items: [{
      id: FAILURE_ITEM_ID,
      label: `Planning blocked: ${message}`,
      status: "blocked",
      notes: [{
        at: Date.now(),
        kind: "block",
        text: message
      }]
    }],
    note: "Planner failed before creating a task-specific TodoState"
  });
  runState.todoState = {
    ...next,
    activeItemId: null
  };
  return runState.todoState;
}

function readErrorMessage$3(error) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && typeof error.message === "string") return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Planner failed before creating a plan";
}

export { maybeCreatePlannerFailureTodoState };
