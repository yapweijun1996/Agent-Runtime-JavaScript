import { tokenizeTopicText } from '../session/thread.js';

/**
 * Shared structural-signal helpers for the topic-router and the turn-intent
 * extractor. Kept lexicon-free on purpose — only token-set arithmetic and
 * Jaccard overlap live here, never domain vocabulary.
 */

/** Collect the distinctive-token bag for a thread (topic + anchor + recents). */
function collectThreadTokens(thread) {
  const bag = new Set();
  if (!thread || typeof thread !== "object") return bag;
  const topic = readString$h(thread.topic);
  if (topic) {
    for (const token of tokenizeTopicText(topic)) bag.add(token);
  }
  const anchor = thread.goalAnchor && typeof thread.goalAnchor === "object" ? thread.goalAnchor : null;
  if (anchor) {
    for (const token of tokenizeTopicText(anchor.text)) bag.add(token);
  }
  const recents = Array.isArray(thread.recentUserTexts) ? thread.recentUserTexts : [];
  for (const entry of recents) {
    for (const token of tokenizeTopicText(entry)) bag.add(token);
  }
  return bag;
}

/** Jaccard overlap between two token sets. Returns 0 for empties. */
function jaccard$1(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

/** Jaccard-score every thread against the given message token set. */
function scoreThreads(threads, messageTokens) {
  const results = [];
  if (!Array.isArray(threads)) return results;
  for (const thread of threads) {
    if (!thread || typeof thread !== "object") continue;
    const threadTokens = collectThreadTokens(thread);
    if (threadTokens.size === 0) {
      results.push({ threadId: thread.id, score: 0, threadTokenCount: 0 });
      continue;
    }
    results.push({
      threadId: thread.id,
      score: jaccard$1(messageTokens, threadTokens),
      threadTokenCount: threadTokens.size
    });
  }
  return results;
}

/** True iff any thread carries at least one distinctive token. */
function anyThreadHasDistinctiveTokens(threads) {
  if (!Array.isArray(threads)) return false;
  for (const thread of threads) {
    if (collectThreadTokens(thread).size > 0) return true;
  }
  return false;
}

/** Sum of distinctive-token counts across all threads. */
function totalThreadVocab(threads) {
  if (!Array.isArray(threads)) return 0;
  let total = 0;
  for (const thread of threads) {
    total += collectThreadTokens(thread).size;
  }
  return total;
}

function readString$h(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { anyThreadHasDistinctiveTokens, collectThreadTokens, jaccard$1 as jaccard, scoreThreads, totalThreadVocab };
