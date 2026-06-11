# AGRUN-246-J: post structure-hints Mandarin rerun

Date: 2026-05-25

Purpose: rerun the canonical Mandarin flash-lite Harness Engineering long-output
scenario after the dotted section-number repair hint fix, then verify whether it
reduces structure churn and improves final user-level quality.

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

## Run 1: structure-hints only

Run ID: `2026-05-24T22-43-08-533Z`

Artifacts:

| artifact | path |
|---|---|
| debug markdown | `agrun_debug_runs/2026-05-24T22-43-08-533Z.md` |
| debug jsonl | `agrun_debug_runs/2026-05-24T22-43-08-533Z.jsonl` |
| final report | `agrun_debug_runs/2026-05-24T22-43-08-533Z-report.md` |

Result:

| gate | required | observed | result |
|---|---:|---:|---|
| `candidateCjkChars` | `>= 3000` | `1521` | FAIL |
| `finalCandidateStructureOk` | `true` | `false` | FAIL |
| `sourceMinimumPassed` | `true` | `false` | FAIL |
| `userGoalSatisfied` | `true` | `false` | FAIL |
| `qualityScore.score` | `>= 80` | `25` | FAIL |

Important finding: the run no longer proved the previous `3.4` dotted-number
parser bug, but it exposed a broader recovery issue. Terminal repair allowed
only `read_url` while source relevance was still short, even though read source
count was already far beyond the minimum and the candidate still had a visible
length deficit. The model read 33 URLs, produced 30 successful reads, but all
sources were weak/thin/blocked and the draft remained short.

## Harness fix applied

File: `src/runtime/terminal-repair-state.js`

Change: when source minimum still fails only because relevance is low, but the
read-source quota is already satisfied and an observable length deficit exists,
terminal repair now exposes workspace expansion actions alongside `read_url`.
This keeps AI ownership of source selection and content while avoiding a
read_url-only action surface that cannot improve length.

Regression: `test/unit/terminal-repair-state.test.js` now covers the mixed
source-relevance + length-deficit case.

## Run 2: after source-relevance action-surface fix

Run ID: `2026-05-24T22-57-18-965Z`

Artifacts:

| artifact | path |
|---|---|
| debug markdown | `agrun_debug_runs/2026-05-24T22-57-18-965Z.md` |
| debug jsonl | `agrun_debug_runs/2026-05-24T22-57-18-965Z.jsonl` |
| final report | `agrun_debug_runs/2026-05-24T22-57-18-965Z-report.md` |

Result:

| gate | required | observed | result |
|---|---:|---:|---|
| `candidateCjkChars` | `>= 3000` | `3644` | PASS |
| `finalCandidateStructureOk` | `true` | `false` | FAIL |
| `sourceMinimumPassed` | `true` | `false` | FAIL |
| `userGoalSatisfied` | `true` | `false` | FAIL |
| `qualityScore.score` | `>= 80` | `50` | FAIL |

Summary:

```json
{
  "runStatus": "completed",
  "terminalizedBy": "workspace_publish_candidate",
  "outputKind": "final_response",
  "decision": "limited",
  "candidatePath": "final_candidate.md",
  "candidateCjkChars": 3644,
  "candidateWords": 309,
  "finalCandidateStructureOk": false,
  "finalCandidateStructureIssueCodes": ["duplicate_section_numbers"],
  "sourceMinimum": {
    "minReadSources": 3,
    "minRelevantSources": 2,
    "passed": false,
    "readSources": 14,
    "relevantSources": 0
  },
  "successfulReadUrlCount": 13,
  "qualityScore": {
    "score": 50,
    "failingGates": ["structure", "source"],
    "candidateLength": 3644,
    "lengthUnit": "cjkChars",
    "lengthRatio": 1
  }
}
```

Behavior improvement:

| metric | Run 1 | Run 2 | meaning |
|---|---:|---:|---|
| first workspace expansion after read quota | hard-veto late | cycle 10 | PASS, action surface fix worked |
| `read_url` timings count | 33 | 16 | improved |
| successful reads | 30 | 14 | fewer reads needed before limited exit |
| `candidateCjkChars` | 1521 | 3644 | length gate recovered |
| `qualityScore.score` | 25 | 50 | improved but still failed |

Remaining HBR:

- Source relevance still failed: `relevantSources=0/2` despite 14 read sources.
  Many plausible framework/evaluation sources were classified as weak because
  the current source-quality overlap path did not consider them relevant enough
  to the Mandarin Harness Engineering prompt.
- Structure still failed with duplicated section numbers, especially repeated
  subsection numbers such as `3.1`, `4.1`, `5.1`, and `6.1`.
- TodoState remained partially unsynchronized (`5 unfinished task(s)`).
- `acceptanceError` remained `none` because the script accepts honest limited
  outputs; user-level gate must read `userGoalSatisfied=false` and
  `qualityScore=50` as failure.

## Decision

AGRUN-246-J remains PARTIAL. The source-relevance action-surface fix is useful
and should ship because it turned a read_url-only loop into earlier workspace
expansion and recovered the length gate. It does not close AGRUN-246-J.

Next best fix: investigate source-quality relevance for non-English prompts and
AI-agent evaluation/framework sources, then separately harden duplicate
subsection-number repair after multiple valid patch/apply cycles still leave
structure failing.
