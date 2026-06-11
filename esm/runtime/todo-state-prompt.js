import { summarizeTodoStateForPrompt } from './todo-state.js';
import { isTodoPlanningPlaceholder } from './todo-planning-placeholder.js';
import { normalizeTodoPromptStrings, DEFAULT_TODO_PROMPT_STRINGS } from './todo-prompt-strings.js';

/**
 * AGRUN-212a Phase E — Build the planner-system-prompt block that
 * surfaces the active TodoState for the cycle.
 *
 * Why this is its own module:
 *   - Keeps `summarizeTodoStateForPrompt` close to its sole consumer
 *     (the planner) without coupling to action-loop-planner.js.
 *   - Pure function over runState → string. Trivially unit-testable
 *     and free of the virtual:* dep graph the rest of the planner
 *     pulls in.
 *
 * Token-budget contract (locked by ADR-0010):
 *   - Always inject only the active item plus ±2 surrounding items.
 *   - Mention `omittedBefore` / `omittedAfter` counts so the planner
 *     can see "more, but truncated" without rendering them.
 *   - Full dumps are reachable via the `todo_inspect` action when
 *     the planner explicitly asks for them.
 *   - Empty string (NOT a placeholder) when there is no plan yet —
 *     callers concatenate without checking, and the prompt stays
 *     short for the common "no plan needed" turn.
 */


// 2026-04-27: header / footer / placeholder copy moved into
// todo-prompt-strings.js so hosts can override per-model without
// touching this file. Defaults preserve historical wording verbatim
// (the footer no longer advertises todo_inspect — see DEFAULT_TODO_PROMPT_STRINGS
// for the reason note).
const WINDOW = 2;

function statusGlyph(status, isActive) {
  if (isActive) return "▶";
  if (status === "done") return "✓";
  if (status === "blocked") return "⨯";
  if (status === "abandoned") return "·";
  return "○";
}

function readString$q(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the planner-prompt block for the current cycle's TodoState.
 *
 * Inputs:
 *   runState — must carry `todoState` (set by hydration in
 *     run-state-thread.js) or be a no-op.
 *
 * Returns: trimmed string. Empty string when:
 *   - runState is null/missing
 *   - runState.todoState is null
 *   - runState.todoState has no items
 */
function buildTodoStateBlockForCycle(runState, options) {
  const summary = summarizeTodoStateForPrompt(
    runState && runState.todoState ? runState.todoState : null,
    { window: WINDOW }
  );
  if (!summary) return "";

  // Resolve prompt strings: callers (planner) thread through the
  // normalized autopilot config; tests and direct callers can omit and
  // get the defaults. Either way we re-normalize so partial overrides
  // (e.g. only `blockFooter`) still pick up default functions.
  const strings = resolvePromptStrings(options);

  const lines = [strings.blockHeader];
  const isPlanningPlaceholder = isTodoPlanningPlaceholder(runState && runState.todoState);
  if (summary.goal) {
    lines.push(strings.goalLine({
      goal: compactDuplicateGoal(summary.goal, options && options.requestPrompt)
    }));
  }
  if (isPlanningPlaceholder) {
    lines.push(strings.planningPlaceholder);
  }
  lines.push(strings.planStatusLine({ status: summary.status, totalItems: summary.totalItems }));
  if (summary.omittedBefore > 0) {
    lines.push(strings.omittedBefore({ count: summary.omittedBefore }));
  }
  for (const item of summary.visible) {
    const glyph = statusGlyph(item.status, item.isActive);
    const noteFragment = item.lastNote ? ` — note: ${item.lastNote}` : "";
    const activeMarker = item.isActive ? " [ACTIVE]" : "";
    lines.push(`  ${glyph} ${item.id}: ${item.label} (${item.status})${activeMarker}${noteFragment}`);
  }
  if (summary.omittedAfter > 0) {
    lines.push(strings.omittedAfter({ count: summary.omittedAfter }));
  }
  lines.push(strings.blockFooter);
  return lines.join("\n");
}

function compactDuplicateGoal(goal, requestPrompt) {
  const value = readString$q(goal);
  const requestKey = normalizePromptDuplicateKey(requestPrompt);
  if (!value || !requestKey) return value;
  return normalizePromptDuplicateKey(value) === requestKey
    ? "same as current user request"
    : value;
}

function normalizePromptDuplicateKey(value) {
  return readString$q(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function resolvePromptStrings(options) {
  // Already-normalized full catalog (planner threads this through).
  if (options && options.promptStringsNormalized && options.promptStringsNormalized.prompt) {
    return options.promptStringsNormalized.prompt;
  }
  // Raw override — normalize once.
  if (options && options.promptStrings) {
    return normalizeTodoPromptStrings({ prompt: options.promptStrings }).prompt;
  }
  return DEFAULT_TODO_PROMPT_STRINGS.prompt;
}

export { buildTodoStateBlockForCycle };
