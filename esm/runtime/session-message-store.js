import { stringifySessionContent, stableStringify } from '../session/content.js';
import { cloneValue } from './utils.js';
import { PUBLISH_DIRECT_ACTION } from './kernel-terminal-actions.js';

const SESSION_MESSAGE_SCHEMA_VERSION = "agrun.message.v1";
const SESSION_PART_SCHEMA_VERSION = "agrun.part.v1";

function createSessionMessageStore(options = {}) {
  const storage = normalizeStorageAdapter(options.storage);
  if (!storage) return createDisabledSessionMessageStore();

  const state = {
    errors: [],
    maxErrors: readPositiveInteger$1(options.maxErrors) || 20,
    onError: typeof options.onError === "function" ? options.onError : null,
    runs: new Map(),
    storage,
    unsubscribe: null
  };

  const runtimeEventBus = options.runtimeEventBus;
  if (runtimeEventBus && typeof runtimeEventBus.subscribe === "function") {
    state.unsubscribe = runtimeEventBus.subscribe((event) => {
      recordRuntimeEvent(state, event);
    });
  }

  return {
    enabled: true,

    async createSession(sessionRecord, context = {}) {
      if (!sessionRecord || typeof sessionRecord !== "object") return null;
      const session = {
        schemaVersion: "agrun.storage-session.v1",
        parentSessionID: readString$2(sessionRecord.parentSessionId) || readString$2(context.parentSessionId) || null,
        sessionID: readString$2(sessionRecord.id),
        time: {
          created: readNumber$1(sessionRecord.createdAt) || Date.now(),
          updated: readNumber$1(sessionRecord.updatedAt) || Date.now()
        },
        title: readString$2(context.title) || null
      };
      if (!session.sessionID) return null;
      await safeStorageCall(state, "createSession", () => state.storage.createSession(session));
      return session;
    },

    async recordUserMessage(context) {
      const message = context && context.message;
      if (!message || typeof message !== "object") return null;
      const sessionID = readString$2(context.sessionId) || readString$2(message.sessionId);
      if (!sessionID) return null;

      const record = createMessageRecord({
        message,
        model: null,
        role: "user",
        runId: readString$2(message.runId),
        sessionID,
        status: readString$2(message.status) || "completed"
      });
      const text = stringifySessionContent(message.content);
      const part = createPartRecord({
        index: 0,
        messageID: record.id,
        runID: record.runID,
        sessionID,
        text: text || stableStringify(message.content || null),
        type: "text"
      });
      record.partIDs = [part.id];

      await writeMessageWithParts(state, sessionID, record, [part]);
      return record;
    },

    async recordAssistantMessage(context) {
      const message = context && context.message;
      if (!message || typeof message !== "object") return null;
      const result = context.result && typeof context.result === "object" ? context.result : {};
      const runState = result.runState && typeof result.runState === "object" ? result.runState : {};
      const sessionID = readString$2(context.sessionId) || readString$2(message.sessionId) || readString$2(runState.sessionId);
      const runID = readString$2(message.runId) || readString$2(runState.runId);
      if (!sessionID || !runID) return null;

      const runRecord = consumeRunRecord(state, runID, runState);
      const parts = materializeAssistantParts({
        message,
        runRecord,
        runState,
        sessionID
      });
      const record = createMessageRecord({
        eventRange: runRecord.eventRange,
        message,
        model: readModel(result, runState),
        partCount: parts.length,
        role: "assistant",
        runId: runID,
        sessionID,
        status: readString$2(message.status) || readRunStatus(runState)
      });
      record.partIDs = parts.map((part) => part.id);

      await writeMessageWithParts(state, sessionID, record, parts);
      await maybeAppendWorkspaceDiff(state, sessionID, record, result);
      return record;
    },

    async recordCompactionTurn(context) {
      const userMessage = context && context.userMessage;
      const assistantMessage = context && context.assistantMessage;
      if (!userMessage || !assistantMessage) return null;
      const compaction = context.compactionTurn && typeof context.compactionTurn === "object"
        ? context.compactionTurn
        : {};
      const sessionID = readString$2(context.sessionId)
        || readString$2(assistantMessage.sessionId)
        || readString$2(userMessage.sessionId);
      const runID = readString$2(compaction.runId)
        || readString$2(assistantMessage.runId)
        || readString$2(userMessage.runId);
      if (!sessionID || !runID) return null;

      const runRecord = consumeRunRecord(state, runID, {
        runId: runID,
        sessionId: sessionID,
        status: "completed"
      });
      const summary = createCompactionSummary(compaction, {
        assistantMessageID: readString$2(assistantMessage.id),
        userMessageID: readString$2(userMessage.id)
      });
      const userRecord = createMessageRecord({
        agent: "agrun.compaction",
        message: userMessage,
        model: null,
        role: "user",
        runId: runID,
        sessionID,
        status: "completed",
        summary,
        variant: "compaction"
      });
      const userPart = createPartRecord({
        index: 0,
        messageID: userRecord.id,
        runID,
        sessionID,
        text: stringifySessionContent(userMessage.content) || stableStringify(userMessage.compaction || null),
        type: "text"
      });
      userRecord.partIDs = [userPart.id];

      const assistantRecord = createMessageRecord({
        agent: "agrun.compaction",
        eventRange: runRecord.eventRange,
        message: assistantMessage,
        model: null,
        role: "assistant",
        runId: runID,
        sessionID,
        status: "completed",
        summary,
        variant: "compaction"
      });
      const assistantPart = createPartRecord({
        index: 0,
        messageID: assistantRecord.id,
        runID,
        sessionID,
        text: stringifySessionContent(assistantMessage.content) || readString$2(compaction.summaryText),
        type: "text"
      });
      assistantRecord.partIDs = [assistantPart.id];

      await writeMessageWithParts(state, sessionID, userRecord, [userPart]);
      await writeMessageWithParts(state, sessionID, assistantRecord, [assistantPart]);
      return { assistant: assistantRecord, user: userRecord };
    },

    getState() {
      return {
        enabled: true,
        errors: cloneValue(state.errors),
        pendingRunCount: state.runs.size
      };
    },

    close() {
      if (typeof state.unsubscribe === "function") {
        state.unsubscribe();
        state.unsubscribe = null;
      }
      state.runs.clear();
    }
  };
}

