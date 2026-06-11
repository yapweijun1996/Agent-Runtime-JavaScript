// SSOT for read-only TodoState queries shared across the autopilot,
// action handlers, and lifecycle projection. Keeping these in one
// place prevents the cascading-fallback semantics (id-match preferred,
// then any "active" item) from drifting between callers.
//
// All functions are null-safe: they tolerate `null`/missing
// `todoState`, missing `items`, and non-array shapes.

function getTodoItems(todoState) {
  return todoState && Array.isArray(todoState.items) ? todoState.items : [];
}

function findActiveTodoItem$2(todoState) {
  const items = getTodoItems(todoState);
  if (items.length === 0) return null;
  const activeItemId = todoState && typeof todoState.activeItemId === "string" && todoState.activeItemId
    ? todoState.activeItemId
    : null;
  if (activeItemId) {
    const byId = items.find((item) => item && item.id === activeItemId && item.status === "active");
    if (byId) return byId;
  }
  return items.find((item) => item && item.status === "active") || null;
}

function findFirstPendingItem(todoState) {
  const items = getTodoItems(todoState);
  return items.find((item) => item && item.status === "pending") || null;
}

function findItemsByStatus(todoState, status) {
  return getTodoItems(todoState).filter((item) => item && item.status === status);
}

function countItemsByStatus(todoState, status) {
  return findItemsByStatus(todoState, status).length;
}

function findItemIndexById(todoState, itemId) {
  const items = getTodoItems(todoState);
  if (!itemId) return -1;
  return items.findIndex((item) => item && item.id === itemId);
}

export { countItemsByStatus, findActiveTodoItem$2 as findActiveTodoItem, findFirstPendingItem, findItemIndexById, findItemsByStatus, getTodoItems };
