import { readStatsKeyForUnit, readTerminalContractText, extractRequestedLengthContract } from './terminal-final-contract.js';
import { WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_WRITE_ACTION, WEB_SEARCH_ACTION, READ_URL_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_READ_ACTION, FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION } from './action-names.js';
import { cloneValue } from './utils.js';
import { readWorkspaceFinalCandidate } from './virtual-workspace.js';
import { readString } from './semantic-json.js';
import { lowCycleRemainingThreshold } from './cycle-budget.js';

const WORKSPACE_RECOVERY_ACTIONS = new Set(["append", "insert_after_section", "replace"]);
const WORKSPACE_ACTION_NAMES = new Set([
  WORKSPACE_INSERT_AFTER_SECTION_ACTION,
  WORKSPACE_REPLACE_ACTION,
  WORKSPACE_WRITE_ACTION,
  WORKSPACE_READ_ACTION,
  FINALIZE_CANDIDATE_ACTION
]);
const SOURCE_ACTION_NAMES = new Set([WEB_SEARCH_ACTION, READ_URL_ACTION]);
const TERMINAL_ACTION_NAMES = new Set([PUBLISH_DIRECT_ACTION, "finalize"]);
const SOURCE_RECOVERY_STATUSES = new Set(["retryable_failure", "needs_alternate_source", "source_blocked"]);
const REPEATED_INVALID_TERMINAL_THRESHOLD = 2;
const WORKSPACE_LOW_BUDGET_RATIO = 0.8;

function createRequirementRecoveryEvaluatorState() {
  return {
    kind: "requirement_recovery_evaluator",
    status: "tracking",
    recoverableDeficits: [],
    validLimitedAllowed: true,
    requiredAttemptBeforeLimited: [],
    forbiddenMoves: [],
    recoverySignals: {
      source: [],
      workspace: []
    },
    lastCandidateStats: null,
    lastObservableDeficits: null,
    convergence: createRequirementRecoveryConvergenceState(),
    nextMoveContract: null,
    updatedAtCycle: null,
    version: 1
  };
}

function refreshRequirementRecoveryEvaluator(runState, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const previous = normalizeRequirementRecoveryEvaluatorState(runState.requirementRecoveryEvaluator);
  const next = evaluateRequirementRecovery(runState, { ...context, previous });
  runState.requirementRecoveryEvaluator = next;
  return next;
}

function evaluateRequirementRecovery(runState, context = {}) {
  const previous = normalizeRequirementRecoveryEvaluatorState(context.previous || runState && runState.requirementRecoveryEvaluator);
  const candidate = readCandidateSnapshot(runState);
  const requestedLength = readRequestedLengthSnapshot(runState, context);
  const sourceMinimum = readSourceMinimum(runState);
  const readUrlRecoverySignal = readReadUrlRecoverySignalSnapshot(runState);
  const workspaceSignals = readWorkspaceRecoverySignals(runState, candidate);
  const sourceSignals = readSourceRecoverySignals(runState, readUrlRecoverySignal);
  const deficits = readObservableDeficits({
    candidate,
    requestedLength,
    sourceMinimum
  });
  const recoverableDeficits = [];

  // Length is AI-owned content, but the harness can still expose it as a
  // recoverable workspace deficit while the workspace budget can accept another
  // AI-authored mutation. Honest limited remains available after recovery is
  // exhausted or repeatedly ineffective.
  if (
    deficits.lengthDeficit > 0 &&
    isWorkspaceDeficitRecoverable(runState, candidate, workspaceSignals, context)
  ) {
    recoverableDeficits.push({
      allowedNextMoves: workspaceSignals.expansionAttempted
        ? [WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION]
        : [WORKSPACE_WRITE_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION],
      deficit: deficits.lengthDeficit,
      dimension: "length",
      observed: deficits.lengthObserved,
      recoverable: true,
      requiredAttempt: workspaceSignals.expansionAttempted
        ? "workspace_expansion_until_length_satisfied"
        : "initial_workspace_expansion",
      target: deficits.lengthRequested,
      unit: deficits.lengthUnit,
      whyRecoverable: "requested length is still unmet and workspace recovery budget remains"
    });
  }

  if (
    (deficits.readSourceDeficit > 0 || deficits.relevantSourceDeficit > 0) &&
    isSourceDeficitInScope(runState, readUrlRecoverySignal, sourceMinimum) &&
    isSourceDeficitRecoverable(readUrlRecoverySignal, sourceSignals)
  ) {
    recoverableDeficits.push({
      allowedNextMoves: sourceSignals.alternateAttempted
        ? ["web_search_refined", "read_url_alternate"]
        : ["read_url_alternate", "web_search_refined"],
      deficit: Math.max(deficits.readSourceDeficit, deficits.relevantSourceDeficit),
      dimension: "source",
      observed: {
        readSources: sourceMinimum ? sourceMinimum.readSources : null,
        relevantSources: sourceMinimum ? sourceMinimum.relevantSources : null
      },
      recoverable: true,
      requiredAttempt: sourceSignals.hasAnyEvidenceWork ? "alternate_source_or_refined_search" : "initial_evidence_work",
      target: {
        minReadSources: sourceMinimum ? sourceMinimum.minReadSources : null,
        minRelevantSources: sourceMinimum ? sourceMinimum.minRelevantSources : null
      },
      whyRecoverable: sourceSignals.alternateCandidateCount > 0
        ? "read_url recovery has alternate source candidates that have not been exhausted"
        : "source minimum is below target and no evidence work is visible yet"
    });
  }

  const requiredAttemptBeforeLimited = Array.from(new Set(
    recoverableDeficits.map((entry) => entry.requiredAttempt).filter(Boolean)
  ));
  const baselineValidLimitedAllowed = recoverableDeficits.length === 0;
  let convergence = buildRequirementRecoveryConvergence({
    candidate,
    context,
    deficits,
    previous,
    readUrlRecoverySignal,
    recoverableDeficits,
    requestedLength,
    runState,
    sourceMinimum,
    sourceSignals,
    validLimitedAllowed: baselineValidLimitedAllowed,
    workspaceSignals
  });
  const terminalRepairLimitedAllowed = shouldAllowTerminalRepairLimited({
    convergence,
    recoverableDeficits,
    runState,
    workspaceSignals
  });
  const validLimitedAllowed = baselineValidLimitedAllowed || terminalRepairLimitedAllowed;
  if (terminalRepairLimitedAllowed && convergence.recommendedContract !== "valid_limited_allowed") {
    convergence = {
      ...convergence,
      recommendedContract: "valid_limited_allowed",
      terminalPattern: {
        kind: "terminal_repair_valid_limited_allowed",
        threshold: REPEATED_INVALID_TERMINAL_THRESHOLD,
        message: "Terminal repair is active and workspace recovery is low-budget or repeatedly ineffective; valid limited publish is allowed with concrete remainingGaps."
      }
    };
  }
  const forbiddenMoves = validLimitedAllowed
    ? []
    : ["clean_ready", "limited_without_recovery_attempt"];
  const status = readStatus({ recoverableDeficits, validLimitedAllowed });
  const nextMoveContract = buildNextMoveContract({
    convergence,
    recoverableDeficits,
    requiredAttemptBeforeLimited,
    validLimitedAllowed
  });

  return {
    kind: "requirement_recovery_evaluator",
    status,
    recoverableDeficits,
    validLimitedAllowed,
    requiredAttemptBeforeLimited,
    forbiddenMoves,
    recoverySignals: {
      source: sourceSignals.signals,
      workspace: workspaceSignals.signals
    },
    lastCandidateStats: candidate ? cloneValue(candidate) : null,
    lastObservableDeficits: deficits,
    convergence,
    nextMoveContract,
    updatedAtCycle: readNullableNumber$3(runState.cycleCount),
    version: 1
  };
}

