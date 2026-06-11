import { deriveClarificationStatus, deriveAmbiguityState, detectClarificationLoopRisk, deriveOpenAmbiguity } from './clarification-state.js';
import { classifyGoalQuality } from './goal-quality.js';

function createObservationSummary(request, normalizedInput) {
  const prompt = readPrompt$2(request, normalizedInput);
  const promptSignal = classifyPromptSignal(prompt);

  return {
    isActionLike: promptSignal.isActionLike,
    isLowSignal: promptSignal.isLowSignal,
    isQuestionLike: promptSignal.isQuestionLike,
    prompt,
    promptSignal: promptSignal.signal
  };
}

function createPlannerState(request, observationSummary, inputResolution) {
  const normalizedResolution = normalizeInputResolution(inputResolution, observationSummary);
  const intentState = normalizedResolution.intentState;
  const inquiryContext = normalizedResolution.inquiryContext;
  const prompt = readPrompt$2(request, observationSummary);
  const turnIntent = normalizedResolution.turnIntent;
  const executionClass = readString$1b(normalizedResolution.executionClass) || null;
  const goalQuality = classifyGoalQuality(inquiryContext.activeGoal, inquiryContext.activeTopic, {
        executionClass,
        prompt,
        turnIntent
      });
  const clarificationStatus = deriveClarificationStatus(
    inquiryContext.pendingClarification,
    inquiryContext.lastClarificationResolution,
    intentState.clarificationStatus
  );
  const openAmbiguity = deriveOpenAmbiguity(inquiryContext.pendingClarification);
  const ambiguityState = deriveAmbiguityState({
    currentGoal: inquiryContext.activeGoal,
    currentTopic: inquiryContext.activeTopic,
    evidenceState: normalizedResolution.evidenceState,
    fallbackClarificationStatus: clarificationStatus,
    goalQuality: goalQuality.quality,
    lastResolution: inquiryContext.lastClarificationResolution,
    pendingClarification: inquiryContext.pendingClarification,
    promptSignal: readPlannerPromptSignal(request, observationSummary),
    semanticHint: ""
  });

  return {
    activeQuery: readString$1b(normalizedResolution.activeQuery),
    activeTask: inquiryContext.activeGoal || prompt,
    ambiguityState,
    clarificationStatus,
    currentGoal: inquiryContext.activeGoal,
    currentTopic: inquiryContext.activeTopic,
    evidenceState: normalizedResolution.evidenceState,
    goalEqualsTopic: goalQuality.goalEqualsTopic,
    goalLooksLikeQuestion: goalQuality.goalLooksLikeQuestion,
    goalQuality: goalQuality.quality,
    hasEvidenceSignal: intentState.hasEvidenceSignal,
    hasOpenAmbiguity: openAmbiguity.length > 0,
    hasUserClarification: intentState.hasUserClarification,
    inquiryContext,
    openAmbiguity,
    pendingClarification: inquiryContext.pendingClarification,
    promptSignal: readPlannerPromptSignal(request, observationSummary),
    shouldUseRecall: normalizedResolution.shouldUseRecall === true,
    executionClass,
    lastResolution: inquiryContext.lastClarificationResolution,
    unresolvedDetail: openAmbiguity
  };
}

function createEvaluationState(options) {
  const actionName = readString$1b(options && options.actionName);
  const plannerState = options && typeof options === "object" ? options.plannerState : null;
  const turnState = options && typeof options === "object" ? options.turnState : null;
  const evidenceState = readString$1b(plannerState && plannerState.evidenceState) || "none";
  const promptSignal = readString$1b(plannerState && plannerState.promptSignal) || "empty";
  const pendingClarification = plannerState && plannerState.pendingClarification
    ? plannerState.pendingClarification
    : null;
  const lastResolution = plannerState && plannerState.lastResolution
    ? plannerState.lastResolution
    : null;
  const clarificationStatus = deriveClarificationStatus(
    pendingClarification,
    lastResolution,
    plannerState && plannerState.clarificationStatus
  );
  const ambiguityState = deriveAmbiguityState({
    currentGoal: readString$1b(plannerState && plannerState.currentGoal),
    currentTopic: readString$1b(plannerState && plannerState.currentTopic),
    evidenceState,
    fallbackClarificationStatus: clarificationStatus,
    goalQuality: readString$1b(plannerState && plannerState.goalQuality),
    lastResolution,
    pendingClarification,
    promptSignal,
    semanticHint: ""
  });
  const clarificationLoopRisk = detectClarificationLoopRisk({
    actionName,
    currentGoal: readString$1b(plannerState && plannerState.currentGoal),
    currentTopic: readString$1b(plannerState && plannerState.currentTopic),
    evidenceState,
    lastResolution,
    pendingClarification,
    promptSignal,
    recentTurns: readString$1b(options && options.sessionContext && options.sessionContext.recentTurns),
    semanticHint: ""
  });

  return {
    actionName: actionName || null,
    ambiguityState,
    clarificationStatus,
    clarificationLoopRisk,
    evidenceState,
    hasExternalEvidence: Boolean(turnState && turnState.hasEvidenceSignal) || evidenceState !== "none",
    hasUserClarification: Boolean(
      plannerState && plannerState.hasUserClarification
    ) || Boolean(turnState && turnState.hasUserClarification),
    nextState: readString$1b(options && options.nextState) || null,
    openAmbiguity: deriveOpenAmbiguity(pendingClarification) || null,
    outcome: readString$1b(options && options.outcome) || null
  };
}

