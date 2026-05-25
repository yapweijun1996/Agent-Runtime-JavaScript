# AGRUN-246-K — Verify Attempt Rejected 2026-05-25

## Scope

Honest record of the AGRUN-246-K implementation attempt. The proposed
`consecutiveNonRelevantReadCount` convergence signal was implemented per the
threshold=3 design in
`agrun_docs/audits/agrun-246-k-source-relevance-recovery-convergence-2026-05-25.md`,
verified on 3 canonical Mandarin Gemini flash-lite/high reruns, and **rolled
back** because the live data showed the change does not produce the intended
behavioral pivot. The lever was the wrong one.

## What was built and verified

Code change (now reverted in git HEAD):

- `src/runtime/read-url-recovery-signal.js` — added
  `SOURCE_RELEVANCE_CONVERGENCE_THRESHOLD = 3`, extended state shape with
  `consecutiveNonRelevantReadCount`, `sourceDisambiguationStatus`,
  `sourceDisambiguationHint`, `lastNonRelevantReadUrls`, `lastSearchQueries`,
  added `computeSourceRelevanceConvergence` helper that walks `readSources`
  backwards and counts consecutive `weak`/`thin` tiers (with `blocked` /
  failed as neutral), surfaced the new fields through `summarizeReadUrlRecoverySignal`
  and `buildReadUrlNextMoveContract` so the planner prompt sees the
  disambiguation hint when streak >= 3.
- `src/runtime/action-loop-action.js` — added 2 fields to the existing
  `read-url-recovery-signal-refreshed` pushStep event.
- `test/unit/read-url-action.test.js` — 6 new focused unit tests proved the
  helper behaved correctly at boundary, threshold, mid-streak reset, blocked
  neutrality, summary surfacing, and null-summary preservation.

Unit / build verification:

- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/read-url-action.test.js`: 13/13 PASS (7 old + 6 new).
- `npm test`: 1042 PASS / 0 FAIL.
- `npm run build`: clean.
- `npm run dist:check`: 289 markdown files PASS.

## Live evidence

3 canonical Mandarin reruns on the post-change HEAD with the same fixture
that produced AGRUN-246-K's 6-trace distribution sampling:

| Run | sourceMinimum | structure | score | userGoal | total read_url |
|---|---|---|---|---|---|
| `2026-05-25T02-30-39-927Z` | 26 / 1 **FAIL** | PASS | 50 | false | 31 (26 success / 5 blocked) |
| `2026-05-25T02-30-49-123Z` | 3 / 2 PASS | unknown | 75 | false | 3 |
| `2026-05-25T02-30-58-275Z` | 6 / 1 **FAIL** | unknown | 41 | false | ≤8 |

Strict-quality pass rate: **0 / 3** (worst yet). Source-fail rate: 2 / 3.
Score range: 41-75 (mean ~55). Compare 7-trace pre-change baseline: strict
pass 3/7 = 43%, source-fail 3/7 = 43%. **The change made the distribution
worse, not better.**

Run #1 specifically read **26 URLs** vs the pre-change worst case of 18 URLs.

## Did the signal actually elevate?

Yes. Confirmed via two checks:

1. The post-change `planner_prompt` payload in run #1 carries
   `readUrlRecoverySignal` at 2362-3666 chars across cycles 3-49, far above
   the 4-char `null` baseline. The new disambiguation hint and metadata are
   serialized into the planner prompt every cycle after the streak crosses
   the threshold.
2. Run #1 tier sequence (extracted from `agrun_debug_runs/2026-05-25T02-30-39-927Z.md`):
   `thin, weak, weak, blocked, weak, blocked, thin, weak, thin, weak, weak,
   blocked, weak, blocked, thin, weak, thin, weak, weak, blocked, ...`.
   The streak hits 3 by the 3rd read and stays elevated for the rest of the
   run. The signal IS active throughout the failure window.

So the signal IS being populated, IS being serialized into the planner
prompt, and the LLM IS seeing it. The LLM does not act on it.

## Why the lever was wrong

The AGRUN-246-K audit doc identified the failure mode correctly but picked
the wrong intervention point. From the doc itself:

> "The AI started with 3 web_search queries all containing 'evaluation
> frameworks' and 'framework architecture', anchoring on 'Harness
> Engineering = LLM evaluation harness'."

That mis-disambiguation happens in the **first 1-3 `web_search` queries,
BEFORE any `read_url`**. A read-phase consecutive-non-relevant streak
signal fires **after** the AI has already committed to a misinterpretation
cluster (via search) and gathered candidate URLs from that cluster. A
post-hoc "your reads are non-relevant, pivot to web_search" hint cannot
break a committed search-derived plan in flash-lite — the model has
already collected and queued URLs from the wrong cluster.

The real lever sits in the search phase, not the read phase. By the time
the read phase produces a streak, the harness has already let the model
commit to a wrong angle.

## Rollback action

- `git checkout` on
  `src/runtime/read-url-recovery-signal.js`,
  `src/runtime/action-loop-action.js`,
  `test/unit/read-url-action.test.js`.
- `npm run build` to clean dist.
- `dist/agrun.js` confirmed to contain zero references to
  `consecutiveNonRelevantReadCount` or `sourceDisambiguationStatus`.
- `npm test` 1042 PASS after rollback.

The proposed code change is NOT in git history. The rollback is clean.

## Reclassification

`AGRUN-246-K-SOURCE-RELEVANCE-RECOVERY-CONVERGENCE-2026-05-25` is now closed
as **wrong-intervention-point**. The diagnosis was correct; the mechanism
(read-phase streak signal) is not the right lever for this failure mode.

A new ticket
`AGRUN-246-L-SEARCH-PHASE-QUERY-DIVERSIFICATION-2026-05-25` opens to
attack the actual root cause: high-overlap query clustering in the first
1-3 `web_search` calls drives the AI into a misinterpretation cluster
before any read happens.

## HBR

- This is the second time a live-evidence harness change in the AGRUN-246
  series produced near-zero or negative behavioral impact on
  `gemini-3.1-flash-lite`. The model is harder to steer with post-action
  hints than the audit doc assumed.
- The unit-test layer correctly proved the mechanism worked, but
  mechanism != behavior. Future fix proposals in this area need to plan
  for a live verification gate BEFORE the code change is merged, not
  after.
- The 3 verify reruns cost real Gemini quota and ~30 minutes wall-clock.
  The rollback is correct but not free; in future, smaller-scope live
  probes (e.g. one canonical run with a flag toggle on a tee-off branch)
  could shorten the verify-or-revert loop.
