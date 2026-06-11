import { readHeaderValue } from './url-reader-utils.js';
import { readReadUrlResponseMeta } from './read-url-service-fetch.js';

function createReadUrlSuccess(options) {
  return {
    bytes: options.bytes,
    contentType: options.contentType || "",
    kind: "read_url_result",
    message: readString$Q(options.meta && options.meta.message),
    mode: options.mode,
    ok: true,
    originStatus: typeof options.meta?.originStatus === "number" ? options.meta.originStatus : null,
    platform: readString$Q(options.meta && options.meta.platform),
    screenshotDataUrl: readString$Q(options.meta && options.meta.screenshotDataUrl),
    screenshotMimeType: readString$Q(options.meta && options.meta.screenshotMimeType),
    status: typeof options.response.status === "number" ? options.response.status : null,
    statusText: typeof options.response.statusText === "string" ? options.response.statusText : "",
    text: options.text,
    textRange: normalizeTextRange(options.textRange),
    title: readString$Q(options.meta && options.meta.title),
    truncated: options.truncated === true,
    url: options.url
  };
}

function createReadUrlFailure(options) {
  return {
    bytes: typeof options.bytes === "number" ? options.bytes : 0,
    contentType: options.contentType || "",
    error: options.error,
    kind: "read_url_result",
    message: options.message,
    mode: options.mode,
    ok: false,
    originStatus: typeof options.originStatus === "number" ? options.originStatus : null,
    platform: options.platform || null,
    reason: options.reason || null,
    screenshotDataUrl: "",
    screenshotMimeType: "",
    status: options.response && typeof options.response.status === "number" ? options.response.status : null,
    statusText: options.response && typeof options.response.statusText === "string" ? options.response.statusText : "",
    text: "",
    title: "",
    truncated: options.truncated === true,
    url: options.url
  };
}

function createReadUrlFetchFailure(error, request) {
  if (error && (error.name === "AbortError" || error.code === 20)) {
    return createReadUrlFailure({
      error: "timeout",
      message: `Timed out after ${request.timeoutMs}ms.`,
      mode: request.mode,
      reason: "timeout",
      url: request.url
    });
  }

  return createReadUrlFailure({
    error: "fetch_failed",
    message: "Environment Restriction (Browser CORS) or network fetch failed.",
    mode: request.mode,
    platform: "browser",
    reason: "cors_blocked",
    url: request.url
  });
}

function readServiceReadFailure(options) {
  const error = readHeaderValue(options.response && options.response.headers, "x-agrun-read-url-error");
  if (!error) {
    return null;
  }

  return createReadUrlFailure({
    contentType: options.contentType,
    error,
    message: readHeaderValue(options.response && options.response.headers, "x-agrun-read-url-message") ||
      `Read URL service failed with status ${options.response.status}.`,
    mode: options.mode,
    originStatus: readOptionalPositiveInteger(
      readHeaderValue(options.response && options.response.headers, "x-agrun-read-url-origin-status")
    ),
    platform: readHeaderValue(options.response && options.response.headers, "x-agrun-read-url-platform") || "read_url_service",
    reason: readHeaderValue(options.response && options.response.headers, "x-agrun-read-url-reason") || error,
    response: options.response,
    url: readHeaderValue(options.response && options.response.headers, "x-agrun-read-url-url") || options.url
  });
}

function readResponseMeta(response) {
  const meta = readReadUrlResponseMeta(response) || {};
  const platform = readHeaderValue(response && response.headers, "x-agrun-read-url-platform");
  const headerTextRange = readHeaderTextRange(response && response.headers);

  return {
    message: readHeaderValue(response && response.headers, "x-agrun-read-url-message"),
    originStatus: readOptionalPositiveInteger(
      readHeaderValue(response && response.headers, "x-agrun-read-url-origin-status")
    ) || (typeof meta.originStatus === "number" ? meta.originStatus : null),
    platform: platform || "browser",
    screenshotDataUrl: readString$Q(meta.screenshotDataUrl),
    screenshotMimeType: readString$Q(meta.screenshotMimeType),
    textRange: normalizeTextRange(meta.textRange) || headerTextRange,
    textWindowApplied: meta.textWindowApplied === true ||
      readHeaderValue(response && response.headers, "x-agrun-read-url-window-applied") === "true",
    title: readString$Q(meta.title)
  };
}

function detectReadQualityFailure(options) {
  const wafAction = readHeaderValue(options.response && options.response.headers, "x-amzn-waf-action").toLowerCase();
  const status = options.response && typeof options.response.status === "number" ? options.response.status : null;
  const text = typeof options.text === "string" ? options.text.trim() : "";

  if (wafAction === "challenge") {
    return createReadUrlFailure({
      bytes: options.bytes,
      contentType: options.contentType,
      error: "blocked_page",
      message: "The page returned a WAF challenge instead of readable content.",
      mode: options.mode,
      platform: "browser",
      reason: "waf_challenge",
      response: options.response,
      truncated: options.truncated,
      url: options.url
    });
  }

  if (status === 202) {
    return createReadUrlFailure({
      bytes: options.bytes,
      contentType: options.contentType,
      error: "blocked_page",
      message: "The page returned an accepted/challenge response instead of readable content.",
      mode: options.mode,
      platform: "browser",
      reason: "non_final_response",
      response: options.response,
      truncated: options.truncated,
      url: options.url
    });
  }

  if (options.mode === "html_text" && text.length === 0) {
    return createReadUrlFailure({
      bytes: options.bytes,
      contentType: options.contentType,
      error: "empty_content",
      message: "The page did not expose readable body text.",
      mode: options.mode,
      platform: "browser",
      reason: "empty_content",
      response: options.response,
      truncated: options.truncated,
      url: options.url
    });
  }

  return null;
}

function readString$Q(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTextRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return {
    end: readOptionalNonNegativeInteger(value.end),
    hasAfter: value.hasAfter === true,
    hasBefore: value.hasBefore === true,
    nextTextStart: readOptionalNonNegativeInteger(value.nextTextStart),
    requestedLength: readOptionalPositiveInteger(value.requestedLength),
    start: readOptionalNonNegativeInteger(value.start) || 0,
    totalChars: readOptionalNonNegativeInteger(value.totalChars) || 0
  };
}

function readHeaderTextRange(headers) {
  const start = readOptionalNonNegativeInteger(readHeaderValue(headers, "x-agrun-read-url-text-range-start"));
  const end = readOptionalNonNegativeInteger(readHeaderValue(headers, "x-agrun-read-url-text-range-end"));
  const totalChars = readOptionalNonNegativeInteger(readHeaderValue(headers, "x-agrun-read-url-text-range-total"));
  if (start == null || end == null || totalChars == null) {
    return null;
  }

  return normalizeTextRange({
    end,
    hasAfter: readHeaderValue(headers, "x-agrun-read-url-text-range-has-after") === "true",
    hasBefore: readHeaderValue(headers, "x-agrun-read-url-text-range-has-before") === "true",
    nextTextStart: readOptionalNonNegativeInteger(readHeaderValue(headers, "x-agrun-read-url-text-range-next-start")),
    requestedLength: readOptionalPositiveInteger(readHeaderValue(headers, "x-agrun-read-url-text-range-requested-length")),
    start,
    totalChars
  });
}

function readOptionalPositiveInteger(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function readOptionalNonNegativeInteger(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

export { createReadUrlFailure, createReadUrlFetchFailure, createReadUrlSuccess, detectReadQualityFailure, readResponseMeta, readServiceReadFailure };
