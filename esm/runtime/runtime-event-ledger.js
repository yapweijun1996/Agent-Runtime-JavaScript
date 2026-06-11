import { cloneValue } from './utils.js';
import { classifyEvent } from './runtime-event-classifier.js';

// AGRUN-248-C Phase 1 — Typed runtime event ledger SSOT.
//
// Every step (via pushStep) and stream event (via streamEmitter.emit) is also
// appended here in normalized envelope form. Phase 1 is additive: steps[] and
// host onStep/onStreamEvent callbacks are unchanged; the ledger is an extra
// projection that future Inspector / replay / support-bundle consumers can read.


const RUNTIME_EVENT_LEDGER_SCHEMA_VERSION = "v1";

// Default FIFO cap. Unset used to mean unbounded, which grew without limit
// in long-lived browser sessions (every step + stream event is appended for
// the lifetime of the runtime-level event bus). Hosts that genuinely want
// unbounded retention opt out explicitly with `maxEvents: null`.
const DEFAULT_MAX_EVENTS = 10000;

function createRuntimeEventLedger(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const state = {
    events: [],
    nextSequence: 1,
    maxEvents: normalizeMaxEvents(source.maxEvents),
    onEvent: typeof source.onEvent === "function" ? source.onEvent : null,
    sequenceProvider: typeof source.sequenceProvider === "function" ? source.sequenceProvider : null,
    runState: source.runState && typeof source.runState === "object" ? source.runState : null
  };

  return {
    appendEvent({ type, detail, mode } = {}) {
      const eventType = readString$1t(type);
      if (!eventType) return null;
      const normalizedMode = normalizeMode(mode);
      const classification = classifyEvent({ type: eventType, mode: normalizedMode });
      const runId = readRunId(state.runState);
      const sequence = nextSequence(state);

      const event = Object.freeze({
        schemaVersion: RUNTIME_EVENT_LEDGER_SCHEMA_VERSION,
        id: buildEventId(runId, sequence),
        sequence,
        runId,
        // AGRUN-240-followup — session lineage as first-class ledger fields
        // (not just buried inside payload). Replay / inspector tooling can
        // filter and group on these without parsing payload shape per event
        // type. Null when caller never passed sessionId/parentSessionId.
        sessionId: readSessionId(state.runState),
        parentSessionId: readParentSessionId(state.runState),
        cycle: readCycle$1(state.runState),
        ts: Date.now(),
        mode: normalizedMode,
        visibility: classification.visibility,
        phase: classification.phase,
        type: eventType,
        payload: freezePayload(detail)
      });

      state.events.push(event);
      enforceCap(state);
      notifyEventSink(state, event);
      return event;
    },

    getEvents(filter) {
      if (!filter || typeof filter !== "object") return state.events.slice();
      return state.events.filter((event) => matchesFilter(event, filter));
    },

    size() {
      return state.events.length;
    },

    clear() {
      state.events.length = 0;
      state.nextSequence = 1;
    },

    bindRunState(nextRunState) {
      if (nextRunState && typeof nextRunState === "object") {
        state.runState = nextRunState;
      }
    }
  };
}

function createRuntimeEventBus({ maxEvents } = {}) {
  const state = {
    events: [],
    maxEvents: normalizeMaxEvents(maxEvents),
    nextSequence: 1,
    nextSubscriberId: 1,
    subscribers: new Map()
  };

  return {
    nextSequence() {
      return nextSequence(state);
    },

    appendEvent({ type, detail, mode, runId, sessionId, parentSessionId, cycle } = {}) {
      const eventType = readString$1t(type);
      if (!eventType) return null;
      const normalizedMode = normalizeMode(mode);
      const classification = classifyEvent({ type: eventType, mode: normalizedMode });
      const sequence = nextSequence(state);
      const resolvedRunId = readString$1t(runId) || "anonymous";
      const event = Object.freeze({
        schemaVersion: RUNTIME_EVENT_LEDGER_SCHEMA_VERSION,
        id: buildEventId(resolvedRunId, sequence),
        sequence,
        runId: resolvedRunId,
        sessionId: readString$1t(sessionId) || null,
        parentSessionId: readString$1t(parentSessionId) || null,
        cycle: Number.isInteger(cycle) ? cycle : null,
        ts: Date.now(),
        mode: normalizedMode,
        visibility: classification.visibility,
        phase: classification.phase,
        type: eventType,
        payload: freezePayload(detail)
      });

      state.events.push(event);
      enforceCap(state);
      notifySubscribers(state, event);
      return event;
    },

    recordEvent(event) {
      if (!event || typeof event !== "object") return;
      state.events.push(event);
      enforceCap(state);
      notifySubscribers(state, event);
    },

    getEvents(filter) {
      if (!filter || typeof filter !== "object") return state.events.slice();
      return state.events.filter((event) => matchesFilter(event, filter));
    },

    subscribe(callback, options) {
      if (typeof callback !== "function") {
        throw new TypeError("runtime.subscribeEvents requires a callback function.");
      }

      const filter = normalizeSubscriptionFilter(options);
      const replayEvents = typeof filter.sinceSequence === "number"
        ? state.events.filter((event) => matchesFilter(event, filter))
        : [];
      const id = state.nextSubscriberId++;
      const subscriber = {
        active: true,
        callback,
        filter,
        queue: [],
        replaying: true
      };

      state.subscribers.set(id, subscriber);

      const unsubscribe = () => {
        if (!subscriber.active) return;
        subscriber.active = false;
        subscriber.queue.length = 0;
        state.subscribers.delete(id);
      };

      for (const event of replayEvents) {
        if (!subscriber.active) break;
        safeNotify(callback, event);
      }

      subscriber.replaying = false;
      while (subscriber.active && subscriber.queue.length > 0) {
        safeNotify(callback, subscriber.queue.shift());
      }

      return unsubscribe;
    },

    size() {
      return state.events.length;
    },

    subscriberCount() {
      return state.subscribers.size;
    }
  };
}

