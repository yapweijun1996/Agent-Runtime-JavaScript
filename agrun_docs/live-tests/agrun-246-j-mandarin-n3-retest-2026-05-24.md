# AGRUN-246-J Mandarin N=3 retest (post-249/250/251/252)

Date: 2026-05-24
Purpose: confirm whether AGRUN-246-J can close after AGRUN-249/250/251/252 ship, by running n=3 Mandarin flash-lite traces with the canonical 3000-CJK-char Harness Engineering prompt.

## Run Config (identical across all 3 traces)

| field | value |
|---|---|
| provider | gemini |
| model | gemini-3.1-flash-lite |
| thinkingLevel | high |
| plannerMode | envelope |
| maxSteps | 60 |
| timeoutMs | 300000 |
| prompt | `写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。使用网络检索和网页阅读为每个章节引用真实来源。至少引用3个权威网址。结构：定义、核心原则、具体模式、反面案例、真实世界示例、结论。` |

## N=3 Outcome

| trace | CJK chars | length gate | structureOk | issueCodes | source min | userGoalSatisfied | qualityScore | terminalizedBy | duration |
|---|---|---|---|---|---|---|---|---|---|
| `2026-05-24T13-30-33-942Z` | 1858 (62%) | ❌ | ❌ | duplicate_headings, duplicate_section_numbers | ❌ (23/1 rel, min 2) | ❌ | 31 | publish | 5min |
| `2026-05-24T13-58-46-178Z` | 3047 (102%) | ✅ | ❌ | duplicate_headings, duplicate_section_numbers | ✅ (3/2 rel) | ❌ | 75 | publish | 16min |
| `2026-05-24T14-15-00-093Z` | 2965 (99%) | ❌ | ❌ | duplicate_section_numbers | ✅ (3/2 rel) | ❌ | 74 | max_steps | 28min |
| **mean ± std** | 2623 ± 542 (CV 21%) | 1/3 ✅ | **0/3 ✅ stable fail** | structure always fails | 2/3 ✅ | **0/3 ✅ never** | 60 ± 21 | inconsistent | 5–28 min, 5× variance |

## Stable observations (n=3 confirms)

1. **Structure failure rate 3/3** — `duplicate_headings` and `duplicate_section_numbers` are stable bugs, not noise. Even trace #3 used `workspace_propose_patch ×3` + `workspace_apply_patch ×2` + `workspace_multi_edit ×1` and still left `duplicate_section_numbers`.
2. **userGoalSatisfied 0/3** — Mandarin retests never satisfy the user-level gate even when 2/3 sub-gates pass.
3. **Length variance is wide but most runs are near target** — 62/102/99%, mean 2623 / target 3000 (87% of target on average).
4. **Trace #3 fired `read-only-planning-hard-veto-blocked` 30 times** on `web_search` with `ignoredCount` climbing to 8+ and `budgetState=enough`. This contradicts the earlier prioritization decision (based on English n=3) that demoted AGRUN-249-H to P2 defensive. **Mandarin and English have different hot-paths.**
5. **Duration variance huge (5/16/28 min)** — same config, 5× spread; trace #3 timed out via `max_steps_continuation`.
6. **Source acquisition borderline** — trace #1 failed with 23 reads / 1 relevant; #2 + #3 barely passed at 2 relevant.

## Verdict

AGRUN-246-J cannot close. The new failure mode is no longer "wrong candidate path" (AGRUN-246-J first/second after-trace fixed that) but:

- Mandarin structure repair tools cannot fix Mandarin heading/section duplicates
- Read-only-planning hard_veto fires excessively on Mandarin web_search
- Mandarin runs vary 5× in duration

These are signal/tool gaps, not model gaps. The next root fix lives in a new AGRUN-253 ticket — Mandarin-specific signal harness — and remains AI-first.

## Cross-language priority lesson

The earlier YELLOW deep-review demoted AGRUN-249-H to P2 defensive based on English n=3 baselines that never fired `read_only_planning_hard_veto_block`. Mandarin trace #3 fired this exact path 30 times, proving:

- **English n=3 is NOT a complete baseline** for prioritization.
- Future trace-driven prioritization must include at least one Mandarin trace cell.
- Multi-language n=3 is the new floor for agrun harness work.

## Recommended next steps (no hardcoded fix)

Open AGRUN-253 with these signal/tool subtasks:
- 253-A: `normalize_headings` accepts CJK section markers (`一、`, `（一）`, `1.`, `第一节` mixed).
- 253-B: `source_search_saturation_signal` when read_only_planning hard_veto `ignoredCount >= 3` AND sources are already sufficient.
- 253-C: duplicate-section-numbers detector handles Chinese numeral cross-checking so `1.` and `一、` are not treated as different.
- 253-D: investigate Mandarin duration variance (5–28 min on same config) — possibly Gemini API Mandarin latency or signal-density issue.
- 253-J: n=3 Mandarin after-trace acceptance gate — at least 2/3 userGoalSatisfied=true.

## Linked

- task.md `### AGRUN-246` and `### AGRUN-253`
- KB project item `production-agent-harness-for-agrun-js` kbcid `agrun.runtime`
- Cross-references: `agrun_docs/live-tests/agrun-249-after-trace-2026-05-24.md`, `agrun_docs/live-tests/agrun-246-j-mandarin-post-249-2026-05-24.md`
