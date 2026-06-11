# AGRUN-246-J Source + Structure Closeout 2026-05-25

## Scope

Canonical Mandarin Gemini flash-lite/high-thinking Harness Engineering report test:

```bash
AGRUN_DEBUG=1 \
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=high \
NODE_AGRUN_LIVE_MAX_STEPS=60 \
NODE_AGRUN_LIVE_TIMEOUT_MS=300000 \
NODE_AGRUN_LIVE_PROMPT="写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。使用网络检索和网页阅读为每个章节引用真实来源。至少引用3个权威网址。结构：定义、核心原则、具体模式、反面案例、真实世界示例、结论。" \
node test/node-agrun-3000-live.mjs
```

## Changes Tested

- Mixed CJK/Latin tokenization for source relevance (`Harness Engineering` embedded in Mandarin prompts).
- General web search exact-phrase pass and ranking so broad AI overview pages do not satisfy a specific Harness Engineering search.
- Source recovery excludes already-read URLs and sourceMinimum counts distinct strong topic-relevant read sources.
- Structure repair no longer gets trapped on stale patch previews, and source+structure hard-veto can expose a rewrite escape.
- `workspace_insert_after_section` warns on structure regression without blocking growth.
- `workspace_write` now blocks destructive shrink rewrites of substantial `final_candidate.md` content.

## Live Evidence

| Run | Result | Key facts |
|---|---|---|
| `2026-05-24T23-14-10-583Z` | Failed | Strict structure blocking kept `finalCandidateStructureOk=true` but starved length: `candidateCjkChars=1892/3000`, source minimum passed. |
| `2026-05-24T23-24-24-063Z` | Failed | Warning-only structure growth improved length to `2453/3000`, but source relevance regressed to `0/2` and structure failed. |
| `2026-05-24T23-48-58-551Z` | Partial | Length passed (`3026/3000`) and source diagnostics found strong Harness sources, but sourceMinimum was `7 read / 1 relevant` and structure still failed. |
| `2026-05-24T23-59-12-542Z` | Passed | `candidateCjkChars=3032/3000`, `finalCandidateStructureOk=true`, `sourceMinimumPassed=true` (`3 read / 2 relevant`), `userGoalSatisfied=true`, `qualityScore=100`. |

Final run artifacts:

- `agrun_debug_runs/2026-05-24T23-59-12-542Z.md`
- `agrun_debug_runs/2026-05-24T23-59-12-542Z.jsonl`
- `agrun_debug_runs/2026-05-24T23-59-12-542Z-report.md`

## Final Run Summary

```json
{
  "runStatus": "completed",
  "candidateCjkChars": 3032,
  "requestedWords": 3000,
  "finalCandidateStructureOk": true,
  "sourceMinimumPassed": true,
  "sourceMinimum": {
    "readSources": 3,
    "relevantSources": 2,
    "minReadSources": 3,
    "minRelevantSources": 2,
    "passed": true
  },
  "userGoalSatisfied": true,
  "qualityScore": {
    "score": 100,
    "failingGates": []
  }
}
```

Read source diagnostics in the passing run:

- `https://harness-engineering.ai/blog/agent-harness-complete-guide/` — strong.
- `https://atlan.com/know/what-is-harness-engineering/` — strong.
- `https://github.com/ai-boost/awesome-harness-engineering` — blocked by content pattern, correctly not counted as relevant.

## HBR

Intermediate runs found real bad behavior before the final pass:

- A strict structure block preserved heading quality but prevented enough AI-authored length growth.
- Warning-only growth let the AI expand, but it could read broad AI sources instead of Harness-specific sources.
- One live pass showed `workspace_write` shrinking a long candidate before later recovery. This was fixed after the passing run with a targeted destructive-shrink guard and unit coverage; no runtime-authored report content was added.

## Verification

- `node test/unit/web-search-ranking.test.js`
- `node test/unit/read-source-quality.test.js`
- `node test/unit/read-url-action.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/research-evidence-graph.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/terminal-repair-state.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/workspace-actions.test.js`
- `npm run build`

