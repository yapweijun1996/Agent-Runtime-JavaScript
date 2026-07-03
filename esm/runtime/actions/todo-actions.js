import { applyTodoPlan, serializeTodoState, applyTodoAdvance, applyTodoCancel, createTodoState } from '../todo-state.js';
import { findActiveTodoItem, findFirstPendingItem } from '../todo-queries.js';
import { normalizeVerificationPattern, DEFAULT_VERIFICATION_PATTERN } from '../todo-autopilot-rules.js';
import { normalizeTodoPromptStrings } from '../todo-prompt-strings.js';
import { resetTodoAutopilotVetoOnProgress } from '../todo-autopilot.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';
import { readString } from '../semantic-json.js';

/**
 * AGRUN-212a Phase C — Planner actions for TodoState.
 *
 * Single file because each action is a thin wrapper over
 * one applyTodo* function. Splitting into three files would force
 * identical "read runState.todoState, call apply*, return
 * control:continue" preludes — the harness lives in todo-state.js,
 * the actions are just plumbing.
 *
 * Contract:
 *   - All three actions read/write `runState.todoState` (a per-turn
 *     snapshot hydrated from the active thread; written back to
 *     `sessionRecord.threads[i].todoState` after the turn by handle.js).
 *   - Mutations go through `applyTodoPlan` / `applyTodoAdvance` /
 *     `applyTodoCancel` so the status-transition table, single-active-item
 *     invariant, and terminal-state rules cannot be bypassed.
 *   - `_provenance: {threadId, turnId}` is stamped from runState so
 *     every TodoItem mutation carries the same shape AGRUN-145
 *     evidence/messages already use.
 *   - `todo_inspect` is read-only — no state mutation, no version bump.
 *   - All three return `control: "continue"` so the planner can keep
 *     iterating in the same turn (e.g. `todo_plan` then `todo_advance`).
 */



// Threshold mirrors claude-code TodoWriteTool — for trivial 1-2 step
// plans, the verifier nudge is not worth the loop cost.
const VERIFIER_NUDGE_MIN_ITEMS = 3;

function readProvenance(runState) {
  if (!runState || typeof runState !== "object") return null;
  const threadId = readString(runState.threadId);
  const turnId = readString(runState.runId);
  if (!threadId && !turnId) return null;
  return { threadId: threadId || "default", turnId: turnId || null };
}

function ensureTodoState(runState, fallbackOptions) {
  const existing = runState && runState.todoState;
  if (existing && typeof existing === "object") return existing;
  return createTodoState(fallbackOptions || {});
}

// -------- todo_plan --------

const todoPlanAction = Object.freeze({
  description:
    "Create or replace the structured plan for the current task. "
    + "Use when a fresh breakdown is needed (initial planning OR replanning "
    + "after evidence shifts the goal). Replacing items drops the previous "
    + "activeItemId; supply `activeItemId` to set the next focus. "
    + "Pass `merge: true` to PRESERVE already-completed items (status `done` "
    + "or `abandoned`) and only replace the remaining work — useful when "
    + "evidence collected so far is still valid but the next steps must change. "
    + "REQUIRED on every call (especially replan): set `goal` to the user's "
    + "original request shown at the top of the system prompt. Never omit `goal` "
    + "and never substitute a generic 'recover task / resume work' template — "
    + "items must stay anchored to the real user request.",
  name: "todo_plan",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["plan", "make_plan", "todo_create"],
    argsExample: {
      goal: "...",
      items: [
        { id: "i-1", label: "step 1" },
        { id: "i-2", label: "step 2" }
      ],
      activeItemId: "i-1",
      note: "why this plan",
      merge: false
    },
    argsSchema: {
      activeItemId: { type: "string" },
      goal: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable item id." },
            label: { type: "string", description: "Concrete task step label." },
            status: { type: "string", description: "Item status, usually pending or active." }
          },
          required: ["label"]
        }
      },
      merge: { type: "boolean" },
      note: { type: "string" }
    },
    decisionType: "action",
    guidance:
      "Call todo_plan once at the start of a long task to break it into ordered "
      + "items, and again only when the plan itself must change (replan). For "
      + "marking individual items done/blocked, use todo_advance instead. "
      + "When replanning mid-task, prefer `merge: true` so completed work is "
      + "preserved as audit history; only use `merge: false` (default) when "
      + "the entire plan including completed items must be discarded. "
      + "REPLAN ANCHOR (anti-drift): every todo_plan call — including replans — "
      + "MUST re-pass `goal` extracted verbatim from the User request line at "
      + "the top of the system prompt. Items must be task-specific and reference "
      + "the real subject (e.g. 'Search Singapore AI safety regulation news'), "
      + "not generic recovery templates ('Recover paused task state', "
      + "'Re-establish connections', 'Execute next work unit'). If you find "
      + "yourself writing those generic phrases, stop and re-read the User request."
  },
  preflight: preflightTodoPlanAction,
  tier: 0,
  execute: executeTodoPlanAction,
  outputSchema: {
    kinds: ["todo_plan_result"],
    controls: ["continue"]
  }
});

