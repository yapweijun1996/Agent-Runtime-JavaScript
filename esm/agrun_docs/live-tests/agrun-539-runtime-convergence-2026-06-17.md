# AGRUN-539 Runtime Convergence Live Review

Date: 2026-06-17

## Result

AGRUN-539 improved the general runtime convergence controls, but the complex-skill benchmark is still not production-ready.

The runtime now avoids some useless review and shrink-write loops, and one live run passed the performance SLO. However, no live run passed the full acceptance gate because the final report still failed structure/source or length/source quality checks.

## What Changed

- Added fresh same-version `workspace_review_candidate` detection.
- Hid fresh candidate review from the planner action surface outside active terminal repair.
- Exposed candidate review freshness in the virtual workspace prompt.
- For semantic duplicate/body-after-final structure repair, made terminal repair prefer content rewrite actions over heading-only patch repair.
- Updated workspace repair recommended action order so `workspace_replace` / `workspace_write` appear before patch for content-level structure repair.
- Counted repeated `destructive_shrink_blocked` `workspace_write` results as workspace mutation growth stalls.
- Prevented hard-veto `decision=limited` publish while budget is still `enough` and a length deficit remains.

## Live Runs

All runs used real `.env.local` keys, `gemini-3.1-flash-lite`, `GEMINI_THINKING_LEVEL=low`, `NODE_AGRUN_LIVE_PERFORMANCE_SLO=1`, and the same 1500-word Loop Engineering / Harness Engineering benchmark.

| Run | Main change under test | Duration | Provider calls | Tokens | Tool/action time | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `2026-06-17T05-15-57-142Z` | fresh-review gate | 162.4s | 26 | 425,918 | 2.2s | Failed: structure/source, 1370 words |
| `2026-06-17T05-21-41-340Z` | blocked-preview rewrite surface | 152.2s | 34 | 550,275 | 3.4s | Failed: structure/source |
| `2026-06-17T05-28-56-055Z` | semantic full-rewrite preference | 412.3s | 70 | 1,356,753 | 14.3s | Failed: write/read shrink loop, max steps |
| `2026-06-17T05-38-40-016Z` | shrink-block convergence | 89.2s | 19 | 295,461 | 9.3s | Performance SLO passed, quality failed: 630 words/source |
| `2026-06-17T05-42-37-453Z` | no early limited publish while budget enough | 186.9s | 34 | 539,112 | ~7.2s read_url + small workspace actions | Failed: structure/source, patch churn |

## Root Cause

The slow part is still not the tools. `web_search`, `read_url`, and workspace actions usually consume seconds or milliseconds. The expensive part is repeated provider planning turns with growing prompt payloads.

The remaining root cause is content-level structure repair. The model repeatedly uses `normalize_headings` to rename duplicate sections, but semantic duplicate content and body-after-conclusion issues require block-level merge/removal. Renaming headings makes the document look different while the duplicated content purpose remains.

## Production Verdict

Not ready for production complex-skill use.

The simple 5-turn chat monitor remains production-ready from AGRUN-531. The complex long-report benchmark still blocks production readiness for the general agent runtime because quality gates fail after live runs.

## Verification

Passed deterministic verification after final amendments:

- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/terminal-repair-build-allowed-actions.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `node test/unit/planner-action-surface.test.js`
- `node test/unit/workspace-actions.test.js`
- `npm run build`
- `npm test`

Failed live acceptance:

- `NODE_AGRUN_LIVE_PERFORMANCE_SLO=1 ... npm run test:live:node-3000`

## Next Required Fix

Create AGRUN-540 to make content-level structure repair a hard contract:

- If `semantic_duplicate_headings` or `body_after_final_section` remains after heading normalization, do not allow another heading-only patch as progress.
- Require a successful content-changing merge/remove operation, or publish limited only when budget is low/exhausted with concrete remaining gaps.
- Treat repeated successful `normalize_headings` with unchanged semantic structure as structure-repair no-progress.
- Keep the fix general. Do not hardcode this report topic or section names.
