import { applyTodoPlan, createTodoState } from './todo-state.js';
import { WEB_SEARCH_ACTION, READ_URL_ACTION, EXECUTE_SKILL_TOOL_ACTION, ASK_CLARIFICATION_ACTION } from './action-names.js';
import { normalizeTodoAutopilotConfig } from './todo-autopilot.js';
import { isTodoShapedRun, readString } from './todo-detection.js';

function maybeSeedTodoStateFromPlanDecision(runState, config, decision, planActions) {
  const normalized = normalizeTodoAutopilotConfig(config);
  if (!normalized.enabled) return null;
  if (!runState || typeof runState !== "object" || runState.todoState) return null;
  if (!isTodoShapedRun(runState) && !hasMultiActionPlan(planActions)) return null;

  const actions = Array.isArray(planActions) ? planActions : [];
  const items = buildPlanItems(decision, actions);
  if (items.length === 0) return null;

  const goal = readString(runState.observationSummary && runState.observationSummary.prompt)
    || readString(decision && decision.reasoning)
    || "Complete the planned multi-step task";
  const next = applyTodoPlan(createTodoState({ goal }), {
    activeItemId: items[0].id,
    goal,
    items,
    note: "Autopilot seeded TodoState from a planner plan decision"
  });
  runState.todoState = next;
  return next;
}

function buildPlanItems(decision, actions) {
  const items = [];
  const seen = new Set();

  for (const action of actions) {
    const label = labelForAction(action);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    items.push({ id: `plan-${items.length + 1}`, label, status: "pending" });
  }

  if (readString(decision && decision.synthesize_instruction) !== "direct") {
    const synthLabel = "Synthesize the final user-facing answer";
    if (!seen.has(synthLabel)) {
      items.push({ id: `plan-${items.length + 1}`, label: synthLabel, status: "pending" });
    }
  }

  return items.slice(0, 8);
}

function labelForAction(action) {
  const name = readString(action && action.name);
  if (name === WEB_SEARCH_ACTION) return "Search the web for relevant evidence";
  if (name === READ_URL_ACTION) return "Read selected source pages";
  if (name === EXECUTE_SKILL_TOOL_ACTION) return "Run the selected skill tool";
  if (name === ASK_CLARIFICATION_ACTION) return "Resolve the open clarification";
  if (name.startsWith("todo_")) return "";
  return name ? `Run ${name}` : "";
}

function hasMultiActionPlan(planActions) {
  return Array.isArray(planActions) && planActions.filter((item) => {
    const name = readString(item && item.name);
    return name && !name.startsWith("todo_");
  }).length > 1;
}

export { maybeSeedTodoStateFromPlanDecision };
