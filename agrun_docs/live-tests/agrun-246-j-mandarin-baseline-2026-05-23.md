# AGRUN-246-J: Mandarin × flash-lite Baseline Run

**Date**: 2026-05-23  
**Run ID**: `2026-05-23T13-23-32-528Z`  
**Purpose**: Per-category misfire evidence required before implementing C-H fixes in AGRUN-246

---

## Run Config

| field | value |
|---|---|
| model | gemini-3.1-flash-lite |
| provider | gemini |
| prompt | Pure Mandarin, 3000-word deep research on Harness Engineering |
| maxSteps | 30 |
| AGRUN_DEBUG | 1 |

Prompt (verbatim):
```
写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。使用网络检索和网页阅读为每个章节引用真实来源。至少引用3个权威网址。结构：定义、核心原则、具体模式、反面案例、真实世界示例、结论。
```

---

## Run Outcome

| field | value |
|---|---|
| runStatus | completed |
| duration | 52.5s |
| candidateWords | **85** (vs 3000 requested) |
| successfulReadUrlCount | 3 |
| sourceMinimumPassed | true |
| structureOk | true |
| acceptanceError | none |
| Issue | `length_deficit: 85/3000 words` |

**Verdict: FAILED** — output is 2.8% of requested length.

---

## Action Timeline

Cycles 1-9: Research phase (plan → web_search × 2 → read_url × 3 → workspace_write 85 words)  
Cycles 10-23: **Publish-block loop** (workspace_publish_candidate × 6, all blocked by `terminal_repair_invalid_publish`)

---

## Per-Category Misfire Observations

### C1 — Word-count enforcement blocking instead of guiding

**Observation**: `terminal_repair_invalid_publish` blocked `workspace_publish_candidate` 5 times (cycles 10, 12, 15, 18, 20). Escalated advisory → hard_veto at cycle 21.

**Root cause**: The terminal_repair state correctly detected `length_deficit: 85/3000` but failed to redirect the agent toward expansion actions. After the first block, the agent never called `workspace_write`, `workspace_replace`, or `workspace_multi_edit` again — it only retried publish.

**Hardcode violation**: Word-count-based publication blocking is a runtime-level enforcement decision (C1 category). The AI should decide whether to expand; the harness should only provide the word-count fact.

**Evidence**: 
- `terminal_repair_invalid_publish` at cycles 10, 12, 15, 18, 20 (convergence_block events)
- `candidateWords: 85` never changed from cycle 9 to cycle 23
- No `workspace_write` / `workspace_replace` / `workspace_multi_edit` after cycle 9

**Status**: **Misfire confirmed** — C1 directly caused the run failure.

---

### C2 — Mandarin prompt misclassified by external source intent detector

**Observation**: The prompt is pure Mandarin. `isExternalSourceCoveragePrompt()` in `external-source-intent.js` uses English-only regex patterns — it would return `false`, setting `requiresExternalSources=false` in `evidence-pack.js`.

**However**: The AI model independently decided to search (2 web_search + 3 read_url calls), `sourceMinimumPassed: true`.

**Root cause**: The harness provided NO coverage guidance (no coverage targets, no coverage guard) because the intent detector returned false. But the lite model happened to search anyway. For a weaker/different prompt, the model might not self-correct.

**Evidence**:
- `researchReportLoop` signal: 813 chars in cycle 1, grew to ~2245 chars — report loop guidance was providing some signal
- `successfulReadUrlCount: 3` — sources gathered despite false negative
- C2 misfire is **present but non-fatal in this run** — AI self-corrected; the harness gap is real but masked

**Status**: **Misfire present, non-fatal** — English-only regex confirmed incorrect for Mandarin prompts. Fix needed to ensure harness actively guides instead of relying on model self-correction.

---

### C3 — Terminal repair fails to guide concrete repair action

**Observation**: After cycles 10-20 of `terminal_repair_invalid_publish` blocks, the repair state correctly flagged length deficit but provided no actionable guidance to expand content.

**Evidence**:
- `terminalRepairState` signal: 2175 chars from cycle 11 onwards — signal was large (correct)
- Agent responded to blocks with `todo_advance` (4 calls) — treating it as task progress, not repair signal
- No expansion action taken in 13 repair cycles
- Final outcome: `decision: "limited"` publish with `requirementSatisfied: false`

**Status**: **Misfire confirmed** — repair state detected deficit but loop guidance failed to channel agent toward expansion.

---

### C4 — TodoState synchronization mismatch

**Observation**: At run end, TodoState shows `done: 1, pending: 4` (5 total tasks). Only "调研" task marked done. Research, drafting, review tasks remained pending.

**Evidence**:
- `todo_advance` called 4 times but only 1 task advanced to done
- Agent used `todo_advance` inside the terminal-repair loop (cycles 11, 14, 17, 19) as if advancing past a blocker
- Todo actions were not aligned with actual work completion

**Status**: **Partial misfire** — todo tracking doesn't reflect real work progress; agent used todo_advance as a "retry" signal.

---

### C5 — Budget state transitions

**Observation**: Budget state transitioned: `unknown` (cycles 1-9) → `enough` (10-19) → `low` (20-23). The `low` state at cycle 20 triggered harder veto (convergence_block) but didn't motivate final-effort expansion.

**Status**: **Minor** — budget signals propagated correctly, but the `low` budget state should have triggered an accelerated single-pass expansion attempt. Not a critical misfire.

---

### C6 — Read-URL recovery signal

**Observation**: `readUrlRecoverySignal` held at 2397 chars from cycle 4 onward. 3 URLs read successfully (2 strong tier, 1 weak tier sources). No recovery needed.

**Status**: **Not triggered** — read_url worked normally in this run. C6 fix can't be validated from this trace.

---

## Summary Table

| Category | Misfire? | Severity | Notes |
|---|---|---|---|
| C1 (word-count publish block) | ✅ Confirmed | **Critical** | Direct cause of run failure — 85/3000 words |
| C2 (Mandarin intent detection) | ✅ Present (non-fatal) | High | AI self-corrected; harness gap confirmed |
| C3 (repair → expansion guidance) | ✅ Confirmed | High | Repair loop didn't redirect to expand action |
| C4 (TodoState sync) | Partial | Medium | todo_advance used incorrectly as retry signal |
| C5 (budget state) | Minor | Low | Signals correct, utilization suboptimal |
| C6 (read-url recovery) | Not triggered | N/A | Need failed read_url run to test C6 |

---

## Key Evidence for C-H Implementation

**Before implementing any C-H fix**: This trace is the `before` baseline.

**Primary finding**: The C1 + C3 interaction is the main failure mode — terminal_repair blocks publication repeatedly without guiding expansion. The agent gets stuck in `publish → block → todo_advance → retry` loop for 13 cycles while the document stays at 85 words.

**C2 finding**: English-only regex in `external-source-intent.js` confirmed incorrect for Mandarin. The AI self-corrected in this run, but the harness gap is structural — coverage guidance was absent for the Mandarin prompt.

**Per-category `after` traces**: Each C-H implementation needs a matching post-fix re-run to confirm the specific repair path works.

---

## Artifacts

- Debug trace: `agrun_debug_runs/2026-05-23T13-23-32-528Z.jsonl` (186KB)
- Full debug report: `agrun_debug_runs/2026-05-23T13-23-32-528Z.md` (530KB)
- Run report: `agrun_debug_runs/2026-05-23T13-23-32-528Z-report.md`
