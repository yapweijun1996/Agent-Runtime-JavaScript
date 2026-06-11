function createProviderStreamEmitter(callback, context = {}) {
  return createRuntimeStreamEmitter(callback, context);
}

function createRuntimeStreamEmitter(callback, context = {}) {
  const emit = typeof callback === "function" ? callback : null;
  // AGRUN-248-C — optional event ledger that also receives every emitted
  // stream event with mode:"stream" so the ledger is the SSOT across both
  // pushStep and provider streams. context.ledger is read on each emit so
  // late-bound ledger attachment (after the emitter is created) still works.
  let sequence = 0;

  return {
    emit(type, detail) {
      const event = normalizeProviderStreamEvent({
        ...(detail && typeof detail === "object" ? detail : {}),
        context,
        sequence: ++sequence,
        type
      });
      appendStreamEventToLedger(context, event);
      if (emit) emit(event);
      return event;
    },

    wrapToken(onToken) {
      return (token) => {
        this.emit("provider-text-delta", {
          delta: typeof token === "string" ? token : String(token ?? "")
        });
        if (typeof onToken === "function") {
          onToken(token);
        }
      };
    },

    // AGRUN-419 — sub-action reasoning stream (AG2B reasoning_delta). Same
    // contract as wrapToken; providers that surface reasoning tokens route
    // them here so the ledger sees provider-reasoning-delta events.
    wrapReasoning(onReasoning) {
      return (token) => {
        this.emit("provider-reasoning-delta", {
          delta: typeof token === "string" ? token : String(token ?? "")
        });
        if (typeof onReasoning === "function") {
          onReasoning(token);
        }
      };
    }
  };
}

function appendStreamEventToLedger(context, event) {
  const ledger = context && context.ledger;
  if (!ledger || typeof ledger.appendEvent !== "function") return;
  const eventType = typeof event === "object" && event && typeof event.type === "string"
    ? event.type
    : null;
  if (!eventType) return;
  try {
    ledger.appendEvent({ type: eventType, detail: event, mode: "stream" });
  } catch (_error) {
    // Defensive: ledger append must never break the stream path.
  }
}

function normalizeProviderStreamEvent(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const context = source.context && typeof source.context === "object" && !Array.isArray(source.context)
    ? source.context
    : {};
  const type = normalizeType$1(source.type);
  const event = {
    actionName: readString$13(source.actionName) || readString$13(context.actionName) || undefined,
    callId: readString$13(source.callId) || readString$13(context.callId) || undefined,
    control: readString$13(source.control) || undefined,
    delta: typeof source.delta === "string" ? source.delta : undefined,
    durationMs: Number.isFinite(source.durationMs) ? source.durationMs : undefined,
    error: typeof source.error === "string" ? source.error : undefined,
    final: source.final === true,
    kind: readString$13(source.kind) || undefined,
    model: readString$13(source.model) || readString$13(context.model) || null,
    preliminary: source.preliminary === true,
    provider: readString$13(source.provider) || readString$13(context.provider) || null,
    resultCount: Number.isFinite(source.resultCount) ? source.resultCount : undefined,
    sequence: Number.isInteger(source.sequence) && source.sequence > 0 ? source.sequence : null,
    skillName: readString$13(source.skillName) || undefined,
    source: readString$13(source.source) || readString$13(context.source) || undefined,
    status: readString$13(source.status) || undefined,
    timestamp: Number.isFinite(source.timestamp) ? source.timestamp : Date.now(),
    toolName: readString$13(source.toolName) || undefined,
    type
  };
  return stripUndefined$1(event);
}

// Stream event types share the kebab-case taxonomy used by step events
// (ADR-0055). The event `mode` field ("stream" vs "step"), not the spelling,
// is what distinguishes the two surfaces.
function normalizeType$1(value) {
  const type = readString$13(value);
  if (type === "provider-stream-start") return type;
  if (type === "provider-text-delta") return type;
  if (type === "provider-reasoning-delta") return type;
  if (type === "provider-stream-finish") return type;
  if (type === "provider-stream-error") return type;
  if (type === "action-executing") return type;
  if (type === "action-executed") return type;
  if (type === "action-error") return type;
  if (type === "tool-input-delta") return type;
  if (type === "tool-result") return type;
  return "provider-stream-event";
}

function stripUndefined$1(value) {
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) output[key] = entry;
  }
  return output;
}

function readString$13(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createProviderStreamEmitter, createRuntimeStreamEmitter, normalizeProviderStreamEvent };
