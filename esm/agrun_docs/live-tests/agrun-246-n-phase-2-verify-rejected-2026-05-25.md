# AGRUN-246-N Phase 2 Verify Rejected (2026-05-25)

## Scope

Honest record of the AGRUN-246-N Phase 2 runtime implementation being
rolled back after 5-trace live verify produced 0/5 strict pass — worse
than the pre-change baseline of 3/7 = 43% from the AGRUN-246-K era.
Mirrors the AGRUN-246-K and AGRUN-246-L rejection pattern at the same
gate position (post-implementation, pre-push live verify).

## What was built (commit `09f2d62a4`, rolled back)

Per the AGRUN-246-N Phase 2 design audit:

- `src/runtime/search-plan-orthogonality.js` (new, ~200 lines) — pure
  verifier module exporting `verifySearchPlanOrthogonality` plus
  calibration constants (MIN=3, MAX=8, threshold=0.55, max-rejections=2).
- `src/runtime/actions/web-search-action.js` — extended with Mode B
  branch. `argsSchema` gains `searchPlan: { type: "array" }`. Most
  prominently, `argsExample` switched to Mode B as the dominant shape:

  ```
  argsExample: {
    searchPlan: [
      { query: "<topic> definition fundamentals introduction",
        aspect: "definition_fundamentals" },
      { query: "<topic> production reliability case studies real-world",
        aspect: "production_reliability" },
      { query: "<topic> evaluation methodology measurement framework",
        aspect: "evaluation_methodology" }
    ]
  }
  ```

- `src/runtime/state.js` — `researchContext.searchPlanRejectionCount: 0`
  added.
- 17 unit tests passed (12 orthogonality verifier + 5 Mode B
  integration). Full npm test PASS, npm run build clean, npm run
  dist:check PASS.

## Live verify (gemini-3.1-flash-lite, canonical Mandarin Harness Engineering, 5 traces)

Environment:

- model: `gemini-3.1-flash-lite`
- thinking budget: `high`
- maxSteps: 60
- timeout: 300s per planner call
- user goal: "写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。"

| Trace | Mode B used | searchCalls | qualityScore | userGoal | candidateCjkChars | structureOk | notes |
|---|---|---|---|---|---|---|---|
| `2026-05-25T06-50-44-032Z` | YES (1×3 queries) | 1 | 29 | false | 1751 | false | early finalize |
| `2026-05-25T06-53-05-973Z` | **NO** (skipped web_search) | 0 | **0** | false | 0 | false | planner_finalize bypass |
| `2026-05-25T06-54-18-871Z` | YES (2×3 queries) | 2 | 54 | false | 1725 | true | source FAIL |
| `2026-05-25T06-58-40-814Z` | YES (3×3 queries) | 3 | 75 | false | 3228 | n/a | length OK, source FAIL |
| `2026-05-25T07-01-30-305Z` | YES (1×3 queries) | 1 | 23 | false | 1360 | false | hit max_steps |

Aggregate:

- **Strict pass: 0 / 5 = 0%** vs pre-change baseline 3 / 7 = 43%.
- Median qualityScore = 29 (baseline ~75 across mixed strict_pass + source_fail).
- Mode B adoption rate: 4 / 5 = 80% (one trace skipped web_search entirely).
- Verifier rejections fired: **0** across all traces. Every submitted
  Mode B plan was orthogonal (max pairwise Jaccard 0.091 - 0.400, well
  below the 0.55 threshold).

The verifier mechanism worked correctly in production:

- Trace 1 plan: `definition` + `reliability_framework` + `architecture_components` → max Jaccard 0.375 → accepted.
- Trace 3 plans: orthogonal both times.
- Trace 4 plans: orthogonal across 3 separate Mode B calls.
- Trace 5 plan: orthogonal.

The model never produced a narrow same-cluster plan that would have
triggered the verifier. So the verifier never had to fire.

## Why this was rejected

The Phase 2 design audit's rollback rule was framed around verifier
failure modes:

> Rollback if any source_fail trace shows the verifier did NOT
> elevate before the first read_url.