function createDisabledSessionMessageStore() {
  return {
    enabled: false,
    async createSession() { return null; },
    async recordUserMessage() { return null; },
    async recordAssistantMessage() { return null; },
    async recordCompactionTurn() { return null; },
    getState() {
      return { enabled: false, errors: [], pendingRunCount: 0 };
    },
    close() {}
  };
}

function normalizeStorageAdapter(storage) {
  if (!storage || typeof storage !== "object") return null;
  if (typeof storage.writeMessage !== "function") return null;
  if (typeof storage.writePart !== "function") return null;
  return {
    appendSessionDiff: typeof storage.appendSessionDiff === "function" ? storage.appendSessionDiff.bind(storage) : null,
    createSession: typeof storage.createSession === "function" ? storage.createSession.bind(storage) : async () => null,
    writeMessage: storage.writeMessage.bind(storage),
    writePart: storage.writePart.bind(storage)
  };
}

function recordRuntimeEvent(state, event) {
  if (!event || typeof event !== "object") return;
  const sessionID = readString$2(event.sessionId);
  const runID = readString$2(event.runId);
  if (!sessionID || !runID) return;
  const runRecord = ensureRunRecord(state, runID, sessionID);
  const clonedEvent = cloneValue(event);
  runRecord.events.push(clonedEvent);
  runRecord.eventRange.firstSequence = minSequence(runRecord.eventRange.firstSequence, event.sequence);
  runRecord.eventRange.lastSequence = maxSequence(runRecord.eventRange.lastSequence, event.sequence);

  const item = createPartItemFromEvent(runRecord, clonedEvent);
  if (item) runRecord.items.push(item);
}

function ensureRunRecord(state, runID, sessionID) {
  const existing = state.runs.get(runID);
  if (existing) return existing;
  const record = {
    eventRange: {
      firstSequence: null,
      lastSequence: null
    },
    events: [],
    items: [],
    runID,
    sessionID,
    textBuffer: "",
    toolItems: new Map()
  };
  state.runs.set(runID, record);
  return record;
}

