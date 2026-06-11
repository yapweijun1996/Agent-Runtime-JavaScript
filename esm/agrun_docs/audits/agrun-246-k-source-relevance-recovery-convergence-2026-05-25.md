# AGRUN-246-K — Source-Relevance Recovery Convergence (REJECTED 2026-05-25)

> **Status: REJECTED — wrong intervention point.** Implementation was
> built, unit-tested, and live-verified on 3 canonical reruns. The signal
> populated correctly and reached the planner prompt (~2362-3666 chars,
> elevated on every cycle after read index 3), but `gemini-3.1-flash-lite`
> did NOT pivot. Worst trace got worse (26 reads vs 18 baseline). The
> failure mode is committed in the search phase BEFORE any read; a
> read-phase convergence signal fires too late. See
> `agrun_docs/live-tests/agrun-246-k-verify-rejected-2026-05-25.md` for
> the rollback + evidence, and
> `agrun_docs/audits/agrun-246-l-search-phase-query-diversification-2026-05-25.md`
> for the replacement ticket attacking the right lever.

## Scope

Define the new follow-up surfaced by the AGRUN-246-J 3-trace live distribution
(`agrun_docs/live-tests/agrun-246-j-workspace-repair-churn-live-rerun-2026-05-25.md`).
1 of 3 canonical Mandarin reruns failed strict quality on the source gate, NOT
because of any `applyIfValid:true` regression but because the model entered a
non-converging `read_url` loop on a topic it had mis-disambiguated.

This is a research doc. No code change yet. Goal: define the issue, root cause,
and the smallest harness-side signal that addresses it without crossing into
runtime-as-AI territory.

## Failing run trace

Run `2026-05-25T01-21-38-039Z` on canonical Mandarin Harness Engineering prompt.

Final: `runStatus=completed`, `candidateCjkChars=3156/3000`, structure PASS,
`sourceMinimum.passed=false` (`readSources=16, relevantSources=1`, vs minimum
`3 / 2`), `qualityScore=75`, `userGoalSatisfied=false`.

Action shape: 3 `web_search` early, then **18 `read_url` decisions**, then
finalize. No second `web_search` pivot after the first 4-5 read_urls produced
zero relevant.

Search queries (all 3 issued at the start, before any read_url):

1. `Harness Engineering AI agents evaluation frameworks definition`
2. `AI agent systems evaluation harness engineering framework`
3. `AI agent evaluation harness framework architecture patterns`

Read URLs in order:

1. `arxiv.org/html/2601.01743v1`
2. `github.com/ai-boost/awesome-harness-engineering`
3. `www.harness.io`
4. `openai.com/`
5. `arxiv.org/abs/2601.01743`
6. `www.anthropic.com/research`
7. `blog.langchain.dev/evaluating-llm-agents/`
8. `docs.langchain.com/docs`
9. `docs.smith.langchain.com/`
10. `www.ibm.com/think/topics/artificial-intelligence`
11. `www.betterevaluation.org/getting-started/what-evaluation`
12. `lilianweng.github.io/posts/2023-06-23-agent/`
13. `www.promptfoo.dev/docs/intro`
14. `www.promptfoo.dev/docs/red-team/`
15. `docs.langchain.com/docs/components/evaluation`
16. `langchain-ai.github.io/langgraph/`
17. `huggingface.co/blog/evaluating-llm-agents`
18. `docs.llamaindex.ai/en/stable/module_guides/evaluating/`

Compare passing Rerun 1 `2026-05-25T01-11-49-375Z`:

- `harness-engineering.ai/blog/agent-harness-complete-guide/` — strong topical hit
- `atlan.com/know/what-is-harness-engineering/` — strong topical hit
- `www.harness.io` — strong topical hit
- 4 read_urls total, 3 read / 2 relevant. PASS.

Compare passing Rerun 3 `2026-05-25T01-21-47-172Z`:

- `martinfowler.com/articles/harness-engineering.html`
- `reddit.com/r/ArtificialInteligence/.../harness-engineering_turning_ai_agents_into/`
- `www.ibm.com/topics/artificial-intelligence`
- `www.harness.io`
- 4 read_urls total, 3 read / 3 relevant. PASS.

## Root cause analysis

The runtime is NOT mis-scoring relevance. The relevance score correctly rejects
generic LLM-evaluation content (LangChain / promptfoo / LlamaIndex docs) as
non-topical for "Harness Engineering". The failing Rerun 2 has 16 read_url
calls and 1 relevant — that ratio is the model's behavior, not a relevance
scoring bug.

The actual failure mode is **non-convergence of the AI's query interpretation**:

1. The model anchored on "Harness Engineering = LLM evaluation harness /
   eval framework" early (queries 1 and 2 both include "evaluation
   frameworks").
2. After the first 3-5 read_url returned non-relevant on this interpretation,
   the model kept reading more URLs from the same misinterpretation cluster
   instead of pivoting back to `web_search` with a fresh query.
3. The harness never surfaced a strong-enough convergence signal saying "your
   last 5 read_urls produced 0 relevant — your search query interpretation is
   the suspect, not the URLs."

The model in Rerun 1 and Rerun 3 happened to anchor correctly from the first
read_url (`harness-engineering.ai` / `martinfowler.com`) and stayed in topic.
This is a luck distribution, not a robust behavior, and `gemini-3.1-flash-lite`
is exactly the class of model where the harness needs to compensate for
ambiguous prompt disambiguation.

## Existing harness pieces (gap analysis)

