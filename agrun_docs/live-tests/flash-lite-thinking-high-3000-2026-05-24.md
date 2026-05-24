# Live test: gemini-3.1-flash-lite + thinkingLevel=high (3000-word English research)

**Date**: 2026-05-24
**Run ID**: `2026-05-24T04-51-22-404Z`
**Artifacts**:
- `agrun_debug_runs/2026-05-24T04-51-22-404Z.jsonl`
- `agrun_debug_runs/2026-05-24T04-51-22-404Z.md`
- `agrun_debug_runs/2026-05-24T04-51-22-404Z-report.md`

## Run Config

| field | value |
|---|---|
| provider | gemini |
| model | gemini-3.1-flash-lite |
| thinkingLevel | high |
| plannerMode | envelope |
| maxSteps | 60 |
| requestedWords | 3000 |
| timeoutMs | 300000 |
| webSearchEndpoint | https://search.yapweijun1996.com/search |
| readUrlEndpoint | https://readurl.yapweijun1996.com/read-url |

Prompt (default English long-research):
```
Write a 3000-word deep research report on "What is Harness Engineering in AI agent systems".
Use web_search and read_url to ground every section in real sources. Cite at least 3
authoritative URLs. Structure: Definition, Core Principles, Concrete Patterns,
Anti-patterns, Real-World Examples, Conclusion.
```

## Outcome

| dimension | value | verdict |
|---|---|---|
| Node test acceptance gate | PASS (no acceptanceError, `node_agrun_live_pass` emitted) | ✅ |
| runStatus | completed | ✅ |
| terminalizedBy | workspace_publish_candidate | ✅ clean |
| candidateWords | 599 / 3000 | ❌ 20% |
| finalCandidateStructureOk | false | ❌ |
| finalCandidateStructureIssueCodes | `duplicate_headings`, `duplicate_section_numbers` | ❌ |
| sourceMinimum.passed | true (16 reads / 5 relevant; min 3/2) | ✅ first time |
| successfulReadUrlCount | 11 (16 attempts) | ✅ |
| decision | limited | ⚠️ honest |
| durationMs | 547143 (~9 min) | ✅ in budget |
| runError | null | ✅ |
| plannerInvalidCount | 0 | ✅ no PLANNER_INVALID_ACTION |

## Action distribution (31 steps used of 60 budget)

| action | count |
|---|---|
| finalize | 8 (all rejected by terminal repair) |
| read_url | 6 |
| web_search | 4 |
| workspace_publish_candidate | 3 |
| plan | 2 |
| workspace_finalize_candidate | 2 |
| workspace_read | 2 |
| workspace_write | 1 |
| workspace_insert_after_section | 1 |
| todo_run_next | 1 |
| todo_plan | 1 |

## Progress vs prior baselines

| trace | candidateWords | sourceMinimum | Status |
|---|---|---|---|
| baseline 2026-05-23 | 85 | failed | publish-block loop |
| after #1 2026-05-24 | 49 | failed | thin limited publish |
| after #2 2026-05-24 (escalated) | 0 | failed | wrote `report.md` not `final_candidate.md` |
| **this run** | **599** | **passed** ✅ | clean limited publish |

## Wins

1. **Source acquisition gate passed for the first time** (16 reads / 5 relevant)
2. **candidate path discipline holds** — model wrote to `final_candidate.md`, not a sibling file
3. **Clean termination via `workspace_publish_candidate`** — no `max_steps_continuation`, no `PLANNER_INVALID_ACTION` fatal
4. **10x candidate growth** (0/49/85 → 599)
5. **`thinkingLevel=high` materially helps planner stability** on lite tier

## Issues found

### Issue #1 (HIGH) — Length expansion does not iterate
- Model wrote ONE `workspace_write` (initial draft) + ONE `workspace_insert_after_section` (added Concrete Patterns), then jumped to finalize.
- No draft→read→append→read→append loop. 599 words is a one-pass draft, not an expansion-cycled report.
- Harness gap: no observable signal nudges AI toward "you have a 599-word draft and need 2400 more words; consider iterating `workspace_append` per section". Length deficit is visible but no per-section delta hint exists.

### Issue #2 (HIGH) — Structure-repair tools never invoked
- `duplicate_headings` + `duplicate_section_numbers` persist throughout.
- Final report contains two `## 3. Concrete Patterns` headings literally adjacent.
- `workspace_propose_patch` + `normalize_headings` operations exist in the action surface but flash-lite never selected them.
- Harness gap: when structure issues are observable and AI is in terminal repair, the planner-visible hint should name the structural repair tool by name (not just say "fix structure").

### Issue #3 (HIGH) — Finalize loop thrashes 8x
- 8 `finalize` calls in a row, each rejected by terminal repair.
- After repeated finalize rejection, AI fell back to 2 more `web_search` calls (source minimum was already passed) — indicating "lost direction" rather than recovery.
- Harness gap: terminal repair's reject-finalize feedback does not pivot AI toward concrete expansion/normalize action; AI just retries finalize.

### Issue #4 (MEDIUM) — Source–drafting decoupling
- 16 read sources, 5 relevant. But candidate is 599 words.
- read_url evidence enters the evidence pool but does not enter the draft.
- Harness gap: no `unused_evidence_signal` — AI sees source count but not "of N read sources you cited M; expand from the remaining N-M".

### Issue #5 (MEDIUM) — Acceptance gate too permissive
- Node test marked PASS because `sourceMinimum.passed=true` + valid `limited` publish protocol.
- User-perspective verdict is FAIL (599 / 3000 words = 20% delivery).
- Harness gap: debug summary lacks a `userGoalSatisfied` boolean (length + structure both true) and a numeric `qualityScore`. CI cannot distinguish "harness-clean honest limited" from "regression that produces 20% output".

## Interpretation

`thinkingLevel=high` lifts gemini-3.1-flash-lite over three former barriers (source acquisition, candidate path discipline, clean termination) but exposes the next set of harness gaps: **length expansion iteration**, **structure-repair tool invocation**, and **finalize loop pivot**. None of these is a model-capability ceiling — each is a missing observable signal or under-named tool hint.

## HBR

- Node test PASS hides user-goal failure (Issue #5).
- 8 wasted finalize attempts (Issue #3) burned ~27% of the step budget.
- Structure issues are visible to the AI but the tool that fixes them is not surfaced strongly enough (Issue #2).
- This is evidence, not completion proof.

## Tracked under

[AGRUN-249](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/task.md#agrun-249--long-form-expansion--structure-repair-signal-harness) — Long-form expansion + structure-repair signal harness.
