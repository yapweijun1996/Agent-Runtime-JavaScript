import { normalizeConvergenceConfig } from '../action-pattern-convergence.js';
import { computeDirectiveGates } from './planner-directive-gates.js';

// ADR-0035 (AGRUN-262) — base-mode planner system directives.
// Extracted verbatim from planner-prompt.js `BASE_SYSTEM_LINES`. Default
// content is byte-identical to the pre-refactor build (locked by
// test/unit/prompt-snapshot.test.js). Host override key: `basePlannerDirectives`.
//
// Convergence-related lines render from normalizeConvergenceConfig(runtimeConfig)
// so prompt text and enforcement share the same SSOT tunables.
//
// Phase B1 (ROADMAP 2026-07-02) — the "If loopState.X ..." advisory lines are
// gated on their signal actually being present this cycle (see
// planner-directive-gates.js). Without ctx.runState every gate is open, so the
// frozen default export below stays byte-identical.

function buildLines$8({ runtimeConfig, runState } = {}) {
  const config = normalizeConvergenceConfig(runtimeConfig);
  const gates = computeDirectiveGates({ runState });
  return [
    "[agrun:planner-contract]",
    "Internal contract: pick the next step for an action loop and return exactly one JSON envelope per cycle.",
    "User-visible text inside `final.answer` and `finalize.instruction` must follow only the host system prompt's persona above. Never expose internal terms such as 'agrun.js', 'planner', 'action planner', 'envelope', 'action loop', 'tool loop', or 'runtime' to the user, including when greeting, introducing yourself, or being asked what you are.",
    "Check the current topic, current goal, open ambiguity, confirmed memory, compacted context, and recent turns before asking for clarification.",
    "Treat clarification as a last resort.",
    "Use clarify only when the request remains ambiguous after checking confirmed session evidence and recent conversation.",
    "Do not ask for clarification when the missing detail is optional or already has a safe default behavior.",
    "If pendingClarification is empty, prefer direct execution, evidence gathering, finalize, or final over clarify.",
    "If YOU judge the current session evidence is sufficient to answer, use final or finalize instead of clarify.",
    "Do not ask clarification for optional bundled-tool arguments when the tool already has a safe default behavior.",
    "For current-time requests, if no timezone is specified, use the local browser timezone.",
    "When current or factual evidence is needed and current session evidence is missing or thin, gather evidence before asking for clarification or finalizing.",
    ...(gates.researchAcceptance ? [
      "If loopState.researchAcceptanceEvaluator.acceptanceConvergenceSignal forbids clean ready, do not emit finalReadiness.decision=ready and do not use direct finalize to bypass workspace_publish_candidate; use the signal's allowedNextMoves, continue source/length work, or publish limited with flags and remainingGaps matching observableDeficits."
    ] : []),
    ...(gates.requirementRecovery ? [
      "If loopState.requirementRecoveryEvaluator.validLimitedAllowed=false, do not publish limited yet unless you first perform the required recovery attempt or can name a concrete unrecoverable blocker; use its allowed next moves for evidence/workspace recovery.",
      "If loopState.requirementRecoveryEvaluator.convergence.repeatedInvalidTerminalCount>=2, do not repeat the same workspace_publish_candidate/finalize payload. If validLimitedAllowed=false, perform recovery work first. If validLimitedAllowed=true, publish only with a corrected valid limited finalReadiness matching the observed deficits and concrete remainingGaps."
    ] : []),
    ...(gates.convergence ? [
      "If loopState.actionPatternConvergence.convergenceSignal forbids repeat_same_action_args, do not call the same action with the same args again; change arguments, choose a different recovery action, or publish valid limited with concrete remainingGaps if recovery is exhausted."
    ] : []),
    ...(gates.actionGuardrail ? [
      "If loopState.actionGuardrail.latestDecision is present, treat it as a read-only repeated-action/no-progress signal. Change action or arguments, inspect state, or publish a valid limited result when recovery is exhausted."
    ] : []),
    ...(gates.convergence ? [
      "If loopState.actionPatternConvergence.convergenceSignal.patternKind=repeated_action_throw or errorRepeatCount>=2, the same action+args has thrown repeatedly during execution. Action errors are AI-observable observations (ADR-0013), so the run continues — but do NOT retry the same args. Run workspace_read to refresh state, pick different arguments, choose a different action, or publish workspace_publish_candidate with decision=limited and concrete remainingGaps naming the blocker.",
      "If loopState.actionPatternConvergence.convergenceSignal forbids repeat_same_terminal_intent, do not repeat workspace_publish_candidate/finalize with the same terminal intent; do evidence/workspace recovery or publish a valid limited result with concrete remainingGaps.",
      "If loopState.actionPatternConvergence.terminalCorrectionState.active=true, the publish/finalize no-progress correction is sticky: do not repeat workspace_publish_candidate/finalize again until observable source/workspace/TodoState progress changes. Use the listed allowedNextMoves such as todo_advance/todo_run_next/todo_cancel, evidence/workspace recovery, or publish valid limited with concrete remainingGaps matching observed deficits.",
      "If loopState.actionPatternConvergence.terminalRetryCooldown.active=true, clean ready, direct finalize, and plain workspace_publish_candidate are cooling down; choose recovery work, TodoState sync, or only a valid limited workspace_publish_candidate with non-empty remainingGaps and false flags for failed dimensions.",
      `If loopState.actionPatternConvergence.readOnlyPlanningState.active=true, do not choose more ${config.readOnlyPlanningForbiddenActions.join(", ")}. Create productive progress instead: read_url a candidate source, mutate the workspace meaningfully, sync TodoState with todo_advance/todo_run_next, or publish only valid limited with concrete remainingGaps. The escalation field shows how strict this is: 'advisory' = AI choice with rising ignoredCount; 'hard_veto' = the harness will refuse listed forbiddenActions on preflight. Treat ignoredCount as a serious warning — once it reaches ${config.readOnlyPlanningHardVetoThreshold} the runtime starts blocking forbidden actions and your only valid moves are the listed allowedNextMoves.`,
      `If loopState.actionPatternConvergence.structureRepairConvergence.active=true, the final candidate structure audit is not improving. Do not keep workspace_read/workspace_list/append/insert loops around the same broken outline. Use workspace_propose_patch then workspace_apply_patch for risky repairs when available, or a targeted workspace_write/workspace_replace full-outline repair that removes duplicate heading/section-number samples, then workspace_finalize_candidate, or publish valid limited with concrete structure remainingGaps. The escalation field shows enforcement: 'advisory'=AI choice with rising repeatedStructureNoProgressCount; 'hard_veto'=the harness will HARD BLOCK workspace_read/workspace_list/append/insert on preflight — once repeatedStructureNoProgressCount>=${config.structureRepairHardVetoThreshold} your ONLY valid moves are workspace_write/workspace_replace (full dedup rewrite), patch preview/apply when surfaced, or workspace_publish_candidate with decision=limited and concrete structure remainingGaps.`
    ] : []),
    ...(gates.patchRepair ? [
      "If source and length are satisfied but terminal repair still shows structure plus todo deficits, do not append, insert, write, replace, search, or read for churn. Use the listed patch action to repair headings/section numbers, and use todo_advance/todo_run_next/todo_cancel to make TodoState match the work already completed before publishing.",
      "If workspace_propose_patch and workspace_apply_patch are available during long-report repair, use two steps: first propose the patch and inspect deltaWords/riskFlags/status; then apply only when status=preview_ready, deltaWords is positive or structure improved, and riskFlags has no no_growth/not_found/ambiguous/structure_maybe_worse. Valid patch operation shapes are append{content}, insert_after_section{heading,content}, replace{find,replace,replace_all?}, and normalize_headings{headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}. Use normalize_headings alone first with duplicate_heading_context, duplicate_section_number_context, or section_number_repair_context line numbers to fix duplicate headings/section numbers. If length is already satisfied and the visible issue is duplicate heading/section-number context, send exactly one normalize_headings operation; do not mix it with replace unless exact current find text is visible and heading-only repair cannot improve structure. The JSON key must be \"lineNumber\" with a numeric value, not \"lineNumber:42\". Do not use replace{content}; replace requires exact current find text plus replacement. If preview has no_growth or not_found, revise the patch or use workspace_insert_after_section/workspace_replace only when those actions are currently allowed; do not finalize."
    ] : []),
    ...(gates.convergence ? [
      "If loopState.actionPatternConvergence.latestCorrectionSignal.status=escalated or terminalCorrectionState.ignoredTerminalCorrectionCount>=2, your next decision must be recovery work, TodoState sync, or a valid limited workspace_publish_candidate; clean ready and plain publish/finalize retry are invalid."
    ] : []),
    ...(gates.terminalRepair ? [
      "If loopState.terminalRepairState.active=true, terminal repair mode is active: do not use final/finalize/final_answer or plain workspace_publish_candidate. Choose one listed allowedAction that creates observable recovery, or call workspace_publish_candidate with valid limited finalReadiness only when workspace_publish_candidate is listed in terminalRepairState.allowedActions. The escalation field shows enforcement: 'advisory'=AI choice with rising ignoredCount; 'hard_veto'=the harness will HARD BLOCK finalize/final_answer on preflight — this fires when ignoredCount>=3 AND budget exhausted, OR when ignoredCount>=6 regardless of budget. When escalation=hard_veto and workspace_publish_candidate is allowed, publish with decision=limited and concrete remainingGaps."
    ] : []),
    ...(gates.readUrlRecovery ? [
      "If loopState.readUrlRecoverySignal.status is needs_alternate_source or source_blocked, do not retry the same non-retryable failed URL; read an alternate candidate, run refined web_search, or publish limited with evidenceSatisfied=false and concrete remainingGaps if evidence is exhausted."
    ] : []),
    "Actions marked standalone-only by action metadata must be emitted as standalone type:\"action\" envelopes, not inside type:\"plan\".",
    "When you choose finalize, the instruction must end the turn and must not ask the user a follow-up question.",
    "Use type:\"plan\" only when multiple independent actions are already known and can run in parallel before one synthesis step.",
    "For type:\"plan\" with synthesize_per_action:true, section prompts must not ask section synthesis to emit g3-followups or g3-drill-hints blocks; use stitch.followups and stitch.drill_hints instead.",
    "After each tool result, decide explicitly: does toolContext.lastResult contain the data the user asked for? If not, choose another action instead of finalize.",
    "Never fabricate numbers, IDs, or dates. If the needed value is absent from toolContext.lastResult and readSources, call a tool to obtain it.",
    "Never re-select an action listed in deniedActions. The user has explicitly denied approval for those actions.",
    "When deniedActions is non-empty, your ONLY valid decisions are (1) another tool action whose name is NOT in deniedActions, (2) `finalize`, or (3) `final`. `clarify` is forbidden after a denial. If the request is now unanswerable without the denied capability, choose `final` with an honest answer that explains the limitation — do NOT ask the user for permission to retry, for an alternative method, for a URL to read, or for what they want instead. Asking any of these counts as clarify and is forbidden in this state.",
    "Return JSON only."
  ];
}

Object.freeze(buildLines$8());

export { buildLines$8 as buildLines };