function summarizeRequirementRecoveryEvaluator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deficits = Array.isArray(value.recoverableDeficits)
    ? value.recoverableDeficits.map((entry) => ({
        allowedNextMoves: Array.isArray(entry.allowedNextMoves)
          ? entry.allowedNextMoves.map(readString).filter(Boolean).slice(0, 6)
          : [],
        deficit: readNullableNumber$3(entry.deficit),
        dimension: readString(entry.dimension) || "requirement",
        observed: cloneValue(entry.observed),
        recoverable: entry.recoverable === true,
        requiredAttempt: readString(entry.requiredAttempt) || null,
        target: cloneValue(entry.target),
        unit: readString(entry.unit) || null,
        whyRecoverable: readString(entry.whyRecoverable) || null
      })).slice(0, 6)
    : [];
  return {
    kind: "requirement_recovery_evaluator",
    status: readString(value.status) || "tracking",
    recoverableDeficits: deficits,
    validLimitedAllowed: value.validLimitedAllowed !== false,
    requiredAttemptBeforeLimited: Array.isArray(value.requiredAttemptBeforeLimited)
      ? value.requiredAttemptBeforeLimited.map(readString).filter(Boolean).slice(0, 6)
      : [],
    forbiddenMoves: Array.isArray(value.forbiddenMoves)
      ? value.forbiddenMoves.map(readString).filter(Boolean).slice(0, 6)
      : [],
    recoverySignals: value.recoverySignals && typeof value.recoverySignals === "object"
      ? {
          source: Array.isArray(value.recoverySignals.source)
            ? value.recoverySignals.source.map(readString).filter(Boolean).slice(0, 8)
            : [],
          workspace: Array.isArray(value.recoverySignals.workspace)
            ? value.recoverySignals.workspace.map(readString).filter(Boolean).slice(0, 8)
            : []
        }
      : { source: [], workspace: [] },
    lastCandidateStats: value.lastCandidateStats && typeof value.lastCandidateStats === "object"
      ? {
          chars: readNullableNumber$3(value.lastCandidateStats.chars),
          cjkChars: readNullableNumber$3(value.lastCandidateStats.cjkChars),
          path: readString(value.lastCandidateStats.path) || null,
          words: readNullableNumber$3(value.lastCandidateStats.words)
        }
      : null,
    lastObservableDeficits: value.lastObservableDeficits && typeof value.lastObservableDeficits === "object"
      ? cloneValue(value.lastObservableDeficits)
      : null,
    convergence: summarizeRequirementRecoveryConvergence(value.convergence),
    nextMoveContract: readString(value.nextMoveContract) || null
  };
}

