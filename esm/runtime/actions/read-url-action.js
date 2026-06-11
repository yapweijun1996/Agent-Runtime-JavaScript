import { readUrl } from '../../skills/providers/url-reader.js';
import { explainReadSourceQuality } from '../read-source-quality.js';
import { DEFAULT_READ_URL_MAX_BYTES, normalizeHttpUrl, normalizeReadUrlMethod, normalizeReadUrlMode, normalizePositiveInteger, DEFAULT_READ_URL_TIMEOUT_MS } from '../../skills/providers/url-reader-utils.js';
import { isRetryableReadUrlResult, classifyReadUrlFailure } from '../read-url-recovery-signal.js';

const READ_URL_MAX_RETRIES = 1;
const READ_URL_RETRY_DELAY_MS = 1500;

const readUrlAction = Object.freeze({
  description: "Read the content of a public URL when search snippets are not enough.",
  name: "read_url",
  planner: {
    aliases: ["read", "open_url", "fetch_url"],
    argsExample: {
      maxBytes: DEFAULT_READ_URL_MAX_BYTES,
      mode: "html_text",
      textLength: 1800,
      textStart: 0,
      url: "https://example.com/article"
    },
    argsSchema: {
      headers: { type: "object" },
      maxBytes: { type: "number" },
      method: { type: "string" },
      mode: { type: "string" },
      textLength: { type: "number" },
      textStart: { type: "number" },
      timeoutMs: { type: "number" },
      url: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use read_url when the user gives a URL directly or when web_search snippets are not enough and you need to inspect a page."
  },
  tier: 1,
  execute: executeReadUrlAction,
  outputSchema: {
    kinds: ["read_url_result", "read_url_recovery", "read_url_fallback"],
    controls: ["continue"]
  }
});

async function executeReadUrlAction(context, args) {
  const normalizedArgs = normalizeReadUrlArgs(args, context && context.request);

  if (!normalizedArgs.ok) {
    return {
      control: "continue",
      output: normalizedArgs.output,
      summary: `read_url(invalid) -> ${normalizedArgs.output.error}`
    };
  }

  const readUrlArgs = {
    fetch: context && context.request ? context.request.fetch : null,
    headers: normalizedArgs.headers,
    maxBytes: normalizedArgs.maxBytes,
    method: normalizedArgs.method,
    mode: normalizedArgs.mode,
    textLength: normalizedArgs.textLength,
    textStart: normalizedArgs.textStart,
    timeoutMs: normalizedArgs.timeoutMs,
    url: normalizedArgs.url
  };

  let output = await readUrl(readUrlArgs);

  // Retry on transient failures (timeout, fetch_failed) up to READ_URL_MAX_RETRIES times.
  if (!output.ok && isRetryableReadUrlResult(output)) {
    for (let retry = 0; retry < READ_URL_MAX_RETRIES; retry += 1) {
      await delay$2(READ_URL_RETRY_DELAY_MS);
      output = await readUrl(readUrlArgs);
      if (output.ok || !isRetryableReadUrlResult(output)) {
        break;
      }
    }
  }

  if (!output.ok && shouldUseAlternateCandidateFallback(context)) {
    output = await maybeReadAlternateCandidate(context, output, normalizedArgs, readUrlArgs);
  }

  if (!output.ok) {
    output = {
      ...output,
      recovery: createReadUrlRecovery(output, normalizedArgs)
    };
  }

  // Weak-model trace walk 2026-06-10 — a 403/captcha page reads "ok" at the
  // transport level; saying "ok" to the model hides that the source is
  // unusable as evidence. Name it in the summary the model actually reads.
  const contentQuality = output.ok ? explainReadSourceQuality(output) : null;
  const okSummary = contentQuality && contentQuality.tier === "blocked"
    ? `unusable_source(${contentQuality.reason}) — this page is NOT readable evidence; read an alternate source instead of citing or retrying this URL`
    : "ok";
  return {
    control: "continue",
    output,
    summary: `read_url(${normalizedArgs.url}) -> ${output.ok ? okSummary : output.error || "failed"}`
  };
}

function normalizeReadUrlArgs(args, request) {
  const prompt = request && typeof request.prompt === "string" ? request.prompt : "";
  const rawMethod = readString$P(args && args.method).toUpperCase();
  const url = normalizeHttpUrl(
    readString$P(args && args.url) ||
    extractFirstUrl(prompt) ||
    readSnapshotSelectedUrl(request)
  );
  const method = rawMethod ? normalizeReadUrlMethod(rawMethod) : "GET";
  const mode = normalizeReadUrlMode(args && args.mode);
  const timeoutMs = normalizePositiveInteger(args && args.timeoutMs, DEFAULT_READ_URL_TIMEOUT_MS);
  const maxBytes = normalizePositiveInteger(args && args.maxBytes, DEFAULT_READ_URL_MAX_BYTES);
  const textStart = normalizeNonNegativeInteger$1(args && args.textStart, 0);
  const textLength = normalizePositiveInteger(args && args.textLength, 0);
  const headers = args && typeof args.headers === "object" && !Array.isArray(args.headers)
    ? args.headers
    : {};

  if (!url) {
    return {
      ok: false,
      output: createInvalidReadUrlOutput("invalid_url", 'read_url requires a valid http/https "url".', mode)
    };
  }

  if (rawMethod && method !== "GET" && method !== "HEAD") {
    return {
      ok: false,
      output: createInvalidReadUrlOutput("invalid_method", 'read_url only supports "GET" or "HEAD".', mode, url)
    };
  }

  return {
    headers,
    maxBytes,
    method,
    mode,
    ok: true,
    textLength,
    textStart,
    timeoutMs,
    url
  };
}

function createInvalidReadUrlOutput(error, message, mode, url) {
  return {
    bytes: 0,
    contentType: "",
    error,
    kind: "read_url_result",
    message,
    mode,
    ok: false,
    platform: "browser",
    reason: error,
    screenshotDataUrl: "",
    screenshotMimeType: "",
    status: null,
    statusText: "",
    text: "",
    title: "",
    truncated: false,
    url: url || ""
  };
}

function createReadUrlRecovery(output, args) {
  const classification = classifyReadUrlFailure(output);
  const reason = readString$P(output && (output.reason || output.error));
  return {
    kind: "read_url_recovery",
    retryable: classification.retryable === true,
    status: classification.statusCode,
    originStatus: classification.originStatus,
    reason: reason || classification.reason || null,
    url: args && args.url || "",
    nextActionOptions: [
      "Use web_search with a refined query to find alternate primary, official, documentation, paper, or project sources.",
      "Use read_url on a different high-quality result before treating evidence as source-backed.",
      "If this exact URL is important and the failure is retryable, retry read_url once later; do not loop on the same failed URL.",
      "If no successful read_url source is available, publish only with honest limitations and do not mark evidence as fully satisfied."
    ]
  };
}

async function maybeReadAlternateCandidate(context, output, normalizedArgs, readUrlArgs) {
  const candidate = findAlternateCandidate(context, normalizedArgs.url);
  if (!candidate) {
    return output;
  }

  const fallbackArgs = {
    ...readUrlArgs,
    textStart: 0,
    url: candidate.url
  };
  if (typeof context?.pushStep === "function") {
    context.pushStep("read-url-fallback-attempt", {
      fromUrl: normalizedArgs.url,
      reason: readString$P(output && (output.reason || output.error)) || "read_url_failed",
      url: candidate.url
    });
  }

  const fallbackOutput = await readUrl(fallbackArgs);
  const fallback = {
    kind: "read_url_fallback",
    fromUrl: normalizedArgs.url,
    selectedUrl: candidate.url,
    selectedTitle: candidate.title || "",
    selectedDomain: candidate.domain || "",
    result: {
      error: readString$P(fallbackOutput && fallbackOutput.error),
      ok: fallbackOutput && fallbackOutput.ok !== false,
      status: typeof fallbackOutput?.status === "number" ? fallbackOutput.status : null,
      originStatus: typeof fallbackOutput?.originStatus === "number" ? fallbackOutput.originStatus : null
    }
  };

  if (typeof context?.pushStep === "function") {
    context.pushStep("read-url-fallback-completed", fallback);
  }

  if (fallbackOutput && fallbackOutput.ok !== false) {
    return {
      ...fallbackOutput,
      fallback
    };
  }

  return {
    ...output,
    fallback
  };
}

function shouldUseAlternateCandidateFallback(context) {
  const config = context && context.runtimeConfig && typeof context.runtimeConfig === "object"
    ? context.runtimeConfig
    : {};
  const fallback = config.readUrlFallback;
  const enabled = fallback === true || (fallback && typeof fallback === "object" && fallback.enabled === true);
  if (!enabled) {
    return false;
  }
  // Approval resumes should execute exactly the approved URL. Alternate-source
  // recovery belongs to autonomous runs where the host has already allowed
  // tier-1 research actions.
  return readString$P(context?.request?.type) !== "approval_resolution";
}

function findAlternateCandidate(context, failedUrl) {
  const failed = new Set(readFailedUrlKeys(context, failedUrl));
  const seen = new Set();
  for (const candidate of collectCandidateSources(context)) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    const key = normalizeUrlKey(normalized.url);
    if (!key || failed.has(key) || seen.has(key)) continue;
    seen.add(key);
    return normalized;
  }
  return null;
}

