import { cloneValue } from '../runtime/utils.js';
import { SessionVersionConflictError } from './errors.js';
import { ensureSummaryKeyFields, composeSummaryKey } from './summary-key.js';

const DEFAULT_DB_NAME$1 = "agrun-session-store";
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
// AGRUN-145 Slice B — v3: re-key `summaries` to composite `id`.
// AGRUN-203 — v4 carries no schema delta; the bump exists to force every
// pre-AGRUN-203 db through `ensureSchema`, which now creates ANY missing
// index on existing stores. Earlier upgrades only created indexes when
// the store itself was new, so a legacy db opened by an older build
// could be missing indexes that current reads (`getAllByIndex`) require,
// surfacing as `NotFoundError`.
const DB_VERSION$1 = 4;

// AGRUN-203 — Single source of truth for the IndexedDB schema. Every
// upgrade pass walks this descriptor and creates any missing store /
// index, so adding a new index is one line here instead of a new
// imperative branch in `onupgradeneeded`. We never delete user data
// from this descriptor — drops are explicit (see the v3 summaries
// rebuild below).
//
// Harness: schema is data, migration is a fold over that data. There
// is no "is this index already there?" branch scattered across the
// codebase — `ensureSchema` answers it for every (store, index) pair.
const SCHEMA$1 = Object.freeze({
  sessions:      { keyPath: "id",  indexes: [] },
  messages:      { keyPath: "id",  indexes: [{ name: "sessionId", keyPath: "sessionId" }] },
  summaries:     { keyPath: "id",  indexes: [{ name: "sessionId", keyPath: "sessionId" }] },
  memoryEntries: { keyPath: "key", indexes: [{ name: "sessionId", keyPath: "sessionId" }] },
  globalMemory:  { keyPath: "id",  indexes: [{ name: "category",  keyPath: "category"  }] }
});

