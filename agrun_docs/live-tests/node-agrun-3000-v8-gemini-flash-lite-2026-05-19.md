# E2E v8 — gemini-3.1-flash-lite, 90 steps (2026-05-19)

## Run Config
- Model: `gemini-3.1-flash-lite`
- plannerMode: `envelope`
- maxSteps: 90
- Prompt: 3000-word Harness Engineering report
- Command: `GEMINI_MODEL=gemini-3.1-flash-lite NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs`

## Result: FAIL

| Metric | Value | Target |
|---|---|---|
| runStatus | `failed` | `completed` |
| candidateWords | **437** | ≥ 3000 |
| finalCandidateStructureOk | `true` | `true` ✓ |
| finalCandidateStructureIssueCodes | `[]` | `[]` ✓ |
| sourceMinimum.passed | `false` | `true` |
| readSources | 3 | ≥ 3 ✓ |
| relevantSources | 1 | ≥ 2 ✗ |
| successfulReadUrlCount | 3 | ≥ 3 ✓ |
| terminalizedBy | `""` | `workspace_publish_candidate` |
| budgetState (final) | `low` | — |
| terminalRepairState.active | `true` | `false` |
| terminalRepairState.ignoredCount | **8** | — |
| readOnlyPlanningIgnoredCount | **21** | — |
| durationMs | 355,296 ms | — |
| cycleCount | 84 | 90 max |

## Block Events (harness enforcement working)
| Event | Count |
|---|---|
| `terminal-repair-direct-terminal-blocked` (finalize blocked) | **6** |
| `terminal-repair-action-blocked` (invalid publish blocked) | 1 |
| `read-only-planning-action-blocked` (web_search blocked) | 1 |
| `PLANNER_INVALID_ACTION` (invalid envelope, ADR-0013 fatal) | 2 |
| `plan-validation-failed` | 1 |

## Hard-Veto Analysis
- **PR 2 (terminal repair hard_veto)**: NOT triggered. `ignoredCount: 8 >= 3` (threshold met) BUT `budgetState: "low"` ≠ `"exhausted"`. Hard_veto requires BOTH conditions. 6 cycles remained when run ended.
- **PR 3 (structure repair hard_veto)**: NOT triggered. `finalCandidateStructureOk: true`, `structureRepairConvergence` not active.

## Root Cause: Model Ceiling (gemini-3.1-flash-lite)
- Only 437 words produced across 84 cycles — model could not generate meaningful content
- AI repeatedly wrote short workspace_write/append fragments without building toward 3000 words
- `readOnlyPlanningIgnoredCount: 21` — model ignored convergence signals continuously
- Consistent with gemini-flash family pattern: weak instruction-following for long-form research
- This is NOT a harness gap — advisory blocks fired correctly 8 times

## Advisory Blocks Working Correctly
The `terminalRepairState` advisory signal is functioning as designed:
- Blocked `finalize` 6 times (direct terminal blocked)
- Blocked invalid `workspace_publish_candidate` 1 time
- Blocked `web_search` via read-only-planning 1 time
- Model kept attempting forbidden actions despite blocks → confirms model ceiling, not harness gap

## Action Sequence Pattern
Steps 12-78 were dominated by `workspace_write → workspace_append` alternating loop (66 consecutive workspace ops with only 3 `web_search` and 3 `read_url` calls after step 16). Model was writing but producing very little useful content per step.

## Source Quality
- `relevantSources: 1/2` (failed minimum)
- Only 1 "strong" source: harness.io (a DevOps company, not about AI Harness Engineering concept)
- 2 "usable" sources: ArXiv AdBooster paper (completely off-topic, overlap score 2)
- Model searched for "harness engineering" but found Harness.io (the company) instead of the concept

## Debug Experience Gap (documented for future improvement)
During this run, the `planner_decision` JSONL stream showed only `{actionName, event, index}` — no convergence state inline. Key debug questions that could not be answered from the stream:
1. Was `candidateWords` growing per step? (not visible)
2. At which step did `readOnlyPlanningState` activate? (had to read `interestingSteps`)
3. Did hard_veto fire or was it only advisory? (no dedicated hard_veto event emitted)

**Planned improvement (AGRUN-DEBUG-01):**
- Add `candidateWords` to each `planner_decision` event
- Add dedicated `hard_veto_fired` event when `escalation === "hard_veto"` blocks an action
- These 2 fields would make per-step analysis possible without reading `interestingSteps` array

## Conclusion
gemini-3.1-flash-lite confirmed as **too weak** for 3000-word long-form research (437/3000 words = 15%). This is the same pattern as previous flash runs. For meaningful AGRUN-237 PR 2/PR 3 hard_veto validation, use:
- `gemini-3-pro-preview` (KB: PASS 1/1 but infra unstable)
- `gpt-5-mini` + `NODE_AGRUN_LIVE_PROVIDER=openai` (KB: PASS 2/2 consecutive — recommended)
