import { isTurnIdBefore } from '../runtime/turn-ordering.js';
import { cloneValue } from '../runtime/utils.js';
import { readString } from '../runtime/semantic-json.js';

function normalizeCompactionPolicy(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    maxTurns: readPositiveInteger$7(source.maxTurns),
    onCompact: typeof source.onCompact === "function" ? source.onCompact : null
  };
}

async function applyCompactionPolicyToHistory(history, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const sourceHistory = Array.isArray(history) ? history.slice() : [];
  const policy = normalizeCompactionPolicy(opts.compactionPolicy);
  const sourceCount = sourceHistory.length;
  const sourceTurnCount = countHistoryTurns(sourceHistory);
  const sourceWindowSize = sourceTurnCount || sourceCount;
  const shouldTrimByMaxTurns = Number.isInteger(policy.maxTurns) && sourceWindowSize > policy.maxTurns;

  if (!policy.onCompact && !shouldTrimByMaxTurns) {
    return createCompactionPolicyResult(sourceHistory, {
      applied: false,
      maxTurns: policy.maxTurns,
      reason: "not_needed",
      sourceCount,
      sourceTurnCount
    });
  }

  if (policy.onCompact && (shouldTrimByMaxTurns || policy.maxTurns == null)) {
    try {
      const hostResult = await policy.onCompact(cloneValue(sourceHistory), {
        maxTurns: policy.maxTurns,
        sessionId: readString(opts.sessionId) || null,
        sourceCount,
        sourceTurnCount,
        threadId: readString(opts.threadId) || null
      });
      const normalized = normalizeHistory(hostResult);
      if (normalized) {
        return createCompactionPolicyResult(normalized, {
          applied: normalized.length !== sourceCount || !sameMessageIds(sourceHistory, normalized),
          hook: "onCompact",
          maxTurns: policy.maxTurns,
          reason: "host_onCompact",
          sourceCount,
          sourceTurnCount
        });
      }
    } catch (error) {
      return createCompactionPolicyResult(defaultTrim(sourceHistory, policy.maxTurns), {
        applied: shouldTrimByMaxTurns,
        error: readString(error && error.message) || "onCompact_failed",
        hook: "onCompact",
        maxTurns: policy.maxTurns,
        reason: shouldTrimByMaxTurns ? "host_onCompact_failed_default_trim" : "host_onCompact_failed_noop",
        sourceCount,
        sourceTurnCount
      });
    }
  }

  return createCompactionPolicyResult(defaultTrim(sourceHistory, policy.maxTurns), {
    applied: shouldTrimByMaxTurns,
    maxTurns: policy.maxTurns,
    reason: shouldTrimByMaxTurns ? "max_turns_window" : "not_needed",
    sourceCount,
    sourceTurnCount
  });
}

function mergeCompactionWindows(left, right) {
  const leftTurn = readWindowTurnId(left);
  const rightTurn = readWindowTurnId(right);
  if (!leftTurn) return rightTurn ? { oldestPreservedTurnId: rightTurn } : null;
  if (!rightTurn) return { oldestPreservedTurnId: leftTurn };
  return isTurnIdBefore(leftTurn, rightTurn)
    ? { oldestPreservedTurnId: rightTurn }
    : { oldestPreservedTurnId: leftTurn };
}

function createCompactionPolicyResult(history, detail) {
  const messages = normalizeHistory(history) || [];
  const window = detail.applied === true
    ? createWindowFromHistory(messages)
    : null;
  return {
    detail: {
      applied: detail.applied === true,
      error: readString(detail.error) || null,
      hook: readString(detail.hook) || null,
      maxTurns: Number.isInteger(detail.maxTurns) ? detail.maxTurns : null,
      reason: readString(detail.reason) || null,
      resultCount: messages.length,
      sourceCount: Number.isInteger(detail.sourceCount) ? detail.sourceCount : messages.length,
      sourceTurnCount: Number.isInteger(detail.sourceTurnCount) ? detail.sourceTurnCount : null
    },
    history: messages,
    window
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map(cloneValue);
}

function defaultTrim(history, maxTurns) {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0 || history.length <= maxTurns) {
    return history.slice();
  }
  const turnIds = readOrderedTurnIds(history);
  if (turnIds.length === 0) {
    return history.slice(-maxTurns);
  }
  const keptTurnIds = new Set(turnIds.slice(-maxTurns));
  return history.filter((message) => {
    const turnId = readString(message && message.turnId);
    return !turnId || keptTurnIds.has(turnId);
  });
}

function createWindowFromHistory(history) {
  const first = history.find((message) => readString(message && message.turnId));
  const oldestPreservedTurnId = readString(first && first.turnId);
  return oldestPreservedTurnId ? { oldestPreservedTurnId } : null;
}

function sameMessageIds(left, right) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => readString(entry && entry.id) === readString(right[index] && right[index].id));
}

function countHistoryTurns(history) {
  return readOrderedTurnIds(history).length;
}

function readOrderedTurnIds(history) {
  const turnIds = [];
  const seen = new Set();
  for (const message of history) {
    const turnId = readString(message && message.turnId);
    if (!turnId || seen.has(turnId)) continue;
    seen.add(turnId);
    turnIds.push(turnId);
  }
  return turnIds;
}

function readWindowTurnId(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? readString(value.oldestPreservedTurnId)
    : "";
}

function readPositiveInteger$7(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export { applyCompactionPolicyToHistory, mergeCompactionWindows, normalizeCompactionPolicy };
