import { djb2Hash, stableStringify, fingerprintAction } from './action-fingerprint.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from './workspace-candidate-lifecycle.js';
import { summarizeProgressSnapshot, normalizeProgressSnapshot, createProgressSnapshot, resolveProductiveProgressDimensions, diffProgress, readCandidateSnapshot, readSourceMinimum, hasUnfinishedTodoState, hasWorkspaceArtifacts, readRequestedLengthStatus, readAcceptancePacket } from './action-pattern-progress.js';
import { isEvidenceConvergenceRun } from './convergence-activation.js';
import { WORKSPACE_WRITE_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_LIST_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_APPLY_PATCH_ACTION, WEB_SEARCH_ACTION, TODO_PLAN_ACTION, TODO_INSPECT_ACTION, LIST_AGENT_SKILLS_ACTION, READ_AGENT_SKILL_ACTION, USE_AGENT_SKILL_ACTION, EXECUTE_SKILL_TOOL_ACTION, PUBLISH_DIRECT_ACTION, FINALIZE_CANDIDATE_ACTION } from './action-names.js';
import { cloneValue } from './utils.js';
import { readStringArray, readString } from './semantic-json.js';

const DEFAULT_REPEAT_THRESHOLD = 2;
const TRANSITIONAL_ONLY_THRESHOLD = 3;
const READ_ONLY_PLANNING_HARD_VETO_THRESHOLD = 3;
const READ_ONLY_PLANNING_CLEAR_THRESHOLD = 2;
const STRUCTURE_REPAIR_NO_PROGRESS_THRESHOLD = 2;
// ADR-0013 / AGRUN-237 PR 3: escalate to hard_veto after this many no-progress
// structure repair cycles — mirrors READ_ONLY_PLANNING_HARD_VETO_THRESHOLD.
const STRUCTURE_REPAIR_HARD_VETO_THRESHOLD = 3;
// AGRUN-237-GAP-04: workspace_write overwrite oscillation — advisory when stall
// count reaches 2, hard_veto at 3.
const WORKSPACE_MUTATION_GROWTH_ADVISORY_THRESHOLD = 2;
const WORKSPACE_MUTATION_GROWTH_HARD_VETO_THRESHOLD = 3;
// delta.words below this floor (while deficit persists) counts as a stall.
const WORKSPACE_MUTATION_GROWTH_STALL_FLOOR = 30;
const MAX_RECENT_PATTERNS = 12;
// AGRUN-263 — window for tool-result dedup. A successful tool call only
// produces the `tool_result` productive dimension when its action+args
// fingerprint is NOT in the last N entries. Mirrors the AGRUN-256 trap:
// productive signals must not be game-able by re-issuing the same call.
const TOOL_RESULT_DEDUP_WINDOW = 5;
const DEFAULT_FORBIDDEN_TERMINAL_ACTIONS = [PUBLISH_DIRECT_ACTION, "finalize"];
const DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS = [
  WEB_SEARCH_ACTION,
  TODO_PLAN_ACTION,
  TODO_INSPECT_ACTION,
  WORKSPACE_LIST_ACTION,
  WORKSPACE_READ_ACTION,
  LIST_AGENT_SKILLS_ACTION,
  READ_AGENT_SKILL_ACTION,
  USE_AGENT_SKILL_ACTION,
  EXECUTE_SKILL_TOOL_ACTION
];
const LENGTH_DEFICIT_CHURN_ACTIONS = [
  WORKSPACE_READ_ACTION,
  WORKSPACE_WRITE_ACTION,
  WORKSPACE_REPLACE_ACTION
];
const DEFAULT_READ_ONLY_PLANNING_ALLOWED_NEXT_MOVES = [
  "read_url",
  "workspace_write",
  "workspace_replace",
  "workspace_insert_after_section",
  "todo_advance",
  "todo_run_next",
  "workspace_publish_candidate_limited_with_remainingGaps"
];
const DEFAULT_STRUCTURE_REPAIR_FORBIDDEN_ACTIONS = [
  WORKSPACE_LIST_ACTION,
  WORKSPACE_READ_ACTION,
  WORKSPACE_INSERT_AFTER_SECTION_ACTION,
  WORKSPACE_MULTI_EDIT_ACTION,
  WORKSPACE_PROPOSE_PATCH_ACTION,
  WORKSPACE_APPLY_PATCH_ACTION,
  WORKSPACE_REPLACE_ACTION
];
const DEFAULT_STRUCTURE_REPAIR_ALLOWED_NEXT_MOVES = [
  "workspace_write",
  "workspace_replace",
  FINALIZE_CANDIDATE_ACTION,
  "todo_advance",
  "todo_run_next",
  "workspace_publish_candidate_limited_with_structure_remainingGaps"
];
const DEFAULT_WORKSPACE_MUTATION_GROWTH_FORBIDDEN_ACTIONS = [
  WORKSPACE_WRITE_ACTION,
  WORKSPACE_REPLACE_ACTION,
  WORKSPACE_MULTI_EDIT_ACTION
];
const DEFAULT_WORKSPACE_MUTATION_GROWTH_ALLOWED_NEXT_MOVES = [
  "workspace_propose_patch",
  "workspace_apply_patch",
  "workspace_insert_after_section",
  "workspace_review_candidate",
  FINALIZE_CANDIDATE_ACTION,
  "workspace_publish_candidate_limited_with_remainingGaps"
];
const DEFAULT_VALID_TERMINAL_EXCEPTION =
  "workspace_publish_candidate with decision=limited + non-empty remainingGaps + false failed-dimension flags";

// SSOT for convergence tunables. agrun is a GENERAL agent runtime; the DEFAULT_*
// constants above encode out-of-box (research/document) behavior, but ONLY the
// host knows its task type and how aggressive convergence should be. Every value
// here is host-overridable via `runtimeConfig.convergence`; when absent each key
// falls back to its DEFAULT_* constant, so default behavior is byte-identical.
// The circuit-breaker MECHANISM (advisory -> escalate -> hard_veto) is unchanged
// — only the THRESHOLDS and FORBIDDEN-ACTION lists become configurable.
const DEFAULT_CONVERGENCE_CONFIG = {
  repeatThreshold: DEFAULT_REPEAT_THRESHOLD,
  transitionalOnlyThreshold: TRANSITIONAL_ONLY_THRESHOLD,
  readOnlyPlanningHardVetoThreshold: READ_ONLY_PLANNING_HARD_VETO_THRESHOLD,
  readOnlyPlanningClearThreshold: READ_ONLY_PLANNING_CLEAR_THRESHOLD,
  structureRepairNoProgressThreshold: STRUCTURE_REPAIR_NO_PROGRESS_THRESHOLD,
  structureRepairHardVetoThreshold: STRUCTURE_REPAIR_HARD_VETO_THRESHOLD,
  workspaceMutationGrowthAdvisoryThreshold: WORKSPACE_MUTATION_GROWTH_ADVISORY_THRESHOLD,
  workspaceMutationGrowthHardVetoThreshold: WORKSPACE_MUTATION_GROWTH_HARD_VETO_THRESHOLD,
  workspaceMutationGrowthStallFloor: WORKSPACE_MUTATION_GROWTH_STALL_FLOOR,
  toolResultDedupWindow: TOOL_RESULT_DEDUP_WINDOW,
  maxRecentPatterns: MAX_RECENT_PATTERNS,
  readOnlyPlanningForbiddenActions: DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS.slice(),
  structureRepairForbiddenActions: DEFAULT_STRUCTURE_REPAIR_FORBIDDEN_ACTIONS.slice(),
  workspaceMutationGrowthForbiddenActions: DEFAULT_WORKSPACE_MUTATION_GROWTH_FORBIDDEN_ACTIONS.slice()
};

// Resolve the host's convergence overrides from `runtimeConfig.convergence`.
// Mirrors normalizeActionGuardrailConfig / resolveProductiveProgressDimensions:
// each threshold reads a positive integer (falling back to its DEFAULT_*), and
// each forbidden-action list is REPLACED (not merged) when the host supplies a
// non-empty array — replacement is intentional so misconfiguration is loud, not
// silently additive.
function normalizeConvergenceConfig(runtimeConfig) {
  const source = runtimeConfig &&
    runtimeConfig.convergence &&
    typeof runtimeConfig.convergence === "object" &&
    !Array.isArray(runtimeConfig.convergence)
    ? runtimeConfig.convergence
    : {};
  return {
    repeatThreshold: readPositiveInteger$j(source.repeatThreshold, DEFAULT_REPEAT_THRESHOLD),
    transitionalOnlyThreshold: readPositiveInteger$j(source.transitionalOnlyThreshold, TRANSITIONAL_ONLY_THRESHOLD),
    readOnlyPlanningHardVetoThreshold: readPositiveInteger$j(source.readOnlyPlanningHardVetoThreshold, READ_ONLY_PLANNING_HARD_VETO_THRESHOLD),
    readOnlyPlanningClearThreshold: readPositiveInteger$j(source.readOnlyPlanningClearThreshold, READ_ONLY_PLANNING_CLEAR_THRESHOLD),
    structureRepairNoProgressThreshold: readPositiveInteger$j(source.structureRepairNoProgressThreshold, STRUCTURE_REPAIR_NO_PROGRESS_THRESHOLD),
    structureRepairHardVetoThreshold: readPositiveInteger$j(source.structureRepairHardVetoThreshold, STRUCTURE_REPAIR_HARD_VETO_THRESHOLD),
    workspaceMutationGrowthAdvisoryThreshold: readPositiveInteger$j(source.workspaceMutationGrowthAdvisoryThreshold, WORKSPACE_MUTATION_GROWTH_ADVISORY_THRESHOLD),
    workspaceMutationGrowthHardVetoThreshold: readPositiveInteger$j(source.workspaceMutationGrowthHardVetoThreshold, WORKSPACE_MUTATION_GROWTH_HARD_VETO_THRESHOLD),
    workspaceMutationGrowthStallFloor: readPositiveInteger$j(source.workspaceMutationGrowthStallFloor, WORKSPACE_MUTATION_GROWTH_STALL_FLOOR),
    toolResultDedupWindow: readPositiveInteger$j(source.toolResultDedupWindow, TOOL_RESULT_DEDUP_WINDOW),
    maxRecentPatterns: readPositiveInteger$j(source.maxRecentPatterns, MAX_RECENT_PATTERNS),
    readOnlyPlanningForbiddenActions: readForbiddenActionList(source.readOnlyPlanningForbiddenActions, DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS),
    structureRepairForbiddenActions: readForbiddenActionList(source.structureRepairForbiddenActions, DEFAULT_STRUCTURE_REPAIR_FORBIDDEN_ACTIONS),
    workspaceMutationGrowthForbiddenActions: readForbiddenActionList(source.workspaceMutationGrowthForbiddenActions, DEFAULT_WORKSPACE_MUTATION_GROWTH_FORBIDDEN_ACTIONS)
  };
}

function createActionPatternConvergenceState() {
  return {
    kind: "action_pattern_convergence",
    status: "tracking",
    lastFingerprint: null,
    lastOutcomeHash: null,
    lastSemanticFingerprint: null,
    lastActionName: null,
    repeatedFingerprintCount: 0,
    repeatedSemanticFingerprintCount: 0,
    errorRepeatCount: 0,
    stepsWithoutObservableProgress: 0,
    progressSnapshot: createProgressSnapshot(null),
    recentPatterns: [],
    recentToolFingerprints: [],
    convergenceSignal: null,
    readOnlyPlanningState: createReadOnlyPlanningState(),
    structureRepairConvergence: createStructureRepairConvergenceState(),
    workspaceMutationGrowthConvergence: createWorkspaceMutationGrowthConvergenceState(),
    terminalCorrectionState: createTerminalCorrectionState(),
    ignoredTerminalCorrectionCount: 0,
    latestCorrectionSignal: null,
    terminalRetryCooldown: createTerminalRetryCooldownState(),
    updatedAtCycle: null,
    version: 1
  };
}

function isActionErrorRefresh(context) {
  const status = readString(context && context.status);
  return status === "action_error_self_correct"
    || status === "validation_error_self_correct"
    || status === "preflight_error_self_correct";
}

function refreshActionPatternConvergence(runState, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const config = normalizeConvergenceConfig(context.runtimeConfig);
  const previous = normalizeActionPatternConvergenceState(runState.actionPatternConvergence, config);
  const next = evaluateActionPatternConvergence(runState, { ...context, previous });
  runState.actionPatternConvergence = next;
  return next;
}

function shouldEmitActionPatternConvergenceRefreshed(evaluator) {
  return Boolean(
    evaluator &&
    typeof evaluator === "object" &&
    evaluator.convergenceSignal &&
    typeof evaluator.convergenceSignal === "object"
  );
}

