import { READ_URL_ACTION, WEB_SEARCH_ACTION } from './action-names.js';
import { explainReadSourceQuality } from './read-source-quality.js';
import { readString } from './semantic-json.js';

const RETRYABLE_ERRORS = new Set([
  "timeout",
  "fetch_failed",
  "READ_URL_SERVICE_UNAVAILABLE"
]);

const NON_RETRYABLE_ERRORS = new Set([
  "blocked_page",
  "empty_content",
  "invalid_method",
  "invalid_url",
  "unsupported_content_type"
]);

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404]);
const MAX_ALTERNATE_SOURCE_CANDIDATES = 5;

function createReadUrlRecoverySignalState() {
  return {
    kind: "read_url_recovery_signal",
    status: "none",
    failedUrl: null,
    statusCode: null,
    originStatus: null,
    reason: null,
    retryable: false,
    sameUrlAttemptCount: 0,
    alternateSourceCandidates: [],
    allowedNextMoves: [],
    forbiddenMove: null,
    updatedAtCycle: null,
    updatedBy: null
  };
}

function isRetryableReadUrlResult(output) {
  return classifyReadUrlFailure(output).retryable === true;
}

function classifyReadUrlFailure(output) {
  const source = output && typeof output === "object" ? output : {};
  const error = readString(source.error);
  const reason = readString(source.reason) || error || null;
  const statusCode = readStatusCode(source.status);
  const originStatus = readStatusCode(source.originStatus);
  const effectiveStatus = originStatus ?? statusCode;

  if (source.ok !== false) {
    return {
      category: "none",
      error: error || null,
      originStatus,
      reason,
      retryable: false,
      statusCode
    };
  }

  if (RETRYABLE_ERRORS.has(error) || RETRYABLE_ERRORS.has(readString(source.code))) {
    return {
      category: "transient",
      error: error || null,
      originStatus,
      reason,
      retryable: true,
      statusCode
    };
  }

  if (effectiveStatus != null && RETRYABLE_STATUS_CODES.has(effectiveStatus)) {
    return {
      category: "transient",
      error: error || null,
      originStatus,
      reason,
      retryable: true,
      statusCode
    };
  }

  if (
    NON_RETRYABLE_ERRORS.has(error) ||
    NON_RETRYABLE_ERRORS.has(readString(source.code)) ||
    (effectiveStatus != null && NON_RETRYABLE_STATUS_CODES.has(effectiveStatus))
  ) {
    return {
      category: "source_blocked",
      error: error || null,
      originStatus,
      reason,
      retryable: false,
      statusCode
    };
  }

  return {
    category: "unknown_failure",
    error: error || null,
    originStatus,
    reason,
    retryable: false,
    statusCode
  };
}