function inspectLimitedRecoveryReadiness(runState, context = {}) {
  const finalReadiness = context.finalReadiness && typeof context.finalReadiness === "object"
    ? context.finalReadiness
    : null;
  if (!finalReadiness || readString(finalReadiness.decision) !== "limited") {
    return { ok: true, evaluator: evaluateRequirementRecovery(runState, context) };
  }
  const evaluator = evaluateRequirementRecovery(runState, context);
  if (evaluator.validLimitedAllowed !== false) return { ok: true, evaluator };
  return {
    ok: false,
    evaluator,
    message: [
      "workspace_publish_candidate limited publish is too early because observable deficits still appear recoverable.",
      evaluator.nextMoveContract,
      "Continue the allowed recovery work first, or publish limited only after recovery attempts are exhausted and requirementsAssessment.remainingGaps names the concrete blocker."
    ].filter(Boolean).join(" ")
  };
}

function readStatus({ recoverableDeficits, validLimitedAllowed }) {
  if (validLimitedAllowed) return "limited_allowed";
  if (recoverableDeficits.some((entry) => entry.dimension === "source")) return "needs_evidence_recovery";
  if (recoverableDeficits.some((entry) => entry.dimension === "length")) return "needs_workspace_recovery";
  return "tracking";
}

function shouldAllowTerminalRepairLimited({ convergence, recoverableDeficits, runState, workspaceSignals }) {
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return false;
  if (!Array.isArray(recoverableDeficits) || recoverableDeficits.length === 0) return false;
  const dimensions = Array.from(new Set(recoverableDeficits.map((entry) => readString(entry && entry.dimension)).filter(Boolean)));
  if (dimensions.includes("source")) return false;
  if (dimensions.some((dimension) => dimension !== "length")) return false;
  if (!workspaceSignals || workspaceSignals.expansionAttempted !== true) return false;
  const normalized = normalizeRequirementRecoveryConvergenceState(convergence);
  const lengthState = normalized.dimensionStates.length;
  return normalized.budgetState === "exhausted" ||
    readNumber$d(lengthState.repeatedRegressionCount) >= 1 ||
    readNumber$d(lengthState.repeatedNoProgressCount) >= 2;
}

function buildNextMoveContract({ convergence, recoverableDeficits, requiredAttemptBeforeLimited, validLimitedAllowed }) {
  if (validLimitedAllowed || recoverableDeficits.length === 0) {
    return "No recoverable requirement deficit is currently blocking honest limited readiness.";
  }
  const deficitText = recoverableDeficits.map((entry) => {
    if (entry.dimension === "length") {
      return `length deficit ${entry.deficit} ${entry.unit || "units"} (${entry.observed}/${entry.target})`;
    }
    if (entry.dimension === "source") {
      const observed = entry.observed || {};
      const target = entry.target || {};
      return `source deficit read=${observed.readSources}/${target.minReadSources}, relevant=${observed.relevantSources}/${target.minRelevantSources}`;
    }
    return `${entry.dimension} deficit`;
  }).join("; ");
  const moves = Array.from(new Set(
    recoverableDeficits.flatMap((entry) => Array.isArray(entry.allowedNextMoves) ? entry.allowedNextMoves : [])
  ));
  const terminalWarning = convergence &&
    readNumber$d(convergence.repeatedInvalidTerminalCount) >= REPEATED_INVALID_TERMINAL_THRESHOLD
    ? "Repeated workspace_publish_candidate/finalize attempts produced no observable requirement progress. Do not publish again until source or length facts improve, or validLimitedAllowed becomes true."
    : "";
  const lengthState = convergence && convergence.dimensionStates && convergence.dimensionStates.length
    ? convergence.dimensionStates.length
    : null;
  const regressionWarning = readNumber$d(lengthState && lengthState.repeatedRegressionCount) > 0
    ? "Candidate length regressed during recovery. Do not use broad rewrites that shrink the selected candidate; use additive repair or publish valid limited when recovery is exhausted."
    : "";
  return [
    `Recoverable deficits remain: ${deficitText}.`,
    `Before limited, perform: ${requiredAttemptBeforeLimited.join(", ") || "recovery work"}.`,
    `Allowed next moves: ${moves.join(", ") || "continue recovery work"}.`,
    regressionWarning,
    terminalWarning,
    "Do not clean ready or limited_without_recovery_attempt while these deficits are recoverable."
  ].join(" ");
}

function createRequirementRecoveryConvergenceState() {
  return {
    dimensionStates: {
      source: createDimensionState("source"),
      length: createDimensionState("length")
    },
    repeatedInvalidTerminalCount: 0,
    budgetState: "enough",
    recommendedContract: "valid_limited_allowed",
    terminalPattern: null,
    updatedAtCycle: null
  };
}

function createDimensionState(dimension) {
  return {
    attempts: 0,
    dimension,
    exhausted: false,
    lastEffectiveAction: null,
    lastRegressionAction: null,
    lastObserved: null,
    progressCount: 0,
    regressionCount: 0,
    repeatedRegressionCount: 0,
    repeatedNoProgressCount: 0
  };
}