function evaluateActionPatternConvergence(runState, context = {}) {
  const config = normalizeConvergenceConfig(context.runtimeConfig);
  const previous = normalizeActionPatternConvergenceState(context.previous || runState && runState.actionPatternConvergence, config);
  const actionName = readString(context.actionName) || readActionName$3(context.decision);
  const fingerprint = readString(context.fingerprint) || fingerprintAction(context.decision) || null;
  const outcomeHash = readString(context.outcomeHash) || createOutcomeHash(runState, context, actionName);
  const semanticFingerprint = readString(context.semanticFingerprint) ||
    createSemanticTerminalFingerprint(runState, context, actionName);
  const snapshot = createProgressSnapshot(runState, context.runtimeConfig);
  // AGRUN-263 — `tool_result` dimension: when configured productive
  // whitelist includes `tool_result`, AND the new toolHistory entry is a
  // genuinely NEW (action+args) call vs. last N, count it as productive.
  // Dedup window prevents the planner from gaming the detector by
  // re-issuing identical tool calls.
  const productiveWhitelist = resolveProductiveProgressDimensions(context.runtimeConfig);
  const toolFingerprint = buildToolCallFingerprint(actionName, context.decision);
  const toolHistoryGrew = readNumber$f(snapshot.toolHistoryCount) > readNumber$f(previous.progressSnapshot && previous.progressSnapshot.toolHistoryCount);
  const isDuplicateToolCall = Boolean(
    toolFingerprint && Array.isArray(previous.recentToolFingerprints) &&
    previous.recentToolFingerprints.includes(toolFingerprint)
  );
  const toolResultProductive = productiveWhitelist.includes("tool_result")
    && toolHistoryGrew
    && Boolean(toolFingerprint)
    && !isDuplicateToolCall;
  const extraDimensions = toolResultProductive ? ["tool_result"] : [];
  const progress = diffProgress(previous.progressSnapshot, snapshot, {
    productiveDimensions: productiveWhitelist,
    extraDimensions
  });
  const recentToolFingerprints = updateRecentToolFingerprints(
    previous.recentToolFingerprints,
    toolFingerprint,
    toolHistoryGrew,
    config
  );
  const longFormMode = isEvidenceConvergenceRun(runState);
  const productiveOnlyMode = longFormMode || isStructuredReadOnlyPlanningLoop(runState, actionName, config);
  const effectiveHasProgress = productiveOnlyMode ? progress.hasProductiveProgress : progress.hasProgress;
  const repeatedFingerprintCount = fingerprint && fingerprint === previous.lastFingerprint
    ? previous.repeatedFingerprintCount + 1
    : fingerprint
      ? 1
      : previous.repeatedFingerprintCount;
  const repeatedSemanticFingerprintCount = progress.hasProgress && previous.lastSemanticFingerprint
    ? 0
    : semanticFingerprint &&
    semanticFingerprint === previous.lastSemanticFingerprint &&
    outcomeHash &&
    outcomeHash === previous.lastOutcomeHash
      ? previous.repeatedSemanticFingerprintCount + 1
      : semanticFingerprint
        ? 1
        : previous.repeatedSemanticFingerprintCount;
  const stepsWithoutObservableProgress = effectiveHasProgress
    ? 0
    : isTrackableAction(actionName, context)
      ? previous.stepsWithoutObservableProgress + 1
      : previous.stepsWithoutObservableProgress;
  // ADR-0013 — track repeated throws of the same action+args. The
  // counter increments only when the current refresh is an
  // action-error path (validation / preflight / execute) AND the
  // fingerprint matches the previous throw. Any non-error refresh
  // resets it, so a single recovered action clears the signal.
  const errorRepeatCount = isActionErrorRefresh(context)
    ? (fingerprint && fingerprint === previous.lastFingerprint
        ? readNumber$f(previous.errorRepeatCount) + 1
        : 1)
    : 0;
  const signal = buildConvergenceSignal({
    actionName,
    config,
    context,
    effectiveHasProgress,
    errorRepeatCount,
    fingerprint,
    longFormMode,
    outcomeHash,
    progress,
    productiveOnlyMode,
    repeatedFingerprintCount,
    repeatedSemanticFingerprintCount,
    runState,
    semanticFingerprint,
    stepsWithoutObservableProgress
  });
  const terminalCorrectionState = updateTerminalCorrectionState({
    actionName,
    config,
    context,
    outcomeHash,
    previous: previous.terminalCorrectionState,
    progress,
    runState,
    semanticFingerprint,
    signal
  });
  const terminalRetryCooldown = updateTerminalRetryCooldown({
    actionName,
    context,
    previous: previous.terminalRetryCooldown,
    previousLastActionName: previous.lastActionName,
    progress,
    runState,
    signal,
    terminalCorrectionState
  });
  const readOnlyPlanningState = updateReadOnlyPlanningState({
    actionName,
    config,
    context,
    previous: previous.readOnlyPlanningState,
    progress,
    runState,
    signal,
    stepsWithoutObservableProgress
  });
  const structureRepairConvergence = updateStructureRepairConvergence({
    actionName,
    config,
    context,
    previous: previous.structureRepairConvergence,
    runState
  });
  const workspaceMutationGrowthConvergence = updateWorkspaceMutationGrowthConvergence({
    actionName,
    config,
    context,
    progress,
    previous: previous.workspaceMutationGrowthConvergence,
    runState
  });
  const latestCorrectionSignal = buildLatestCorrectionSignal(terminalCorrectionState, signal, config);
  const patternKind = semanticFingerprint ? "semantic_terminal" : "exact_action";
  const status = terminalCorrectionState.active
    ? "terminal_correction_active"
    : readOnlyPlanningState.active
      ? "read_only_planning_active"
      : structureRepairConvergence.active
        ? "structure_repair_active"
      : workspaceMutationGrowthConvergence.active
        ? "workspace_mutation_growth_active"
    : signal
    ? "repeated_no_progress"
    : progress.hasProgress
      ? "progress_observed"
      : "tracking";
  const recentPatterns = appendRecentPattern(previous.recentPatterns, {
    actionName: actionName || null,
    cycle: readNullableNumber$5(runState && runState.cycleCount),
    fingerprint,
    outcomeHash,
    patternKind,
    progress: progress.dimensions,
    repeatCount: repeatedFingerprintCount,
    semanticFingerprint,
    semanticRepeatCount: repeatedSemanticFingerprintCount,
    status,
    stage: readString(context.status) || readString(context.stage) || null
  }, config);

  return {
    kind: "action_pattern_convergence",
    status,
    lastFingerprint: fingerprint || previous.lastFingerprint || null,
    lastOutcomeHash: outcomeHash || previous.lastOutcomeHash || null,
    lastSemanticFingerprint: semanticFingerprint || previous.lastSemanticFingerprint || null,
    lastActionName: actionName || previous.lastActionName || null,
    repeatedFingerprintCount,
    repeatedSemanticFingerprintCount,
    errorRepeatCount,
    stepsWithoutObservableProgress,
    progressSnapshot: snapshot,
    recentPatterns,
    recentToolFingerprints,
    convergenceSignal: signal,
    readOnlyPlanningState,
    structureRepairConvergence,
    workspaceMutationGrowthConvergence,
    terminalCorrectionState,
    ignoredTerminalCorrectionCount: terminalCorrectionState.active
      ? terminalCorrectionState.ignoredTerminalCorrectionCount
      : 0,
    latestCorrectionSignal,
    terminalRetryCooldown,
    updatedAtCycle: readNullableNumber$5(runState && runState.cycleCount),
    version: 1
  };
}

function summarizeActionPatternConvergence(value) {
  const normalized = normalizeActionPatternConvergenceState(value);
  const signal = normalized.convergenceSignal;
  if (
    normalized.status === "tracking" &&
    !signal &&
    !normalized.terminalCorrectionState.active &&
    !normalized.terminalRetryCooldown.active &&
    !normalized.structureRepairConvergence.active &&
    !normalized.workspaceMutationGrowthConvergence.active &&
    readNumber$f(normalized.terminalRetryCooldown.blockedTerminalRetryCount) === 0 &&
    normalized.repeatedFingerprintCount === 0 &&
    readNumber$f(normalized.errorRepeatCount) === 0 &&
    normalized.stepsWithoutObservableProgress === 0
  ) {
    return null;
  }
  return {
    kind: "action_pattern_convergence",
    status: normalized.status,
    lastActionName: normalized.lastActionName,
    lastFingerprint: normalized.lastFingerprint,
    lastOutcomeHash: normalized.lastOutcomeHash,
    lastSemanticFingerprint: normalized.lastSemanticFingerprint,
    repeatedFingerprintCount: normalized.repeatedFingerprintCount,
    repeatedSemanticFingerprintCount: normalized.repeatedSemanticFingerprintCount,
    errorRepeatCount: readNumber$f(normalized.errorRepeatCount),
    stepsWithoutObservableProgress: normalized.stepsWithoutObservableProgress,
    progressSnapshot: summarizeProgressSnapshot(normalized.progressSnapshot),
    recentPatterns: normalized.recentPatterns.slice(-6).map((entry) => ({
      actionName: readString(entry.actionName) || null,
      cycle: readNullableNumber$5(entry.cycle),
      fingerprint: readString(entry.fingerprint) || null,
      outcomeHash: readString(entry.outcomeHash) || null,
      patternKind: readPatternKind(entry.patternKind),
      progress: Array.isArray(entry.progress) ? entry.progress.map(readString).filter(Boolean).slice(0, 6) : [],
      repeatCount: readNumber$f(entry.repeatCount),
      semanticFingerprint: readString(entry.semanticFingerprint) || null,
      semanticRepeatCount: readNumber$f(entry.semanticRepeatCount),
      status: readString(entry.status) || "tracking",
      stage: readString(entry.stage) || null
    })),
    convergenceSignal: signal ? cloneValue(signal) : null,
    terminalCorrectionState: cloneValue(normalized.terminalCorrectionState),
    ignoredTerminalCorrectionCount: normalized.ignoredTerminalCorrectionCount,
    latestCorrectionSignal: normalized.latestCorrectionSignal
      ? cloneValue(normalized.latestCorrectionSignal)
      : null,
    readOnlyPlanningState: summarizeReadOnlyPlanningState(normalized.readOnlyPlanningState),
    structureRepairConvergence: summarizeStructureRepairConvergence(normalized.structureRepairConvergence),
    workspaceMutationGrowthConvergence: summarizeWorkspaceMutationGrowthConvergence(normalized.workspaceMutationGrowthConvergence),
    terminalRetryCooldown: summarizeTerminalRetryCooldown(normalized.terminalRetryCooldown),
    updatedAtCycle: normalized.updatedAtCycle
  };
}

function createReadOnlyPlanningState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  const forbiddenActions = readStringArray(source.forbiddenActions);
  const allowedNextMoves = readStringArray(source.allowedNextMoves);
  const ignoredCount = readNumber$f(source.ignoredCount);
  const explicitEscalation = readString(source.escalation);
  const escalation = explicitEscalation === "hard_veto" || explicitEscalation === "advisory"
    ? explicitEscalation
    : (active && ignoredCount >= READ_ONLY_PLANNING_HARD_VETO_THRESHOLD ? "hard_veto" : "advisory");
  return {
    active,
    status: readString(source.status) || (active ? "active" : "none"),
    reason: readString(source.reason) || null,
    forbiddenMove: readString(source.forbiddenMove) || (active ? "repeat_read_only_planning_without_productive_progress" : null),
    forbiddenActions: (forbiddenActions.length > 0
      ? forbiddenActions
      : DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS).slice(0, 12),
    allowedNextMoves: (allowedNextMoves.length > 0
      ? allowedNextMoves
      : DEFAULT_READ_ONLY_PLANNING_ALLOWED_NEXT_MOVES).slice(0, 12),
    requiredCorrection: readString(source.requiredCorrection) || null,
    stepsWithoutProductiveProgress: readNumber$f(source.stepsWithoutProductiveProgress),
    consecutiveProductiveSteps: readNumber$f(source.consecutiveProductiveSteps),
    ignoredCount,
    escalation,
    activatedAtCycle: readNullableNumber$5(source.activatedAtCycle),
    lastUpdatedAtCycle: readNullableNumber$5(source.lastUpdatedAtCycle),
    lastIgnoredAtCycle: readNullableNumber$5(source.lastIgnoredAtCycle),
    transitionalDimensions: readStringArray(source.transitionalDimensions).slice(0, 8),
    lastActionName: readString(source.lastActionName) || null,
    clearedReason: active ? null : (readString(source.clearedReason) || null)
  };
}

function summarizeReadOnlyPlanningState(value) {
  const state = createReadOnlyPlanningState(value);
  if (
    !state.active &&
    state.ignoredCount === 0 &&
    state.stepsWithoutProductiveProgress === 0 &&
    !state.clearedReason
  ) {
    return {
      active: false,
      status: state.status,
      clearedReason: state.clearedReason
    };
  }
  return {
    active: state.active,
    status: state.status,
    reason: state.reason,
    escalation: state.escalation,
    forbiddenMove: state.forbiddenMove,
    forbiddenActions: state.forbiddenActions,
    allowedNextMoves: state.allowedNextMoves,
    requiredCorrection: state.requiredCorrection,
    stepsWithoutProductiveProgress: state.stepsWithoutProductiveProgress,
    ignoredCount: state.ignoredCount,
    activatedAtCycle: state.activatedAtCycle,
    lastUpdatedAtCycle: state.lastUpdatedAtCycle,
    lastIgnoredAtCycle: state.lastIgnoredAtCycle,
    transitionalDimensions: state.transitionalDimensions,
    lastActionName: state.lastActionName,
    clearedReason: state.clearedReason
  };
}

