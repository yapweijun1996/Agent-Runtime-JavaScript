# AGRUN-538 Long Report SLO Repair Live Review

Date: 2026-06-17

## Result

The general agent runtime is not production-ready yet for the complex long-report benchmark.

The simple deterministic test suite and build pass, and the runtime now exposes stronger structure facts, but both real-key Gemini low-thinking live reruns still failed the production SLO and quality gate.

Important: the final cross-level semantic-duplicate detection and stricter unread-citation blocking were added after the second live rerun. They are covered by deterministic tests, but they have not yet been verified by a third real-key live rerun.

## What Changed

- Added `todo_sync_not_sufficient` action-ordering signal so TodoState sync is not treated as a product repair when source/length/structure/readiness deficits remain.
- Added `sectionPurposeSignal` to `workspaceRepairSignal` so the planner sees near-duplicate section purpose before expanding length.
- Upgraded `inspectWorkspaceCandidateStructure` to detect:
  - semantic duplicate headings across `##` and `###`
  - body sections after a final Conclusion/Summary section
  - semantic duplicate contexts with line numbers
- Projected semantic duplicate and body-after-final contexts into the workspace prompt.
- Tightened the live citation contract so `unread_cited_url` and `blocked_source_cited` are blocking in `test/node-agrun-3000-live.mjs`.

## Live Runs

| Run | Duration | Provider calls | Tokens | Tool time | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Before AGRUN-538 | 154.9s | 28 | 450,239 | n/a | Failed: semantic duplicate sections |
| AGRUN-538 first rerun | 142.6s | 35 | 549,395 | 5.2s | Failed: semantic duplicates after Conclusion |
| AGRUN-538 second rerun | 150.3s | 32 | 510,269 | 9.0s | Failed: semantic duplicate section + citation issue |

Artifacts:

- `agrun_debug_runs/2026-06-17T04-24-04-560Z.*`
- `agrun_debug_runs/2026-06-17T04-35-30-724Z.*`

## Step Timing Finding

The runtime tools are not the slow part.

| Step group | Observed time |
| --- | ---: |
| `read_url` total in second rerun | 7.469s |
| `web_search` in second rerun | 1.426s |
| workspace/todo actions | mostly 1-15ms each |
| full run duration | 150.253s |

Root cause is planner/provider loop churn: repeated repair/review/publish cycles grow prompt size and token count.

## Root Cause

1. The model still repairs semantic duplicate content by renaming headings instead of merging/removing duplicate section blocks.
2. TodoState sync still appears after partial repair. It is better than the first failed run, but it still spends extra provider turns.
3. `workspace_review_candidate` can repeat after the candidate is already reviewed, adding calls without content progress.
4. Citation contract was too soft during live: one cited URL could be unread while the model still attempted `ready`.

## Production Verdict

Not ready for production complex-skill use under this benchmark.

Simple chat/runtime direct-answer behavior is ready from AGRUN-531, but the general runtime still needs AGRUN-539 before complex agent skills can be called production-ready.

## Verification

Passed:

- `node test/unit/virtual-workspace.test.js`
- `node test/unit/terminal-repair-workspace-repair-signal.test.js`
- `node test/unit/candidate-quality-signal.test.js`
- `npm run build`
- `npm test`

Failed live acceptance:

- `NODE_AGRUN_LIVE_PERFORMANCE_SLO=1 ... npm run test:live:node-3000`

Not yet rerun live after final deterministic hardening:

- cross-level `##`/`###` semantic duplicate detection
- blocking `unread_cited_url` and `blocked_source_cited` as live acceptance failures

## Next Required Fix

AGRUN-539 should be a general runtime convergence fix, with the long-report task kept as the acceptance benchmark. It should focus on:

- blocking repeated `workspace_review_candidate` when latest review is fresh and no candidate content changed
- making semantic duplicate repair prefer content-block removal/merge over heading normalization
- reducing prompt/loop tokens during terminal repair
- rerunning the same live test until SLO and quality gates pass
