import { applyTodoPlan, createTodoState } from './todo-state.js';
import { normalizeTodoAutopilotConfig } from './todo-autopilot.js';
import { TODO_PLANNING_PLACEHOLDER_LABEL, TODO_PLANNING_PLACEHOLDER_ID } from './todo-planning-placeholder.js';
import { isTodoShapedRun, readString } from './todo-detection.js';

function maybeAutostartTodoState(runState, config) {
  const normalized = normalizeTodoAutopilotConfig(config);
  // AGRUN-212a amendment 2E — Autostart placeholder injection is now
  // strictly opt-in via `autostart: true`. Default is OFF, so the
  // runtime never auto-injects a generic "Plan the work" placeholder.
  // The harness contract is: the planner reads the user prompt, decides
  // whether the task is multi-step, and calls `todo_plan` with
  // task-specific items. Auto-injecting placeholder items was patch-thinking
  // (treat-the-symptom: "no plan yet, fabricate one") and conflicted
  // with the agent's own planning surface.
  if (!normalized.enabled || !normalized.autostart) return null;
  if (!runState || typeof runState !== "object" || runState.todoState) return null;
  if (!isTodoShapedRun(runState)) return null;

  const goal = readString(runState.observationSummary && runState.observationSummary.prompt)
    || readString(runState.originalQuery)
    || "Complete the multi-step task";
  const next = applyTodoPlan(createTodoState({ goal }), {
    activeItemId: TODO_PLANNING_PLACEHOLDER_ID,
    goal,
    items: [{
      id: TODO_PLANNING_PLACEHOLDER_ID,
      label: TODO_PLANNING_PLACEHOLDER_LABEL,
      status: "pending",
      notes: [{
        at: Date.now(),
        kind: "replan",
        text: "Runtime placeholder only. Planner must replace this with a task-specific todo_plan before doing the work."
      }]
    }],
    note: "Autopilot created a planning placeholder for a multi-step run"
  });
  runState.todoState = next;
  return next;
}

export { maybeAutostartTodoState };