function createStructureRepairConvergenceState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  return {
    active,
    status: readString(source.status) || (active ? "active" : "none"),
    reason: readString(source.reason) || null,
    forbiddenMove: readString(source.forbiddenMove) || (active ? "repeat_structure_repair_without_audit_delta" : null),
    forbiddenActions: (readStringArray(source.forbiddenActions).length > 0
      ? readStringArray(source.forbiddenActions)
      : DEFAULT_STRUCTURE_REPAIR_FORBIDDEN_ACTIONS).slice(0, 12),
    allowedNextMoves: (readStringArray(source.allowedNextMoves).length > 0
      ? readStringArray(source.allowedNextMoves)
      : DEFAULT_STRUCTURE_REPAIR_ALLOWED_NEXT_MOVES).slice(0, 12),
    requiredCorrection: readString(source.requiredCorrection) || null,
    repeatedStructureNoProgressCount: readNumber$f(source.repeatedStructureNoProgressCount),
    structureProgressCount: readNumber$f(source.structureProgressCount),
    lastActionName: readString(source.lastActionName) || null,
    lastStructureSnapshot: normalizeStructureSnapshot(source.lastStructureSnapshot),
    activeIssueCodes: readStringArray(source.activeIssueCodes).slice(0, 8),
    repeatedHeadingSamples: normalizeStructureSamples(source.repeatedHeadingSamples, "heading"),
    repeatedNumberSamples: normalizeStructureSamples(source.repeatedNumberSamples, "number"),
    escalation: readString(source.escalation) === "hard_veto" ? "hard_veto" : "advisory",
    activatedAtCycle: readNullableNumber$5(source.activatedAtCycle),
    lastUpdatedAtCycle: readNullableNumber$5(source.lastUpdatedAtCycle),
    lastNoProgressAtCycle: readNullableNumber$5(source.lastNoProgressAtCycle),
    clearedReason: active ? null : (readString(source.clearedReason) || null),
    // AGRUN-303 — the host output guardrail can block one section (e.g.
    // section_rehash) while the heading/number structure reads clean. The live
    // block only appears on the publish-attempt cycle, so the blocked section +
    // its content hash are persisted here and compared across the edit/read
    // churn cycles that follow to detect a no-op repair loop.
    openGuardrailBlock: normalizeOpenGuardrailBlock(source.openGuardrailBlock),
    // AGRUN-304 — lowest heading/number structural-defect score seen during the
    // current block; lets the no-progress counter survive count oscillation.
    bestStructureDefectScore: readNullableScore(source.bestStructureDefectScore)
  };
}

function normalizeOpenGuardrailBlock(value) {
  const source = readRecord(value);
  if (!source) return null;
  const section = readString(source.section) || null;
  const sectionHash = readString(source.sectionHash) || null;
  const issueCodes = readStringArray(source.issueCodes).slice(0, 8);
  if (!section && issueCodes.length === 0) return null;
  return { section, sectionHash, issueCodes };
}

function summarizeStructureRepairConvergence(value) {
  const state = createStructureRepairConvergenceState(value);
  if (
    !state.active &&
    state.repeatedStructureNoProgressCount === 0 &&
    state.structureProgressCount === 0 &&
    !state.clearedReason
  ) {
    return {
      active: false,
      status: state.status,
      clearedReason: state.clearedReason
    };
  }
  return {
    active: state.active,
    status: state.status,
    reason: state.reason,
    escalation: state.escalation,
    forbiddenMove: state.forbiddenMove,
    forbiddenActions: state.forbiddenActions,
    allowedNextMoves: state.allowedNextMoves,
    requiredCorrection: state.requiredCorrection,
    repeatedStructureNoProgressCount: state.repeatedStructureNoProgressCount,
    structureProgressCount: state.structureProgressCount,
    activeIssueCodes: state.activeIssueCodes,
    repeatedHeadingSamples: state.repeatedHeadingSamples,
    repeatedNumberSamples: state.repeatedNumberSamples,
    lastActionName: state.lastActionName,
    lastStructureSnapshot: summarizeStructureSnapshot(state.lastStructureSnapshot),
    openGuardrailBlock: state.openGuardrailBlock,
    activatedAtCycle: state.activatedAtCycle,
    lastUpdatedAtCycle: state.lastUpdatedAtCycle,
    lastNoProgressAtCycle: state.lastNoProgressAtCycle,
    clearedReason: state.clearedReason
  };
}

function createWorkspaceMutationGrowthConvergenceState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  return {
    active,
    status: readString(source.status) || (active ? "active" : "none"),
    reason: readString(source.reason) || null,
    forbiddenMove: readString(source.forbiddenMove) || (active ? "repeat_workspace_write_without_growth" : null),
    forbiddenActions: (readStringArray(source.forbiddenActions).length > 0
      ? readStringArray(source.forbiddenActions)
      : DEFAULT_WORKSPACE_MUTATION_GROWTH_FORBIDDEN_ACTIONS).slice(0, 6),
    allowedNextMoves: (readStringArray(source.allowedNextMoves).length > 0
      ? readStringArray(source.allowedNextMoves)
      : DEFAULT_WORKSPACE_MUTATION_GROWTH_ALLOWED_NEXT_MOVES).slice(0, 8),
    requiredCorrection: readString(source.requiredCorrection) || null,
    stallCount: readNumber$f(source.stallCount),
    escalation: readString(source.escalation) === "hard_veto" ? "hard_veto" : "advisory",
    activatedAtCycle: readNullableNumber$5(source.activatedAtCycle),
    lastUpdatedAtCycle: readNullableNumber$5(source.lastUpdatedAtCycle),
    clearedReason: active ? null : (readString(source.clearedReason) || null)
  };
}

function summarizeWorkspaceMutationGrowthConvergence(value) {
  const state = createWorkspaceMutationGrowthConvergenceState(value);
  if (!state.active && state.stallCount === 0 && !state.clearedReason) {
    return { active: false, status: state.status, clearedReason: state.clearedReason };
  }
  return {
    active: state.active,
    status: state.status,
    reason: state.reason,
    escalation: state.escalation,
    forbiddenMove: state.forbiddenMove,
    forbiddenActions: state.forbiddenActions,
    allowedNextMoves: state.allowedNextMoves,
    requiredCorrection: state.requiredCorrection,
    stallCount: state.stallCount,
    activatedAtCycle: state.activatedAtCycle,
    lastUpdatedAtCycle: state.lastUpdatedAtCycle,
    clearedReason: state.clearedReason
  };
}

function createTerminalCorrectionState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  return {
    status: readString(source.status) || (active ? "active" : "none"),
    active,
    reason: readString(source.reason) || null,
    actionName: readString(source.actionName) || null,
    forbiddenMove: readString(source.forbiddenMove) || null,
    allowedNextMoves: readStringArray(source.allowedNextMoves).slice(0, 8),
    requiredCorrection: readString(source.requiredCorrection) || null,
    firstTriggeredAtCycle: readNullableNumber$5(source.firstTriggeredAtCycle),
    lastTriggeredAtCycle: readNullableNumber$5(source.lastTriggeredAtCycle),
    ignoredTerminalCorrectionCount: readNumber$f(source.ignoredTerminalCorrectionCount),
    lastIgnoredAtCycle: readNullableNumber$5(source.lastIgnoredAtCycle),
    lastSemanticFingerprint: readString(source.lastSemanticFingerprint) || null,
    lastOutcomeHash: readString(source.lastOutcomeHash) || null,
    clearedReason: active ? null : (readString(source.clearedReason) || null)
  };
}

function createTerminalRetryCooldownState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  const forbiddenTerminalActions = readStringArray(source.forbiddenTerminalActions);
  return {
    active,
    status: readString(source.status) || (active ? "active" : "none"),
    reason: readString(source.reason) || null,
    forbiddenTerminalActions: (forbiddenTerminalActions.length > 0
      ? forbiddenTerminalActions
      : DEFAULT_FORBIDDEN_TERMINAL_ACTIONS).slice(0, 8),
    allowedNextMoves: readStringArray(source.allowedNextMoves).slice(0, 8),
    validTerminalException: readString(source.validTerminalException) || DEFAULT_VALID_TERMINAL_EXCEPTION,
    blockedTerminalRetryCount: readNumber$f(source.blockedTerminalRetryCount),
    executedPublishCount: readNumber$f(source.executedPublishCount),
    consecutiveExecutedPublishCount: readNumber$f(source.consecutiveExecutedPublishCount),
    firstActivatedAtCycle: readNullableNumber$5(source.firstActivatedAtCycle),
    lastActivatedAtCycle: readNullableNumber$5(source.lastActivatedAtCycle),
    lastBlockedAtCycle: readNullableNumber$5(source.lastBlockedAtCycle),
    clearedReason: active ? null : (readString(source.clearedReason) || null)
  };
}

function updateTerminalRetryCooldown({
  actionName,
  context,
  previous,
  previousLastActionName,
  progress,
  runState,
  signal,
  terminalCorrectionState
}) {
  const prior = createTerminalRetryCooldownState(previous);
  const cycle = readNullableNumber$5(runState && runState.cycleCount);
  const preflightBlocked = isTerminalCorrectionPreflightBlock(context);
  const terminalCompleted = isTerminalCompleted(actionName, context);
  const executedPublish = isExecutedWorkspacePublish(actionName, context);
  const base = {
    ...prior,
    blockedTerminalRetryCount: prior.blockedTerminalRetryCount + (preflightBlocked ? 1 : 0),
    executedPublishCount: prior.executedPublishCount + (executedPublish ? 1 : 0),
    consecutiveExecutedPublishCount: executedPublish
      ? (readString(previousLastActionName) === PUBLISH_DIRECT_ACTION
        ? prior.consecutiveExecutedPublishCount + 1
        : 1)
      : 0,
    lastBlockedAtCycle: preflightBlocked ? cycle : prior.lastBlockedAtCycle
  };
  if (terminalCompleted) {
    return clearTerminalRetryCooldown(base, "terminal_completed", cycle);
  }
  if (progress && progress.hasProgress) {
    return clearTerminalRetryCooldown(base, "observable_progress", cycle);
  }
  const semanticSignal = signal &&
    signal.patternKind === "semantic_terminal" &&
    signal.status === "repeated_no_progress";
  const correction = createTerminalCorrectionState(terminalCorrectionState);
  const shouldActivate = prior.active || correction.active || semanticSignal || preflightBlocked;
  if (!shouldActivate) {
    return base;
  }
  const signalMoves = signal && Array.isArray(signal.allowedNextMoves) ? signal.allowedNextMoves : [];
  const correctionMoves = correction.allowedNextMoves || [];
  const allowedNextMoves = readStringArray(correctionMoves.length > 0 ? correctionMoves : signalMoves).slice(0, 8);
  return {
    ...base,
    active: true,
    status: "active",
    reason: correction.reason ||
      readString(signal && signal.reason) ||
      "terminal_retry_cooldown_active",
    forbiddenTerminalActions: DEFAULT_FORBIDDEN_TERMINAL_ACTIONS.slice(),
    allowedNextMoves,
    validTerminalException: DEFAULT_VALID_TERMINAL_EXCEPTION,
    firstActivatedAtCycle: prior.firstActivatedAtCycle != null ? prior.firstActivatedAtCycle : cycle,
    lastActivatedAtCycle: cycle,
    clearedReason: null
  };
}

function clearTerminalRetryCooldown(value, reason, cycle) {
  const normalized = createTerminalRetryCooldownState(value);
  return {
    ...normalized,
    active: false,
    status: normalized.active ? "cleared" : normalized.status || "none",
    lastActivatedAtCycle: normalized.active && cycle != null ? cycle : normalized.lastActivatedAtCycle,
    clearedReason: normalized.active ? (reason || "cleared") : normalized.clearedReason
  };
}

