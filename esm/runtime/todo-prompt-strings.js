/**
 * SSOT for every LLM-facing string the TodoState subsystem injects into
 * planner prompts or autopilot vetoes.
 *
 * Why this exists (2026-04-27):
 *   The TodoState mechanism layer (state machine, queries, persistence)
 *   is correct and stable. The "policy" layer — the *wording* of veto
 *   observations and the prompt block — is a moving target: every new
 *   planner model (gpt-5-mini, gemini-2.5-flash, claude-sonnet) reacts
 *   differently to the same English. The inspect-loop bug was a policy
 *   regression, not a mechanism regression. Hard-coding policy strings
 *   inside `todo-autopilot.js` and `todo-state-prompt.js` made each
 *   tuning round a code change instead of a config change, which is
 *   classic patch-thinking.
 *
 *   This module exports the full default string catalog and a deep-merge
 *   normalizer. Hosts inject overrides via
 *   `runtimeConfig.todoAutopilot.promptStrings` and the runtime reads
 *   from the normalized config at call time. Defaults preserve existing
 *   behavior verbatim, so this is purely additive — no caller is forced
 *   to change.
 *
 * Layering:
 *   - `prompt.*` strings appear in the per-cycle ACTIVE TODO PLAN block.
 *   - `autopilot.*` strings appear in pre-action veto observations.
 *   - Functions take named-parameter objects so future fields are
 *     additive, not positional.
 */

