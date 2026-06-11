import { buildSessionEvidenceSnapshot } from './evidence.js';

function buildSessionMemorySnapshot(options) {
  const snapshot = buildSessionEvidenceSnapshot({
    ...options,
    threadScope: options && options.threadScope ? options.threadScope : null
  });

  return {
    compactedContext: readString$7(snapshot.compactedContext),
    decisions: readString$7(snapshot.decisions),
    estimatedTokens: typeof snapshot.estimatedTokens === "number" ? snapshot.estimatedTokens : 0,
    facts: readString$7(snapshot.facts),
    history: readString$7(snapshot.history),
    items: Array.isArray(snapshot.items) ? snapshot.items.slice() : [],
    legacyIntent: {
      clarificationStatus: readString$7(snapshot.clarificationStatus) || "none",
      currentGoal: readString$7(snapshot.currentGoal),
      currentTopic: readString$7(snapshot.currentTopic),
      lastResolution: snapshot.lastResolution || null,
      openAmbiguity: readString$7(snapshot.openAmbiguity),
      pendingClarification: snapshot.pendingClarification || null
    },
    memory: readString$7(snapshot.memory),
    preferences: readString$7(snapshot.preferences),
    recentTurns: readString$7(snapshot.recentTurns),
    summary: readString$7(snapshot.summary) || readString$7(snapshot.compactedContext)
  };
}

function readString$7(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildSessionMemorySnapshot };
