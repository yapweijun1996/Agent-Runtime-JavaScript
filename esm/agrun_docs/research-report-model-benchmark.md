# agrun 3-Way Research-Report Benchmark — Results

**Date:** 2026-06-05 · **Runtime:** `dist/agrun.js` in Node · **Task:** one identical
~3000-word research report ("The State of On-Device / In-Browser LLM Inference in
2026"), web_search + read_url allowed, `maxSteps=60`, same prompt/systemPrompt/policy.
Only the model + its "thinking low" knob varied.

## Performance (measured)

| Model | Thinking | Wall time | Tokens | Steps | Searches/Reads | Words | Outcome |
|---|---|---|---|---|---|---|---|
| deepseek-v4-flash | none (non-thinking) | **27.0 min** | 1.07M | 50 | 4 / 9 | 3094 | full report |
| gemini-3.1-flash-lite | thinkingLevel: low | 4.4 min | 1.15M | **60 (cap)** | 2 / 4 | **135** | **truncated** at step cap |
| gpt-5-mini | reasoningEffort: low | **13.5 min** | **0.77M** | 46 | **10** / 7 | 3092 | full report |

Gemini hit the 60-step budget still in research phase (item 2 of 5) and emitted
agrun's "pause & resume" checkpoint stub, not a report. A fairness re-run with
`maxSteps=120` was done separately (see metrics-gemini-rerun.json).

### Gemini fairness re-run (maxSteps=120)

Gemini produced a full 3038-word report — but needed **double the step budget,
11 min wall, and 2.30M tokens (3× gpt-5-mini, 2× deepseek)**. Quality (judged as
Report C): rubric **overall 5.0/10** (topicCoverage 8, accuracy 7, depth 5,
structure **3**, grounding **3**, length 9). Citations: 3 real reachable URLs,
no fabrication, but **zero inline citations** (bare end-list only) and severe
structural redundancy (WebGPU/quantization/runtimes each explained 2–3×). It
**lost both order-controlled head-to-heads vs gpt-5-mini at HIGH confidence**.

## Quality (anonymized A/B judging: citation audit + rubric + 2 order-controlled head-to-heads)

- **Rubric overall:** A (deepseek) 6.8 / B (gpt-5-mini) 6.8 — a tie.
- **Grounding audit:** B 8/10, A 7/10. Both cite real, reachable, on-topic URLs.
- **Head-to-head:** B won **both** runs (medium, then high confidence).
- **Decisive finding:** the second judge fetched the shared WebLLM arXiv paper
  (2412.15803). DeepSeek **fabricated** numbers attributed to it — invented a
  first-token-latency figure, wrong hardware (M2 vs M3 Max), understated
  throughput (claimed "up to 20 tok/s" vs the paper's 41–71 tok/s). GPT-5-mini
  hedged its numbers honestly and its 4-source bibliography all resolved.

## Final 3-Way Ranking

**1. gpt-5-mini (reasoningEffort: low) — OVERALL WINNER.** Best grounding (8/10),
won **all four** head-to-heads (2 vs deepseek, 2 vs gemini), and the most
*efficient* by far: ~13.5 min, 0.77M tokens, the most real research (10 searches),
completed inside the 60-step budget. Weaker on raw depth (qualitative ranges) and
one fp16-memory slip. Ship-grade for production research.

**2. deepseek-v4-flash (non-thinking) — RUNNER-UP.** Rubric tied at 6.8 and the
most *impressive-reading* (deepest numbers, broadest runtime coverage), but lost
to gpt-5-mini because its headline figures are **fabricated** (invented numbers
attributed to a real arXiv paper). Also slowest (27 min) and most tokens of the
two clean runs (1.07M). Best for breadth/first-draft where a human fact-checks
every figure.

**3. gemini-3.1-flash-lite (thinkingLevel: low) — THIRD.** Did not converge in 60
steps (truncated stub); with 120 steps it finished but at **3× the token cost**,
and the report is the weakest on structure and grounding (rubric 5.0), losing
both head-to-heads to the winner at high confidence. Fast per step, but poor
convergence + heavy redundancy make it the least suited to this task as-configured.

**Bottom line — quality AND performance both point to `gpt-5-mini`.**

### Caveats
- N=1 per model — indicative, not definitive.
- "Thinking low" applies only to gemini + gpt-5-mini; deepseek-v4-flash is
  non-thinking. Inherent asymmetry in the request.
- Citation audit verified reachability + topicality, not every one of ~40 claims;
  DeepSeek's fabrication was caught only because both reports cited the same paper.
