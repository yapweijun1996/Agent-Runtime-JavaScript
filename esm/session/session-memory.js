import { buildSessionEvidenceSnapshot } from './evidence.js';
import { readString } from '../runtime/semantic-json.js';

function buildSessionMemorySnapshot(options) {
  const snapshot = buildSessionEvidenceSnapshot({
    ...options,
    threadScope: options && options.threadScope ? options.threadScope : null
  });

  return {
    compactedContext: readString(snapshot.compactedContext),
    decisions: readString(snapshot.decisions),
    estimatedTokens: typeof snapshot.estimatedTokens === "number" ? snapshot.estimatedTokens : 0,
    facts: readString(snapshot.facts),
    history: readString(snapshot.history),
    items: Array.isArray(snapshot.items) ? snapshot.items.slice() : [],
    legacyIntent: {
      clarificationStatus: readString(snapshot.clarificationStatus) || "none",
      currentGoal: readString(snapshot.currentGoal),
      currentTopic: readString(snapshot.currentTopic),
      lastResolution: snapshot.lastResolution || null,
      openAmbiguity: readString(snapshot.openAmbiguity),
      pendingClarification: snapshot.pendingClarification || null
    },
    memory: readString(snapshot.memory),
    preferences: readString(snapshot.preferences),
    recentTurns: readString(snapshot.recentTurns),
    summary: readString(snapshot.summary) || readString(snapshot.compactedContext)
  };
}

export { buildSessionMemorySnapshot };
