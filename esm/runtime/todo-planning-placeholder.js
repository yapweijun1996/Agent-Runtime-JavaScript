const TODO_PLANNING_PLACEHOLDER_ID = "auto-planning";
const TODO_PLANNING_PLACEHOLDER_LABEL = "Planning task breakdown";

function isTodoPlanningPlaceholder(todoState) {
  if (!todoState || typeof todoState !== "object" || !Array.isArray(todoState.items)) {
    return false;
  }
  return todoState.status === "active" &&
    todoState.activeItemId === TODO_PLANNING_PLACEHOLDER_ID &&
    todoState.items.length === 1 &&
    todoState.items[0] &&
    todoState.items[0].id === TODO_PLANNING_PLACEHOLDER_ID &&
    todoState.items[0].label === TODO_PLANNING_PLACEHOLDER_LABEL;
}

export { TODO_PLANNING_PLACEHOLDER_ID, TODO_PLANNING_PLACEHOLDER_LABEL, isTodoPlanningPlaceholder };