function updateReadOnlyPlanningState({
  actionName,
  config = DEFAULT_CONVERGENCE_CONFIG,
  context,
  previous,
  progress,
  runState,
  signal,
  stepsWithoutObservableProgress
}) {
  const prior = createReadOnlyPlanningState(previous);
  const cycle = readNullableNumber$5(runState && runState.cycleCount);
  const terminalCompleted = isTerminalCompleted(actionName, context);
  if (terminalCompleted) {
    return clearReadOnlyPlanningState(prior, "terminal_completed", cycle);
  }
  // Stickiness: a single productive step does not clear an active
  // read-only-planning state, because the live v3 e2e showed AI can game
  // the metric by doing one productive insert per ~2 read-only actions.
  // Require READ_ONLY_PLANNING_CLEAR_THRESHOLD consecutive productive
  // steps before clearing. Outside active mode, productive growth simply
  // resets the steps-without-productive-progress counter (existing
  // behavior below).
  if (progress && progress.hasProductiveProgress) {
    const productiveDims = Array.isArray(progress.productiveDimensions)
      ? progress.productiveDimensions
      : [];
    const hasSourceProgress = productiveDims.includes("source") || productiveDims.includes("evidence");
    // Source progress (successful read_url adding a relevant source) is a
    // strong signal of recovery — clear immediately. Workspace-only
    // progress (e.g. a single workspace_replace after several reads) is
    // weak and can be gamed; require stickiness threshold consecutive
    // workspace-productive steps before clearing.
    if (hasSourceProgress || !prior.active) {
      return clearReadOnlyPlanningState(prior, "productive_progress", cycle);
    }
    const consecutive = readNumber$f(prior.consecutiveProductiveSteps) + 1;
    if (consecutive >= config.readOnlyPlanningClearThreshold) {
      return clearReadOnlyPlanningState(prior, "productive_progress", cycle);
    }
    return {
      ...prior,
      consecutiveProductiveSteps: consecutive,
      stepsWithoutProductiveProgress: 0,
      lastUpdatedAtCycle: cycle,
      lastActionName: readString(actionName) || prior.lastActionName
    };
  }
  const transitionalSignal = signal &&
    signal.patternKind === "transitional_only_progress" &&
    signal.status === "repeated_no_progress";
  const readOnlyExactSignal = signal &&
    signal.patternKind === "exact_action" &&
    signal.status === "repeated_no_progress" &&
    isReadOnlyPlanningAction(signal.actionName, config);
  const readOnlyNoProgressThreshold = isReadOnlyPlanningAction(actionName, config) &&
    readNumber$f(stepsWithoutObservableProgress) >= config.transitionalOnlyThreshold &&
    (!progress || progress.hasProductiveProgress !== true);
  const shouldActivate = prior.active || transitionalSignal || readOnlyExactSignal || readOnlyNoProgressThreshold;
  if (!shouldActivate) {
    return {
      ...prior,
      stepsWithoutProductiveProgress: progress && progress.hasProductiveProgress
        ? 0
        : prior.stepsWithoutProductiveProgress,
      lastUpdatedAtCycle: cycle
    };
  }
  const planningAction = isReadOnlyPlanningAction(actionName, config) || isLengthDeficitChurnAction(runState, actionName);
  const preflightBlocked = isReadOnlyPlanningPreflightBlock(context);
  const ignoredCount = prior.active && planningAction && !preflightBlocked
    ? prior.ignoredCount + 1
    : prior.ignoredCount;
  const signalMoves = signal && Array.isArray(signal.allowedNextMoves) ? signal.allowedNextMoves : [];
  const forbiddenActions = readReadOnlyPlanningForbiddenActions(runState, config);
  const allowedNextMoves = readReadOnlyPlanningAllowedNextMoves(signalMoves, forbiddenActions);
  // Forbidden action while active resets the productive-streak counter:
  // AI cannot escape via 1 productive insert sandwiched in a read loop.
  const nextConsecutiveProductive = planningAction
    ? 0
    : readNumber$f(prior.consecutiveProductiveSteps);
  const computedEscalation = ignoredCount >= config.readOnlyPlanningHardVetoThreshold
    ? "hard_veto"
    : "advisory";
  return {
    active: true,
    status: ignoredCount >= config.repeatThreshold ? "escalated" : "active",
    reason: readString(signal && signal.reason) ||
      prior.reason ||
      (readOnlyNoProgressThreshold
        ? "read_only_planning_sequence_without_productive_progress"
        : "read_only_planning_without_productive_progress"),
    forbiddenMove: "repeat_read_only_planning_without_productive_progress",
    forbiddenActions,
    allowedNextMoves,
    requiredCorrection: readString(signal && signal.requiredCorrection) ||
      "Stop repeating search, planning, skill-tool, or read-only review without productive progress. Use read_url to turn search leads into sources, mutate the workspace meaningfully, sync TodoState with todo_advance/todo_run_next, or publish only a valid limited result with concrete remainingGaps.",
    stepsWithoutProductiveProgress: Math.max(
      prior.stepsWithoutProductiveProgress + (isTrackableAction(actionName, context) ? 1 : 0),
      readNumber$f(signal && signal.stepsWithoutObservableProgress),
      readNumber$f(stepsWithoutObservableProgress)
    ),
    consecutiveProductiveSteps: nextConsecutiveProductive,
    ignoredCount,
    escalation: computedEscalation,
    activatedAtCycle: prior.activatedAtCycle != null ? prior.activatedAtCycle : cycle,
    lastUpdatedAtCycle: cycle,
    lastIgnoredAtCycle: prior.active && planningAction ? cycle : prior.lastIgnoredAtCycle,
    transitionalDimensions: Array.isArray(progress && progress.transitionalDimensions)
      ? progress.transitionalDimensions.slice(0, 8)
      : prior.transitionalDimensions,
    lastActionName: readString(actionName) || prior.lastActionName,
    clearedReason: null
  };
}

function clearReadOnlyPlanningState(value, reason, cycle) {
  const normalized = createReadOnlyPlanningState(value);
  if (!normalized.active && normalized.status !== "active" && normalized.status !== "escalated") {
    return {
      ...normalized,
      active: false,
      status: "none",
      clearedReason: normalized.clearedReason
    };
  }
  return {
    ...normalized,
    active: false,
    status: "cleared",
    stepsWithoutProductiveProgress: 0,
    consecutiveProductiveSteps: 0,
    ignoredCount: 0,
    escalation: "advisory",
    lastUpdatedAtCycle: cycle != null ? cycle : normalized.lastUpdatedAtCycle,
    lastIgnoredAtCycle: null,
    clearedReason: reason || "cleared"
  };
}

function updateStructureRepairConvergence({
  actionName,
  config = DEFAULT_CONVERGENCE_CONFIG,
  context,
  previous,
  runState
}) {
  const prior = createStructureRepairConvergenceState(previous);
  const cycle = readNullableNumber$5(runState && runState.cycleCount);
  const snapshot = readStructureSnapshot(runState);
  const repairAction = isStructureRepairAction(actionName);
  const terminalCompleted = isTerminalCompleted(actionName, context);

  if (terminalCompleted) {
    return clearStructureRepairConvergence(prior, "terminal_completed", cycle, snapshot);
  }

  // AGRUN-303 — guardrail-section axis. Recompute the open guardrail block from
  // the live publish-block (it only appears on the publish-attempt cycle) and
  // otherwise carry forward the persisted block through the edit/read churn
  // cycles. While a block names a section, the heading/number snapshot can read
  // clean (snapshot.ok===true), so the section-content hash — not the
  // heading/number axis — decides whether the repair loop is making progress.
  const liveGuardrailBlock = readLiveStructureGuardrailBlock(context);
  const candidateContent = readFinalCandidateContent(runState);
  const openGuardrailBlock = liveGuardrailBlock
    ? {
        section: liveGuardrailBlock.section,
        issueCodes: liveGuardrailBlock.issueCodes,
        sectionHash: hashStructureSection(candidateContent, liveGuardrailBlock.section)
      }
    : normalizeOpenGuardrailBlock(prior.openGuardrailBlock);

  if (openGuardrailBlock && openGuardrailBlock.section) {
    return updateGuardrailSectionRepair({
      prior,
      cycle,
      actionName,
      config,
      snapshot,
      runState,
      repairAction,
      candidateContent,
      openGuardrailBlock
    });
  }

  if (snapshot.ok === true) {
    return clearStructureRepairConvergence(prior, "structure_resolved", cycle, snapshot);
  }

  if (!snapshot.present || snapshot.ok !== false) {
    return {
      ...prior,
      lastUpdatedAtCycle: cycle
    };
  }

  const previousSnapshot = prior.lastStructureSnapshot;
  const hasPreviousStructure = previousSnapshot && previousSnapshot.present === true;
  // AGRUN-304 — oscillation-resistant progress. isStructureImproved compares
  // against the immediately previous cycle, so a model that partially repairs
  // then re-breaks the outline (duplicate count 5->4->5->4) trips "improved" on
  // every down-cycle and resets the no-progress counter, so it never escalates
  // while it churns. Track the BEST (lowest) structural-defect score seen during
  // this block and count only a NEW best as real progress: monotone progress
  // keeps setting new bests (never penalized), but oscillation/stall does not.
  const defectScore = snapshot.issueCodes.length + snapshot.totalDuplicateCount;
  const priorBest = readNullableScore(prior.bestStructureDefectScore);
  const netImproved = priorBest == null ? true : defectScore < priorBest;
  const bestStructureDefectScore = priorBest == null
    ? defectScore
    : Math.min(priorBest, defectScore);
  const changed = hasPreviousStructure && snapshot.signature !== previousSnapshot.signature;
  const noProgress = hasPreviousStructure && repairAction && !netImproved;
  const repeatedNoProgress = noProgress
    ? prior.repeatedStructureNoProgressCount + 1
    : netImproved
      ? 0
      : prior.repeatedStructureNoProgressCount;
  const progressCount = prior.structureProgressCount + (netImproved || changed ? 1 : 0);
  const shouldActivate = prior.active ||
    repeatedNoProgress >= config.structureRepairNoProgressThreshold ||
    readString(context && context.status) === "structure_repair_preflight_block";

  if (!shouldActivate) {
    return {
      ...prior,
      repeatedStructureNoProgressCount: repeatedNoProgress,
      structureProgressCount: progressCount,
      bestStructureDefectScore,
      lastActionName: readString(actionName) || prior.lastActionName,
      lastStructureSnapshot: snapshot,
      activeIssueCodes: snapshot.issueCodes,
      repeatedHeadingSamples: snapshot.repeatedHeadingSamples,
      repeatedNumberSamples: snapshot.repeatedNumberSamples,
      lastUpdatedAtCycle: cycle,
      lastNoProgressAtCycle: noProgress ? cycle : prior.lastNoProgressAtCycle
    };
  }

  const computedEscalation = repeatedNoProgress >= config.structureRepairHardVetoThreshold
    ? "hard_veto"
    : "advisory";
  return {
    active: true,
    status: repeatedNoProgress >= config.structureRepairNoProgressThreshold ? "needs_targeted_structure_rewrite" : "active",
    reason: "structure_audit_not_improving",
    escalation: computedEscalation,
    forbiddenMove: "repeat_structure_repair_without_audit_delta",
    forbiddenActions: config.structureRepairForbiddenActions.slice(),
    allowedNextMoves: readStructureRepairAllowedNextMoves(runState),
    requiredCorrection: buildStructureRepairRequiredCorrection(snapshot),
    repeatedStructureNoProgressCount: repeatedNoProgress,
    structureProgressCount: progressCount,
    bestStructureDefectScore,
    lastActionName: readString(actionName) || prior.lastActionName,
    lastStructureSnapshot: snapshot,
    activeIssueCodes: snapshot.issueCodes,
    repeatedHeadingSamples: snapshot.repeatedHeadingSamples,
    repeatedNumberSamples: snapshot.repeatedNumberSamples,
    activatedAtCycle: prior.activatedAtCycle != null ? prior.activatedAtCycle : cycle,
    lastUpdatedAtCycle: cycle,
    lastNoProgressAtCycle: noProgress ? cycle : prior.lastNoProgressAtCycle,
    clearedReason: null
  };
}

function clearStructureRepairConvergence(value, reason, cycle, snapshot) {
  const normalized = createStructureRepairConvergenceState(value);
  if (!normalized.active && normalized.status !== "active" && normalized.status !== "needs_targeted_structure_rewrite") {
    return {
      ...normalized,
      active: false,
      status: "none",
      lastStructureSnapshot: normalizeStructureSnapshot(snapshot || normalized.lastStructureSnapshot),
      openGuardrailBlock: null,
      bestStructureDefectScore: null,
      clearedReason: normalized.clearedReason
    };
  }
  return {
    ...normalized,
    active: false,
    status: "cleared",
    escalation: "advisory",
    repeatedStructureNoProgressCount: 0,
    lastStructureSnapshot: normalizeStructureSnapshot(snapshot || normalized.lastStructureSnapshot),
    openGuardrailBlock: null,
    bestStructureDefectScore: null,
    lastUpdatedAtCycle: cycle != null ? cycle : normalized.lastUpdatedAtCycle,
    lastNoProgressAtCycle: null,
    clearedReason: reason || "cleared"
  };
}

// AGRUN-303 — issue codes that describe a repairable structural defect the host
// guardrail can block on. Length/source/citation blocks are intentionally
// excluded so a non-structural guardrail block never forces a structure axis.
function isStructureGuardrailIssueCode(code) {
  const value = readString(code);
  if (!value) return false;
  return value.includes("section_rehash") ||
    value.includes("duplicate_heading") ||
    value.includes("duplicate_number") ||
    value.includes("duplicate_section") ||
    value.includes("non_monotonic_section");
}

