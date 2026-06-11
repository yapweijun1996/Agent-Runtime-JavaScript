function shouldProxyRequest(requestUrl, method, init, endpoint, passthroughUrls) {
  if (!requestUrl || (method !== "GET" && method !== "HEAD")) {
    return false;
  }

  if (!isHttpUrl(requestUrl) || init.body != null) {
    return false;
  }

  if (requestUrl === endpoint || requestUrl.startsWith(`${endpoint}?`)) {
    return false;
  }

  return !passthroughUrls.some((prefix) => requestUrl === prefix || requestUrl.startsWith(prefix));
}

function createSyntheticReadResponse(payload, serviceResponse, requestUrl, method, attachMeta) {
  const responseStatus = readResponseStatus(serviceResponse);
  const originStatus = readOriginStatus(payload);
  const ok = shouldTreatPayloadAsSuccess(payload, responseStatus, originStatus);
  const textRange = readServiceTextRange(payload);

  if (!ok) {
    const failureStatus = readFailureStatus(originStatus, responseStatus);
    const failureResponse = new Response(allowsResponseBody(failureStatus) ? "" : null, {
      headers: new Headers({
        "content-type": "text/plain; charset=utf-8",
        "x-agrun-read-url-error": readServiceErrorCode(payload),
        "x-agrun-read-url-message": readServiceErrorMessage(payload, failureStatus),
        "x-agrun-read-url-platform": "read_url_service",
        "x-agrun-read-url-reason": readServiceReason(payload),
        "x-agrun-read-url-url": readString$S(payload && (payload.finalUrl || payload.url)) || requestUrl,
        "x-agrun-read-url-origin-status": originStatus ? String(originStatus) : ""
      }),
      status: failureStatus
    });

    attachMeta(failureResponse, payload);
    return failureResponse;
  }

  const successStatus = readSuccessStatus(responseStatus);
  const successResponse = new Response(method === "HEAD" ? "" : buildReadableBody(payload), {
    headers: new Headers({
      "content-type": "text/markdown; charset=utf-8",
      "x-agrun-read-url-final-url": readString$S(payload && (payload.finalUrl || payload.url)) || requestUrl,
      "x-agrun-read-url-from-cache": String(Boolean(payload && payload.meta && payload.meta.fromCache)),
      "x-agrun-read-url-load-time-ms": readPositiveInteger$g(payload && payload.meta && payload.meta.loadTimeMs)
        ? String(payload.meta.loadTimeMs)
        : "",
      "x-agrun-read-url-origin-status": originStatus ? String(originStatus) : "",
      "x-agrun-read-url-platform": "read_url_service",
      "x-agrun-read-url-text-range-end": textRange ? String(textRange.end) : "",
      "x-agrun-read-url-text-range-has-after": textRange ? String(textRange.hasAfter === true) : "",
      "x-agrun-read-url-text-range-has-before": textRange ? String(textRange.hasBefore === true) : "",
      "x-agrun-read-url-text-range-next-start": textRange && textRange.nextTextStart != null ? String(textRange.nextTextStart) : "",
      "x-agrun-read-url-text-range-requested-length": textRange && textRange.requestedLength != null ? String(textRange.requestedLength) : "",
      "x-agrun-read-url-text-range-start": textRange ? String(textRange.start) : "",
      "x-agrun-read-url-text-range-total": textRange ? String(textRange.totalChars) : "",
      "x-agrun-read-url-window-applied": textRange ? "true" : "",
      "x-agrun-read-url-title": readString$S(payload && payload.title)
    }),
    status: successStatus
  });

  attachMeta(successResponse, payload);
  return successResponse;
}

function buildReadableBody(payload) {
  const markdown = readString$S(payload && payload.contentMarkdown);
  if (markdown) {
    return markdown;
  }

  const title = readString$S(payload && payload.title);
  const excerpt = readString$S(payload && payload.textExcerpt);
  const finalUrl = readString$S(payload && (payload.finalUrl || payload.url));

  return [
    title ? `# ${title}` : "",
    excerpt,
    finalUrl ? `Source: ${finalUrl}` : ""
  ].filter(Boolean).join("\n\n");
}

