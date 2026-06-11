const DEFAULT_DB_NAME = "agrun-message-storage-v1";
const DB_VERSION = 1;

const SCHEMA = Object.freeze({
  sessions: { keyPath: "sessionID", indexes: [] },
  messages: { keyPath: "id", indexes: [{ name: "sessionID", keyPath: "sessionID" }] },
  parts: {
    keyPath: "id",
    indexes: [
      { name: "messageID", keyPath: "messageID" },
      { name: "sessionID", keyPath: "sessionID" }
    ]
  },
  diffs: { keyPath: "id", indexes: [{ name: "sessionID", keyPath: "sessionID" }] }
});

function createIndexedDBMessageStorage(options = {}) {
  const dbName = readString$1Y(options.dbName) || DEFAULT_DB_NAME;
  const redactor = typeof options.redactor === "function" ? options.redactor : null;
  let dbPromise = null;

  return {
    async createSession(session) {
      const record = normalizeSession(session);
      await putRecord(await getDb(), "sessions", record);
      return cloneValue(record);
    },

    async writeMessage(sessionID, message) {
      const record = applyRedactor(redactor, "message", normalizeMessage(sessionID, message));
      await putRecord(await getDb(), "messages", record);
      return cloneValue(record);
    },

    async writePart(sessionID, messageID, part) {
      const record = applyRedactor(redactor, "part", normalizePart(sessionID, messageID, part));
      await putRecord(await getDb(), "parts", record);
      return cloneValue(record);
    },

    async listSessions(query = {}) {
      const since = readNumber$n(query.since);
      const limit = readPositiveInteger$p(query.limit);
      const records = (await getAll(await getDb(), "sessions"))
        .filter((record) => since == null || readNumber$n(record.time && record.time.created) > since)
        .sort(compareCreated);
      return (limit ? records.slice(0, limit) : records).map((record) => ({
        sessionID: record.sessionID,
        time: record.time && record.time.created || null,
        title: record.title || null
      }));
    },

    async getMessages(sessionID) {
      return (await getAllByIndex(await getDb(), "messages", "sessionID", sessionID))
        .sort(compareCreated)
        .map(cloneValue);
    },

    async getParts(_sessionID, messageID) {
      return (await getAllByIndex(await getDb(), "parts", "messageID", messageID))
        .sort((a, b) => (readNumber$n(a.index) || 0) - (readNumber$n(b.index) || 0))
        .map(cloneValue);
    },

    async appendSessionDiff(sessionID, fileDiff) {
      const record = {
        ...cloneValue(fileDiff || {}),
        id: readString$1Y(fileDiff && fileDiff.id) || `diff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionID: readString$1Y(sessionID) || readString$1Y(fileDiff && fileDiff.sessionID),
        ts: readNumber$n(fileDiff && fileDiff.ts) || Date.now()
      };
      await putRecord(await getDb(), "diffs", record);
      return cloneValue(record);
    },

    async getSessionDiff(sessionID) {
      return (await getAllByIndex(await getDb(), "diffs", "sessionID", sessionID))
        .sort((a, b) => (readNumber$n(a.ts) || 0) - (readNumber$n(b.ts) || 0))
        .map(cloneValue);
    }
  };

  function getDb() {
    if (!dbPromise) dbPromise = openDb(dbName);
    return dbPromise;
  }
}

function openDb(dbName) {
  if (!globalThis.indexedDB || typeof globalThis.indexedDB.open !== "function") {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }

  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => ensureSchema(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`Failed to open IndexedDB ${dbName}.`));
    request.onblocked = () => reject(new Error(`Opening IndexedDB ${dbName} was blocked.`));
  });
}

function ensureSchema(db, transaction) {
  for (const [storeName, descriptor] of Object.entries(SCHEMA)) {
    const store = db.objectStoreNames.contains(storeName)
      ? null
      : db.createObjectStore(storeName, { keyPath: descriptor.keyPath });
    const objectStore = store || currentUpgradeStore(transaction, storeName);
    for (const index of descriptor.indexes) {
      if (!objectStore.indexNames.contains(index.name)) {
        objectStore.createIndex(index.name, index.keyPath);
      }
    }
  }
}

function currentUpgradeStore(transaction, storeName) {
  if (transaction && typeof transaction.objectStore === "function") {
    return transaction.objectStore(storeName);
  }
  throw new Error(`Cannot inspect existing IndexedDB store ${storeName} during upgrade.`);
}

function putRecord(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).put(cloneValue(record));
    request.onsuccess = () => resolve(cloneValue(record));
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result.map(cloneValue) : []);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function getAllByIndex(db, storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).index(indexName).getAll(value);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result.map(cloneValue) : []);
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function normalizeSession(session) {
  const record = cloneValue(session || {});
  const sessionID = readString$1Y(record.sessionID) || readString$1Y(record.sessionId);
  if (!sessionID) throw new TypeError("createSession requires sessionID.");
  return {
    ...record,
    schemaVersion: readString$1Y(record.schemaVersion) || "agrun.storage-session.v1",
    sessionID,
    time: normalizeTime(record.time)
  };
}

function normalizeMessage(sessionID, message) {
  const record = cloneValue(message || {});
  const id = readString$1Y(record.id);
  const resolvedSessionID = readString$1Y(sessionID) || readString$1Y(record.sessionID);
  if (!resolvedSessionID) throw new TypeError("writeMessage requires sessionID.");
  if (!id) throw new TypeError("writeMessage requires message.id.");
  return {
    ...record,
    id,
    sessionID: resolvedSessionID,
    time: normalizeTime(record.time)
  };
}

function normalizePart(sessionID, messageID, part) {
  const record = cloneValue(part || {});
  const id = readString$1Y(record.id);
  const resolvedSessionID = readString$1Y(sessionID) || readString$1Y(record.sessionID);
  const resolvedMessageID = readString$1Y(messageID) || readString$1Y(record.messageID);
  if (!resolvedSessionID) throw new TypeError("writePart requires sessionID.");
  if (!resolvedMessageID) throw new TypeError("writePart requires messageID.");
  if (!id) throw new TypeError("writePart requires part.id.");
  return {
    ...record,
    id,
    messageID: resolvedMessageID,
    sessionID: resolvedSessionID,
    time: normalizeTime(record.time)
  };
}

function applyRedactor(redactor, kind, record) {
  if (!redactor) return record;
  const next = redactor(cloneValue(record), { kind });
  return next && typeof next === "object" ? next : record;
}

function normalizeTime(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...cloneValue(source),
    created: readNumber$n(source.created) || Date.now()
  };
}

function compareCreated(a, b) {
  return (readNumber$n(a && a.time && a.time.created) || 0) - (readNumber$n(b && b.time && b.time.created) || 0);
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function readPositiveInteger$p(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

function readNumber$n(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString$1Y(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createIndexedDBMessageStorage };
