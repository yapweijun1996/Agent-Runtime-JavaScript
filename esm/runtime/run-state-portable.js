import { getRuntimeBuildId } from './build-info.js';
import { ERROR_CODES } from './errors.js';
import { snapshotRunState } from './state.js';
import { cloneValue } from './utils.js';

// Run-state export / import — the public crash-recovery serialization
// contract. See agrun_docs/run-state-export-import-design.md.
//
// P1 (this module): pure functions only. `exportState` turns a run result
// (or a raw runState) into a versioned, redacted, plain-JSON envelope the
// host can persist (IndexedDB / fs / log). `importState` validates that
// envelope and returns a plain runState ready for the existing
// `options.runState` injection seam (action-loop-session.js). No loop
// wiring yet — that is P2 (`resumeState` run option + `onCheckpoint`).
//
// Two seams already exist and are reused here rather than reinvented:
//   - snapshotRunState (state.js) — deep-clone + strip the live eventLedger.
//   - getRuntimeBuildId (build-info.js) — the build identity stamp.


// Schema version of the envelope. Bump only on a breaking runState-shape
// change; importState throws on any version it does not recognize.
const STATE_ENVELOPE_VERSION = 1;

// Secret + non-serializable live objects that must never leave on a bundled
// request. apiKey is re-supplied by the host at resume time. The rest are
// runtime-attached live objects (action-loop-session.js:29-48).
const REQUEST_DENY_KEYS = Object.freeze([
  "apiKey",
  "signal",
  "circuitBreaker",
  "providerRegistry",
  "fetch"
]);

/**
 * Build a versioned, redacted, plain-JSON checkpoint envelope.
 *
 * @param {object} input - a run result (`{ runState, ... }`) or a raw runState.
 * @param {object} [options]
 * @param {object} [options.request] - originating provider request to bundle
 *   for self-contained resume; auto-redacted (apiKey/live objects stripped).
 * @param {boolean} [options.includeEvents=true] - embed the event ledger array.
 * @param {string} [options.exportedAt] - ISO timestamp; defaults to now.
 * @returns {object} frozen envelope, safe for JSON.stringify / structured clone.
 */
function exportState(input, options) {
  if (!input || typeof input !== "object") {
    throw envelopeError("exportState(input) requires a run result or a runState object.");
  }
  const opts = options && typeof options === "object" ? options : {};
  const { runState, events } = extractRunStateAndEvents(input);
  if (!runState) {
    throw envelopeError("exportState(input): could not find a runState to serialize.");
  }

  const envelope = {
    agrunStateVersion: STATE_ENVELOPE_VERSION,
    runtimeBuildId: typeof runState.runtimeBuildId === "string" && runState.runtimeBuildId
      ? runState.runtimeBuildId
      : getRuntimeBuildId(),
    exportedAt: typeof opts.exportedAt === "string" && opts.exportedAt
      ? opts.exportedAt
      : new Date().toISOString(),
    runState
  };
  if (opts.includeEvents !== false && Array.isArray(events)) {
    envelope.events = events;
  }
  if (opts.request && typeof opts.request === "object") {
    envelope.request = redactRequest(opts.request);
  }
  return Object.freeze(envelope);
}

/**
 * Validate a checkpoint envelope and return a plain runState ready to inject
 * via the `options.runState` seam. Throws on unknown version / corruption.
 * A runtime-build mismatch is best-effort, NOT fatal: the returned runState
 * carries a non-enumerable `agrunBuildMismatch` flag (never re-serialized).
 *
 * @param {object} envelope - output of exportState (possibly JSON round-tripped).
 * @returns {object} the restored runState.
 */
function importState(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw envelopeError("importState(envelope) requires a state envelope object.");
  }
  if (envelope.agrunStateVersion !== STATE_ENVELOPE_VERSION) {
    throw envelopeError(
      `importState: unsupported agrunStateVersion ${JSON.stringify(envelope.agrunStateVersion)}. `
      + `This runtime understands version ${STATE_ENVELOPE_VERSION}.`
    );
  }
  const source = envelope.runState;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw envelopeError("importState: envelope.runState must be an object.");
  }
  if (typeof source.runId !== "string" || !source.runId) {
    throw envelopeError("importState: envelope.runState.runId must be a non-empty string.");
  }

  const runState = cloneValue(source);
  // Re-embed events on the restored snapshot so an inspector / re-export keeps
  // them; the live eventLedger object itself is re-created by the loop (P2).
  if (Array.isArray(envelope.events)) {
    runState.eventLedger = cloneValue(envelope.events);
  }
  const buildMismatch = typeof envelope.runtimeBuildId === "string"
    && envelope.runtimeBuildId !== getRuntimeBuildId();
  // Non-enumerable: visible to host inspection, never lands in JSON or a
  // subsequent exportState (which only reads enumerable runState fields).
  Object.defineProperty(runState, "agrunBuildMismatch", {
    value: buildMismatch,
    enumerable: false,
    writable: false,
    configurable: true
  });
  return runState;
}

function extractRunStateAndEvents(input) {
  // A run result wraps the snapshot under `.runState`; a raw runState is the
  // input itself. Distinguish by the presence of a nested runState object.
  const candidate = input.runState && typeof input.runState === "object" && !Array.isArray(input.runState)
    ? input.runState
    : input;

  const ledger = candidate.eventLedger;
  // Live runState: eventLedger is the closure object with getEvents().
  if (ledger && typeof ledger.getEvents === "function") {
    return {
      runState: snapshotRunState(candidate), // strips the live ledger
      events: safeGetEvents(ledger)
    };
  }
  // Already a plain snapshot (e.g. result.runState): eventLedger is an array
  // or absent. Clone and drop the array so the runState stays pure data.
  const plain = cloneValue(candidate);
  const events = Array.isArray(ledger) ? cloneValue(ledger) : null;
  if ("eventLedger" in plain) delete plain.eventLedger;
  return { runState: plain, events };
}

function safeGetEvents(ledger) {
  try {
    return cloneValue(ledger.getEvents());
  } catch (_error) {
    return null;
  }
}

function redactRequest(request) {
  const copy = {};
  for (const key of Object.keys(request)) {
    if (REQUEST_DENY_KEYS.includes(key)) continue;
    copy[key] = request[key];
  }
  return cloneValue(copy);
}

function envelopeError(message) {
  const error = new Error(message);
  error.code = ERROR_CODES.INVALID_STATE_ENVELOPE;
  return error;
}

export { STATE_ENVELOPE_VERSION, exportState, importState };