function refreshReadUrlRecoverySignal(runState, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const actionName = readString(context.actionName);
  if (actionName !== READ_URL_ACTION && actionName !== WEB_SEARCH_ACTION) {
    return normalizeSignal(runState.readUrlRecoverySignal);
  }

  const output = context.output && typeof context.output === "object" ? context.output : null;
  const current = normalizeSignal(runState.readUrlRecoverySignal);
  const candidates = readAlternateSourceCandidates(runState, current.failedUrl);

  if (actionName === WEB_SEARCH_ACTION) {
    const next = {
      ...current,
      alternateSourceCandidates: candidates,
      updatedAtCycle: readNullableNumber$2(runState.cycleCount),
      updatedBy: WEB_SEARCH_ACTION
    };
    runState.readUrlRecoverySignal = next;
    return next;
  }

  if (!output) {
    runState.readUrlRecoverySignal = {
      ...current,
      alternateSourceCandidates: candidates,
      updatedAtCycle: readNullableNumber$2(runState.cycleCount),
      updatedBy: READ_URL_ACTION
    };
    return runState.readUrlRecoverySignal;
  }

  // Weak-model trace walk 2026-06-10 — a transport-level "ok" read whose
  // CONTENT is a blocked page (origin 403/captcha/denied: tier "blocked")
  // used to RESET this signal, so the model was never told its source was
  // unusable (gemini wrote 3000 words on 1 usable source out of 3). Classify
  // the content before trusting ok: a blocked-tier read is a failed read for
  // recovery purposes and must raise the signal, not clear it.
  const contentQuality = output.ok !== false ? explainReadSourceQuality(output) : null;
  const unusableContent = Boolean(contentQuality && contentQuality.tier === "blocked");

  if (output.ok !== false && !unusableContent) {
    const next = {
      ...createReadUrlRecoverySignalState(),
      alternateSourceCandidates: readAlternateSourceCandidates(runState, null),
      updatedAtCycle: readNullableNumber$2(runState.cycleCount),
      updatedBy: READ_URL_ACTION
    };
    runState.readUrlRecoverySignal = next;
    return next;
  }

  const failedUrl = readString(output.url) || readString(context.url) || current.failedUrl || null;
  const classification = unusableContent
    ? {
        originStatus: readNullableNumber$2(contentQuality.metrics && contentQuality.metrics.originStatus),
        reason: contentQuality.reason,
        retryable: false,
        statusCode: readNullableNumber$2(output.status)
      }
    : classifyReadUrlFailure(output);
  const attemptCount = countFailedReadAttempts(runState, failedUrl, output);
  const alternateSourceCandidates = readAlternateSourceCandidates(runState, failedUrl);
  const status = readSignalStatus({
    alternateSourceCandidates,
    attemptCount,
    classification
  });
  const allowedNextMoves = readAllowedNextMoves(status, classification, alternateSourceCandidates);
  const forbiddenMove = classification.retryable
    ? null
    : "retry_same_non_retryable_url";

  const next = {
    kind: "read_url_recovery_signal",
    status,
    failedUrl,
    statusCode: classification.statusCode,
    originStatus: classification.originStatus,
    reason: classification.reason,
    retryable: classification.retryable,
    sameUrlAttemptCount: attemptCount,
    alternateSourceCandidates,
    allowedNextMoves,
    forbiddenMove,
    updatedAtCycle: readNullableNumber$2(runState.cycleCount),
    updatedBy: READ_URL_ACTION
  };
  runState.readUrlRecoverySignal = next;
  return next;
}

function summarizeReadUrlRecoverySignal(value) {
  const signal = normalizeSignal(value);
  if (signal.status === "none" && signal.alternateSourceCandidates.length === 0) {
    return null;
  }
  return {
    kind: "read_url_recovery_signal",
    status: signal.status,
    failedUrl: signal.failedUrl,
    statusCode: signal.statusCode,
    originStatus: signal.originStatus,
    reason: signal.reason,
    retryable: signal.retryable === true,
    sameUrlAttemptCount: signal.sameUrlAttemptCount,
    alternateSourceCandidates: signal.alternateSourceCandidates.slice(0, MAX_ALTERNATE_SOURCE_CANDIDATES),
    allowedNextMoves: signal.allowedNextMoves.slice(0, 6),
    forbiddenMove: signal.forbiddenMove,
    nextMoveContract: buildReadUrlNextMoveContract(signal)
  };
}

function buildReadUrlNextMoveContract(signal) {
  if (!signal || signal.status === "none") return null;
  const parts = [
    `read_url recovery status=${signal.status}.`,
    signal.failedUrl ? `failedUrl=${signal.failedUrl}.` : "",
    signal.retryable
      ? "The failure is retryable only within a small budget; avoid repeated same-URL loops."
      : "Do not retry the same non-retryable URL.",
    signal.alternateSourceCandidates.length > 0
      ? `Try an alternate candidate URL first (${signal.alternateSourceCandidates.length} available), or run refined web_search if alternates are weak.`
      : "Run refined web_search for another source if evidence is still needed.",
    "Search snippets are candidate leads only; they do not count as successful read_url evidence.",
    "If evidence is exhausted, publish limited with evidenceSatisfied=false and concrete remainingGaps."
  ];
  return parts.filter(Boolean).join(" ");
}

function readSignalStatus({ alternateSourceCandidates, attemptCount, classification }) {
  if (classification.retryable && attemptCount <= 1) return "retryable_failure";
  if (alternateSourceCandidates.length > 0) return "needs_alternate_source";
  if (classification.retryable) return "needs_alternate_source";
  return "source_blocked";
}

function readAllowedNextMoves(status, classification, alternateSourceCandidates) {
  const moves = [];
  if (classification.retryable && status === "retryable_failure") {
    moves.push("read_url_retry_once_later");
  }
  if (alternateSourceCandidates.length > 0 || status === "needs_alternate_source") {
    moves.push("read_url_alternate");
  }
  moves.push("web_search_refined", "limited_with_remainingGaps");
  return Array.from(new Set(moves));
}

