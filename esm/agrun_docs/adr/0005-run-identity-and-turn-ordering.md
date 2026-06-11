# ADR 0005: Run identity and turn ordering

## Context

Two related correctness bugs surfaced during the AGRUN-145 follow-up
review:

1. **Lexicographic turnId comparison (AGRUN-201).** `turnId` values
   used the shape `run-N` (e.g. `run-1`, `run-10`). Naive `<` / `>`
   on strings is lexicographic, so `"run-10" < "run-2"` evaluates
   true. Compaction window filtering ([src/runtime/thread-provenance.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/thread-provenance.js))
   and evidence scope filtering ([src/session/evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js))
   both used naive `<`, silently dropping newer turns once the run
   sequence reached two digits.
2. **Process-scoped runId counter (AGRUN-202).** `createRuntime`
   declared `let runSequence = 0` in its closure. Reopening a
   persisted session created a new runtime → new closure → counter
   reset → next runId reused `run-1`, colliding with provenance
   entries already stamped on prior turns.

Both are silent data-correctness failures: nothing crashes, but
state is wrong.

Affected modules: `src/runtime/turn-ordering.js`,
`src/runtime/run-identity.js`, `src/runtime/thread-provenance.js`,
`src/session/evidence.js`, `src/session/messages.js`,
`src/session/handle.js`, `src/runtime/runtime.js`.

## Decision

### `parseTurnId` contract

A single source of truth for turn-id ordering at
[src/runtime/turn-ordering.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/turn-ordering.js):

```ts
parseTurnId(id: string): { prefix: string, sequence: number } | null
compareTurnIds(a, b): number     // standard sort comparator shape
isTurnIdBefore(candidate, floor): boolean
```

Format: `<prefix>-<integer>`. Prefix is `[^-]*`; integer must be
non-negative and `Number.isSafeInteger`. Examples: `run-10`,
`turn-2`, `session-abc-r-7` (any non-empty prefix permitted).

Comparator is **total**: parseable + same-prefix → numeric;
otherwise lexical fallback. No NaN, no throw.

`isTurnIdBefore` is the semantic primitive call sites use. Returns
`false` when either id is missing or unparseable, matching the
existing "keep when in doubt" filter policy (legacy entries with
unknown turnIds must NOT be silently dropped).

### Durable run identity

Run sequence is persisted on `sessionRecord.lastRunSequence` (not
in a runtime closure). On session reopen, `hydrateRunSequence`
reconciles `lastRunSequence` with `lastRun.runId` so legacy
records (no `lastRunSequence` field) recover the correct floor
instead of restarting at 0.

`createSessionRunIdGenerator({ sessionRecord, persist })` wraps
this in an async closure that:
1. Increments `sessionRecord.lastRunSequence` in place.
2. Calls `formatRunId(sessionRecord.lastRunSequence)` to render
   the new id.
3. Persists via the supplied callback (typically
   `sessionStore.saveSession`).
4. Returns the rendered id.

The async signature is intentional — the durable boundary is the
saveSession write, not the in-memory counter bump. Callers must
`await` the next run id; this also gives AGRUN-206's CAS room to
reject the write and retry. Two `nextRunId` calls in flight on
the same record will serialize via the CAS round-trip.

### Format unchanged

Run ids stay `run-N`. Format stability is preserved so any
downstream consumer that pattern-matches the string (logs,
analytics, manual testing) keeps working. Uniqueness comes from
the persisted counter, not a format change.

## Alternatives

1. **Hash-based ids (UUID / KSUID).** Rejected — opaque ids
   defeat the lexicographic-comparison shortcut for legacy
   tooling, and break log-line readability.
2. **Number-only turnIds.** Rejected — keeping a string format
   lets future variants (`session-X-r-N`) reuse the same parser.
3. **Per-process counter shared across runtimes.** Rejected —
   does not survive process restart; doesn't actually solve
   AGRUN-202.
4. **Synchronous nextRunId with separate persistence.** Rejected —
   makes "claim the id" and "make it durable" two non-atomic
   operations; AGRUN-206 CAS retries cannot wrap that without
   exposing the inconsistency.

## Consequences

Pros:
- Compaction and evidence filters never silently drop newer
  turns, regardless of plan length.
- Session reopen resumes the run counter; provenance ids stay
  globally unique within a session.
- The `<prefix>-<integer>` format is reusable for any future
  durable-id scheme that needs same-prefix numeric ordering.
- Lexical fallback keeps the comparator total — heterogeneous
  ids (legacy / migration / mixed-format) sort deterministically
  even if the order is not "useful".

Cons:
- nextRunId is async, which forced touch of every call site
  (handle.js: 2 sites) when the function moved off a sync
  closure. Future call sites must remember to `await`.
- Lexical fallback can disagree with semantic intent when
  prefixes differ. Treated as acceptable: same-prefix is the
  documented use case; cross-prefix is "best effort".

Risks:
- If a future format change breaks the `^([^-]*)-(\d+)$` regex,
  EVERY consumer of `compareTurnIds` silently falls back to
  lexical. Mitigation: regression test
  ([test/unit/turn-ordering.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/turn-ordering.test.js))
  pins `compareTurnIds("run-2", "run-10") < 0`. Any regex
  change that breaks that case fails the gate.
- A misconfigured store (no `saveSession`) leaves
  `lastRunSequence` un-persisted across the runtime lifetime.
  `createSessionRunIdGenerator` requires a non-null
  sessionStore and throws at creation time, surfacing the
  misconfiguration immediately.

## Rollback

- Reverting commits 721e2483 (AGRUN-201) + 212deee3 (AGRUN-202)
  restores the lexical-comparison + closure-counter behavior.
- Persisted `lastRunSequence` fields on stored session records
  are silently ignored by older readers because `createSessionRecord`
  pre-AGRUN-202 had no such field — the JSON deserializer drops
  unknown keys gracefully.

## References

- AGRUN-201 commit: 721e2483
- AGRUN-202 commit: 212deee3
- Helpers: [src/runtime/turn-ordering.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/turn-ordering.js),
  [src/runtime/run-identity.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/run-identity.js)
- Tests: [test/unit/turn-ordering.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/turn-ordering.test.js),
  [test/unit/run-identity.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/run-identity.test.js)
