import { readString } from './semantic-json.js';
import { cloneValue } from './utils.js';
import { createCycleRecord, startPhase, completePhase, createObserveRecord, createOrientRecord } from './oodae.js';
import { createFallbackResolution, createSemanticInputResolution } from './semantic-input-resolution.js';
import { createObservationSummary } from './task-state.js';
import { countBlockedReadSources, countReadSourcesByTier } from './read-source-quality.js';
import { createTurnState } from './turn-state.js';
import { computeTrajectorySignal, detectDrift, formatDriftReminder } from './drift-detector.js';
import { classifyExecutionClass } from './execution-class.js';
import { createContextSnapshot, normalizeInquiryContext } from '../session/context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot, createSessionContextViewFromSnapshot } from '../session/context-snapshot-projection.js';
import { createControlEnvelopeDetail } from './control-envelope.js';
import { summarizeSessionContextMeta } from '../session/prompt.js';

async function beginActionLoopCycle(session, strategy, options = {}) {
  const continuingInterruptedTurn = options && options.continuingInterruptedTurn === true;
  if (!continuingInterruptedTurn) {
    session.runState.cycleCount += 1;
    session.runState.turnCount = session.runState.cycleCount;
    // ADR-0013: reset list_agent_skills budget counter at the start of each
    // cycle so the 5-call limit applies per turn, not per session.
    if (session.runState.agentSkillContext) {
      session.runState.agentSkillContext.listSkillsCallsThisTurn = 0;
    }
    // AGRUN-486 (audit H8): the recovery retry counter is NO LONGER reset per
    // cycle. The old unconditional reset (ADR-0014 PR 2) is exactly what made
    // the repair budget dead code — retries was always 0 at planner time, so
    // isRecoveryBudgetExhausted never fired. The budget now reflects a streak
    // of consecutive failed-repair cycles and is cleared by resetRecoveryBudget
    // the moment a valid decision is produced (action-loop-planner.js), which
    // preserves the original "don't starve a long session after one bad turn"
    // intent while letting the budget actually gate the N+1 repair LLM call.
  }
  session.pushStep("cycle-started", {
    continuingInterruptedTurn,
    cycle: session.runState.cycleCount,
    inputType: session.normalizedInput.type,
    mode: session.runState.mode
  });
  const cycleRecord = createCycleRecord(session.runState);
  const observationSummary = createObservationSummary(session.request, session.normalizedInput);
  session.runState.observationSummary = cloneValue(observationSummary);

  startPhase(session.runState, session.pushStep, "observe", {
    continuingInterruptedTurn,
    cycle: session.runState.cycleCount,
    inputType: session.normalizedInput.type
  });
  const observeRecord = completePhase(
    cycleRecord,
    session.pushStep,
    "observe",
    {
      ...createObserveRecord(session.normalizedInput, session.memoryFacade, session.runState),
      observationSummary: cloneValue(observationSummary)
    }
  );

  startPhase(session.runState, session.pushStep, "orient", {
    continuingInterruptedTurn,
    cycle: session.runState.cycleCount,
    inputType: observeRecord.inputType
  });
  const inputResolution = await resolveInputResolution(session, observationSummary);
  let contextSnapshot = buildTurnContextSnapshot(session.runState.contextSnapshot, inputResolution);
  // ADR-0028 — `resolveResearchContinuation` deleted. Runtime no longer
  // auto-picks the next URL after web_search nor force-finalizes with
  // the "summarize_limits" instruction when read attempts hit a cap.
  // Read-attempt count is exposed as `runState.readAttemptSignal` for
  // the AI to read on the next planner cycle and decide for itself.
  contextSnapshot = createContextSnapshot({
    ...contextSnapshot,
    continuityResolution: null
  });

  const projectedSessionContext = projectSessionContextFromSnapshot(contextSnapshot);
  const executionClass = classifyExecutionClass(inputResolution, contextSnapshot);
  const turnState = createTurnState({
    executionClass,
    inquiryContext: contextSnapshot.inquiryContext,
    inputResolution,
    observationSummary,
    originalQuery: session.runState.originalQuery,
    pendingApproval: session.runState.pendingApproval,
    // 2026-05-09 — pass `runState` so turn-state can read
    // `researchState.topic` (AI-authored via tool calls) before
    // falling back to raw `intentState.topic` /
    // `inquiryContext.activeTopic`. The AGRUN-214o P4 verbatim-prompt
    // collapse path was deleted as push-mode anti-pattern; this
    // pass-through is now pure state read for the AI-first topic
    // anchor lookup.
    runState: session.runState,
    turnIntent: inputResolution.turnIntent
  });
  session.runState.inputResolution = cloneValue(inputResolution);
  session.runState.intentState = cloneValue(inputResolution.intentState || null);
  session.runState.executionClass = executionClass;
  session.runState.contextSnapshot = cloneValue(contextSnapshot);
  // ADR-0028 — continuityResolution field deleted. readAttemptSignal already
  // assigned above.
  session.runState.turnState = cloneValue(turnState);
  session.runState.driftSignal = evaluateCycleDrift(session, turnState);
  session.runState.blockedPageEvidenceCount = countBlockedReadSources(
    session.runState.researchContext && session.runState.researchContext.readSources
  );
  session.runState.usableReadSourceCount = countReadableTiers(
    session.runState.researchContext && session.runState.researchContext.readSources,
    "usable",
    "strong"
  );
  session.runState.strongReadSourceCount = countReadSourcesByTier(
    session.runState.researchContext && session.runState.researchContext.readSources,
    "strong"
  );
  // ADR-0028 — readAttemptSignal: read-only signal exposed to the AI on
  // the next planner cycle. Mirrors how `actionFailureSignal` works
  // (ADR-0026): runtime records, AI decides. Threshold is informational;
  // runtime does not enforce it.
  session.runState.readAttemptSignal = summarizeReadAttemptSignal(session.runState.researchContext);
  session.runState.sessionContextMeta = projectedSessionContext
    ? summarizeSessionContextMeta(projectedSessionContext)
    : null;
  session.runState.sessionContextView = projectedSessionContext
    ? createSessionContextViewFromSnapshot(contextSnapshot)
    : null;
  // ADR-0028 — `continuity-resolved` step removed (resolveResearchContinuation
  // deletion). AI sees readAttemptSignal in next planner cycle.
  completePhase(cycleRecord, session.pushStep, "orient", {
    ...createOrientRecord(observeRecord, session.runtimeConfig),
    ambiguityState: inputResolution.ambiguityState,
    availableActions: cloneValue(session.availableActions.map((action) => action.name)),
    clarificationStatus: readString(inputResolution && inputResolution.clarificationStatus) || "none",
    executionClass: session.runState.executionClass,
    evidenceState: inputResolution.evidenceState,
    intentState: cloneValue(inputResolution.intentState || null),
    mode: session.runState.mode,
    observationSummary: cloneValue(observationSummary),
    pendingApproval: cloneValue(session.runState.pendingApproval),
    selectedAction: session.runState.lastAction,
    readAttemptSignal: cloneValue(session.runState.readAttemptSignal || null),
    strongReadSourceCount: session.runState.strongReadSourceCount,
    usableReadSourceCount: session.runState.usableReadSourceCount,
    ...createControlEnvelopeDetail(session.runState),
    turnState: cloneValue(turnState)
  });

  startPhase(session.runState, session.pushStep, "decide", {
    continuingInterruptedTurn,
    cycle: session.runState.cycleCount,
    strategy
  });

  return cycleRecord;
}

