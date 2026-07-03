import { mapTerminalKindToAgUiEventType, AG_UI_EVENT_TYPES } from './ag-ui-events.js';
import { diffJsonPatch } from './json-patch.js';
import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';

// AGRUN-423 (stateful synthesis) — turn agrun's native runtime event stream into
// a well-formed AG-UI event stream. Where ag-ui-events.js is a PURE type map,
// this adapter synthesizes what a 1:1 type map cannot: the message-envelope
// boundaries (TEXT_MESSAGE_START/END around a run of text deltas, with a
// messageId), tool-call lifecycle keyed by the native callId, OODAE step
// boundaries, and STATE_SNAPSHOT/STATE_DELTA (the delta via the RFC 6902 engine,
// AGRUN-425).
//
// ADDITIVE / opt-in: the native event stream stays the SSOT. A host feeds each
// native event to adapter.next(event) and forwards the returned AG-UI events to
// an AG-UI frontend; adapter.state(snapshot) emits a snapshot then deltas;
// adapter.finish(terminalKind) closes the run. No emitter is changed.
//
// AG-UI envelope shapes follow the protocol (agrun_docs/
// mastra-copilotkit-agui-learning-notes.md): RUN_STARTED {threadId,runId};
// TEXT_MESSAGE_START {messageId,role}; TEXT_MESSAGE_CONTENT {messageId,delta};
// TOOL_CALL_START {toolCallId,toolCallName}; TOOL_CALL_ARGS {toolCallId,delta};
// TOOL_CALL_RESULT {toolCallId,content}; STATE_SNAPSHOT {snapshot};
// STATE_DELTA {delta}.

function createAgUiAdapter(options = {}) {
  const role = readString(options.role) || "assistant";
  let runId = readString(options.runId) || null;
  let threadId = readString(options.threadId) || null;

  let openMessageId = null;   // an open TEXT_MESSAGE (run of text deltas)
  let messageCounter = 0;
  let hasState = false;
  let lastState = null;

  function readPayload(event) {
    if (event && event.payload && typeof event.payload === "object") return event.payload;
    if (event && event.detail && typeof event.detail === "object") return event.detail;
    return {};
  }

  // Streaming deltas must preserve whitespace verbatim — never trim (readString
  // would drop a leading/trailing space that is part of the streamed text).
  function readDelta(value) {
    return typeof value === "string" ? value : "";
  }

  // Close the open text message, if any.
  function closeTextMessage(out) {
    if (openMessageId) {
      out.push({ type: AG_UI_EVENT_TYPES.TEXT_MESSAGE_END, messageId: openMessageId });
      openMessageId = null;
    }
  }

  function stepName(payload) {
    const cycle = payload.cycle;
    return Number.isFinite(cycle) ? `cycle-${cycle}` : "step";
  }

  function toolCallId(payload) {
    return readString(payload.callId)
      || readString(payload.toolCallId)
      || `${readString(payload.actionName) || readString(payload.name) || "tool"}-${readString(payload.id) || "0"}`;
  }

  function next(event) {
    const out = [];
    if (!event || typeof event !== "object") return out;
    const type = readString(event.type);
    const payload = readPayload(event);

    switch (type) {
      case "run-started":
        runId = readString(payload.runId) || readString(event.runId) || runId;
        threadId = readString(payload.threadId) || readString(payload.sessionId) || threadId;
        out.push({ type: AG_UI_EVENT_TYPES.RUN_STARTED, threadId, runId });
        break;

      case "cycle-started":
        closeTextMessage(out);
        out.push({ type: AG_UI_EVENT_TYPES.STEP_STARTED, stepName: stepName(payload) });
        break;

      case "cycle-completed":
        closeTextMessage(out);
        out.push({ type: AG_UI_EVENT_TYPES.STEP_FINISHED, stepName: stepName(payload) });
        break;

      case "provider-text-delta": {
        const delta = readDelta(payload.delta);
        if (!delta) break;
        if (!openMessageId) {
          messageCounter += 1;
          openMessageId = `msg-${runId || "run"}-${messageCounter}`;
          out.push({ type: AG_UI_EVENT_TYPES.TEXT_MESSAGE_START, messageId: openMessageId, role });
        }
        out.push({ type: AG_UI_EVENT_TYPES.TEXT_MESSAGE_CONTENT, messageId: openMessageId, delta });
        break;
      }

      case "provider-reasoning-delta": {
        const delta = readDelta(payload.delta);
        if (delta) out.push({ type: AG_UI_EVENT_TYPES.REASONING_MESSAGE_CONTENT, delta });
        break;
      }

      case "action-executing": {
        // A tool call interrupts any open assistant text message.
        closeTextMessage(out);
        const id = toolCallId(payload);
        const name = readString(payload.actionName) || readString(payload.name) || "tool";
        out.push({ type: AG_UI_EVENT_TYPES.TOOL_CALL_START, toolCallId: id, toolCallName: name });
        // Non-streaming calls carry their full args here; stream args via
        // tool-input-delta instead (agrun emits one or the other, not both).
        if (payload.args && typeof payload.args === "object") {
          out.push({ type: AG_UI_EVENT_TYPES.TOOL_CALL_ARGS, toolCallId: id, delta: safeJson(payload.args) });
        }
        break;
      }

      case "tool-input-delta": {
        const delta = readDelta(payload.delta);
        if (delta) out.push({ type: AG_UI_EVENT_TYPES.TOOL_CALL_ARGS, toolCallId: toolCallId(payload), delta });
        break;
      }

      case "action-executed":
      case "action-error":
        out.push({ type: AG_UI_EVENT_TYPES.TOOL_CALL_END, toolCallId: toolCallId(payload) });
        break;

      case "tool-result":
        out.push({
          type: AG_UI_EVENT_TYPES.TOOL_CALL_RESULT,
          toolCallId: toolCallId(payload),
          content: readToolResultContent(payload)
        });
        break;
    }
    return out;
  }

  // Emit a STATE_SNAPSHOT for the first state and a STATE_DELTA (RFC 6902 patch)
  // for every subsequent one.
  function state(snapshot) {
    if (!hasState) {
      hasState = true;
      lastState = cloneValue(snapshot);
      return [{ type: AG_UI_EVENT_TYPES.STATE_SNAPSHOT, snapshot: cloneValue(snapshot) }];
    }
    const patch = diffJsonPatch(lastState, snapshot);
    lastState = cloneValue(snapshot);
    return [{ type: AG_UI_EVENT_TYPES.STATE_DELTA, delta: patch }];
  }

  // Close the run: end any open message, then emit RUN_FINISHED / RUN_ERROR.
  function finish(terminalKind, finishOptions = {}) {
    const out = [];
    closeTextMessage(out);
    const agUiType = mapTerminalKindToAgUiEventType(terminalKind);
    if (agUiType === AG_UI_EVENT_TYPES.RUN_FINISHED) {
      out.push({ type: agUiType, threadId, runId });
    } else if (agUiType === AG_UI_EVENT_TYPES.RUN_ERROR) {
      out.push({ type: agUiType, message: readString(finishOptions.message) || "Run did not finish cleanly." });
    }
    return out;
  }

  return { next, state, finish };
}

function readToolResultContent(payload) {
  if (typeof payload.result === "string") return payload.result;
  if (typeof payload.content === "string") return payload.content;
  if (payload.result !== undefined) return safeJson(payload.result);
  return safeJson(stripArgs(payload));
}

function stripArgs(payload) {
  const out = { ...payload };
  delete out.args;
  return out;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return "";
  }
}

export { createAgUiAdapter };
