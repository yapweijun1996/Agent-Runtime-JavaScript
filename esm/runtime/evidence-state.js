import { readVerificationState } from './web-search-verification.js';
import { hasUsableReadSource } from './read-source-quality.js';

function classifyEvidenceState(researchContext, toolContext) {
  const context = researchContext && typeof researchContext === "object" ? researchContext : null;
  const searchResults = Array.isArray(context && context.searchResults) ? context.searchResults : [];
  const readSources = Array.isArray(context && context.readSources) ? context.readSources : [];
  const verificationState = readVerificationState(context && context.verificationState);

  if (hasUsableSource(readSources) || hasStructuredToolEvidence(toolContext)) {
    return "content_backed";
  }

  if (verificationState !== "none" || searchResults.length > 0 || readSources.length > 0) {
    return "snippet_only";
  }

  return "none";
}

function hasUsableSource(readSources) {
  return hasUsableReadSource(readSources);
}

function hasStructuredToolEvidence(toolContext) {
  const context = toolContext && typeof toolContext === "object" ? toolContext : null;

  if (hasStructuredValue(context && context.lastResult, 0)) {
    return true;
  }

  const history = Array.isArray(context && context.history) ? context.history : [];
  return history.some((entry) => hasStructuredValue(entry, 0));
}

function hasStructuredValue(value, depth) {
  if (depth > 2 || value == null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasStructuredValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return false;
    }

    return entries.some(([, item]) => hasStructuredValue(item, depth + 1));
  }

  return false;
}

export { classifyEvidenceState };
