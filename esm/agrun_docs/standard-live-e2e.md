# Standard Live E2E Test Suite (Node.js, real API keys)

> **This is THE standard.** Every release-worthy change runs these four scenarios
> across all 3 providers (openai, gemini, deepseek — keys in `.env.local`).
> One provider passing is NOT verified (project testing rule).

## The four standard scenarios

| # | Scenario | Command | What it proves |
|---|----------|---------|----------------|
| 1 | **Short 150 words** (web_search + read_url, cited) | `node test/live-standard.mjs --tier short` | tools + skills + fast turnaround |
| 2 | **Long 1500 words** (Harness Engineering research report) | `node test/live-standard.mjs --tier long` | long-run research + publish contract |
| 3 | **Deep research 1200 words** (RAG in production; topic fixed for trend comparability) | `node test/live-standard.mjs --tier research` | mid-size research, ≥3 citations |
| 4 | **Multi-turn conversation** (8 turns: greeting → calculation → history → ML topic → **today's news via web_search** → host-time echo → recall → summary) | `node test/live-multiturn-standard.mjs --provider all` | session memory, tool-silence on chat turns + web_search on the news turn, secret boundary, wire-level payload capture |

Full matrix in one command each:

```bash
npm run test:live:standard             # scenarios 1–3, all models (12 cells)
npm run test:live:multiturn-standard   # scenario 4, openai+gemini+deepseek
npm run test:live:agent-sdk-benchmark  # agrun vs OpenAI Agents SDK (see below)
```

Model roster (cheap tier, fixed knobs): `gpt-5.4-mini` (reasoningEffort low),
`gemini-3.1-flash-lite` (thinkingLevel low), `deepseek-v4-flash` (high + default A/B twin).

The same 8-turn script is the **browser example UI standard**: drive it through
the real chat UI (localhost dev server; Chrome DevTools MCP or by hand), expect
per-turn direct answers, cross-thread recall ("WeiJun, 547"), and a searched
news answer with source URLs. 2026-07-03 note: the news turn depends on the
host web-search backend — a SearXNG instance returning 0 JSON results fails
openai/deepseek news turns honestly (gemini passes via gemini_grounding).

## agrun vs OpenAI Agents SDK (static comparison)

`examples/agent-sdk-benchmark/bench-multi-provider.mjs` runs the SAME prompts
through agrun (3 providers) and the OpenAI Agents SDK on three tiers
(ping-pong / 150-word / 1500-word), printing wall-clock + token table and
writing a timestamped JSON.

`bench-multiturn.mjs` (`npm run test:live:agent-sdk-multiturn`) runs the SAME
7-turn conversation (greeting, name memory, calculation, history, ML topic,
cross-turn recall, summary) through agrun sessions at three profiles (default
surface / tools stripped / tuned: no extraction call + responses/low) and the
SDK's MemorySession, same model both sides. 2026-07-03 baseline: all four 7/7
correct incl. recall; agrun tuned 20.9 s beats the SDK's 32.9 s; agrun
untuned default 117 s — the gap is configuration (per-turn memory-extraction
call + default reasoning effort), not the runtime loop.

## Artifacts & trend

- Scenario 1–3: `test/live-standard-out/SCORECARD.md` + append-only
  `scorecard-trend.jsonl` (history since 2026-06-08 — old vs latest is a
  `jq`/python group-by over this file).
- Scenario 4: `test/live-observe-out/multiturn-standard-<provider>-<stamp>.md`
  (+ `.summary.json` + redacted request/response `.jsonl` wire trace).
- SDK comparison: `examples/agent-sdk-benchmark/bench-multi-provider-results.<stamp>.json`.

## Result snapshot (2026-07-03, post performance-arc)

2026-07-03 full 12-cell run: **12/12 completed, 0 crashes** (first matrix run was
3/6 failed on 2026-06-08). Multi-turn: passed on all 3 providers (7/7 turns,
exactly 1 LLM call per turn, recall turn recovers the turn-2 fact — post AGRUN-586).

Long tier, before vs after the 2026-07-02 performance arc (same cells):

| Cell (long 1500w) | 2026-06-26 (pre-arc) | 2026-07-03 | Δ wall |
|------|------------------|--------|---|
| openai gpt-5.4-mini | 3.14 min, 423k tok, $0.285 | 2.85 min, 262k tok, $0.204 | −9%, −38% tok |
| gemini flash-lite | 5.72 min, 1236k tok, $0.251 | 2.40 min, 649k tok, $0.108 | −58%, −47% tok |
| deepseek high | 13.02 min, 660k tok | 8.62 min, 397k tok | −34% |
| deepseek default | 9.89 min, 434k tok | 5.08 min, 363k tok | −49% |

Short tier trend (first recorded vs latest):

| Cell (short 150w) | 2026-06-08 (old) | latest | Δ |
|------|------------------|--------|---|
| openai | failed, 3.0 min, 524k tok, $0.298 | pass, 0.96 min, 170k tok, $0.079 | 3× faster, −67% tok |
| gemini | failed, 2.0 min, 473k tok, $0.090 | pass, 0.61 min, 132k tok, $0.022 | 3× faster, −72% tok |
| deepseek | failed, 3.1 min, 181k tok | pass, 2.3–5.1 min | pass + stable |

Research tier (new 2026-07-03 baseline): openai 0.95 min/$0.068, gemini 1.43 min/$0.065
(qScore 100), deepseek default 8.6 min/$0.055, deepseek high 15.4 min/$0.083 —
deepseek research cells are the slow tail; watch the trend.

vs OpenAI Agents SDK (2026-07-03 run): agrun+gemini ping-pong 872 ms beats the
SDK's 1677 ms; agrun+openai still carries ~5–6k prompt tokens vs the SDK's ~50
(absorbed 75–99% by provider caches — see
`agrun_docs/audits/why-other-agents-feel-fast-2026-07-02.md`); on 150/1500-word
tiers wall-clock is output-token dominated, agrun ≈ SDK + 3–4 s.

Known variance: deepseek long-form can degenerate (repetition / short answer,
one 220 s outlier on 2026-07-03) — tracked, not a runtime regression.
Known variance: openai gpt-5.4-mini is stochastically non-convergent on the
news (search-then-answer) turn — passes some minutes, budget-dies or refuses
others; low and medium effort behave alike; every systematic hypothesis
(parser, observer, hosted-tool, infra) was eliminated by experiment
(AGRUN-596). gemini + deepseek are the expected-green rows for that turn.

## What this standard has caught

- **AGRUN-586 (2026-07-03)**: the new multi-turn recall turn failed on ALL 3
  providers simultaneously → root cause: provider conversation silently kept
  only the last 6 messages (3 exchanges) while the compaction summary only
  forms under token pressure — turns 4+ back were unrecallable in every
  session chat. Fix: carry the whole post-summary window; budget evaluation
  now counts conversation tokens so compaction still bounds growth.

## Rules

- Always test the shipped bundle (`npm run build` first) unless bisecting with `--src`.
- Never commit result artifacts; commit only doc/task updates.
- A change verified on one provider is not verified (see `AGENTS.md`).