function consumeRunRecord(state, runID, runState) {
  const existing = state.runs.get(runID);
  if (existing) {
    state.runs.delete(runID);
    return existing;
  }
  const fallback = {
    eventRange: {
      firstSequence: null,
      lastSequence: null
    },
    events: [],
    items: [],
    runID,
    sessionID: readString$2(runState && runState.sessionId),
    textBuffer: "",
    toolItems: new Map()
  };
  const events = Array.isArray(runState && runState.eventLedger) ? runState.eventLedger : [];
  for (const event of events) {
    const clonedEvent = cloneValue(event);
    fallback.events.push(clonedEvent);
    fallback.eventRange.firstSequence = minSequence(fallback.eventRange.firstSequence, event.sequence);
    fallback.eventRange.lastSequence = maxSequence(fallback.eventRange.lastSequence, event.sequence);
    const item = createPartItemFromEvent(fallback, clonedEvent);
    if (item) fallback.items.push(item);
  }
  return fallback;
}

function createPartItemFromEvent(runRecord, event) {
  if (isCycleStart(event)) {
    return {
      event,
      type: "step-start"
    };
  }

  if (isCycleFinish(event)) {
    return {
      event,
      type: "step-finish"
    };
  }

  if (isTextDeltaEvent(event)) {
    const delta = typeof (event.payload && event.payload.delta) === "string"
      ? event.payload.delta
      : "";
    if (!delta) return null;
    runRecord.textBuffer += delta;
    return null;
  }

  if (isActionEvent(event)) {
    return createToolItem(runRecord, event);
  }

  if (isReasoningEvent(event)) {
    return {
      event,
      text: formatReasoningEvent(event),
      type: "reasoning"
    };
  }

  return null;
}

function createToolItem(runRecord, event) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const actionName = readString$2(payload.actionName) || readString$2(payload.name) || readString$2(event.type);
  const callId = readString$2(payload.callId) || `${actionName || "action"}-${event.sequence || runRecord.items.length + 1}`;
  const key = `${actionName}:${callId}`;
  const existing = runRecord.toolItems.get(key);
  const item = existing || {
    event,
    state: {
      input: payload.args && typeof payload.args === "object" ? cloneValue(payload.args) : undefined,
      status: "pending",
      time: {
        start: readNumber$1(event.ts) || Date.now()
      }
    },
    tool: actionName || null,
    type: "tool"
  };

  if (event.type === "action-executing") {
    item.state.status = "running";
    item.state.time.start = readNumber$1(event.ts) || item.state.time.start || Date.now();
    if (payload.args && typeof payload.args === "object") {
      item.state.input = cloneValue(payload.args);
    }
  } else if (event.type === "action-executed") {
    item.state.status = "completed";
    item.state.time.end = readNumber$1(event.ts) || Date.now();
    item.state.output = cloneValue(stripRuntimeEventPayload(payload));
  } else if (event.type === "action-execute-error") {
    item.state.status = "error";
    item.state.time.end = readNumber$1(event.ts) || Date.now();
    item.state.error = readString$2(payload.error) || "Action failed.";
  }

  runRecord.toolItems.set(key, item);
  return existing ? null : item;
}

function materializeAssistantParts({ message, runRecord, runState, sessionID }) {
  const runID = readString$2(message.runId) || readString$2(runState && runState.runId) || runRecord.runID;
  const messageID = readString$2(message.id);
  const parts = [];

  for (const item of runRecord.items) {
    const part = createPartRecord({
      event: item.event,
      index: parts.length,
      messageID,
      runID,
      sessionID,
      state: item.state,
      text: item.text,
      tool: item.tool,
      type: item.type
    });
    parts.push(part);
  }

  const streamedText = readString$2(runRecord.textBuffer);
  const assistantText = stringifySessionContent(message.content);
  const text = streamedText || assistantText;
  if (text && !parts.some((part) => part.type === "text")) {
    parts.push(createPartRecord({
      index: parts.length,
      messageID,
      runID,
      sessionID,
      text,
      type: "text"
    }));
  }

  if (parts.length === 0) {
    parts.push(createPartRecord({
      index: 0,
      messageID,
      runID,
      sessionID,
      text: stableStringify({
        status: readRunStatus(runState),
        type: "empty_assistant_message"
      }),
      type: "reasoning"
    }));
  }

  return parts;
}

