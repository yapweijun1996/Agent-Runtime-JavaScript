# ADR 0006: Session record optimistic concurrency (CAS)

## Context

ADR-0005 closed the single-tab `run-1` reuse via the durable
`lastRunSequence` field on the session record. But `saveSession`
remained last-write-wins. With multi-tab usage of the same
sessionId:

1. Tab A reads sessionRecord (`lastRunSequence = 7`).
2. Tab B reads sessionRecord (`lastRunSequence = 7`).
3. Tab A bumps to 8, saveSession writes `lastRunSequence = 8`.
4. Tab B bumps to 8, saveSession writes `lastRunSequence = 8`.
5. Both tabs emit `run-8` → provenance collision, AGRUN-202's
   single-tab fix bypassed.

Same race exists for any multi-writer field: token usage
counters, compaction state, thread routing decisions, etc.

Affected modules: `src/session/store-memory.js`,
`src/session/store-indexeddb.js`, `src/session/errors.js`
(new), `src/session/messages.js`, `src/runtime/run-identity.js`.

## Decision

### `version` token on every session record

`createSessionRecord` adds `version: 0`. Every successful
`saveSession` bumps it by 1.

### CAS check inside `saveSession`

Both store implementations (in-memory + IndexedDB) check
`stored.version === incoming.version` before writing:

- **Memory store**: read-modify-write inside one synchronous
  function call.
- **IndexedDB store**: read-modify-write inside ONE
  `readwrite` transaction so IndexedDB's per-store isolation
  makes the get/put pair atomic against other writers.

Mismatch throws `SessionVersionConflictError`.

### Conflict error carries the stored record

`SessionVersionConflictError(storedVersion, incomingVersion, storedRecord)`
includes the conflicting record itself. The retry loop adopts
`err.storedRecord` directly without a second `getSession`
round-trip.

This is load-bearing: an extra `await getSession()` before
retrying opens a new race window for a third writer to advance
the record again. Under high contention the retry budget would
exhaust before any writer succeeds. With `storedRecord` on the
error, the retry takes zero extra I/O hops.

### Generator retry loop

`createSessionRunIdGenerator` (ADR-0005) wraps `nextRunId` in a
bounded retry:

```js
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  sessionRecord.lastRunSequence += 1;
  try {
    await sessionStore.saveSession(sessionRecord);
    return formatRunId(sessionRecord.lastRunSequence);
  } catch (err) {
    if (!isSessionVersionConflictError(err)) {
      sessionRecord.lastRunSequence -= 1; // undo bump on non-CAS error
      throw err;
    }
    // CAS conflict: undo bump, adopt the storedRecord from the
    // error, retry with fresh version + max(our seq, stored seq).
    ...
  }
}
```

`maxAttempts = 5` default. Empirically validated by the
concurrent-writers regression test, which interleaves 10
nextRunId calls across two generators sharing the same store
and asserts every issued id is unique.

### Version is bumped by `saveSession`, not the caller

The store mutates the caller's `record.version` to the
post-write value. Callers read it back on the next mutation.
This avoids forcing every save site to do
`record = await saveSession(record)`.

## Alternatives

1. **Pessimistic locking.** Rejected — the multi-tab use case
   is browser local, no shared lock daemon available.
2. **Last-write-wins + telemetry.** Rejected — the failure
   silently corrupts provenance; telemetry alone does not
   restore the lost id.
3. **Synchronous CAS without retry, throw to caller.** Rejected
   — would force every save site to wrap with retry logic;
   centralizing it inside `nextRunId` is one location to audit.
4. **Refresh `lastRunSequence` via separate `getSession` call
   on conflict.** Was the first design. Failed under high
   contention because the extra await opened a new race window.
   Replaced with `storedRecord` on the error.

## Consequences

Pros:
- Multi-tab races no longer corrupt provenance ids.
- The retry loop is a single, audited primitive in
  [src/runtime/run-identity.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-identity.js);
  no other site reimplements CAS logic.
- `version` is also available to any future caller that wants
  to detect "did someone else write this record between my
  read and my next write?" — generic concurrency primitive,
  not just runId-specific.

Cons:
- Save throughput drops slightly under contention because
  retries serialize.
- Every store implementation MUST honor the CAS contract;
  a future store backend that ignores `version` reintroduces
  the race silently.

Risks:
- A pathological hot-loop with > 5 writers could exhaust the
  retry budget. Mitigation: `maxAttempts` is configurable
  per-generator; production scenarios with high write fanout
  should bump the budget AND investigate why fanout is high.

## Rollback

- Reverting commit e94c6d65 removes the CAS check from both
  store implementations and the retry loop from
  `createSessionRunIdGenerator`.
- Persisted `version` fields on session records are silently
  ignored by older readers (unknown JSON key).

## References

- AGRUN-206 commit: e94c6d65
- Implementation: [src/session/errors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/errors.js),
  [src/session/store-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-memory.js),
  [src/session/store-indexeddb.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-indexeddb.js),
  [src/runtime/run-identity.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-identity.js)
- Tests: [test/unit/run-identity.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/run-identity.test.js)
  (concurrent writers scenario)