function buildRequirementRecoveryConvergence({
  candidate,
  context,
  deficits,
  previous,
  readUrlRecoverySignal,
  recoverableDeficits,
  requestedLength,
  runState,
  sourceMinimum,
  sourceSignals,
  validLimitedAllowed,
  workspaceSignals
}) {
  const previousConvergence = normalizeRequirementRecoveryConvergenceState(previous && previous.convergence);
  const actionName = readString(context && context.actionName);
  const finalReadiness = readFinalReadiness(context);
  const sourceRecoverable = recoverableDeficits.some((entry) => entry.dimension === "source");
  const lengthRecoverable = recoverableDeficits.some((entry) => entry.dimension === "length");
  const sourceObserved = readSourceObservedSnapshot(runState, sourceMinimum, deficits);
  const lengthObserved = readLengthObservedSnapshot(candidate, requestedLength, deficits);
  const validLimited = isValidLimitedWithConcreteGaps(finalReadiness, deficits);
  const sourceProgress = hasSourceProgress(previousConvergence.dimensionStates.source, sourceObserved, validLimited);
  const lengthProgress = hasLengthProgress(previousConvergence.dimensionStates.length, lengthObserved, validLimited);
  const lengthRegression = hasLengthRegression(previousConvergence.dimensionStates.length, lengthObserved);
  const sourceState = updateDimensionState({
    actionName,
    dimension: "source",
    isAttemptAction: SOURCE_ACTION_NAMES.has(actionName),
    observed: sourceObserved,
    previous: previousConvergence.dimensionStates.source,
    progress: sourceProgress,
    regression: false,
    recoverable: sourceRecoverable,
    exhausted: sourceHasDeficit(deficits) && !sourceRecoverable && !isSourceDeficitRecoverable(readUrlRecoverySignal, sourceSignals)
  });
  const lengthState = updateDimensionState({
    actionName,
    dimension: "length",
    isAttemptAction: WORKSPACE_ACTION_NAMES.has(actionName),
    observed: lengthObserved,
    previous: previousConvergence.dimensionStates.length,
    progress: lengthProgress,
    regression: lengthRegression,
    recoverable: lengthRecoverable,
    exhausted: deficits.lengthDeficit > 0 && !lengthRecoverable && !isWorkspaceDeficitRecoverable(runState, candidate, workspaceSignals, context)
  });
  const terminalNoProgressAttempt = TERMINAL_ACTION_NAMES.has(actionName) &&
    (validLimitedAllowed === false || isBlockedTerminalOutput(context && context.output));
  const hasAnyProgress = sourceProgress || lengthProgress;
  const repeatedInvalidTerminalCount = terminalNoProgressAttempt && !hasAnyProgress
    ? previousConvergence.repeatedInvalidTerminalCount + 1
    : hasAnyProgress
      ? 0
      : previousConvergence.repeatedInvalidTerminalCount;
  const budgetState = readBudgetState(runState, candidate, context);
  const recommendedContract = readRecommendedContract({
    budgetState,
    repeatedInvalidTerminalCount,
    validLimitedAllowed
  });
  return {
    dimensionStates: {
      source: sourceState,
      length: lengthState
    },
    repeatedInvalidTerminalCount,
    budgetState,
    recommendedContract,
    terminalPattern: repeatedInvalidTerminalCount > 0
      ? {
          kind: "publish_without_requirement_progress",
          threshold: REPEATED_INVALID_TERMINAL_THRESHOLD,
          message: repeatedInvalidTerminalCount >= REPEATED_INVALID_TERMINAL_THRESHOLD
            ? "Do not repeat workspace_publish_candidate/finalize without new evidence, workspace growth, or valid limited allowance."
            : "Terminal action was attempted while recoverable deficits remained."
        }
      : null,
    updatedAtCycle: readNullableNumber$3(runState && runState.cycleCount)
  };
}

function updateDimensionState({ actionName, dimension, exhausted, isAttemptAction, observed, previous, progress, regression, recoverable }) {
  const state = normalizeDimensionState(previous, dimension);
  const hasActiveDeficit = recoverable || exhausted;
  const attempts = isAttemptAction && hasActiveDeficit ? state.attempts + 1 : state.attempts;
  const progressCount = progress ? state.progressCount + 1 : state.progressCount;
  const regressionCount = regression ? state.regressionCount + 1 : state.regressionCount;
  const repeatedRegressionCount = regression
    ? state.repeatedRegressionCount + 1
    : progress
      ? 0
      : state.repeatedRegressionCount;
  const repeatedNoProgressCount = progress
    ? 0
    : isAttemptAction && hasActiveDeficit
      ? state.repeatedNoProgressCount + 1
      : state.repeatedNoProgressCount;
  return {
    attempts,
    dimension,
    exhausted: exhausted === true,
    lastEffectiveAction: progress ? actionName || state.lastEffectiveAction : state.lastEffectiveAction,
    lastRegressionAction: regression ? actionName || state.lastRegressionAction : state.lastRegressionAction,
    lastObserved: cloneValue(observed),
    progressCount,
    regressionCount,
    repeatedRegressionCount,
    repeatedNoProgressCount
  };
}

function readSourceObservedSnapshot(runState, sourceMinimum, deficits) {
  return {
    passed: sourceMinimum ? sourceMinimum.passed === true : null,
    readSourceDeficit: deficits.readSourceDeficit,
    readSources: sourceMinimum ? readNumber$d(sourceMinimum.readSources) : null,
    relevantSourceDeficit: deficits.relevantSourceDeficit,
    relevantSources: sourceMinimum ? readNumber$d(sourceMinimum.relevantSources) : null,
    successfulReadUrlCount: readSuccessfulReadUrlCount(runState)
  };
}

function readLengthObservedSnapshot(candidate, requestedLength, deficits) {
  return {
    chars: candidate ? readNumber$d(candidate.chars) : null,
    cjkChars: candidate ? readNumber$d(candidate.cjkChars) : null,
    deficit: deficits.lengthDeficit,
    requested: requestedLength && Number.isFinite(requestedLength.value) ? requestedLength.value : null,
    unit: requestedLength ? readString(requestedLength.unit) || null : null,
    words: candidate ? readNumber$d(candidate.words) : null
  };
}