async function resolveInputResolution(session, observationSummary) {
  const consumedApprovalEnvelope = session.runState &&
    session.runState.controlEnvelopeKind === "approval_resolution" &&
    session.runState.controlEnvelopeConsumed === true;

  // AGRUN-313-P2F (2.0 prep) — read the evidence classifier from the runtime
  // config hook instead of importing the research function. config.js wires the
  // research default, so behavior is byte-identical; a domain-free runtime that
  // never wires it falls back to "none" (no evidence concept in the kernel).
  const classifyEvidence = session.runtimeConfig
    && typeof session.runtimeConfig.classifyEvidenceFn === "function"
    ? session.runtimeConfig.classifyEvidenceFn
    : () => "none";

  if (consumedApprovalEnvelope) {
    const resolution = createFallbackResolution(
      normalizeInquiryContext(session.runState.contextSnapshot && session.runState.contextSnapshot.inquiryContext),
      classifyEvidence(session.runState.researchContext, session.runState.toolContext),
      {
        turnKind: "approval_resolution"
      }
    );
    return resolution;
  }

  if (session.request && session.request.type !== "approval_resolution") {
    return createSemanticInputResolution({
      contextSnapshot: session.runState.contextSnapshot,
      normalizedInput: session.normalizedInput,
      observationSummary,
      request: session.request,
      researchContext: session.runState.researchContext,
      runtimeConfig: session.runtimeConfig,
      toolContext: session.runState.toolContext,
      turnIntent: session.turnIntent
    });
  }

  return createFallbackResolution(
    normalizeInquiryContext(session.runState.contextSnapshot && session.runState.contextSnapshot.inquiryContext),
    classifyEvidence(session.runState.researchContext, session.runState.toolContext),
    {
      turnKind: session.request && session.request.type === "approval_resolution"
        ? "approval_resolution"
        : "unknown",
      turnIntent: session.turnIntent
    }
  );
}