function readString$11(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readFunction(value) {
  return typeof value === "function" ? value : null;
}

const DEFAULT_TODO_PROMPT_STRINGS = Object.freeze({
  prompt: Object.freeze({
    blockHeader: "ACTIVE TODO PLAN",
    // 2026-04-27: footer no longer advertises todo_inspect — see
    // BLOCK_FOOTER history note in todo-state-prompt.js.
    blockFooter:
      "End of plan. Do the actual work for the active item first "
      + "(for example search/read/analyze/draft in workspace when needed), then use "
      + "todo_advance or todo_run_next only after that work unit is "
      + "genuinely complete. Use todo_plan to replan when the plan "
      + "itself must change. If you choose finalize while this plan still "
      + "has active or pending items, that is your decision; first either "
      + "advance/abandon the todo items you consider complete or explain "
      + "in your finalize reasoning why the visible plan is obsolete.",
    planningPlaceholder:
      "Planning placeholder: this is not a real task breakdown. Your "
      + "next decision MUST be todo_plan with task-specific ordered "
      + "items generated from the user's request. Do not search, read, "
      + "synthesize, or finalize until this placeholder is replaced.",
    goalLine: ({ goal }) => `Goal: ${goal}`,
    planStatusLine: ({ status, totalItems }) =>
      `Plan status: ${status}; ${totalItems} item(s) total.`,
    omittedBefore: ({ count }) => `...(${count} earlier item(s) omitted)...`,
    omittedAfter: ({ count }) => `...(${count} later item(s) omitted)...`
  }),
  autopilot: Object.freeze({
    needsPlanBeforeFinalize:
      "TodoState autopilot: do not finalize a long-running or "
      + "multi-step request before a durable TodoState exists. Call "
      + "todo_plan first with the ordered work items, set the first "
      + "item active, then continue through todo_run_next.",
    proseOnlyChecklist:
      "TodoState autopilot: do not finalize with a prose-only "
      + "checklist. The answer contains visible progress structure, "
      + "but no durable TodoState exists. Call todo_plan first with "
      + "the ordered items, set the first work item active, then continue.",
    placeholderNotReplaced:
      "TodoState autopilot: the current TodoState is only a runtime "
      + "planning placeholder. Do not finalize or continue work yet. "
      + "Call todo_plan with a task-specific ordered todo list "
      + "generated from the user's request.",
    finalSynthesisItem: ({ activeLabel }) =>
      `TodoState autopilot: the final TodoState item "${activeLabel}" `
      + "is the synthesis/finalization step. Mark it complete with "
      + "todo_run_next, then finalize the answer.",
    unfinishedItems: ({ remainingCount, activeLabel }) =>
      `TodoState autopilot: do not finalize yet. There are ${remainingCount} `
      + `unfinished todo item(s). Continue the actual work for "${activeLabel}" `
      + "first, then call todo_advance or todo_run_next only after "
      + "that work unit is genuinely completed. Finalize only when the "
      + "TodoState is completed, blocked, abandoned, or the user asked to stop.",
    inspectLoop: ({ consecutive, remediation }) =>
      `TodoState autopilot: you have already called todo_inspect ${consecutive} `
      + "time(s) in a row. Calling it again will not change your prompt "
      + "context — todo_inspect's result is not re-injected into the "
      + "next cycle. " + remediation,
    inspectLoopRemediationWithPlan:
      "Choose todo_run_next to advance the plan, todo_advance to flip "
      + "a specific item, or call the appropriate work action "
      + "(web_search / read_url / finalize). The active item ±2 in "
      + "ACTIVE TODO PLAN already shows what you need.",
    inspectLoopRemediationNoPlan:
      "Call todo_plan to create a task-specific ordered plan. The "
      + "active item ±2 in ACTIVE TODO PLAN already shows what you need.",
    todoPlanRequired:
      "TodoState guard: this is a complex or long-running task and no "
      + "structured TodoState exists yet. Call todo_plan first with "
      + "task-specific ordered items generated from the user's "
      + "request. Do not search, read, synthesize, or finalize until "
      + "the TodoState plan exists.",
    // 2026-04-27: structural verifier reminder. Fires from todo_run_next
    // when a 3+ item plan transitions to `completed` status and no item
    // label/note matches the verification pattern. Mirrors claude-code's
    // TodoWriteTool verificationNudgeNeeded pattern. Threshold 3 matches
    // claude-code — for trivial 1-2 step plans, the verification overhead
    // is not worth the loop cost.
    verifierNudge: ({ itemCount }) =>
      `TodoState autopilot: you just completed a ${itemCount}-item plan and `
      + "no item mentions verification (verify / test / check / validate / qa). "
      + "Before finalizing the answer, actually run any tests, smoke checks, "
      + "or e2e verification the task implies. You cannot self-assign success "
      + "by listing caveats in the summary — only the result of a real check "
      + "issues the verdict.",
    // 2026-04-28: evidence-exhausted redirect. Fires when the planner
    // picks finalize but TodoState still has unfinished items AND the
    // exhaustion signal is set. ADR-0028 — pre-deletion this read
    // `autoReadStoppedReason`; post-deletion it reads `readAttemptSignal`
    // (attemptCount >= threshold infers exhaustion). The veto redirects
    // to `todo_run_next` with an "evidence-constrained" note so the plan
    // advances item-by-item toward completion, instead of locking in an
    // infinite finalize-veto loop. Replaces the pure-block path that
    // caused the AGRUN-212a 2L production bug (75 wasted cycles,
    // max_steps_continuation forced exit).
    evidenceExhausted: ({ activeLabel, reason }) =>
      `TodoState autopilot: cannot finalize while "${activeLabel}" is still active, `
      + `but evidence-gathering is exhausted (reason: ${reason}). `
      + "Advancing this item with todo_run_next using the snippet-only evidence "
      + "available, so the plan can complete and finalize can proceed. The "
      + "final answer should mark public-evidence limits explicitly rather than "
      + "fabricate detail beyond what snippets confirm."
  })
});

/**
 * Deep-merge a host override on top of DEFAULT_TODO_PROMPT_STRINGS.
 *
 * Rules:
 *   - Override may supply any subset; missing keys keep defaults.
 *   - Strings: override must be a non-empty string (trimmed). Empty /
 *     non-string values fall back to default.
 *   - Functions: override must be a function. Non-function values fall
 *     back to default. (We don't allow strings to override functions —
 *     callers depend on the function shape for parameter substitution.)
 *   - Unknown keys are dropped (we don't mirror garbage into runtime).
 */
function normalizeTodoPromptStrings(override) {
  return Object.freeze({
    prompt: mergeSection(DEFAULT_TODO_PROMPT_STRINGS.prompt, override && override.prompt),
    autopilot: mergeSection(DEFAULT_TODO_PROMPT_STRINGS.autopilot, override && override.autopilot)
  });
}

function mergeSection(defaults, override) {
  if (!override || typeof override !== "object") return defaults;
  const merged = {};
  for (const key of Object.keys(defaults)) {
    const defaultValue = defaults[key];
    const overrideValue = override[key];
    if (typeof defaultValue === "function") {
      const fn = readFunction(overrideValue);
      merged[key] = fn || defaultValue;
    } else {
      const str = readString$11(overrideValue);
      merged[key] = str || defaultValue;
    }
  }
  return Object.freeze(merged);
}

export { DEFAULT_TODO_PROMPT_STRINGS, normalizeTodoPromptStrings };
