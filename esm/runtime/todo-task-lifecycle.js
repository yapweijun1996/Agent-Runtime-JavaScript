import { findActiveTodoItem, countItemsByStatus, findItemIndexById } from './todo-queries.js';

const TODO_TASK_LIFECYCLE_STATUSES = Object.freeze([
  "running",
  "paused",
  "blocked",
  "completed",
  "abandoned"
]);

const CONTINUATION_FINAL_SOURCE = "continuation_required";
const CONTINUATION_TERMINALIZER = "max_steps_continuation";

function readString$1s(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber$b(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function hasContinuationSignal(runState) {
  return runState?.finalAnswerSource === CONTINUATION_FINAL_SOURCE
    || runState?.terminalizedBy === CONTINUATION_TERMINALIZER;
}

function deriveLifecycleStatus(todoState, runState, counts) {
  if (todoState.status === "completed") return "completed";
  if (todoState.status === "abandoned") return "abandoned";
  if (hasContinuationSignal(runState)) return "paused";
  if (runState?.pendingApproval) return "blocked";
  if (counts.blocked > 0 && counts.active === 0) return "blocked";
  return "running";
}

function readActivePosition(todoState, activeItemId) {
  if (!activeItemId) return null;
  const index = findItemIndexById(todoState, activeItemId);
  return index >= 0 ? index + 1 : null;
}

/**
 * Project TodoState into a host-facing task lifecycle snapshot.
 *
 * This is deliberately read-only: no auto-advance, no auto-continue,
 * no UI-only mutation. Hosts can use the snapshot for progress panels,
 * stop/cancel affordances, reload recovery, and audit logs while the
 * planner remains the only owner of TodoState transitions.
 */
function projectTodoTaskLifecycle(runState) {
  const state = runState && typeof runState === "object" ? runState : {};
  const todoState = state.todoState && typeof state.todoState === "object"
    ? state.todoState
    : null;
  const items = Array.isArray(todoState?.items) ? todoState.items.filter(Boolean) : [];
  if (!todoState || items.length === 0) return null;

  const activeItem = findActiveTodoItem(todoState);
  const counts = {
    abandoned: countItemsByStatus(todoState, "abandoned"),
    active: countItemsByStatus(todoState, "active"),
    blocked: countItemsByStatus(todoState, "blocked"),
    done: countItemsByStatus(todoState, "done"),
    pending: countItemsByStatus(todoState, "pending"),
    total: items.length
  };
  const status = deriveLifecycleStatus(todoState, state, counts);
  const threadId = readString$1s(state.threadId) || "default";
  const todoId = readString$1s(todoState.id) || "todo";
  const activeItemId = readString$1s(activeItem?.id) || null;
  const hasUnfinishedWork = counts.active > 0 || counts.pending > 0;

  return {
    activeItemId,
    activeItemLabel: readString$1s(activeItem?.label) || null,
    activePosition: readActivePosition(todoState, activeItemId),
    canCancel: status === "running" || status === "paused" || status === "blocked",
    canContinue: status === "paused" && hasUnfinishedWork && !state.pendingApproval,
    counts,
    goal: readString$1s(todoState.goal) || null,
    reason: status === "paused"
      ? CONTINUATION_FINAL_SOURCE
      : (state.pendingApproval ? "pending_approval" : null),
    runId: readString$1s(state.runId) || null,
    status,
    taskId: `todo-task:${threadId}:${todoId}`,
    threadId,
    todoStateId: todoId,
    updatedAt: readNumber$b(todoState.updatedAt, null),
    version: Number.isInteger(todoState.version) ? todoState.version : 0
  };
}

export { TODO_TASK_LIFECYCLE_STATUSES, projectTodoTaskLifecycle };
