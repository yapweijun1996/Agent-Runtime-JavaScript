import { deriveClarificationStatus, deriveOpenAmbiguity, deriveAmbiguityState } from './clarification-state.js';
import { classifyGoalQuality } from './goal-quality.js';
import { resolvePromptInquiryContext } from './inquiry-context-resolution.js';
import { classifyPromptSignal } from './task-state.js';
import { cloneValue } from './utils.js';
import { readContextSnapshot, normalizeInquiryContext } from '../session/context-snapshot-normalize.js';

async function createSemanticInputResolution(options) {
  const request = options && options.request;
  const normalizedInput = options && options.normalizedInput;
  const prompt = readPrompt$1(request, normalizedInput);
  const snapshot = readContextSnapshot(request)
    || readContextSnapshot({ contextSnapshot: options && options.contextSnapshot });
  const inquiryContext = normalizeInquiryContext(
    snapshot && snapshot.inquiryContext,
    request && request.sessionContext
  );
  // AGRUN-313-P2F (2.0 prep) — evidence classifier via the runtime config hook
  // (threaded one hop from the session as options.runtimeConfig), not a direct
  // research import. Domain-free fallback "none" when no classifier is wired.
  const classifyEvidence = options && options.runtimeConfig
    && typeof options.runtimeConfig.classifyEvidenceFn === "function"
    ? options.runtimeConfig.classifyEvidenceFn
    : () => "none";
  const evidenceState = classifyEvidence(
    options && options.researchContext,
    options && options.toolContext
  );

  return createFallbackResolution(inquiryContext, evidenceState, {
    prompt,
    snapshot,
    requestType: request && request.type,
    turnIntent: options && options.turnIntent
  });
}

function createFallbackResolution(inquiryContext, evidenceState, options) {
  const prompt = readString$i(options && options.prompt);
  const snapshot = options && options.snapshot ? options.snapshot : null;
  const goal = readString$i(inquiryContext && inquiryContext.activeGoal);
  const topic = readString$i(inquiryContext && inquiryContext.activeTopic);
  const promptSignal = classifyPromptSignal(prompt).signal;
  const upstreamTurnIntent = normalizeUpstreamTurnIntent(options && options.turnIntent);
  const resolvedContext = resolvePromptInquiryContext(inquiryContext, prompt, {
    turnIntent: upstreamTurnIntent
  });
  const turnIntentKind = resolveTurnIntentKind({
    requestType: options && options.requestType,
    resolvedContext,
    turnKind: options && options.turnKind,
    upstreamTurnIntent
  });
  const executionClass = pendingClarificationLike(resolvedContext.pendingClarification)
    ? "clarification_gate"
    : "research_loop";
  const pendingClarification = clonePendingClarification(
    resolvedContext.pendingClarification
  );
  const lastResolution = cloneValue(resolvedContext.lastClarificationResolution);
  const clarificationStatus = deriveClarificationStatus(
    pendingClarification,
    lastResolution
  );
  const goalQuality = classifyGoalQuality(resolvedContext.activeGoal || goal, resolvedContext.activeTopic || topic, {
    executionClass,
    prompt,
    turnIntent: { kind: turnIntentKind }
  }).quality;
  const activeQuery = resolvedContext.activeQuery;
  const derivedGoal = resolvedContext.activeGoal || goal;
  const derivedTopic = resolvedContext.activeTopic || topic;
  const normalizedLastResolution = cloneValue(lastResolution);

  const canonicalInquiryContext = {
    activeGoal: derivedGoal,
    activeQuery,
    activeTopic: derivedTopic,
    lastClarificationResolution: normalizedLastResolution,
    pendingClarification: cloneValue(pendingClarification)
  };

  return {
    activeQuery,
    ambiguityState: deriveAmbiguityState({
      currentGoal: derivedGoal,
      currentTopic: derivedTopic,
      evidenceState,
      fallbackClarificationStatus: clarificationStatus,
      goalQuality,
      lastResolution: normalizedLastResolution,
      pendingClarification,
      promptSignal,
      semanticHint: "none"
    }),
    clarificationStatus,
    evidenceState,
    executionClass,
    inquiryContext: canonicalInquiryContext,
    intentState: {
      clarificationStatus,
      goal: derivedGoal,
      hasEvidenceSignal: evidenceState !== "none",
      hasUserClarification: resolvedContext.hasUserClarification === true,
      lastResolution: normalizedLastResolution,
      openAmbiguity: deriveOpenAmbiguity(pendingClarification),
      pendingClarification: cloneValue(pendingClarification),
      topic: derivedTopic
    },
    shouldUseRecall: shouldUseSemanticRecall(prompt, inquiryContext, snapshot),
    turnIntent: {
      clarificationReply: null,
      followUpTarget: null,
      goal: derivedGoal || prompt,
      kind: turnIntentKind,
      needsClarification: clarificationStatus === "pending",
      resetContext: false,
      topic: derivedTopic
    }
  };
}

function normalizeUpstreamTurnIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const kind = readString$i(value.kind);
  return {
    ...value,
    kind
  };
}

function resolveTurnIntentKind(options) {
  if (readString$i(options && options.requestType) === "approval_resolution") {
    return "approval_resolution";
  }
  const upstreamKind = readString$i(options && options.upstreamTurnIntent && options.upstreamTurnIntent.kind);
  if (upstreamKind) return upstreamKind;
  const explicitTurnKind = readString$i(options && options.turnKind);
  if (explicitTurnKind) return explicitTurnKind;
  return readString$i(options && options.resolvedContext && options.resolvedContext.turnKind) || "unknown";
}

function pendingClarificationLike(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shouldUseSemanticRecall(prompt, inquiryContext, snapshot) {
  const normalizedPrompt = readString$i(prompt).toLowerCase();

  if (!normalizedPrompt || !hasConfirmedSessionMemory(inquiryContext, snapshot)) {
    return false;
  }

  return (
    /^what is my\b/.test(normalizedPrompt) ||
    /^what's my\b/.test(normalizedPrompt) ||
    /^what language should you reply in\b/.test(normalizedPrompt) ||
    /^what did we decide\b/.test(normalizedPrompt)
  );
}

function hasConfirmedSessionMemory(inquiryContext, snapshot) {
  const sessionMemory = snapshot &&
    snapshot.sessionMemory &&
    typeof snapshot.sessionMemory === "object"
    ? snapshot.sessionMemory
    : null;

  return Boolean(
    inquiryContext &&
    (
      readString$i(inquiryContext.activeGoal) ||
      readString$i(inquiryContext.activeTopic) ||
      inquiryContext.lastClarificationResolution ||
      (sessionMemory && (
        readString$i(sessionMemory.decisions) ||
        readString$i(sessionMemory.facts) ||
        readString$i(sessionMemory.history) ||
        readString$i(sessionMemory.preferences) ||
        readString$i(sessionMemory.recentTurns) ||
        readString$i(sessionMemory.summary) ||
        (Array.isArray(sessionMemory.items) && sessionMemory.items.length > 0)
      ))
    )
  );
}

function clonePendingClarification(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function readPrompt$1(request, normalizedInput) {
  if (request && typeof request.prompt === "string") {
    return request.prompt.trim();
  }

  if (normalizedInput && typeof normalizedInput.text === "string") {
    return normalizedInput.text.trim();
  }

  return "";
}

function readString$i(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createFallbackResolution, createSemanticInputResolution };
