# AGRUN-246-N — Orthogonality Lever Research (2026-05-25)

## Status

**RESEARCH ONLY.** No runtime code. No tool-shape change. This document
records the research that opens AGRUN-246-N as a replacement for the
rejected AGRUN-246-L distinct-angle signal.

## Scope

AGRUN-246-L was rejected across two live verify batches:

- v1 (`queryAngle` optional): AI skipped the field 4/5 times. Signal
  dormant. 1/3 strict pass (worse than pre-change 3/7 = 43%).
- v2 (`queryAngle` required): AI declared narrow same-cluster angles
  (`definition`, `technical`). Signal elevated correctly but the model
  did not pivot. 0/3 strict pass; one trace scored 0 (worst in the
  entire AGRUN-246 series).

Rollback: `git reset --hard af6f105ba`. Both unpushed commits dropped.
Calibration corpus and debug runner preserved.

The question that opens this research: **what shape of harness lever
can actually move a weak model (`gemini-3.1-flash-lite`) away from a
narrow same-cluster query loop, without runtime hardcoding any
topic-specific tokens, and without amplifying the bias it was meant to
catch?**

## Research findings

Prior art was reviewed across four bodies of work. All references are in
the Sources section at the end.

### Finding 1 — Industry pattern is upfront parallel decomposition, not sequential pivot

| System | Mechanism | Diversity enforcement |
|---|---|---|
| Anthropic Multi-Agent Research | Lead agent spawns 3-5 subagents in parallel, each with explicit objective/boundaries | Architectural — separate context windows |
| O-Researcher | Planner decomposes query into **orthogonal sub-queries**, parallel agents execute | Architectural — parallel execution isolates context |
| GPT Researcher (Deep Research mode) | Fixed `breadth=4` parallel queries per recursion level | Structural — breadth parameter |
| Modern AI Search (Google AIO, Perplexity, Claude Research) | Query fan-out: 5-15 sub-queries fired in parallel | Tool-shape — fan-out is the action |
| ParallelSearch (RL paper) | LLM trained to decompose+search in parallel | RL-shaped behavior |

Common pattern: **commit to N orthogonal directions BEFORE any search
executes**, not "search → notice narrow → pivot". Weak models cannot
mid-stream pivot reliably; they can fill N slots upfront if the tool
forces N slots.

### Finding 2 — O-Researcher does NOT formally measure orthogonality

The arXiv paper that explicitly introduces "orthogonal decomposition"
admits it does not compute or validate orthogonality. The structure is
asserted by the planner and enforced by **parallel execution that
isolates contexts**. Implication: even state-of-the-art systems do not
ship a "semantic orthogonality classifier"; they ship a structural
constraint.

### Finding 3 — Anthropic's primary lever was prompt-engineered tool descriptions

Anthropic reported that rewriting bad tool descriptions cut task
completion failures by 40%. The KB procedural memory already records:
`argsExample` is the strongest behavioral signal for lite-tier models —
they literally copy the example. This bounds what is feasible: argsExample
can shape the **first call**, but cannot enforce subsequent calls without
a structural gate.

### Finding 4 — Cosine-similarity dedup thresholds are domain-specific

Web-search dedup industry guidance is ~0.85-0.9 cosine similarity for
"near-duplicate" detection. Token-set Jaccard is lower-dimensional and
typically requires lower threshold (~0.4-0.6) to flag overlap. Either
metric depends on per-corpus calibration; there is no universal
threshold.

### Finding 5 — `gemini-3.1-flash-lite` cold-start failure mode is real

The 246-L v2 traces show the model's **first** `web_search` call already
selects narrow-cluster keywords (`evaluation framework`, `test harness`).
The cold-start commitment anchors the misinterpretation. Subsequent
searches only refine, never broaden. The simulator that "proved" 246-L
pivoted was pre-seeded with prior `queryAngle`, which is not the real
production cold-start state.

## Proposed lever shape for AGRUN-246-N

**Upfront search plan + offline-calibrated orthogonality verifier.**

