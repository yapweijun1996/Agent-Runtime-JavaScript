# Structure Limited Publish Contract - 2026-05-16

## Goal

Align terminal repair's planner-facing contract with the real `workspace_publish_candidate` execution gate for unresolved structure deficits.

## Contract

- Normal budget keeps structure strict: repair with `workspace_write` or `workspace_replace` before terminal publish.
- Low or exhausted budget may publish only an honest limited candidate.
- The limited publish must use `finalReadiness.decision="limited"`, `requirementsAssessment.requirementSatisfied=false`, non-empty `remainingGaps`, and a gap that explicitly names the structure issue such as duplicate headings, duplicate section numbers, section outline, or heading structure.
- The runtime does not repair or write the answer. It only validates observable facts and the AI-owned readiness declaration.

## Implementation Notes

- `terminal-repair-state` now treats structure deficits as publish-blocking unless budget is `low` or `exhausted` and `remainingGaps` names a structure issue.
- Low-budget structure repair exposes publish protocol moves and `workspace_publish_candidate` after the latest candidate has already been finalized and read.
- `workspace_publish_candidate` now asks the same terminal repair validator before allowing a limited publish through a failed structure audit.
- Source, length, TodoState, and workspace-read/finalize checks still run independently after the structure exception.

## Verification

Passed targeted checks:

```bash
node test/unit/terminal-repair-state.test.js
node test/unit/workspace-actions.test.js
node test/unit/action-pattern-convergence.test.js
node test/unit/planner-action-surface.test.js
node test/unit/plan-validation-recovery.test.js
```

Full verification was run after this change:

```bash
npm test
npm run build
npm run dist:check
git diff --check
```

## HBR

- Codeloom MCP timed out on `get_status` after 120 seconds, so local code inspection and tests were used as the source of truth.
- Node still prints existing `MODULE_TYPELESS_PACKAGE_JSON` warnings in targeted unit tests.
