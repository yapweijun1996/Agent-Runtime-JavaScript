import { normalizeActionProgressRules, normalizeFinalizationPattern, DEFAULT_ACTION_PROGRESS_RULES, DEFAULT_FINALIZATION_PATTERN } from './todo-autopilot-rules.js';
import { isTodoShapedRun, readString } from './todo-detection.js';
import { normalizeTodoPromptStrings, DEFAULT_TODO_PROMPT_STRINGS } from './todo-prompt-strings.js';
import { GUARD_MAX_VETOES } from './guard-defaults.js';

const DEFAULT_MAX_ITEMS = 10;
// Live e2e on gpt-5-mini and gemini-2.5-flash showed planner LLMs
// repeating todo_inspect 8-15 times in a row — its result does not
// change the next prompt cycle, so once the planner picks it once,
// it has no signal to stop. Default cap of 1 means "allow one
// inspect per task; veto every subsequent inspect with a redirect
// observation". Hosts can raise via runtimeConfig if their planner
// genuinely needs repeated inspects.
const DEFAULT_MAX_CONSECUTIVE_INSPECTS = 1;

function disabledConfig() {
  return {
    enabled: false,
    autostart: false,
    maxItems: DEFAULT_MAX_ITEMS,
    maxVetoes: GUARD_MAX_VETOES,
    maxRequiredCompletionVetoes: GUARD_MAX_VETOES,
    maxConsecutiveInspects: DEFAULT_MAX_CONSECUTIVE_INSPECTS,
    finalizationPattern: DEFAULT_FINALIZATION_PATTERN,
    actionProgressRules: DEFAULT_ACTION_PROGRESS_RULES,
    promptStrings: DEFAULT_TODO_PROMPT_STRINGS
  };
}

function normalizeTodoAutopilotConfig(value) {
  if (value == null || value === false) {
    return disabledConfig();
  }
  if (value === true) {
    // Legacy shorthand: enable autopilot vetoes but NOT the autostart
    // placeholder injection. The placeholder was patch-thinking: it filled
    // a runtime-shaped void with generic items, which conflicts with
    // the harness contract that the planner should call `todo_plan`
    // with task-specific items derived from the user prompt.
    return { ...disabledConfig(), enabled: true };
  }
  if (!value || typeof value !== "object") {
    return disabledConfig();
  }
  return {
    enabled: value.enabled === true,
    // Opt-in only. `autostart: true` re-enables the placeholder
    // injection for hosts that want a stability backstop while
    // their planner prompt is still maturing. New code should rely
    // on the planner calling `todo_plan` directly instead.
    autostart: value.autostart === true,
    maxItems: Number.isInteger(value.maxItems) && value.maxItems > 0
      ? value.maxItems
      : DEFAULT_MAX_ITEMS,
    maxVetoes: Number.isInteger(value.maxVetoes) && value.maxVetoes > 0
      ? value.maxVetoes
      : GUARD_MAX_VETOES,
    maxRequiredCompletionVetoes: Number.isInteger(value.maxRequiredCompletionVetoes) && value.maxRequiredCompletionVetoes > 0
      ? value.maxRequiredCompletionVetoes
      : GUARD_MAX_VETOES,
    maxConsecutiveInspects: Number.isInteger(value.maxConsecutiveInspects) && value.maxConsecutiveInspects > 0
      ? value.maxConsecutiveInspects
      : DEFAULT_MAX_CONSECUTIVE_INSPECTS,
    finalizationPattern: normalizeFinalizationPattern(value.finalizationPattern, DEFAULT_FINALIZATION_PATTERN),
    actionProgressRules: normalizeActionProgressRules(value.actionProgressRules, DEFAULT_ACTION_PROGRESS_RULES),
    promptStrings: normalizeTodoPromptStrings(value.promptStrings)
  };
}