function preflightTodoPlanAction(context, args) {
  if (!isNativeToolsPlanner(context)) {
    return;
  }
  const opts = args && typeof args === "object" ? args : {};
  const items = Array.isArray(opts.items) ? opts.items : [];
  const validItems = items.filter((item) => (
    item &&
    typeof item === "object" &&
    readString(item.label)
  ));
  if (validItems.length === 0) {
    throw new Error("todo_plan requires at least one item with a non-empty label in native_tools mode.");
  }
}

async function executeTodoPlanAction(context, args) {
  const runState = context && context.runState;
  if (!runState) {
    throw new Error("todo_plan: runState is required");
  }
  const opts = args && typeof args === "object" ? args : {};
  const provenance = readProvenance(runState);
  const rawItems = Array.isArray(opts.items) ? opts.items : [];
  const maxItems = readTodoMaxItems(context);
  const items = rawItems
    .slice(0, maxItems)
    .map((item) => ({
        ...(item && typeof item === "object" ? item : {}),
        _provenance: (item && item._provenance) || provenance
      }));
  if (rawItems.length > maxItems && typeof context.pushStep === "function") {
    context.pushStep("todo-plan-items-truncated", {
      requested: rawItems.length,
      kept: maxItems
    });
  }
  // Goal anchor (anti-drift backstop): if the planner omitted `goal` on a
  // replan call, do NOT silently let applyTodoPlan preserve a stale or empty
  // goal — fall back to the original user request from observationSummary.
  // This catches the live-e2e plan-drift bug where small planner LLMs
  // (gpt-5-mini, gemini-2.5-flash) replanned with generic "recover task"
  // items because they forgot to re-pass goal. Prompt-side guidance tells
  // them to re-pass; this is the runtime tier-2 backstop. Provenance is
  // recorded so the host can see when the backstop fired.
  const resolvedGoal = readGoalForPlan(opts, runState, context);
  const baseState = ensureTodoState(runState, { goal: resolvedGoal });
  const next = applyTodoPlan(baseState, {
    goal: resolvedGoal,
    items,
    activeItemId: opts.activeItemId,
    note: opts.note,
    status: opts.status,
    merge: opts.merge === true
  });
  runState.todoState = next;
  emitTodoStateMutation(context, "plan", next, {
    itemCount: next.items.length,
    merge: opts.merge === true
  });
  return {
    control: "continue",
    output: {
      kind: "todo_plan_result",
      todoState: serializeTodoState(next),
      itemCount: next.items.length
    },
    summary: `todo_plan(items=${next.items.length}, active=${next.activeItemId || "none"})`
  };
}

function isNativeToolsPlanner(context) {
  const effectiveMode =
    context &&
    context.runState &&
    context.runState.plannerModeSelection &&
    context.runState.plannerModeSelection.effectiveMode;
  if (effectiveMode === "native_tools") return true;
  if (effectiveMode === "envelope") return false;
  return Boolean(
    context &&
    context.runtimeConfig &&
    context.runtimeConfig.plannerMode === "native_tools"
  );
}

