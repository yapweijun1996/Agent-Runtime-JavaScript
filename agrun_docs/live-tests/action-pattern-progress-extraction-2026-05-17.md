# Action Pattern Progress Extraction - 2026-05-17

## Goal

Close the stale planner-action-surface review finding and reduce the
`action-pattern-convergence.js` layering smell without changing runtime
behavior.

## Change

- Verified the current `src/runtime/planner-action-surface.js` no longer
  contains the old dead skill-surface branching helpers
  (`resolveSkillActionSurface`, `isExplicitSkillRequest`,
  `matchesComplexSkillIntent`, `tokenizeIntent`).
- Added `src/runtime/action-pattern-progress.js` as the SSOT for progress
  snapshots, progress diffs, productive/transitional classification, and
  candidate/source/todo/skill/workspace projection.
- Kept `src/runtime/action-pattern-convergence.js` focused on convergence
  state, correction signals, cooldowns, and planner-visible recovery
  orchestration.

## Verification

- `node --check src/runtime/action-pattern-convergence.js`
- `node --check src/runtime/action-pattern-progress.js`
- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/planner-action-surface.test.js`
- `node test/unit/plan-validation-recovery.test.js`
- `npm run build`
- `npm run dist:check`
- `npm test`
- Codeloom `get_status({ repo: "agrun", error_sample: 10 })`:
  `errors_count=0`, `root_path_status=ok`, `auto_reindex_status=ok`.
- Codeloom `find_circular_deps({ repo: "agrun", max_cycle_length: 8 })`:
  `[]`.
- Codeloom `audit_diff` covered the changed runtime files and surfaced
  expected caller edges from action-loop/planner tests. Markdown/task files
  are not code-indexed, so they appear as not-in-index documentation inputs.

## HBR

- No live real-provider run was added because this was a structural
  extraction and all behavior is covered by targeted unit tests plus the
  full suite.
- `npm run build` still prints the existing third-party Rollup/Vite
  warnings (OpenTelemetry `this` rewrite, Zod circular dependency, browser
  chunk size warning). These are unchanged by this refactor.
