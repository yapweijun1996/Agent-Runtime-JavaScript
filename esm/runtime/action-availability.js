function filterAvailableActions(actions, disabledActions) {
  const disabled = createDisabledActionSet(disabledActions);
  return (Array.isArray(actions) ? actions : []).filter((action) => !disabled.has(readActionName(action)));
}

function createDisabledActionSet(disabledActions) {
  return new Set(
    (Array.isArray(disabledActions) ? disabledActions : [])
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
  );
}

function readActionName(action) {
  return action && typeof action === "object" && typeof action.name === "string"
    ? action.name.trim()
    : "";
}

export { filterAvailableActions };
