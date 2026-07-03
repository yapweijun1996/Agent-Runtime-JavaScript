import { cloneValue } from '../runtime/utils.js';
import { SessionVersionConflictError } from './errors.js';
import { upsertSessionMemoryEntry } from './memory-slot.js';
import { ensureSummaryKeyFields, composeSummaryKey } from './summary-key.js';

// AGRUN-206 — CAS check helper shared between store implementations.
// Returns the version to write (= incoming + 1). Throws on conflict.
// `null` stored means "first write for this id" — no version check
// (createSession path), but we still bump from incoming to incoming+1
// so the caller adopts a non-zero version after the first save.
function casNextVersion(stored, incoming) {
  const incomingV = typeof incoming.version === "number" ? incoming.version : 0;
  if (stored) {
    const storedV = typeof stored.version === "number" ? stored.version : 0;
    if (storedV !== incomingV) {
      throw new SessionVersionConflictError(storedV, incomingV, cloneValue(stored));
    }
  }
  return incomingV + 1;
}

// AGRUN-488 (audit H7) — bound the in-memory store's session growth. By
// default the store is UNBOUNDED (browser / single-process hosts keep the
// current behavior with zero surprise data loss). A long-lived multi-session
// server host opts in by passing `maxSessions` (LRU cap) and/or
// `sessionTtlMs` (idle expiry). Eviction is lazy + insert-driven — there is no
// background timer, so the store never holds a Node process alive. Evicting a
// session drops ALL of its per-session data (record + messages + summaries +
// memory); cross-session globalMemory is never evicted.
function normalizeEvictionOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  let maxSessions = null;
  if (source.maxSessions !== undefined && source.maxSessions !== null) {
    if (!Number.isInteger(source.maxSessions) || source.maxSessions <= 0) {
      throw new Error("createInMemorySessionStore: maxSessions must be a positive integer.");
    }
    maxSessions = source.maxSessions;
  }
  let sessionTtlMs = null;
  if (source.sessionTtlMs !== undefined && source.sessionTtlMs !== null) {
    if (typeof source.sessionTtlMs !== "number" || !Number.isFinite(source.sessionTtlMs) || source.sessionTtlMs <= 0) {
      throw new Error("createInMemorySessionStore: sessionTtlMs must be a positive number of milliseconds.");
    }
    sessionTtlMs = source.sessionTtlMs;
  }
  return { maxSessions, sessionTtlMs };
}

