// AGRUN-423 — AG-UI protocol event-type vocabulary + a pure mapping from
// agrun's native event types to AG-UI types, so a host building an AG-UI
// compatible UI can relabel agrun's event stream without hardcoding the
// translation.
//
// ADDITIVE / opt-in: agrun's native event stream (agent-events.js +
// runtime-event-ledger.js) stays the SSOT. This module changes no emitter — it
// is a host-side adapter vocabulary. Only HIGH-CONFIDENCE 1:1 mappings are
// provided; types that would need message-envelope synthesis (TEXT_MESSAGE_START
// /END boundaries with a message id) or state diffing (STATE_DELTA, overlaps
// AGRUN-425) return null and are the host's to synthesize (or a later slice).
//
// AG-UI reference: agrun_docs/mastra-copilotkit-agui-learning-notes.md.

const AG_UI_EVENT_TYPES = Object.freeze({
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  RAW: "RAW",
  CUSTOM: "CUSTOM"
});

// High-confidence 1:1 mappings from agrun's native event types (the step type
// strings + AGENT_STREAM_EVENT_TYPES) to AG-UI types. Deliberately omits the
// types that have no clean 1:1 (provider-stream-start/finish/error,
// tool-input-delta partials needing a call id, etc.) — those stay null so a host
// does not get a misleading translation.
const AGENT_TYPE_TO_AG_UI = Object.freeze({
  "run-started": AG_UI_EVENT_TYPES.RUN_STARTED,
  "cycle-started": AG_UI_EVENT_TYPES.STEP_STARTED,
  "provider-text-delta": AG_UI_EVENT_TYPES.TEXT_MESSAGE_CONTENT,
  "provider-reasoning-delta": AG_UI_EVENT_TYPES.REASONING_MESSAGE_CONTENT,
  "action-executing": AG_UI_EVENT_TYPES.TOOL_CALL_START,
  "action-executed": AG_UI_EVENT_TYPES.TOOL_CALL_END,
  "tool-input-delta": AG_UI_EVENT_TYPES.TOOL_CALL_ARGS,
  "tool-result": AG_UI_EVENT_TYPES.TOOL_CALL_RESULT
});

// Map an agrun native event type to its AG-UI protocol type, or null when there
// is no clean 1:1 equivalent.
function mapToAgUiEventType(agentEventType) {
  if (typeof agentEventType !== "string") return null;
  return AGENT_TYPE_TO_AG_UI[agentEventType] || null;
}

// Map a run terminal kind (readRunTerminalKind from agent-events.js: done |
// abort | error) to the AG-UI run-completion event. `done` -> RUN_FINISHED;
// `error` and `abort` both -> RUN_ERROR (an aborted run did not finish cleanly).
function mapTerminalKindToAgUiEventType(terminalKind) {
  if (terminalKind === "done") return AG_UI_EVENT_TYPES.RUN_FINISHED;
  if (terminalKind === "error" || terminalKind === "abort") return AG_UI_EVENT_TYPES.RUN_ERROR;
  return null;
}

export { AG_UI_EVENT_TYPES, mapTerminalKindToAgUiEventType, mapToAgUiEventType };