function hasSourceProgress(previousState, observed, validLimited) {
  const previous = previousState && previousState.lastObserved && typeof previousState.lastObserved === "object"
    ? previousState.lastObserved
    : null;
  if (!previous) return false;
  if (validLimited && sourceObservedHasDeficit(observed)) return true;
  if (observed.passed === true && previous.passed !== true) return true;
  if (readNumber$d(observed.successfulReadUrlCount) > readNumber$d(previous.successfulReadUrlCount)) return true;
  if (readNumber$d(observed.readSources) > readNumber$d(previous.readSources)) return true;
  if (readNumber$d(observed.relevantSources) > readNumber$d(previous.relevantSources)) return true;
  return false;
}

function hasLengthProgress(previousState, observed, validLimited) {
  const previous = previousState && previousState.lastObserved && typeof previousState.lastObserved === "object"
    ? previousState.lastObserved
    : null;
  if (!previous) return false;
  if (validLimited && readNumber$d(observed.deficit) > 0) return true;
  if (readNumber$d(observed.deficit) === 0 && readNumber$d(previous.deficit) > 0) return true;
  if (readNumber$d(observed.words) > readNumber$d(previous.words)) return true;
  if (readNumber$d(observed.chars) > readNumber$d(previous.chars)) return true;
  if (readNumber$d(observed.cjkChars) > readNumber$d(previous.cjkChars)) return true;
  return false;
}

function hasLengthRegression(previousState, observed) {
  const previous = previousState && previousState.lastObserved && typeof previousState.lastObserved === "object"
    ? previousState.lastObserved
    : null;
  if (!previous) return false;
  const requested = readNumber$d(observed && observed.requested) || readNumber$d(previous.requested);
  const previousObserved = readNumber$d(previous.words) || readNumber$d(previous.chars) || readNumber$d(previous.cjkChars);
  const currentObserved = readNumber$d(observed && observed.words) || readNumber$d(observed && observed.chars) || readNumber$d(observed && observed.cjkChars);
  const activeDeficit = requested > 0 && currentObserved > 0 && currentObserved < requested;
  const nearOrAboveTargetBefore = requested > 0 && previousObserved >= Math.floor(requested * 0.95);
  if (isMaterialRegression(previous.words, observed && observed.words, 100)) {
    return activeDeficit || nearOrAboveTargetBefore || readNumber$d(previous.words) >= 1000;
  }
  if (isMaterialRegression(previous.chars, observed && observed.chars, 600)) {
    return activeDeficit || nearOrAboveTargetBefore || readNumber$d(previous.chars) >= 6000;
  }
  if (isMaterialRegression(previous.cjkChars, observed && observed.cjkChars, 250)) {
    return activeDeficit || nearOrAboveTargetBefore || readNumber$d(previous.cjkChars) >= 2500;
  }
  return false;
}

function isMaterialRegression(previous, current, floor) {
  const before = readNumber$d(previous);
  const after = readNumber$d(current);
  if (!before || after >= before) return false;
  return before - after >= floor && after <= Math.floor(before * 0.9);
}

function sourceObservedHasDeficit(observed) {
  return readNumber$d(observed && observed.readSourceDeficit) > 0 ||
    readNumber$d(observed && observed.relevantSourceDeficit) > 0;
}

function sourceHasDeficit(deficits) {
  return readNumber$d(deficits && deficits.readSourceDeficit) > 0 ||
    readNumber$d(deficits && deficits.relevantSourceDeficit) > 0;
}

