# Model Comparison — Live Observation Benchmark 2026-06-06

## Simple Web Search Task

Same task across all models: "Use web_search to find latest Node.js LTS version, reply in ONE sentence".

| model | wall | steps | reqs | stuck | cost | tokens | quality |
|-------|------|-------|------|-------|------|--------|---------|
| **gm-lite-low** | **5.8s** | 47 | 3 | 1 | $0.0048 | 18k | ✅ |
| **gm-lite-med** | **6.0s** | 47 | 3 | 1 | **$0.0046** | 17k | ✅ |
| gm-lite-high | 13.4s | 47 | 3 | 1 | $0.0047 | 17k | ✅ |
| ds-flash-high | 51.7s | 73 | 4 | 2 | $0.0049 | 31k | ✅ |
| ds-pro-high | 62.1s | 73 | 4 | 2 | $0.0143 | 30k | ✅ |

**Winner**: Gemini flash-lite medium — 10× faster than DeepSeek, half the tokens, same quality.

### Key Findings

1. **GPT-5.4-mini high is best overall for simple tasks** — 5.0s, $0.0115, 14k tokens. Fastest + fewest tokens.
2. **Gemini flash-lite cheapest** — $0.0046–$0.0048, ~6s. Best for cost-sensitive deployments.
3. **Gemini 3.5 flash is WORSE than lite on simple tasks** — 3–6× slower (20–34s), 2–3× more tokens (29–51k), 2–4× more stuck (2–4). Don't use for simple tasks.
4. **DeepSeek thinking models slow on simple tasks** — 10× slower (51–62s), double-request pattern. Only use for complex agent/report tasks.
5. **AGRUN-310 verified fixed** — rpr=0 on post-fix runs (gm35, gpt), confirms ghost events eliminated
6. **Remaining stuck source: `action-pattern-convergence-refreshed`** — ALL models show this on simple tasks. Next investigation target.
3. **All models still show stuck≥1** — even after AGRUN-310 fix. Other stuck signal sources remain (action-pattern-convergence, invalid-action)
4. **thinkingLevel low/medium/high on Gemini** — low and medium are near-identical (6s), high is 2× slower (13s) but same quality. Low is the sweet spot.

## Research Report Task (from TNO Benchmark, 2026-06-05)

~3000-word management/ERP research report with web_search + read_url.

| model | wall | cost | tokens | words | sources | status |
|-------|------|------|--------|-------|---------|--------|
| **gpt-5.4-mini high** | **9.6min** | $0.526 | 438k | ✅ | ✅ | ✅ quality leader |
| deepseek-v4-flash high | 31.2min | $0.168 | 1,504k | ✅ | ⚠️ fact risk | completed |
| deepseek-v4-pro low | 13.8min | $0.113 | 391k | 3404 | ⚠️ fact risk | completed |
| gemini-3.1-flash-lite high | 37.9min | $1.358 | 7,194k | 3091 | ✅ | duplicated sections |
| gemini-3.5-flash low | 24.5min | $4.467 | 2,765k | 3071 | ✅ | most expensive |
| gemini-3.5-flash medium | 12.1min | N/A | 1,500k | — | — | stuck, no report |

## Research Report Task (from Benchmark #3, 2026-06-05)

~3000-word browser-LLM inference research report.

| model | wall | cost | tokens | words | status |
|-------|------|------|--------|-------|--------|
| deepseek-v4-pro low | 13.8min | $0.113 | 391k | 3404 | cheapest, fast |
| gpt-5.4-mini low | 29.9min | $2.008 | 2,305k | 3018 | safest quality |
| gemini-3.1-flash-lite high | 37.9min | $1.358 | 7,194k | 3091 | heavy churn |
| gemini-3.5-flash low | 24.5min | $4.467 | 2,765k | 3071 | most expensive |

## Production Recommendations

### Simple tasks (single tool call, short answer)
- **Gemini flash-lite low/medium** — fastest, cheapest, same quality
- Avoid DeepSeek thinking models for simple tasks (10× slower, same result)

### Research reports (multi-source, long-form)
- **gpt-5.4-mini high** — quality leader ($0.53, 10min) — but must use `researchActivation: "long_research"`
- **deepseek-v4-flash high** — cheapest completed ($0.17) but 3× slower (31min) and needs fact-checking
- **deepseek-v4-pro low** — fastest/cheapest draft ($0.11, 14min) but mandatory source verification
- **Gemini flash-lite** — risky: heavy publish/repair churn, duplicated sections, expensive ($1.36-$4.47)

### DeepSeek Thinking Configuration
- `reasoning_effort`: low/medium/high are effectively the same for DeepSeek — use `high` or `xhigh` (max) only
- Thinking ON causes double-request pattern (think→act) — each tool call = 2 API requests
- Simple tasks: turn thinking OFF
- Complex agent/report: use `high` (or `xhigh` for deep research)

### Gemini Thinking Configuration  
- `thinkingLevel`: low and medium near-identical in speed/quality — use `low` as sweet spot
- `high` is 2× slower with no quality benefit on simple tasks
- For reports: low/medium have heavy churn; high produces better structure

## AGRUN-310 — False terminal-repair events (fixed)

Three `terminal-repair-state-refreshed` emission sites used `if (repair)` instead of `if (repair && repair.active === true)`, emitting ghost events every cycle with `activeDeficits=[]`, `reason=null`. Fixed in `cf574068`. TNO's "504 terminal-repair refreshes" likely inflated by these ghost events.

---

*Data sources: live-observe 2026-06-06 (simple task), TNO benchmark 2026-06-05 (report), benchmark #3 2026-06-05*
