/**
 * AGRUN-206 — Session-store CAS error.
 *
 * Thrown by `saveSession` when the version on the incoming record does
 * not match the version of the record currently in the store. The
 * caller (typically the run-id generator's retry loop) catches this
 * specific class to distinguish "another writer beat me; re-fetch and
 * retry" from genuine I/O failures.
 *
 * The class also carries the two version numbers so test assertions
 * and observability hooks can confirm which writer lost the race.
 */
class SessionVersionConflictError extends Error {
  constructor(storedVersion, incomingVersion, storedRecord) {
    super(`Session version conflict (stored=${storedVersion}, incoming=${incomingVersion}).`);
    this.name = "SessionVersionConflictError";
    this.storedVersion = storedVersion;
    this.incomingVersion = incomingVersion;
    // Carrying the conflicting record lets the retry loop adopt the
    // winning state without a second I/O round-trip — under high
    // contention, that extra `getSession` await would re-open the
    // window for yet another writer to race ahead.
    this.storedRecord = storedRecord || null;
  }
}

function isSessionVersionConflictError(err) {
  return err instanceof SessionVersionConflictError
    || (err && err.name === "SessionVersionConflictError");
}

export { SessionVersionConflictError, isSessionVersionConflictError };