function collectCandidateSources(context) {
  const runState = context && context.runState && typeof context.runState === "object" ? context.runState : {};
  const researchContext = runState.researchContext && typeof runState.researchContext === "object" ? runState.researchContext : {};
  const snapshot = runState.contextSnapshot && typeof runState.contextSnapshot === "object" ? runState.contextSnapshot : {};
  const inquiryContext = snapshot.inquiryContext && typeof snapshot.inquiryContext === "object" ? snapshot.inquiryContext : {};
  return [
    ...readArray$1(context && context.searchResults),
    ...readArray$1(inquiryContext.candidateSources),
    ...readArray$1(inquiryContext.lastSearchResults),
    ...readArray$1(researchContext.aggregatedSearchResults),
    ...readArray$1(researchContext.searchResults)
  ];
}

function readFailedUrlKeys(context, failedUrl) {
  const keys = [];
  const failedKey = normalizeUrlKey(failedUrl);
  if (failedKey) keys.push(failedKey);
  const readSources = readArray$1(context?.runState?.researchContext?.readSources);
  for (const source of readSources) {
    if (source && typeof source === "object" && source.ok === false) {
      const key = normalizeUrlKey(source.url);
      if (key) keys.push(key);
    }
  }
  return keys;
}

function normalizeCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = normalizeHttpUrl(readString$P(value.url));
  if (!url) return null;
  return {
    domain: readString$P(value.domain) || readDomain$1(url),
    title: readString$P(value.title) || url,
    url
  };
}

