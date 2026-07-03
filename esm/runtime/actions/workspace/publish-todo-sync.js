import { PUBLISH_DIRECT_ACTION } from '../../action-names.js';
import { readString } from '../../semantic-json.js';
import { isBudgetConstrainedForLimitedPublish, isValidTerminalRepairPublishArgs } from '../../terminal-repair/publish-contract.js';

// TodoState publish-sync gate, extracted from virtual-workspace-actions.js
// (AGRUN-451 slice 6 — component D of the publish-readiness cluster).
// inspectPublishTodoStateSync blocks a terminal workspace_publish_candidate
// while TodoState still has unfinished items (unless a terminal-repair limited
// publish is allowed); the other three are its helpers (limited-publish
// allowance, active-item lookup, status tally). The cluster is closed: the only
// intra-cluster edges are inspectPublishTodoStateSync -> the other three;
// nothing here calls back into virtual-workspace-actions.js. The publish
// executor imports inspectPublishTodoStateSync back.


function inspectPublishTodoStateSync(context, finalReadiness, publishPath) {
  const todoState = context && context.runState && context.runState.todoState;
  if (!todoState || typeof todoState !== "object") return { ok: true };
  if (todoState.terminatedAt) return { ok: true };
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  if (items.length === 0) return { ok: true };
  const unfinished = items.filter((item) => {
    const status = readString(item && item.status) || "pending";
    return status === "active" || status === "pending" || status === "blocked";
  });
  if (unfinished.length === 0) return { ok: true };
  if (canPublishLimitedWithUnfinishedTodo(context, finalReadiness, publishPath)) {
    return {
      ok: true,
      status: "todo_state_limited_with_remaining_gaps"
    };
  }
  const activeItem = findActiveTodoItem$1(todoState, items);
  const activeLabel = readString(activeItem && activeItem.label) || readString(unfinished[0] && unfinished[0].label) || "current TodoState item";
  const statusSummary = countTodoStatuses(items);
  return {
    ok: false,
    status: "todo_state_not_synced",
    message: `workspace_publish_candidate cannot be terminal while TodoState still has unfinished work. Active item: "${activeLabel}". Counts: done=${statusSummary.done}, active=${statusSummary.active}, pending=${statusSummary.pending}, blocked=${statusSummary.blocked}, abandoned=${statusSummary.abandoned}, total=${statusSummary.total}. If the work is complete, choose todo_run_next or todo_advance before publishing; if the plan changed, use todo_plan or todo_cancel. Runtime will not auto-complete TodoState for the AI.`
  };
}

function canPublishLimitedWithUnfinishedTodo(context, finalReadiness, publishPath) {
  const repair = context &&
    context.runState &&
    context.runState.terminalRepairState &&
    typeof context.runState.terminalRepairState === "object"
    ? context.runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return false;
  if (!Array.isArray(repair.activeDeficits) || !repair.activeDeficits.includes("todo")) return false;
  if (!Array.isArray(repair.allowedActions) || !repair.allowedActions.includes(PUBLISH_DIRECT_ACTION)) {
    return false;
  }
  if (!isBudgetConstrainedForLimitedPublish(repair)) return false;
  return isValidTerminalRepairPublishArgs({ finalReadiness, path: publishPath }, repair, {
    runState: context && context.runState
  });
}

function findActiveTodoItem$1(todoState, items) {
  const activeItemId = readString(todoState && todoState.activeItemId);
  if (activeItemId) {
    const byId = items.find((item) => item && item.id === activeItemId && item.status === "active");
    if (byId) return byId;
  }
  return items.find((item) => item && item.status === "active") || null;
}

function countTodoStatuses(items) {
  const counts = {
    abandoned: 0,
    active: 0,
    blocked: 0,
    done: 0,
    pending: 0,
    total: 0
  };
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    counts.total += 1;
    const status = readString(item.status) || "pending";
    if (status === "done") counts.done += 1;
    else if (status === "active") counts.active += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "abandoned") counts.abandoned += 1;
    else counts.pending += 1;
  }
  return counts;
}

export { canPublishLimitedWithUnfinishedTodo, countTodoStatuses, findActiveTodoItem$1 as findActiveTodoItem, inspectPublishTodoStateSync };
