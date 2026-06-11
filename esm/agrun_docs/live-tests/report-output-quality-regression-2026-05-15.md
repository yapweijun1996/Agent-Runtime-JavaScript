# Report Output Quality Regression - 2026-05-15

## Goal

Verify that the 3000-word harness report flow is not accepted purely because
source/length readiness appears correct. The final answer must also be a clean
user-facing report, not duplicated append fragments or a raw-prompt title.

## Findings

- A previous Chrome MCP live result reached length/source-style checks but the
  published report was messy: duplicated numbered sections, repeated conclusion
  blocks, and a title that copied the raw user request.
- First rerun after adding structure checks exposed a separate contract gap:
  `workspace_publish_candidate` accepted an AI-provided clean `ready` on a
  246-word candidate because the long-research gate was not active.
- Second rerun exposed a no-progress loop: the AI repeatedly called
  `workspace_read` after publish was blocked, and read operations were being
  counted as observable workspace progress.
- Third rerun improved that path but still spent cycles on
  `workspace_replace` / `workspace_read` under length deficit.
- Follow-up fixed the direct `planner_finalize` escape for explicit long-form
  requests, but later reruns still failed by maxSteps after repeated publish
  blocks and workspace edits while source minimum stayed short.

## Changes Shipped

- Added objective final-candidate structure audit:
  - raw prompt copied into title
  - duplicate Markdown headings
  - duplicate section numbers
  - repeated conclusion headings
- Projected `final_candidate_structure` in the virtual workspace prompt block.
- Blocked research workspace publish when the selected candidate has structural
  issues.
- Audited any AI-provided `finalReadiness`, even when the long-research gate is
  not active, so short candidates cannot declare clean `ready`.
- Stopped treating read-only workspace operation count and generic tool history
  growth as action-pattern progress.
- Added action-pattern preflight blocks for repeated same action+args and
  workspace read/replace loops under an unresolved length deficit.
- Updated the 3000-word live smoke to assert `finalCandidateStructureOk=true`.
- Added explicit long-form workspace publish path activation: if the user asks
  for a long-form answer such as `3000 words` and workspace publishing is
  available, direct `planner_finalize` now returns
  `workspace_publish_path_required` even before a draft/candidate exists.
- Made `workspace_publish_candidate.finalReadiness` required in the planner
  tool schema and added nested `requirementsAssessment` shape guidance.
- Added source-deficit workspace cooldowns so, after a publish block, if the
  candidate already satisfies requested length and source minimum is still
  short, workspace edits/read loops are blocked in favor of
  `web_search`/`read_url` or valid limited publish.
- Added a compact `requiredArgsExample` for valid limited publish to terminal
  correction and source-deficit preflight observations.

## Verification

- `node test/unit/virtual-workspace.test.js` passed.
- `node test/unit/workspace-actions.test.js` passed.
- `node test/unit/action-pattern-convergence.test.js` passed.
- `node test/unit/action-loop-session-terminals.test.js` passed.
- `npm test` passed.
- `npm run build` passed with existing Rollup/Vite warnings.
- `npm run dist:check` passed.

Follow-up targeted verification after the direct-finalize fix:

- `node --check src/runtime/research-finalize-contract.js` passed.
- `node --check src/runtime/actions/virtual-workspace-actions.js` passed.
- `node --check src/runtime/action-loop-action.js` passed.
- `node test/unit/action-loop-session-terminals.test.js` passed.
- `node test/unit/workspace-actions.test.js` passed.
- `node test/unit/action-pattern-convergence.test.js` passed.
- `node test/unit/read-url-action.test.js` passed.
- `node test/unit/virtual-workspace.test.js` passed.
- `node test/concerns/planner.test.js` passed after updating its stale
  workspace-publish mock to use honest limited readiness when no read_url
  source evidence exists.
- `npm test` passed before the final source-deficit cooldown additions.
- `npm run build` passed after the final source-deficit cooldown additions.

## Honest Bad Result

`node examples/browser/test/read-url-live-smoke.mjs --mode long-report` still
does not pass consistently. The direct `planner_finalize` escape is fixed, but
recent live attempts still fail by maxSteps. Observed failures:

- Run with `candidateWords=3049`, `read_url ok 200`, `sourceMinimumPassed=false`,
  no terminalized output. AI kept editing after publish blocks instead of
  choosing evidence recovery or valid limited.
- Run with `candidateWords=3212`, only one successful source, terminal
  correction/cooldown active, but the model repeated plain
  `workspace_publish_candidate` until maxSteps.
- Latest run ended around `candidateWords=2069`, two sources, source minimum
  still false, multiple publish attempts, and no terminalized output.

The next fix should make valid limited correction a first-class planner action
contract when terminal cooldown/source deficit is active. Current observations
include valid-limited examples, but the weak model can still ignore them.