/**
 * Resolve the goal for a todo_plan call with anti-drift protection.
 *
 * Order of preference:
 *   1. Planner-supplied `args.goal` (trimmed, non-empty) — the planner did
 *      the right thing.
 *   2. The original user request from `runState.observationSummary.prompt`
 *      — backstop when the planner omitted goal (common on replan with
 *      small models). This stops the empty-goal → generic-template chain.
 *   3. Empty string — no signal anywhere; let `applyTodoPlan` preserve
 *      whatever the existing TodoState already has (the historical default).
 *
 * When the backstop fires (case 2), pushStep records `todo-plan-goal-anchored`
 * so the host can see in the activity stream that the runtime had to
 * re-anchor the goal because the planner forgot to.
 */
function readGoalForPlan(args, runState, context) {
  const explicit = readString(args && args.goal);
  if (explicit) return explicit;
  const prompt = readString(
    runState && runState.observationSummary && runState.observationSummary.prompt
  );
  if (prompt) {
    if (typeof context.pushStep === "function") {
      context.pushStep("todo-plan-goal-anchored", {
        reason: "planner omitted goal; backstop fell back to observationSummary.prompt",
        promptLength: prompt.length
      });
    }
    return prompt;
  }
  return "";
}

function readTodoMaxItems(context) {
  const value = context &&
    context.runtimeConfig &&
    context.runtimeConfig.todoAutopilot &&
    context.runtimeConfig.todoAutopilot.maxItems;
  return Number.isInteger(value) && value > 0 ? value : 10;
}

// -------- todo_advance --------

const todoAdvanceAction = Object.freeze({
  description:
    "Advance a single TodoItem: change its status (pending/active/done/blocked/abandoned) "
    + "and optionally attach a progress/block note. Promoting an item to `active` "
    + "automatically demotes the previously-active item to `pending`.",
  name: "todo_advance",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["todo_update", "todo_complete", "advance_todo"],
    argsExample: {
      itemId: "i-2",
      nextStatus: "done",
      note: "completed via web_search"
    },
    argsSchema: {
      itemId: { type: "string", required: true },
      nextStatus: { type: "string", required: true },
      note: { type: "string" },
      noteKind: { type: "string" }
    },
    decisionType: "action",
    guidance:
      "Use todo_advance to flip individual items as work progresses. "
      + "Allowed transitions are listed in the schema; advancing throws if "
      + "the move is not in the table (e.g. abandoned → done is rejected)."
  },
  tier: 0,
  execute: executeTodoAdvanceAction,
  outputSchema: {
    kinds: ["todo_advance_result"],
    controls: ["continue"]
  }
});

async function executeTodoAdvanceAction(context, args) {
  const runState = context && context.runState;
  if (!runState) {
    throw new Error("todo_advance: runState is required");
  }
  const opts = args && typeof args === "object" ? args : {};
  const itemId = readString(opts.itemId);
  if (!itemId) {
    throw new Error("todo_advance: itemId is required");
  }
  const nextStatus = readString(opts.nextStatus);
  if (!nextStatus) {
    throw new Error("todo_advance: nextStatus is required");
  }
  const current = runState.todoState;
  if (!current || typeof current !== "object") {
    throw new Error("todo_advance: no TodoState exists yet — call todo_plan first");
  }
  const provenance = readProvenance(runState);
  const previousItem = Array.isArray(current.items)
    ? current.items.find((item) => item && item.id === itemId)
    : null;
  const fromStatus = previousItem && typeof previousItem.status === "string" ? previousItem.status : null;
  const next = applyTodoAdvance(current, {
    itemId,
    nextStatus,
    note: opts.note,
    noteKind: opts.noteKind,
    _provenance: provenance
  });
  runState.todoState = next;
  emitTodoStateMutation(context, "advance", next, {
    itemId,
    fromStatus,
    toStatus: nextStatus
  });
  return {
    control: "continue",
    output: {
      kind: "todo_advance_result",
      todoState: serializeTodoState(next),
      itemId,
      nextStatus
    },
    summary: `todo_advance(${itemId}, ${nextStatus})`
  };
}

// -------- todo_cancel --------

