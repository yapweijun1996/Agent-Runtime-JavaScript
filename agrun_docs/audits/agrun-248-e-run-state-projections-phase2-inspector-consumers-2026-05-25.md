# AGRUN-248-E Phase 2 Inspector Consumers Audit — 2026-05-25

## Status

DONE with HBR.

## Project Goal

Move Browser Inspector and Long Task Lab read-only runtime snapshots off direct
subsystem reads so host debug surfaces consume cloned RunState projections
instead of depending on the live mutable runtime shape.

## Implementation

- Added `projectInspectorRunState()` to
  `src/runtime/run-state-projections.js`.
- The Inspector projection composes kernel, approval, research, workspace,
  Todo, and metrics projections once per host debug/update path, then clones
  only additional Inspector-facing observability fields.
- Extended `projectResearchRunState()` with `researchFinalizeContract` because
  Browser Debug and Long Task Lab summaries rely on that AI-authored readiness
  contract.
- Hardened metrics projection against malformed `costLedger` snapshots so a
  partial debug payload cannot crash Inspector projection.
- Migrated Browser Debug snapshot construction, source extraction, web-search
  activity mapping, approval activity mapping, streaming Todo projection, and
  final-text normalization to use projection helpers.
- Migrated Long Task Lab runtime step/result summarization to project the
  incoming runtime snapshot once before evidence/workspace/quality/debug
  summaries read it.
- Updated Browser search backend smoke coverage to reflect the current
  production default: no private SearXNG endpoint is bundled; tests that need
  SearXNG now pass an explicit test endpoint.
- Added clone-isolation coverage for `projectInspectorRunState()` and
  malformed-cost-ledger coverage for `projectMetricsRunState()`.

## Verification

- `node --check src/runtime/run-state-projections.js`
- `node --check test/unit/run-state-projections.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm run test:long-task-lab`
- `npm run build`
- `npm test`
- `npm run dist:check`
- `git diff --check`
- `node -e "const fs=require('fs'); const lines=fs.readFileSync('task.jsonl','utf8').trim().split(/\n/); for (let i=0;i<lines.length;i++) JSON.parse(lines[i]); console.log('task.jsonl ok', lines.length);"`

All listed checks passed. Build warnings were the existing Rollup
OpenTelemetry `this` rewrite, Zod circular dependency, and Browser example
chunk-size warning.

## HBR

This completes the known AGRUN-248-E Phase 2 read-only projection consumers for
session, terminal, Browser Inspector, and Long Task Lab surfaces. Runtime
action executors and terminal contract helpers still use live `runState` where
they intentionally mutate harness state. AGRUN-248-C still has the known
token-delta gap: provider/finalizer token stream events are not fully wired
into `eventLedger`.

## Harness Logic

Inspector surfaces now read a cloned projection of runtime facts. The runtime
does not judge answer quality or rewrite user-facing output; it exposes
observable state so AI and engineers can inspect the same harness facts without
binding UI/debug code to mutable subsystem internals.
