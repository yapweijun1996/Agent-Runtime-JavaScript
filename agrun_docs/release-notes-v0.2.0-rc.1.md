# v0.2.0-rc.1 Release Notes

RC tag for the global memory policy work. No breaking changes to existing public APIs — all new capability is opt-in.

## New Public API

### `createRuntime({ globalMemory })` options

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `minConfidence` | number `0..1` | `0.7` | Floor for auto-promotion into global memory. |
| `maxEntries` | integer > 0 | `100` | LRU cap per sessionStore database. |
| `hookTimeoutMs` | integer > 0 | `2000` | Per-hook fail-closed timeout. |
| `sensitivityFilter` | `(entry, ctx) => bool \| Promise<bool>` | `null` | Host blocks on `true`. |
| `promotionValidator` | `(entry, ctx) => bool \| Promise<bool>` | `null` | Host allows on `true`; anything else blocks. |

Both hooks fail closed: throw / reject / timeout → entry is not promoted.

### Hook context

```js
{
  sessionId,
  sessionStore,
  kind,                 // fact | preference | decision
  category,             // learned_fact | user_preference | project_context
  slot,
  source,
  sourceTurn: { user, assistant }
}
```

`userId` is intentionally not in the context. Scope per-user via IndexedDB `dbName` (see README "Multi-tenant Deployment Pattern"). Hosts that need `userId` inside the hook should close over it at hook construction.

### `sessionStore` additions

- `updateGlobalMemory(id, patch)` — partial update by id. Returns the updated entry or `null` if not found.

### Telemetry (`onStep` step types)

| `type` | `detail` |
|--------|----------|
| `global-memory-recalled` | `{ count }` |
| `global-memory-written` | `{ id, category, slot, confidence, reason }` |
| `global-memory-filtered` | `{ category, slot, hook, reason, message }` |
| `global-memory-purged` | `{ id, reason }` |

## Extractor Behavior Changes

The semantic-memory extractor prompt (`src/runtime/semantic-memory.js`) has been tightened. Expected observable differences:

- `confidence` is no longer uniformly `1.0`. The prompt now demands continuous self-grading with explicit anti-ceiling guidance. Entries with weak inference (confidence < 0.55 by the new rubric) are dropped rather than emitted.
- Transient intents, time-scoped results ("no X for April 2026"), negative-search results ("item not found"), speculative restatements, and tabular data dumps are rejected at extraction time rather than promoted as `learned_fact`.
- Business-identifier-shaped values (document numbers, order codes, lot numbers, UUIDs, opaque short codes) are rejected generically — no tenant-specific regex, only surface properties.
- Entries whose specifics do not appear in the user or assistant text (`sourceTurn`) are dropped, giving generic grounding against hallucinated identifiers.

Hosts that were relying on high-volume low-precision extraction will see fewer entries promoted. This is intentional.

## Documentation

- `README.md`: "Multi-tenant Deployment Pattern" — scope per-user via `dbName`.
- `agrun_docs/spec.md`: Design principle #6, "Stay Domain-neutral."
- `agrun_docs/runtime-state-and-memory-architecture.md`: Design principle #7, "Domain-neutral Memory Policy."
- `agrun_docs/public-runtime-api.md`: "Global Memory Configuration" — options, hooks, polarity, error contract, telemetry, management API.

## Regression Corpus

- `test/corpus/global-memory-extractor-regression.jsonl` — 5 redacted Globe3 sample entries with labels.
- `test/corpus/tenant-format-examples.md` — 14 representative tenant identifier conventions.

Used for manual calibration. Not consumed at runtime or by automated tests yet.

## Migration

None required. Existing apps:

- `globalMemory` config block is new and optional.
- Hooks default to `null`, preserving prior behavior.
- `updateGlobalMemory` is additive on `sessionStore`. Custom store implementations must add this method (throws at `createSessionStore` validation if missing).
- Multi-tenant hosts should adopt the `dbName: \`agrun-${userId}\`` pattern at their earliest convenience. Default db entries are not migrated automatically; recommend "start fresh" at first login under the new scheme.

## Known Gaps Deferred Past RC

- Extractor regression tests are not yet automated against the corpus. Manual sampling only.
- TTL / decay (`lastAccessedAt`, `globalMemoryTtlDays`) is not implemented. LRU cap continues to bound growth.
- No embedding-based recall. Merge-all with slot dedup remains the recall strategy.