const todoCancelAction = Object.freeze({
  description:
    "Explicitly abandon the current TodoState. Use only when the user cancels "
    + "the task, the host requests abandonment, or the task must stop because "
    + "continuing would be unsafe or impossible. Unfinished items become "
    + "`abandoned`; completed items stay `done`.",
  name: "todo_cancel",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["todo_abandon", "cancel_task", "abandon_task"],
    argsExample: {
      reason: "user cancelled the long-running task"
    },
    argsSchema: {
      note: { type: "string" },
      reason: { type: "string" }
    },
    decisionType: "action",
    guidance:
      "Use todo_cancel only for explicit cancellation/abandonment. Do not call "
      + "it to finish normal work; completed work should use todo_advance or "
      + "todo_run_next."
  },
  tier: 0,
  execute: executeTodoCancelAction,
  outputSchema: {
    kinds: ["todo_cancel_result"],
    controls: ["continue"]
  }
});

async function executeTodoCancelAction(context, args) {
  const runState = context && context.runState;
  if (!runState) {
    throw new Error("todo_cancel: runState is required");
  }
  const current = runState.todoState;
  if (!current || typeof current !== "object" || !Array.isArray(current.items)) {
    throw new Error("todo_cancel: no TodoState exists yet — call todo_plan first");
  }
  const opts = args && typeof args === "object" ? args : {};
  const cancellableBefore = countCancellableTodoItems(current);
  const provenance = readProvenance(runState);
  const next = applyTodoCancel(current, {
    reason: opts.reason,
    note: opts.note,
    _provenance: provenance
  });
  runState.todoState = next;
  emitTodoStateMutation(context, "cancel", next, {
    cancelledItemCount: next === current ? 0 : cancellableBefore,
    reason: readString(opts.reason || opts.note) || null
  });
  return {
    control: "continue",
    output: {
      cancelledItemCount: next === current ? 0 : cancellableBefore,
      kind: "todo_cancel_result",
      reason: readString(opts.reason || opts.note) || null,
      todoState: serializeTodoState(next)
    },
    summary: `todo_cancel(items=${next === current ? 0 : cancellableBefore}, status=${next.status})`
  };
}

// -------- todo_run_next --------

const todoRunNextAction = Object.freeze({
  description:
    "Advance the active TodoState item as one completed work unit and promote the next pending item. "
    + "Use only after the active work unit has actually been completed.",
  name: "todo_run_next",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["todo_continue", "todo_next", "run_next_todo"],
    argsExample: {
      note: "completed this work unit"
    },
    argsSchema: {
      note: { type: "string" }
    },
    decisionType: "action",
    guidance:
      "Use todo_run_next only after the active TodoState work unit has genuinely completed. "
      + "It marks the current active item done and promotes the next pending item; "
      + "when no pending item remains it completes the plan. Do not use it merely because the runtime asks you to continue."
  },
  tier: 0,
  execute: executeTodoRunNextAction,
  outputSchema: {
    kinds: ["todo_run_next_result"],
    controls: ["continue"]
  }
});

async function executeTodoRunNextAction(context, args) {
  const runState = context && context.runState;
  return applyTodoRunNextToRunState(runState, args, context);
}