function normalizeUrlKey(value) {
  const url = normalizeHttpUrl(readString$P(value));
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function readDomain$1(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function readArray$1(value) {
  return Array.isArray(value) ? value : [];
}

function readString$P(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNonNegativeInteger$1(value, fallbackValue) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallbackValue;
}

function extractFirstUrl(text) {
  const match = typeof text === "string"
    ? text.match(/https?:\/\/[^\s)]+/i)
    : null;

  return match ? match[0] : "";
}

function delay$2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSnapshotSelectedUrl(request) {
  const snapshot = request && typeof request === "object" && request.contextSnapshot && typeof request.contextSnapshot === "object"
    ? request.contextSnapshot
    : null;
  const inquiryContext = snapshot && snapshot.inquiryContext && typeof snapshot.inquiryContext === "object"
    ? snapshot.inquiryContext
    : null;
  const selectedSource = inquiryContext && inquiryContext.selectedSource && typeof inquiryContext.selectedSource === "object"
    ? inquiryContext.selectedSource
    : null;
  const singleCandidate = inquiryContext && Array.isArray(inquiryContext.candidateSources) && inquiryContext.candidateSources.length === 1
    ? inquiryContext.candidateSources[0]
    : null;

  return readString$P(selectedSource && selectedSource.url) || readString$P(singleCandidate && singleCandidate.url);
}

export { executeReadUrlAction, normalizeReadUrlArgs, readUrlAction };
