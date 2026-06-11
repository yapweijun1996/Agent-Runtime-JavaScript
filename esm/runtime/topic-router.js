import { tokenizeTopicText, DEFAULT_THREAD_ID } from '../session/thread.js';
import { looksLikeTopicPrompt } from './topic-like-task.js';
import { scoreThreads, anyThreadHasDistinctiveTokens } from './topic-scoring.js';

/**
 * Minimum Jaccard overlap required to treat a user message as a match
 * against a prior thread's topic/recent-texts tokens. Below this score the
 * message is considered unrelated and will route to a new / active thread.
 */
const MIN_OVERLAP$1 = 0.2;

/**
 * A runner-up score within this delta of the best match triggers an
 * `ambiguous` verdict so the caller can ask the user to clarify instead of
 * silently picking a thread.
 */
const AMBIGUITY_DELTA = 0.05;

/**
 * Legacy pivot-marker lexicon — only consulted when upstream does NOT supply
 * `turnIntent.pivotIntent`. New callers should compute pivot intent in the
 * extractor / planner layer (LLM or ML signal) and hand it to the router;
 * this regex set exists strictly as a graceful fallback and must stay
 * narrow. No new domain vocabulary belongs here.
 */
const PIVOT_MARKERS_FALLBACK = [
  /\b(?:back to|previous|earlier|prior|that other)\b/i,
  /\bresume\s+(?:the\s+)?(?:previous|earlier|prior)\b/i,
  /\bcontinue\s+with\s+(?:the\s+)?(?:previous|earlier|prior)\b/i,
  /\u56de\u5230/,
  /\u4e0a\u4e00\u4e2a/,
  /\u5148\u524d/,
  /\u521a\u624d(?:\u7684|\u90a3)/,
  /\u7ee7\u7eed(?:\u4e4b\u524d|\u5148\u524d|\u521a\u624d|\u90a3\u4e2a)/
];


/**
 * Route a user message to a thread. Pure heuristic — no LLM call. Returns
 * a verdict the runtime can act on.
 *
 * @param {object} options
 * @param {string} options.userMessage — raw user turn text
 * @param {Array<Thread>} options.threads — known threads (default-only is fine)
 * @param {string|null} options.activeThreadId — currently focused thread id
 * @param {object} [options.turnIntent] — optional intent hint from upstream
 *
 * @returns {{
 *   action: "continue_thread"|"new_thread"|"pivot_back"|"ambiguous",
 *   threadId: string|null,
 *   candidates: Array<{threadId:string, score:number}>,
 *   topic: string,
 *   reasoning: string
 * }}
 */
