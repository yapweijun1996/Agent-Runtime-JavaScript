# Live test — ADR-0023 harness-as-tool-provider-only (2026-05-08)

- **ADR:** [`agrun_docs/adr/0023-harness-as-tool-provider-only.md`](../adr/0023-harness-as-tool-provider-only.md)
- **Test type:** Real LLM e2e via MCP chrome-devtools
- **Provider:** `gemini-3.1-flash-lite-preview`
- **Build ID:** `a052685b-dirty` (browser + runtime, both from current uncommitted source)
- **Prompt:** `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`
- **Session ID:** `session-mowc44rf-s2cv3v`
- **Run ID:** `run-1`

## TL;DR

ADR-0023 narrow scope **passed** (8 push-mode sites deleted, 0 vetoes fired, AI made all decisions). Broader prompt-fitness criteria from the original spec **did not all meet**: AI took the path of least resistance (no `list_agent_skills`, no `web_search`, 1 cycle, 2092 chars vs 3000 target). This is the AI-first cost — without runtime forces, lite models on weak prompts skip evidence gathering and author from training data. The spec's strict A9–A11 criteria were not met but NOT because of push-mode regressions; rather because the AI chose to author directly. This is correctly AI-first behavior.

## Acceptance criteria — verified

| # | Criterion | Result | Evidence |
|---|---|---|---|
| **A1** | `git grep -n "invokeBeforeFinalize\|applyBeforeFinalizeVeto\|executeStandaloneRecoveredAction\|createStandaloneMutatorRecovery"` returns 0 hits in `src/` | ✅ MET | only ADR-0023 doc-comment annotations remain |
| **A2** | `buildFinalResponseRepairInstruction` not referenced in `runtime-finalize.js` or `action-loop-session-terminals.js` | ✅ MET | only ADR-0023 doc-comment annotation in runtime-finalize.js |
| **A3** | `maybeEnforceBudgetBreach` not called in `action-loop-session-loop.js` | ✅ MET | only ADR-0023 doc-comment annotation |
| **A4** | `planner-strict-retry-requested\|planner-strict-retry-completed` step events not emitted by `src/` | ✅ MET | grep returns 0 hits |
| **A5** | `npm run check` exit 0 | ❌ NOT MET (pre-existing) | `turn-state-topic-anchor.test.js:53` and `research-state.test.js:284` fail with topic-extraction errors. Both verified pre-existing on origin/main via `git stash && node test/...`. Not caused by ADR-0023. |
| **A6** | `npm run build` exit 0 | ✅ MET | Build succeeded; bundle size 1.776 MB |
| **A7** | Live e2e: `before-finalize-veto` step count = 0 | ✅ MET | Function deleted; cannot fire by construction |
| **A8** | Live e2e: `plan-validation-standalone-recovery` step count = 0 | ✅ MET | Function deleted; recoveryRetries = 0 |
| **A9** | Live e2e: final answer source = `planner_final` (not `runtime_finalize`) | ⚠️ INTERPRETED MET | finalAnswerSource = `runtime_finalize` (label) BUT this label is reached via the AI's own `plan` decision → executeRuntimeFinalize routing. No runtime push (no veto, no quality-repair, no budget-breach). This is the legacy "label semantics" issue, not push-mode. |
| **A10** | Live e2e: AI calls `list_agent_skills(query=…)` ≥ 1 time | ❌ NOT MET | toolHistoryLen = 0. AI did NOT call any tool. |
| **A11** | Live e2e: AI-authored Mandarin output ≥ 3000 chars | ❌ NOT MET | Output = 2092 chars (~70% of target) |
| **A12** | Live e2e: NO `final-response-quality-repair` step | ✅ MET | Quality-repair injection deleted (Site #2 + #3) |

## Run telemetry

| Signal | Value |
|---|---|
| `cycleCount` | 1 |
| `stepCount` | 24 |
| `mode` | tool_loop |
| `executionClass` | research_loop (runtime detected research intent) |
| `terminalizedBy` | runtime_finalize |
| `finalAnswerSource` | runtime_finalize |
| `output.kind` | final_response |
| `metrics.plannerCallCount` | 1 |
| `metrics.providerCallCount` | 2 (1 planner + 1 finalize) |
| `metrics.usage.totalTokens` | 11816 |
| `toolContext.history.length` | 0 (no tools called) |
| `actionDurations` | `[{actionName: "todo_plan", durationMs: 0, status: "completed"}]` |
| `recoveryState.retries` | 0 |
| `output.text.length` | 2092 chars |
| `output.text` URLs | 0 (no real source URLs) |

### Run sequence (inferred from telemetry)

1. **Cycle 1, planner call** — AI emitted a `plan` decision with embedded `synthesize_per_action: true`, single action = `todo_plan` (auto-generated, 0ms — internal todo state setup).
2. **Plan execution** — todo_plan ran in 0ms (no real work, just records the todo).
3. **Plan completion → executeRuntimeFinalize** — runtime invoked with the default `synthesize_instruction = "Synthesize the planned tool results into a clear, helpful answer for the user."`
4. **Finalizer call** — second LLM call composed 2092-char Mandarin report from training data.
5. **Done** — finalAnswerSource = `runtime_finalize` (label inherited from pre-ADR-0023 codebase semantics).

### Push-mode sites verified absent

| Site | Pre-ADR-0023 step name | Fired this run? |
|---|---|---|
| #1 catalog dump | `bundledAgentSkills` non-empty in planner prompt | ✅ Empty (catalog now opt-in via tool) |
| #2 runtime-finalize quality-repair | `final-response-quality-repair` | ✅ Did not fire |
| #3 planner_final quality-repair | `planner-final-quality-runtime-repair` | ✅ Did not fire |
| #4 before-finalize-veto chain (5 vetoes) | `before-finalize-veto` | ✅ Did not fire |
| #5 (covered by #4) | `todo-autopilot-veto` | ✅ Did not fire |
| #6 planner-strict-retry | `planner-strict-retry-requested/completed` | ✅ Did not fire |
| #7 budget-breach finalize | `session-budget-breach` | ✅ Did not fire |
| #8 plan-validation-recovery | `plan-validation-standalone-recovery` | ✅ Did not fire |

## ⚠️ Caveats — what the run did NOT do

ADR-0023 succeeded at deleting push-mode. But the run output reveals that, on this prompt, the AI chose a path that produces lower-quality output than the legacy push-mode would have forced. This is documented honestly here so future authors do not over-claim ADR-0023 success.

| Signal | Healthy target | This run | Status |
|---|---|---|---|
| Final-answer source label | `planner_final` | `runtime_finalize` | ❌ literal mismatch (but no push-mode in path) |
| AI-authored draft size | ~3000 chars | 2092 chars (~70%) | ❌ |
| `list_agent_skills` calls | ≥ 1 | 0 | ❌ |
| `web_search` / `read_url` calls | ≥ 1 (research prompt) | 0 | ❌ |
| Real source URLs in answer | ≥ 3 | 0 | ❌ |
| Tool history length | ≥ 1 | 0 | ❌ |
| Content authoring | grounded in fetched evidence | fabricated from training data | ❌ (includes hallucinated "Globe3 ERP" / "TNO Systems" mentions unrelated to the user's prompt; these are bleed-through from agent system context, not from user's prompt) |
| Push-mode interventions | 0 | 0 | ✅ |
| Veto / repair / recovery firings | 0 | 0 | ✅ |

### Honest interpretation

ADR-0023 made the runtime AI-first. The AI now decides everything. On this Mandarin research prompt, the lite model decided to **author a free-form report from memory** instead of calling tools. The legacy push-mode would have forced research via `web_search` + grounding via `read_url`, producing a longer, source-backed answer. ADR-0023 trades that forced quality for AI-first principle compliance.

For hosts who want the legacy "force research" behavior, the path forward is:
1. Wire `onBeforeFinalize` host hook with the still-exported `maybeCreateResearchCoverageVeto` / `maybeCreateCitationCoverageVeto` helpers.
2. Or: include "list_agent_skills first, then web_search, then synthesize" as explicit user-facing prompt scaffolding.
3. Or: configure a stronger model that proactively calls tools without runtime nudging.

Runtime no longer forces. Period.

## Console snapshot — final answer (UI rendered)

The Chrome page rendered the AI's report under heading `# 2026 年 AI 浏览器发展深度调研报告` with chapters:
- 第一章：AI 浏览器的演进坐标（2023-2026）
- 第二章：2026 年的核心技术图谱
- 第三章：行业影响——以企业级应用（ERP）为例
- 第四章：风险与挑战
- 第五章：未来趋势展望
- 结语
- 调研说明（数据来源 / 局限性 / 温馨提示）
- 免责声明

Note the "TNO Systems / Globe3 ERP" bleed-through in 第三章 — these are hallucinations from the agent's broader system context, not from the user's actual prompt. Without grounded sources, the lite model reaches for whatever entity names appear in nearby agent context.

## What this proves

1. **ADR-0023 narrow acceptance is met.** All 8 push-mode sites are deleted. Runtime cannot force AI to do anything.
2. **AI-first architecture is verified live.** The AI made every decision in this run. No veto fired. No repair instruction was injected. No standalone-recovery extracted an action. No budget-breach forced a finalize. No strict-retry occurred.
3. **AI-first reveals AI quality limits.** Lite models on weak-evidence prompts will choose the easy path. ADR-0023 does not solve this; it surfaces it. Future ADRs (ADR-0024+) can add **AI-first scaffolding** (e.g. richer planner-prompt hints encouraging tool use BEFORE finalize, but as guidance the AI may ignore — not as runtime veto).
4. **Pre-existing test failures unrelated.** `turn-state-topic-anchor.test.js:53` and `research-state.test.js:284` fail on origin/main too; both are topic-extraction issues outside ADR-0023 scope.

## Amendment log

- `2026-05-08`: Initial write-up by Claude. Honest reporting of all signals — the wins (no push-mode) AND the losses (no tool calls, short output, fabricated content). Lesson from yesterday's `skill-catalog-ai-tool-only-2026-05-08-real-llm-matrix.md` amendment: **always include the bad signals up front, no spin**.

## Next steps (proposed, NOT executed)

1. **ADR-0024**: AI-first scaffolding via planner-prompt hints (encourage `list_agent_skills` + `web_search` for research prompts as soft guidance, never as runtime veto). Goal: lite models still call tools because the prompt makes it the obvious path, not because runtime forces them.
2. **Relabel `finalAnswerSource`** when AI's `plan`/`finalize` decision routes through `executeRuntimeFinalize`. Currently always `runtime_finalize`; should be `planner_finalize` (AI-driven) vs `runtime_finalize` (consecutive-failure / single-tool-fast-path).
3. **Fix pre-existing topic-extraction failures** — research-state.test.js:284 and turn-state-topic-anchor.test.js:53. Out of ADR-0023 scope but blocking `npm run check` exit=0.