function applyTodoRunNextToRunState(runState, args, context) {
  if (!runState) {
    throw new Error("todo_run_next: runState is required");
  }
  const current = runState.todoState;
  if (!current || typeof current !== "object" || !Array.isArray(current.items)) {
    throw new Error("todo_run_next: no TodoState exists yet — call todo_plan first");
  }

  const opts = args && typeof args === "object" ? args : {};
  const provenance = readProvenance(runState);
  const activeItem = findActiveTodoItem(current);

  if (current.status === "completed" || current.status === "abandoned") {
    runState.todoState = current;
    emitTodoStateMutation(context, "run_next", current, { variant: "terminal_noop" });
    // No verifier nudge here — the plan was already terminal before this
    // call; the nudge fires only on the transition to completed, not on
    // every subsequent no-op call.
    return createTodoRunNextResult(current, null, null, current.status, null);
  }

  if (!activeItem) {
    const firstPending = findFirstPendingItem(current);
    if (!firstPending) {
      const completed = completeTodoStateIfFinished(current);
      runState.todoState = completed;
      emitTodoStateMutation(context, "run_next", completed, { variant: "completed" });
      const verifierNudge = detectVerifierNudge(context, completed);
      return createTodoRunNextResult(completed, null, null, "completed", verifierNudge);
    }
    const promoted = applyTodoAdvance(current, {
      itemId: firstPending.id,
      nextStatus: "active",
      note: opts.note,
      _provenance: provenance
    });
    runState.todoState = promoted;
    emitTodoStateMutation(context, "run_next", promoted, {
      variant: "promoted",
      promotedItemId: firstPending.id
    });
    return createTodoRunNextResult(promoted, null, firstPending.id, "promoted", null);
  }

  const afterDone = applyTodoAdvance(current, {
    itemId: activeItem.id,
    nextStatus: "done",
    note: opts.note || `Completed: ${activeItem.label}`,
    _provenance: provenance
  });
  const nextPending = findFirstPendingItem(afterDone);
  const next = nextPending
    ? applyTodoAdvance(afterDone, {
        itemId: nextPending.id,
        nextStatus: "active",
        _provenance: provenance
      })
    : completeTodoStateIfFinished(afterDone);

  runState.todoState = next;
  emitTodoStateMutation(context, "run_next", next, {
    variant: nextPending ? "advanced" : "completed",
    completedItemId: activeItem.id,
    promotedItemId: nextPending ? nextPending.id : null
  });
  const verifierNudge = nextPending ? null : detectVerifierNudge(context, next);
  return createTodoRunNextResult(
    next,
    activeItem.id,
    nextPending ? nextPending.id : null,
    nextPending ? "advanced" : "completed",
    verifierNudge
  );
}

// -------- todo_inspect --------

// 2026-04-27: description and guidance softened to stop planner LLMs
// from interpreting them as "always inspect first". The ±2 window in
// the per-cycle ACTIVE TODO PLAN block is the default information path;
// `todo_inspect` is the rare-and-explicit escape hatch for cross-cutting
// decisions, and inspecting more than once per task is almost always
// a planner-loop bug rather than a real need. Live e2e on gpt-5-mini /
// gemini-2.5-flash showed 8-15 consecutive todo_inspect calls when the
// older description framed it as routinely useful.
const todoInspectAction = Object.freeze({
  description:
    "Return the full structured TodoState for the active thread. Read-only — "
    + "does not mutate state or bump version. Rarely needed: the per-cycle "
    + "ACTIVE TODO PLAN block already shows the active item ±2 plus omitted "
    + "counts, which is sufficient for almost all decisions. Only call this "
    + "when a cross-cutting question genuinely requires the full item list.",
  name: "todo_inspect",
  planner: {
    aliases: ["todo_get_current", "show_plan"],
    argsExample: {},
    argsSchema: {},
    decisionType: "action",
    guidance:
      "Do not call todo_inspect for routine progress — the prompt-side "
      + "summary already shows the active item ±2 with omitted counts. "
      + "Calling todo_inspect more than once per task is almost always a "
      + "loop, because the result does not change the next cycle's prompt. "
      + "If you have already called todo_inspect this task, do NOT call it "
      + "again — choose todo_run_next or the appropriate work action instead."
  },
  tier: 0,
  execute: executeTodoInspectAction,
  outputSchema: {
    kinds: ["todo_inspect_result"],
    controls: ["continue"]
  }
});

async function executeTodoInspectAction(context, _args) {
  const runState = context && context.runState;
  if (!runState) {
    throw new Error("todo_inspect: runState is required");
  }
  const snapshot = serializeTodoState(runState.todoState || null);
  return {
    control: "continue",
    output: {
      kind: "todo_inspect_result",
      todoState: snapshot,
      itemCount: snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
    },
    summary: snapshot
      ? `todo_inspect(${snapshot.items.length} items)`
      : "todo_inspect(no plan)"
  };
}


function completeTodoStateIfFinished(todoState) {
  // Idempotent: terminal plans return the same reference. This keeps
  // todo_run_next a no-op when called on a finished/cancelled plan
  // (so a planner that calls one extra time does not bump version,
  // rewrite abandoned history, or trigger spurious CAS conflicts).
  if (todoState.status === "completed" || todoState.status === "abandoned") return todoState;
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  const hasUnfinished = items.some((item) => item && (item.status === "active" || item.status === "pending"));
  if (hasUnfinished) return todoState;
  return {
    ...todoState,
    activeItemId: null,
    status: "completed",
    updatedAt: Date.now(),
    version: (typeof todoState.version === "number" ? todoState.version : 0) + 1
  };
}