function classifyPromptSignal(prompt) {
  const text = trimTrailingPunctuation(prompt).toLowerCase();

  if (!text) {
    return createPromptSignal("empty", false, false, true);
  }

  if (isLowSignalPrompt(text)) {
    return createPromptSignal("low", false, false, true);
  }

  // AGRUN-246-D C2.2/C2.3: prompt-shape is no longer lexically classified here.
  // The English action-verb / question-word lexicons (formerly isActionLikeText /
  // isQuestionLikeText) misclassified non-English prompts, and the resulting
  // isActionLike / isQuestionLike booleans were never read downstream — only
  // "low" vs not-low matters (clarification-state.js low-signal gating), and
  // that is owned by isLowSignalPrompt, a length/triviality check, not a
  // lexicon. Real prompt intent is AI/router-owned via turnIntent.kind.
  return createPromptSignal("high", false, false, false);
}

function createPromptSignal(signal, isActionLike, isQuestionLike, isLowSignal) {
  return {
    isActionLike,
    isLowSignal,
    isQuestionLike,
    signal
  };
}

function normalizeInputResolution(inputResolution, observationSummary) {
  const source = inputResolution && typeof inputResolution === "object"
    ? inputResolution
    : {};
  const intentState = source.intentState && typeof source.intentState === "object"
    ? source.intentState
    : {
        clarificationStatus: "none",
        goal: "",
        hasEvidenceSignal: false,
        hasUserClarification: false,
        lastResolution: null,
        openAmbiguity: "",
        pendingClarification: null,
        topic: ""
      };

  return {
    activeQuery: readString$1b(source.activeQuery),
    evidenceState: readString$1b(source.evidenceState) || "none",
    inquiryContext: normalizePlannerInquiryContext(
      source.inquiryContext && typeof source.inquiryContext === "object"
        ? source.inquiryContext
        : intentState
    ),
    shouldUseRecall: source.shouldUseRecall === true,
    executionClass: readString$1b(source.executionClass) || null,
    turnIntent: source.turnIntent && typeof source.turnIntent === "object"
      ? source.turnIntent
      : null,
    intentState: {
      ...intentState,
      clarificationStatus: deriveClarificationStatus(
        intentState.pendingClarification,
        intentState.lastResolution,
        intentState.clarificationStatus
      ),
      openAmbiguity: deriveOpenAmbiguity(intentState.pendingClarification)
    },
    observationSummary: observationSummary && typeof observationSummary === "object"
      ? observationSummary
      : null
  };
}

function isLowSignalPrompt(value) {
  const text = trimTrailingPunctuation(value).toLowerCase();

  if (!text || text.length <= 3) {
    return true;
  }

  return /^(yes|no|ok|okay|sure|yep|yup|nah|all|more)$/i.test(text);
}

function trimTrailingPunctuation(value) {
  return readString$1b(value).replace(/[.?!]+$/g, "").trim();
}

function readPrompt$2(request, normalizedInput) {
  if (request && typeof request.prompt === "string") {
    return request.prompt.trim();
  }

  if (normalizedInput && typeof normalizedInput.text === "string") {
    return normalizedInput.text.trim();
  }

  return "";
}

function readPlannerPromptSignal(request, observationSummary) {
  const explicit = readString$1b(observationSummary && observationSummary.promptSignal);
  return explicit || classifyPromptSignal(readPrompt$2(request, null)).signal;
}

function normalizePlannerInquiryContext(value) {
  const source = value && typeof value === "object" ? value : {};

  return {
    activeGoal: readString$1b(source.activeGoal || source.goal),
    activeQuery: readString$1b(source.activeQuery),
    activeTopic: readString$1b(source.activeTopic || source.topic),
    lastClarificationResolution: source.lastClarificationResolution || source.lastResolution || null,
    pendingClarification: source.pendingClarification && typeof source.pendingClarification === "object"
      ? source.pendingClarification
      : null
  };
}

function readString$1b(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { classifyPromptSignal, createEvaluationState, createObservationSummary, createPlannerState };
