# AGRUN-246-L — Offline Query-Diversification Calibration 2026-05-25

## Scope

Calibrate AGRUN-246-L before any runtime code change. The goal is to test
whether the captured AGRUN-246-K 7-trace query corpus can support a generic
search-phase diversification signal.

This is **offline evidence only**. No runtime code was changed.

## Corpus

Command:

```bash
node scripts/calibrate-agrun-246-l-query-diversification.mjs
```

Corpus:

| Label | Runs |
|---|---:|
| Strict pass | 3 |
| Source fail | 3 |
| Ambiguous source-pass / structure-fail | 1 |

The ambiguous run is `2026-05-25T01-57-51-053Z`. It passed the source gate
but failed structure, and the distribution doc already flags a likely
wikipedia-scorer false-positive issue. Treat it as a held-out risk case, not
as a clean negative.

## Extracted Initial Queries

| Run | Label | First web_search queries |
|---|---|---|
| baseline | strict_pass | `Harness Engineering AI Agent systems definition` / `AI agent harness design patterns reliability production` |
| rerun1 | strict_pass | `Harness Engineering in AI Agent systems evaluation framework` / `AI agent framework design harness patterns principles` / `AI agent control patterns guardrails orchestration frameworks` |
| rerun2 | source_fail | `Harness Engineering AI agents evaluation frameworks definition` / `AI agent systems evaluation harness engineering framework` / `AI agent evaluation harness framework architecture patterns` |
| rerun3 | strict_pass | `Harness Engineering in AI agent systems evaluation frameworks` / `AI agent harness engineering architecture components guides sensors` / `AI agent control system architecture design patterns` |
| rerun4 | source_fail | `Harness Engineering in AI Agent systems concept` / `test harness for AI agents evaluation framework` |
| rerun6 | source_fail | `Harness Engineering AI agent systems evaluation framework` / `what is 'Harness Engineering' in AI agent systems evaluation` |
| rerun5 | ambiguous | `Harness Engineering in AI Agent Systems meaning` / `test harness design for LLM autonomous agent systems evaluation framework` / `AI agent evaluation framework testing harness architecture` |

## Calibration Result

### Candidate 1 — Pure Token-Overlap Ratio

Rejected.

Pure token overlap does not separate the clean labels:

- `rerun4` is a source-fail run but has first-2 overlap `0.00` because its
  two queries use different words while staying inside the same broad
  misinterpretation.
- `rerun1` is a strict-pass run but has first-2 overlap `0.20` and would be
  easy to false-positive if the threshold is low enough to catch all failures.

Conclusion: raw token overlap is too shallow. It measures string reuse, not
query-angle diversity.

### Candidate 2 — Fixture Anchor Rule

Diagnostic only, not runtime-safe.

A fixture-specific rule can separate the clean labels:

- trigger when an evaluation/test/framework cluster appears in the first
  searches and no broadening angle appears;
- do not trigger for strict-pass runs that introduce production/reliability,
  control/guardrails/orchestration, components/sensors, or case/example
  angles.

This also flags the ambiguous rerun5, which is acceptable diagnostically
because rerun5 is not a clean pass. However, this rule depends on
topic-specific English anchor tokens. Shipping those tokens in runtime would
violate the AI-first/no-hardcode direction.

Conclusion: useful for explaining the trace, not acceptable as the runtime
SSOT.

## Calibrated Direction

Use AI-declared query-angle diversity instead of runtime-authored topic
anchors.

Proposed next implementation shape:

1. Extend `web_search` action args with an optional AI-authored
   `queryAngle` / `queryIntent` field.
2. Runtime stores the first 2-3 search declarations and raw queries as facts.
3. Runtime exposes `search_query_diversification_signal` when the first
   searches repeat the same declared angle or declare too few distinct angles.
4. Signal is advisory only:
   - no auto-blocking `web_search`;
   - no auto-issued alternate query;
   - no runtime rewrite of user prompt or query;
   - no topic-specific token allowlist/denylist.

This preserves harness engineering: runtime exposes trace facts and repeated
declarations; AI owns the interpretation and the next search.

## Acceptance Update

Before any runtime implementation:

- Add a replay fixture around the 7 captured query sets.
- The fixture should prove:
  - clean strict-pass runs do not elevate after their first search set;
  - source-fail runs elevate before first `read_url`;
  - rerun5 is treated as ambiguous/high-risk, not as a clean negative.
- The signal logic must not include topic-specific tokens such as
  `guardrails`, `orchestration`, `evaluation`, or `framework` as hardcoded
  outcome criteria.

After implementation:

- Run >=3 canonical Mandarin live reruns before commit.
- Required live gate remains 3/3 strict pass or a clearly documented reject
  with rollback, following the AGRUN-246-K lesson.

## HBR

- The original 246-L research doc was too optimistic about token-overlap
  homogeneity. The offline data shows raw token overlap is not strong enough.
- A lexical anchor rule can fit this tiny corpus but would be hardcoded and
  should not ship.
- Rerun5 remains a messy data point: source gate passed, but the query set is
  still clustered and the run failed structure. This supports keeping the
  wikipedia-scorer permissiveness issue separate.
