# AGRUN-540 Content Structure Hard Contract Live Test

Date: 2026-06-17
Provider: Gemini `gemini-3.1-flash-lite`
Thinking: `GEMINI_THINKING_LEVEL=low`
Benchmark: 1500-word Loop Engineering and Harness Engineering report

## Result

AGRUN-540 is implemented but not live-accepted.

The deterministic harness is stronger: heading-only structure repair is no longer accepted for content-level structure failures, terminal repair prefers content-changing repair, runtime structure detection now aligns closer to report-quality red flags, and structure-repair shrink writes can pass only when they actually improve the content structure.

The final real-key live benchmark still failed production acceptance.

## Verification

| Check | Result |
| --- | --- |
| `node test/unit/workspace-actions.test.js` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS |
| Real-key live E2E, final rerun | FAIL |

## Live Attempts

| Artifact | Runtime | Calls | Tokens | Action time | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `agrun_debug_runs/2026-06-17T06-00-25-260Z.*` | 212.3s | 50 | 833,126 | 2.198s | Failed: source/structure |
| `agrun_debug_runs/2026-06-17T06-06-29-360Z.*` | 276.3s | 60 | 979,349 | 8.453s | Failed: reportQuality semantic duplicates |
| `agrun_debug_runs/2026-06-17T06-18-27-919Z.*` | 125.2s | 26 | 452,109 | 5.436s | Failed: structure and length; shrink repair was blocked |
| `agrun_debug_runs/2026-06-17T06-27-27-419Z.*` | 330.8s | 70 | 1,325,445 | 1.909s | Failed: max steps, length/structure |

## Root Cause

The main slowness is not web search, read_url, or workspace tools. In the final run, observed action time was only 1.909s, while total runtime was 330.8s. The cost is provider/planner loop churn.

AGRUN-540 fixed the earlier blocker where a valid full rewrite for structure repair was rejected as `destructive_shrink_blocked`. After that fix, the weak model could perform structure repair, but it repeatedly compressed the candidate:

- Candidate reached 1474 words, then `workspace_write` compressed it to 851 words.
- Candidate reached 1658 words, then `workspace_write` compressed it to 868 words.
- Candidate reached 1613 words in low budget, then `workspace_write` compressed it to 693 words.
- The run ended at max steps with 1106 words, duplicate structure issues, and no terminal publish.

This exposes a second runtime issue: after a candidate is near or above the requested length, the harness still allows broad full-document rewrites during terminal repair. For low-thinking models, that becomes a loop: expand enough, rewrite shorter, expand again, rewrite shorter again.

## Code Changes

- Block heading-only `normalize_headings` when semantic duplicate/body-after-final content remains.
- Add `content_structure_not_repaired` risk flag and patch suggestion.
- Project semantic duplicate and body-after-final contexts into patch summaries and convergence snapshots.
- Make terminal repair prefer `workspace_replace` / `workspace_write` for content-level structure repair instead of patch-only heading fixes.
- Track no-growth stalls for `workspace_multi_edit` and `workspace_replace`.
- Align runtime semantic duplicate detection with report-quality duplicate-heading behavior.
- Add a narrow structure-repair shrink allowance so full rewrite can pass only when old content has content-level structure issues and the new structure is cleaner while preserving substantive content.

## Production Verdict

Not production-ready for complex long-report agent skills yet.

Simple multi-turn chat remains validated from AGRUN-531. The complex report benchmark remains blocked by AGRUN-541: length-preserving terminal repair and publish convergence.

## Next Fix

AGRUN-541 should add a general length-preserving repair gate:

- When the latest candidate is near/above requested length, terminal repair should prefer `workspace_read`, `workspace_review_candidate`, `workspace_publish_candidate`, or targeted `workspace_replace`.
- Full `workspace_write` should be blocked or hard-vetoed if it would materially reduce word count without resolving a blocking structure/source issue.
- Low/exhausted budget should not allow new broad rewrites when a publishable or near-publishable candidate already exists.
- WMG should count broad rewrite compression as no-progress even when the action technically succeeds.
