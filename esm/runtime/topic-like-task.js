function isExecutableTopicLikeTurn(prompt, turnIntent) {
  const text = readString$1e(prompt);

  if (!text) {
    return false;
  }

  if (
    !turnIntent ||
    typeof turnIntent !== "object" ||
    readString$1e(turnIntent.kind) !== "new_task"
  ) {
    return false;
  }

  if (turnIntent.clarificationReply || turnIntent.followUpTarget) {
    return false;
  }

  if (!looksLikeTopicPrompt(text)) {
    return false;
  }

  return hasDigit(text) || countWords(text) >= 5;
}

// AGRUN-246-K: a topic-shaped prompt is a SHORT, NON-QUESTION turn — a pure
// language-neutral structural primitive (token count + trailing-"?" only). The
// final English action-verb exclusion (isActionLikeText) was removed: it
// misclassified Mandarin / non-English / indirect commands, and "command vs
// bare topic" is a SEMANTIC distinction the AI owns via turnIntent.kind /
// divergentIntent — not something a structural shape check can decide. A
// command-shaped prompt now reads as topic-like; the routing/continuity layers
// rely on the AI signal (or their own conservative default) to tell follow-up
// from new topic. See ADR-0047.
function looksLikeTopicPrompt(value) {
  const words = trimTrailingPunctuation$2(value).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 10 && !isQuestionLikeText(value);
}

// AGRUN-246-D C2.2: question detection is universal trailing-"?" punctuation
// only. The English question-word lexicon (what|which|who|...) was removed — it
// misclassified Mandarin / non-English / indirect prompts (audit
// non-ai-first-2026-05-23 §C2.2). The real question-vs-task intent is now
// AI/router-owned via `turnIntent.kind`; this structural helper only feeds
// `looksLikeTopicPrompt`'s no-LLM thread-routing fallback and the assistant-
// prose loop-risk scan in clarification-state.js (assistant text, not a user
// prompt). "?" is language-neutral punctuation, not an intent lexicon.
function isQuestionLikeText(value) {
  return readString$1e(value).endsWith("?");
}

// AGRUN-246-K: isActionLikeText (the last English action-verb lexicon, B1/B2)
// is DELETED. It was the final regex-on-prompt in this file, surviving only as
// a no-LLM structural fallback for (1) topic-router thread routing and (2)
// inquiry-context follow_up_command continuity. Both are now AI-owned:
// thread routing relies on turnIntent.divergentIntent/pivotIntent (with a
// conservative continue/topic-shape default), and inquiry-context preserves the
// prior topic anchor by default (turnIntent.kind === "new_task" is the AI's
// reset override). The lexicon was i18n-broken (English-only) and "command vs
// topic" is a semantic judgement the AI makes — no structural primitive can.
// See ADR-0047 (closes audit C2.2; topic-like-task.js allowlist 2 → 0).

function countWords(value) {
  return trimTrailingPunctuation$2(value).split(/\s+/).filter(Boolean).length;
}

// AGRUN-246-D C2.2: digit presence via a language-neutral character scan
// (replaces the prior `/\b\d+\b/` regex-on-prompt). A number in a short topic
// signals specificity ("Q3 2024", "...2026"); this is a structural primitive,
// not an intent lexicon.
function hasDigit(value) {
  const text = readString$1e(value);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch >= "0" && ch <= "9") {
      return true;
    }
  }
  return false;
}

function trimTrailingPunctuation$2(value) {
  return readString$1e(value).replace(/[.?!]+$/g, "").trim();
}

function readString$1e(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { isExecutableTopicLikeTurn, isQuestionLikeText, looksLikeTopicPrompt };