function createCompactionSummary(compaction, ids) {
  const source = compaction && typeof compaction === "object" ? compaction : {};
  return {
    compactedMessageIDs: Array.isArray(source.compactedMessageIds)
      ? source.compactedMessageIds.map(readString$2).filter(Boolean)
      : [],
    durationMs: readNumber$1(source.durationMs),
    kind: "compaction",
    oldestPreservedTurnID: readString$2(source.oldestPreservedTurnId) || null,
    reason: readString$2(source.reason) || "budget",
    savedTokensEstimate: readNumber$1(source.savedTokensEstimate),
    sourceMessageIDs: Array.isArray(source.sourceMessageIds)
      ? source.sourceMessageIds.map(readString$2).filter(Boolean)
      : [],
    summaryID: readString$2(source.summaryId) || null,
    summaryMessageID: readString$2(ids && ids.assistantMessageID) || null,
    threadID: readString$2(source.threadId) || null,
    turnID: readString$2(source.turnId) || readString$2(source.runId) || null,
    uptoMessageID: readString$2(source.uptoMessageId) || null,
    userMessageID: readString$2(ids && ids.userMessageID) || null
  };
}

function createMessageRecord(options) {
  const message = options.message && typeof options.message === "object" ? options.message : {};
  const sessionID = readString$2(options.sessionID);
  const runID = readString$2(options.runId) || readString$2(message.runId) || null;
  return stripUndefined({
    agent: options.agent === undefined ? null : options.agent,
    eventRange: options.eventRange ? cloneValue(options.eventRange) : undefined,
    id: readString$2(message.id),
    model: options.model || null,
    partIDs: [],
    role: options.role,
    runID,
    schemaVersion: SESSION_MESSAGE_SCHEMA_VERSION,
    sessionID,
    status: readString$2(options.status) || readString$2(message.status) || "completed",
    summary: options.summary === undefined ? null : cloneValue(options.summary),
    threadID: readString$2(message.threadId) || null,
    time: {
      created: readNumber$1(message.createdAt) || Date.now()
    },
    turnID: readString$2(message.turnId) || runID,
    variant: options.variant === undefined ? null : options.variant
  });
}

function createPartRecord(options) {
  const id = createPartId(options.messageID, options.index);
  const event = options.event && typeof options.event === "object" ? options.event : null;
  return stripUndefined({
    event: event
      ? {
          id: readString$2(event.id) || null,
          phase: readString$2(event.phase) || null,
          sequence: readNumber$1(event.sequence) || null,
          type: readString$2(event.type) || null,
          visibility: readString$2(event.visibility) || null
        }
      : undefined,
    id,
    index: options.index,
    messageID: readString$2(options.messageID),
    runID: readString$2(options.runID) || null,
    schemaVersion: SESSION_PART_SCHEMA_VERSION,
    sessionID: readString$2(options.sessionID),
    state: options.state ? cloneValue(options.state) : undefined,
    text: typeof options.text === "string" ? options.text : undefined,
    time: {
      created: event && readNumber$1(event.ts) ? readNumber$1(event.ts) : Date.now()
    },
    tool: readString$2(options.tool) || undefined,
    type: options.type
  });
}

async function writeMessageWithParts(state, sessionID, message, parts) {
  for (const part of parts) {
    await safeStorageCall(state, "writePart", () => (
      state.storage.writePart(sessionID, message.id, part)
    ));
  }
  await safeStorageCall(state, "writeMessage", () => (
    state.storage.writeMessage(sessionID, message)
  ));
}

