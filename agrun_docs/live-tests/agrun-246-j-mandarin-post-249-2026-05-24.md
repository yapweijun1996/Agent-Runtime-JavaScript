# AGRUN-246-J: Mandarin post-249/250/251 retest

Date: 2026-05-24

Run ID: `2026-05-24T13-30-33-942Z`

Purpose: rerun the canonical Mandarin flash-lite Harness Engineering trace after AGRUN-249, AGRUN-250, AGRUN-251, and AGRUN-252 landed. This is the close-or-keep-PARTIAL check for AGRUN-246-J.

## Command

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

Artifacts:

| artifact | path |
|---|---|
| debug markdown | `agrun_debug_runs/2026-05-24T13-30-33-942Z.md` |
| debug jsonl | `agrun_debug_runs/2026-05-24T13-30-33-942Z.jsonl` |
| final report | `agrun_debug_runs/2026-05-24T13-30-33-942Z-report.md` |

## User Gate Result

The command exited cleanly under the script's older AGRUN-244 acceptance rules, but the stricter AGRUN-246-J user gate failed.

| gate | required | observed | result |
|---|---:|---:|---|
| `candidateCjkChars` | `>= 3000` | `1858` | FAIL |
| `finalCandidateStructureOk` | `true` | `false` | FAIL |
| `sourceMinimumPassed` | `true` | `false` | FAIL |
| `userGoalSatisfied` | `true` | `false` | FAIL |
| `qualityScore.score` | `>= 80` | `31` | FAIL |

Final summary:

```json
{
  "runStatus": "completed",
  "terminalizedBy": "workspace_publish_candidate",
  "outputKind": "final_response",
  "decision": "limited",
  "candidatePath": "final_candidate.md",
  "candidateChars": 3241,
  "candidateCjkChars": 1858,
  "candidateWords": 130,
  "finalCandidateStructureIssueCodes": [
    "duplicate_headings",
    "duplicate_section_numbers"
  ],
  "sourceMinimum": {
    "minReadSources": 3,
    "minRelevantSources": 2,
    "passed": false,
    "readSources": 23,
    "relevantSources": 1
  },
  "successfulReadUrlCount": 17,
  "qualityScore": {
    "score": 31,
    "failingGates": [
      "length",
      "structure",
      "source"
    ],
    "candidateLength": 1858,
    "lengthUnit": "cjkChars",
    "lengthRatio": 0.619
  }
}
```

## Before / After Comparison

| stage | run | length result | structure | source | user goal | notes |
|---|---|---:|---|---|---|---|
| Baseline mean cited by AGRUN-249 | n=3 baseline | `834` mean | mixed | mixed | `0/3` | Pre-249 long-form baseline average used for AGRUN-249 comparison. |
| AGRUN-246-J original Mandarin baseline | `2026-05-23T13-23-32-528Z` | `85/3000` words | failed user depth | failed | false | Old publish-block failure. |
| AGRUN-246-J first after-trace | `2026-05-24T04-30-50-485Z` | `1685` chars / `1196` CJK chars / `49` words | true | false | false | Hard-veto opened workspace_write but produced a thin limited candidate. |
| AGRUN-246-J escalated after-trace | `agrun-246-j-after-2026-05-24-escalated` | `0` selected candidate words | false | false | false | AI wrote `report.md`, selected `final_candidate.md` stayed empty. |
| AGRUN-249 Mandarin pass | `2026-05-24T07-25-15-132Z` | `3232/3000` CJK chars | true | true | true | Proved the new signal harness can pass this class, but it was not the final close-out trace after 250/251/252. |
| Post-249/250/251 close-out retest | `2026-05-24T13-30-33-942Z` | `1858/3000` CJK chars | false | false | false | Path discipline held, but source/read loop and late expansion left the result partial. |

## Action Pattern

Compressed sequence:

```text
todo_plan -> web_search -> plan -> read_url -> plan -> todo_plan -> read_url
-> web_search/read_url loop -> workspace_write -> repeated read_url/finalize blocks
-> terminal hard_veto -> workspace_insert_after_section -> workspace_replace
-> workspace_publish_candidate -> workspace_finalize_candidate -> workspace_read
-> workspace_publish_candidate
```

Important observations:

- Selected candidate path held: all workspace writes/insertions targeted `final_candidate.md`, not `report.md`.
- The run completed through `workspace_publish_candidate`, so the old selected-candidate-empty failure did not recur.
- The AI spent most of the budget on `read_url`: 29 `read_url` actions, 23 counted read sources, 17 successful reads, but only 1 relevant source against the required 2.
- Terminal repair blocked premature finalize 5 times, then hard-veto opened expansion/edit actions at cycle 45.
- Expansion started too late and too small: candidate moved from 93 words to only 130 words / 1858 CJK chars.
- The final candidate still had duplicate headings and duplicate section numbers.
- TodoState stayed unsynchronized: 4 unfinished tasks remained.

## HBR

AGRUN-246-J remains PARTIAL. The new run is better than the previous selected-candidate-path failure because the AI wrote to `final_candidate.md` and the runtime exposed repair actions without authoring report prose. It still fails the user-level gate on length, structure, source minimum, user goal, and quality score.

The main failure mode moved from "wrong candidate path / empty selected candidate" to "repeated source reading and late, insufficient expansion." Terminal repair kept the run honest by publishing `limited` with concrete remaining gaps, but it did not get the AI to satisfy the requested 3000 CJK-character report.

No hardcoded runtime fix should be added from this trace. The next root fix should expose candidate growth, source recovery, and TodoState progress as compact observable state that helps the AI choose earlier expansion and better source strategy, while still leaving content, citations, and readiness decisions to the AI.

