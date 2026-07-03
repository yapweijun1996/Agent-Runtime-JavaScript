# Standard Live-Test Method (general agent runtime monitoring)

The single, repeatable way to monitor agrun — the **general agent runtime** — for
**output quality, cost, and time spent** across providers and task sizes, using
real APIs and the shipped `dist/agrun.js`.

> Why this exists: scattered one-off benchmarks (`bench-one.mjs`, `live-observe.mjs`,
> per-task batch scripts) all measured pieces of this, but there was no single
> standard scorecard. And the runtime's machine quality gates once scored a report
> 100/100 that repeated whole paragraphs — so a numbers-only scorecard lies. This
> method fixes both: one fixed matrix, one scorecard, plus text red-flags that tell
> a human **which reports to actually read**.

## What it proves

agrun is a general agent runtime that supports **agent skills, roles, and
long-running tasks**. The matrix exercises all of that:

- **short tier** — a skill + `web_search` + `read_url` task (skills/roles/tools path).
- **long tier** — a 1500-word research report (long-run + workspace + convergence). A faster/cheaper variant of the GOAL.md task; the formal 3000-word acceptance test stays in `test/node-agrun-3000-live.mjs`.

## The fixed matrix

3 cheap models × 2 task tiers = 6 cells. Thinking/effort is fixed per the project
standard (cheap tier, low effort; DeepSeek's cheap tier only supports high):

| provider | model | effort/thinking | priceKey |
|----------|-------|-----------------|----------|
| openai   | gpt-5.4-mini          | reasoningEffort = **low**  | gpt-5.4-mini |
| gemini   | gemini-3.1-flash-lite | thinkingLevel = **low**    | gemini-3.1-flash-lite |
| deepseek | deepseek-v4-flash     | reasoningEffort = **high** | deepseek-v4-flash |

| tier  | output target | maxSteps | per-call timeout | run deadline |
|-------|---------------|----------|------------------|--------------|
| short | ~150 words    | 40       | 120 s            | 5 min |
| long  | 1500 words    | 90       | 240 s            | 20 min |

Per-call timeout is generous on purpose: a slow OpenAI call must not be recorded
as a quality regression (a real false-fail seen on gpt-5.4-mini with the default
timeout). Per-call timeout and whole-run deadline are separate (`cfg.timeoutMs`
vs `cfg.runDeadlineMs`).

## How to run

```bash
npm run build                       # always test the latest bundle
npm run test:live:standard          # full 6-cell matrix
npm run test:live:multiturn-standard # 5-turn simple-chat monitor
node test/live-standard.mjs --tier short      # one tier only
node test/live-standard.mjs --only gemini     # one model only
node test/live-standard.mjs --render-only      # re-score existing artifacts, no API calls
```

Requires real keys in `.env.local`: `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`DEEPSEEK_API_KEY` (cells with a missing key are skipped, not failed), plus the
`READ_URL_ENDPOINT` / `WEB_SEARCH_ENDPOINT` services.

## Companion: 5-turn multi-turn simple-chat monitor

Use `npm run test:live:multiturn-standard` before the full matrix when the change
affects normal chatbox/session UX. It is cheaper and faster than the matrix and
checks a different surface:

| Gate | Standard |
|------|----------|
| Conversation length | 5 turns in one `session.run` thread |
| Model roster | OpenAI `gpt-5.4-mini` + `reasoningEffort: low`; Gemini `gemini-3.1-flash-lite` + `thinkingLevel: low` |
| Runtime profile | browser simple-chat: `plannerMode: native_tools`, external actions plus `plan`/`finalize` disabled, virtual workspace disabled, memory extraction skipped by host policy |
| Provider calls | exactly 1 LLM request per turn |
| Tool behavior | no external model tool picks and no runtime actions; native `final_answer` terminal calls are allowed |
| Context quality | turn 3 must recall the session anchor |
| Time quality | turn 4 must use host-provided `timeContext` exactly |
| Security | returned results must not contain the provider API key |
| Evidence | redacted provider payload/response JSONL + summary report in `test/live-observe-out/` |

This does not replace the full matrix. It is the standard quick monitor for
general frontend chat performance and multi-turn continuity.

## Outputs (in `test/live-standard-out/`)

- `SCORECARD.md` — the at-a-glance table (also printed to stdout).
- `scorecard-trend.jsonl` — append-only, one line per cell per run, for tracking over time.
- `report-<id>.md` — the actual deliverable per cell (open the ones flagged 🔎 READ).
- `metrics-<id>.json`, `progress-<id>.jsonl`, `log-<id>.txt` — per-cell raw data.

## Reading the scorecard

| column | meaning |
|--------|---------|
| status | runtime `runState.status` (`completed` / `failed` / `killed_or_crashed` / deadline) |
| pass   | coarse health. **long**: status=completed AND all 3 gates pass. **short**: delivered a tool-grounded answer (≥50 words, used a tool) |
| qScore | machine quality gate score 0–100 (length + structure + source). **Can miss bad prose.** |
| words  | candidate/answer length |
| $cost  | USD from the embedded price table (`test/helpers/bench-metrics.mjs`) on real token usage |
| min    | wall-clock minutes |
| tok    | total tokens |
| web/read | web_search / read_url action counts |
| cites  | distinct source URLs in the deliverable |
| red-flags | **text-level** problems the gates miss: `dup-paragraphs`, `repeated-headings`, `placeholder`, `no-citations` |
| review | 🔎 READ when any red-flag fired — a human must open and judge the report |

**The discriminating rule:** never trust a high `qScore` alone. If `review` says
🔎 READ, open the report and judge the prose by eye. That is the GOAL.md #8
dimension ("no duplicate heading, no placeholder sentence") that no gate catches.

## It is a monitoring scorecard, not a CI gate

By design it never throws on quality misses (exit non-zero only on launcher
crash). Cheap/weak models legitimately vary; the value is the **trend** and the
**human-review flags**, not a binary pass/fail. Use a uniform length threshold
(1500 words for long) so model tiers are compared on the same ruler.

## v1 Baseline (2026-06-09) — regression anchor

First full baseline after two AI-first fixes: the source/citation publish gate is
now default-advisory + host-configurable (commit f47158371), and the research
source-minimum numeric defaults moved out of the kernel into the
`@agrun/skills-research` pack (AGRUN-455 / ADR-0053, commit 2fc912ac9).

All 6 cells `completed` (pass=true):

| tier | model | qScore | words | $cost | min | red-flags |
|------|-------|--------|-------|-------|-----|-----------|
| long  | gpt-5.4-mini          | 100 | 1620 | $0.35  | 3.7 | — |
| long  | gemini-3.1-flash-lite | 100 | 1545 | $0.06  | 1.1 | unverified-citations |
| long  | deepseek-v4-flash     | 100 | 1538 | $0.025 | 4.5 | unverified-citations |
| short | gpt-5.4-mini          | 63  | 114  | $0.39  | 3.2 | unverified-citations |
| short | gemini-3.1-flash-lite | 100 | 186  | $0.11  | 2.2 | unverified-citations |
| short | deepseek-v4-flash     | 0\* | 131  | $0.005 | 1.1 | — |

**Headline:** `deepseek-v4-flash` long went from FAILED (looped to its 20-min
deadline, 0 words delivered, pre-fix) to COMPLETED (4.5 min, 1538 words) — the
hardcoded blocking source gate was the deadlock root cause; removing it fixed the
weak-model deadlock with no regression on gpt/gemini. The 4 `unverified-citations`
flags are NOT a regression — cheap models cite URLs they did not successfully
read, and that quality risk is now a visible scorecard+human review flag instead
of a silent runtime veto.

\* `qScore 0` for deepseek short = a direct answer with no workspace candidate
(the length gate has nothing to score); the run still delivered (131 words) and
passed the short-tier deliverable check.

**Use as a regression anchor:** after any runtime change, rerun the matrix and
diff `scorecard-trend.jsonl` against this baseline — watch the `status` column
(any new `failed`/`killed_or_crashed`?) and the `red-flags` column (new quality
signals?). Behavior should stay equal-or-better; a model regressing to `failed`
is the signal to investigate.

## How it is wired (for maintainers)

- `test/live-standard.mjs` — the matrix launcher + scorecard renderer.
- `test/bench-one.mjs` — one real run per cell; `cfg.loadSkills` wires the
  research pack (agent skills + hooks + read_url service fetch), `cfg.research`
  seeds the evidence-convergence capability, and it captures true token split
  (fetch intercept) + extracts quality via the SSOT `computeNodeLiveQualitySummary`.
- `test/helpers/bench-metrics.mjs` — SSOT price table + `computeCost` + kill salvage.
- `test/helpers/report-quality.mjs` — SSOT text red-flag analysis.
