# Research Report Model Benchmark 3

Date: 2026-06-05  
Runtime: `dist/agrun.js` through Node.js  
Harness: `test/bench-one.mjs`  
Artifact directory: `test/benchmark-out4/`  
Task: identical 3000-word research report on on-device / in-browser LLM inference in 2026.  
Cost note: USD costs are benchmark estimates from the local price table in `test/bench-one.mjs`, not provider billing invoices.

## Decision

Production default for trusted research reports: **`gpt-5.4-mini` low**.

Cheap draft option: **`deepseek-v4-pro` low**, but only with mandatory source verification.

Do not use as default for this workload:
- `deepseek-v4-pro` medium: failed with no report.
- `gemini-3.1-flash-lite` high: too much repair churn and duplicated final structure.
- `gemini-3.5-flash` low: highest estimated cost with no clear quality win.

## Live Results

| Rank | Run | Status | Time | Est. Cost | Ledger Tokens | Usage Tokens | Calls | Words | Cost / 1k Words | Notes |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | `gpt-5.4-mini-low` | completed | 29.93 min | $2.00762 | 2,060,108 | 2,304,846 | 125 | 3,018 | $0.665 | Best final quality and safest production pick. |
| 2 | `deepseek-v4-pro-low` | completed | 13.77 min | $0.11342 | 391,261 | 391,261 | 25 | 3,404 | $0.033 | Fastest and cheapest, but source/fact risk is high. |
| 3 | `gemini-3.1-flash-lite-high` | completed | 37.91 min | $1.35788 | 5,158,486 | 7,194,305 | 301 | 3,091 | $0.439 | Heavy churn; final report duplicates sections. |
| 4 | `gemini-3.5-flash-low` | completed | 24.48 min | $4.46666 | 2,289,587 | 2,765,430 | 136 | 3,071 | $1.454 | Most expensive; verbose but not clearly better. |
| 5 | `deepseek-v4-pro-medium` | failed | 12.39 min | $0.02120 | 105,958 | 105,958 | 7 | 0 | n/a | Failed; no usable output. |

## Quality Review

### GPT

`gpt-5.4-mini-low` produced the most conservative and source-aligned report. It avoided many unsupported benchmark-style numbers and framed browser LLM inference as a hybrid architecture, which is the most realistic production conclusion.

Risk: this run took almost 30 minutes and used more than 2M ledger tokens, so cost and latency are not ideal.

### DeepSeek

`deepseek-v4-pro-low` was the strongest on speed and price. However, the report has only one final source URL while making many exact performance claims. Earlier benchmark memories already showed the same DeepSeek pattern: fluent output can contain invented or weakly supported numbers.

Risk: good-looking report can hide factual errors.

### Gemini

`gemini-3.1-flash-lite-high` completed, but the trace shows the worst convergence pattern: 301 provider calls, 215 cycles, and hundreds of workspace read/review actions. The final report also repeats major sections.

`gemini-3.5-flash-low` completed faster than GPT in wall time, but cost was highest and the final quality did not justify it.

Risk: Gemini long-report runs need stronger early-stop / convergence control before production use.

## Observability Finding

The new SSE-like JSONL progress files made the benchmark much easier to debug. Final metrics alone would not show why Gemini and GPT were slow. The trace showed repeated action loops:

- `workspace_review_candidate`
- `workspace_replace`
- `workspace_read`
- `finalize`
- `workspace_publish_candidate`

This is the right observability pattern for future model tests.

## Harness Follow-up

1. Keep progress JSONL as the standard live benchmark output.
2. Add an early-stop policy for high token burn with no material candidate improvement.
3. Add automated duplicate-section scoring to the benchmark report review.
4. Add source-strength scoring: unique URLs, primary-source count, and unsupported exact-number detection.
5. Re-test DeepSeek medium separately before considering it again.

## Artifact Files

Benchmark report:
- `test/benchmark-out4/BENCHMARK-RESULTS.md`

Metrics:
- `test/benchmark-out4/metrics-gpt-5.4-mini-low.json`
- `test/benchmark-out4/metrics-deepseek-v4-pro-low.json`
- `test/benchmark-out4/metrics-deepseek-v4-pro-medium.json`
- `test/benchmark-out4/metrics-gemini-3.1-flash-lite-high.json`
- `test/benchmark-out4/metrics-gemini-3.5-flash-low.json`

Generated reports:
- `test/benchmark-out4/report-gpt-5.4-mini-low.md`
- `test/benchmark-out4/report-deepseek-v4-pro-low.md`
- `test/benchmark-out4/report-deepseek-v4-pro-medium.md`
- `test/benchmark-out4/report-gemini-3.1-flash-lite-high.md`
- `test/benchmark-out4/report-gemini-3.5-flash-low.md`
