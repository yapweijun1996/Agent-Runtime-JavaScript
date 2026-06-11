# agrun Research-Report Benchmark #2 — Thinking-Knob + Cost Study

**Date:** 2026-06-05 · **Runtime:** `dist/agrun.js` in Node · **Task:** one identical
~3000-word research report ("The State of On-Device / In-Browser LLM Inference in
2026"), web_search + read_url allowed, `maxSteps=120`, same prompt/system/policy.
Only the model + its thinking knob varied.

Harness: `test/bench-one.mjs` (parameterized; intercepts every provider HTTP call
to tally true input/output/cache-hit/reasoning tokens, since agrun's ledger only
aggregates totalTokens). Pricing per 1M tokens fetched 2026-06-05 (DeepSeek
flash $0.14/$0.28, pro $0.435/$0.87 + cache-hit ~50× cheaper; Gemini 3.1
flash-lite $0.25/$1.50; gpt-5.4-mini $0.75/$4.50).

## Token-accuracy note (honesty)

The fetch-tally was validated to match the ledger exactly on short calls for all
three usage shapes. On the long runs:
- **deepseek-v4-pro**: tally 842,994 == ledger 842,994 → **fully trustworthy**.
- **gpt-5.4-mini** (responses API): tally 680,095 vs ledger 590,357 (~15% gap,
  `total_tokens` includes reasoning differently). Cost uses directly-scraped
  input/output → trustworthy.
- **gemini-3.1-flash-lite** (SDK): tally 6,528,264 vs ledger 4,876,985 (~25% gap;
  Google sometimes returns cumulative usageMetadata). Real total is in
  4.9M–6.5M; cost is therefore a range ~$0.95–$1.27 — still the most expensive
  either way.

## Performance + Cost (the 4 clean data points)

| Config | Thinking | Wall | Total tok | cacheHit | out | reason | **Cost (USD)** | Words | Outcome |
|---|---|---|---|---|---|---|---|---|---|
| **gpt-5.4-mini** | effort low | **6.7 min** | 680K | 218K | 52K | 10K | **$0.557** | 2982 | ✅ clean |
| deepseek-v4-pro | reasoning **max** (xhigh) | 37.4 min | 843K | 168K | 96K | 80K | **$0.336** (lowest) | 3147 | ✅ clean |
| gemini-3.1-flash-lite | thinking **high** (220 steps) | 34.2 min | 4.9–6.5M | 1.5M | 80K | 464K | **~$0.95–1.27** (highest) | 3147 | ✅ but needed 2× step budget |
| gemini-3.1-flash-lite | thinking **high** (120 steps) | 15.4 min | 2.5M | 454K | 35K | 215K | ~$0.41–0.51 | **136** | ❌ truncated stub |

Cost breakdown insight: DeepSeek is cheapest because its **output price ($0.87/M)
is 5× below gpt ($4.50/M) and its token total stays modest**. Gemini is dearest
because thinking-high made it emit **6M+ tokens** (464K reasoning) — input cost
dominates. gpt is mid: expensive output price but very few output tokens (52K).

## Quality (anonymized: citation audit w/ live URL fetch + rubric + head-to-head)

| Config | Rubric /10 | Citation grounding /10 | Fabrication | Head-to-head vs gpt |
|---|---|---|---|---|
| **gpt-5.4-mini low** | **6** | **9** | none | — (baseline) |
| deepseek-v4-pro max | 5 | **2** | **SEVERE** | **lost** |
| gemini high (220 steps) | **4** | 3 | none (but numbers unsourced) | **lost** |

- **gpt** wins both head-to-heads. Honest, clean, well-grounded — but shallow
  (qualitative; a "Concrete trade-offs" section with no hard numbers).
- **deepseek-pro** reads most impressive (deepest numbers, broadest coverage) but
  **fabricated its headline numbers**: invented a TTFT figure, wrong hardware
  (M2 vs the paper's M3 Max), throughput the WebLLM arXiv paper never states,
  a falsely-claimed HTTP 404, a picovoice blog mislabeled as ONNX docs, and a
  citation `[5]` used 6× but absent from Sources. This is the **2nd consecutive
  benchmark** where a DeepSeek model fabricated specific figures.
- **gemini high** is a stitched, duplicated draft (conclusion mid-document,
  mismatched section numbering, runtimes/outlook repeated 3–7×) — thinking-high
  made it spin and pad, not improve.

## Verdict

**Overall winner: gpt-5.4-mini (reasoningEffort low)** — fastest (6.7 min),
highest quality, most trustworthy citations, mid cost. Ship-grade.

**Cost winner: deepseek-v4-pro ($0.336)** — cheapest and most complete, but
**fabricates numbers** → only safe with human fact-checking. "DeepSeek is cheap"
is confirmed (low output price), but cheap ≠ trustworthy.

**Worst value: gemini-3.1-flash-lite thinking high** — most expensive, slowest of
the lite tier, lowest quality, and needed 2× the step budget to not truncate.

## Key findings

1. **Higher thinking ≠ better.** gemini thinking-high was a disaster (spun, padded,
   $1.27, needed 220 steps). deepseek max-thinking fabricated *more*, not less.
2. **DeepSeek systematically fabricates specific numbers** in research reports
   (2 benchmarks, flash + pro, every thinking level). Best for breadth/first-draft
   under human review; not for trustworthy production research.
3. **Thinking cost is multiplicative.** reasoning_effort xhigh → 55–65 s *per* LLM
   call (vs 3–4 s at low); across ~50 agentic calls that's 45–55 min.
4. **DeepSeek's agrun slowness is two independent factors:** thinking-knob AND a
   many-step research loop with slow read_url fetches. Dropping to medium removes
   factor 1 but not factor 2 — so DeepSeek stays far slower than gpt regardless.
5. **Single-account concurrency rate-limits.** 4 concurrent DeepSeek runs on one
   key 429-throttled each other; flash-max stalled 53 min, the medium runs never
   converged in 47 min. Production with concurrent users on one key needs queueing
   or multiple keys.
6. **reasoning_effort support (DeepSeek V4):** only `low/medium/high/xhigh`
   (none/minimal/ultra rejected 400). low~high barely differ; xhigh is the real
   "max" switch.

## Not completed (and why)

deepseek-v4-flash-max, deepseek-v4-flash-medium, deepseek-v4-pro-medium were all
killed after 47–53 min: single-account rate-limiting + `maxSteps=120` letting
DeepSeek run a long non-converging research loop. The "is medium faster?" question
is answered qualitatively by finding #4: medium removes the per-step thinking cost
but not the multi-step + read_url overhead, so it is NOT dramatically faster in
agrun for this task. A clean medium data point was not obtained.
