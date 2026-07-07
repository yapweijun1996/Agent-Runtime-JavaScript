/**
 * LLM-backed turn-intent planner. Escalation path for structural cases the
 * `extractTurnIntent` Jaccard extractor cannot resolve (typical example:
 * cross-language pivot-back where word overlap is too thin to cross
 * `MIN_OVERLAP` even though the user clearly asked to return to an earlier
 * thread).
 *
 * Harness contract:
 *  - This module does NOT make network calls directly. It takes a
 *    `classify` callback the runtime wires up (so tests and providers can
 *    swap implementations cheaply).
 *  - It does NOT carry domain vocabulary, pivot lexicons, or locale
 *    regexes. Those belong to the planner prompt, not the router stack.
 *  - Output is normalized to the same `turnIntent` shape the router
 *    already consumes, plus an optional `targetThreadId` that the router
 *    honors as an authoritative pivot destination (bypasses Jaccard
 *    thresholds — that is the whole point of escalating to an LLM).
 *
 * Gating is the caller's responsibility: invoke the planner only when
 * structural signals are insufficient (e.g. extractor returned `{}`,
 * `threads.length >= 2`, and a classifier was configured). That keeps the
 * cheap path free and makes the escalation cost explicit.
 */

const VALID_TARGET_FALLBACK = null;

/**
 * Build compact, LLM-friendly thread summaries. Intentionally trims heavy
 * thread fields so the prompt stays small; the planner only needs enough
 * signal to decide pivot vs new vs continue.
 *
 * @param {Array<Thread>} threads
 * @returns {Array<{id:string, topic:string, sample:string, recentCount:number}>}
 */
function buildThreadSummaries(threads) {
  if (!Array.isArray(threads)) return [];
  const summaries = [];
  for (const thread of threads) {
    if (!thread || typeof thread !== "object") continue;
    const id = typeof thread.id === "string" && thread.id ? thread.id : null;
    if (!id) continue;
    const topic = typeof thread.topic === "string" ? thread.topic.trim().slice(0, 160) : "";
    const recents = Array.isArray(thread.recentUserTexts) ? thread.recentUserTexts : [];
    const sample = recents.length > 0 && typeof recents[recents.length - 1] === "string"
      ? recents[recents.length - 1].trim().slice(0, 200)
      : "";
    summaries.push({
      id,
      topic,
      sample,
      recentCount: recents.length
    });
  }
  return summaries;
}

/**
 * Normalize a raw classifier result into the strict turnIntent shape the
 * router consumes. Rejects unknown keys, coerces booleans, and validates
 * `targetThreadId` against the caller-supplied thread list so a planner
 * hallucination never reaches the router.
 *
 * @param {unknown} raw
 * @param {{threadIds:Set<string>, activeThreadId:string|null, hasPendingClarification?:boolean}} context
 * @returns {object}
 */
