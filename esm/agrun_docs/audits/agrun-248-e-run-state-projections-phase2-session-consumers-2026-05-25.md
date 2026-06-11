# AGRUN-248-E Phase 2 Session Consumers Audit — 2026-05-25

## Status

DONE with HBR.

## Project Goal

Use the RunState projection boundary for read-only session consumers so host
session persistence and auto-memory provenance stop reaching directly into
global mutable subsystem objects.

## Implementation

- Extended `projectResearchRunState()` to include a cloned `researchContext`.
- Extended `projectTodoRunState()` to include a cloned raw `todoState`, while
  keeping the existing `todoTask` lifecycle projection.
- Migrated session auto-extraction provenance in `src/session/handle-turn.js`
  to read research sources through `projectResearchRunState()`.
- Migrated active thread persistence in `src/session/handle.js` to read
  `todoState` and `researchContext` through projection helpers before writing
  back to the durable thread record.
- Added clone-isolation assertions for projected `researchContext` and
  `todoState` in `test/unit/run-state-projections.test.js`.

## Verification

- `node --check src/runtime/run-state-projections.js`
- `node --check src/session/handle-turn.js`
- `node --check src/session/handle.js`
- `node --check test/unit/run-state-projections.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/todo-state-thread-persistence.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/memory-provenance.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/thread-hydration.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/concerns/session.test.js`
- `npm run build`
- `npm test`
- `npm run dist:check`
- `git diff --check`
- `task.jsonl` parse

All listed checks passed. `npm run build` emitted only the existing
Rollup/OpenTelemetry `this` rewrite warnings, Zod circular dependency warning,
and Vite browser chunk-size warning. `npm run dist:check` passed with 271
markdown files, and `task.jsonl` parsed with 141 entries.

## HBR

This slice only migrates read-only session consumers. Runtime action executors
still directly read/write `runState.todoState`, `runState.researchContext`, and
`runState.virtualWorkspace` where mutation is the active behavior. Terminal
finalization and Inspector-facing projections still have additional read-only
direct reads that can be migrated in a later Phase 2 slice after checking clone
cost and finalization behavior.

## Harness Logic

The helper boundary is used only where the consumer needs an isolated snapshot.
Mutation paths stay on the live subsystem state, so the harness remains
AI-first and stateful without turning projections into a second source of
truth.