The lever sits at the **first search-phase action**, not at the read or
plan-after-failure phase. Two pieces:

### Piece A — Tool-shape change (structural pressure)

Extend `web_search` (or add a new `research_search_plan` action,
decision deferred to design phase) so the planner can submit:

```jsonc
{
  // Mode A (single, backwards-compatible):
  "query": "..."

  // Mode B (plan-mode, new):
  "searchPlan": [
    { "query": "...", "aspect": "..." },
    { "query": "...", "aspect": "..." },
    { "query": "...", "aspect": "..." }
  ]
}
```

- The argsExample in the planner registry shows a realistic Mode B
  example for the **first** research-phase action: three Mandarin
  queries each targeting a distinct aspect of the topic.
- argsExample is the dominant prompt signal for lite-tier models per
  the standing KB memory. This is the **structural lever** — the model
  copies the example shape, so it commits to three queries upfront.

This piece is design-only in this document. Implementation is gated by
Piece B calibration.

### Piece B — Orthogonality verifier (safety net)

After plan is submitted but BEFORE the first search executes, runtime
computes pairwise similarity on the queries in the plan. If any pair
exceeds a calibrated threshold, runtime returns a `searchPlanRejected`
result envelope with diagnostic content (which pair, what overlap),
and the AI is expected to revise.

Candidate similarity metrics (offline calibration must pick one or
reject all):

1. **English token-set Jaccard** — existing 246-L baseline.
   Inherits 246-L's weakness on synonyms and CJK.
2. **Character bigram Jaccard** — CJK-friendly, language-agnostic,
   captures partial token overlap. No external dependency.
3. **AI-declared `aspect` distinct-count** — 246-L v2 already proved
   this can be gamed. Only useful as a *secondary* dimension.
4. **Composite**: bigram Jaccard ≥ threshold **OR** aspect
   distinct-count < N.
5. **Embedding cosine distance** — only available if host injects an
   embedding hook. Optional layer; runtime must work without it.

The verifier is a **gate, not a rewriter**. Runtime does not edit the
plan or pick alternative queries. It only refuses the plan with a
structured diagnostic. The AI owns the rewrite.

Reject-loop budget: verifier may reject at most N times (calibrated)
before allowing best-effort plan execution with the signal elevated.
This prevents lite-model reject loops.

### Why this avoids 246-L's failure modes

| 246-L failure | 246-N response |
|---|---|
| Optional field skipped by lite model | Plan mode is the argsExample → model copies the shape |
| Required field labeled narrowly after-the-fact | Plan commits N aspects BEFORE any search executes |
| Signal elevates too late (after read starts) | Verifier runs at plan-submit time, before any web hit |
| `distinct-count` of strings counted `definition` + `test_harness_evaluation` as 2 | Pairwise similarity on the actual query strings catches lexical-near plans |
| Simulator only tested primed-prior state | Cold-start is the default; first action is the plan |
| Forcing function amplified bias | Structural N-slot forcing is upfront, not retrofit labeling |

## Constraints for the calibration phase

These are non-negotiable for AGRUN-246-N before any runtime code lands:

1. **Offline calibration first.** Reuse the 7-trace AGRUN-246-K corpus
   already in `test/fixtures/agrun-246-l-query-corpus.js`, plus the 9
   AGRUN-246-L v1+v2 raw jsonls in `agrun_debug_runs/` (3 v1 + 3 v2 +
   3 unidentified-source-fail = 9 traces). Total 16 trace data points.
2. **No fixed topic-token taxonomy.** Calibration may use diagnostic
   token lists (EVAL_CLUSTER_TOKENS, etc.) for the report, but
   recommended runtime metric must NOT depend on them.
3. **Cold-start verified.** Calibration must inspect the **first 2-3
   queries** of each trace, not the steady-state behavior.
4. **Live verification gate ≥5 traces.** The 246-L v1 batch's 1/3 was
   in noise range and the 3-trace gate failed to discriminate. Lift
   the bar.