function normalizePlannedIntent(raw, context) {
  const intent = {};
  if (!raw || typeof raw !== "object") return intent;
  const threadIds = context && context.threadIds instanceof Set ? context.threadIds : new Set();
  const activeThreadId = context && typeof context.activeThreadId === "string"
    ? context.activeThreadId
    : null;
  const hasPendingClarification = Boolean(context && context.hasPendingClarification === true);

  if (raw.pivotIntent === true) intent.pivotIntent = true;
  if (raw.divergentIntent === true) intent.divergentIntent = true;
  if (raw.referentialIntent === true) intent.referentialIntent = true;
  // AGRUN-593 — the turn asks about earlier conversation content (the user's
  // name, a previous result) whose location is unknown or spans threads. The
  // router answers with a cross-thread-recall verdict: stay on the active
  // thread but give THIS turn the whole-session view.
  if (raw.recallIntent === true) intent.recallIntent = true;
  const kind = normalizeIntentKind(raw.kind);
  if (kind) {
    intent.kind = kind;
    if (kind === "new_task") {
      intent.divergentIntent = true;
    }
  }

  // AGRUN-617 — clarification-answer verdict. Only meaningful when the caller
  // actually had a pending clarification to show the classifier; a
  // hallucinated verdict with nothing pending is rejected outright (same
  // whitelist-and-validate posture as targetThreadId below).
  const clarificationAnswerKind = normalizeClarificationAnswerKind(raw.clarificationAnswerKind);
  if (clarificationAnswerKind && hasPendingClarification) {
    intent.clarificationAnswerKind = clarificationAnswerKind;
    // Mutual-exclusion guard: "answers" means the reply resolves the pending
    // clarification about the ACTIVE topic — by definition a continuation, so
    // a coexisting new_task reset (and its implied divergentIntent) is
    // contradictory. The clarification-specific verdict is the more specific
    // signal (the classifier was shown the pending question) and wins.
    if (clarificationAnswerKind === "answers") {
      if (intent.kind === "new_task") delete intent.kind;
      if (intent.divergentIntent) delete intent.divergentIntent;
    }
  }

  if (typeof raw.targetThreadId === "string" && raw.targetThreadId) {
    if (threadIds.has(raw.targetThreadId) && raw.targetThreadId !== activeThreadId) {
      intent.targetThreadId = raw.targetThreadId;
    }
  }

  // Self-consistency: a targetThreadId without a pivotIntent is treated as
  // a pivot — the planner was confident enough to pick a specific thread,
  // which is stronger signal than the boolean on its own.
  if (intent.targetThreadId && intent.pivotIntent !== true) {
    intent.pivotIntent = true;
  }

  // Mutual-exclusion guard: divergent means "new topic, no prior context
  // applies" — it cannot coexist with a pivot target. Drop the weaker
  // signal (divergent) so the router's pivot branch fires cleanly.
  if (intent.pivotIntent && intent.divergentIntent) {
    delete intent.divergentIntent;
  }

  // AGRUN-593 — recall means "needs prior conversation content"; it cannot
  // coexist with divergent ("no prior context applies"). Recall wins.
  if (intent.recallIntent && intent.divergentIntent) {
    delete intent.divergentIntent;
  }

  return intent;
}

/**
 * Call the LLM classifier with a normalized payload and return a validated
 * intent object. Swallows classifier errors and returns `{}` so routing
 * degrades gracefully — the structural layer's conservative default keeps
 * the user on the active thread.
 *
 * @param {object} options
 * @param {string} options.userMessage
 * @param {Array<Thread>} options.threads
 * @param {string|null} options.activeThreadId
 * @param {(payload:object)=>Promise<object>} options.classify
 * @param {{question?:string, options?:Array<{key?:string,text?:string}>}|null} [options.pendingClarification]
 * @returns {Promise<object>}
 */
async function planTurnIntent(options) {
  const source = options && typeof options === "object" ? options : {};
  const userMessage = typeof source.userMessage === "string" ? source.userMessage.trim() : "";
  const threads = Array.isArray(source.threads) ? source.threads.filter(Boolean) : [];
  const activeThreadId = typeof source.activeThreadId === "string" ? source.activeThreadId : null;
  const classify = typeof source.classify === "function" ? source.classify : null;
  // AGRUN-617 — compact pending-clarification summary for the classifier
  // payload. The classifier cannot judge "does this reply answer the pending
  // clarification" without seeing the question, so the caller threads it in;
  // absent (null) keeps the payload byte-identical to the pre-617 shape.
  const pendingClarification = buildPendingClarificationSummary(source.pendingClarification);

  if (!userMessage || threads.length === 0 || !classify) return {};

  const summaries = buildThreadSummaries(threads);
  if (summaries.length === 0) return {};

  const threadIds = new Set(summaries.map((s) => s.id));

  let raw;
  try {
    raw = await classify({
      userMessage,
      activeThreadId,
      threads: summaries,
      ...(pendingClarification ? { pendingClarification } : {})
    });
  } catch (_err) {
    return {};
  }

  return normalizePlannedIntent(raw, {
    threadIds,
    activeThreadId: activeThreadId || VALID_TARGET_FALLBACK,
    hasPendingClarification: Boolean(pendingClarification)
  });
}

/**
 * Merge a structural intent (from `extractTurnIntent`) with a planned
 * intent (from `planTurnIntent`). Planner wins on overlapping keys
 * because escalation only happens when structural was insufficient; the
 * planner saw richer context and should override. But planner is
 * additive — it cannot erase structural signals that weren't asked about.
 *
 * @param {object} structural
 * @param {object} planned
 * @returns {object}
 */
