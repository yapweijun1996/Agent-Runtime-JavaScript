# Planner Long-Research Fallback Guard - 2026-05-17

## Goal

Close the remaining envelope-mode path where planner repair failure could still produce a runtime-authored `web_search` in long-research mode.

## Change

- `src/runtime/planner.js` now checks `isResearchQualityGateRequired(runState, { prompt })` before the repair-failed `shouldFallbackToWebSearch` branch.
- Non-long-research fallback behavior is unchanged.
- `test/concerns/research-flows.test.js` adds a regression that activates `researchActivation = "long_research"` during invalid planner output handling, lets envelope repair fail, and verifies the runtime does not emit `planner-fallback-applied` or a first-cycle `web_search` decision.

## Verification

- `npm run build` passed.
- `node test/concerns/research-flows.test.js` passed.
- `npm run dist:check` passed with 176 markdown files.
- `npm test` passed.
- Codeloom `find_circular_deps({ repo: "agrun", max_cycle_length: 8 })` returned `[]`.
- Codeloom final `get_status({ repo: "agrun" })` returned `errors_count=0`, `root_path_status=ok`, and `auto_reindex_status=ok`.

## Codeloom Cleanup

Updated `.codeloomignore` to exclude generated bundles (`dist/`, `examples/browser/dist/`) and two known Codeloom 0.2.1 parser-limitation files:

- `examples/browser/src/index.css` uses Tailwind v4 directives that build correctly but create tree-sitter CSS ERROR nodes.
- `examples/browser/src/components/PrivacySettingsPanel.tsx` is valid TSX and builds correctly, but Codeloom 0.2.1 repeatedly reported tree-sitter ERROR nodes.

## HBR

`index_repo` reported `filesWithSyntaxErrors=0`, but `get_status` still showed historical parse errors until the stale local Codeloom repo row was deleted and rebuilt. The final rebuilt graph has 0 parse errors.
