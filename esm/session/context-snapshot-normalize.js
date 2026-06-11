import { cloneValue } from '../runtime/utils.js';
import { normalizeCandidateSources, normalizeCandidateSource, inferSelectedSource, normalizePendingClarification, normalizeReadSource, normalizeClarificationResolution } from './context-snapshot-fields.js';
export { isResolvedClarificationKind } from './context-snapshot-fields.js';

function createContextSnapshot(options) {
  return {
    continuityResolution: normalizeContinuityResolution(options && options.continuityResolution),
    inquiryContext: normalizeInquiryContext(options && options.inquiryContext),
    sessionMemory: normalizeSessionMemory(options && options.sessionMemory),
    turnIntent: normalizeTurnIntent(options && options.turnIntent)
  };
}

function readContextSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  if (hasSnapshotShape(value)) {
    return createContextSnapshot(value);
  }

  if (value.contextSnapshot && hasSnapshotShape(value.contextSnapshot)) {
    return createContextSnapshot(value.contextSnapshot);
  }

  return null;
}

function normalizeInquiryContext(value, fallbackLegacyContext) {
  const legacy = adaptLegacySessionContext(fallbackLegacyContext);
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

  if (!source) {
    return legacy;
  }

  const candidateSources = hasOwn$2(source, "candidateSources")
    ? normalizeCandidateSources(source.candidateSources, [])
    : normalizeCandidateSources(undefined, legacy.candidateSources);
  const selectedSource = hasOwn$2(source, "selectedSource")
    ? normalizeCandidateSource(source.selectedSource)
    : normalizeCandidateSource(source.selectedSource) || inferSelectedSource(candidateSources, legacy.selectedSource);

  return {
    activeGoal: hasOwn$2(source, "activeGoal") ? readAnchorText(source.activeGoal) : legacy.activeGoal,
    activeQuery: hasOwn$2(source, "activeQuery") ? readString$1V(source.activeQuery) : legacy.activeQuery,
    activeTopic: hasOwn$2(source, "activeTopic") ? readAnchorText(source.activeTopic) : legacy.activeTopic,
    candidateSources,
    lastClarificationResolution: hasOwn$2(source, "lastClarificationResolution")
      ? normalizeClarificationResolution(source.lastClarificationResolution)
      : legacy.lastClarificationResolution,
    lastReadSource: hasOwn$2(source, "lastReadSource")
      ? normalizeReadSource(source.lastReadSource)
      : legacy.lastReadSource,
    lastSearchResults: hasOwn$2(source, "lastSearchResults")
      ? normalizeCandidateSources(source.lastSearchResults, [])
      : normalizeCandidateSources(undefined, legacy.lastSearchResults),
    pendingClarification: hasOwn$2(source, "pendingClarification")
      ? normalizePendingClarification(source.pendingClarification)
      : normalizePendingClarification(undefined, legacy.pendingClarification),
    selectedSource: selectedSource || null
  };
}

function adaptLegacySessionContext(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  const fallbackQuestion = readString$1V(source && source.openAmbiguity);

  return {
    ...createEmptyInquiryContext(),
    activeGoal: readAnchorText(source && source.currentGoal),
    activeTopic: readAnchorText(source && source.currentTopic),
    lastClarificationResolution: normalizeClarificationResolution(source && source.lastResolution),
    pendingClarification: normalizePendingClarification(
      source && source.pendingClarification,
      fallbackQuestion
    )
  };
}

function createEmptySessionMemory() {
  return {
    compactedContext: "",
    decisions: "",
    estimatedTokens: 0,
    facts: "",
    history: "",
    items: [],
    memory: "",
    preferences: "",
    recentTurns: "",
    summary: ""
  };
}

function createEmptyInquiryContext() {
  return {
    activeGoal: "",
    activeQuery: "",
    activeTopic: "",
    candidateSources: [],
    lastClarificationResolution: null,
    lastReadSource: null,
    lastSearchResults: [],
    pendingClarification: null,
    selectedSource: null
  };
}

function hasSnapshotShape(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (
      hasOwn$2(value, "sessionMemory") ||
      hasOwn$2(value, "inquiryContext") ||
      hasOwn$2(value, "turnIntent") ||
      hasOwn$2(value, "continuityResolution")
    )
  );
}

function normalizeSessionMemory(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

  if (!source) {
    return createEmptySessionMemory();
  }

  return {
    compactedContext: readString$1V(source.compactedContext),
    decisions: readString$1V(source.decisions),
    estimatedTokens: typeof source.estimatedTokens === "number" ? source.estimatedTokens : 0,
    facts: readString$1V(source.facts),
    history: readString$1V(source.history),
    items: Array.isArray(source.items) ? cloneValue(source.items) : [],
    memory: readString$1V(source.memory),
    preferences: readString$1V(source.preferences),
    recentTurns: readString$1V(source.recentTurns),
    summary: readString$1V(source.summary) || readString$1V(source.compactedContext)
  };
}

function normalizeTurnIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const kind = readString$1V(value.kind);

  if (!kind) {
    return null;
  }

  return {
    clarificationReply: cloneStructuredValue$3(value.clarificationReply),
    followUpTarget: cloneStructuredValue$3(value.followUpTarget),
    goal: readString$1V(value.goal),
    kind,
    needsClarification: value.needsClarification === true,
    topic: readString$1V(value.topic)
  };
}

function normalizeContinuityResolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const kind = readString$1V(value.kind);

  if (!kind) {
    return null;
  }

  return {
    confidence: typeof value.confidence === "number" ? value.confidence : null,
    decision: cloneStructuredValue$3(value.decision),
    kind,
    pendingClarification: cloneStructuredValue$3(value.pendingClarification),
    selectedUrl: readString$1V(value.selectedUrl) || null,
    source: readString$1V(value.source) || null
  };
}

function cloneStructuredValue$3(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function hasOwn$2(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readString$1V(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readAnchorText(value) {
  return readString$1V(value).replace(/[.?!]+$/g, "").trim();
}

export { adaptLegacySessionContext, createContextSnapshot, createEmptyInquiryContext, createEmptySessionMemory, normalizeCandidateSource, normalizeCandidateSources, normalizeClarificationResolution, normalizeInquiryContext, normalizePendingClarification, normalizeReadSource, readContextSnapshot };