function createInMemorySessionStore(options) {
  const { maxSessions, sessionTtlMs } = normalizeEvictionOptions(options);
  const sessions = new Map();
  const messages = new Map();
  // AGRUN-145 Slice B — Summaries moved from per-session to
  // per-(session,thread). Key format is `${sessionId}::${threadId}` so the
  // Map can honor either legacy single-thread lookups (default thread) or
  // explicit per-thread lookups without schema branching.
  const summaries = new Map();
  const memoryEntries = new Map();
  const globalMemoryEntries = [];
  // AGRUN-488 — per-session access record { at, seq } driving eviction. `at` is
  // the wall-clock (Date.now()) the TTL idle-expiry measures against; `seq` is a
  // strictly-monotonic counter the LRU orders by. The counter is what makes LRU
  // correct under sub-millisecond bursts — Date.now() ties many same-ms sessions
  // and would degenerate the LRU into insertion order. Kept off the stored
  // record so cloneValue returns stay clean. Only populated when eviction is on.
  const accessRecords = new Map();
  let accessCounter = 0;
  const evictionEnabled = maxSessions !== null || sessionTtlMs !== null;

  function touch(sessionId) {
    if (!evictionEnabled || typeof sessionId !== "string" || !sessionId) return;
    accessCounter += 1;
    accessRecords.set(sessionId, { at: Date.now(), seq: accessCounter });
  }

  function evictSession(sessionId) {
    sessions.delete(sessionId);
    messages.delete(sessionId);
    memoryEntries.delete(sessionId);
    accessRecords.delete(sessionId);
    for (const [key, record] of summaries) {
      if (record && record.sessionId === sessionId) {
        summaries.delete(key);
      }
    }
  }

  function isExpired(sessionId, now) {
    if (sessionTtlMs === null) return false;
    const record = accessRecords.get(sessionId);
    return Boolean(record) && now - record.at > sessionTtlMs;
  }

  // Reclaim every session whose idle time exceeds the TTL. Called opportunistically
  // on insert so abandoned (created-then-never-touched) sessions are released even
  // without a read that would lazily expire them.
  function sweepExpired() {
    if (sessionTtlMs === null) return;
    const now = Date.now();
    for (const sessionId of Array.from(accessRecords.keys())) {
      if (isExpired(sessionId, now)) {
        evictSession(sessionId);
      }
    }
  }

  // Evict the least-recently-used sessions until the live count is within cap.
  function enforceLru() {
    if (maxSessions === null) return;
    while (sessions.size > maxSessions) {
      let oldestId = null;
      let oldestSeq = Infinity;
      for (const sessionId of sessions.keys()) {
        const record = accessRecords.get(sessionId);
        const seq = record ? record.seq : 0;
        if (seq < oldestSeq) {
          oldestSeq = seq;
          oldestId = sessionId;
        }
      }
      if (oldestId === null) break;
      evictSession(oldestId);
    }
  }

  return {
    async createSession(record) {
      sweepExpired();
      sessions.set(record.id, cloneValue(record));
      touch(record.id);
      enforceLru();
      return cloneValue(record);
    },

    async getSession(sessionId) {
      if (sessionTtlMs !== null && sessions.has(sessionId) && isExpired(sessionId, Date.now())) {
        evictSession(sessionId);
        return null;
      }
      const found = sessions.get(sessionId);
      if (found) touch(sessionId);
      return cloneNullable$3(found);
    },

    async saveSession(record) {
      // AGRUN-206 — CAS write. Reject when stored version diverges
      // from incoming so concurrent writers (e.g. two browser tabs)
      // cannot silently overwrite each other's `lastRunSequence`.
      const stored = sessions.get(record.id) || null;
      const nextVersion = casNextVersion(stored, record);
      const next = { ...cloneValue(record), version: nextVersion };
      sessions.set(record.id, next);
      // Mutate caller's record so it adopts the new version for its
      // next save without forcing every call site to do
      // `record = await saveSession(record)`.
      record.version = nextVersion;
      touch(record.id);
      enforceLru();
      return cloneValue(next);
    },

    async appendMessage(message) {
      const list = messages.get(message.sessionId) || [];
      list.push(cloneValue(message));
      messages.set(message.sessionId, list);
      touch(message.sessionId);
      return cloneValue(message);
    },

    async updateMessage(message) {
      const list = messages.get(message.sessionId) || [];
      const index = list.findIndex((entry) => entry.id === message.id);

      if (index === -1) {
        list.push(cloneValue(message));
      } else {
        list[index] = cloneValue(message);
      }

      messages.set(message.sessionId, list);
      touch(message.sessionId);
      return cloneValue(message);
    },

    async readMessages(sessionId) {
      touch(sessionId);
      return (messages.get(sessionId) || []).map(cloneValue);
    },

    async getSummary(sessionId, threadId) {
      touch(sessionId);
      return cloneNullable$3(summaries.get(composeSummaryKey(sessionId, threadId)));
    },

    async writeSummary(summary) {
      const record = ensureSummaryKeyFields(summary);
      summaries.set(record.id, cloneValue(record));
      touch(record.sessionId);
      return cloneValue(record);
    },

    async listSummaries(sessionId) {
      if (typeof sessionId !== "string" || !sessionId) return [];
      const out = [];
      for (const record of summaries.values()) {
        if (record && record.sessionId === sessionId) {
          out.push(cloneValue(record));
        }
      }
      return out.sort((a, b) => {
        const at = typeof a.updatedAt === "number" ? a.updatedAt : 0;
        const bt = typeof b.updatedAt === "number" ? b.updatedAt : 0;
        return at - bt;
      });
    },

    async appendMemory(sessionId, entry) {
      // AGRUN-494 (audit M17) — upsert by (kind, slot) so a re-confirmed slot
      // REPLACES its stale row instead of accumulating duplicates (only the
      // latest per slot is ever wanted; the read merge already assumes one row
      // per slot). Slot-less entries stay append-only.
      const list = memoryEntries.get(sessionId) || [];
      upsertSessionMemoryEntry(list, cloneValue(entry));
      memoryEntries.set(sessionId, list);
      touch(sessionId);
      return cloneValue(entry);
    },

    async readMemory(sessionId) {
      touch(sessionId);
      return (memoryEntries.get(sessionId) || []).map(cloneValue);
    },

    async appendGlobalMemory(entry) {
      const nextEntry = {
        ...cloneValue(entry),
        id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
        updatedAt: Date.now()
      };
      const existing = globalMemoryEntries.findIndex((e) => e.id === nextEntry.id);
      if (existing >= 0) {
        globalMemoryEntries[existing] = nextEntry;
      } else {
        globalMemoryEntries.push(nextEntry);
      }
      return cloneValue(nextEntry);
    },

    async readAllGlobalMemory() {
      return globalMemoryEntries
        .slice()
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map(cloneValue);
    },

    async deleteGlobalMemory(id) {
      const index = globalMemoryEntries.findIndex((e) => e.id === id);
      if (index >= 0) {
        globalMemoryEntries.splice(index, 1);
      }
    },

    async updateGlobalMemory(id, patch) {
      const index = globalMemoryEntries.findIndex((e) => e.id === id);
      if (index < 0) return null;
      const existing = globalMemoryEntries[index];
      const patchRecord = patch && typeof patch === "object" ? patch : {};
      const next = {
        ...existing,
        ...cloneValue(patchRecord),
        id: existing.id,
        createdAt: typeof existing.createdAt === "number" ? existing.createdAt : Date.now(),
        updatedAt: Date.now()
      };
      globalMemoryEntries[index] = next;
      return cloneValue(next);
    },

    async clearAllGlobalMemory() {
      globalMemoryEntries.length = 0;
    }
  };
}

function cloneNullable$3(value) {
  return value == null ? null : cloneValue(value);
}

export { createInMemorySessionStore };
