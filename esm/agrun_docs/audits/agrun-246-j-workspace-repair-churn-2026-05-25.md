# AGRUN-246-J Workspace Repair Churn 2026-05-25

## Scope

Follow-up to the canonical Mandarin source+structure closeout. Final live run
`2026-05-24T23-59-12-542Z` passed all strict quality gates, but HBR remained on
workspace repair churn:

- `workspace_propose_patch`: 9 planner decisions.
- `workspace_apply_patch`: 4 planner decisions.
- `workspace_insert_after_section`: 7 planner decisions in the action timeline.
- Total planner decisions: 41.

The issue is not answer correctness. It is loop cost: heading-only structure
repairs require one cycle to preview and a second cycle to apply even when the
patch is already fully AI-authored and runtime validation says it is safe.

## Change

`workspace_propose_patch` now accepts optional `applyIfValid:true`.

Safety boundary:

- Auto-apply is allowed only when every operation is `normalize_headings`.
- The patch must pass the same existing preview validation.
- Content-bearing operations such as `append`, `insert_after_section`, and
  `replace` are not auto-applied.
- If the preview has blocking `riskFlags`, it remains blocked and is not
  applied.

This keeps AI ownership intact: the AI still authors exact heading line changes;
runtime only validates and applies the already-authored patch.

## Expected Churn Impact

The live closeout trace used repeated heading normalization pairs:

```text
workspace_propose_patch -> workspace_apply_patch
workspace_propose_patch -> workspace_apply_patch
workspace_propose_patch -> workspace_apply_patch
workspace_propose_patch -> workspace_apply_patch
```

With `applyIfValid:true`, a valid heading-only normalization can complete in one
action instead of two. The expected effect is fewer patch-apply cycles in future
structure-repair traces. This slice does not claim a measured live cycle
reduction because no new live rerun was performed.

## Verification

- `node --check src/runtime/actions/virtual-workspace-actions.js`
- `node --check src/runtime/action-loop-action.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/workspace-actions.test.js`

Focused regression proves:

- Heading-only `normalize_headings` with `applyIfValid:true` returns
  `status=applied`, increments the file version, clears pending patch, and
  fixes structure.
- Non-heading patch operations with `applyIfValid:true` are not auto-applied;
  they remain a normal preview.

## Skill Reflection

Classification: project-local agrun workflow knowledge, not a new global Codex
skill. Existing project skills that teach long-report structure repair were
updated to prefer `applyIfValid:true` for heading-only `normalize_headings`
repairs and to call `workspace_apply_patch` only when a valid preview was not
already applied.

## HBR

This is a harness-side cycle reducer, not a full performance proof. It is unit
verified but not yet live-rerun against the canonical Mandarin prompt. The next
live run should compare `workspace_propose_patch`, `workspace_apply_patch`, and
total planner-decision counts against `2026-05-24T23-59-12-542Z`.