// Read the live host output-guardrail block off the action output for THIS
// cycle. Returns the affected section heading + structural issue codes, or null
// when there is no structural guardrail block. Mirrors the read pattern in
// terminal-repair-state.js readOutputGuardrailBlock.
function readLiveStructureGuardrailBlock(context) {
  const output = readRecord(context && context.output);
  if (!output) return null;
  if (readString(output.status) !== "output_guardrail_blocked") return null;
  const block = readRecord(output.outputGuardrailBlock);
  const info = readRecord(block && block.info);
  const issues = Array.isArray(info && info.issues) ? info.issues : [];
  const structureIssues = issues.filter((issue) => isStructureGuardrailIssueCode(issue && issue.code));
  if (structureIssues.length === 0) return null;
  const section = structureIssues
    .map((issue) => readString(issue && issue.section))
    .find(Boolean) || null;
  if (!section) return null;
  const issueCodes = structureIssues
    .map((issue) => readString(issue && issue.code))
    .filter(Boolean)
    .slice(0, 8);
  return { section, issueCodes };
}

// The final candidate markdown is the single source of truth for the blocked
// section's content. finalCandidateStructure is computed from this same content,
// so the snapshot and the hash stay in sync within a cycle.
function readFinalCandidateContent(runState) {
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  if (!workspace) return "";
  const quality = readRecord(workspace.quality) || {};
  const path = readString(quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const files = readRecord(workspace.files) || {};
  const file = readRecord(files[path]);
  return readString(file && file.content);
}

function normalizeHeadingText(value) {
  return readString(value).replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Extract one Markdown section's text by heading: from the matching heading line
// down to the next same-or-higher-level heading. Read-only; authors nothing.
function extractMarkdownSectionText(content, heading) {
  const text = readString(content);
  const target = normalizeHeadingText(heading);
  if (!text || !target) return "";
  const lines = text.split(/\r?\n/);
  const headingPattern = /^(#{1,6})\s+(.*\S)\s*$/;
  let startIndex = -1;
  let startLevel = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = headingPattern.exec(lines[index]);
    if (!match) continue;
    if (normalizeHeadingText(match[2]) === target) {
      startIndex = index;
      startLevel = match[1].length;
      break;
    }
  }
  if (startIndex < 0) return "";
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const match = headingPattern.exec(lines[index]);
    if (match && match[1].length <= startLevel) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join("\n").trim();
}

function hashStructureSection(content, heading) {
  const sectionText = extractMarkdownSectionText(content, heading);
  if (!sectionText) return null;
  return hashCompactFacts({ heading: normalizeHeadingText(heading), text: sectionText });
}

function buildGuardrailSectionRequiredCorrection(openGuardrailBlock) {
  const section = readString(openGuardrailBlock && openGuardrailBlock.section);
  const issueCodes = readStringArray(openGuardrailBlock && openGuardrailBlock.issueCodes);
  const parts = [
    section
      ? `Your last edits did not change the blocked section "${section}"; the host output guardrail still fails on it.`
      : "Your last edits did not change the blocked section; the host output guardrail still fails on it.",
    issueCodes.length > 0 ? `Active guardrail issueCodes=${issueCodes.join(",")}.` : "",
    section
      ? `Read "${section}", then rewrite or replace that whole section with materially different content before the next publish.`
      : "Read the blocked section, then rewrite or replace that whole section with materially different content before the next publish.",
    "Do not keep issuing no-op multi_edit/read on the same unchanged section."
  ].filter(Boolean);
  return parts.join(" ");
}

// AGRUN-303 — guardrail-section no-progress axis. No-progress means a repair
// action ran but the blocked section is byte-identical to the previous cycle. A
// genuine section rewrite (hash change) resets the counter so the runtime never
// punishes real progress, and never authors the replacement itself.
function updateGuardrailSectionRepair({
  prior,
  cycle,
  actionName,
  config = DEFAULT_CONVERGENCE_CONFIG,
  snapshot,
  runState,
  repairAction,
  candidateContent,
  openGuardrailBlock
}) {
  const currentSectionHash = hashStructureSection(candidateContent, openGuardrailBlock.section);
  const priorOpen = normalizeOpenGuardrailBlock(prior.openGuardrailBlock);
  const priorHash = priorOpen ? priorOpen.sectionHash : null;

  // A genuine change to the blocked section (or a renamed/renumbered heading the
  // extractor can no longer resolve) breaks the no-op loop. Clear and require a
  // fresh live output_guardrail_blocked before re-arming, so recovery work on
  // this or any other section is never punished. The next publish re-runs the
  // host guardrail to decide whether the section is truly fixed.
  if (priorHash != null && currentSectionHash !== priorHash) {
    return {
      active: false,
      status: "none",
      reason: null,
      forbiddenMove: null,
      forbiddenActions: [],
      allowedNextMoves: [],
      requiredCorrection: null,
      repeatedStructureNoProgressCount: 0,
      structureProgressCount: readNumber$f(prior.structureProgressCount),
      lastActionName: readString(actionName) || prior.lastActionName,
      lastStructureSnapshot: snapshot,
      activeIssueCodes: [],
      repeatedHeadingSamples: prior.repeatedHeadingSamples,
      repeatedNumberSamples: prior.repeatedNumberSamples,
      escalation: "advisory",
      openGuardrailBlock: null,
      activatedAtCycle: null,
      lastUpdatedAtCycle: cycle,
      lastNoProgressAtCycle: null,
      clearedReason: "structure_section_rewritten"
    };
  }

  const noProgress = repairAction && priorHash != null;
  const repeatedNoProgress = noProgress
    ? readNumber$f(prior.repeatedStructureNoProgressCount) + 1
    : readNumber$f(prior.repeatedStructureNoProgressCount);
  const nextOpenBlock = {
    section: openGuardrailBlock.section,
    issueCodes: readStringArray(openGuardrailBlock.issueCodes).slice(0, 8),
    sectionHash: currentSectionHash
  };
  const activate = repeatedNoProgress >= config.structureRepairNoProgressThreshold;
  if (!activate) {
    // Below the no-progress threshold: keep tracking the open block, but do not
    // constrain the action surface yet.
    return {
      active: false,
      status: "none",
      reason: null,
      forbiddenMove: null,
      forbiddenActions: [],
      allowedNextMoves: [],
      requiredCorrection: null,
      repeatedStructureNoProgressCount: repeatedNoProgress,
      structureProgressCount: readNumber$f(prior.structureProgressCount),
      lastActionName: readString(actionName) || prior.lastActionName,
      lastStructureSnapshot: snapshot,
      activeIssueCodes: nextOpenBlock.issueCodes,
      repeatedHeadingSamples: prior.repeatedHeadingSamples,
      repeatedNumberSamples: prior.repeatedNumberSamples,
      escalation: "advisory",
      openGuardrailBlock: nextOpenBlock,
      activatedAtCycle: prior.activatedAtCycle,
      lastUpdatedAtCycle: cycle,
      lastNoProgressAtCycle: noProgress ? cycle : prior.lastNoProgressAtCycle,
      clearedReason: prior.clearedReason
    };
  }
  const escalation = repeatedNoProgress >= config.structureRepairHardVetoThreshold
    ? "hard_veto"
    : "advisory";
  return {
    active: true,
    status: "needs_targeted_structure_rewrite",
    reason: "output_guardrail_section_not_changing",
    escalation,
    forbiddenMove: "repeat_section_edit_without_section_delta",
    forbiddenActions: config.structureRepairForbiddenActions.slice(),
    allowedNextMoves: readStructureRepairAllowedNextMoves(runState),
    requiredCorrection: buildGuardrailSectionRequiredCorrection(nextOpenBlock),
    repeatedStructureNoProgressCount: repeatedNoProgress,
    structureProgressCount: readNumber$f(prior.structureProgressCount),
    lastActionName: readString(actionName) || prior.lastActionName,
    lastStructureSnapshot: snapshot,
    activeIssueCodes: nextOpenBlock.issueCodes,
    repeatedHeadingSamples: prior.repeatedHeadingSamples,
    repeatedNumberSamples: prior.repeatedNumberSamples,
    openGuardrailBlock: nextOpenBlock,
    activatedAtCycle: prior.activatedAtCycle != null ? prior.activatedAtCycle : cycle,
    lastUpdatedAtCycle: cycle,
    lastNoProgressAtCycle: noProgress ? cycle : prior.lastNoProgressAtCycle,
    clearedReason: null
  };
}

function updateWorkspaceMutationGrowthConvergence({
  actionName,
  config = DEFAULT_CONVERGENCE_CONFIG,
  context,
  progress,
  previous,
  runState
}) {
  const prior = createWorkspaceMutationGrowthConvergenceState(previous);
  const cycle = readNullableNumber$5(runState && runState.cycleCount);
  const name = readString(actionName);

  if (isTerminalCompleted(actionName, context)) {
    return {
      ...prior,
      active: false,
      status: "cleared",
      escalation: "advisory",
      stallCount: 0,
      clearedReason: "terminal_completed",
      lastUpdatedAtCycle: cycle
    };
  }

  const isMutationAction = [
    WORKSPACE_WRITE_ACTION,
    WORKSPACE_REPLACE_ACTION,
    WORKSPACE_MULTI_EDIT_ACTION,
    WORKSPACE_INSERT_AFTER_SECTION_ACTION
  ].includes(name);

  if (!isMutationAction) {
    return { ...prior, lastUpdatedAtCycle: cycle };
  }

  // Track full-document, targeted replace, and aggregate rewrite stalls. Insertions have separate
  // length-growth semantics and should not clear or increment this rewrite
  // stall counter; live traces showed write→multi_edit shrink/no-growth loops
  // and replace/read churn can otherwise continue after write/multi_edit have
  // been hard-vetoed.
  if (name !== WORKSPACE_WRITE_ACTION && name !== WORKSPACE_MULTI_EDIT_ACTION && name !== WORKSPACE_REPLACE_ACTION) {
    return { ...prior, lastUpdatedAtCycle: cycle };
  }

  const lengthStatus = readRequestedLengthStatus(runState);
  const hasDeficit = lengthStatus != null
    && readNumber$f(lengthStatus.observed) < readNumber$f(lengthStatus.requested);
  const status = readString(context && context.output && context.output.status);
  const blockedNoProgressMutation = status === "destructive_shrink_blocked";
  const candidateRegression = progress &&
    progress.hasRegressiveProgress === true &&
    Array.isArray(progress.regressiveDimensions) &&
    progress.regressiveDimensions.includes("candidate");

  if (!hasDeficit && !blockedNoProgressMutation && !candidateRegression) {
    if (!prior.active && prior.stallCount === 0) return { ...prior, lastUpdatedAtCycle: cycle };
    return {
      ...prior,
      active: false,
      status: "cleared",
      escalation: "advisory",
      stallCount: 0,
      clearedReason: "length_target_met",
      lastUpdatedAtCycle: cycle
    };
  }

  const reportedDeltaWords = readSignedNumber(
    context &&
    context.output &&
    context.output.mutationStats &&
    context.output.mutationStats.delta &&
      context.output.mutationStats.delta.words
  );
  const candidateDeltaWords = readSignedNumber(progress && progress.candidateDelta && progress.candidateDelta.words);
  const regressionDeltaWords = candidateRegression && candidateDeltaWords < 0
    ? candidateDeltaWords
    : null;

  const minimumEffectiveGrowth = computeMinimumEffectiveWorkspaceGrowth(config);
  const deltaWords = blockedNoProgressMutation
    ? Math.min(reportedDeltaWords, -minimumEffectiveGrowth)
    : regressionDeltaWords != null
      ? regressionDeltaWords
    : reportedDeltaWords;
  const isStall = candidateRegression || deltaWords < minimumEffectiveGrowth;

  if (!isStall) {
    // The tracked mutation itself grew positively — genuine recovery, clear the stall counter.
    if (!prior.active && prior.stallCount === 0) return { ...prior, lastUpdatedAtCycle: cycle };
    return {
      ...prior,
      active: false,
      status: "none",
      stallCount: 0,
      escalation: "advisory",
      clearedReason: prior.active ? "growth_detected" : null,
      lastUpdatedAtCycle: cycle
    };
  }

  const newStallCount = prior.stallCount + 1;
  // Destructive overwrites (negative delta) activate advisory immediately on the first occurrence
  // so the model sees the correction message without waiting for the two-stall threshold.
  const isDestructiveOverwrite = deltaWords < 0;
  const shouldActivate = prior.active || isDestructiveOverwrite || newStallCount >= config.workspaceMutationGrowthAdvisoryThreshold;

  if (!shouldActivate) {
    return { ...prior, stallCount: newStallCount, lastUpdatedAtCycle: cycle };
  }

  const escalation = newStallCount >= config.workspaceMutationGrowthHardVetoThreshold
    ? "hard_veto"
    : "advisory";
  return {
    active: true,
    status: candidateRegression ? "candidate_regression" : "stalling_without_growth",
    reason: candidateRegression ? "candidate_text_regressed" : "workspace_write_not_accumulating",
    escalation,
    forbiddenMove: candidateRegression ? "repeat_workspace_mutation_after_candidate_regression" : "repeat_workspace_mutation_without_growth",
    forbiddenActions: config.workspaceMutationGrowthForbiddenActions.slice(),
    allowedNextMoves: DEFAULT_WORKSPACE_MUTATION_GROWTH_ALLOWED_NEXT_MOVES.slice(),
    requiredCorrection: candidateRegression
      ? `${name || "workspace mutation"} reduced the selected candidate instead of preserving accumulated work (delta=${deltaWords} words). Stop broad rewrites; use workspace_insert_after_section for additive repair, review the latest candidate, or publish limited with explicit remainingGaps when recovery is exhausted.`
      : `${name || "workspace mutation"} is overwriting or under-growing content instead of accumulating (delta=${deltaWords} words). Use workspace_insert_after_section to add content under an existing section, use workspace_review_candidate after a fresh read, or publish limited only when the draft covers the planned sections and remaining gaps are explicit.`,
    stallCount: newStallCount,
    activatedAtCycle: prior.activatedAtCycle != null ? prior.activatedAtCycle : cycle,
    lastUpdatedAtCycle: cycle,
    clearedReason: null
  };
}

function computeMinimumEffectiveWorkspaceGrowth(config = DEFAULT_CONVERGENCE_CONFIG) {
  // AGRUN-244 Phase 3 — the stall floor is a fixed anti-noop / anti-shrink
  // threshold, NOT derived from the word-count target. A workspace_write that
  // adds genuine positive content is never a "stall" merely because it is
  // small relative to a requested length; only a write that adds ~nothing or
  // shrinks the draft counts as a stall.
  return config.workspaceMutationGrowthStallFloor;
}

function updateTerminalCorrectionState({
  actionName,
  config = DEFAULT_CONVERGENCE_CONFIG,
  context,
  outcomeHash,
  previous,
  progress,
  runState,
  semanticFingerprint,
  signal
}) {
  const prior = createTerminalCorrectionState(previous);
  const cycle = readNullableNumber$5(runState && runState.cycleCount);
  if (isTerminalCompleted(actionName, context)) {
    return clearTerminalCorrectionState(prior, "terminal_completed", cycle);
  }
  if (progress && progress.hasProgress) {
    return clearTerminalCorrectionState(prior, "observable_progress", cycle);
  }
  const isTerminal = isSemanticTerminalAction(actionName, context);
  const semanticSignal = signal &&
    signal.patternKind === "semantic_terminal" &&
    signal.status === "repeated_no_progress";
  if (prior.active && isTerminal && isTerminalCorrectionPreflightBlock(context)) {
    return {
      ...prior,
      status: prior.ignoredTerminalCorrectionCount >= config.repeatThreshold ? "escalated" : "active",
      actionName: readString(actionName) || prior.actionName,
      lastTriggeredAtCycle: prior.lastTriggeredAtCycle != null ? prior.lastTriggeredAtCycle : cycle,
      lastSemanticFingerprint: readString(semanticFingerprint) || prior.lastSemanticFingerprint,
      lastOutcomeHash: readString(outcomeHash) || prior.lastOutcomeHash,
      clearedReason: null
    };
  }
  if (semanticSignal) {
    const wasActive = prior.active === true;
    const ignoredCount = wasActive && isTerminal
      ? prior.ignoredTerminalCorrectionCount + 1
      : prior.ignoredTerminalCorrectionCount;
    return {
      status: ignoredCount >= config.repeatThreshold ? "escalated" : "active",
      active: true,
      reason: readString(signal.reason) || "same_terminal_intent_without_observable_progress",
      actionName: readString(signal.actionName) || readString(actionName) || prior.actionName,
      forbiddenMove: readString(signal.forbiddenMove) || "repeat_same_terminal_intent",
      allowedNextMoves: readStringArray(signal.allowedNextMoves).slice(0, 8),
      requiredCorrection: readString(signal.requiredCorrection) ||
        "Do not repeat the same publish/finalize terminal intent until observable progress changes, or publish a valid limited result with concrete remainingGaps.",
      firstTriggeredAtCycle: prior.firstTriggeredAtCycle != null ? prior.firstTriggeredAtCycle : cycle,
      lastTriggeredAtCycle: cycle,
      ignoredTerminalCorrectionCount: ignoredCount,
      lastIgnoredAtCycle: wasActive && isTerminal ? cycle : prior.lastIgnoredAtCycle,
      lastSemanticFingerprint: readString(signal.semanticFingerprint) || readString(semanticFingerprint) || prior.lastSemanticFingerprint,
      lastOutcomeHash: readString(signal.outcomeHash) || readString(outcomeHash) || prior.lastOutcomeHash,
      clearedReason: null
    };
  }
  if (prior.active && isTerminal) {
    const ignoredCount = prior.ignoredTerminalCorrectionCount + 1;
    return {
      ...prior,
      status: ignoredCount >= config.repeatThreshold ? "escalated" : "active",
      actionName: readString(actionName) || prior.actionName,
      ignoredTerminalCorrectionCount: ignoredCount,
      lastIgnoredAtCycle: cycle,
      lastTriggeredAtCycle: prior.lastTriggeredAtCycle != null ? prior.lastTriggeredAtCycle : cycle,
      lastSemanticFingerprint: readString(semanticFingerprint) || prior.lastSemanticFingerprint,
      lastOutcomeHash: readString(outcomeHash) || prior.lastOutcomeHash,
      clearedReason: null
    };
  }
  return prior;
}

function isTerminalCorrectionPreflightBlock(context) {
  const output = readRecord(context && context.output);
  return readString(output.kind) === "terminal_correction_preflight_block";
}

function isReadOnlyPlanningPreflightBlock(context) {
  const output = readRecord(context && context.output);
  return readString(output.kind) === "read_only_planning_preflight_block";
}

function isExecutedWorkspacePublish(actionName, context) {
  if (readString(actionName) !== PUBLISH_DIRECT_ACTION) return false;
  return !isTerminalCorrectionPreflightBlock(context);
}

function clearTerminalCorrectionState(prior, reason, cycle) {
  const normalized = createTerminalCorrectionState(prior);
  if (!normalized.active && normalized.status !== "active") {
    return {
      ...normalized,
      status: "none",
      active: false,
      clearedReason: normalized.clearedReason
    };
  }
  return {
    ...normalized,
    status: "cleared",
    active: false,
    lastTriggeredAtCycle: cycle != null ? cycle : normalized.lastTriggeredAtCycle,
    ignoredTerminalCorrectionCount: 0,
    lastIgnoredAtCycle: null,
    clearedReason: reason || "cleared"
  };
}

function buildLatestCorrectionSignal(terminalCorrectionState, signal, config = DEFAULT_CONVERGENCE_CONFIG) {
  const terminal = createTerminalCorrectionState(terminalCorrectionState);
  if (terminal.active) {
    const escalated = terminal.ignoredTerminalCorrectionCount >= config.repeatThreshold;
    return {
      kind: "terminal_correction_signal",
      status: escalated ? "escalated" : "active",
      patternKind: "semantic_terminal",
      reason: terminal.reason,
      actionName: terminal.actionName,
      forbiddenMove: terminal.forbiddenMove,
      allowedNextMoves: terminal.allowedNextMoves,
      requiredCorrection: escalated
        ? "Terminal correction has already been ignored twice. Do not attempt clean ready or another publish/finalize retry. Perform evidence/workspace/TodoState recovery first, or publish only a valid limited result with concrete remainingGaps and false flags for failed dimensions."
        : terminal.requiredCorrection,
      ignoredTerminalCorrectionCount: terminal.ignoredTerminalCorrectionCount,
      firstTriggeredAtCycle: terminal.firstTriggeredAtCycle,
      lastTriggeredAtCycle: terminal.lastTriggeredAtCycle,
      lastIgnoredAtCycle: terminal.lastIgnoredAtCycle,
      semanticFingerprint: terminal.lastSemanticFingerprint,
      outcomeHash: terminal.lastOutcomeHash
    };
  }
  return signal ? cloneValue(signal) : null;
}

function isTerminalCompleted(actionName, context) {
  if (!isSemanticTerminalAction(actionName, context)) return false;
  const output = readRecord(context && context.output);
  const kind = readString(output.kind);
  if (kind === "final_response") return true;
  if (readString(output.control) === "complete") return true;
  if (readString(context && context.status) === "complete") return true;
  return false;
}

function buildConvergenceSignal({
  actionName,
  config = DEFAULT_CONVERGENCE_CONFIG,
  context,
  effectiveHasProgress,
  errorRepeatCount,
  fingerprint,
  longFormMode,
  outcomeHash,
  progress,
  productiveOnlyMode,
  repeatedFingerprintCount,
  repeatedSemanticFingerprintCount,
  runState,
  semanticFingerprint,
  stepsWithoutObservableProgress
}) {
  if (!isTrackableAction(actionName, context)) return null;
  const requiredCorrection = readRequiredCorrection(runState);
  // ADR-0013 — `repeated_action_throw` fires when the SAME action+args
  // has thrown >= DEFAULT_REPEAT_THRESHOLD times in a row. Highest
  // priority signal because by definition it indicates the AI is stuck
  // on a broken arg shape; productive progress is impossible until the
  // AI changes args / action. This branch runs before
  // `effectiveHasProgress` short-circuit because the harness must
  // surface the signal even if some other action produced progress
  // between throws (the *same* arg shape still won't work next time).
  if (
    isActionErrorRefresh(context) &&
    fingerprint &&
    readNumber$f(errorRepeatCount) >= config.repeatThreshold
  ) {
    const allowedNextMoves = readAllowedNextMoves$1(runState, {
      longFormMode: longFormMode === true
    });
    return {
      kind: "action_pattern_convergence_signal",
      status: "repeated_no_progress",
      patternKind: "repeated_action_throw",
      reason: "same_action_args_thrown_repeatedly",
      actionName: actionName || null,
      fingerprint,
      errorRepeatCount: readNumber$f(errorRepeatCount),
      stepsWithoutObservableProgress,
      forbiddenMove: "repeat_same_action_args_after_throw",
      allowedNextMoves,
      requiredCorrection: `Action "${actionName}" has thrown with the same arguments ${readNumber$f(errorRepeatCount)} times. Read the latest workspace state, choose different arguments, pick a different action, or publish workspace_publish_candidate with decision=limited and concrete remainingGaps explaining the blocker.`,
      updatedAtCycle: readNullableNumber$5(runState && runState.cycleCount)
    };
  }
  if (effectiveHasProgress) return null;
  if (
    productiveOnlyMode === true &&
    progress &&
    progress.hasProductiveProgress === false &&
    progress.hasTransitionalOnlyProgress === true &&
    stepsWithoutObservableProgress >= config.transitionalOnlyThreshold
  ) {
    const allowedNextMoves = readAllowedNextMoves$1(runState, { longFormMode: true });
    return {
      kind: "action_pattern_convergence_signal",
      status: "repeated_no_progress",
      patternKind: "transitional_only_progress",
      reason: "transitional_only_progress_without_workspace_or_source_growth",
      actionName: actionName || null,
      fingerprint: fingerprint || null,
      stepsWithoutObservableProgress,
      transitionalDimensions: Array.isArray(progress.transitionalDimensions) ? progress.transitionalDimensions.slice(0, 6) : [],
      forbiddenMove: "another_search_or_plan_without_workspace_or_read_url",
      allowedNextMoves,
      requiredCorrection: "Search and planning are means, not deliverables. Capture evidence with read_url, then grow the candidate via workspace_write/workspace_insert_after_section/workspace_replace before any further web_search or todo_plan.",
      updatedAtCycle: readNullableNumber$5(runState && runState.cycleCount)
    };
  }
  if (semanticFingerprint && outcomeHash && repeatedSemanticFingerprintCount >= config.repeatThreshold) {
    const allowedNextMoves = readAllowedNextMoves$1(runState, { terminalMode: true });
    return {
      kind: "action_pattern_convergence_signal",
      status: "repeated_no_progress",
      patternKind: "semantic_terminal",
      reason: "same_terminal_intent_without_observable_progress",
      actionName: actionName || null,
      fingerprint: fingerprint || null,
      outcomeHash,
      semanticFingerprint,
      repeatCount: repeatedFingerprintCount,
      semanticRepeatCount: repeatedSemanticFingerprintCount,
      stepsWithoutObservableProgress,
      forbiddenMove: "repeat_same_terminal_intent",
      allowedNextMoves,
      requiredCorrection,
      updatedAtCycle: readNullableNumber$5(runState && runState.cycleCount)
    };
  }
  if (semanticFingerprint) return null;
  if (!fingerprint) return null;
  if (repeatedFingerprintCount < config.repeatThreshold) return null;
  const allowedNextMoves = readAllowedNextMoves$1(runState);
  return {
    kind: "action_pattern_convergence_signal",
    status: "repeated_no_progress",
    patternKind: "exact_action",
    reason: "same_action_fingerprint_without_observable_progress",
    actionName: actionName || null,
    fingerprint,
    repeatCount: repeatedFingerprintCount,
    stepsWithoutObservableProgress,
    forbiddenMove: "repeat_same_action_args",
    allowedNextMoves,
    requiredCorrection: "Do not repeat the same action+args until observable progress changes.",
    updatedAtCycle: readNullableNumber$5(runState && runState.cycleCount)
  };
}

function isStructuredReadOnlyPlanningLoop(runState, actionName, config = DEFAULT_CONVERGENCE_CONFIG) {
  if (!isReadOnlyPlanningAction(actionName, config) && !isLengthDeficitChurnAction(runState, actionName)) return false;
  return hasUnfinishedTodoState(runState) || hasWorkspaceArtifacts(runState);
}

function isLengthDeficitChurnAction(runState, actionName) {
  const name = readString(actionName);
  return LENGTH_DEFICIT_CHURN_ACTIONS.includes(name) && hasRequestedLengthDeficit(runState);
}

function hasRequestedLengthDeficit(runState) {
  const requested = readRequestedLengthStatus(runState);
  return requested && requested.requested > 0 && requested.observed > 0 && requested.observed < requested.requested;
}

function readAllowedNextMoves$1(runState, options = {}) {
  const terminalMode = options && options.terminalMode === true;
  const longFormMode = options && options.longFormMode === true;
  const moves = [];
  if (longFormMode) {
    moves.push("read_url", "workspace_write", "workspace_replace");
  }
  if (hasUnfinishedTodoState(runState)) {
    moves.push("todo_advance", "todo_run_next", "todo_cancel");
  }
  const readUrlSignal = runState && runState.readUrlRecoverySignal && typeof runState.readUrlRecoverySignal === "object"
    ? runState.readUrlRecoverySignal
    : null;
  if (readUrlSignal && Array.isArray(readUrlSignal.allowedNextMoves) && readUrlSignal.allowedNextMoves.length > 0) {
    moves.push(...readUrlSignal.allowedNextMoves);
  }
  const recovery = runState && runState.requirementRecoveryEvaluator && typeof runState.requirementRecoveryEvaluator === "object"
    ? runState.requirementRecoveryEvaluator
    : null;
  if (recovery && Array.isArray(recovery.recoverableDeficits)) {
    for (const deficit of recovery.recoverableDeficits) {
      if (deficit && Array.isArray(deficit.allowedNextMoves)) {
        moves.push(...deficit.allowedNextMoves);
      }
    }
  }
  if (!terminalMode) {
    moves.push("change_arguments", "choose_different_action");
  }
  moves.push("valid_limited_with_remainingGaps");
  return Array.from(new Set(moves.map(readString).filter(Boolean))).slice(0, 8);
}

function readReadOnlyPlanningForbiddenActions(runState, config = DEFAULT_CONVERGENCE_CONFIG) {
  const actions = new Set(config.readOnlyPlanningForbiddenActions);
  if (hasRequestedLengthDeficit(runState)) {
    for (const action of LENGTH_DEFICIT_CHURN_ACTIONS) {
      actions.add(action);
    }
  }
  return Array.from(actions).slice(0, 12);
}

function readReadOnlyPlanningAllowedNextMoves(signalMoves, forbiddenActions) {
  const forbidden = new Set(Array.isArray(forbiddenActions)
    ? forbiddenActions
    : DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS);
  const moves = [
    ...DEFAULT_READ_ONLY_PLANNING_ALLOWED_NEXT_MOVES,
    ...(Array.isArray(signalMoves) ? signalMoves : [])
  ].filter((move) => {
    const value = readString(move);
    return value && !forbidden.has(value);
  });
  return Array.from(new Set(moves)).slice(0, 12);
}

function readRequiredCorrection(runState) {
  if (hasUnfinishedTodoState(runState)) {
    return "Do not repeat publish/finalize while TodoState has active or pending work. First use todo_advance, todo_run_next, or todo_cancel to make the visible plan match completed/obsolete work; then retry terminal publish with valid readiness.";
  }
  return "Do not repeat the same publish/finalize terminal intent until observable source/workspace progress changes, or publish a valid limited result with concrete remainingGaps.";
}

function createOutcomeHash(runState, context, actionName) {
  const output = readRecord(context && context.output);
  const candidate = readOutputCandidateSnapshot(output) || readCandidateSnapshot(runState);
  const facts = {
    actionName: readString(actionName) || null,
    candidate: summarizeCandidateForHash(candidate),
    control: readString(output.control) || null,
    issueCodes: readReadinessIssueCodes(context, output),
    kind: readString(output.kind) || null,
    publishBlockStatus: readPublishBlockStatus(runState, output),
    status: readString(output.status) || readString(context && context.status) || null
  };
  return hashCompactFacts(facts);
}

function createSemanticTerminalFingerprint(runState, context, actionName) {
  if (!isSemanticTerminalAction(actionName, context)) return null;
  const output = readRecord(context && context.output);
  const candidate = readOutputCandidateSnapshot(output) || readCandidateSnapshot(runState);
  const sourceMinimum = readSourceMinimum(runState);
  const deficits = readObservableDeficits$1(runState, candidate, sourceMinimum);
  const facts = {
    blockStatus: readPublishBlockStatus(runState, output),
    candidate: summarizeCandidateForHash(candidate),
    issueCodes: readReadinessIssueCodes(context, output),
    sourceMinimum: sourceMinimum ? {
      minReadSources: readNumber$f(sourceMinimum.minReadSources),
      minRelevantSources: readNumber$f(sourceMinimum.minRelevantSources),
      passed: sourceMinimum.passed === true,
      readSources: readNumber$f(sourceMinimum.readSources),
      relevantSources: readNumber$f(sourceMinimum.relevantSources)
    } : null,
    terminalAction: normalizeTerminalActionName(actionName, context),
    deficits
  };
  return hashCompactFacts(facts);
}

function hashCompactFacts(value) {
  return djb2Hash(stableStringify(value));
}

function isSemanticTerminalAction(actionName, context) {
  const name = readString(actionName);
  if (name === PUBLISH_DIRECT_ACTION) return true;
  if (name === "finalize" || name === "final" || name === "planner_finalize" || name === "planner_final") return true;
  const source = readString(context && context.sourceLabel);
  return source === "planner_finalize" || source === "planner_final" || source === "planner_finalizer" || source === "plan_synthesize";
}

function normalizeTerminalActionName(actionName, context) {
  const name = readString(actionName);
  if (name === PUBLISH_DIRECT_ACTION) return PUBLISH_DIRECT_ACTION;
  const source = readString(context && context.sourceLabel);
  if (source) return source === "planner_final" ? "planner_finalize" : source;
  return name === "final" ? "planner_finalize" : (name || "finalize");
}

function readOutputCandidateSnapshot(output) {
  if (!output || typeof output !== "object") return null;
  const workspaceCandidate = readRecord(output.workspaceCandidate);
  const workspaceStats = readRecord(workspaceCandidate && workspaceCandidate.textStats);
  if (workspaceStats) {
    return {
      chars: readNumber$f(workspaceStats.chars),
      cjkChars: readNumber$f(workspaceStats.cjkChars),
      path: readString(workspaceCandidate.path) || null,
      words: readNumber$f(workspaceStats.words),
      version: readNullableNumber$5(workspaceCandidate.version)
    };
  }
  const textStats = readRecord(output.textStats);
  if (textStats) {
    return {
      chars: readNumber$f(textStats.chars),
      cjkChars: readNumber$f(textStats.cjkChars),
      path: readString(output.path) || null,
      words: readNumber$f(textStats.words),
      version: null
    };
  }
  const candidate = readRecord(output.candidate);
  const candidateStats = readRecord(candidate && candidate.stats);
  if (candidateStats) {
    return {
      chars: readNumber$f(candidateStats.chars),
      cjkChars: readNumber$f(candidateStats.cjkChars),
      path: readString(candidate.path) || null,
      words: readNumber$f(candidateStats.words),
      version: readNullableNumber$5(candidate.version)
    };
  }
  return null;
}

function summarizeCandidateForHash(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  return {
    chars: readNumber$f(candidate.chars),
    cjkChars: readNumber$f(candidate.cjkChars),
    path: readString(candidate.path) || null,
    words: readNumber$f(candidate.words)
  };
}

function readPublishBlockStatus(runState, output) {
  const outputSignal = output && readRecord(output.publishBlockSignal);
  const runSignal = runState && readRecord(runState.publishBlockSignal);
  return readString(output && output.status) ||
    readString(outputSignal && outputSignal.lastStatus) ||
    readString(runSignal && runSignal.lastStatus) ||
    null;
}

function readReadinessIssueCodes(context, output) {
  const codes = [];
  const candidates = [
    context && context.conflictIssues,
    output && output.readinessAudit && output.readinessAudit.issues,
    output && output.signal && output.signal.issues,
    output && output.contract && output.contract.finalReadinessAssessment && output.contract.finalReadinessAssessment.issues
  ];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const issue of list) {
      const code = readString(issue) || readString(issue && (issue.code || issue.status || issue.reason));
      if (code) codes.push(code);
    }
  }
  return Array.from(new Set(codes)).sort().slice(0, 10);
}