function routeTopic(options) {
  const source = options && typeof options === "object" ? options : {};
  const text = readString$e(source.userMessage);
  const threads = Array.isArray(source.threads) ? source.threads.filter(Boolean) : [];
  const activeThreadId = readString$e(source.activeThreadId) || null;
  const turnIntent = source.turnIntent && typeof source.turnIntent === "object" ? source.turnIntent : null;

  // Empty / missing input → stay on active (or default) thread.
  if (!text) {
    return buildVerdict({
      action: "continue_thread",
      threadId: activeThreadId || DEFAULT_THREAD_ID,
      candidates: [],
      topic: "",
      reasoning: "empty_user_message"
    });
  }

  // Upstream-planner pivot target wins before any structural analysis.
  // When the planner supplies a valid, non-active `targetThreadId`, the
  // router treats it as authoritative and bypasses Jaccard thresholds —
  // that is the whole point of escalating to an LLM layer. Structural
  // signals stay available below for callers that do not use a planner.
  if (turnIntent && typeof turnIntent.targetThreadId === "string" && turnIntent.targetThreadId) {
    const target = threads.find((thread) => thread && thread.id === turnIntent.targetThreadId);
    if (target) {
      const targetId = target.id;
      if (targetId !== activeThreadId) {
        return buildVerdict({
          action: "pivot_back",
          threadId: targetId,
          candidates: [],
          topic: "",
          reasoning: "upstream_pivot_target"
        });
      }
      return buildVerdict({
        action: "continue_thread",
        threadId: targetId,
        candidates: [],
        topic: "",
        reasoning: "upstream_pivot_target_already_active"
      });
    }
    // Target was supplied but does not exist in thread list — ignore and
    // fall through to structural routing. Validator upstream already
    // dropped hallucinations, so reaching here means a race (thread
    // evicted). Conservative default covers us.
  }

  const tokens = new Set(tokenizeTopicText(text));
  const candidates = scoreThreads(threads, tokens);

  // No prior threads (or only a virgin default) — decide new vs. continue.
  const hasRealHistory = candidates.some((entry) => entry.score > 0);
  if (!hasRealHistory) {
    const hasDistinctiveThreads = anyThreadHasDistinctiveTokens(threads);

    // Referential continuation: upstream (extractor / planner) marks the turn
    // as relying on prior context → never split, even with zero overlap.
    // Router stays a pure decision layer; no lexicon here.
    if (isReferential(turnIntent) && hasDistinctiveThreads) {
      return buildVerdict({
        action: "continue_thread",
        threadId: activeThreadId || DEFAULT_THREAD_ID,
        candidates,
        topic: "",
        reasoning: "referential_continuation_no_overlap"
      });
    }
    // Upstream-signaled divergent intent forces a split regardless of
    // prompt shape. Primary harness contract for cross-topic questions.
    if (isDivergent(turnIntent)) {
      return buildVerdict({
        action: "new_thread",
        threadId: null,
        candidates,
        topic: text,
        reasoning: "upstream_divergent_intent"
      });
    }
    if (looksLikeTopicPrompt(text)) {
      return buildVerdict({
        action: "new_thread",
        threadId: null,
        candidates,
        topic: text,
        reasoning: "topic_like_prompt_no_prior_overlap"
      });
    }
    // Conservative default: zero-overlap question-shaped prompts stay on
    // the active thread. Router refuses to split without either an upstream
    // intent signal or a topic-like prompt shape — preventing misrouting
    // of referential meta-prompts ("summarize what we discussed earlier")
    // without baking a continuity lexicon into the router.
    return buildVerdict({
      action: "continue_thread",
      threadId: activeThreadId || DEFAULT_THREAD_ID,
      candidates,
      topic: "",
      reasoning: "no_prior_overlap_fallback_active"
    });
  }

  const sorted = candidates.slice().sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const runnerUp = sorted[1];

  // Strong overlap and a pivot marker in the message → pivot_back when the
  // match is a different thread than the active one; otherwise continue.
  const pivotIntent = detectPivot(text, turnIntent);
  if (pivotIntent && best.score >= MIN_OVERLAP$1) {
    if (best.threadId !== activeThreadId) {
      return buildVerdict({
        action: "pivot_back",
        threadId: best.threadId,
        candidates: sorted,
        topic: "",
        reasoning: "pivot_marker_with_overlap"
      });
    }
    return buildVerdict({
      action: "continue_thread",
      threadId: best.threadId,
      candidates: sorted,
      topic: "",
      reasoning: "pivot_marker_but_already_active"
    });
  }

  // Overlap below threshold → nothing matches; treat as new topic if prompt
  // is topic-like, else stay on active.
  if (best.score < MIN_OVERLAP$1) {
    if (looksLikeTopicPrompt(text)) {
      return buildVerdict({
        action: "new_thread",
        threadId: null,
        candidates: sorted,
        topic: text,
        reasoning: "overlap_below_threshold_topic_like"
      });
    }
    return buildVerdict({
      action: "continue_thread",
      threadId: activeThreadId || DEFAULT_THREAD_ID,
      candidates: sorted,
      topic: "",
      reasoning: "overlap_below_threshold_fallback_active"
    });
  }

  // Close tie between best and runner-up → ambiguous.
  if (runnerUp && runnerUp.score >= MIN_OVERLAP$1 && (best.score - runnerUp.score) < AMBIGUITY_DELTA) {
    return buildVerdict({
      action: "ambiguous",
      threadId: null,
      candidates: sorted,
      topic: "",
      reasoning: "multiple_threads_tied_within_delta"
    });
  }

  // Clear winner — continue on it, or pivot_back if it differs from active.
  if (activeThreadId && best.threadId !== activeThreadId) {
    return buildVerdict({
      action: "pivot_back",
      threadId: best.threadId,
      candidates: sorted,
      topic: "",
      reasoning: "best_match_differs_from_active"
    });
  }
  return buildVerdict({
    action: "continue_thread",
    threadId: best.threadId,
    candidates: sorted,
    topic: "",
    reasoning: "best_match_is_active"
  });
}

/**
 * Pivot intent. Primary: upstream signal. Fallback: narrow regex lexicon,
 * preserved only because legacy callers don't yet populate `turnIntent`.
 * Remove the fallback once planner/extractor produces pivot signals.
 */
function detectPivot(text, turnIntent) {
  if (turnIntent && turnIntent.pivotIntent === true) return true;
  if (!text) return false;
  for (const pattern of PIVOT_MARKERS_FALLBACK) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Referential intent — router consumes only; detection stays upstream. */
function isReferential(turnIntent) {
  return Boolean(turnIntent && turnIntent.referentialIntent === true);
}

/** Divergent intent — router consumes only; detection stays upstream. */
function isDivergent(turnIntent) {
  return Boolean(turnIntent && turnIntent.divergentIntent === true);
}

function buildVerdict(result) {
  return {
    action: result.action,
    threadId: result.threadId,
    candidates: Array.isArray(result.candidates) ? result.candidates.slice() : [],
    topic: typeof result.topic === "string" ? result.topic : "",
    reasoning: typeof result.reasoning === "string" ? result.reasoning : ""
  };
}

function readString$e(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { routeTopic };
