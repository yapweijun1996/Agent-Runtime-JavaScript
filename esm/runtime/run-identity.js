import { parseTurnId } from './turn-ordering.js';
import { isSessionVersionConflictError } from '../session/errors.js';
import { cloneValue } from './utils.js';

/**
 * AGRUN-202 — Durable run identity harness.
 *
 * Problem: a process-scoped `runSequence` resets on every `createRuntime()`,
 * so reopening a persisted session reuses `run-1`, `run-2`, … and collides
 * with provenance entries already stamped on prior turns. After AGRUN-201
 * fixed the lexical compare bug, the *uniqueness* hole became the next
 * data-correctness gap.
 *
 * Harness contract:
 *   - The session record owns `lastRunSequence` (a non-negative integer).
 *     This is the single source of truth for "what is the next run number
 *     in this session?" — runtime-level counters never override it.
 *   - `parseRunSequence(runId)` reuses the AGRUN-201 turn-ordering parser,
 *     so the format is consistent with every other turn-id consumer.
 *   - `hydrateRunSequence(sessionRecord)` reconciles `lastRunSequence`
 *     with `sessionRecord.lastRun.runId` so legacy records (saved before
 *     AGRUN-202) recover the correct floor instead of starting from 0.
 *   - `createSessionRunIdGenerator({ sessionRecord, persist })` mutates
 *     `sessionRecord.lastRunSequence` in place each call. Persist is
 *     fire-and-forget on purpose — the call site (session-handle) already
 *     calls `saveSession` at end of turn, so durability is guaranteed
 *     without a synchronous fsync per increment.
 *
 * Format note: the run id stays `run-${n}` for backward compatibility
 * with downstream consumers that pattern-match the string. Uniqueness
 * comes from the persisted sequence, not a format change.
 */


const RUN_ID_PREFIX = "run";

function parseRunSequence(runId) {
  const parsed = parseTurnId(runId);
  if (!parsed || parsed.prefix !== RUN_ID_PREFIX) return null;
  return parsed.sequence;
}

function formatRunId(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`formatRunId: sequence must be a positive integer, got ${sequence}`);
  }
  return `${RUN_ID_PREFIX}-${sequence}`;
}

function readNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Reconcile `sessionRecord.lastRunSequence` with the runId carried in
 * `sessionRecord.lastRun`. The higher of the two wins so a legacy record
 * (no `lastRunSequence` field) still resumes at the right floor.
 *
 * Mutates the record in place and returns it for chaining.
 */
function hydrateRunSequence(sessionRecord) {
  if (!sessionRecord || typeof sessionRecord !== "object") return sessionRecord;
  const persisted = readNonNegativeInteger(sessionRecord.lastRunSequence);
  const fromLastRun = sessionRecord.lastRun && typeof sessionRecord.lastRun === "object"
    ? parseRunSequence(sessionRecord.lastRun.runId)
    : null;
  const recovered = typeof fromLastRun === "number" && fromLastRun >= 0 ? fromLastRun : 0;
  sessionRecord.lastRunSequence = Math.max(persisted, recovered);
  return sessionRecord;
}

/**
 * Build a session-scoped run id generator.
 *
 * AGRUN-202 + AGRUN-206 — each call increments `lastRunSequence` and
 * persists through `sessionStore.saveSession`, which performs an
 * optimistic compare-and-swap on the session record's `version`. When
 * a concurrent writer (e.g. another browser tab) wins the race, the
 * store throws `SessionVersionConflictError`; we re-fetch the record,
 * adopt the higher of (our seq, stored seq), bump the adopted version,
 * and retry up to `maxAttempts` times.
 *
 * The generator is async — callers must `await nextRunId()`. This was
 * a deliberate API break (vs the old fire-and-forget persist hook):
 * AGRUN-206's correctness depends on the run id only being handed out
 * after the CAS write commits, so the caller cannot proceed until the
 * sequence is durably claimed.
 *
 * Required options:
 *   - `sessionRecord`  : record whose `lastRunSequence` and `version`
 *                        we mutate in place.
 *   - `sessionStore`   : object exposing `saveSession(record)` and
 *                        `getSession(id)`. saveSession must throw a
 *                        SessionVersionConflictError on version
 *                        mismatch; otherwise it must return the saved
 *                        record (with bumped version).
 *
 * Optional:
 *   - `maxAttempts`    : retry budget on CAS conflict (default 5).
 */
function createSessionRunIdGenerator(options) {
  const opts = options && typeof options === "object" ? options : {};
  const sessionRecord = opts.sessionRecord;
  if (!sessionRecord || typeof sessionRecord !== "object") {
    throw new Error("createSessionRunIdGenerator: sessionRecord is required");
  }
  const sessionStore = opts.sessionStore;
  if (!sessionStore || typeof sessionStore.saveSession !== "function" || typeof sessionStore.getSession !== "function") {
    throw new Error("createSessionRunIdGenerator: sessionStore with saveSession/getSession is required");
  }
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : 5;
  hydrateRunSequence(sessionRecord);

  return async function nextRunId() {
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      sessionRecord.lastRunSequence += 1;
      try {
        // saveSession mutates `sessionRecord.version` to the bumped
        // value on success, so the next call already carries the
        // correct CAS token.
        await sessionStore.saveSession(sessionRecord);
        return formatRunId(sessionRecord.lastRunSequence);
      } catch (err) {
        if (!isSessionVersionConflictError(err)) {
          // Non-CAS failure: undo the optimistic bump and surface.
          // Without this the in-memory counter would drift past the
          // stored one and later reopens would skip ids.
          sessionRecord.lastRunSequence -= 1;
          throw err;
        }
        lastError = err;
        // CAS conflict: undo our bump, then adopt the conflicting
        // record's version + sequence floor. We prefer the record
        // attached to the error (carried by the store on conflict)
        // over a fresh `getSession`, because that extra await would
        // open another window for a third writer to race ahead and
        // we'd retry-loop forever under high contention.
        sessionRecord.lastRunSequence -= 1;
        let fresh = err && typeof err === "object" ? err.storedRecord : null;
        if (!fresh) {
          fresh = await sessionStore.getSession(sessionRecord.id);
        }
        if (fresh && typeof fresh === "object") {
          mergeFreshSessionRecord(sessionRecord, fresh);
        }
      }
    }
    throw new Error(
      `createSessionRunIdGenerator: gave up after ${maxAttempts} CAS conflicts (last: ${lastError && lastError.message})`
    );
  };
}

function mergeFreshSessionRecord(sessionRecord, fresh) {
  const localSeq = readNonNegativeInteger(sessionRecord.lastRunSequence);
  const localCompactedAt = readNonNegativeInteger(sessionRecord.compactedAt);
  const next = cloneValue(fresh);
  for (const key of Object.keys(sessionRecord)) {
    delete sessionRecord[key];
  }
  Object.assign(sessionRecord, next);
  const freshSeq = readNonNegativeInteger(sessionRecord.lastRunSequence);
  sessionRecord.lastRunSequence = Math.max(localSeq, freshSeq);
  if (localCompactedAt > readNonNegativeInteger(sessionRecord.compactedAt)) {
    sessionRecord.compactedAt = localCompactedAt;
  }
  sessionRecord.version = typeof fresh.version === "number" ? fresh.version : 0;
}

export { createSessionRunIdGenerator, formatRunId, hydrateRunSequence, parseRunSequence };
