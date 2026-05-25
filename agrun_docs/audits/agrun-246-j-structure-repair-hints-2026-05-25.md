# AGRUN-246-J Structure Repair Hints - 2026-05-25

## Scope

Follow-up quality slice after the ordered pending journey completed with HBR.
The current-head Mandarin run passed length and source gates, but final
structure still failed with duplicate section numbers after 21
`workspace_propose_patch` calls and only 2 `workspace_apply_patch` calls.

Input evidence:

- `agrun_docs/live-tests/agrun-246-j-current-head-rerun-2026-05-25.md`
- local debug artifact `agrun_debug_runs/2026-05-24T18-25-09-526Z-report.md`

## Finding

The structure audit was exposing weak repair hints for dotted section numbers.
The final report had two `3.4` headings:

```text
line 84: ## 3.4 强制模式校验 (Schema-driven Enforcement)
line 90: ### 3.4. 观察-推理-行动 (OODA) 循环的显式实现
```

Before this slice, the parser normalized dotted headings through the generic
heading normalizer, so `3.4` became `34`. The generated
`section_number_repair_context` could also emit unhelpful `candidateNumber 10`
style hints. That is not enough for weak models to produce one valid
`normalize_headings` patch.

## Implemented Harness Change

Changed `src/runtime/virtual-workspace.js` so workspace structure diagnostics:

- parse full dotted section numbers from raw Markdown heading text before
  punctuation stripping
- keep duplicate section samples as `3.4`, not `34`
- provide a bounded next available `candidateNumber` for later duplicate
  occurrences, such as `3.6` when `3.5` is already occupied
- preserve AI ownership: runtime still does not rewrite or renumber report
  headings by itself

The intended prompt surface now looks like:

```text
duplicate_section_number_samples=3.4 x2
section_number_repair_context=... lineNumber 90 currentNumber 3.4 candidateNumber 3.6 raw "3.4. 观察-推理-行动 ..."
```

This makes `workspace_propose_patch` with `normalize_headings` easier to form
without hardcoding any report content.

## Verification

Focused checks:

```bash
node --check src/runtime/virtual-workspace.js
node --check test/unit/workspace-actions.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/virtual-workspace.test.js
node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/workspace-actions.test.js
```

Additional local replay against the failed final report proved:

- `inspectWorkspaceCandidateStructure()` now reports duplicate number `3.4`
- repair hints include line 90 `candidateNumber: "3.6"`
- a `normalize_headings` preview changing line 90 to `3.6` is
  `preview_ready`, `valid=true`, and moves `structureAfter.ok` to `true`

## HBR

This is a diagnostic-quality fix, not proof that the next real Gemini
flash-lite AGRUN-246-J run will pass. A fresh live rerun is still required to
measure whether better section-number hints reduce propose/apply churn and
improve final structure quality.
