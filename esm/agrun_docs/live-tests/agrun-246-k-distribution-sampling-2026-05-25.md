# AGRUN-246-K — Distribution Sampling (6-trace data) 2026-05-25

## Scope

Grow the failing-trace sample for AGRUN-246-K source-relevance recovery
convergence by running 3 more canonical Mandarin Gemini flash-lite/high
reruns on the same fixture used in the AGRUN-246-J 3-trace distribution. Goal:
use real distribution data, not a guess, to choose the
`consecutiveNonRelevantReadCount` threshold and to size the actual failure
rate of the canonical prompt on this model.

## Command (identical to AGRUN-246-J distribution)

```bash
AGRUN_DEBUG=1 \
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=high \
NODE_AGRUN_LIVE_MAX_STEPS=60 \
NODE_AGRUN_LIVE_TIMEOUT_MS=300000 \
NODE_AGRUN_LIVE_PROMPT="写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering..." \
node test/node-agrun-3000-live.mjs
```

Three new runs launched in parallel with 0/4/8 second offsets to avoid
timestamp collision: `2026-05-25T01-57-34-790Z`, `2026-05-25T01-57-43-502Z`,
`2026-05-25T01-57-51-053Z`.

## 6-Trace Quality Distribution (full)

| # | Run | runStatus | candCjk | sourceMin (read/rel) | structure | failingGates | score | userGoal |
|---|---|---|---|---|---|---|---|---|
| 1 | `2026-05-24T23-59-12-542Z` baseline | completed | 3032 | 3 / 2 PASS | PASS | — | 100 | true |
| 2 | `2026-05-25T01-11-49-375Z` Rerun 1 | completed | 3274 | 3 / 2 PASS | PASS | — | 100 | true |
| 3 | `2026-05-25T01-21-38-039Z` Rerun 2 | completed | 3156 | 16 / 1 **FAIL** | PASS | source | 75 | false |
| 4 | `2026-05-25T01-21-47-172Z` Rerun 3 | completed | 3069 | 3 / 3 PASS | PASS | — | 100 | true |
| 5 | `2026-05-25T01-57-34-790Z` Rerun 4 | completed | 3283 | 18 / 1 **FAIL** | PASS | source | 75 | false |
| 6 | `2026-05-25T01-57-43-502Z` Rerun 6 | completed | 3285 | 18 / 1 **FAIL** | PASS | source | 75 | false |
| 7 | `2026-05-25T01-57-51-053Z` Rerun 5 | completed | 3178 | 4 / 2 PASS | **FAIL** | structure | 75 | false |

**Strict-quality pass rate: 3 / 7 = 43%** (mixing baseline + 6 reruns).
**Source-gate fail rate: 3 / 7 = 43%**, all three with the same shape
(16-18 reads, exactly 1 relevant).

This is markedly worse than the 2/3 pass rate inferred from the first 3-trace
distribution. The original sample was too small; the canonical Mandarin
prompt on `gemini-3.1-flash-lite` is significantly less stable than we
believed.

## Failing-Run Pattern — Search Query Disambiguation

| Run | First few search queries |
|---|---|
| Rerun 2 (FAIL) | `Harness Engineering AI agents evaluation frameworks definition` / `AI agent systems evaluation harness engineering framework` / `AI agent evaluation harness framework architecture patterns` |
| Rerun 4 (FAIL) | `Harness Engineering in AI Agent systems concept` / `test harness for AI agents evaluation framework` |
| Rerun 6 (FAIL) | `Harness Engineering AI agent systems evaluation framework` / `what is 'Harness Engineering' in AI agent systems evaluation` |

| Run | First few search queries |
|---|---|
| Rerun 1 (PASS) | `Harness Engineering in AI Agent systems evaluation framework` / `AI agent framework design harness patterns principles` / `AI agent control patterns guardrails orchestration frameworks` |
| Rerun 3 (PASS) | `Harness Engineering in AI agent systems evaluation frameworks` / `AI agent harness engineering architecture components guides sensors` / `AI agent control system architecture design patterns` / `AI agent harness engineering case studies real-world examples` |
| Rerun 5 (PASS source, FAIL structure) | `Harness Engineering in AI Agent Systems meaning` / `test harness design for LLM autonomous agent systems evaluation framework` / `AI agent evaluation framework testing harness architecture` |

**Distinguishing factor:** Passing runs eventually issued queries with words
like `control patterns`, `guardrails`, `orchestration`, `architecture
components`, `sensors`. Failing runs stayed locked on `evaluation
framework / test harness`.

