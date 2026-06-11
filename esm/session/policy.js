import { ERROR_CODES } from '../runtime/errors.js';
import { normalizeContextWindowCompactionPolicy } from './context-window-policy.js';

const DEFAULT_SESSION_POLICY = {
  charsPerToken: 4,
  compactAtTokens: 24576,
  contextWindowTokens: 32768,
  maxPromptTokens: 12000,
  recentMessages: 6
};

const MIN_INPUT_BUDGET_TOKENS = 32;

function normalizeSessionPolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  assertNoRemovedSessionPolicyFields(source);
  const contextWindowTokens = normalizePositiveInteger(
    source.contextWindowTokens,
    DEFAULT_SESSION_POLICY.contextWindowTokens
  );
  const inputBudgetTokens = Math.max(MIN_INPUT_BUDGET_TOKENS, contextWindowTokens);
  const compactAtSource = normalizePositiveInteger(
    source.compactAtTokens,
    normalizePositiveInteger(source.maxPromptTokens, DEFAULT_SESSION_POLICY.compactAtTokens)
  );

  return {
    charsPerToken: normalizePositiveInteger(source.charsPerToken, DEFAULT_SESSION_POLICY.charsPerToken),
    compactAtTokens: Math.min(compactAtSource, inputBudgetTokens),
    compaction: normalizeContextWindowCompactionPolicy(source.compaction, source.recentMessages),
    contextWindowTokens,
    maxPromptTokens: normalizePositiveInteger(source.maxPromptTokens, DEFAULT_SESSION_POLICY.maxPromptTokens),
    recentMessages: normalizePositiveInteger(source.recentMessages, DEFAULT_SESSION_POLICY.recentMessages)
  };
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function assertNoRemovedSessionPolicyFields(source) {
  if (!Object.prototype.hasOwnProperty.call(source, "reserveOutputTokens")) {
    return;
  }

  const error = new Error(
    'sessionPolicy.reserveOutputTokens has been removed. agrun.js now computes prompt budget directly from contextWindowTokens and compactAtTokens.'
  );
  error.code = ERROR_CODES.INVALID_SESSION_POLICY;
  throw error;
}

export { normalizeSessionPolicy };
