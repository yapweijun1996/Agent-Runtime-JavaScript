import { readString } from '../runtime/semantic-json.js';

const DEFAULT_CONTEXT_WINDOW_COMPACTION = Object.freeze({
  degradationOrder: ["other_memory", "history", "recent_turns", "summary"],
  failureMode: "error",
  strategy: "priority_preserve_v1",
  summaryFormat: "context_summary_v1",
  tiers: {
    confirmedMemory: {
      itemPriority: ["decision", "fact", "preference"],
      maxShare: 0.20,
      pinned: true
    },
    direction: {
      maxShare: 0.15,
      pinned: true
    },
    history: {
      enabled: false,
      maxShare: 0.05,
      pinned: false
    },
    otherMemory: {
      maxShare: 0.10,
      pinned: false
    },
    recentTurns: {
      anchorSignals: [
        "activeGoal",
        "activeTopic",
        "pendingClarification",
        "lastResolution",
        "selectedSource"
      ],
      maxShare: 0.25,
      maxTurns: 6,
      minTurns: 1,
      pinned: false
    },
    summary: {
      maxShare: 0.25,
      minTokens: 192,
      pinned: true
    }
  }
});

function normalizeContextWindowCompactionPolicy(source, legacyRecentMessages) {
  const config = source && typeof source === "object" ? source : {};
  const tiersSource = config.tiers && typeof config.tiers === "object" ? config.tiers : {};
  const recentTurnsMax = normalizePositiveInteger$1(
    config.recentTurnsMax,
    normalizePositiveInteger$1(legacyRecentMessages, DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.recentTurns.maxTurns)
  );

  return {
    degradationOrder: normalizeDegradationOrder(config.degradationOrder),
    failureMode: config.failureMode === "error" ? "error" : DEFAULT_CONTEXT_WINDOW_COMPACTION.failureMode,
    strategy: config.strategy === "priority_preserve_v1"
      ? config.strategy
      : DEFAULT_CONTEXT_WINDOW_COMPACTION.strategy,
    summaryFormat: readString(config.summaryFormat) || DEFAULT_CONTEXT_WINDOW_COMPACTION.summaryFormat,
    tiers: {
      confirmedMemory: {
        itemPriority: normalizeItemPriority(
          tiersSource.confirmedMemory && tiersSource.confirmedMemory.itemPriority
        ),
        maxShare: normalizeShare(
          tiersSource.confirmedMemory && tiersSource.confirmedMemory.maxShare,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.confirmedMemory.maxShare
        ),
        pinned: readBoolean(
          tiersSource.confirmedMemory && tiersSource.confirmedMemory.pinned,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.confirmedMemory.pinned
        )
      },
      direction: {
        maxShare: normalizeShare(
          tiersSource.direction && tiersSource.direction.maxShare,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.direction.maxShare
        ),
        pinned: readBoolean(
          tiersSource.direction && tiersSource.direction.pinned,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.direction.pinned
        )
      },
      history: {
        enabled: readBoolean(
          tiersSource.history && tiersSource.history.enabled,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.history.enabled
        ),
        maxShare: normalizeShare(
          tiersSource.history && tiersSource.history.maxShare,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.history.maxShare
        ),
        pinned: readBoolean(
          tiersSource.history && tiersSource.history.pinned,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.history.pinned
        )
      },
      otherMemory: {
        maxShare: normalizeShare(
          tiersSource.otherMemory && tiersSource.otherMemory.maxShare,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.otherMemory.maxShare
        ),
        pinned: readBoolean(
          tiersSource.otherMemory && tiersSource.otherMemory.pinned,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.otherMemory.pinned
        )
      },
      recentTurns: {
        anchorSignals: normalizeAnchorSignals(
          tiersSource.recentTurns && tiersSource.recentTurns.anchorSignals
        ),
        maxShare: normalizeShare(
          tiersSource.recentTurns && tiersSource.recentTurns.maxShare,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.recentTurns.maxShare
        ),
        maxTurns: normalizePositiveInteger$1(
          tiersSource.recentTurns && tiersSource.recentTurns.maxTurns,
          recentTurnsMax
        ),
        minTurns: normalizePositiveInteger$1(
          tiersSource.recentTurns && tiersSource.recentTurns.minTurns,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.recentTurns.minTurns
        ),
        pinned: readBoolean(
          tiersSource.recentTurns && tiersSource.recentTurns.pinned,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.recentTurns.pinned
        )
      },
      summary: {
        maxShare: normalizeShare(
          tiersSource.summary && tiersSource.summary.maxShare,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.summary.maxShare
        ),
        minTokens: normalizePositiveInteger$1(
          tiersSource.summary && tiersSource.summary.minTokens,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.summary.minTokens
        ),
        pinned: readBoolean(
          tiersSource.summary && tiersSource.summary.pinned,
          DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.summary.pinned
        )
      }
    }
  };
}

function toTargetTokens(inputBudgetTokens, maxShare, minTokens) {
  const share = normalizeShare(maxShare, 0);
  const floor = normalizePositiveInteger$1(minTokens, 0);
  return Math.max(floor, Math.floor(inputBudgetTokens * share));
}

function normalizeDegradationOrder(value) {
  const entries = Array.isArray(value) ? value : [];
  const allowed = new Set(DEFAULT_CONTEXT_WINDOW_COMPACTION.degradationOrder);
  const normalized = entries
    .map(readString)
    .filter((entry) => allowed.has(entry));

  return normalized.length > 0
    ? normalized
    : DEFAULT_CONTEXT_WINDOW_COMPACTION.degradationOrder.slice();
}

function normalizeItemPriority(value) {
  const allowed = new Set(DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.confirmedMemory.itemPriority);
  const normalized = (Array.isArray(value) ? value : [])
    .map(readString)
    .filter((entry) => allowed.has(entry));

  return normalized.length > 0
    ? normalized
    : DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.confirmedMemory.itemPriority.slice();
}

function normalizeAnchorSignals(value) {
  const allowed = new Set(DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.recentTurns.anchorSignals);
  const normalized = (Array.isArray(value) ? value : [])
    .map(readString)
    .filter((entry) => allowed.has(entry));

  return normalized.length > 0
    ? normalized
    : DEFAULT_CONTEXT_WINDOW_COMPACTION.tiers.recentTurns.anchorSignals.slice();
}

function normalizeShare(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, 1)
    : fallback;
}

function normalizePositiveInteger$1(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export { DEFAULT_CONTEXT_WINDOW_COMPACTION, normalizeContextWindowCompactionPolicy, toTargetTokens };
