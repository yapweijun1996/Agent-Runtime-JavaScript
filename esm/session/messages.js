import { cloneValue } from '../runtime/utils.js';
import { readActiveTurnId, readActiveThreadId } from '../runtime/thread-provenance.js';
import { createAssistantSessionContent, createUserSessionContent } from './content.js';
import { DEFAULT_THREAD_ID } from './thread.js';

function createSessionRecord(id) {
  const now = Date.now();

  return {
    compactedAt: null,
    contextSnapshot: null,
    createdAt: now,
    id,
    cumulativeUsage: null,
    lastRun: null,
    // AGRUN-202 — Durable run identity. Persists the highest issued
    // run sequence so reopening this session never reuses a previous
    // turn id (which would collide with stamped provenance entries).
    lastRunSequence: 0,
    lastTokenUsage: null,
    // AGRUN-240 — Session lineage. Null until caller passes parentSessionId
    // in session.run() input, enabling orchestrator-worker task tree debugging.
    parentSessionId: null,
    updatedAt: now,
    // AGRUN-206 — Optimistic concurrency token. `saveSession` rejects
    // writes whose `version` does not match the stored one, so two
    // tabs sharing this session id cannot both increment
    // `lastRunSequence` to the same number and emit duplicate run
    // ids. Bumped by the store on every successful write.
    version: 0
  };
}

function createSessionId() {
  return createId("session");
}

function createPendingUserMessage(sessionId, value) {
  return createSessionMessage(sessionId, "user", value, "pending");
}

function createCompactionTurnMessages(sessionId, options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const now = readTimestamp(source.createdAt, Date.now());
  const runId = readString$8(source.runId) || createId("cmp");
  const turnId = readString$8(source.turnId) || runId;
  const threadId = readString$8(source.threadId) || DEFAULT_THREAD_ID;
  const sourceMessageIds = Array.isArray(source.sourceMessageIds)
    ? source.sourceMessageIds.map(readString$8).filter(Boolean)
    : [];
  const summaryText = readString$8(source.summaryText);
  const summaryId = readString$8(source.summaryId) || null;
  const uptoMessageId = readString$8(source.uptoMessageId) || null;
  const oldestPreservedTurnId = readString$8(source.oldestPreservedTurnId) || null;
  const reason = readString$8(source.reason) || "budget";
  const userMessageId = readString$8(source.userMessageId) || createId("msg");
  const assistantMessageId = readString$8(source.assistantMessageId) || createId("msg");
  const compactionBase = {
    oldestPreservedTurnId,
    reason,
    sourceMessageIds,
    summaryId,
    uptoMessageId
  };

  return {
    assistantMessage: {
      compaction: {
        ...cloneValue(compactionBase),
        role: "assistant"
      },
      content: createAssistantSessionContent({ text: summaryText }, null),
      createdAt: now + 1,
      hidden: true,
      id: assistantMessageId,
      kind: "compaction",
      role: "assistant",
      runId,
      sessionId,
      status: "completed",
      threadId,
      turnId
    },
    userMessage: {
      compaction: {
        ...cloneValue(compactionBase),
        role: "user"
      },
      content: createUserSessionContent(
        buildCompactionBoundaryText(sourceMessageIds, uptoMessageId)
      ),
      createdAt: now,
      hidden: true,
      id: userMessageId,
      kind: "compaction",
      role: "user",
      runId,
      sessionId,
      status: "completed",
      threadId,
      turnId
    }
  };
}

function createAssistantMessage(sessionId, result) {
  // AGRUN-145 Slice A — Persist thread provenance on every assistant
  // message at creation time. Legacy / threads-disabled runtimes fall back
  // to DEFAULT_THREAD_ID via `readActiveThreadId`. `turnId` mirrors `runId`
  // so compaction can group messages by `(threadId, turnId)` without
  // reaching back into runState.
  return {
    content: createAssistantSessionContent(result.output, result.error),
    createdAt: Date.now(),
    id: createId("msg"),
    role: "assistant",
    runId: result.runState.runId,
    sessionId,
    status: readPersistedMessageStatus(result),
    threadId: readActiveThreadId(result.runState),
    turnId: readActiveTurnId(result.runState) || result.runState.runId || null
  };
}

function isCompactionMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (message.kind === "compaction") return true;
  const compaction = message.compaction && typeof message.compaction === "object"
    ? message.compaction
    : null;
  return Boolean(compaction && readString$8(compaction.role));
}

function normalizeSeedMessages(sessionId, seedMessages) {
  const list = Array.isArray(seedMessages) ? seedMessages : [];
  const baseTimestamp = Date.now();

  return list
    .map((message, index) => normalizeSeedMessage(sessionId, message, baseTimestamp + index))
    .filter(Boolean);
}

function normalizeSeedMessage(sessionId, message, fallbackTimestamp) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const role = readSeedRole(message.role);

  if (!role) {
    return null;
  }

  const content = role === "assistant"
    ? createAssistantSeedContent(message)
    : createUserSeedContent(message);

  if (!content) {
    return null;
  }

  return {
    content,
    createdAt: readTimestamp(message.createdAt, fallbackTimestamp),
    id: createId("msg"),
    role,
    runId: null,
    sessionId,
    status: "completed",
    // Seed messages predate thread routing; park them in the default
    // thread so compaction groupers and evidence filters see a consistent
    // shape across legacy + post-AGRUN-144 sessions.
    threadId: DEFAULT_THREAD_ID,
    turnId: null
  };
}

function createSessionMessage(sessionId, role, value, status) {
  return {
    content: role === "assistant"
      ? createAssistantSessionContent(value, null)
      : createUserSessionContent(value),
    createdAt: Date.now(),
    id: createId("msg"),
    role,
    runId: null,
    sessionId,
    status,
    // Pending user messages get stamped with the router's verdict in
    // handle.js after `routeTurnToThread` resolves. Leaving DEFAULT here
    // keeps a safe fallback if the runtime short-circuits before routing.
    threadId: DEFAULT_THREAD_ID,
    turnId: null
  };
}

function createUserSeedContent(message) {
  const prompt = readUserSeedText(message);
  const parts = Array.isArray(message.parts) ? message.parts : null;

  if (parts && parts.length > 0) {
    return createUserSessionContent({
      parts,
      prompt
    });
  }

  const text = readUserSeedText(message);
  return text ? createUserSessionContent(text) : null;
}

function createAssistantSeedContent(message) {
  const text = readAssistantSeedText(message);
  return text ? createAssistantSessionContent({ text }, null) : null;
}

function readUserSeedText(message) {
  return readString$8(message.content) || readString$8(message.text);
}

function readAssistantSeedText(message) {
  return readString$8(message.content) || readString$8(message.text);
}

function readSeedRole(value) {
  return value === "user" || value === "assistant" ? value : "";
}

function readTimestamp(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString$8(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildCompactionBoundaryText(sourceMessageIds, uptoMessageId) {
  const count = Array.isArray(sourceMessageIds) ? sourceMessageIds.length : 0;
  const noun = count === 1 ? "message" : "messages";
  const suffix = uptoMessageId ? ` through ${uptoMessageId}` : "";
  return `Compaction boundary: summarize ${count} earlier ${noun}${suffix} for future turns.`;
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readPersistedMessageStatus(result) {
  return result && result.runState && result.runState.status === "failed"
    ? "failed"
    : "completed";
}

export { createAssistantMessage, createCompactionTurnMessages, createPendingUserMessage, createSessionId, createSessionRecord, isCompactionMessage, normalizeSeedMessages, readPersistedMessageStatus };
