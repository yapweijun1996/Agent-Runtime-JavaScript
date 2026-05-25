# AGRUN-248-E Phase 2 Terminal Consumers Audit — 2026-05-25

## Status

DONE with HBR.

## Project Goal

Move terminal final-text/source projection code off direct subsystem reads so
terminal output normalization consumes a RunState projection rather than the
global mutable state shape.

## Implementation

- Added `projectTerminalRunState()` to `src/runtime/run-state-projections.js`.
- The terminal projection composes cloned research, workspace, and Todo
  projections once per terminal normalization path to avoid repeated deep
  clone work.
- Migrated `src/runtime/result.js` final output normalization/source
  collection to consume `projectTerminalRunState()`.
- Migrated `src/runtime/action-loop-terminal.js` final-text normalization,
  source collection, scoped evidence fallback, research-loop source
  suppression, and Todo terminal-observation telemetry to use projection
  helpers.
- Removed unused direct `researchContext` pass-throughs into
  `createEvaluationState()` from terminal paths.
- Added clone-isolation coverage for `projectTerminalRunState()` in
  `test/unit/run-state-projections.test.js`.

## Verification

- `node --check src/runtime/run-state-projections.js`
- `node --check src/runtime/result.js`
- `node --check src/runtime/action-loop-terminal.js`
- `node --check test/unit/run-state-projections.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/action-loop-session-terminals.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/concerns/approval-finalize.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/concerns/push-mode-invariants.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/concerns/native-tools.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/concerns/research-flows.test.js`
- `npm run build`
- `npm test`

All listed checks passed before final dist/task gates.

## HBR

This slice migrates terminal read-only final-text/source consumers only.
`applyTerminalFinalContract()`, claim coverage, and Todo terminal observation
still receive the live `runState` where they intentionally append audits or
update terminal synchronization state. Inspector-facing browser/Long Task Lab
projection code still has direct runtime snapshot reads and remains the next
AGRUN-248-E Phase 2 target.

## Harness Logic

The terminal projection gives output normalization a stable read model while
preserving live writes for explicit harness side effects. AI still owns final
readiness and answer content; runtime only projects state facts and verifies
protocol consistency.