The verifier did NOT need to elevate because the plans were already
orthogonal. By that narrow rule alone, this would not trigger
rollback.

But the broader rule from the AGRUN-246-K and AGRUN-246-L rejection
precedents applies: **if live verify is meaningfully worse than the
pre-change baseline distribution, rollback regardless of why**. Per
the AGRUN-246-K KB procedural memory at importance 9:

> Unit tests prove mechanism, not behavior. A signal can populate
> correctly, reach the planner prompt at the right time, contain
> the right hint, and still produce zero or negative behavioral
> change because the LLM does not act on it.

Here the behavioral change is **negative** — Mode B is adopted but
overall quality drops. The cause is not the verifier, it is the
upstream effect of Mode B's tool shape on the AI's research-phase
budget perception.

## Diagnosis — Mode B atomicity condenses the search phase

The strongest empirical signal across the 4 Mode B traces:

| Mode B calls | candidateCjkChars |
|---|---|
| 1 (traces 1, 5) | 1751 / 1360 |
| 2 (trace 3) | 1725 |
| 3 (trace 4) | 3228 |

More Mode B calls correlate with longer final candidates. Trace 4
(3 calls × 3 queries = 9 search queries) was the only trace to clear
the 3000-cjk-char length gate. Traces 1 and 5 (1 call only) finalized
with ~1400 cjk chars — far short.

Hypothesis: Mode A produced N sequential web_search ACTIONS (one per
query), so the AI naturally accumulated 3+ search actions across cycles
before moving to read+write. Mode B condenses N queries into ONE
action, so the AI completes one Mode B call and treats "search phase"
as done — moving prematurely to read+finalize.

In short: **the structural forcing that produced orthogonal plans
also told the AI "search is one action, not N", which reduced the
total evidence accumulation budget.** The simulator (which only
measured first-plan emission) could not detect this because it ran
in isolation without the multi-cycle research loop.

Trace 2 (planner_finalize bypass with zero web_search) is a
pre-existing failure mode that also occurs in baseline runs; it is
not a Mode B regression, but the 0 quality score it contributes
worsens the overall distribution.

## Statistical caveat

5 traces is a small sample. Under a 43% baseline strict-pass rate,
the probability of observing 0 / 5 by chance is `(1 - 0.43)^5 ≈ 6%` —
suggestive but not conclusive. The decision to rollback also weighs:

- Median qualityScore (29) is far from the baseline median (~75).
- The signed direction of the trend across all 5 traces is
  consistently below baseline.
- The diagnosis (Mode B atomicity reduces search budget) has a clear
  mechanistic story consistent with the trace data.

Continuing to add traces could narrow the confidence interval, but
each trace costs ~2-5 minutes of live Gemini quota plus harness/lab
time. The rejection precedent from AGRUN-246-K/L is to rollback
early on rough negative signal and avoid pushing speculative changes
to `origin/main`.

## Rollback action

```bash
git reset --hard 689358c50
# kept on main:  the Phase 2 design + simulator commit
#                (no runtime code, no schema change, no behavior change).
# dropped:       09f2d62a4 feat(runtime): Mode B + verifier implementation
```

Result:

- HEAD = `689358c50 docs(audit): AGRUN-246-N Phase 2 tool-shape design + simulator gate PASS`.
- All runtime files restored to pre-Phase-2 state:
  - `src/runtime/search-plan-orthogonality.js` deleted (never existed
    pre-rollback).
  - `src/runtime/actions/web-search-action.js` reverted (no Mode B branch).
  - `src/runtime/state.js` reverted (no searchPlanRejectionCount).
  - 2 unit test files deleted.
- The dropped commit (`09f2d62a4`) was local-only; never pushed to
  `origin/main`.

## Reclassification

`AGRUN-246-N` Phase 2 implementation is now closed as
**wrong-tool-shape**. The orthogonality mechanism is correct (and would
have been valuable IF Mode B were used additively to Mode A, not as a
replacement). The atomic Mode B shape (one action with N queries)
collapsed the AI's mental budget for search phase, producing fewer
total search ACTIONS even though more search QUERIES were issued per
action. The design hypothesis — that forcing function at the tool
surface produces structural diversity — was correct in isolation but
wrong in the multi-cycle loop dynamics.

