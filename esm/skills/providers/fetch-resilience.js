/**
 * Modular fetch resilience utilities.
 *
 * Provides timeout, retry-with-backoff, and deadline helpers that can wrap
 * any fetch-compatible function.  Every helper returns a plain Promise so
 * callers don't need to know about AbortController internals.
 *
 * Usage:
 *   import { fetchWithTimeout, fetchWithRetry, withDeadline } from "./fetch-resilience.js";
 *
 *   // 1) Single fetch with timeout
 *   const res = await fetchWithTimeout(fetch, url, init, { timeoutMs: 15000 });
 *
 *   // 2) Fetch with timeout + automatic retry on transient failures
 *   const res = await fetchWithRetry(fetch, url, init, {
 *     timeoutMs: 15000,
 *     maxRetries: 2,
 *     baseDelayMs: 1000
 *   });
 *
 *   // 3) Deadline wrapper for multi-step operations
 *   const deadline = withDeadline(45000);
 *   for (const pass of passes) {
 *     if (deadline.expired()) break;
 *     await fetchWithTimeout(fetch, url, init, { signal: deadline.signal });
 *   }
 */

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_SEARCH_TIMEOUT_MS = 15000;
const DEFAULT_GROUNDING_TIMEOUT_MS = 40000;
const DEFAULT_LLM_TIMEOUT_MS = 60000;
const DEFAULT_SEARCH_DEADLINE_MS = 45000;
const DEFAULT_MAX_RETRIES$1 = 2;
const DEFAULT_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

/**
 * Wraps a single fetch call with an AbortController-based timeout.
 *
 * @param {Function} fetchImpl  - fetch-compatible function
 * @param {string}   url        - request URL
 * @param {object}   [init]     - fetch init (headers, method, body, …)
 * @param {object}   [options]
 * @param {number}   [options.timeoutMs]  - ms before abort (default 15 000)
 * @param {AbortSignal} [options.signal]  - external signal to honour (e.g. deadline)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(fetchImpl, url, init = {}, options = {}) {
  const timeoutMs = normalizePositiveInteger$2(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // If caller passes an external signal (e.g. deadline), abort when it fires.
  const externalSignal = options.signal || null;
  let onExternalAbort = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    throw normalizeTimeoutError(error, timeoutMs, url);
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

/**
 * Fetch with timeout + automatic retry on transient / timeout failures.
 *
 * @param {Function} fetchImpl
 * @param {string}   url
 * @param {object}   [init]
 * @param {object}   [options]
 * @param {number}   [options.timeoutMs]    - per-attempt timeout (default 15 000)
 * @param {number}   [options.maxRetries]   - retry count after first failure (default 2)
 * @param {number}   [options.baseDelayMs]  - base backoff delay (default 1 000)
 * @param {AbortSignal} [options.signal]    - external abort signal
 * @param {Function} [options.isRetryable]  - (error, response) => boolean
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(fetchImpl, url, init = {}, options = {}) {
  const maxRetries = normalizePositiveInteger$2(options.maxRetries, DEFAULT_MAX_RETRIES$1);
  const baseDelayMs = normalizePositiveInteger$2(options.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const isRetryable = typeof options.isRetryable === "function"
    ? options.isRetryable
    : defaultIsRetryable;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // If external signal already aborted, stop immediately.
    if (options.signal && options.signal.aborted) {
      throw lastError || new DOMException("Aborted", "AbortError");
    }

    try {
      const response = await fetchWithTimeout(fetchImpl, url, init, {
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });

      // Retry on server errors (502, 503, 429) if caller allows.
      if (!response.ok && isRetryable(null, response) && attempt < maxRetries) {
        lastError = new Error(`HTTP ${response.status}`);
        await delay$1(baseDelayMs * Math.pow(2, attempt));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries) {
        throw error;
      }

      // Only retry timeout / network errors, not programmer bugs.
      if (!isRetryable(error, null)) {
        throw error;
      }

      await delay$1(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// withDeadline
// ---------------------------------------------------------------------------

/**
 * Creates a deadline context for multi-step operations.
 *
 * Returns an object with:
 *   - signal:    AbortSignal that fires when the deadline expires
 *   - expired(): boolean check
 *   - remainingMs(): ms left before deadline
 *   - cleanup():  clears internal timer (call when done)
 *
 * @param {number} [deadlineMs] - total time budget in ms (default 45 000)
 * @returns {{ signal: AbortSignal, expired: () => boolean, remainingMs: () => number, cleanup: () => void }}
 */