function readSuccessfulReadUrlCount(runState) {
  const packet = readAcceptancePacket(runState);
  const packetCount = packet && packet.evidence && Number.isFinite(Number(packet.evidence.successfulReadUrlCount))
    ? Number(packet.evidence.successfulReadUrlCount)
    : null;
  if (packetCount != null) return packetCount;
  const readSources = runState && runState.researchContext && Array.isArray(runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  return readSources.filter((source) => source && (source.ok === true || readNumber$d(source.status) >= 200 && readNumber$d(source.status) < 300)).length;
}

function readFinalReadiness(context) {
  if (context && context.finalReadiness && typeof context.finalReadiness === "object") return context.finalReadiness;
  const output = context && context.output && typeof context.output === "object" ? context.output : null;
  if (output && output.finalReadiness && typeof output.finalReadiness === "object") return output.finalReadiness;
  const args = output && output.args && typeof output.args === "object" ? output.args : null;
  return args && args.finalReadiness && typeof args.finalReadiness === "object" ? args.finalReadiness : null;
}

function isValidLimitedWithConcreteGaps(finalReadiness, deficits) {
  if (!finalReadiness || readString(finalReadiness.decision) !== "limited") return false;
  const assessment = finalReadiness.requirementsAssessment &&
    typeof finalReadiness.requirementsAssessment === "object"
    ? finalReadiness.requirementsAssessment
    : finalReadiness;
  const gaps = Array.isArray(assessment.remainingGaps)
    ? assessment.remainingGaps.map(readString).filter(Boolean)
    : Array.isArray(finalReadiness.remainingGaps)
      ? finalReadiness.remainingGaps.map(readString).filter(Boolean)
      : [];
  if (gaps.length === 0) return false;
  if (sourceHasDeficit(deficits) && assessment.evidenceSatisfied !== false) return false;
  if (readNumber$d(deficits.lengthDeficit) > 0 && assessment.lengthSatisfied !== false) return false;
  if ((sourceHasDeficit(deficits) || readNumber$d(deficits.lengthDeficit) > 0) && assessment.requirementSatisfied !== false) return false;
  return true;
}

function isBlockedTerminalOutput(output) {
  if (!output || typeof output !== "object") return false;
  const kind = readString(output.kind);
  const status = readString(output.status);
  const control = readString(output.control);
  if (kind.includes("blocked") || kind.includes("continuation")) return true;
  if (status === "blocked" || status === "error" || status === "continue") return true;
  return control === "continue";
}

function readBudgetState(runState, candidate, context) {
  const cyclesRemaining = readCyclesRemaining(runState);
  const maxSteps = readNullableNumber$3(runState && runState.maxSteps);
  const limits = readWorkspaceRecoveryLimits(context);
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const operationCount = workspace && Array.isArray(workspace.operations) ? workspace.operations.length : 0;
  const chars = candidate ? readNumber$d(candidate.chars) : 0;
  if (cyclesRemaining != null && cyclesRemaining <= 0) return "exhausted";
  if (operationCount >= limits.maxOperations) return "exhausted";
  if (chars >= limits.maxFileChars) return "exhausted";
  // AGRUN-413 — proportional to maxSteps, consistent with WORKSPACE_LOW_BUDGET_RATIO below.
  if (cyclesRemaining != null && cyclesRemaining <= lowCycleRemainingThreshold(maxSteps)) return "low";
  if (operationCount >= Math.floor(limits.maxOperations * WORKSPACE_LOW_BUDGET_RATIO)) return "low";
  if (chars >= Math.floor(limits.maxFileChars * WORKSPACE_LOW_BUDGET_RATIO)) return "low";
  return "enough";
}

function readCyclesRemaining(runState) {
  if (!runState || typeof runState !== "object") return null;
  const maxSteps = readNullableNumber$3(runState.maxSteps);
  const cycleCount = readNullableNumber$3(runState.cycleCount);
  if (maxSteps == null || cycleCount == null) return null;
  return Math.max(0, maxSteps - cycleCount);
}

function readRecommendedContract({ budgetState, repeatedInvalidTerminalCount, validLimitedAllowed }) {
  if (validLimitedAllowed) return "valid_limited_allowed";
  if (budgetState === "exhausted") return "valid_limited_allowed";
  if (repeatedInvalidTerminalCount >= REPEATED_INVALID_TERMINAL_THRESHOLD) return "continue_recovery";
  return "continue_recovery";
}

function normalizeRequirementRecoveryEvaluatorState(value) {
  const base = createRequirementRecoveryEvaluatorState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  return {
    ...base,
    ...cloneValue(value),
    convergence: normalizeRequirementRecoveryConvergenceState(value.convergence)
  };
}

function normalizeRequirementRecoveryConvergenceState(value) {
  const base = createRequirementRecoveryConvergenceState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  return {
    ...base,
    ...cloneValue(value),
    dimensionStates: {
      source: normalizeDimensionState(value.dimensionStates && value.dimensionStates.source, "source"),
      length: normalizeDimensionState(value.dimensionStates && value.dimensionStates.length, "length")
    },
    repeatedInvalidTerminalCount: readNumber$d(value.repeatedInvalidTerminalCount),
    budgetState: readBudgetStateValue(value.budgetState) || base.budgetState,
    recommendedContract: readRecommendedContractValue(value.recommendedContract) || base.recommendedContract,
    terminalPattern: value.terminalPattern && typeof value.terminalPattern === "object"
      ? cloneValue(value.terminalPattern)
      : null,
    updatedAtCycle: readNullableNumber$3(value.updatedAtCycle)
  };
}

function normalizeDimensionState(value, dimension) {
  const base = createDimensionState(dimension);
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  return {
    attempts: readNumber$d(value.attempts),
    dimension,
    exhausted: value.exhausted === true,
    lastEffectiveAction: readString(value.lastEffectiveAction) || null,
    lastRegressionAction: readString(value.lastRegressionAction) || null,
    lastObserved: value.lastObserved && typeof value.lastObserved === "object" ? cloneValue(value.lastObserved) : null,
    progressCount: readNumber$d(value.progressCount),
    regressionCount: readNumber$d(value.regressionCount),
    repeatedRegressionCount: readNumber$d(value.repeatedRegressionCount),
    repeatedNoProgressCount: readNumber$d(value.repeatedNoProgressCount)
  };
}

function summarizeRequirementRecoveryConvergence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = normalizeRequirementRecoveryConvergenceState(value);
  return {
    budgetState: normalized.budgetState,
    dimensionStates: {
      source: summarizeDimensionState(normalized.dimensionStates.source),
      length: summarizeDimensionState(normalized.dimensionStates.length)
    },
    repeatedInvalidTerminalCount: normalized.repeatedInvalidTerminalCount,
    recommendedContract: normalized.recommendedContract,
    terminalPattern: normalized.terminalPattern
      ? {
          kind: readString(normalized.terminalPattern.kind) || null,
          message: readString(normalized.terminalPattern.message) || null,
          threshold: readNullableNumber$3(normalized.terminalPattern.threshold)
        }
      : null
  };
}

function summarizeDimensionState(value) {
  const normalized = normalizeDimensionState(value, readString(value && value.dimension) || "requirement");
  return {
    attempts: normalized.attempts,
    exhausted: normalized.exhausted,
    lastEffectiveAction: normalized.lastEffectiveAction,
    lastRegressionAction: normalized.lastRegressionAction,
    lastObserved: normalized.lastObserved,
    progressCount: normalized.progressCount,
    regressionCount: normalized.regressionCount,
    repeatedRegressionCount: normalized.repeatedRegressionCount,
    repeatedNoProgressCount: normalized.repeatedNoProgressCount
  };
}