function readObservableDeficits$1(runState, candidate, sourceMinimum) {
  const recovery = runState && runState.requirementRecoveryEvaluator && typeof runState.requirementRecoveryEvaluator === "object"
    ? runState.requirementRecoveryEvaluator
    : null;
  if (recovery && recovery.lastObservableDeficits && typeof recovery.lastObservableDeficits === "object") {
    return {
      lengthDeficit: readNumber$f(recovery.lastObservableDeficits.lengthDeficit),
      readSourceDeficit: readNumber$f(recovery.lastObservableDeficits.readSourceDeficit),
      relevantSourceDeficit: readNumber$f(recovery.lastObservableDeficits.relevantSourceDeficit)
    };
  }
  const requested = readRequestedLengthSnapshot$1(runState);
  const observed = candidate && requested ? readNumber$f(candidate[requested.statsKey]) : 0;
  return {
    lengthDeficit: requested ? Math.max(0, readNumber$f(requested.value) - observed) : 0,
    readSourceDeficit: sourceMinimum ? Math.max(0, readNumber$f(sourceMinimum.minReadSources) - readNumber$f(sourceMinimum.readSources)) : 0,
    relevantSourceDeficit: sourceMinimum ? Math.max(0, readNumber$f(sourceMinimum.minRelevantSources) - readNumber$f(sourceMinimum.relevantSources)) : 0
  };
}