function mergeTurnIntent(structural, planned) {
  const out = {};
  if (structural && typeof structural === "object") {
    for (const [key, val] of Object.entries(structural)) {
      if (val !== undefined && val !== null) out[key] = val;
    }
  }
  if (planned && typeof planned === "object") {
    for (const [key, val] of Object.entries(planned)) {
      if (val !== undefined && val !== null) out[key] = val;
    }
  }
  // If planner produced a pivot target, clear any prior divergentIntent
  // (structural can never coexist with a targeted pivot — see the same
  // guard in normalizePlannedIntent).
  if (out.targetThreadId && out.divergentIntent) {
    delete out.divergentIntent;
  }
  if (out.kind === "new_task") {
    out.divergentIntent = true;
  }
  // AGRUN-593 — same recall-beats-divergent guard as normalizePlannedIntent,
  // for the merged (structural + planned) shape.
  if (out.recallIntent && out.divergentIntent) {
    delete out.divergentIntent;
  }
  // AGRUN-618 — when the planner was consulted and explicitly classified the
  // turn as a continuation of existing context (follow_up / drill_down /
  // referential), a structural divergentIntent is an overruled guess: the AI
  // saw the thread summaries and the message, the extractor only saw token
  // overlap. Planner kind "unknown" (or a planner error → planned {}) leaves
  // the structural signal standing — override requires a positive AI verdict,
  // absence of one is not evidence.
  const plannerContinues = planned && typeof planned === "object" && (
    planned.kind === "follow_up"
    || planned.kind === "drill_down"
    || planned.referentialIntent === true
  );
  if (plannerContinues && planned.divergentIntent !== true && out.divergentIntent) {
    delete out.divergentIntent;
  }
  // AGRUN-617 — a positive AI verdict that the reply ANSWERS the pending
  // clarification is a continuation of the active context, so a structural
  // divergentIntent (a zero-token-overlap guess — a typo'd answer often
  // shares no tokens with the thread) is an overruled guess. Same
  // positive-verdict-only contract as AGRUN-618 above: "breakout"/"unrelated"
  // and an absent verdict leave structural signals standing.
  if (out.clarificationAnswerKind === "answers") {
    if (out.divergentIntent) delete out.divergentIntent;
    if (out.kind === "new_task") delete out.kind;
  }
  return out;
}

function normalizeIntentKind(value) {
  if (typeof value !== "string") return "";
  const kind = value.trim();
  if (
    kind === "new_task" ||
    kind === "follow_up" ||
    kind === "drill_down" ||
    kind === "approval_resolution" ||
    kind === "unknown"
  ) {
    return kind;
  }
  return "";
}

// AGRUN-617 — strict whitelist for the clarification-answer verdict:
//  "answers"   — the reply answers/restates/corrects the pending
//                clarification's topic (typos, paraphrases, other languages).
//  "breakout"  — the reply abandons the question for a genuinely new topic.
//  "unrelated" — the reply is an instruction unrelated to the question but
//                still inside the ongoing conversation (topic preserved).
// Anything else (including omission) is "no verdict" and the structural
// clarification chain in inquiry-context-resolution.js remains the fallback.
function normalizeClarificationAnswerKind(value) {
  if (typeof value !== "string") return "";
  const kind = value.trim();
  if (kind === "answers" || kind === "breakout" || kind === "unrelated") {
    return kind;
  }
  return "";
}

// AGRUN-617 — trim the pending clarification down to what the classifier
// needs (question + option labels), mirroring buildThreadSummaries' compact
// posture so the prompt stays small.
function buildPendingClarificationSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const question = typeof value.question === "string" ? value.question.trim().slice(0, 300) : "";
  if (!question) return null;
  const options = Array.isArray(value.options)
    ? value.options
      .map((option) => {
        if (!option || typeof option !== "object") return null;
        const key = typeof option.key === "string" ? option.key.trim() : "";
        const text = typeof option.text === "string" ? option.text.trim().slice(0, 160) : "";
        return key || text ? { key, text } : null;
      })
      .filter(Boolean)
    : [];
  return { question, options };
}

export { buildThreadSummaries, mergeTurnIntent, normalizePlannedIntent, planTurnIntent };