function buildServiceHeaders(sourceHeaders, apiKey, authMode) {
  const headers = new Headers(sourceHeaders || undefined);
  headers.set("content-type", "application/json");

  if (apiKey) {
    if (authMode === "bearer") {
      headers.set("authorization", `Bearer ${apiKey}`);
    } else {
      headers.set("x-api-key", apiKey);
    }
  }

  return headers;
}

function readRequestUrl(input) {
  if (typeof input === "string") {
    return input.trim();
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (input && typeof input === "object" && typeof input.url === "string") {
    return input.url.trim();
  }

  return "";
}

function normalizeServiceEndpoint(value) {
  const endpoint = readString$S(value);
  if (!endpoint) {
    return "";
  }

  return endpoint.endsWith("/read-url")
    ? endpoint
    : `${endpoint.replace(/\/+$/, "")}/read-url`;
}

function normalizeAuthMode(value) {
  return value === "bearer" ? "bearer" : "x-api-key";
}

function normalizeMethod(value) {
  const method = readString$S(value).toUpperCase();
  return method || "GET";
}

function resolveBaseFetch(fetchImpl) {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error("A fetch implementation is required for read URL service adapters.");
}

function readPositiveInteger$g(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readNonNegativeInteger$2(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readResponseStatus(response) {
  return typeof response.status === "number" ? response.status : 502;
}

function readServiceErrorCode(payload) {
  const error = readServiceError(payload);
  return readString$S(error && error.code) || readString$S(payload && payload.error) || "READ_URL_SERVICE_ERROR";
}

function readServiceReason(payload) {
  return readString$S(payload && payload.reason) || readServiceErrorCode(payload);
}

function readServiceErrorMessage(payload, status) {
  const error = readServiceError(payload);
  return readString$S(error && error.message) ||
    readString$S(payload && payload.message) ||
    `Read URL service failed with status ${status}.`;
}

function shouldTreatPayloadAsSuccess(payload, responseStatus, originStatus) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (payload.ok === false || responseStatus < 200 || responseStatus >= 300) {
    return false;
  }

  if (!originStatus) {
    return true;
  }

  return (originStatus >= 200 && originStatus < 300) || hasReadablePayloadContent(payload);
}

function hasReadablePayloadContent(payload) {
  return Boolean(
    readString$S(payload && payload.contentMarkdown) ||
    readString$S(payload && payload.textExcerpt)
  );
}

function readSuccessStatus(responseStatus) {
  return responseStatus >= 200 && responseStatus < 300 ? responseStatus : 200;
}

function readFailureStatus(originStatus, responseStatus) {
  if (originStatus && allowsResponseBody(originStatus)) {
    return originStatus;
  }

  if (responseStatus >= 400 && responseStatus < 600 && allowsResponseBody(responseStatus)) {
    return responseStatus;
  }

  return 502;
}

function readOriginStatus(payload) {
  return readPositiveInteger$g(payload && payload.meta && payload.meta.statusCode);
}

function readServiceTextRange(payload) {
  const direct = normalizeTextRange$2(payload && payload.textRange);
  if (direct) {
    return direct;
  }

  return normalizeTextRange$2(payload && payload.meta && payload.meta.textRange);
}

function normalizeTextRange$2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const start = readNonNegativeInteger$2(value.start);
  const end = readNonNegativeInteger$2(value.end);
  const totalChars = readNonNegativeInteger$2(value.totalChars);
  if (start == null || end == null || totalChars == null) {
    return null;
  }

  return {
    end,
    hasAfter: value.hasAfter === true,
    hasBefore: value.hasBefore === true,
    nextTextStart: readNonNegativeInteger$2(value.nextTextStart),
    requestedLength: readPositiveInteger$g(value.requestedLength),
    start,
    totalChars
  };
}

function readServiceError(payload) {
  return payload && typeof payload.error === "object" && payload.error
    ? payload.error
    : null;
}

function allowsResponseBody(status) {
  return status !== 204 && status !== 304;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readString$S(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildReadableBody, buildServiceHeaders, createSyntheticReadResponse, normalizeAuthMode, normalizeMethod, normalizeServiceEndpoint, readNonNegativeInteger$2 as readNonNegativeInteger, readPositiveInteger$g as readPositiveInteger, readRequestUrl, resolveBaseFetch, shouldProxyRequest };
