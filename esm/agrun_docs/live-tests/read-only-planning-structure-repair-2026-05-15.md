# Read-Only Planning + Structure Repair Live QA — 2026-05-15

## Goal

Verify the Node real API 3000-word harness report flow after strengthening long-form convergence:

- Sticky `actionPatternConvergence.readOnlyPlanningState` for repeated read-only/planning actions without productive source/workspace progress.
- `workspace_list` classified as read-only planning.
- `terminalRepairState` activates when a finalized candidate has structure audit failure, before a publish attempt.
- Structure deficits expose duplicate heading and section-number samples.
- Terminal repair no longer allows `todo_plan`; it should sync TodoState with `todo_advance`, `todo_run_next`, or `todo_cancel`.

## Verification

Passed deterministic checks:

```bash
node test/unit/action-pattern-convergence.test.js
node test/unit/planner-action-surface.test.js
node test/unit/terminal-repair-state.test.js
node test/unit/virtual-workspace.test.js
npm test
npm run build
npm run dist:check
```

Build warnings were existing Rollup/OpenTelemetry `this` rewrite warnings and Vite chunk-size warnings.

## Node Real API Result

Command:

```bash
NODE_AGRUN_LIVE_MAX_STEPS=85 npm run test:live:node-3000
```

Observed:

- Candidate reached `3354` words.
- Source minimum passed: `readSources=3/3`, `relevantSources=2/2`.
- Meaningful workspace expansion occurred.
- No consecutive publish loop: max consecutive `workspace_publish_candidate` was `1`.
- Runtime ended by `max_steps_continuation`, so the live test failed.
- `terminalRepairState` was active at the end:
  - `activeDeficits=["structure","todo"]`
  - `reason="finalized_candidate_structure_not_ready"`
  - `ignoredCount=2`
- Structure audit still failed:
  - `duplicate_headings`
  - `duplicate_section_numbers`

## HBR

The latest live failure is better classified than before, but not solved end-to-end. The harness now correctly says: source and length are fine, but the final candidate is not production-ready because structure and TodoState are still unresolved.

The remaining model behavior problem is repeated broad workspace repair (`workspace_write` / `workspace_replace` / `workspace_read`) without changing the structure audit outcome enough before maxSteps.

## Next Fix

Add a structure-specific repair convergence contract:

- Track `finalCandidateStructure.issueCodes`, duplicate heading samples, duplicate number samples, and whether those samples changed after each workspace mutation.
- If structure samples do not change after repeated workspace writes/replaces, activate a `structureRepairConvergence` signal.
- During that signal, forbid broad append/write loops and require a targeted full-outline rewrite or targeted section-number/heading normalization.
- Keep runtime AI-first: do not write report text; only expose objective structure audit deltas and restrict no-progress repair patterns.
