import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';

const TURN_SIGNALS = Object.freeze({
  FINAL_OUTPUT: "final_output",
  HANDOFF: "handoff",
  INTERRUPTION: "interruption",
  RUN_AGAIN: "run_again"
});

function createTurnControl(options = {}) {
  options = options && typeof options === "object" && !Array.isArray(options)
    ? options
    : {};
  const signal = readTurnSignal(options.signal);
  if (!signal) return null;

  return {
    signal,
    source: readString(options.source) || null,
    cycle: readNonNegativeInteger$3(options.cycle),
    actionName: readString(options.actionName) || null,
    pendingApproval: sanitizePendingApproval(options.pendingApproval),
    handoff: cloneRecordOrNull(options.handoff),
    output: cloneRecordOrNull(options.output),
    error: cloneRecordOrNull(options.error),
    observation: cloneRecordOrNull(options.observation)
  };
}

function applyTurnControl(runState, options = {}) {
  if (!runState || typeof runState !== "object" || Array.isArray(runState)) {
    return null;
  }
  const turnControl = createTurnControl(options);
  runState.turnControl = turnControl;
  return turnControl;
}

function projectTurnControl(value) {
  const turnControl = createTurnControl(value);
  return turnControl ? cloneValue(turnControl) : null;
}

function summarizeTurnControlForPrompt(value) {
  const turnControl = projectTurnControl(value);
  if (!turnControl) return null;

  return {
    signal: turnControl.signal,
    source: turnControl.source,
    cycle: turnControl.cycle,
    actionName: turnControl.actionName,
    pendingApproval: turnControl.pendingApproval,
    handoff: turnControl.handoff,
    output: summarizeOutput(turnControl.output),
    error: turnControl.error,
    observation: summarizeObservation(turnControl.observation)
  };
}

function summarizeOutput(output) {
  if (!output) return null;
  return {
    kind: readString(output.kind) || null,
    text: readString(output.text) || null
  };
}

function summarizeObservation(observation) {
  if (!observation) return null;
  return {
    actionName: readString(observation.actionName) || null,
    kind: readString(observation.kind) || null,
    policy: readString(observation.policy) || null,
    resolution: readString(observation.resolution) || null,
    message: readString(observation.message) || null
  };
}

function sanitizePendingApproval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actionName = readString(value.actionName);
  const policy = readString(value.policy);
  if (!actionName || !policy) return null;
  return {
    actionName,
    policy,
    reason: readString(value.reason) || null,
    resumable: value.resumable === true,
    resolution: readString(value.resolution) || "pending"
  };
}

function readTurnSignal(value) {
  return Object.values(TURN_SIGNALS).includes(value) ? value : "";
}

function cloneRecordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function readNonNegativeInteger$3(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export { TURN_SIGNALS, applyTurnControl, createTurnControl, projectTurnControl, summarizeTurnControlForPrompt };
