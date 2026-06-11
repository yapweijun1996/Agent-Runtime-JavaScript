import { cloneValue } from '../runtime/utils.js';
import { createContextSnapshot, normalizeInquiryContext } from './context-snapshot-normalize.js';
import { normalizePendingClarification, normalizeClarificationResolution, isResolvedClarificationKind } from './context-snapshot-fields.js';

function projectSessionContextFromSnapshot(snapshot) {
  const normalizedSnapshot = createContextSnapshot(snapshot);
  const sessionMemory = normalizedSnapshot.sessionMemory;
  const inquiryContext = normalizedSnapshot.inquiryContext;
  const pendingClarification = normalizePendingClarification(inquiryContext.pendingClarification);
  const lastResolution = normalizeClarificationResolution(inquiryContext.lastClarificationResolution);

  return {
    activeQuery: inquiryContext.activeQuery,
    clarificationStatus: pendingClarification
      ? "pending"
      : isResolvedClarificationKind(lastResolution && lastResolution.kind)
        ? "resolved"
        : "none",
    compactedContext: sessionMemory.compactedContext || sessionMemory.summary,
    currentGoal: inquiryContext.activeGoal,
    currentTopic: inquiryContext.activeTopic,
    decisions: sessionMemory.decisions,
    facts: sessionMemory.facts,
    history: sessionMemory.history || sessionMemory.recentTurns,
    items: cloneValue(sessionMemory.items),
    lastReadSource: cloneStructuredValue$2(inquiryContext.lastReadSource),
    lastResolution: cloneStructuredValue$2(lastResolution),
    memory: sessionMemory.memory,
    openAmbiguity: pendingClarification ? pendingClarification.question : "",
    pendingClarification,
    preferences: sessionMemory.preferences,
    recentTurns: sessionMemory.recentTurns,
    selectedSource: cloneStructuredValue$2(inquiryContext.selectedSource),
    summary: sessionMemory.summary
  };
}

function createSessionContextViewFromSnapshot(snapshot) {
  const normalizedSnapshot = createContextSnapshot(snapshot);
  const projected = projectSessionContextFromSnapshot(normalizedSnapshot);

  return {
    clarificationStatus: projected.clarificationStatus,
    currentGoal: projected.currentGoal,
    currentTopic: projected.currentTopic,
    lastResolution: cloneStructuredValue$2(projected.lastResolution),
    openAmbiguity: projected.openAmbiguity,
    pendingClarification: cloneStructuredValue$2(projected.pendingClarification)
  };
}

function summarizeInquiryContext(inquiryContext) {
  const context = normalizeInquiryContext(inquiryContext);

  return {
    activeGoal: context.activeGoal || null,
    activeQuery: context.activeQuery || null,
    activeTopic: context.activeTopic || null,
    candidateSourceCount: context.candidateSources.length,
    hasPendingClarification: Boolean(context.pendingClarification),
    lastClarificationResolutionKind: readString$1U(
      context.lastClarificationResolution && context.lastClarificationResolution.kind
    ) || null,
    lastReadSourceUrl: readString$1U(context.lastReadSource && context.lastReadSource.url) || null,
    selectedSource: context.selectedSource
      ? {
          title: context.selectedSource.title || null,
          url: context.selectedSource.url
        }
      : null
  };
}

function cloneStructuredValue$2(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function readString$1U(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createSessionContextViewFromSnapshot, projectSessionContextFromSnapshot, summarizeInquiryContext };