/**
 * Veto consecutive `todo_inspect` calls that don't change state.
 *
 * Why this exists: live e2e on gpt-5-mini and gemini-2.5-flash showed
 * planner LLMs picking todo_inspect 8-15 times in a row after todo_plan,
 * because (a) the per-cycle planner prompt repeated invitations to use
 * todo_inspect, and (b) todo_inspect's output never re-enters the next
 * cycle's prompt — so the planner thinks it still hasn't seen the full
 * plan. The prompt-side fix removed the invitations; this veto is the
 * runtime backstop for when the planner ignores prompt instructions.
 *
 * Trigger:
 *   - Action about to run is `todo_inspect`
 *   - The tail of `actionHistory` already contains
 *     `maxConsecutiveInspects` consecutive `todo_inspect` entries
 *
 * Returns a redirect veto telling the planner not to inspect again
 * and listing the actions it should choose from instead. Returns null
 * when the inspect is the first (or below cap), or when autopilot is
 * disabled, or when the action isn't todo_inspect.
 */
function maybeCreateTodoInspectLoopGuard(runState, config, context) {
  const normalized = normalizeTodoAutopilotConfig(config);
  if (!normalized.enabled) return null;
  const actionName = readString(context && context.actionName);
  if (actionName !== "todo_inspect") return null;

  const history = Array.isArray(context && context.actionHistory) ? context.actionHistory : [];
  const consecutive = countTrailingInspects(history);
  if (consecutive < normalized.maxConsecutiveInspects) return null;

  const todoState = runState && runState.todoState;
  const hasPlan = todoState && Array.isArray(todoState.items) && todoState.items.length > 0;
  const strings = normalized.promptStrings.autopilot;
  const remediation = hasPlan
    ? strings.inspectLoopRemediationWithPlan
    : strings.inspectLoopRemediationNoPlan;
  return {
    actionName,
    consecutiveInspects: consecutive,
    observation: strings.inspectLoop({ consecutive, remediation })
  };
}

function countTrailingInspects(history) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || typeof entry !== "object") break;
    // Only count actual inspects. Errors / hints / non-action entries
    // also break the streak — once anything else lands in history,
    // the planner is making forward progress.
    if (entry.actionName === "todo_inspect" && entry.kind === "action") {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function resetTodoAutopilotVetoOnProgress(runState, source) {
  if (!runState || typeof runState !== "object") return;
  const state = runState.todoAutopilot && typeof runState.todoAutopilot === "object"
    ? runState.todoAutopilot
    : null;
  if (!state) return;
  const previousVetoCount = Number.isInteger(state.vetoCount) ? state.vetoCount : 0;
  const previousRequiredCompletionVetoCount = Number.isInteger(state.requiredCompletionVetoCount) ? state.requiredCompletionVetoCount : 0;
  if (previousVetoCount === 0 && previousRequiredCompletionVetoCount === 0) return;
  runState.todoAutopilot = {
    ...state,
    lastProgressSource: typeof source === "string" && source ? source : (state.lastProgressSource || null),
    requiredCompletionVetoCount: 0,
    vetoCount: 0
  };
}

function maybeCreateTodoPlanRequiredGuard(runState, config, context) {
  const normalized = normalizeTodoAutopilotConfig(config);
  if (!normalized.enabled) return null;
  if (!isTodoShapedRun(runState)) return null;

  const todoState = runState && runState.todoState;
  if (todoState && typeof todoState === "object" && Array.isArray(todoState.items) && todoState.items.length > 0) {
    return null;
  }

  const actionName = readString(context && context.actionName);
  if (isTodoPlanningAction(actionName)) return null;

  return {
    actionName: actionName || null,
    observation: normalized.promptStrings.autopilot.todoPlanRequired
  };
}

function isTodoPlanningAction(actionName) {
  return actionName === "todo_plan" ||
    actionName === "todo_inspect" ||
    actionName === "ask_clarification";
}

export { maybeCreateTodoInspectLoopGuard, maybeCreateTodoPlanRequiredGuard, normalizeTodoAutopilotConfig, resetTodoAutopilotVetoOnProgress };
