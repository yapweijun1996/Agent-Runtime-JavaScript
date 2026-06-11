# AGRUN-246-L — Verify Rejected 2026-05-25

## Scope

Honest record of the AGRUN-246-L implementation attempt being rolled back
after live verify produced worse-than-baseline results in two batches.
Mirrors the AGRUN-246-K rejection pattern but at a different failure
layer: 246-K's signal was dormant in the wrong phase; 246-L's signal
either stayed dormant (optional `queryAngle`) or amplified the bias
(required `queryAngle` with no semantic constraint).

## What was built

Per `agrun_docs/audits/agrun-246-l-search-phase-query-diversification-2026-05-25.md`:

- `src/runtime/actions/web-search-action.js` extended with optional
  AI-authored `queryAngle` / `queryIntent` planner args.
- `src/runtime/search-query-diversification-signal.js` (new): enum
  status (`quiet` / `low_distinct_angles` / `same_angle_repeat` /
  `unknown_angle`) + `forbiddenMove` / `allowedNextMoves` / hint
  contract.
- Wired through `state.js`, `action-loop-action.js`,
  `planner-prompt.js`.
- Unit tests `test/unit/search-query-diversification-signal.test.js`
  (8/8 PASS, 6/7 corpus match with `rerun4` as known boundary).
- Simulator `scripts/simulate-agrun-246-l-pivot.mjs` (3/3 PASS on the
  `same-angle-repeat` variant; pivot to distinct angle observed).
- Skill updates teaching `queryAngle` declaration.

## Live verify v1 (optional queryAngle, commit `c94f3ec08`)

Three canonical Mandarin Gemini gemini-3.1-flash-lite/high reruns:

| Run | sourceMinimum | structure | failingGates | score | userGoal |
|---|---|---|---|---|---|
| `2026-05-25T04-49-02-431Z` | 3/3 PASS | FAIL | structure | 75 | false |
| `2026-05-25T04-49-11-546Z` | 3/0 FAIL | FAIL | source + structure | 50 | false |
| `2026-05-25T04-49-20-430Z` | 3/2 PASS | PASS | — | 100 | true |

Strict pass: **1 / 3 = 33%**, vs pre-change baseline 3/7 = 43%. Each
trace declared `queryAngle` on at most 1 web_search call; the rest left
the field null. Signal never reached the elevated state because optional
declarations were skipped by `gemini-3.1-flash-lite`.

Diagnosis: optional structured fields are skipped by lite-tier models
even when argsExample and guidance encourage them. Required for KB
memory match: "argsExample is the strongest behavioral signal for
lite-tier models... they fill required fields and skip optional ones".

## Live verify v2 (`required: true`, worktree change discarded)

Made `queryAngle` required in argsSchema. Updated mock-provider test
to add `queryAngle` to mocked plans. `npm test` 1050 PASS, build clean.

Three canonical Mandarin reruns:

| Run | sourceMinimum | structure | failingGates | score | userGoal |
|---|---|---|---|---|---|
| `2026-05-25T05-17-12-028Z` | 3/0 FAIL | FAIL | source + structure | **14** | false |
| `2026-05-25T05-17-21-393Z` | 4/0 FAIL | FAIL | source + structure | **0** | false |
| `2026-05-25T05-17-30-214Z` | 3/0 FAIL | PASS | source | 75 | false |

Strict pass: **0 / 3 = 0%**, source-fail rate **3 / 3 = 100%**. Score 0
in v2-2 is the worst trace in the entire AGRUN-246 series. Pre-change
baseline is 3/7 = 43% — v2 is worse than baseline.

Tracing `queryAngle` declarations:

| Run | web_search calls | queryAngles declared |
|---|---|---|
| v2-1 | 2 | `(MISSING)` then `definition` |
| v2-2 | 3 | `(MISSING)`, `technical`, `definition` |
| v2-3 | 1 | `definition` |

The AI now declares `queryAngle` (when it does declare), but the
declared angles are **single-word labels that match the topic name**:
`definition`, `technical`. These are inside the same misinterpretation
cluster the signal was supposed to detect. The forcing function pushed
the model to lock the bias **faster**, not broaden away from it.

Reads in failing v2 runs:

- v2-1: `arxiv.org/abs/2311.08252`, `lilianweng.github.io`, `harness.io`, `arxiv.org/abs/2309.07864`
- v2-2: `github.com/openai/evals`, `betterevaluation.org`, `openai.com`, `python.langchain.com`, `docs.smith.langchain.com`
- v2-3: `harness.io`, `docs.langchain.com`, `docs.smith.langchain.com`, `blog.langchain.dev`

