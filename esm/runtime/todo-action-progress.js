import { normalizeTodoAutopilotConfig } from './todo-autopilot.js';
import { FINALIZE_CANDIDATE_ACTION } from './kernel-terminal-actions.js';
import { readString } from './todo-detection.js';
import { findActiveTodoItem } from './todo-queries.js';

function maybeCreateTodoActionProgressDecision(runState, config, context) {
  const normalized = normalizeTodoAutopilotConfig(config);
  if (!normalized.enabled) return null;

  const actionName = readString(context && context.actionName);
  const rules = normalized.actionProgressRules || {};
  const rule = rules[actionName];
  if (!rule) return null;

  const todoState = runState && runState.todoState;
  if (!todoState || todoState.status !== "active" || !Array.isArray(todoState.items)) return null;

  // Don't celebrate failed reads as progress. When read_url returns
  // ok=false (HTTP error, blocked content, scraper failure), the active
  // item must NOT be auto-advanced — otherwise the planner thinks
  // evidence was gathered when nothing usable came back, and the next
  // step starts from a false premise. This is observation-driven from
  // a 2026-04-27 live e2e where Gemini 2.5 Flash got stuck in a
  // todo_inspect loop after a failed read; auto-advancing on failure
  // would have made the loop worse by promoting the work item without
  // real progress.
  if (actionName === "read_url") {
    const lastReadSource = runState
      && runState.contextSnapshot
      && runState.contextSnapshot.inquiryContext
      && runState.contextSnapshot.inquiryContext.lastReadSource;
    if (lastReadSource && lastReadSource.ok === false) return null;
  }

  const activeItem = findActiveTodoItem(todoState);
  if (!activeItem) return null;

  const label = readString(activeItem.label);
  if (!label) return null;
  if (actionName === FINALIZE_CANDIDATE_ACTION) {
    if (!(normalized.finalizationPattern instanceof RegExp)) return null;
    if (!normalized.finalizationPattern.test(label)) return null;
  }
  // block guard fires first: if the active todo label matches the
  // finalize-stage pattern (English + CJK keywords by default; hosts
  // can extend via runtimeConfig.todoAutopilot.actionProgressRules),
  // do NOT auto-advance — AI is mid-write and a tool call here is
  // verifying a fact, not finishing the item.
  if (actionName !== FINALIZE_CANDIDATE_ACTION && rule.block instanceof RegExp && rule.block.test(label)) return null;
  // allow is OPTIONAL (2026-05-10 i18n fix): when host explicitly sets
  // an allow regex, the active todo label must match it; when allow is
  // null/undefined (the new default for read_url + web_search), any
  // unblocked active todo is eligible. This makes the autopilot
  // language-agnostic by default while still honoring host overrides.
  if (rule.allow instanceof RegExp && !rule.allow.test(label)) return null;

  const key = `${actionName}:${activeItem.id || label}`;
  const state = runState.todoAutopilot && typeof runState.todoAutopilot === "object"
    ? runState.todoAutopilot
    : {};
  if (state.lastActionProgressKey === key) return null;

  runState.todoAutopilot = {
    ...state,
    lastActionProgressKey: key
  };

  return {
    type: "action",
    name: "todo_run_next",
    args: {
      note: `Action completed (${actionName}): ${label}`
    }
  };
}

export { maybeCreateTodoActionProgressDecision };
