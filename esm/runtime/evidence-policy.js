import { readString } from './semantic-json.js';
import { WEB_SEARCH_ACTION, READ_URL_ACTION } from './action-names.js';

const DEFAULT_WEB_RESEARCH_RECOVERY_ACTIONS = Object.freeze([WEB_SEARCH_ACTION, READ_URL_ACTION]);
// Audit H5 (AGRUN-483) — bound runState.toolContext.history growth. Default 50
// most-recent entries; host-overridable via evidencePolicy.toolHistoryCap.
const DEFAULT_TOOL_HISTORY_CAP = 50;
// Audit H6 (AGRUN-484) — bound runState.researchContext.readSources growth.
// Each read source can carry full page text + screenshot base64 (MB-scale), so
// without a cap a long / hydrated research run accumulates unboundedly. Default
// 50 most-recent entries; host-overridable via evidencePolicy.readSourcesCap.
const DEFAULT_READ_SOURCES_CAP = 50;
// Audit M6 (AGRUN-489) — bound runState.researchContext.searchPasses growth.
// appendWebSearchOutput concats every web_search pass onto the prior array and
// re-aggregates over the whole array, so a long run grows the array unboundedly
// AND drives aggregateRankedSearchResults' cost up quadratically. Default 50
// most-recent passes; host-overridable via evidencePolicy.searchPassesCap.
const DEFAULT_SEARCH_PASSES_CAP = 50;

function normalizeEvidencePolicyConfig(value) {
  if (value === false) {
    return {
      enabled: false,
      profile: "host",
      recoveryActions: [],
      structuredToolEvidence: true,
      toolHistoryCap: DEFAULT_TOOL_HISTORY_CAP,
      readSourcesCap: DEFAULT_READ_SOURCES_CAP,
      searchPassesCap: DEFAULT_SEARCH_PASSES_CAP
    };
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const profile = readString(source.profile) || readString(source.mode) || "web_research";
  const recoveryActions = Array.isArray(source.recoveryActions)
    ? source.recoveryActions.map(readString).filter(Boolean)
    : profile === "web_research"
      ? DEFAULT_WEB_RESEARCH_RECOVERY_ACTIONS.slice()
      : [];
  return {
    enabled: source.enabled !== false,
    profile,
    recoveryActions: Array.from(new Set(recoveryActions)),
    structuredToolEvidence: source.structuredToolEvidence !== false,
    toolHistoryCap: readPositiveCap(source.toolHistoryCap, DEFAULT_TOOL_HISTORY_CAP),
    readSourcesCap: readPositiveCap(source.readSourcesCap, DEFAULT_READ_SOURCES_CAP),
    searchPassesCap: readPositiveCap(source.searchPassesCap, DEFAULT_SEARCH_PASSES_CAP)
  };
}

function resolveReadSourcesCap(runtimeConfig) {
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  return readPositiveCap(policy ? policy.readSourcesCap : undefined, DEFAULT_READ_SOURCES_CAP);
}

function resolveSearchPassesCap(runtimeConfig) {
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  return readPositiveCap(policy ? policy.searchPassesCap : undefined, DEFAULT_SEARCH_PASSES_CAP);
}

function readPositiveCap(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readEvidencePolicy(runtimeConfig) {
  if (runtimeConfig && runtimeConfig.evidencePolicy === false) {
    return normalizeEvidencePolicyConfig(false);
  }
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  return normalizeEvidencePolicyConfig(policy || {});
}

function readEvidenceRecoveryActions(runtimeConfig) {
  const policy = readEvidencePolicy(runtimeConfig);
  return policy.enabled === false ? [] : policy.recoveryActions.slice();
}

function formatEvidenceRecoveryActions(runtimeConfig, fallback = "continue evidence work") {
  const actions = readEvidenceRecoveryActions(runtimeConfig);
  return actions.length > 0 ? actions.join("/") : fallback;
}

function countStructuredToolEvidence(runState) {
  const history = runState &&
    runState.toolContext &&
    Array.isArray(runState.toolContext.history)
    ? runState.toolContext.history
    : [];
  return history.filter((entry) => hasStructuredEvidence(entry, 0)).length;
}

function hasStructuredEvidence(value, depth) {
  if (depth > 3 || value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => hasStructuredEvidence(item, depth + 1));
  if (typeof value === "object") {
    if (value.ok === false || value.error) return false;
    const output = value.output && typeof value.output === "object" ? value.output : value;
    return Object.entries(output).some(([, item]) => hasStructuredEvidence(item, depth + 1));
  }
  return false;
}

export { DEFAULT_READ_SOURCES_CAP, DEFAULT_SEARCH_PASSES_CAP, DEFAULT_TOOL_HISTORY_CAP, countStructuredToolEvidence, formatEvidenceRecoveryActions, normalizeEvidencePolicyConfig, readEvidencePolicy, readEvidenceRecoveryActions, resolveReadSourcesCap, resolveSearchPassesCap };
