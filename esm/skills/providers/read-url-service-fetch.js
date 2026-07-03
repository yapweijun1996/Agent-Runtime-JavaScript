import { normalizeServiceEndpoint, normalizeAuthMode, resolveBaseFetch, readRequestUrl, normalizeMethod, shouldProxyRequest, buildServiceHeaders, readPositiveInteger, readNonNegativeInteger, createSyntheticReadResponse } from './read-url-service-helpers.js';
import { readString } from '../../runtime/semantic-json.js';

const DEFAULT_WAIT_UNTIL = "domcontentloaded";
const READ_URL_RESPONSE_META = new WeakMap();
const RETRYABLE_READ_URL_SERVICE_ERROR = "READ_URL_SERVICE_UNAVAILABLE";

function createReadUrlServiceFetch(options = {}) {
  const endpoint = normalizeServiceEndpoint(options.endpoint);
  const authMode = normalizeAuthMode(options.authMode);
  const apiKey = readString(options.apiKey);
  const baseFetch = resolveBaseFetch(options.baseFetch);
  const includeScreenshot = options.includeScreenshot === true;
  const passthroughUrls = Array.isArray(options.passthroughUrls)
    ? options.passthroughUrls.map(readString).filter(Boolean)
    : [];
  const waitUntil = readString(options.waitUntil) || DEFAULT_WAIT_UNTIL;

  if (!endpoint) {
    throw new Error('Read URL service fetch requires a non-empty "endpoint".');
  }

  return async function readUrlServiceFetch(input, init = {}) {
    const requestUrl = readRequestUrl(input);
    const method = normalizeMethod(init.method);

    if (!shouldProxyRequest(requestUrl, method, init, endpoint, passthroughUrls)) {
      return baseFetch(input, init);
    }

    try {
      const serviceResponse = await baseFetch(endpoint, {
        body: JSON.stringify({
          includeScreenshot,
          maxBytes: readPositiveInteger(init.maxBytes),
          textLength: readPositiveInteger(init.textLength),
          textStart: readNonNegativeInteger(init.textStart),
          timeoutMs: readPositiveInteger(init.timeoutMs),
          url: requestUrl,
          waitUntil
        }),
        headers: buildServiceHeaders(init.headers, apiKey, authMode),
        method: "POST",
        signal: init.signal
      });

      const payload = await readServicePayload(serviceResponse);
      return createSyntheticReadResponse(payload, serviceResponse, requestUrl, method, attachReadUrlMeta);
    } catch (error) {
      throw createRetryableReadUrlServiceError(error, endpoint, requestUrl);
    }
  };
}

function readReadUrlResponseMeta(response) {
  return response && typeof response === "object"
    ? READ_URL_RESPONSE_META.get(response) || null
    : null;
}

function isRetryableReadUrlServiceFetchError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    error.code === RETRYABLE_READ_URL_SERVICE_ERROR &&
    error.retryable === true
  );
}

async function readServicePayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function attachReadUrlMeta(response, payload) {
  if (!response || typeof response !== "object") {
    return;
  }

  const screenshotBase64 = readString(payload && payload.screenshotBase64);
  const screenshotMimeType = readString(payload && payload.screenshotMimeType) || "image/jpeg";
  const textRange = normalizeTextRange$1(
    (payload && payload.textRange) || (payload && payload.meta && payload.meta.textRange)
  );

  READ_URL_RESPONSE_META.set(response, {
    fromCache: Boolean(payload && payload.meta && payload.meta.fromCache),
    loadTimeMs: readPositiveInteger(payload && payload.meta && payload.meta.loadTimeMs),
    originStatus: readPositiveInteger(payload && payload.meta && payload.meta.statusCode),
    screenshotDataUrl: screenshotBase64
      ? `data:${screenshotMimeType};base64,${screenshotBase64}`
      : "",
    screenshotMimeType,
    textRange,
    textWindowApplied: Boolean(textRange),
    title: readString(payload && payload.title)
  });
}

function createRetryableReadUrlServiceError(error, endpoint, requestUrl) {
  if (isRetryableReadUrlServiceFetchError(error)) {
    return error;
  }

  const retryableError = new Error(readRetryableErrorMessage(error));
  retryableError.name = "ReadUrlServiceFetchError";
  retryableError.code = RETRYABLE_READ_URL_SERVICE_ERROR;
  retryableError.retryable = true;
  retryableError.cause = error;
  retryableError.endpoint = endpoint;
  retryableError.requestUrl = requestUrl;
  return retryableError;
}

function readRetryableErrorMessage(error) {
  if (error && (error.name === "AbortError" || error.code === 20)) {
    return "Read URL service request timed out before a response was available.";
  }

  return "Read URL service request failed before a response was available.";
}

function normalizeTextRange$1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const start = readNonNegativeInteger(value.start);
  const end = readNonNegativeInteger(value.end);
  const totalChars = readNonNegativeInteger(value.totalChars);
  if (start == null || end == null || totalChars == null) {
    return null;
  }

  return {
    end,
    hasAfter: value.hasAfter === true,
    hasBefore: value.hasBefore === true,
    nextTextStart: readNonNegativeInteger(value.nextTextStart),
    requestedLength: readPositiveInteger(value.requestedLength),
    start,
    totalChars
  };
}

export { createReadUrlServiceFetch, isRetryableReadUrlServiceFetchError, readReadUrlResponseMeta };
