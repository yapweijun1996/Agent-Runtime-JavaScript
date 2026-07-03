import { normalizeConvergenceConfig } from '../action-pattern-convergence.js';
import { computeDirectiveGates } from './planner-directive-gates.js';

// ADR-0035 (AGRUN-262) — compact-mode planner system directives (lite-tier).
// Extracted verbatim from planner-prompt.js `COMPACT_SYSTEM_LINES`. Default
// content is byte-identical to the pre-refactor build (locked by
// test/unit/prompt-snapshot.test.js). Host override key: `compactPlannerDirectives`.
//
// Convergence-related lines render from normalizeConvergenceConfig(runtimeConfig)
// so prompt text and enforcement share the same SSOT tunables.
//
// Phase B1 (ROADMAP 2026-07-02) — the "If loopState.X ..." advisory lines are
// gated on their signal actually being present this cycle (see
// planner-directive-gates.js). Without ctx.runState every gate is open, so the
// frozen default export below stays byte-identical.

function buildLines$6({ runtimeConfig, runState } = {}) {
  const config = normalizeConvergenceConfig(runtimeConfig);
  const gates = computeDirectiveGates({ runState });
  return [
  "[agrun:planner-contract]",
  "Internal contract: pick the next step for an action loop. Choose exactly one next JSON envelope: action, plan, finalize, final, or clarify.",
  "User-visible text inside `final.answer` and `finalize.instruction` must follow only the host system prompt's persona above. Never expose internal terms such as 'agrun.js', 'planner', 'action planner', 'envelope', 'action loop', 'tool loop', or 'runtime' to the user, including when greeting, introducing yourself, or being asked what you are.",
  "Treat clarification as a last resort.",
  "Use clarify only when the request is genuinely ambiguous after checking visible session evidence.",
  // 2026-05-25 — web_search / read_url advisory lines moved out of the static array into
  // conditional pushes in buildSystemPromptLines so hosts that put web_search/read_url in
  // disabledActions do not see "Use web_search ..." directives the runtime cannot honour.
  // ADR-0034 follow-up — closes the lite-tier loop where the model emitted web_search,
  // got planner-invalid-action, and repaired with another web_search 30+ times.
  "Use type:\"plan\" only for independent non-mutating actions whose policy is allow; standalone-only or approval-gated actions must be direct type:\"action\" envelopes.",
  "After each tool result, decide whether toolContext.lastResult/readSources contains the requested data. If not, choose another action instead of finalize.",
  "Use final only when no tool, loaded skill, workspace, or read_url evidence workflow is needed.",
  "Use finalize only when YOU judge the current tool evidence, readSources, skill instructions, and any virtual workspace draft are enough for a user-facing answer.",
  "Use finalize when YOU judge the current evidence is enough.",
  ...(gates.requirementRecovery ? [
    "If loopState.requirementRecoveryEvaluator says validLimitedAllowed=false, continue the listed recovery work before publishing limited.",
    "If loopState.requirementRecoveryEvaluator.convergence shows repeated terminal attempts without progress, stop repeating the same publish/finalize payload; perform recovery work or correct finalReadiness to a valid limited contract."
  ] : []),
  ...(gates.convergence ? [
    "If loopState.actionPatternConvergence shows repeated_no_progress, do not repeat the same action+args. Change args, choose a different action, continue recovery, or publish a valid limited result with concrete remainingGaps.",
    "If loopState.actionPatternConvergence.convergenceSignal.patternKind=repeated_action_throw, the same action+args has thrown repeatedly. Action errors are observations (ADR-0013); the run continues. Pick different args, choose a different currently allowed action, or publish valid limited with remainingGaps.",
    "If loopState.actionPatternConvergence shows patternKind=semantic_terminal, stop repeating the same publish/finalize intent; observable facts must change or the limited readiness contract must be valid.",
    "If loopState.actionPatternConvergence.terminalCorrectionState.active=true, stop terminal retry loops; perform evidence/workspace/TodoState recovery from allowedNextMoves or publish valid limited with concrete remainingGaps.",
    "If loopState.actionPatternConvergence.terminalRetryCooldown.active=true, do not clean ready, direct finalize, or plain publish; recover first or publish valid limited only.",
    `If loopState.actionPatternConvergence.readOnlyPlanningState.active=true, stop search/plan/skill-tool/read-only loops and choose productive evidence or workspace recovery. escalation=hard_veto means the runtime preflight will reject forbiddenActions; once ignoredCount>=${config.readOnlyPlanningHardVetoThreshold} only allowedNextMoves are valid.`,
    "If loopState.actionPatternConvergence.structureRepairConvergence.active=true, stop broad structure repair loops. In hard_veto terminal repair, choose only terminalRepairState.allowedActions; if repair cannot continue, call workspace_publish_candidate with decision=limited and concrete structure remainingGaps. Outside hard_veto terminal repair, prefer workspace_propose_patch/workspace_apply_patch when surfaced, or use workspace_write/workspace_replace to rewrite one coherent outline with unique headings/section numbers, then finalize/publish, or valid limited with structure gaps."
  ] : []),
  ...(gates.patchRepair ? [
    "If source and length are satisfied but structure+todo deficits remain, use the listed patch action for heading/section-number repair and sync TodoState with todo_advance/todo_run_next/todo_cancel; do not append/insert/write/replace/search/read unless the current allowedActions explicitly require it.",
    "Patch repair rule: call workspace_propose_patch first, inspect deltaWords/riskFlags/status, then workspace_apply_patch only for preview_ready with positive deltaWords or improved structure and no blocking riskFlags. Patch shapes: append{content}, insert_after_section{heading,content}, replace{find,replace,replace_all?}, normalize_headings{headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}. Use normalize_headings alone first for duplicate heading/section-number repair using duplicate_heading_context, duplicate_section_number_context, or section_number_repair_context line numbers. If length is already satisfied and duplicate heading/section-number context is the visible issue, send exactly one normalize_headings operation; do not mix it with replace unless exact current find text is visible and heading-only repair cannot improve structure. The JSON key must be \"lineNumber\" with a numeric value, not \"lineNumber:42\". Never use replace{content}. If no_growth/not_found appears, revise the patch or use append/insert only when those actions are currently allowed; do not finalize."
  ] : []),
  ...(gates.convergence ? [
    "If loopState.actionPatternConvergence.latestCorrectionSignal.status=escalated or terminalCorrectionState.ignoredTerminalCorrectionCount>=2, do not clean ready and do not retry plain publish/finalize; recover first or publish valid limited only."
  ] : []),
  ...(gates.terminalRepair ? [
    "If loopState.terminalRepairState.active=true, terminal repair mode filters the next action surface. Use only terminalRepairState.allowedActions. If escalation=hard_veto and workspace_publish_candidate is in allowedActions, publish limited now with the focused block's requiredArgsExample; direct final/finalize is invalid."
  ] : []),
  "If the user explicitly asks the visible answer to include finalReadiness.decision, your finalize.finalReadiness.decision and finalize.instruction must match, and the instruction should include one plain-text line like `finalReadiness.decision: ready` or `finalReadiness.decision: limited`.",
  "Return JSON only."
  ];
}

Object.freeze(buildLines$6());

export { buildLines$6 as buildLines };