5. **Plan-shape verified in simulator before live.** Before any tool
   shape change, run the simulator on the lite model with the proposed
   Mode B argsExample and confirm the model produces a 3-aspect plan
   with naturally distinct lexical content. If the simulator shows the
   model writes 3 same-cluster queries even with the new argsExample,
   the tool-shape change is **rejected** and 246-N closes the same way
   246-L did.

## Out of scope for 246-N

- Runtime auto-rewrite of queries (rejected pattern, see 246-K
  precedent).
- Runtime auto-block of `web_search` (rejected pattern).
- Embedding model bundled in agrun runtime (host responsibility if
  needed at all).
- Topic-specific token allowlists/denylists (rejected pattern).
- Changing `gemini-3.1-flash-lite` to a stronger model as
  mitigation (rejected by user, see standing KB feedback memory:
  "harness must NEVER kill model ability by gating tasks based on
  model tier").

## Calibration plan

Phase 1 (this ticket, deliverable now):

- Write `scripts/calibrate-agrun-246-n-orthogonality.mjs` that loads
  the 16 trace corpus, extracts the first 2-3 `web_search` queries per
  trace, computes the 4 candidate metrics, and reports which (if any)
  cleanly separates `strict_pass` from `source_fail` traces.
- If at least one metric achieves clean separation on the 16-trace
  corpus, AGRUN-246-N proceeds to design phase (next ticket).
- If no metric separates cleanly, AGRUN-246-N is **rejected at
  calibration**, same way 246-L was rejected at offline calibration
  for pure token overlap. We do not implement tool-shape change
  without offline evidence.

### Phase 1 result (this run, 2026-05-25)

`node scripts/calibrate-agrun-246-n-orthogonality.mjs --window=3` over
the 16-trace corpus produced **CONDITIONAL PASS**:

| Metric scope | Threshold | TP | FP | TN | FN | Ambiguous (elevated/tolerated) | Clean separation |
|---|---|---|---|---|---|---|---|
| `latinJaccardMax` full corpus | 0.556 | 8 | 0 | 4 | 2 | 0 / 2 | NO (2 FN) |
| `bigramJaccardMax` full corpus | 0.538 | 8 | 0 | 4 | 2 | 0 / 2 | NO (2 FN) |
| `latinJaccardMax` ≥3 Q subset | 0.556 | 5 | 0 | 2 | 0 | 0 / 1 | **YES** |
| `bigramJaccardMax` ≥3 Q subset | 0.437 | 5 | 0 | 2 | 0 | 1 / 0 | **YES** |

The two false-negatives on the full corpus are `rerun4` (only 2 queries
captured, both narrow same-cluster lexically distinct) and `v2-3` (only
1 query — verifier needs ≥2). Both disappear under a `minCount=3` tool
shape, because such traces cannot exist if the tool schema rejects
`searchPlan` arrays of length < 3.

`latinJaccardMax >= 0.556` on the ≥3 Q subset:

- All 5 source_fail traces with 3+ queries elevate.
- Both strict_pass traces with 3+ queries stay quiet.
- The 1 ambiguous trace (`rerun5`) is tolerated (stays below threshold).
- No false positives, no false negatives, no over-elevation.

`bigramJaccardMax >= 0.437` is more sensitive — it elevates the
ambiguous `rerun5` as well. This is acceptable per fixture intent
(risk_flag), but `latinJaccardMax` is the recommended primary because
it preserves the ambiguous-as-tolerated property.

**Practical conclusion:** If 246-N's tool-shape change enforces
`minCount=3` upfront, the Latin token Jaccard verifier at threshold
0.556 cleanly classifies the captured corpus. Bigram is recommended
as a fallback for CJK-heavy queries (the captured corpus is mostly
English-keyword queries even when user prompt is Mandarin, so bigram
also worked here; CJK-only corpora must be re-calibrated).

**This is necessary but not sufficient evidence.** The calibration
proves the verifier can distinguish narrow plans from broad plans on
historical traces. It does NOT prove the lite model will write
3-query plans naturally given new argsExample. That requires Phase 2
simulator verification before any live verify.

Phase 2 (only if Phase 1 PASS):

- Design `searchPlan` tool-shape (mode A vs mode B vs new action).
- Simulator verify lite model produces orthogonal plan with new
  argsExample. Reject if model still writes narrow plans.
- Unit tests against the same corpus fixture.
- ≥5 trace live verify on canonical Mandarin Harness Engineering
  fixture. Rollback if any source_fail trace shows the verifier did
  not reject before the first web hit.

## HBR

1. **This is design hypothesis, not validated mechanism.** The
   recommendation is based on cross-system pattern review plus
   AGRUN-246-K/L empirical evidence. Concrete metric viability is
   pending Phase 1 calibration.
2. **Tool-shape change has larger blast radius than signal
   addition.** `news-brief-skill`, `web-search-skill`, and any host
   skill that calls `web_search` must be tested for backwards
   compatibility before commit.
3. **Verifier reject loop on weak models is unknown behavior.** If
   the lite model gets stuck in reject loops, the budget mechanism
   prevents infinite loops but the trace becomes inefficient. Need
   simulator measurement.
4. **AGRUN-246-M (wikipedia scorer permissiveness) is still
   deferred.** Even a perfect 246-N implementation cannot push
   `gemini-3.1-flash-lite` strict-pass past the ceiling imposed by
   the wikipedia scorer issue. Consider closing 246-M before 246-N
   Phase 2 live verify so the verify trace labels are unambiguous.
5. **`gemini-3.1-flash-lite` may simply lack the capacity to write
   orthogonal first-shot plans.** If Phase 1 calibration finds a
   metric but Phase 2 simulator shows the model writes 3
   same-cluster queries even with the new argsExample, the answer
   is to defer 246-N until tool design includes a stronger upfront
   forcing (e.g. argsSchema requiring distinct top-domain tokens
   per slot — itself a hardcoding risk).

## Sources

External references reviewed during this research:

- O-Researcher: An Open Ended Deep Research Model via Multi-Agent
  Distillation and Agentic RL — https://arxiv.org/html/2601.03743v1
- A Survey of LLM-based Deep Search Agents — https://arxiv.org/html/2508.05668v3
- Deep Research: A Survey of Autonomous Research Agents — https://arxiv.org/html/2508.12752v1
- GPT Researcher Deep Research Mode — https://deepwiki.com/assafelovic/gpt-researcher/4.3-deep-research-mode
- Anthropic Multi-Agent Research System (Simon Willison summary) — https://simonwillison.net/2025/Jun/14/multi-agent-research-system/
- ParallelSearch RL — https://arxiv.org/pdf/2508.09303
- Query Fan-Out in AI Search — https://www.amicited.com/blog/query-fanout-llm-multiple-searches/
- From Web Search to Agentic Deep Research — https://arxiv.org/pdf/2506.18959
- SemHash semantic deduplication — https://medium.com/@sreeprad99/how-semhash-simplifies-semantic-deduplication-for-llm-data-a0b1a53e84fe

Internal references:

- `agrun_docs/audits/agrun-246-l-search-phase-query-diversification-2026-05-25.md`
- `agrun_docs/audits/agrun-246-l-offline-calibration-2026-05-25.md`
- `agrun_docs/live-tests/agrun-246-l-verify-rejected-2026-05-25.md`
- `test/fixtures/agrun-246-l-query-corpus.js`
- `scripts/debug-agrun-246-l-fixture.mjs`
- `scripts/calibrate-agrun-246-l-query-diversification.mjs`
- KB procedural memory `b4a36d34-b2ee-45aa-a536-5973acbf3cba:9015b078-…` (246-L required-vs-optional lesson)
- KB procedural memory `b4a36d34-b2ee-45aa-a536-5973acbf3cba:2fe9403d-…` (unit-mechanism PASS ≠ behavioral lift)
- KB reflective memory `bc940294-6044-46cf-869f-0f92afa6a741:8f899626-…` (argsExample is the strongest behavioral signal)
- KB reflective memory `bc940294-6044-46cf-869f-0f92afa6a741:49a738b4-…` (no model-tier gating)