function matchesFilter(event, filter) {
  if (!matchesStringFilter(event.mode, filter.mode)) return false;
  if (!matchesStringFilter(event.visibility, filter.visibility)) return false;
  if (!matchesStringFilter(event.phase, filter.phase)) return false;
  if (!matchesTypeFilter(event.type, filter.type || filter.types)) return false;
  if (typeof filter.sinceSequence === "number" && event.sequence <= filter.sinceSequence) {
    return false;
  }
  if (typeof filter.since === "number" && event.sequence <= filter.since) {
    return false;
  }
  return true;
}

function normalizeSubscriptionFilter(options) {
  const source = options && typeof options === "object" ? options : {};
  const filter = {};
  copyFilterField(filter, source, "mode");
  copyFilterField(filter, source, "type");
  copyFilterField(filter, source, "types");
  copyFilterField(filter, source, "visibility");
  copyFilterField(filter, source, "phase");
  const since = normalizeSince(source.sinceSequence ?? source.since);
  if (since != null) filter.sinceSequence = since;
  return filter;
}

function copyFilterField(target, source, key) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return;
  const value = normalizeFilterValue(source[key]);
  if (value != null) target[key] = value;
}

function normalizeFilterValue(value) {
  if (Array.isArray(value)) {
    const items = value.map(readString$1t).filter(Boolean);
    return items.length > 0 ? items : null;
  }
  const text = readString$1t(value);
  return text || null;
}

function normalizeSince(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function matchesStringFilter(value, filter) {
  if (filter == null) return true;
  if (Array.isArray(filter)) return filter.includes(value);
  return value === filter;
}

function matchesTypeFilter(value, filter) {
  if (filter == null) return true;
  const patterns = Array.isArray(filter) ? filter : [filter];
  return patterns.some((pattern) => matchesTypePattern(value, pattern));
}

function matchesTypePattern(value, pattern) {
  const eventType = readString$1t(value);
  const normalizedPattern = readString$1t(pattern);
  if (!normalizedPattern) return true;
  if (!normalizedPattern.includes("*")) return eventType === normalizedPattern;
  const expression = new RegExp(`^${escapeRegExp$2(normalizedPattern).replaceAll("\\*", ".*")}$`);
  return expression.test(eventType);
}

function escapeRegExp$2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function freezePayload(detail) {
  if (detail == null) return null;
  const cloned = cloneValue(detail);
  return cloned && typeof cloned === "object" ? Object.freeze(cloned) : cloned;
}

function nextSequence(state) {
  if (typeof state.sequenceProvider === "function") {
    try {
      const sequence = state.sequenceProvider();
      if (Number.isSafeInteger(sequence) && sequence > 0) return sequence;
    } catch (_error) {
      // Fall back to local sequencing; event append must stay non-throwing.
    }
  }
  const sequence = state.nextSequence;
  state.nextSequence = sequence + 1;
  return sequence;
}

function notifyEventSink(state, event) {
  if (typeof state.onEvent !== "function") return;
  try {
    state.onEvent(event);
  } catch (_error) {
    // Event observers must never break runtime execution.
  }
}

function notifySubscribers(state, event) {
  for (const subscriber of state.subscribers.values()) {
    if (!subscriber.active || !matchesFilter(event, subscriber.filter)) continue;
    if (subscriber.replaying) {
      subscriber.queue.push(event);
      continue;
    }
    safeNotify(subscriber.callback, event);
  }
}

function safeNotify(callback, event) {
  try {
    callback(event);
  } catch (_error) {
    // Host subscribers must not break runtime execution or other subscribers.
  }
}

function normalizeMode(mode) {
  return mode === "stream" ? "stream" : "step";
}

function normalizeMaxEvents(value) {
  if (value === null) return null; // explicit unbounded opt-out
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_EVENTS;
  }
  return Math.floor(value);
}

function enforceCap(state) {
  if (state.maxEvents == null) return;
  if (state.events.length <= state.maxEvents) return;
  const overflow = state.events.length - state.maxEvents;
  state.events.splice(0, overflow);
}

function readRunId(runState) {
  const value = runState && typeof runState.runId === "string" ? runState.runId.trim() : "";
  return value || "anonymous";
}

function readSessionId(runState) {
  const value = runState && typeof runState.sessionId === "string" ? runState.sessionId.trim() : "";
  return value || null;
}

function readParentSessionId(runState) {
  const value = runState && typeof runState.parentSessionId === "string" ? runState.parentSessionId.trim() : "";
  return value || null;
}

function readCycle$1(runState) {
  if (!runState || typeof runState !== "object") return null;
  return Number.isInteger(runState.cycleCount) ? runState.cycleCount : null;
}

function buildEventId(runId, sequence) {
  return `evt_${runId}_${sequence}`;
}

function readString$1t(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { DEFAULT_MAX_EVENTS, RUNTIME_EVENT_LEDGER_SCHEMA_VERSION, createRuntimeEventBus, createRuntimeEventLedger };