Surveyed `src/runtime/read-source-quality.js`, `read-url-recovery-signal.js`,
`src/runtime/action-pattern-convergence.js`, `src/skills/providers/web-search-ranking.js`,
`src/skills/providers/web-search-planner.js`.

| Existing piece | What it does | Why it does not solve this |
|---|---|---|
| `read-source-quality.js` | Scores each read_url's content for topical relevance | Per-URL only; no streak signal |
| `read-url-recovery-signal.js` | Surfaces alternate-source candidates after a single failed read | Per-failure; no "your query is wrong" angle |
| `action-pattern-convergence.js` | Tracks `consecutiveProductiveSteps`, `consecutiveExecutedPublishCount` | No `consecutiveNonRelevantReadCount` and no per-search-query attribution |
| `web-search-ranking.js` | Re-ranks search hits by exact-phrase + topical signal | Runs at search-time, not at recovery-time |
| `web-search-planner.js` | Helps the AI craft better queries | One-shot planning, no feedback loop from observed relevance failures |

The gap is a **consecutive-non-relevant-read convergence signal** combined
with a soft surface that points the AI back to `web_search` with a hint that
the *query interpretation* is the suspect.

## Proposed direction (NOT implementation; for next session)

Smallest harness-side surface that respects AI-first / no-hardcode:

1. Track `consecutiveNonRelevantReadCount` in a state similar to
   `read-url-recovery-signal.js`. Increment on each read_url whose relevance
   scorer returns `weak` or worse. Reset on each `strong`/`relevant` hit.
2. When that count crosses a threshold (e.g. 3-5), expose a NEW signal
   (`source_disambiguation_signal` or similar) in the AI-visible state with:
   - `consecutiveNonRelevantReadCount`
   - `lastSearchQueries[]` and their hit URLs
   - `recommendedNextMoves: ["web_search"]` (but NOT auto-blocking read_url)
   - A natural-language hint like "your last N read_urls returned weak
     relevance; your search query interpretation may need revising"
3. Surface the signal through the existing action-availability hints so the
   planner sees it on the next cycle — same surface used by
   `read_url_recovery_signal`.

Anti-patterns to AVOID (per CLAUDE.md):

- Do NOT hardcode "block read_url after N misses" — that's runtime making a
  decision the AI should make.
- Do NOT auto-issue a `web_search` from runtime — that's runtime doing AI
  work.
- Do NOT mutate `runState.observation` with a custom error message — use the
  established `runState.observation` envelope projection per AGRUN-248-B.
- Do NOT introduce a new private subsystem; reuse `read-url-recovery-signal`
  state shape.

## Acceptance shape (when this work eventually lands)

- Live rerun the canonical Mandarin Harness Engineering prompt ≥3 times on
  the new HEAD. Strict-quality pass rate must be ≥ 3/3 (a meaningful jump
  from 2/3) with the same source gate (`3 read / 2 relevant`).
- The 16-read_url failure mode must not recur in any of the 3 reruns.
- No regression in propose+apply pair cycle collapse from AGRUN-246-J: when
  the AI uses `applyIfValid:true`, propose+apply pair must still equal
  `propose` count + 0.

## Threshold — RESOLVED with 6-trace distribution sampling

Updated after `agrun_docs/live-tests/agrun-246-k-distribution-sampling-2026-05-25.md`:

3 additional canonical reruns (`2026-05-25T01-57-34-790Z`,
`2026-05-25T01-57-43-502Z`, `2026-05-25T01-57-51-053Z`) raised the failing-
trace sample. All 3 source-fail runs (Rerun 2, 4, 6) share the same shape:
**15-17 consecutive non-relevant read_url** after one early `www.harness.io`
topical hit. All 3 source-pass runs (Rerun 1, 3, baseline) read ≤ 4 URLs
total.

The failing-run streak is so long that a threshold of 3, 5, or even 7 would
all fire in time. A threshold of 3 also does not fire in any source-pass run
(none read 3 non-relevant in a row), so there is no false-positive surface
in this dataset.

**Decision: `consecutiveNonRelevantReadCount` threshold = 3** for the first
(and only) signal level. Implementation may raise to 4-5 if a future fixture
shows false positives, but the 6-trace dataset does not require it.

## Remaining open questions

- Projection injection path: should `source_disambiguation_signal` flow
  through the existing `read-url-recovery-signal` state shape (proposed) or
  get its own field in the AGRUN-248-E RunState kernel? Defer to
  implementation session after reviewing how `read_url_recovery_signal` is
  already consumed by planners.
- Signal granularity: single-level is the proposed default. If
  threshold=3 still does not produce a pivot in some failing fixtures,
  consider escalated level at threshold=6.
- Rerun 5 (PASS source 4/2, FAIL structure) suggests the topical-relevance
  scorer may be too permissive on wikipedia general pages
  (`wiki/Software_testing`, `wiki/Evaluation`). This is a separate ticket
  from 246-K and should NOT be conflated.

## Evidence anchors

- Failed run: `agrun_debug_runs/2026-05-25T01-21-38-039Z.{md,jsonl,-report.md}`.
- Passing runs: `2026-05-25T01-11-49-375Z`, `2026-05-25T01-21-47-172Z`.
- Distribution doc: `agrun_docs/live-tests/agrun-246-j-workspace-repair-churn-live-rerun-2026-05-25.md`.
- task.jsonl id: this audit becomes `AGRUN-246-K-SOURCE-RELEVANCE-RECOVERY-CONVERGENCE-2026-05-25`.