## Failing-Run Pattern — Read URL Sequences

All three source-fail runs read 18 URLs and got exactly 1 relevant. The
relevant URL in each case was `www.harness.io` (vendor site), read early. The
remaining 15-17 read_urls all came from the LLM-eval interpretation cluster:

- `arxiv.org` eval papers (2601.01743, 2305.10601, 2308.03688, 2309.07864,
  2305.16291)
- `langchain.com`, `docs.smith.langchain.com`, `langchain-ai.github.io`,
  `blog.langchain.dev`
- `promptfoo.dev` (intro / red-team / agents)
- `lilianweng.github.io/posts/2023-06-23-agent/` (read in **all 3** failing
  runs — it is a strong attractor for "AI agent" but is not topical for
  Harness Engineering)
- `huggingface.co/blog/evaluating-llm-agents`, `huggingface.co/docs/evaluate`
- `docs.llamaindex.ai`, `agentops.ai`, `confident-ai.com`, `braintrust.dev`,
  `superannotate.com`, `EleutherAI/lm-evaluation-harness`,
  `openai/evals`, `THUDM/AgentBench`, `WooooDyy/AgentLite`,
  `microsoft/autogen`, `microsoft/promptflow`
- `betterevaluation.org`, `agentops.ai`

This pattern is highly stable: the same off-topic cluster appears in all 3
failing runs even though the runs were independent sessions with different
sampling.

## Streak Length

In each source-fail run, after the early `www.harness.io` (the only relevant
hit, usually at read index 3), every subsequent read_url scored non-relevant.
That is a **15-17 consecutive non-relevant read streak** in each failing run.

In each source-pass run, the entire read sequence is ≤4 URLs, most of them
relevant. There is no "many non-relevant reads in a row" pattern.

## Threshold Decision (data-backed)

A `consecutiveNonRelevantReadCount` threshold of **3** would fire after the
first 3 non-topical reads following the lone topical hit and would catch all
3 failing runs at read index 5-6, ~10 reads before the AI exhausted its
budget. A threshold of **5** would catch them at read index 7-8.

Passing runs read ≤ 4 URLs total, so a threshold of 3 does **not** fire in
any passing run — there is no false-positive surface in this dataset.

Final proposed threshold (subject to implementation testing): **3** for the
first signal level, with no separate "escalated" level. The signal does not
auto-block read_url; it only adds a `recommendedNextMoves:["web_search"]`
hint and a NL-readable disambiguation message into the
`read-url-recovery-signal` state shape.

If implementation finds that threshold=3 causes false positives in other
fixtures (e.g. shorter prompts that legitimately need 3 setup reads before
the first relevant), the threshold can be raised to 4 or 5; the failing-run
streaks are long enough (15-17) that even 7 would still fire in time.

## HBR

- The expanded 6-trace sample shows the original 3-trace pass rate (2/3) was
  too optimistic. Real strict-quality pass rate is **3/7 = 43%**, source-fail
  rate **3/7 = 43%**, structure-fail rate **1/7 = 14%**.
- Rerun 5 introduces a separate failure surface: source PASS with only 4
  reads (2 wikipedia general pages + 1 lilianweng + 1 harness.io scored as 2
  relevant) but structure FAIL. This may indicate the topical-relevance
  scorer is **too permissive** on wikipedia general pages, but that is a
  separate AGRUN ticket from 246-K convergence.
- 6 reruns on a real LLM is expensive. Future distribution sampling should
  be batched + tied to an explicit ticket, not done casually.

## Verification

- All 7 runs: `node test/node-agrun-3000-live.mjs` exit 0.
- Data extracted from `agrun_debug_runs/*.jsonl` via `jq` on
  `event=="planner_decision"` filters.
- Source minimum / quality score extracted from each run's `.md` summary.
- `npm run dist:check` PASS.

## Evidence Anchors

- All 7 run artifacts: `agrun_debug_runs/{baseline + 6 reruns}.{md,jsonl,-report.md}`.
- AGRUN-246-K audit + design direction: `agrun_docs/audits/agrun-246-k-source-relevance-recovery-convergence-2026-05-25.md`.
- AGRUN-246-J cycle-cost distribution: `agrun_docs/live-tests/agrun-246-j-workspace-repair-churn-live-rerun-2026-05-25.md`.
- task.jsonl id: `AGRUN-246-K-DISTRIBUTION-SAMPLING-2026-05-25`.
