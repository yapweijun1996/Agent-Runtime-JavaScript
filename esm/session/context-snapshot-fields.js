import { cloneValue } from '../runtime/utils.js';
import { readString } from '../runtime/semantic-json.js';

const MAX_CANDIDATE_SOURCES = 5;
const RESOLVED_CLARIFICATION_KINDS = new Set(["confirm", "explicit_answer", "option_select"]);

function isResolvedClarificationKind(value) {
  return RESOLVED_CLARIFICATION_KINDS.has(readString(value));
}

function normalizeCandidateSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const url = readString(value.url);

  if (!url) {
    return null;
  }

  return {
    domain: readString(value.domain),
    engine: readString(value.engine),
    passIndex: typeof value.passIndex === "number" ? value.passIndex : null,
    query: readString(value.query),
    rank: typeof value.rank === "number" ? value.rank : null,
    source: readString(value.source),
    sourceCategory: readString(value.sourceCategory),
    sourceScore: typeof value.sourceScore === "number" ? value.sourceScore : null,
    snippet: readString(value.snippet) || readString(value.content),
    title: readString(value.title),
    url
  };
}

function normalizeReadSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const url = readString(value.url);

  if (!url) {
    return null;
  }

  return {
    bytes: typeof value.bytes === "number" ? value.bytes : 0,
    contentType: readString(value.contentType),
    error: readString(value.error),
    message: readString(value.message),
    mode: readString(value.mode),
    ok: value.ok !== false,
    originStatus: typeof value.originStatus === "number" ? value.originStatus : null,
    platform: readString(value.platform),
    reason: readString(value.reason),
    status: typeof value.status === "number" ? value.status : null,
    text: readString(value.text),
    textRange: normalizeTextRange$4(value.textRange),
    tier: readString(value.tier),
    title: readString(value.title),
    truncated: value.truncated === true,
    url
  };
}

function normalizeCandidateSources(value, fallback) {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];

  return source
    .map((item) => normalizeCandidateSource(item))
    .filter(Boolean)
    .slice(0, MAX_CANDIDATE_SOURCES);
}

function inferSelectedSource(candidateSources, fallback) {
  const normalizedFallback = normalizeCandidateSource(fallback);

  if (normalizedFallback) {
    return normalizedFallback;
  }

  return candidateSources.length === 1 ? candidateSources[0] : null;
}

function normalizePendingClarification(value, fallbackQuestion) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const fallback = readString(fallbackQuestion);

    if (!fallback) {
      return null;
    }

    return {
      id: `clarify:${fallback.toLowerCase()}`,
      kind: "clarification",
      options: [],
      question: fallback,
      source: "legacy",
      sourceTurn: "history"
    };
  }

  const question = readString(value.question);

  if (!question) {
    return null;
  }

  return {
    id: readString(value.id) || `clarify:${question.toLowerCase()}`,
    kind: readPendingKind(value.kind) || "clarification",
    options: Array.isArray(value.options)
      ? value.options
        .map((option) => normalizeOption(option))
        .filter(Boolean)
      : [],
    question,
    source: readString(value.source) || "structured",
    sourceTurn: readString(value.sourceTurn) || "history"
  };
}

function normalizeClarificationResolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const kind = readString(value.kind);

  if (!kind) {
    return null;
  }

  return {
    kind,
    sourceTurn: readString(value.sourceTurn) || null,
    value: value.value == null ? null : cloneValue(value.value)
  };
}

function normalizeOption(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const key = readString(value.key);
  const text = readString(value.text);

  if (!key || !text) {
    return null;
  }

  return {
    key,
    text
  };
}

function readPendingKind(value) {
  return value === "clarification" || value === "approval_followup"
    ? value
    : "";
}

const DEFAULT_DIRECTION_SNIPPET_BUDGET_CHARS = 600;

/**
 * Project a normalized `readSource` into a lean shape safe for the
 * pinned `direction` context-window segment.
 *
 * Why this exists: `inquiryContext.lastReadSource.text` holds the
 * scraped body of the last read URL — for some pages that's tens of
 * thousands of tokens. The direction segment is `pinned: true` so
 * compaction cannot drop it; without bounding `text`/`snippet`/
 * `message`/`error`, a single read can blow past the entire input
 * budget and the runtime cannot recover (observed live: 52K-token
 * direction segment vs 32K Gemini 2.5 Flash budget).
 *
 * Behaviour:
 *   - All "what/where" fields (url, title, status, ok, contentType,
 *     mode, platform, tier, truncated, bytes, originStatus, reason)
 *     are kept verbatim — the planner needs them to reason about the
 *     last read.
 *   - Long-form fields (text, snippet, message, error) are capped to
 *     `snippetCharBudget` chars and a "..." marker is appended when
 *     truncated.
 *   - Sets `_truncatedForDirection: true` if any cap fired, so
 *     downstream prompt rendering can disclose the truncation.
 *   - Returns null when the input is null/invalid (no source to
 *     summarise).
 *
 * The full canonical `readSource` is NOT mutated — this is a pure
 * projection. Other consumers (memory, evidence, recent-turns) keep
 * the full text via the original normalized record.
 */
function summarizeReadSourceForDirection(readSource, options) {
  if (!readSource || typeof readSource !== "object" || Array.isArray(readSource)) {
    return null;
  }

  const opts = options && typeof options === "object" ? options : {};
  const snippetBudget = Number.isInteger(opts.snippetCharBudget) && opts.snippetCharBudget > 0
    ? opts.snippetCharBudget
    : DEFAULT_DIRECTION_SNIPPET_BUDGET_CHARS;

  let truncated = false;
  const capLong = (value) => {
    const s = readString(value);
    if (!s) return "";
    if (s.length <= snippetBudget) return s;
    truncated = true;
    return `${s.slice(0, Math.max(0, snippetBudget - 3))}...`;
  };

  const projected = {
    bytes: typeof readSource.bytes === "number" ? readSource.bytes : 0,
    contentType: readString(readSource.contentType),
    error: capLong(readSource.error),
    message: capLong(readSource.message),
    mode: readString(readSource.mode),
    ok: readSource.ok !== false,
    originStatus: typeof readSource.originStatus === "number" ? readSource.originStatus : null,
    platform: readString(readSource.platform),
    reason: readString(readSource.reason),
    snippet: capLong(readSource.snippet),
    status: typeof readSource.status === "number" ? readSource.status : null,
    text: capLong(readSource.text),
    textRange: normalizeTextRange$4(readSource.textRange),
    tier: readString(readSource.tier),
    title: readString(readSource.title),
    truncated: readSource.truncated === true || truncated,
    url: readString(readSource.url)
  };

  if (truncated) {
    projected._truncatedForDirection = true;
  }
  return projected;
}

function normalizeTextRange$4(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    end: readOptionalNonNegativeInteger$1(value.end),
    hasAfter: value.hasAfter === true,
    hasBefore: value.hasBefore === true,
    nextTextStart: readOptionalNonNegativeInteger$1(value.nextTextStart),
    requestedLength: readOptionalPositiveInteger$1(value.requestedLength),
    start: readOptionalNonNegativeInteger$1(value.start) || 0,
    totalChars: readOptionalNonNegativeInteger$1(value.totalChars) || 0
  };
}

function readOptionalPositiveInteger$1(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readOptionalNonNegativeInteger$1(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export { DEFAULT_DIRECTION_SNIPPET_BUDGET_CHARS, inferSelectedSource, isResolvedClarificationKind, normalizeCandidateSource, normalizeCandidateSources, normalizeClarificationResolution, normalizePendingClarification, normalizeReadSource, summarizeReadSourceForDirection };
