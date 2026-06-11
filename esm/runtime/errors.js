import { readProviderError } from './provider-error.js';

const ERROR_CODES = {
  ACTION_EXECUTE_ERROR: "ACTION_EXECUTE_ERROR",
  APPROVAL_RESOLUTION_ERROR: "APPROVAL_RESOLUTION_ERROR",
  INVALID_PROVIDER_REQUEST: "INVALID_PROVIDER_REQUEST",
  INVALID_RUN_INPUT: "INVALID_RUN_INPUT",
  INVALID_SESSION_POLICY: "INVALID_SESSION_POLICY",
  PLANNER_ERROR: "PLANNER_ERROR",
  PLANNER_INVALID_ACTION: "PLANNER_INVALID_ACTION",
  PROMPT_BUDGET_EXCEEDED: "PROMPT_BUDGET_EXCEEDED",
  UNSUPPORTED_PROVIDER_PARAMETER: "UNSUPPORTED_PROVIDER_PARAMETER",
  MAX_STEPS_EXCEEDED: "MAX_STEPS_EXCEEDED",
  RUN_DEADLINE_EXCEEDED: "RUN_DEADLINE_EXCEEDED",
  COST_BUDGET_EXCEEDED: "COST_BUDGET_EXCEEDED",
  INVALID_STATE_ENVELOPE: "INVALID_STATE_ENVELOPE"
};

function createStructuredError(code, message, skill, cause) {
  const providerError = readProviderError(cause);
  return {
    code,
    details: providerError || extractDetails(cause),
    message: providerError ? providerError.message : message,
    skill: skill || null,
    cause: providerError ? providerError.cause : summarizeCause(cause)
  };
}

function isStructuredError(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

// Normalizes any thrown value into { error: Error, message: string }. Guards
// against `throw "string"` / `throw { code }` producing "[object Object]"
// when a caller does `String(thrown)`. Original value kept as `.cause`.
function normalizeThrownError(value) {
  if (value instanceof Error) {
    return { error: value, message: value.message || value.name || "Unknown error" };
  }

  if (typeof value === "string") {
    return { error: new Error(value), message: value };
  }

  if (value && typeof value === "object") {
    const fields = [
      typeof value.message === "string" ? value.message : null,
      typeof value.reason === "string" ? value.reason : null,
      typeof value.code === "string" ? `[${value.code}]` : null
    ].filter(Boolean);

    let message = fields.join(" ").trim();
    if (!message) {
      try {
        message = JSON.stringify(value);
      } catch {
        message = Object.prototype.toString.call(value);
      }
    }

    const wrapped = new Error(message);
    wrapped.cause = value;
    return { error: wrapped, message };
  }

  const message = String(value);
  return { error: new Error(message), message };
}

function summarizeCause(cause) {
  if (cause == null) {
    return null;
  }

  if (cause instanceof Error) {
    return cause.message || cause.name || "Unknown error";
  }

  if (typeof cause === "string") {
    return cause;
  }

  try {
    return JSON.stringify(cause);
  } catch (error) {
    return String(cause);
  }
}

function extractDetails(cause) {
  if (!cause || typeof cause !== "object" || cause == null || !("debug" in cause)) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(cause.debug));
  } catch {
    return null;
  }
}

// AGRUN-420 — total serializer for thrown values. Error.prototype fields
// (name/message/stack) are non-enumerable, so JSON.stringify(new Error(...))
// yields "{}" and any ledger/observer payload built that way silently loses
// the error. This is the SSOT for putting an error INTO a payload; it
// complements (not replaces) createStructuredError/ERROR_CODES, which remain
// the taxonomy for runtime-originated structured errors.
function serializeError(value, options = {}) {
  const stackLimit = Number.isInteger(options.stackLimit) && options.stackLimit > 0
    ? options.stackLimit
    : 2000;
  if (value instanceof Error) {
    const serialized = {
      name: value.name || "Error",
      message: value.message || "Unknown error"
    };
    if (typeof value.code === "string" && value.code) serialized.code = value.code;
    if (typeof value.stack === "string" && value.stack) serialized.stack = value.stack.slice(0, stackLimit);
    if (value.cause != null) {
      serialized.cause = value.cause instanceof Error
        ? { name: value.cause.name || "Error", message: value.cause.message || "Unknown error" }
        : summarizeCause(value.cause);
    }
    return serialized;
  }
  if (isStructuredError(value)) {
    return { name: "StructuredError", message: value.message, code: value.code };
  }
  const { message } = normalizeThrownError(value);
  return { name: "Error", message };
}

export { ERROR_CODES, createStructuredError, isStructuredError, normalizeThrownError, serializeError };