function withDeadline(deadlineMs = DEFAULT_SEARCH_DEADLINE_MS) {
  const ms = normalizePositiveInteger$2(deadlineMs, DEFAULT_SEARCH_DEADLINE_MS);
  const controller = new AbortController();
  const startTime = Date.now();
  const timer = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    expired() {
      return controller.signal.aborted || (Date.now() - startTime) >= ms;
    },
    remainingMs() {
      return Math.max(0, ms - (Date.now() - startTime));
    },
    cleanup() {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultIsRetryable(error, response) {
  if (error) {
    // Timeout / network errors are retryable.
    if (error.name === "AbortError" || error.code === 20) {
      return true;
    }
    if (error.name === "TypeError" && /fetch|network/i.test(error.message)) {
      return true;
    }
    if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "ENOTFOUND") {
      return true;
    }
    return false;
  }

  if (response) {
    // 429 (rate limit), 502, 503, 504 are retryable.
    return response.status === 429 ||
      response.status === 502 ||
      response.status === 503 ||
      response.status === 504;
  }

  return false;
}

function normalizeTimeoutError(error, timeoutMs, url) {
  if (error && (error.name === "AbortError" || error.code === 20)) {
    const timeoutError = new Error(
      `Request timed out after ${timeoutMs}ms: ${url}`
    );
    timeoutError.name = "TimeoutError";
    timeoutError.code = "FETCH_TIMEOUT";
    timeoutError.timeoutMs = timeoutMs;
    timeoutError.url = url;
    timeoutError.cause = error;
    return timeoutError;
  }

  return error;
}

function normalizePositiveInteger$2(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function delay$1(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60000;

/**
 * Creates a per-key circuit breaker that tracks consecutive failures
 * and fast-fails requests when a provider is consistently down.
 *
 * States: closed → open → half_open → closed
 *
 * @param {object} [options]
 * @param {number} [options.threshold]  - failures before opening (default 5)
 * @param {number} [options.cooldownMs] - ms to stay open before half-open probe (default 60000)
 * @returns {{ canRequest, recordSuccess, recordFailure, getState, reset }}
 */
function createCircuitBreaker(options) {
  const config = options && typeof options === "object" ? options : {};
  const threshold = normalizePositiveInteger$2(config.threshold, DEFAULT_CIRCUIT_THRESHOLD);
  const cooldownMs = normalizePositiveInteger$2(config.cooldownMs, DEFAULT_CIRCUIT_COOLDOWN_MS);
  const entries = new Map();

  function getEntry(key) {
    if (!entries.has(key)) {
      entries.set(key, { state: "closed", failures: 0, openedAt: 0 });
    }
    return entries.get(key);
  }

  return {
    canRequest(key) {
      const entry = getEntry(key);
      if (entry.state === "closed") return true;
      if (entry.state === "half_open") return true;
      // state === "open"
      if (Date.now() - entry.openedAt >= cooldownMs) {
        entry.state = "half_open";
        return true;
      }
      return false;
    },

    recordSuccess(key) {
      const entry = getEntry(key);
      entry.state = "closed";
      entry.failures = 0;
      entry.openedAt = 0;
    },

    recordFailure(key) {
      const entry = getEntry(key);
      if (entry.state === "half_open") {
        // Probe failed — re-open.
        entry.state = "open";
        entry.openedAt = Date.now();
        return;
      }
      entry.failures += 1;
      if (entry.failures >= threshold) {
        entry.state = "open";
        entry.openedAt = Date.now();
      }
    },

    getState(key) {
      const entry = getEntry(key);
      return {
        state: entry.state,
        failures: entry.failures,
        openedAt: entry.openedAt,
        threshold,
        cooldownMs,
        remainingMs: entry.state === "open"
          ? Math.max(0, cooldownMs - (Date.now() - entry.openedAt))
          : 0
      };
    },

    reset(key) {
      if (key) {
        entries.delete(key);
      } else {
        entries.clear();
      }
    }
  };
}

export { DEFAULT_BASE_DELAY_MS, DEFAULT_GROUNDING_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS, DEFAULT_MAX_RETRIES$1 as DEFAULT_MAX_RETRIES, DEFAULT_SEARCH_DEADLINE_MS, DEFAULT_SEARCH_TIMEOUT_MS, createCircuitBreaker, fetchWithRetry, fetchWithTimeout, withDeadline };