function readBudgetStateValue(value) {
  const text = readString(value);
  return ["enough", "low", "exhausted"].includes(text) ? text : "";
}

function readRecommendedContractValue(value) {
  const text = readString(value);
  return ["continue_recovery", "valid_limited_allowed", "fail_fast_debug"].includes(text) ? text : "";
}

function isWorkspaceDeficitRecoverable(runState, candidate, workspaceSignals, context = {}) {
  if (!candidate) return false;
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  if (!workspace) return true;
  const operationCount = Array.isArray(workspace.operations) ? workspace.operations.length : 0;
  const limits = readWorkspaceRecoveryLimits(context);
  if (operationCount >= limits.maxOperations) return false;
  if (readNumber$d(candidate.chars) >= limits.maxFileChars) return false;
  return true;
}

function readWorkspaceRecoveryLimits(context) {
  const config = context && context.runtimeConfig && context.runtimeConfig.virtualWorkspace &&
    typeof context.runtimeConfig.virtualWorkspace === "object"
    ? context.runtimeConfig.virtualWorkspace
    : context && context.virtualWorkspaceConfig && typeof context.virtualWorkspaceConfig === "object"
      ? context.virtualWorkspaceConfig
      : null;
  return {
    maxFileChars: readPositiveNumber$1(config && config.maxFileChars) || 24000,
    maxOperations: readPositiveNumber$1(config && config.maxOperations) || 80
  };
}

function isSourceDeficitRecoverable(readUrlRecoverySignal, sourceSignals) {
  if (!sourceSignals.hasAnyEvidenceWork) return true;
  if (!readUrlRecoverySignal) return false;
  if (!SOURCE_RECOVERY_STATUSES.has(readString(readUrlRecoverySignal.status))) return false;
  if (sourceSignals.alternateCandidateCount > 0 && !sourceSignals.alternateAttempted) return true;
  if (readString(readUrlRecoverySignal.status) === "retryable_failure" && readNumber$d(readUrlRecoverySignal.sameUrlAttemptCount) <= 1) return true;
  return false;
}

