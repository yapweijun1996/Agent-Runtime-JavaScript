const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:sk|gm)-[A-Za-z0-9._~+/-]{3,}/g,
  /gw_[A-Za-z0-9._~+/-]{6,}/g,
  /\b(?:sk|gm|gw_|AIza)[A-Za-z0-9._~+/=-]{6,}\b/g
];
const SECRET_FIELD_PATTERN = /("(?:apiKey|authorization|Authorization|x-goog-api-key)"\s*:\s*")[^"]+(")/g;

function attachProviderError(error, providerHint) {
  const normalized = normalizeProviderError(error, providerHint);
  if (normalized && error && typeof error === "object") {
    try {
      Object.defineProperty(error, "__agrunProviderError", {
        configurable: true,
        enumerable: false,
        value: normalized
      });
    } catch {
      error.__agrunProviderError = normalized;
    }
  }
  return error;
}

function readProviderError(value, providerHint) {
  if (value && typeof value === "object" && value.__agrunProviderError) {
    return cloneProviderError(value.__agrunProviderError);
  }
  return normalizeProviderError(value, providerHint);
}

function normalizeProviderError(value, providerHint) {
  const status = readStatus$2(value);
  const code = readCode(value);
  const provider = readProvider(value, providerHint);
  const rawMessage = scrubSecretText(readMessage(value));
  const reason = classifyProviderError({ code, message: rawMessage, status, value });

  if (!reason) return null;

  return {
    cause: truncate$3(rawMessage || reason || "Provider request failed.", 300),
    code: code || null,
    message: buildProviderErrorMessage(provider, reason),
    provider: provider || null,
    reason,
    retryable: isRetryableProviderError({ code, reason, status, value }),
    status: Number.isInteger(status) ? status : null
  };
}

function createProviderErrorStepDetail(value, providerHint) {
  const normalized = readProviderError(value, providerHint);
  if (!normalized) return null;
  return {
    code: normalized.code,
    message: normalized.message,
    provider: normalized.provider,
    reason: normalized.reason,
    retryable: normalized.retryable,
    status: normalized.status
  };
}

function cloneProviderError(value) {
  if (!value || typeof value !== "object") return null;
  return {
    cause: typeof value.cause === "string" ? value.cause : null,
    code: typeof value.code === "string" ? value.code : null,
    message: typeof value.message === "string" ? value.message : "Provider request failed.",
    provider: typeof value.provider === "string" ? value.provider : null,
    reason: typeof value.reason === "string" ? value.reason : "provider_error",
    retryable: value.retryable === true,
    status: Number.isInteger(value.status) ? value.status : null
  };
}

function buildProviderErrorMessage(provider, reason) {
  const name = provider || "provider";
  if (reason === "auth") {
    return `Provider request failed: authentication or permission error for ${name}.`;
  }
  if (reason === "rate_limit") {
    return `Provider request failed: rate limit from ${name}. Please retry later.`;
  }
  if (reason === "timeout") {
    return `Provider request failed: request timed out for ${name}.`;
  }
  if (reason === "network") {
    return `Provider request failed: network error while calling ${name}.`;
  }
  if (reason === "upstream") {
    return `Provider request failed: upstream service error from ${name}. Please retry later.`;
  }
  if (reason === "circuit_open") {
    return `Provider request failed: circuit breaker is open for ${name}. Please retry later.`;
  }
  if (reason === "config") {
    return `Provider request failed: configuration is incomplete for ${name}.`;
  }
  return `Provider request failed for ${name}.`;
}

function classifyProviderError({ code, message, status, value }) {
  if (code === "CIRCUIT_OPEN") return "circuit_open";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 502 || status === 503 || status === 504 || (Number.isInteger(status) && status >= 500)) {
    return "upstream";
  }

  const name = value && typeof value === "object" && typeof value.name === "string" ? value.name : "";
  const text = `${name} ${code || ""} ${message || ""}`.toLowerCase();
  if (/endpoint|authmode|configuration|requires a non-empty|requires non-empty/.test(text)) return "config";
  if (/auth|api key|apikey|permission|unauthorized|forbidden|credential/.test(text)) return "auth";
  if (/rate.?limit|too many requests|\b429\b/.test(text)) return "rate_limit";
  if (/timeout|timed out|fetch_timeout|abort/.test(text)) return "timeout";
  if (/network|fetch|econnreset|etimedout|enotfound|failed to fetch/.test(text)) return "network";
  if (/model|requires/.test(text)) return "config";
  if (
    value &&
    typeof value === "object" &&
    value.debug &&
    value.debug.request &&
    typeof value.debug.request.provider === "string"
  ) {
    return "provider_error";
  }
  return null;
}

function isRetryableProviderError({ code, reason, status, value }) {
  if (reason === "rate_limit" || reason === "timeout" || reason === "network" || reason === "upstream" || reason === "circuit_open") {
    return true;
  }
  if (code === "FETCH_TIMEOUT" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND") {
    return true;
  }
  if (value && typeof value === "object" && (value.name === "TimeoutError" || value.name === "AbortError")) {
    return true;
  }
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function readProvider(value, providerHint) {
  if (typeof providerHint === "string" && providerHint.trim()) return providerHint.trim();
  if (!value || typeof value !== "object") return null;
  if (typeof value.provider === "string" && value.provider.trim()) return value.provider.trim();
  if (typeof value.providerKey === "string" && value.providerKey.trim()) return value.providerKey.trim();
  if (
    value.debug &&
    value.debug.request &&
    typeof value.debug.request.provider === "string" &&
    value.debug.request.provider.trim()
  ) {
    return value.debug.request.provider.trim();
  }
  return null;
}

function readStatus$2(value) {
  if (!value || typeof value !== "object") return null;
  if (Number.isInteger(value.status)) return value.status;
  if (value.response && Number.isInteger(value.response.status)) return value.response.status;
  if (value.debug && value.debug.response && Number.isInteger(value.debug.response.status)) {
    return value.debug.response.status;
  }
  if (value.cause && typeof value.cause === "object") return readStatus$2(value.cause);
  return null;
}

function readCode(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.code === "string" && value.code.trim()) return value.code.trim();
  if (typeof value.name === "string" && value.name.trim() && value.name !== "Error") return value.name.trim();
  if (value.cause && typeof value.cause === "object") return readCode(value.cause);
  return null;
}

function readMessage(value) {
  if (value instanceof Error) return value.message || value.name || "Unknown provider error";
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.reason === "string") return value.reason;
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

function scrubSecretText(value) {
  let text = typeof value === "string" ? value : "";
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[redacted]");
  }
  text = text.replace(SECRET_FIELD_PATTERN, "$1[redacted]$2");
  return text;
}

function truncate$3(value, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export { attachProviderError, createProviderErrorStepDetail, normalizeProviderError, readProviderError, scrubSecretText };