async function maybeAppendWorkspaceDiff(state, sessionID, message, result) {
  if (typeof state.storage.appendSessionDiff !== "function") return;
  const runState = result && result.runState && typeof result.runState === "object"
    ? result.runState
    : {};
  if (runState.finalAnswerSource !== PUBLISH_DIRECT_ACTION) return;
  const workspace = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  if (!workspace || !workspace.files || typeof workspace.files !== "object") return;
  const finalCandidatePath = readString$2(workspace.quality && workspace.quality.finalCandidatePath) || "final_candidate.md";
  const file = workspace.files[finalCandidatePath] && typeof workspace.files[finalCandidatePath] === "object"
    ? workspace.files[finalCandidatePath]
    : null;
  const content = readString$2(file && file.content);
  if (!content) return;
  const diff = {
    diff: renderAddedFileDiff(finalCandidatePath, content),
    messageID: message.id,
    newVersion: readNumber$1(file.version) || 1,
    path: finalCandidatePath,
    sessionID,
    ts: Date.now()
  };
  await safeStorageCall(state, "appendSessionDiff", () => state.storage.appendSessionDiff(sessionID, diff));
}

async function safeStorageCall(state, label, operation) {
  try {
    return await operation();
  } catch (error) {
    const entry = {
      label,
      message: normalizeErrorMessage(error),
      ts: Date.now()
    };
    state.errors.push(entry);
    if (state.errors.length > state.maxErrors) {
      state.errors.splice(0, state.errors.length - state.maxErrors);
    }
    if (state.onError) {
      try {
        state.onError(cloneValue(entry));
      } catch (_error) {
        // Storage error observers must not break runtime execution.
      }
    }
    return null;
  }
}

function isCycleStart(event) {
  return readString$2(event && event.type) === "cycle-started";
}

function isCycleFinish(event) {
  return readString$2(event && event.type) === "cycle-completed";
}

function isTextDeltaEvent(event) {
  const type = readString$2(event && event.type);
  return (event && event.mode === "stream") && (type === "provider_text_delta" || type === "provider-text-delta");
}

function isActionEvent(event) {
  const type = readString$2(event && event.type);
  return type === "action-executing" || type === "action-executed" || type === "action-execute-error";
}

function isReasoningEvent(event) {
  const type = readString$2(event && event.type);
  if (!type) return false;
  if (readString$2(event.phase) === "decide") return true;
  if (type.startsWith("planner-")) return true;
  if (type.startsWith("provider-")) return true;
  if (type.startsWith("observation-")) return true;
  return readString$2(event.visibility) !== "debug";
}

function formatReasoningEvent(event) {
  const payload = event && event.payload != null ? event.payload : null;
  return stableStringify({
    event: readString$2(event && event.type),
    payload
  });
}

function readModel(result, runState) {
  const output = result && result.output && typeof result.output === "object" ? result.output : {};
  const providerID = readString$2(output.provider) || readString$2(runState && runState.provider) || null;
  const modelID = readString$2(output.model) || readString$2(runState && runState.model) || null;
  if (!providerID && !modelID) return null;
  return { providerID, modelID };
}

function readRunStatus(runState) {
  return readString$2(runState && runState.status) || "completed";
}

function stripRuntimeEventPayload(payload) {
  const output = { ...cloneValue(payload || {}) };
  delete output.args;
  return output;
}

function renderAddedFileDiff(filePath, content) {
  const lines = String(content).split(/\r?\n/);
  return [
    `--- /dev/null`,
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

function createPartId(messageID, index) {
  const base = readString$2(messageID).replace(/[^a-zA-Z0-9_-]/g, "_") || "msg";
  return `prt-${base}-${String(index + 1).padStart(4, "0")}`;
}

function minSequence(current, value) {
  const number = readNumber$1(value);
  if (number == null) return current == null ? null : current;
  if (current == null) return number;
  return Math.min(current, number);
}

function maxSequence(current, value) {
  const number = readNumber$1(value);
  if (number == null) return current == null ? null : current;
  if (current == null) return number;
  return Math.max(current, number);
}

function stripUndefined(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function normalizeErrorMessage(error) {
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return String(error || "Unknown storage error.");
}

function readPositiveInteger$1(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

function readNumber$1(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString$2(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { SESSION_MESSAGE_SCHEMA_VERSION, SESSION_PART_SCHEMA_VERSION, createSessionMessageStore };