function readRequestedLengthSnapshot$1(runState) {
  const packet = readAcceptancePacket(runState);
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  if (!requested) return null;
  const unit = readString(requested.unit) || "chars";
  return {
    statsKey: readString(requested.statsKey) || (unit === "words" ? "words" : unit === "cjkChars" ? "cjkChars" : "chars"),
    unit,
    value: readNumber$f(requested.value)
  };
}

function normalizeActionPatternConvergenceState(value, config = DEFAULT_CONVERGENCE_CONFIG) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const terminalCorrectionState = createTerminalCorrectionState(source.terminalCorrectionState);
  return {
    kind: "action_pattern_convergence",
    status: readStatus$1(source.status),
    lastFingerprint: readString(source.lastFingerprint) || null,
    lastOutcomeHash: readString(source.lastOutcomeHash) || null,
    lastSemanticFingerprint: readString(source.lastSemanticFingerprint) || null,
    lastActionName: readString(source.lastActionName) || null,
    repeatedFingerprintCount: readNumber$f(source.repeatedFingerprintCount),
    repeatedSemanticFingerprintCount: readNumber$f(source.repeatedSemanticFingerprintCount),
    errorRepeatCount: readNumber$f(source.errorRepeatCount),
    stepsWithoutObservableProgress: readNumber$f(source.stepsWithoutObservableProgress),
    progressSnapshot: normalizeProgressSnapshot(source.progressSnapshot),
    recentPatterns: Array.isArray(source.recentPatterns)
      ? source.recentPatterns.filter((entry) => entry && typeof entry === "object").slice(-config.maxRecentPatterns)
      : [],
    recentToolFingerprints: Array.isArray(source.recentToolFingerprints)
      ? source.recentToolFingerprints.filter((entry) => typeof entry === "string" && entry).slice(-config.toolResultDedupWindow)
      : [],
    convergenceSignal: source.convergenceSignal && typeof source.convergenceSignal === "object"
      ? cloneValue(source.convergenceSignal)
      : null,
    readOnlyPlanningState: createReadOnlyPlanningState(source.readOnlyPlanningState),
    structureRepairConvergence: createStructureRepairConvergenceState(source.structureRepairConvergence),
    workspaceMutationGrowthConvergence: createWorkspaceMutationGrowthConvergenceState(source.workspaceMutationGrowthConvergence),
    terminalCorrectionState,
    ignoredTerminalCorrectionCount: terminalCorrectionState.active
      ? terminalCorrectionState.ignoredTerminalCorrectionCount
      : 0,
    latestCorrectionSignal: source.latestCorrectionSignal && typeof source.latestCorrectionSignal === "object"
      ? cloneValue(source.latestCorrectionSignal)
      : null,
    terminalRetryCooldown: createTerminalRetryCooldownState(source.terminalRetryCooldown),
    updatedAtCycle: readNullableNumber$5(source.updatedAtCycle),
    version: 1
  };
}