## What the next ticket needs

`AGRUN-246-O` (research-only, if/when opened) must address the
budget-perception failure:

1. **Mode B should be additive, not replacement.** The first
   research-phase action could still be a Mode B searchPlan, but the
   runtime/prompt should explicitly signal that "this counted as the
   1st of N expected research-phase searches". The AI must NOT treat
   one Mode B call as "search complete".
2. **Calibration must include multi-cycle live behavior, not just
   first-plan emission.** The Phase 2 simulator measured only the
   first envelope. A meaningful gate would replay multiple cycles to
   see if the AI re-issues web_search after the first Mode B
   acceptance.
3. **Measure END-TO-END quality**, not intermediate mechanism. A
   verifier that fires correctly but reduces overall task quality is
   net-negative. Future signal designs must have a sanity check
   against the end-task pass rate, not just the targeted metric.
4. **Mode A must remain the planner default for argsExample.** If
   Mode B is offered, it should be in the `guidance` text and the
   schema, but argsExample should preserve the Mode A simple shape
   so simple-lookup paths are not over-promoted to fan-out.

## HBR

1. **Third AGRUN-246 implementation rejected post-build-pass this
   session** (after 246-K and 246-L). Cumulative quota cost across the
   three rejections this week: ~17-18 live reruns.
2. **Simulator PASS at 10/10 trials did NOT predict live failure.**
   This is a new dimension of the standing KB lesson "unit-mechanism
   PASS != behavioral lift". Even when the simulator measures the exact
   metric the design relies on (Mode B emission rate, orthogonality),
   it can miss failure modes that emerge from the multi-cycle loop
   dynamics — here, the atomicity of Mode B condensing the search
   phase.
3. **No commits entered `origin/main`.** The discipline of "live verify
   before push" again saved a regression from entering shared history.
4. **Three Phase 2 commits remain on the local branch** as the
   research artifact:
   - `6ed58222d` Phase 1 calibration (research-only)
   - `ddadfb7d6` AGRUN-246-M density gate (independent fix, NOT rolled
     back — orthogonal value)
   - `689358c50` Phase 2 design + simulator gate (research-only)
   Plus this rejection audit (next commit). Phase 2 implementation
   commit `09f2d62a4` is dropped.
5. **Calibration corpus expanded.** The 5 rejected live traces are
   preserved in `agrun_debug_runs/`. They include both Mode B
   adoption examples and the planner_finalize bypass case, useful for
   any future AGRUN-246-O simulator design that wants to test
   multi-cycle behavior.

## Evidence anchors

- All 5 live traces:
  `agrun_debug_runs/2026-05-25T06-50-44-032Z.{md,jsonl,-report.md}`,
  `agrun_debug_runs/2026-05-25T06-53-05-973Z.{md,jsonl,-report.md}`,
  `agrun_debug_runs/2026-05-25T06-54-18-871Z.{md,jsonl,-report.md}`,
  `agrun_debug_runs/2026-05-25T06-58-40-814Z.{md,jsonl,-report.md}`,
  `agrun_debug_runs/2026-05-25T07-01-30-305Z.{md,jsonl,-report.md}`.
- Phase 2 design audit:
  `agrun_docs/audits/agrun-246-n-tool-shape-design-2026-05-25.md`.
- Phase 1 calibration audit:
  `agrun_docs/audits/agrun-246-n-orthogonality-lever-research-2026-05-25.md`.
- AGRUN-246-K precedent rejection:
  `agrun_docs/live-tests/agrun-246-k-verify-rejected-2026-05-25.md`.
- AGRUN-246-L precedent rejection:
  `agrun_docs/live-tests/agrun-246-l-verify-rejected-2026-05-25.md`.
- Rollback commit reference: `git reset --hard 689358c50` — dropped
  commit `09f2d62a4 feat(runtime): AGRUN-246-N Phase 2 web_search
  Mode B + orthogonality verifier`.
