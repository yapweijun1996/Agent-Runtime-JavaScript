# ADR 0007: IndexedDB schema migration via descriptor

## Context

The pre-fix `ensureStore()` only created indexes inside the
`createObjectStore` branch:

```js
function ensureStore(db, name, keyPath, indexKeyPath) {
  const store = db.objectStoreNames.contains(name)
    ? null  // <-- store exists; no index check
    : db.createObjectStore(name, { keyPath });
  if (store && indexKeyPath && !store.indexNames.contains(indexKeyPath)) {
    store.createIndex(indexKeyPath, indexKeyPath, { unique: false });
  }
}
```

A database created at version N without index X never gets X
retro-fitted when reopened at version N+1, because the
`if (!contains)` branch does not enter when the store already
exists. Subsequent reads via `getAllByIndex` then throw
`NotFoundError` against the missing index.

This is the classic "imperative migration script that forgets
to be idempotent" failure mode. AGRUN-203 surfaced it during
the AGRUN-145 follow-up audit.

Affected module: `src/session/store-indexeddb.js`.

## Decision

### Schema as data, migration as fold

The set of object stores and their indexes is captured as a
single frozen descriptor:

```js
const SCHEMA = Object.freeze({
  sessions:      { keyPath: "id",  indexes: [] },
  messages:      { keyPath: "id",  indexes: [{ name: "sessionId", keyPath: "sessionId" }] },
  summaries:     { keyPath: "id",  indexes: [{ name: "sessionId", keyPath: "sessionId" }] },
  memoryEntries: { keyPath: "key", indexes: [{ name: "sessionId", keyPath: "sessionId" }] },
  globalMemory:  { keyPath: "id",  indexes: [{ name: "category",  keyPath: "category"  }] }
});
```

Migration is a fold over this descriptor:

```js
function ensureSchema(db, versionChangeTxn) {
  for (const [name, spec] of Object.entries(SCHEMA)) {
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
```

Every (store, index) pair is checked independently and created
only if missing. Both the new-database and upgrade paths run the
same loop.

### DB_VERSION bump forces migration

`DB_VERSION` was bumped to 4 (no schema delta vs 3) explicitly to
force every pre-AGRUN-203 database through the new
`ensureSchema`. Pre-fix databases that opened cleanly at v3 will
re-enter `onupgradeneeded` at v4 and gain any missing indexes.

### Destructive migrations are explicit

The v3 summaries re-key (composite `id = "${sessionId}::${threadId}"`)
remains an explicit `db.deleteObjectStore("summaries")` branch
gated on `oldVersion < 3`. The descriptor is for additive
changes; non-additive changes (key path changes, store deletes)
are explicit in `onupgradeneeded`.

## Alternatives

1. **Migrate in batched per-version steps.** Rejected — every
   version bump would need bespoke code; descriptor handles
   "any pre-N to current" in one fold.
2. **Always recreate stores on every upgrade.** Rejected —
   destroys user data.
3. **Defer index creation to first index read.** Rejected — adds
   a runtime branch that has to handle "index not present yet"
   in every reader.
4. **Use a migration framework (Dexie, idb).** Rejected for now
   — current requirements fit ~30 lines; framework is
   over-engineering until we have ≥ 3 destructive migrations.

## Consequences

Pros:
- Adding a new index is one line in `SCHEMA`. Adding a new store
  is one entry. Migration logic doesn't change.
- The descriptor is the single source of truth for the database
  shape. Schema drift between code and disk surfaces immediately.
- `ensureSchema` is idempotent within a single
  `versionchange` transaction — calling it twice in the same
  upgrade does not throw or duplicate.

Cons:
- Destructive migrations (key path changes, store deletes) still
  need imperative code outside the descriptor. The pattern is
  "additive via descriptor, destructive via explicit branch".
- The descriptor describes shape, not data semantics. A store's
  schema migration that changes record shape (not just keys/
  indexes) is still imperative.

Risks:
- `versionchange` transactions are short-lived. A descriptor
  with many indexes could exceed transaction time on slow
  storage. Current ~5 stores × 1 index each is fine; if it
  grows past ~50 (S/I), reconsider.
- A typo in `SCHEMA` (wrong keyPath) lands silently on new
  databases and asymptotically corrupts data. Mitigation:
  fake-indexeddb regression test ([test/unit/store-indexeddb-migration.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/store-indexeddb-migration.test.js))
  asserts every (store, index) declared in SCHEMA actually
  appears in a freshly-opened db.

## Rollback

- Reverting commit b03e893a restores the imperative
  `ensureStore` and decrements DB_VERSION. Stored data is not
  affected by the rollback because the descriptor only ADDS
  indexes; removing them is silent.
- The fake-indexeddb dev dependency could be removed alongside
  the test file.

## References

- AGRUN-203 commit: b03e893a
- Implementation: [src/session/store-indexeddb.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-indexeddb.js)
- Tests: [test/unit/store-indexeddb-migration.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/store-indexeddb-migration.test.js)
