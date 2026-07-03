import { readString } from './semantic-json.js';

// AI-first terminal Todo handling.
//
// History:
//   1. Original patch marked every unfinished item as done when the run
//      finalized. UI looked tidy but runtime was rewriting AI progress
//      (push-mode). Deleted.
//   2. Replacement patch recorded the observation and then nulled
//      `runState.todoState`. UI was tidy AND items were not falsely marked
//      done — but the side effect was that the active thread's todoState
//      snapshot in IndexedDB also became null (handle.js mirrors
//      runState.todoState back onto the thread). Anyone debugging the
//      session at rest then saw "AI never had a Todo plan" while the
//      activity log clearly showed todo_plan / todo_advance. The
//      mismatch between TodoState audit and activity log was caught in
//      the 2026-05-11 live e2e (see
//      agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md).
//   3. Current shape (this file): annotate, do not destroy.
//      `observeTodoStateOnTerminal` adds two read-only fields
//      (`terminatedAt`, `terminatedBy`) onto the existing todoState so
//      the audit trail survives in `activeThread.todoState`. Items keep
//      their honest status (no false completion). The "do not steer the
//      next turn" responsibility moves to two prompt-projection gates:
//        - `isTerminalTodoState` in `run-state-thread.js` treats a
//          todoState carrying `terminatedAt` as terminal, so the next
//          turn's hydration nulls `runState.todoState` (clean slate).
//        - `summarizeTodoStateForPrompt` / `hasPromptTodoState` /
//          `buildTodoStateBlockForCycle` skip rendering when
//          `terminatedAt` is set, defensively at every render site.


function observeTodoStateOnTerminal(runState, options = {}) {
  if (!runState || typeof runState !== "object") return false;
  const todoState = runState.todoState;
  if (!todoState || typeof todoState !== "object") return false;
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  if (items.length === 0) return false;

  const observedAt = typeof options.observedAt === "number" ? options.observedAt : Date.now();
  const source = typeof options.source === "string" && options.source.trim()
    ? options.source.trim()
    : "runtime_terminal_success";
  const counts = countStatuses(items);
  const activeItem = findActiveItem(todoState, items);
  const unfinishedCount = counts.active + counts.pending + counts.blocked;
  const observation = {
    activeItemId: readString(activeItem && activeItem.id) || null,
    activeItemLabel: readString(activeItem && activeItem.label) || null,
    counts,
    items: items.map((item) => ({
      id: readString(item && item.id) || null,
      label: readString(item && item.label) || null,
      status: readString(item && item.status) || "pending"
    })),
    observedAt,
    source,
    status: unfinishedCount > 0 ? "unfinished_at_terminal" : "already_terminal_or_complete",
    todoStateStatus: readString(todoState.status) || null,
    unfinishedCount
  };
  runState.todoTerminalObservation = observation;

  // Annotate the live todoState in place so anyone reading
  // `activeThread.todoState` (after handle.js mirrors runState back to
  // the thread record) can see (a) that this plan was terminated by a
  // terminal action and (b) that the items keep their honest status.
  // The annotation is also the signal that downstream prompt-projection
  // gates use to skip rendering on the next turn — runtime never
  // pretends the AI completed unfinished items.
  runState.todoState = {
    ...todoState,
    terminatedAt: observedAt,
    terminatedBy: source
  };
  return true;
}

function countStatuses(items) {
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
    const status = item.status;
    if (status === "done") counts.done += 1;
    else if (status === "active") counts.active += 1;
    else if (status === "blocked") counts.blocked += 1;
    else if (status === "abandoned") counts.abandoned += 1;
    else counts.pending += 1;
  }
  return counts;
}

function findActiveItem(todoState, items) {
  const activeItemId = readString(todoState && todoState.activeItemId);
  if (activeItemId) {
    const byId = items.find((item) => item && item.id === activeItemId && item.status === "active");
    if (byId) return byId;
  }
  return items.find((item) => item && item.status === "active") || null;
}

export { observeTodoStateOnTerminal };
