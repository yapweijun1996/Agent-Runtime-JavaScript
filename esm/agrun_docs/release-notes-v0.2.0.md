# v0.2.0 Release Notes

Final tag. Promotes [v0.2.0-rc.2](./release-notes-v0.2.0-rc.2.md) after host integrator smoke-test confirmed all gates pass.

## Summary

Ships the global memory policy work in two layers:

1. **Host hook mechanism.** `sensitivityFilter` and `promotionValidator` hooks with frozen contract (fail-closed, 2s default timeout, short-circuit ordering, hook context carrying `sessionId` / `sessionStore` / `kind` / `category` / `slot` / `source` / `sourceTurn`). Hosts own the policy; the runtime owns the mechanism.
2. **Domain-neutral extractor.** Prompt rewritten with continuous confidence rubric, hard-rejection rules for transient intents / time-scoped results / negative searches / speculative restatements / data dumps / business identifiers (including when wrapped in natural-language prose), and `sourceTurn` grounding requirement. Calibrated against 14 representative tenant identifier conventions — no tenant-specific regex.

See the per-RC notes for the full delta:

- [rc.1](./release-notes-v0.2.0-rc.1.md) — hooks, multi-tenant docs, extractor tightening v1.
- [rc.2](./release-notes-v0.2.0-rc.2.md) — identifier-in-prose rejection, confidence ceiling.

## What's in 0.2.0 that wasn't in 0.1.x

- `createRuntime({ globalMemory })` options block.
- `sessionStore.updateGlobalMemory(id, patch)`.
- `onStep` step types `global-memory-recalled` / `-written` / `-filtered` / `-purged`.
- Host hooks: `sensitivityFilter`, `promotionValidator`.
- Extractor prompt rewritten for cross-session-durability scope.
- `agrun_docs/spec.md` design principle #6 "Stay Domain-neutral."
- `agrun_docs/runtime-state-and-memory-architecture.md` design principle #7 "Domain-neutral Memory Policy."
- `README.md` "Multi-tenant Deployment Pattern."
- `agrun_docs/public-runtime-api.md` "Global Memory Configuration."
- `test/corpus/` redacted regression samples from host integrator.

## Smoke-Test Gates (host integrator, rc.2)

| Gate | Result |
|------|--------|
| Transient intent rejection | ✓ |
| Tabular data dump rejection | ✓ |
| Identifier-wrapped leak rejection | ✓ |
| Tenant record rejection | ✓ |
| Legitimate preference capture | ✓ |
| Confidence self-grading varies (not uniformly 1.0) | ✓ |
| Host hook layer idle when extractor clean | ✓ |
| Per-user IndexedDB scoping | ✓ |

## Migration

No breaking changes. All new capability is opt-in.

Multi-tenant hosts that were using the default IndexedDB database should adopt the `dbName: \`agrun-${userId}\`` pattern at their earliest convenience. Legacy default-db entries are not migrated forward — recommend "start fresh" at first login under the new scheme. See README "Multi-tenant Deployment Pattern" for details.

Custom `sessionStore` implementations must add `updateGlobalMemory(id, patch)`; `createSessionStore` validation will throw if the method is missing.

## Deferred

- Automated regression tests against `test/corpus/` (manual labeling only for now).
- TTL / decay with `lastAccessedAt`. LRU cap continues to bound growth.
- Embedding-based recall. Merge-all with slot dedup remains the recall strategy.
- Short-preference confidence ceiling (carry-over observation, minor). Revisit after more data points.
