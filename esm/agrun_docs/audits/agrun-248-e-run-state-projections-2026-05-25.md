# AGRUN-248-E — RunState Kernel + Subsystem Projections

Date: 2026-05-25
Status: Phase 1 DONE

## PG

`createRunState()` and `createLastRunSummary()` had accumulated identity,
terminal, research, workspace, Todo, approval, and metrics fields in one
global mutable object. AGRUN-248-E starts splitting the contract without
changing public runtime behavior.

This slice is intentionally conservative:
- Define a small `RunKernelState` for identity/status/cycle/phase/terminal
  fields.
- Add read-only subsystem projection helpers.
- Preserve the existing `createRunState()`, `snapshotRunState()`, and
  `createLastRunSummary()` public shapes.

## Implementation

New module:
- `src/runtime/run-state-projections.js`

New helper boundaries:
- `createRunKernelState(runId, maxSteps)`
- `projectRunKernelState(runState)`
- `projectApprovalRunState(runState)`
- `projectResearchRunState(runState)`
- `projectWorkspaceRunState(runState)`
- `projectTodoRunState(runState)`
- `projectMetricsRunState(runState)`

`src/runtime/state.js` now uses:
- `createRunKernelState()` while constructing the live run state.
- `project*State()` helpers while building `createLastRunSummary()`.
- `projectMetricsRunState().costLedger` while snapshotting the cost ledger.

## Boundary Rules

- Kernel state contains identity/status/cycle/phase/terminal fields only.
- Subsystem projections deep-clone their public projection values.
- Research projection does not expose workspace state.
- Workspace projection does not expose research state.
- Todo projection exposes the existing host-facing task lifecycle, not mutable
  TodoState internals.
- Metrics projection stays observational; it does not affect planner decisions
  or runtime control flow.

## Verification

Focused:

```bash
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/runtime-event-ledger.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/runtime-events.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/concerns/runtime-basic.test.js
npm run build
npm test
npm run dist:check
git diff --check
node -e "const fs=require('fs'); const lines=fs.readFileSync('task.jsonl','utf8').trim().split(/\n/); lines.forEach((line)=>JSON.parse(line)); console.log('task.jsonl entries', lines.length);"
```

`test/unit/run-state-projections.test.js` verifies:
- kernel field list and subsystem absence;
- projection clone isolation;
- research/workspace separation;
- Todo task lifecycle projection;
- summary compatibility through helpers;
- snapshot still strips the live `eventLedger` object.

## HBR

This is Phase 1 of AGRUN-248-E. It creates the helper boundary and tests it,
but it does not yet migrate every runtime subsystem read site to the helpers.
That deeper migration should be done only after this compatibility layer stays
green under full test/build verification.

## Harness

Harness: this slice exposes clearer state boundaries and projections. Runtime
still does not judge answer quality, select content, select sources, or author
planner decisions.
