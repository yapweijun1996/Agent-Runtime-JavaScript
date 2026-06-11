import { tokenizeTopicText } from '../session/thread.js';
import { scoreThreads, anyThreadHasDistinctiveTokens, totalThreadVocab } from './topic-scoring.js';

/**
 * Turn-intent extractor. Produces `{pivotIntent?, divergentIntent?}` from
 * purely structural signals — Jaccard overlap across threads, content-token
 * count, distinctive-vocabulary sufficiency. Does NOT carry any language or
 * topic vocabulary; no lexicons live here.
 *
 * The router consumes these signals but never infers intent on its own —
 * detection responsibility sits at this layer so the router stays a pure
 * decision layer.
 *
 * Intent fields are only emitted when the structural evidence is confident
 * enough; ambiguous cases return `{}` so the router's conservative defaults
 * keep the user on the active thread.
 */

/** Minimum Jaccard for any thread to qualify as "matched". Mirrors router. */
const MIN_OVERLAP = 0.2;

/**
 * A pivot fires only when the best non-active thread's score exceeds the
 * active thread's score by this margin. Keeps routine follow-ups from
 * being misread as pivots.
 */
const PIVOT_DOMINANCE_DELTA = 0.05;

/**
 * Minimum content-token count before zero-overlap can claim a topic shift.
 * Tunable numeric floor (analogous to MIN_OVERLAP) — NOT a word list.
 */
const MIN_DIVERGENT_TOKENS = 3;

/**
 * Extract structural intent signals for a turn.
 *
 * @param {object} options
 * @param {string} options.userMessage
 * @param {Array<Thread>} options.threads
 * @param {string|null} options.activeThreadId
 * @returns {{ pivotIntent?: true, divergentIntent?: true }}
 */
function extractTurnIntent(options) {
  const source = options && typeof options === "object" ? options : {};
  const text = typeof source.userMessage === "string" ? source.userMessage.trim() : "";
  const threads = Array.isArray(source.threads) ? source.threads.filter(Boolean) : [];
  const activeThreadId = typeof source.activeThreadId === "string" ? source.activeThreadId : null;

  const intent = {};
  if (!text || threads.length === 0) return intent;

  const messageTokens = new Set(tokenizeTopicText(text));
  const messageTokenCount = messageTokens.size;
  if (messageTokenCount === 0) return intent;

  const scored = scoreThreads(threads, messageTokens);
  const hasAnyOverlap = scored.some((entry) => entry.score > 0);
  const hasDistinctiveThreads = anyThreadHasDistinctiveTokens(threads);

  // --- Pivot signal ---------------------------------------------------------
  // A pivot only makes sense when more than one thread exists AND a
  // non-active thread's overlap clearly dominates the active one. This is
  // strictly about comparative Jaccard, no lexicon.
  if (activeThreadId) {
    const activeEntry = scored.find((entry) => entry.threadId === activeThreadId);
    const activeScore = activeEntry ? activeEntry.score : 0;
    let bestOther = null;
    for (const entry of scored) {
      if (entry.threadId === activeThreadId) continue;
      if (!bestOther || entry.score > bestOther.score) bestOther = entry;
    }
    if (
      bestOther
      && bestOther.score >= MIN_OVERLAP
      && bestOther.score > activeScore + PIVOT_DOMINANCE_DELTA
    ) {
      intent.pivotIntent = true;
    }
  }

  // --- Divergent signal -----------------------------------------------------
  // A divergent topic shift only fires when:
  //  (a) Every thread scored zero overlap — message shares no token with any
  //      known thread vocabulary.
  //  (b) At least one thread carries distinctive tokens (otherwise the
  //      absence of overlap is trivial, not informative).
  //  (c) The message itself carries enough content-tokens to plausibly
  //      declare a new topic (MIN_DIVERGENT_TOKENS floor).
  //  (d) Thread vocabulary is at least as rich as the message vocabulary —
  //      otherwise zero overlap is not evidence, the threads simply haven't
  //      accumulated enough content to disprove relatedness. This guards
  //      against false-positive splits when the threads are young.
  //
  // All four checks are structural / numeric. Referential intent is NOT
  // produced here — distinguishing referential from divergent on zero-overlap
  // turns requires semantic understanding (LLM) and is deferred to a future
  // slice. The router's conservative default handles unsignalled cases.
  const threadVocabSize = totalThreadVocab(threads);
  if (
    !hasAnyOverlap
    && hasDistinctiveThreads
    && messageTokenCount >= MIN_DIVERGENT_TOKENS
    && threadVocabSize >= messageTokenCount
  ) {
    intent.divergentIntent = true;
  }

  return intent;
}

export { extractTurnIntent };
