import { aggregateRankedSearchResults } from '../skills/providers/web-search-ranking.js';
import { cloneValue } from './utils.js';
import { normalizeCandidateSource } from '../session/context-snapshot-fields.js';
import { createSearchVerification, readVerificationState } from './web-search-verification.js';
import { resolveSearchPassesCap, DEFAULT_SEARCH_PASSES_CAP, resolveReadSourcesCap, DEFAULT_READ_SOURCES_CAP } from './evidence-policy.js';

// SSOT for appending a read_url source to runState.researchContext.readSources,
// shared by BOTH dispatch paths (single action in action-loop-action.js, plan
// batch in action-loop-plan-actions.js). Each source can carry full page text +
// screenshot base64, so it caps the array to the most-recent entries
// (drop-oldest) to keep a long / hydrated research run bounded (audit H6 /
// AGRUN-484). Cap is host-overridable via evidencePolicy.readSourcesCap.
function appendResearchReadSource(runState, readSource, runtimeConfig) {
  if (!runState || typeof runState !== "object") return;
  if (!runState.researchContext || typeof runState.researchContext !== "object") return;
  if (!Array.isArray(runState.researchContext.readSources)) {
    runState.researchContext.readSources = [];
  }
  runState.researchContext.readSources.push(readSource);
  const limit = resolveReadSourcesCap(runtimeConfig) || DEFAULT_READ_SOURCES_CAP;
  if (runState.researchContext.readSources.length > limit) {
    runState.researchContext.readSources.splice(
      0, runState.researchContext.readSources.length - limit
    );
  }
}

function appendWebSearchOutput(researchContext, output, runtimeConfig) {
  const context = researchContext && typeof researchContext === "object"
    ? researchContext
    : {};
  const searchPasses = Array.isArray(context.searchPasses)
    ? context.searchPasses.slice()
    : [];
  const appendedPasses = Array.isArray(output && output.searchPasses)
    ? output.searchPasses
    : [];
  // Audit M6 (AGRUN-489) — bound searchPasses (drop-oldest) BEFORE aggregation.
  // Capping the array keeps memory bounded across a long run AND keeps
  // aggregateRankedSearchResults' cost linear in the cap instead of growing
  // quadratically as passes accumulate. Cap host-overridable via
  // evidencePolicy.searchPassesCap.
  const combinedPasses = searchPasses.concat(cloneValue(appendedPasses));
  const limit = resolveSearchPassesCap(runtimeConfig) || DEFAULT_SEARCH_PASSES_CAP;
  if (combinedPasses.length > limit) {
    combinedPasses.splice(0, combinedPasses.length - limit);
  }
  const readSources = Array.isArray(context.readSources) ? context.readSources.slice() : [];
  const aggregatedSearchResults = aggregateRankedSearchResults(combinedPasses);
  const verification = createSearchVerification({
    query: readString$14(output && output.query) || readString$14(context && context.lastQuery),
    rankedItems: aggregatedSearchResults,
    readSources,
    strategy: output && output.searchPlan ? output.searchPlan.strategy : ""
  });
  const compatibilityItems = aggregatedSearchResults.slice(0, readOutputArray(output, "items", "rankedItems").length || 5);

  return {
    aggregatedSearchResults: cloneValue(aggregatedSearchResults),
    lastQuery: readString$14(output && output.lastExecutedQuery) || readString$14(output && output.query) || null,
    readSources,
    searchPasses: combinedPasses,
    searchPlan: cloneValue(output && output.searchPlan) || null,
    searchResults: cloneValue(compatibilityItems),
    verification: cloneValue(verification),
    verificationState: readVerificationState(verification)
  };
}

function createSearchInquirySources(output, limit = 5) {
  return readOutputArray(output, "rankedItems", "items")
    .map((item) => normalizeCandidateSource(item))
    .filter(Boolean)
    .slice(0, limit);
}

function readOutputArray(output, ...keys) {
  const source = output && typeof output === "object" ? output : null;

  for (const key of keys) {
    if (Array.isArray(source && source[key])) {
      return source[key];
    }
  }

  return [];
}

function readString$14(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { appendResearchReadSource, appendWebSearchOutput, createSearchInquirySources };