function countFailedReadAttempts(runState, failedUrl, output) {
  const url = normalizeUrlKey$1(failedUrl);
  if (!url) return 0;
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  let count = readSources.filter((source) => (
    source &&
    typeof source === "object" &&
    source.ok === false &&
    normalizeUrlKey$1(source.url) === url
  )).length;
  const currentUrl = normalizeUrlKey$1(output && output.url);
  const currentAlreadyCounted = readSources.some((source) => (
    source === output || (
      source &&
      output &&
      source.ok === false &&
      normalizeUrlKey$1(source.url) === currentUrl &&
      readString(source.error) === readString(output.error) &&
      readStatusCode(source.status) === readStatusCode(output.status)
    )
  ));
  if (currentUrl === url && output && output.ok === false && !currentAlreadyCounted) count += 1;
  return count;
}

function readAlternateSourceCandidates(runState, failedUrl) {
  const failedKey = normalizeUrlKey$1(failedUrl);
  const failedUrls = new Set(readFailedUrls(runState));
  if (failedKey) failedUrls.add(failedKey);
  const readUrls = new Set(readSuccessfulOrAttemptedUrls(runState));

  const raw = [];
  const inquiry = runState &&
    runState.contextSnapshot &&
    runState.contextSnapshot.inquiryContext &&
    typeof runState.contextSnapshot.inquiryContext === "object"
      ? runState.contextSnapshot.inquiryContext
      : {};
  pushCandidateArray(raw, inquiry.candidateSources);
  pushCandidateArray(raw, inquiry.lastSearchResults);
  const researchContext = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  pushCandidateArray(raw, researchContext.aggregatedSearchResults);
  pushCandidateArray(raw, researchContext.searchResults);

  const seen = new Set();
  const candidates = [];
  for (const item of raw) {
    const candidate = normalizeCandidate$1(item);
    if (!candidate) continue;
    const key = normalizeUrlKey$1(candidate.url);
    if (!key || seen.has(key) || failedUrls.has(key) || readUrls.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_ALTERNATE_SOURCE_CANDIDATES) break;
  }
  return candidates;
}

function readSuccessfulOrAttemptedUrls(runState) {
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  return readSources
    .map((source) => normalizeUrlKey$1(source && source.url))
    .filter(Boolean);
}

function readFailedUrls(runState) {
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  return readSources
    .filter((source) => source && typeof source === "object" && source.ok === false)
    .map((source) => normalizeUrlKey$1(source.url))
    .filter(Boolean);
}

function pushCandidateArray(target, value) {
  if (!Array.isArray(value)) return;
  value.forEach((item) => target.push(item));
}

function normalizeCandidate$1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = readString(value.url);
  if (!url) return null;
  return {
    domain: readString(value.domain) || readDomain$6(url),
    query: readString(value.query) || null,
    rank: readNullableNumber$2(value.rank),
    snippet: readString(value.snippet) || readString(value.content) || null,
    title: readString(value.title) || url,
    url
  };
}

function readDomain$6(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeSignal(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : createReadUrlRecoverySignalState();
  return {
    kind: "read_url_recovery_signal",
    status: readString(source.status) || "none",
    failedUrl: readString(source.failedUrl) || null,
    statusCode: readStatusCode(source.statusCode),
    originStatus: readStatusCode(source.originStatus),
    reason: readString(source.reason) || null,
    retryable: source.retryable === true,
    sameUrlAttemptCount: readNumber$c(source.sameUrlAttemptCount),
    alternateSourceCandidates: Array.isArray(source.alternateSourceCandidates)
      ? source.alternateSourceCandidates.map(normalizeCandidate$1).filter(Boolean).slice(0, MAX_ALTERNATE_SOURCE_CANDIDATES)
      : [],
    allowedNextMoves: Array.isArray(source.allowedNextMoves)
      ? source.allowedNextMoves.map(readString).filter(Boolean).slice(0, 8)
      : [],
    forbiddenMove: readString(source.forbiddenMove) || null,
    updatedAtCycle: readNullableNumber$2(source.updatedAtCycle),
    updatedBy: readString(source.updatedBy) || null
  };
}

function normalizeUrlKey$1(value) {
  const url = readString(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function readStatusCode(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumber$c(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNullableNumber$2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export { classifyReadUrlFailure, createReadUrlRecoverySignalState, isRetryableReadUrlResult, refreshReadUrlRecoverySignal, summarizeReadUrlRecoverySignal };
