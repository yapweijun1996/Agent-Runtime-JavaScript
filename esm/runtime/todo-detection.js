// SSOT for "is this run todo-shaped" used across the TodoState autopilot
// subsystem. AGRUN-246-D/C2.4: the only runtime-owned signal is the structured
// TodoState declared by the planner through todo_plan. Prompt regex fallbacks,
// including host-provided corePattern/extendedPattern hooks, are deliberately
// removed so the runtime cannot reclassify user intent from raw prompt text.

function readString$12(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isTodoShapedRun(runState) {
  return !!(runState && runState.todoState);
}

export { isTodoShapedRun, readString$12 as readString };
