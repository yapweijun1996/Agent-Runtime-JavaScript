import { readProviderError } from './provider-error.js';

/**
 * AGRUN-PLANNER-PROVIDER-RETRY (weak-model e2e comparison F1) — bounded retry
 * policy for TRANSIENT provider errors (timeout / rate_limit / network /
 * upstream) on the non-streaming completion path.
 *
 * Why this exists:
 *   One planner timeout used to terminate the whole run (PLANNER_ERROR →
 *   finalizeActionLoopFailure, zero retry), discarding all workspace work.
 *   Live evidence (2026-06-10): deepseek-v4-flash died at cycle 10 from a
 *   single 60s planner timeout with 1440 words already in the workspace.
 *   Transient infra errors are the NORM for slow/weak models, not the
 *   exception — surviving them is mechanism, not model vocabulary.
 *
 * Posture (written down per the dispatch-parity rule):
 *   - Retries apply in `requestProviderCompletion` ONLY — the single shared
 *     exit used by every non-streaming planner / finalize / repair call, so
 *     one home covers every dispatch path.
 *   - The STREAMING variant is deliberately NOT retried: tokens already
 *     emitted to the host cannot be unemitted, so a mid-stream retry would
 *     duplicate output. A failed stream surfaces to its caller unchanged.
 *   - `circuit_open` is never retried in-loop: the breaker is deliberately
 *     shedding load; immediate retry would defeat it. Each failed attempt
 *     still records a breaker failure, so the breaker stays authoritative
 *     over persistent failure even while retries run.
 */


const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 500;
const MAX_ALLOWED_RETRIES = 5;

function normalizeProviderRetry(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    backoffMs: readBoundedInteger(source.backoffMs, 0, 60_000, DEFAULT_BACKOFF_MS),
    maxRetries: readBoundedInteger(source.maxRetries, 0, MAX_ALLOWED_RETRIES, DEFAULT_MAX_RETRIES)
  });
}

/**
 * @returns {boolean} true when `error` is a transient provider error worth
 *   one more attempt. Pure read — never mutates the error.
 */
function isTransientProviderError(error, providerHint) {
  const normalized = readProviderError(error, providerHint);
  if (!normalized || normalized.retryable !== true) return false;
  return normalized.reason !== "circuit_open";
}

/**
 * AGRUN-568 — timeout-class detection for retry-budget escalation.
 *
 * A timeout is categorically different from the other transient reasons
 * (rate_limit / network / upstream): those are environment hiccups where the
 * SAME request budget is fine on retry, but a timeout is direct evidence the
 * call needs MORE time than the current budget. Retrying a
 * deterministically-slow call with an identical deadline is provably wasted
 * work — captured live (deepseek-v4-flash, 2026-07-02): a planner cycle that
 * needed >120s timed out at 120s, retried on the same 120s budget, timed out
 * again, and failed the whole run (observed gap exactly 120 + 0.5 backoff +
 * 120 = 240.5s). requestProviderCompletion doubles the budget before a
 * timeout-class retry.
 *
 * @returns {boolean} true when `error` classifies as a provider timeout.
 */
function isTimeoutProviderError(error, providerHint) {
  const normalized = readProviderError(error, providerHint);
  return Boolean(normalized && normalized.reason === "timeout");
}

/**
 * Linear backoff: attempt 1 waits backoffMs, attempt 2 waits 2*backoffMs, …
 * Bounded by MAX_ALLOWED_RETRIES so the worst case stays small and predictable.
 */
function providerRetryDelayMs(retryPolicy, attemptNumber) {
  const policy = retryPolicy && typeof retryPolicy === "object"
    ? retryPolicy
    : normalizeProviderRetry(null);
  const attempt = readBoundedInteger(attemptNumber, 1, MAX_ALLOWED_RETRIES, 1);
  return policy.backoffMs * attempt;
}

function waitMs(ms) {
  const delay = readBoundedInteger(ms, 0, 300_000, 0);
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function readBoundedInteger(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

export { isTimeoutProviderError, isTransientProviderError, normalizeProviderRetry, providerRetryDelayMs, waitMs };
