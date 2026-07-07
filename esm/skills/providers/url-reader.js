import { resolveFetch, normalizePositiveInteger, normalizeHeaders, READ_URL_WATCHDOG_GRACE_MS, readContentType, deriveReadMode, isTextLikeContentType, DEFAULT_READ_URL_TIMEOUT_MS, DEFAULT_READ_URL_MAX_BYTES, buildAcceptHeader, extractReadableHtmlText, htmlToText } from './url-reader-utils.js';
import { readResponseMeta, readServiceReadFailure, createReadUrlFailure, createReadUrlSuccess, detectReadQualityFailure, createReadUrlFetchFailure } from './url-reader-response.js';

const MIN_EXTRACTED_HTML_TEXT_LENGTH = 200;

async function readUrl(request) {
  const resolvedFetch = resolveFetch(request && request.fetch);
  const method = request.method;
  const timeoutMs = normalizePositiveInteger(request.timeoutMs, DEFAULT_READ_URL_TIMEOUT_MS);
  const maxBytes = normalizePositiveInteger(request.maxBytes, DEFAULT_READ_URL_MAX_BYTES);
  const textStart = normalizeNonNegativeInteger$2(request && request.textStart, 0);
  const textLength = normalizePositiveInteger(request && request.textLength, 0);
  const requestedMode = request.mode;
  const headers = {
    Accept: buildAcceptHeader(requestedMode),
    ...normalizeHeaders(request && request.headers)
  };
  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  // Watchdog sits READ_URL_WATCHDOG_GRACE_MS above the render budget so a
  // proxied read that legitimately uses the full timeoutMs server-side is
  // not aborted mid-response; see url-reader-utils.js for the arithmetic.
  const timer = abortController
    ? setTimeout(() => abortController.abort(), timeoutMs + READ_URL_WATCHDOG_GRACE_MS)
    : null;

  try {
    const fetchInit = {
      headers,
      maxBytes,
      method,
      signal: abortController ? abortController.signal : undefined,
      textLength: textLength || undefined,
      textStart,
      timeoutMs
    };
    const response = await resolvedFetch(request.url, fetchInit);
    const contentType = readContentType(response.headers);
    const mode = deriveReadMode(requestedMode, contentType);
    const responseMeta = readResponseMeta(response);
    const serviceFailure = readServiceReadFailure({
      contentType,
      mode,
      response,
      url: request.url
    });

    if (serviceFailure) {
      return serviceFailure;
    }

    if (!response.ok) {
      return createReadUrlFailure({
        contentType,
        error: "http_error",
        message: `URL request failed with status ${response.status}.`,
        mode,
        response,
        url: request.url
      });
    }

    if (method === "HEAD") {
      return createReadUrlSuccess({
        bytes: 0,
        contentType,
        meta: responseMeta,
        mode,
        response,
        text: "",
        truncated: false,
        url: request.url
      });
    }

    if (!isTextLikeContentType(contentType)) {
      return createReadUrlFailure({
        contentType,
        error: "unsupported_content_type",
        message: contentType
          ? `Cannot read non-text content type "${contentType}".`
          : "Cannot read non-text content.",
        mode,
        response,
        url: request.url
      });
    }

    const body = await readResponseBody(response, maxBytes);
    const formattedText = formatReadText(body.text, mode);
    const serviceWindowed = responseMeta.textWindowApplied === true && responseMeta.textRange
      ? {
          range: responseMeta.textRange,
          text: formattedText,
          truncated: responseMeta.textRange.hasBefore || responseMeta.textRange.hasAfter
        }
      : null;
    const windowed = serviceWindowed || selectTextWindow(formattedText, { textLength, textStart });
    const qualityFailure = detectReadQualityFailure({
      bytes: body.bytes,
      contentType,
      mode,
      response,
      text: formattedText,
      truncated: body.truncated,
      url: request.url
    });

    if (qualityFailure) {
      return qualityFailure;
    }

    return createReadUrlSuccess({
      bytes: body.bytes,
      contentType,
      meta: responseMeta,
      mode,
      response,
      text: windowed.text,
      textRange: windowed.range,
      truncated: body.truncated || windowed.truncated,
      url: request.url
    });
  } catch (error) {
    return createReadUrlFetchFailure(error, request);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function selectTextWindow(text, options) {
  const source = typeof text === "string" ? text : "";
  const totalChars = source.length;
  const requestedStart = normalizeNonNegativeInteger$2(options && options.textStart, 0);
  const start = Math.min(requestedStart, totalChars);
  const requestedLength = normalizePositiveInteger(options && options.textLength, 0);
  const end = requestedLength > 0
    ? Math.min(totalChars, start + requestedLength)
    : totalChars;
  const hasBefore = start > 0;
  const hasAfter = end < totalChars;
  return {
    range: {
      end,
      hasAfter,
      hasBefore,
      nextTextStart: hasAfter ? end : null,
      requestedLength: requestedLength || null,
      start,
      totalChars
    },
    text: source.slice(start, end),
    truncated: hasBefore || hasAfter
  };
}

async function readResponseBody(response, maxBytes) {
  const stream = response && response.body && typeof response.body.getReader === "function"
    ? response.body
    : null;

  if (!stream) {
    const text = typeof response.text === "function" ? await response.text() : "";
    return truncateTextByBytes(text, maxBytes);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let truncated = false;
  let text = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    const value = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value || []);
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
    bytes += slice.byteLength;
    text += decoder.decode(slice, { stream: true });

    if (slice.byteLength < value.byteLength) {
      truncated = true;
      break;
    }
  }

  text += decoder.decode();

  if (truncated && typeof reader.cancel === "function") {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from partial reads.
    }
  }

  return { bytes, text, truncated };
}

function truncateTextByBytes(text, maxBytes) {
  const source = typeof text === "string" ? text : "";

  if (!source) {
    return { bytes: 0, text: "", truncated: false };
  }

  const encoder = new TextEncoder();
  const encoded = encoder.encode(source);
  if (encoded.byteLength <= maxBytes) {
    return { bytes: encoded.byteLength, text: source, truncated: false };
  }

  const slice = encoded.slice(0, maxBytes);
  return {
    bytes: slice.byteLength,
    text: new TextDecoder().decode(slice),
    truncated: true
  };
}

function formatReadText(text, mode) {
  if (mode === "html_text") {
    const extracted = extractReadableHtmlText(text);
    if (extracted.length >= MIN_EXTRACTED_HTML_TEXT_LENGTH) {
      return extracted;
    }

    return htmlToText(text);
  }

  if (mode === "json") {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text.trim();
    }
  }

  return typeof text === "string" ? text.trim() : "";
}

function normalizeNonNegativeInteger$2(value, fallbackValue) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallbackValue;
}

export { readUrl };