function buildTurnContextSnapshot(baseSnapshot, inputResolution) {
  const snapshot = createContextSnapshot(baseSnapshot || null);
  const inquiryContext = inputResolution &&
    inputResolution.inquiryContext &&
    typeof inputResolution.inquiryContext === "object"
      ? inputResolution.inquiryContext
      : null;
  const intentState = inputResolution && typeof inputResolution.intentState === "object"
    ? inputResolution.intentState
    : null;
  const activeQuery = readString(inputResolution && inputResolution.activeQuery);

  if (!inquiryContext && !intentState) {
    return createContextSnapshot(snapshot);
  }

  const nextInquiryContext = normalizeInquiryContext({
    ...snapshot.inquiryContext,
    activeGoal: readString(inquiryContext && inquiryContext.activeGoal)
      || readString(intentState && intentState.goal)
      || snapshot.inquiryContext.activeGoal,
    activeQuery: activeQuery || snapshot.inquiryContext.activeQuery,
    activeTopic: readString(inquiryContext && inquiryContext.activeTopic)
      || readString(intentState && intentState.topic)
      || snapshot.inquiryContext.activeTopic,
    lastClarificationResolution: hasOwnValue(inquiryContext, "lastClarificationResolution")
      ? inquiryContext.lastClarificationResolution
      : intentState && intentState.lastResolution
        ? intentState.lastResolution
        : snapshot.inquiryContext.lastClarificationResolution,
    pendingClarification: hasOwnValue(inquiryContext, "pendingClarification")
      ? inquiryContext.pendingClarification
      : hasOwnValue(intentState, "pendingClarification")
        ? intentState.pendingClarification
      : snapshot.inquiryContext.pendingClarification
  });

  return createContextSnapshot({
    ...snapshot,
    inquiryContext: nextInquiryContext,
    turnIntent: inputResolution && inputResolution.turnIntent
      ? inputResolution.turnIntent
      : snapshot.turnIntent
  });
}

function hasOwnValue(value, key) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function countReadableTiers(readSources, ...tiers) {
  return tiers.reduce((total, tier) => total + countReadSourcesByTier(readSources, tier), 0);
}

// ADR-0028 — read-only signal exposed to the AI on the next planner cycle.
// Populated when `researchContext.readSources.length` is non-zero. Threshold
// (2) is informational only — runtime does not enforce it. AI sees the
// signal in the planner prompt and decides whether to read more, finalize,
// or switch tactics. If AI keeps retrying without progress, `maxSteps`
// terminates. Mirrors the `actionFailureSignal` pattern (ADR-0026).
const READ_ATTEMPT_SIGNAL_THRESHOLD = 2;

function summarizeReadAttemptSignal(researchContext) {
  if (!researchContext || typeof researchContext !== "object") {
    return null;
  }
  const readSources = Array.isArray(researchContext.readSources)
    ? researchContext.readSources
    : [];
  const attemptCount = readSources.length;
  if (attemptCount <= 0) {
    return null;
  }
  return {
    attemptCount,
    threshold: READ_ATTEMPT_SIGNAL_THRESHOLD
  };
}

// AGRUN-146 — Per-cycle drift check. Stays silent unless the host opted in
// via `runtimeConfig.driftDetection.enabled = true`. The verdict is stashed
// on runState and consumed exactly once by the planner step, which appends
// a reminder line into plannerDirectives and then clears the slot.
function evaluateCycleDrift(session, turnState) {
  const config = session.runtimeConfig && session.runtimeConfig.driftDetection;
  if (!config || config.enabled !== true) return null;
  const goalAnchorText = readString(turnState && turnState.goalAnchorText);
  if (!goalAnchorText) return null;
  const trajectoryText = computeTrajectorySignal(session.runState, {
    maxEntries: config.maxTrajectoryEntries
  });
  if (!trajectoryText) return null;
  const verdict = detectDrift({
    goalAnchorText,
    trajectoryText,
    cycleCount: session.runState.cycleCount,
    cycleInterval: config.cycleInterval,
    severeThreshold: config.severeThreshold,
    mildThreshold: config.mildThreshold,
    similarityFn: config.similarityFn
  });
  if (!verdict) return null;
  const reminder = formatDriftReminder(verdict);
  if (reminder) {
    session.pushStep("drift-detected", {
      action: verdict.action,
      cycle: verdict.cycleCount,
      cycleInterval: verdict.cycleInterval,
      drift: verdict.drift,
      method: verdict.method,
      similarity: verdict.similarity
    });
  }
  return { ...verdict, reminder };
}

export { beginActionLoopCycle };
