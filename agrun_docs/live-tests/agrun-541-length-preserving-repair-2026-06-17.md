# AGRUN-541 Length-Preserving Repair Live Report

Date: 2026-06-17

## Result First

AGRUN-541 is implemented and deterministic tests pass, but the real-key Gemini low-thinking long-report benchmark is still not production-ready.

The fix improved loop performance substantially:

| Run | Result | Duration | Provider calls | Tokens | Action repeat | Quality |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 2026-06-17T07-50-47Z before protocol fix | Failed | 340.9s | 70 | 1,239,213 | 13 | 75/100 |
| 2026-06-17T08-05-00Z after protocol fix | Failed | 183.8s | 23 | 378,428 | 2 | 50/100 |

The latest run met provider-call and action-repeat SLOs, but failed duration, token, structure, and citation quality gates.

## What Was Fixed

The live trace showed two separate harness problems:

1. Length regression: after a candidate reached or exceeded the requested 1500 words, broad `workspace_write` repairs could shrink it back below the target. The runtime treated the shrink as normal progress.
2. Protocol pollution: `destructive_shrink_blocked` and `workspace_replace not_found` were observations, not content mutations, but the publish protocol counted them as writes. That made the runtime falsely think the candidate needed another finalize/read/review cycle.

AGRUN-541 fixed both at the harness layer:

- Candidate progress now detects material candidate regressions.
- Workspace mutation growth convergence escalates after repeated candidate regression.
- Requirement recovery tracks length regression and supports honest limited publish only after repeated regression evidence.
- `workspace_write` refuses destructive final-candidate rewrites that reopen a requested length deficit.
- The requested length contract is read from direct acceptance packets, gated acceptance packets, and prompt-derived length contracts.
- Publish protocol now counts only content-changing workspace operations as latest writes; blocked/no-op observations no longer stale finalize/read/review.

## Per-Step Timing

Latest live E2E artifact:

- Summary: `agrun_debug_runs/2026-06-17T08-05-00-854Z.md`
- Trace: `agrun_debug_runs/2026-06-17T08-05-00-854Z.trace.v1.json`
- JSONL: `agrun_debug_runs/2026-06-17T08-05-00-854Z.jsonl`
- Report: `agrun_debug_runs/2026-06-17T08-05-00-854Z-report.md`

| Step type | Count | Total time |
| --- | ---: | ---: |
| web_search | 1 | 1.480s |
| read_url | 3 | 0.753s |
| workspace_write | 5 | 0.014s |
| workspace_insert_after_section | 3 | 0.023s |
| workspace_read | 3 | 0.003s |
| workspace_review_candidate | 1 | 0.006s |
| workspace_publish_candidate | 1 | 0.013s |

Observed action time was only 2.292s out of 183.756s. The slow path is provider/planner loop churn and prompt-context size, not tool execution.

## Latest Live Failure

The latest run produced a 1739-word candidate and read 3 strong sources, but the final report was not acceptable:

- `userGoalSatisfied=false`
- Acceptance score: 50/100
- Length gate: pass
- Structure gate: fail
- Source/citation gate: fail
- Red flags: `repeated-headings x6`, `restated-after-conclusion(6)`
- Candidate quality blockers: `duplicate_headings`, `missing_required_cited_urls`

The runtime correctly blocked three destructive shrink rewrites, preserving the 1739-word candidate. The remaining failure is content-level structure repair: the weak model kept duplicating sections, then admitted the candidate was not ready, then tried direct `finalize` multiple times before finally publishing limited.

## Root Cause

The original AGRUN-541 root cause was not model thinking level. `GEMINI_THINKING_LEVEL=low` was used. Tool latency was not the problem.

The root cause was harness contract leakage:

1. The requested length contract was fragmented across prompt, acceptance packet, and terminal repair state.
2. The execution boundary allowed broad rewrites to destroy a near-target candidate.
3. Non-mutating blocked/no-op workspace observations were counted as real writes, creating false stale publish protocol.

These are now fixed.

The remaining root cause is separate: content-level structure repair is still too advisory. When semantic duplicate sections and body-after-final-section remain, the runtime still lets the model spend cycles on broad rewrite attempts and blocked direct finalize instead of forcing one deterministic content-merge/removal repair or an immediate honest limited publish.

## Production Readiness

Not production-ready for this complex long-report benchmark.

Simple multi-turn monitor tests are not the blocker. GPT-5.4 mini and Gemini low-thinking can handle simple multi-turn monitoring. The failure appears in complex agent-skill work where the runtime must preserve a large candidate, enforce structure contracts, and exit within SLO.

## Next Fix

AGRUN-542 should make content-level structure repair a hard terminal contract:

- If length and sources are satisfied but structure has semantic duplicates or body-after-final-section, allow exactly one content-changing repair attempt.
- The repair must reduce duplicated section blocks or remove post-final body content.
- Block direct `finalize` during terminal repair hard veto.
- If the one content repair cannot pass, publish limited immediately with concrete structure gaps.
- Do not count blocked/no-op repair observations as content progress.

Acceptance stays the same benchmark: real-key Gemini low-thinking, 1500-word report, performance SLO enabled, exit 0, under 90s, under 25 provider calls, under 300k tokens, all quality gates true.