function createTodoRunNextResult(todoState, completedItemId, nextActiveItemId, action, verifierNudge) {
  const output = {
    action,
    completedItemId,
    kind: "todo_run_next_result",
    nextActiveItemId,
    todoState: serializeTodoState(todoState)
  };
  if (verifierNudge) output.verifierNudge = verifierNudge;
  const summarySuffix = verifierNudge ? " +verifier-nudge" : "";
  return {
    control: "continue",
    output,
    summary: `todo_run_next(action=${action}, completed=${completedItemId || "none"}, active=${nextActiveItemId || todoState.activeItemId || "none"})${summarySuffix}`
  };
}

/**
 * Structural verifier reminder for todo_run_next completion.
 *
 * Fires only at the transition-to-completed moment: when a 3+ item plan
 * just finished and no item label/note matches the verification pattern.
 * Returns the rendered nudge string (to be attached to the action result)
 * or null when the nudge does not apply.
 *
 * Why this lives here (not in todo-autopilot.js):
 *   The autopilot vetoes are pre-action — they redirect the planner
 *   BEFORE it commits a wrong action. The verifier nudge is post-action
 *   structural evidence — it rides on the result of an action the planner
 *   already chose correctly (todo_run_next). Different lifecycle stage,
 *   different module, same SSOT (regex + string).
 *
 * Mirrors claude-code TodoWriteTool.ts:76-86 verificationNudgeNeeded —
 * adapted to agrun's 5-action surface (we fire from todo_run_next instead
 * of from "the entire list was rewritten with everything completed").
 */
function detectVerifierNudge(context, todoState) {
  const items = todoState && Array.isArray(todoState.items) ? todoState.items : [];
  if (items.length < VERIFIER_NUDGE_MIN_ITEMS) return null;

  const cfg = context && context.runtimeConfig && context.runtimeConfig.todoAutopilot;
  const pattern = normalizeVerificationPattern(
    cfg && cfg.verificationPattern,
    DEFAULT_VERIFICATION_PATTERN
  );
  if (!pattern) return null;

  const nudgeFn = normalizeTodoPromptStrings(cfg && cfg.promptStrings).autopilot.verifierNudge;
  if (typeof nudgeFn !== "function") return null;

  const hasVerificationItem = items.some((item) => {
    if (!item) return false;
    const label = readString(item.label);
    if (label && pattern.test(label)) return true;
    const notes = Array.isArray(item.notes) ? item.notes : [];
    return notes.some((note) => note && pattern.test(readString(note.text)));
  });
  if (hasVerificationItem) return null;

  if (context && typeof context.pushStep === "function") {
    context.pushStep("todo-plan-verifier-nudge", {
      itemCount: items.length,
      reason: "plan completed without any verify/test/check item"
    });
  }
  return readString(nudgeFn({ itemCount: items.length })) || null;
}

function countCancellableTodoItems(todoState) {
  const items = todoState && Array.isArray(todoState.items) ? todoState.items : [];
  return items.filter((item) => (
    item
    && item.status !== "done"
    && item.status !== "abandoned"
  )).length;
}

function emitTodoStateMutation(context, action, todoState, extras) {
  if (!context || typeof context.pushStep !== "function" || !todoState) return;
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  const detail = {
    action,
    activeItemId: todoState.activeItemId || null,
    itemCount: items.length,
    status: todoState.status || null,
    version: typeof todoState.version === "number" ? todoState.version : null
  };
  if (extras && typeof extras === "object") Object.assign(detail, extras);
  context.pushStep("todo-state-mutated", detail);
  resetTodoAutopilotVetoOnProgress(context.runState, `todo-${action}`);
}

export { applyTodoRunNextToRunState, executeTodoAdvanceAction, executeTodoCancelAction, executeTodoInspectAction, executeTodoPlanAction, executeTodoRunNextAction, preflightTodoPlanAction, todoAdvanceAction, todoCancelAction, todoInspectAction, todoPlanAction, todoRunNextAction };