function createIndexedDBSessionStore(options) {
  const dbName = readString$1Z(options && options.dbName) || DEFAULT_DB_NAME$1;
  const openTimeoutMs = readPositiveNumber$4(options && options.openTimeoutMs) || DEFAULT_OPEN_TIMEOUT_MS;
  let dbPromise = null;

  return {
    async createSession(record) {
      await putRecord$1(await getDb(), "sessions", record);
      return cloneValue(record);
    },

    async getSession(sessionId) {
      return cloneNullable$2(await getRecord(await getDb(), "sessions", sessionId));
    },

    async saveSession(record) {
      // AGRUN-206 — CAS write. The read-then-put runs in a single
      // readwrite transaction so IndexedDB's per-store isolation
      // gives us atomic compare-and-swap against concurrent writers.
      const saved = await casPutSession(await getDb(), record);
      record.version = saved.version;
      return cloneValue(saved);
    },

    async appendMessage(message) {
      await putRecord$1(await getDb(), "messages", message);
      return cloneValue(message);
    },

    async updateMessage(message) {
      await putRecord$1(await getDb(), "messages", message);
      return cloneValue(message);
    },

    async readMessages(sessionId) {
      const db = await getDb();
      const items = await getAllByIndex$1(db, "messages", "sessionId", sessionId);
      return items
        .sort(compareTimestamp)
        .map(cloneValue);
    },

    async getSummary(sessionId, threadId) {
      return cloneNullable$2(
        await getRecord(await getDb(), "summaries", composeSummaryKey(sessionId, threadId))
      );
    },

    async writeSummary(summary) {
      const record = ensureSummaryKeyFields(summary);
      await putRecord$1(await getDb(), "summaries", record);
      return cloneValue(record);
    },

    async listSummaries(sessionId) {
      if (typeof sessionId !== "string" || !sessionId) return [];
      const db = await getDb();
      const items = await getAllByIndex$1(db, "summaries", "sessionId", sessionId);
      return items
        .sort((a, b) => {
          const at = typeof a.updatedAt === "number" ? a.updatedAt : 0;
          const bt = typeof b.updatedAt === "number" ? b.updatedAt : 0;
          return at - bt;
        })
        .map(cloneValue);
    },

    async appendMemory(sessionId, entry) {
      const nextEntry = {
        ...cloneValue(entry),
        key: `${sessionId}:${readString$1Z(entry.timestamp)}:${Math.random().toString(36).slice(2, 8)}`,
        sessionId
      };
      await putRecord$1(await getDb(), "memoryEntries", nextEntry);
      return cloneValue(entry);
    },

    async readMemory(sessionId) {
      const db = await getDb();
      const items = await getAllByIndex$1(db, "memoryEntries", "sessionId", sessionId);
      return items
        .sort(compareTimestamp)
        .map((entry) => {
          const clone = cloneValue(entry);
          delete clone.key;
          delete clone.sessionId;
          return clone;
        });
    },

    async appendGlobalMemory(entry) {
      const nextEntry = {
        ...cloneValue(entry),
        id: entry.id || generateId$2(),
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        updatedAt: Date.now()
      };
      await putRecord$1(await getDb(), "globalMemory", nextEntry);
      return cloneValue(nextEntry);
    },

    async readAllGlobalMemory() {
      const db = await getDb();
      const items = await getAllRecords(db, "globalMemory");
      return items.sort(compareTimestamp).map(cloneValue);
    },

    async deleteGlobalMemory(id) {
      await deleteRecord(await getDb(), "globalMemory", id);
    },

    async updateGlobalMemory(id, patch) {
      const db = await getDb();
      const existing = await getRecord(db, "globalMemory", id);
      if (!existing) return null;
      const patchRecord = patch && typeof patch === "object" ? patch : {};
      const next = {
        ...existing,
        ...cloneValue(patchRecord),
        id: existing.id,
        createdAt: typeof existing.createdAt === "number" ? existing.createdAt : Date.now(),
        updatedAt: Date.now()
      };
      await putRecord$1(db, "globalMemory", next);
      return cloneValue(next);
    },

    async clearAllGlobalMemory() {
      await clearStore(await getDb(), "globalMemory");
    }
  };

  async function getDb() {
    if (!dbPromise) {
      // AGRUN-475 (audit M8) — getDb() memoizes the open connection in
      // dbPromise. A `versionchange` (another tab upgrading/deleting the DB)
      // or an abnormal `close` shuts THIS connection down, but the resolved-
      // but-now-dead db stays cached: every later getDb() hands back the
      // closed connection and all transactions throw InvalidStateError —
      // permanent degradation until the whole runtime is recreated. Pass a
      // loss callback that drops the cache so the next getDb() transparently
      // re-opens. The identity guard (`dbPromise === opening`) ensures a late
      // loss event from an old connection never clobbers a fresh re-open.
      const opening = openDb$1(dbName, {
        timeoutMs: openTimeoutMs,
        onConnectionLost: () => {
          if (dbPromise === opening) dbPromise = null;
        }
      });
      dbPromise = opening;
    }

    return dbPromise;
  }
}

function openDb$1(dbName, options) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(dbName, DB_VERSION$1);
    const timeoutMs = readPositiveNumber$4(options && options.timeoutMs) || DEFAULT_OPEN_TIMEOUT_MS;
    let settled = false;
    const timeoutId = setTimeout(() => {
      settleReject(createStorageOpenError(
        "InvalidStateError",
        `IndexedDB open timed out after ${timeoutMs}ms for "${dbName}".`
      ));
    }, timeoutMs);

    function settleResolve(db) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(db);
    }

    function settleReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const txn = request.transaction;
      const oldVersion = typeof event === "object" && event && typeof event.oldVersion === "number"
        ? event.oldVersion
        : 0;

      // AGRUN-145 Slice B — v3 re-keys `summaries` from `sessionId` to
      // composite `id = "${sessionId}::${threadId}"`. Summaries are
      // derived and regenerable, so dropping the legacy store is safe
      // (the next compaction repopulates under the new schema).
      if (oldVersion < 3 && db.objectStoreNames.contains("summaries")) {
        db.deleteObjectStore("summaries");
      }

      ensureSchema$1(db, txn);
    };

    request.onsuccess = () => {
      const db = request.result;
      // AGRUN-475 (audit M8) — On any connection loss, notify the factory so it
      // can invalidate its cached dbPromise and re-open on the next call.
      const onConnectionLost = typeof options.onConnectionLost === "function"
        ? options.onConnectionLost
        : null;
      db.onversionchange = () => {
        try { db.close(); } catch (_) { /* Ignore close failures. */ }
        if (onConnectionLost) onConnectionLost();
      };
      // Abnormal close (storage deleted, forced close by the agent): same
      // recovery path — the cached connection is dead, drop it.
      db.onclose = () => {
        if (onConnectionLost) onConnectionLost();
      };
      settleResolve(db);
    };
    request.onerror = () => settleReject(request.error || new Error("Failed to open IndexedDB."));
    request.onblocked = () => settleReject(createStorageOpenError(
      "InvalidStateError",
      `IndexedDB open blocked for "${dbName}". Close other tabs using this app and retry.`
    ));
  });
}