function summarizeTerminalRetryCooldown(value) {
  const cooldown = createTerminalRetryCooldownState(value);
  return {
    active: cooldown.active,
    status: cooldown.status,
    reason: cooldown.reason,
    forbiddenTerminalActions: cooldown.forbiddenTerminalActions,
    allowedNextMoves: cooldown.allowedNextMoves,
    validTerminalException: cooldown.validTerminalException,
    blockedTerminalRetryCount: cooldown.blockedTerminalRetryCount,
    executedPublishCount: cooldown.executedPublishCount,
    consecutiveExecutedPublishCount: cooldown.consecutiveExecutedPublishCount,
    firstActivatedAtCycle: cooldown.firstActivatedAtCycle,
    lastActivatedAtCycle: cooldown.lastActivatedAtCycle,
    lastBlockedAtCycle: cooldown.lastBlockedAtCycle,
    clearedReason: cooldown.clearedReason
  };
}

function appendRecentPattern(patterns, entry, config = DEFAULT_CONVERGENCE_CONFIG) {
  const next = Array.isArray(patterns) ? patterns.slice(-config.maxRecentPatterns + 1) : [];
  next.push(entry);
  return next;
}

function readStructureSnapshot(runState) {
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const quality = workspace && workspace.quality && typeof workspace.quality === "object" ? workspace.quality : {};
  const structure = quality.finalCandidateStructure && typeof quality.finalCandidateStructure === "object"
    ? quality.finalCandidateStructure
    : null;
  if (!structure) return normalizeStructureSnapshot(null);
  const issueCodes = readStringArray(structure.issueCodes).sort().slice(0, 8);
  const repeatedHeadingSamples = normalizeStructureSamples(structure.repeatedHeadingSamples, "heading");
  const repeatedNumberSamples = normalizeStructureSamples(structure.repeatedNumberSamples, "number");
  const semanticDuplicateHeadingContexts = normalizeSemanticDuplicateHeadingContexts(structure.semanticDuplicateHeadingContexts);
  const bodyAfterFinalSectionContexts = normalizeBodyAfterFinalSectionContexts(structure.bodyAfterFinalSectionContexts);
  const duplicateHeadingCount = readNumber$f(structure.duplicateHeadingCount);
  const duplicateNumberCount = readNumber$f(structure.duplicateNumberCount);
  const semanticDuplicateHeadingCount = semanticDuplicateHeadingContexts.length;
  const bodyAfterFinalSectionCount = bodyAfterFinalSectionContexts.length;
  const facts = {
    bodyAfterFinalSectionCount,
    bodyAfterFinalSectionContexts,
    duplicateHeadingCount,
    duplicateNumberCount,
    issueCodes,
    ok: structure.ok === true,
    repeatedHeadingSamples,
    repeatedNumberSamples,
    semanticDuplicateHeadingContexts,
    semanticDuplicateHeadingCount,
    status: readString(structure.status) || (structure.ok === true ? "pass" : "fail")
  };
  return normalizeStructureSnapshot({
    ...facts,
    present: true,
    signature: hashCompactFacts(facts)
  });
}

function normalizeStructureSnapshot(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const issueCodes = readStringArray(source.issueCodes).sort().slice(0, 8);
  const repeatedHeadingSamples = normalizeStructureSamples(source.repeatedHeadingSamples, "heading");
  const repeatedNumberSamples = normalizeStructureSamples(source.repeatedNumberSamples, "number");
  const semanticDuplicateHeadingContexts = normalizeSemanticDuplicateHeadingContexts(source.semanticDuplicateHeadingContexts);
  const bodyAfterFinalSectionContexts = normalizeBodyAfterFinalSectionContexts(source.bodyAfterFinalSectionContexts);
  const duplicateHeadingCount = readNumber$f(source.duplicateHeadingCount);
  const duplicateNumberCount = readNumber$f(source.duplicateNumberCount);
  const semanticDuplicateHeadingCount = readNumber$f(source.semanticDuplicateHeadingCount) || semanticDuplicateHeadingContexts.length;
  const bodyAfterFinalSectionCount = readNumber$f(source.bodyAfterFinalSectionCount) || bodyAfterFinalSectionContexts.length;
  const ok = source.ok === true;
  const present = source.present === true;
  const status = readString(source.status) || (present ? (ok ? "pass" : "fail") : "missing");
  const signature = readString(source.signature) || hashCompactFacts({
    bodyAfterFinalSectionCount,
    duplicateHeadingCount,
    duplicateNumberCount,
    issueCodes,
    ok,
    repeatedHeadingSamples,
    repeatedNumberSamples,
    semanticDuplicateHeadingCount,
    status
  });
  return {
    bodyAfterFinalSectionCount,
    bodyAfterFinalSectionContexts,
    duplicateHeadingCount,
    duplicateNumberCount,
    issueCodes,
    ok,
    present,
    repeatedHeadingSamples,
    repeatedNumberSamples,
    semanticDuplicateHeadingContexts,
    semanticDuplicateHeadingCount,
    signature,
    status,
    totalDuplicateCount: duplicateHeadingCount + duplicateNumberCount + semanticDuplicateHeadingCount + bodyAfterFinalSectionCount
  };
}

function summarizeStructureSnapshot(value) {
  const snapshot = normalizeStructureSnapshot(value);
  return {
    duplicateHeadingCount: snapshot.duplicateHeadingCount,
    duplicateNumberCount: snapshot.duplicateNumberCount,
    semanticDuplicateHeadingCount: snapshot.semanticDuplicateHeadingCount,
    bodyAfterFinalSectionCount: snapshot.bodyAfterFinalSectionCount,
    issueCodes: snapshot.issueCodes,
    ok: snapshot.ok,
    present: snapshot.present,
    repeatedHeadingSamples: snapshot.repeatedHeadingSamples,
    repeatedNumberSamples: snapshot.repeatedNumberSamples,
    semanticDuplicateHeadingContexts: snapshot.semanticDuplicateHeadingContexts,
    bodyAfterFinalSectionContexts: snapshot.bodyAfterFinalSectionContexts,
    signature: snapshot.signature,
    status: snapshot.status,
    totalDuplicateCount: snapshot.totalDuplicateCount
  };
}

function normalizeSemanticDuplicateHeadingContexts(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = readRecord(entry);
      const first = readRecord(source && source.first);
      const second = readRecord(source && source.second);
      const firstRaw = readString(first && first.raw);
      const secondRaw = readString(second && second.raw);
      if (!firstRaw || !secondRaw) return null;
      return {
        first: { lineNumber: readNumber$f(first && first.lineNumber), raw: firstRaw.slice(0, 160) },
        relation: readString(source && source.relation) || "similar",
        second: { lineNumber: readNumber$f(second && second.lineNumber), raw: secondRaw.slice(0, 160) }
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeBodyAfterFinalSectionContexts(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = readRecord(entry);
      const raw = readString(source && source.raw);
      if (!raw) return null;
      return {
        lineNumber: readNumber$f(source && source.lineNumber),
        raw: raw.slice(0, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeStructureSamples(value, key) {
  const name = key === "number" ? "number" : "heading";
  const list = Array.isArray(value) ? value : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const label = readString(entry[name]);
      const count = readNumber$f(entry.count);
      if (!label || count <= 0) return null;
      return { [name]: label, count };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const countDelta = readNumber$f(b.count) - readNumber$f(a.count);
      if (countDelta !== 0) return countDelta;
      return readString(a[name]).localeCompare(readString(b[name]));
    })
    .slice(0, 5);
}

function isStructureRepairAction(actionName) {
  return [
    FINALIZE_CANDIDATE_ACTION,
    WORKSPACE_INSERT_AFTER_SECTION_ACTION,
    WORKSPACE_LIST_ACTION,
    WORKSPACE_MULTI_EDIT_ACTION,
    WORKSPACE_PROPOSE_PATCH_ACTION,
    WORKSPACE_APPLY_PATCH_ACTION,
    WORKSPACE_READ_ACTION,
    WORKSPACE_REPLACE_ACTION,
    WORKSPACE_WRITE_ACTION
  ].includes(readString(actionName));
}

function readStructureRepairAllowedNextMoves(runState) {
  const moves = DEFAULT_STRUCTURE_REPAIR_ALLOWED_NEXT_MOVES.slice();
  if (hasUnfinishedTodoState(runState)) {
    moves.push("todo_cancel");
  }
  return Array.from(new Set(moves)).slice(0, 12);
}

function buildStructureRepairRequiredCorrection(snapshot) {
  const summary = summarizeStructureSnapshot(snapshot);
  const headingSamples = summary.repeatedHeadingSamples
    .map((entry) => `${entry.heading} x${entry.count}`)
    .join(" | ");
  const numberSamples = summary.repeatedNumberSamples
    .map((entry) => `${entry.number} x${entry.count}`)
    .join(" | ");
  const parts = [
    "Repair the final candidate structure before another clean publish: produce one coherent outline with unique Markdown headings and non-duplicated section numbers.",
    summary.issueCodes.length > 0 ? `Active issueCodes=${summary.issueCodes.join(",")}.` : "",
    headingSamples ? `Duplicate heading samples=${headingSamples}.` : "",
    numberSamples ? `Duplicate section-number samples=${numberSamples}.` : "",
    "Use a targeted full rewrite or targeted heading/number normalization; do not keep reading/appending around the same broken outline."
  ].filter(Boolean);
  return parts.join(" ");
}

function readActionName$3(decision) {
  return readString(decision && (decision.name || decision.actionName));
}

function isTrackableAction(actionName, context) {
  if (readString(context && context.status) === "before_action") return false;
  return Boolean(readString(actionName));
}

function isReadOnlyPlanningAction(actionName, config = DEFAULT_CONVERGENCE_CONFIG) {
  return config.readOnlyPlanningForbiddenActions.includes(readString(actionName));
}

// AGRUN-263 helpers — fingerprint for tool-result dedup. The `decision`
// carries `args`; `toolContext.history` does not preserve them (it stores
// only the action output envelope body). We therefore derive the
// fingerprint from `decision` at refresh time and persist a small ring
// on convergence state. Missing args fold to empty so action-name-only
// repeats still register as duplicates.
function buildToolCallFingerprint(actionName, decision) {
  const name = readString(actionName) || readString(decision && decision.name);
  if (!name) return null;
  const args = decision && decision.args && typeof decision.args === "object" ? decision.args : {};
  return name + ":" + stableStringify(args);
}

function updateRecentToolFingerprints(previousList, fingerprint, toolHistoryGrew, config = DEFAULT_CONVERGENCE_CONFIG) {
  const base = Array.isArray(previousList) ? previousList.slice() : [];
  if (!toolHistoryGrew || !fingerprint) return base.slice(-config.toolResultDedupWindow);
  base.push(fingerprint);
  return base.slice(-config.toolResultDedupWindow);
}

function readStatus$1(value) {
  const status = readString(value);
  if (status === "terminal_correction_active") return status;
  if (status === "read_only_planning_active") return status;
  if (status === "structure_repair_active") return status;
  if (status === "workspace_mutation_growth_active") return status;
  if (status === "repeated_no_progress" || status === "progress_observed") return status;
  return "tracking";
}

function readPatternKind(value) {
  const text = readString(value);
  if (text === "transitional_only_progress") return "transitional_only_progress";
  return text === "semantic_terminal" ? "semantic_terminal" : "exact_action";
}

// Mirror normalizeActionGuardrailConfig.readPositiveInteger: a host override is
// honored only when it is a non-negative integer, otherwise the DEFAULT_* falls
// through. This keeps default behavior byte-identical when config is absent.
function readPositiveInteger$j(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// Forbidden-action lists are REPLACED, not merged: a non-empty host array wins
// outright, an absent/empty one falls back to the DEFAULT_* list. Replacement
// mirrors resolveProductiveProgressDimensions so misconfiguration is loud.
function readForbiddenActionList(value, fallback) {
  const list = readStringArray(value);
  return list.length > 0 ? list : fallback.slice();
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readNumber$f(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function readSignedNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function readNullableNumber$5(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// AGRUN-304 — like readNullableNumber but does NOT coerce: Number(null) is 0, so
// readNullableNumber turns a null "unset" sentinel into 0. This keeps null null
// so bestStructureDefectScore can distinguish "no best yet" from "best is 0".
function readNullableScore(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export { DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS, createActionPatternConvergenceState, evaluateActionPatternConvergence, normalizeConvergenceConfig, refreshActionPatternConvergence, shouldEmitActionPatternConvergenceRefreshed, summarizeActionPatternConvergence };
