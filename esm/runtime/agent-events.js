// AGRUN-419: formal AgentEvent definitions for the runtime event ledger.
//
// SCOPE — deliberately respects AGRUN-248-C: the ~104 step types do NOT get a
// per-type enum (the classifier auto-categorizes by prefix/suffix so new step
// types need no migration table). What IS formalized here are the surfaces
// that are genuinely closed sets:
//   - the normalized envelope shape every ledger event shares,
//   - event modes / visibilities / phases,
//   - the stream-event type taxonomy (closed set in provider-stream-events),
//   - run terminal kinds (done | abort | error), mutually exclusive by
//     construction: readRunTerminalKind is a single total function over the
//     run outcome, so an outcome can never be two kinds at once.
//
// AG2B naming note: AG2B's reasoning_delta / tool_input_delta arrive here as
// provider-reasoning-delta / tool-input-delta — stream events share the
// kebab-case step taxonomy per ADR-0055.

/**
 * @typedef {Object} AgentEvent
 * @property {string} schemaVersion  Ledger schema version ("v1").
 * @property {number} sequence       Monotonic per-ledger sequence number.
 * @property {string|null} runId     Owning run id when known.
 * @property {string} type           Kebab-case event type (open set for steps).
 * @property {"step"|"stream"} mode  Surface the event arrived on.
 * @property {"agent"|"user"|"debug"} visibility  Classifier-assigned audience.
 * @property {"observe"|"orient"|"decide"|"act"|"evaluate"|null} phase  OODAE phase.
 * @property {Object|null} detail    Event payload (runId/sessionId/cycle auto-injected).
 */

const AGENT_EVENT_MODES = Object.freeze(["step", "stream"]);

const AGENT_EVENT_VISIBILITIES = Object.freeze(["agent", "user", "debug"]);

const AGENT_EVENT_PHASES = Object.freeze(["observe", "orient", "decide", "act", "evaluate"]);

// Closed set accepted by normalizeType in provider-stream-events.js — any
// other spelling normalizes to the generic "provider-stream-event".
const AGENT_STREAM_EVENT_TYPES = Object.freeze([
  "provider-stream-start",
  "provider-text-delta",
  "provider-reasoning-delta",
  "provider-stream-finish",
  "provider-stream-error",
  "action-executing",
  "action-executed",
  "action-error",
  "tool-input-delta",
  "tool-result",
  "provider-stream-event"
]);

const RUN_TERMINAL_KINDS = Object.freeze(["done", "abort", "error"]);

// Structural validator for the ledger envelope. Step types are an open set
// by design (AGRUN-248-C), so `type` is only checked for non-empty string.
function isAgentEvent(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.schemaVersion === "string" &&
    Number.isInteger(value.sequence) &&
    typeof value.type === "string" && value.type.length > 0 &&
    AGENT_EVENT_MODES.includes(value.mode) &&
    AGENT_EVENT_VISIBILITIES.includes(value.visibility) &&
    (value.phase === null || AGENT_EVENT_PHASES.includes(value.phase))
  );
}

// Maps a run outcome to exactly ONE terminal kind — the union is mutually
// exclusive because this is a single total function, evaluated in priority
// order: abort beats error beats done.
//   outcome.error  — thrown value or structured error from the run, if any
//   outcome.status — run result status ("completed" | "failed" | ...)
// Returns "done" | "abort" | "error" | null (null = not terminal yet).
function readRunTerminalKind(outcome) {
  const source = outcome && typeof outcome === "object" ? outcome : {};
  const error = source.error;
  if (error && typeof error === "object") {
    if (error.name === "AbortError" || error.code === "ABORT_ERR") return "abort";
    return "error";
  }
  const status = typeof source.status === "string" ? source.status : "";
  if (status === "failed") return "error";
  if (status === "completed") return "done";
  return null;
}

export { AGENT_EVENT_MODES, AGENT_EVENT_PHASES, AGENT_EVENT_VISIBILITIES, AGENT_STREAM_EVENT_TYPES, RUN_TERMINAL_KINDS, isAgentEvent, readRunTerminalKind };