This is the SAME LLM-evaluation cluster that AGRUN-246-K source-fail
runs hit, but now the AI reaches it after only 1-3 searches with
declared narrow `queryAngles`. The signal cannot fire on a single
declaration; by the time a second declaration arrives, the reads are
already running.

## Why this fails the rollback test

Per AGRUN-246-K rejection precedent + standing KB memory at importance
9 (`b4a36d34-…:2fe9403d-…`, line 3): "If live verify shows the signal
elevated but the model still does not pivot, rollback per 246-K
pattern."

In v2, the signal **did populate** (`searchQueryDiversificationSignal`
size 1306-1307 chars in v2-2 and v2-3 cycle traces vs 4 chars / null
in the baseline), but the model did not pivot to broader angles. The
worst v2 trace scored 0.

The signal mechanism is correct at the simulator layer. It does not
translate into production behavior because the AI's `queryAngle`
declaration carries no semantic orthogonality constraint — a
single-token angle that matches the topic name passes runtime validation
but does not broaden the search.

## Rollback action

```bash
git reset --hard af6f105ba
# kept: scripts/debug-agrun-246-l-fixture.mjs + test/fixtures/agrun-246-l-query-corpus.js + handoff docs
# dropped: src/runtime/search-query-diversification-signal.js + web-search-action.js queryAngle args
# dropped: simulator script + skill queryAngle guidance + smoke wiring
```

Result:

- HEAD = `af6f105ba feat(test): AGRUN-246-L fixture + Node debug runner (no hardcode)`.
- `dist/agrun.js` confirmed free of `searchQueryDiversification` and
  `queryAngle` symbols after rebuild.
- `npm test` 1042 PASS (back to pre-246-L baseline).
- `npm run build` clean. `npm run dist:check` 292 markdown PASS.
- 2 commits dropped: `c94f3ec08`, `63741825e`. They were unpushed; the
  reset is clean and never entered `origin/main`.

## Calibration gap that caused this

The AGRUN-246-L simulator (`scripts/simulate-agrun-246-l-pivot.mjs`,
also dropped) tested the `same-angle-repeat` variant by pre-seeding two
prior searchPasses with `queryAngle="evaluation_framework"`. With that
prior state, the model correctly pivoted to a distinct angle.

But the **first-search variant** — fresh start, no prior `queryAngle`
declarations, which is what every live run actually begins with — was
not tested in the way that matters. In production the AI's first
`web_search` is the decision that anchors the misinterpretation, and
that decision happens without any prior signal context.

Future simulator scenarios in this area must include "first declaration
with no prior" plus "second declaration after first declared a
topic-matching angle". The 246-L simulator omitted both.

## Reclassification

`AGRUN-246-L-SEARCH-PHASE-QUERY-DIVERSIFICATION-2026-05-25` is now
closed as **wrong-shape** (signal alone is not the lever). The
diagnosis is correct (search-phase commitment is the failure point),
but a free-form AI-declared `queryAngle` + distinct-count rule is not
sufficient to drive a weak model away from a topic-locked cluster.

## What the next ticket needs

`AGRUN-246-N` (research-only) opens with the following constraints:

1. **Orthogonality, not just diversity.** A 2-distinct-angle rule
   counted `definition` + `test_harness_evaluation` as 2 distinct, but
   both are inside the test/eval cluster. The new lever must measure
   how far the next angle is from prior angles, not just whether they
   differ as strings.
2. **No fixed topic-token taxonomy.** Shipping `["definition",
   "evaluation_framework", "control_guardrails", …]` as a runtime list
   would still be hardcoding — the user's last rejected fixture-anchor
   rule documented this. The orthogonality measure must be
   semantically grounded (embedding distance, classifier output,
   AI-declared parent intent) but not topic-specific.
3. **Calibration must include first-search behavior.** Simulator
   variants must verify cold-start declarations, not just continuation
   from primed prior state.
4. **Live verification gate must include 5+ trace minimum**, not 3.
   The 246-L v2 batch's 0/3 result is statistically severe but the
   v1 batch's 1/3 is in noise range; the verify gate failed to discriminate
   acceptable from unacceptable rollouts. Larger trace samples are
   non-negotiable for the next attempt.

## HBR

- This is the **second AGRUN-246 attempt rejected post-implementation**
  this week (after 246-K). Each rejection cost real Gemini quota
  (~30-40 minutes wall clock per 3-run batch, ~6 reruns total for
  246-L). The KB procedural memory at importance 9 must be updated to
  document the orthogonality finding so future 246-N work does not
  repeat it.
- The required-vs-optional dimension is now charted: optional fields
  are skipped by lite models, but required fields with no semantic
  constraint can amplify the bias they were meant to detect. Both
  edges are documented.
- The fixture and debug runner from `af6f105ba` remain useful
  calibration corpus. Do NOT delete them; they are evidence for the
  246-N calibration pass.
