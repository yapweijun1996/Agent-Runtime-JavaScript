# AGRUN-246-J: current HEAD Mandarin rerun

Date: 2026-05-25

Run ID: `2026-05-24T18-25-09-526Z`

Purpose: rerun the canonical Mandarin flash-lite Harness Engineering long-output
scenario against current HEAD after AGRUN-248-C Phase 2, then record exact
pass/fail facts before choosing the next report-quality fix.

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
| debug markdown | `agrun_debug_runs/2026-05-24T18-25-09-526Z.md` |
| debug jsonl | `agrun_debug_runs/2026-05-24T18-25-09-526Z.jsonl` |
| final report | `agrun_debug_runs/2026-05-24T18-25-09-526Z-report.md` |

## User Gate Result

The command completed without a thrown runtime error, but the user-level report
goal still failed.

| gate | required | observed | result |
|---|---:|---:|---|
| `candidateCjkChars` | `>= 3000` | `3235` | PASS |
| `finalCandidateStructureOk` | `true` | `false` | FAIL |
| `sourceMinimumPassed` | `true` | `true` | PASS |
| `userGoalSatisfied` | `true` | `false` | FAIL |
| `qualityScore.score` | `>= 80` | `75` | FAIL |

Final summary:

```json
{
  "runStatus": "completed",
  "terminalizedBy": "workspace_publish_candidate",
  "outputKind": "final_response",
  "decision": "limited",
  "candidatePath": "final_candidate.md",
  "candidateChars": 5610,
  "candidateCjkChars": 3235,
  "candidateWords": 225,
  "finalCandidateStructureOk": false,
  "finalCandidateStructureIssueCodes": [
    "duplicate_section_numbers"
  ],
  "sourceMinimum": {
    "minReadSources": 3,
    "minRelevantSources": 2,
    "passed": true,
    "readSources": 3,
    "relevantSources": 2
  },
  "successfulReadUrlCount": 3,
  "qualityScore": {
    "score": 75,
    "failingGates": [
      "structure"
    ],
    "candidateLength": 3235,
    "lengthUnit": "cjkChars",
    "lengthRatio": 1
  },
  "durationMs": 266987
}
```

## Before / After Comparison

| stage | run | length result | structure | source | user goal | notes |
|---|---|---:|---|---|---|---|
| Post-249/250/251 close-out retest | `2026-05-24T13-30-33-942Z` | `1858/3000` CJK chars | false | false | false | Path discipline held, but source/read loop and late expansion left the result partial. |
| Current HEAD rerun | `2026-05-24T18-25-09-526Z` | `3235/3000` CJK chars | false | true | false | Length and source gates improved, but duplicate section numbering remained and report quality stayed below acceptance. |

## Action Pattern

Compressed sequence:

```text
plan -> todo_plan -> web_search -> read_url -> web_search -> read_url
-> todo_plan -> workspace_write -> workspace_insert_after_section
-> workspace_propose_patch/apply_patch churn -> workspace_publish_candidate
-> workspace_finalize_candidate -> workspace_read -> todo_run_next/propose_patch churn
-> workspace_publish_candidate
```

Important observations:

- Selected candidate path held: the final candidate stayed at
  `final_candidate.md`.
- The run used only 3 successful `read_url` actions and still passed source
  minimum with 2 relevant sources.
- Candidate length passed the CJK-character gate (`3235/3000`), but the final
  report had duplicated / out-of-order section numbering.
- The runtime exposed structure pressure, but the model spent 21
  `workspace_propose_patch` actions and only 2 `workspace_apply_patch` actions.
- Final publication was honest `limited`; no runtime-authored prose was added.

## HBR

AGRUN-246-J remains PARTIAL. Current HEAD improved the failure mode: the result
now satisfies length and source gates, unlike the post-249/250/251 retest. The
remaining user-level failure is structure and final report quality: duplicate
section numbers survived repeated patch proposals and the final answer was still
published as limited with `userGoalSatisfied=false`.

The next fix should not hardcode report content or citations. The smallest
harness-side improvement should focus on making structure-repair convergence
more AI-observable and action-contract-driven, so the model can stop proposing
the same ineffective heading repair and either apply a concrete valid edit or
publish a truthful limited result earlier.