// AGRUN-203 — Idempotent schema migration.
//
// Pre-fix bug: `ensureStore` only created indexes inside the
// `createObjectStore` branch, so a store created by an earlier
// version that didn't yet declare a given index would never get it
// retro-fitted on upgrade. Reads via `getAllByIndex` then threw
// `NotFoundError` against the missing index.
//
// Fix: walk every (store, index) in `SCHEMA` and create whatever is
// missing. Both `db.createObjectStore` (new store) and
// `txn.objectStore(name)` (existing store under a versionchange
// transaction) return a store handle that supports `createIndex`,
// so adding an index to a pre-existing store is just an extra
// `indexNames.contains` guard. We do NOT delete unknown indexes —
// that would risk wiping user data on a downgrade-then-upgrade.
function ensureSchema$1(db, versionChangeTxn) {
  for (const [name, spec] of Object.entries(SCHEMA$1)) {
    const store = db.objectStoreNames.contains(name)
      ? versionChangeTxn.objectStore(name)
      : db.createObjectStore(name, { keyPath: spec.keyPath });

    for (const index of spec.indexes) {
      if (!store.indexNames.contains(index.name)) {
        store.createIndex(index.name, index.keyPath, { unique: false });
      }
    }
  }
}

// AGRUN-206 — Atomic compare-and-swap put for session records.
// Reads the existing record under the same readwrite transaction,
// rejects on version mismatch, otherwise writes the bumped record.
// Using one transaction means concurrent writers cannot interleave a
// read between our get and our put — IndexedDB serializes overlapping
// readwrite transactions on the same store.
function casPutSession(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    let settled = false;
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const getReq = store.get(record.id);
    getReq.onsuccess = () => {
      const stored = getReq.result || null;
      const incomingV = typeof record.version === "number" ? record.version : 0;
      if (stored) {
        const storedV = typeof stored.version === "number" ? stored.version : 0;
        if (storedV !== incomingV) {
          try { tx.abort(); } catch (_) { /* tx may already be aborting */ }
          finishReject(new SessionVersionConflictError(storedV, incomingV, cloneValue(stored)));
          return;
        }
      }
      const next = { ...cloneValue(record), version: incomingV + 1 };
      store.put(next);
      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(next);
        }
      };
    };
    getReq.onerror = () => finishReject(getReq.error || new Error("Failed to read sessions for CAS."));
    tx.onerror = () => finishReject(tx.error || new Error("Failed to write sessions."));
    tx.onabort = () => finishReject(tx.error || new SessionVersionConflictError(-1, -1, null));
  });
}

function putRecord$1(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(cloneValue(record));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Failed to write ${storeName}.`));
  });
}

function getRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}.`));
  });
}

function getAllRecords(db, storeName) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error(`Failed to list ${storeName}.`));
  });
}

function deleteRecord(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Failed to delete from ${storeName}.`));
  });
}

function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error(`Failed to clear ${storeName}.`));
  });
}

function generateId$2() {
  if (typeof globalThis.crypto === "object" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getAllByIndex$1(db, storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly")
      .objectStore(storeName)
      .index(indexName)
      .getAll(value);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error(`Failed to list ${storeName}.`));
  });
}

function compareTimestamp(left, right) {
  const leftTime = typeof left.createdAt === "number" ? left.createdAt : 0;
  const rightTime = typeof right.createdAt === "number" ? right.createdAt : 0;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return readString$1Z(left.id || left.key).localeCompare(readString$1Z(right.id || right.key));
}

function cloneNullable$2(value) {
  return value == null ? null : cloneValue(value);
}

function readString$1Z(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveNumber$4(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function createStorageOpenError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export { createIndexedDBSessionStore, ensureSchema$1 as ensureSchema };