function isSourceDeficitInScope(runState, readUrlRecoverySignal, sourceMinimum) {
  const researchState = runState && runState.researchState && typeof runState.researchState === "object"
    ? runState.researchState
    : null;
  const finalReason = readString(researchState && researchState.finalReason);
  if (researchState && (
    researchState.qualityGateRequired === true ||
    researchState.finalAllowed === false ||
    (finalReason && finalReason !== "evidence_convergence_inactive" && finalReason !== "ok")
  )) {
    return true;
  }
  if (readUrlRecoverySignal && readString(readUrlRecoverySignal.status) !== "none") return true;
  const readSources = runState && runState.researchContext && Array.isArray(runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  if (readSources.length > 0) return true;
  return sourceMinimum && sourceMinimum.passed === true;
}

function readWorkspaceRecoverySignals(runState, candidate) {
  const path = readString(candidate && candidate.path);
  const operations = runState && runState.virtualWorkspace && Array.isArray(runState.virtualWorkspace.operations)
    ? runState.virtualWorkspace.operations
    : [];
  const relevant = operations.filter((operation) => (
    operation &&
    (!path || operation.path === path)
  ));
  const expansionAttempted = relevant.some((operation) => (
    WORKSPACE_RECOVERY_ACTIONS.has(readString(operation.action)) &&
    readString(operation.status) === "ok"
  ));
  const readAttempted = relevant.some((operation) => readString(operation.action) === "read");
  const signals = [];
  if (readAttempted) signals.push("workspace_read_attempted");
  if (expansionAttempted) signals.push("workspace_expansion_attempted");
  return { expansionAttempted, readAttempted, signals };
}

function readSourceRecoverySignals(runState, readUrlRecoverySignal) {
  const researchContext = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const readSources = Array.isArray(researchContext.readSources) ? researchContext.readSources : [];
  const searchPasses = Array.isArray(researchContext.searchPasses) ? researchContext.searchPasses : [];
  const failedUrl = normalizeUrl(readUrlRecoverySignal && readUrlRecoverySignal.failedUrl);
  const alternateCandidateCount = Array.isArray(readUrlRecoverySignal && readUrlRecoverySignal.alternateSourceCandidates)
    ? readUrlRecoverySignal.alternateSourceCandidates.length
    : 0;
  const alternateAttempted = Boolean(failedUrl) && readSources.some((source) => {
    const url = normalizeUrl(source && source.url);
    return url && url !== failedUrl;
  });
  const hasAnyEvidenceWork = readSources.length > 0 || searchPasses.length > 0 || alternateCandidateCount > 0;
  const signals = [];
  if (searchPasses.length > 0) signals.push("web_search_attempted");
  if (readSources.length > 0) signals.push("read_url_attempted");
  if (alternateCandidateCount > 0) signals.push("alternate_source_candidates_available");
  if (alternateAttempted) signals.push("alternate_source_attempted");
  return {
    alternateAttempted,
    alternateCandidateCount,
    hasAnyEvidenceWork,
    signals
  };
}

function readObservableDeficits({ candidate, requestedLength, sourceMinimum }) {
  const statsKey = requestedLength ? readString(requestedLength.statsKey) || readStatsKeyForUnit(requestedLength.unit) : "";
  const observedLength = candidate && statsKey && Number.isFinite(candidate[statsKey])
    ? candidate[statsKey]
    : null;
  const requestedValue = requestedLength && Number.isFinite(requestedLength.value) ? requestedLength.value : null;
  return {
    lengthDeficit: requestedValue != null && observedLength != null
      ? Math.max(0, requestedValue - observedLength)
      : 0,
    lengthObserved: observedLength,
    lengthRequested: requestedValue,
    lengthUnit: requestedLength ? readString(requestedLength.unit) || null : null,
    readSourceDeficit: sourceMinimum
      ? Math.max(0, readNumber$d(sourceMinimum.minReadSources) - readNumber$d(sourceMinimum.readSources))
      : 0,
    relevantSourceDeficit: sourceMinimum
      ? Math.max(0, readNumber$d(sourceMinimum.minRelevantSources) - readNumber$d(sourceMinimum.relevantSources))
      : 0
  };
}

function readCandidateSnapshot(runState) {
  const packet = readAcceptancePacket(runState);
  const packetCandidate = packet && packet.candidate && typeof packet.candidate === "object"
    ? packet.candidate
    : null;
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const file = workspace ? readWorkspaceFinalCandidate(workspace, packetCandidate && packetCandidate.path) : null;
  const stats = normalizeTextStats$1(
    (packetCandidate && packetCandidate.textStats)
    || (file && file.textStats)
    || (workspace && workspace.quality && workspace.quality.finalCandidateStats)
  );
  if (!stats) return null;
  return {
    chars: stats.chars,
    cjkChars: stats.cjkChars,
    nonWhitespaceChars: stats.nonWhitespaceChars,
    path: readString(packetCandidate && packetCandidate.path) || readString(file && file.path) || null,
    words: stats.words
  };
}

function readRequestedLengthSnapshot(runState, context) {
  const packet = readAcceptancePacket(runState);
  const packetLength = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  if (packetLength && Number.isFinite(packetLength.value)) {
    const unit = readString(packetLength.unit) || null;
    return {
      statsKey: readString(packetLength.statsKey) || readStatsKeyForUnit(unit),
      unit,
      value: packetLength.value
    };
  }
  const assessment = context.finalReadiness &&
    context.finalReadiness.requirementsAssessment &&
    typeof context.finalReadiness.requirementsAssessment === "object"
    ? context.finalReadiness.requirementsAssessment
    : null;
  if (assessment && Number.isFinite(assessment.requestedLength)) {
    const unit = readString(assessment.observedLengthUnit) || null;
    return {
      statsKey: readStatsKeyForUnit(unit),
      unit,
      value: assessment.requestedLength
    };
  }
  const text = readTerminalContractText({
    request: context.request,
    runState
  });
  const extracted = extractRequestedLengthContract(text);
  return extracted ? {
    statsKey: readString(extracted.statsKey) || readStatsKeyForUnit(extracted.unit),
    unit: readString(extracted.unit) || null,
    value: extracted.value
  } : null;
}

function readSourceMinimum(runState) {
  const packet = readAcceptancePacket(runState);
  const source = packet && packet.evidence && packet.evidence.sourceMinimum && typeof packet.evidence.sourceMinimum === "object"
    ? packet.evidence.sourceMinimum
    : runState && runState.researchReportLoop && runState.researchReportLoop.sourceMinimum && typeof runState.researchReportLoop.sourceMinimum === "object"
      ? runState.researchReportLoop.sourceMinimum
      : null;
  if (!source) return null;
  return {
    minReadSources: readNumber$d(source.minReadSources),
    minRelevantSources: readNumber$d(source.minRelevantSources),
    passed: source.passed === true,
    readSources: readNumber$d(source.readSources),
    relevantSources: readNumber$d(source.relevantSources)
  };
}

function readReadUrlRecoverySignalSnapshot(runState) {
  const value = runState && runState.readUrlRecoverySignal && typeof runState.readUrlRecoverySignal === "object"
    ? runState.readUrlRecoverySignal
    : null;
  return value ? cloneValue(value) : null;
}

function readAcceptancePacket(runState) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  const directPacket = loop && loop.acceptancePacket && typeof loop.acceptancePacket === "object"
    ? loop.acceptancePacket
    : null;
  if (directPacket) return directPacket;
  const gateSignal = loop && loop.gateSignal && typeof loop.gateSignal === "object"
    ? loop.gateSignal
    : null;
  return gateSignal && gateSignal.acceptancePacket && typeof gateSignal.acceptancePacket === "object"
    ? gateSignal.acceptancePacket
    : null;
}

function normalizeTextStats$1(value) {
  if (!value || typeof value !== "object") return null;
  return {
    chars: readNumber$d(value.chars),
    cjkChars: readNumber$d(value.cjkChars),
    nonWhitespaceChars: readNumber$d(value.nonWhitespaceChars),
    words: readNumber$d(value.words)
  };
}

function normalizeUrl(value) {
  const text = readString(value);
  return text ? text.replace(/\/+$/, "") : "";
}

function readNumber$d(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readPositiveNumber$1(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readNullableNumber$3(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export { createRequirementRecoveryEvaluatorState, evaluateRequirementRecovery, inspectLimitedRecoveryReadiness, refreshRequirementRecoveryEvaluator, summarizeRequirementRecoveryEvaluator };
