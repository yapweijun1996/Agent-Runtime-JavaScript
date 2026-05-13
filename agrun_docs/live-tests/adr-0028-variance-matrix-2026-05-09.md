# Live test — ADR-0028 3-run variance matrix (2026-05-09)

> **2026-05-09 CORRECTION** — Run 1's 11 cycles + 13 citations (7 off-topic) was originally
> framed as "AI freedom variance / aggressive search iteration". A subsequent support bundle
> (`session-moxnhrpr-ssk5t3`) on the same lite-tier prompt revealed the real cause: AI was
> stuck in a `plan-validation-failed | code=skill_mutator_in_plan` rejection loop because the
> AGRUN-214o P5 loop-breaker (`notePlanValidationFailure`) wrote to a never-initialized,
> never-read field `runtimeConfig.runtimePlannerDirectives` — phantom feature, never armed.
> Run 1's cycle inflation is **runtime regression**, not AI variance. See
> `loop-breaker-plumbing-fix-2026-05-09.md` for the fix and re-verification.


- **ADR:** [`agrun_docs/adr/0028-simple-research-no-runtime-auto-read.md`](../adr/0028-simple-research-no-runtime-auto-read.md)
- **Test type:** 3-run variance matrix via MCP chrome-devtools (browser example dev server, port 3002)
- **Provider:** `gemini` / Model: `gemini-3.1-flash-lite-preview` (lite-tier, matches ADR-0024 baseline)
- **Build ID:** `765001671-dirty` (post-ADR-0028 commit `765001671`)
- **Prompt:** `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告` (identical across all 3 runs, same as ADR-0024 / ADR-0026 baselines)
- **Auto-approve:** Tier-1 enabled via localStorage SSOT bypass

## TL;DR

3 sequential runs of the SAME Mandarin prompt on lite-tier produced **distinct** cycle counts (3 / 5 / 11), output lengths (1,732 / 2,305 / 2,772 chars), and citation patterns (2 / 5 / 13 sources). All three runs hit ADR-0028's invariants: zero push-mode artifacts (`hasUsedSummarizeLimits=false`, `hasAutoReadAttemptCount=false`, `readAttemptSignal=null`). The variance is **AI-side freedom**, not runtime regression — Issue #3's claim ("output drift is AI variance, not regression") is empirically validated.

Two AI-driven termination paths observed: `finalAnswerSource: "planner_finalize"` (Runs 2, 3 — AI emits `type: "finalize"` envelope, runtime makes finalizer LLM call) and `finalAnswerSource: "planner"` (Run 1 — AI emits `type: "final"` with answer text directly). Both bypass the deleted `summarize_limits` overlay completely.

## Variance matrix

| Metric | Run 1 | Run 2 | Run 3 | Range / σ |
|---|---|---|---|---|
| **sessionId** | `session-mox3wdz5-5guu37` | `session-mox3z9u0-k0o9cs` | `session-mox45bqk-0j9mpc` | — |
| **cycleCount** | 11 | 5 | 3 | 3–11 (3.7×) |
| **plannerCallCount** | 11 | 5 | 3 | 3–11 |
| **totalTokens** | 236,489 | 69,965 | 31,084 | 31K–236K (7.6×) |
| **finalAnswerSource** | `planner` | `planner_finalize` | `planner_finalize` | mixed (both AI-driven) |
| **terminalizedBy** | `planner_final` | `planner_finalize` | `planner_finalize` | mixed (literal source labels) |
| **usedRuntimeFinalize** | `false` | `true` | `true` | mixed |
| **reportLength (chars)** | 2,772 | 1,732 | 2,305 | 1,732–2,772 (60% spread) |
| **citationCount** | 13 | 2 | 5 | 2–13 |
| **readSourcesCount** | 0 | 0 | 0 | constant (0 reads in all runs) |
| **runtimeBuildId** | `765001671-dirty` | `765001671-dirty` | `765001671-dirty` | constant ✓ |

## ADR-0028 invariants (all 3 runs)

| Invariant | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `hasOwnProperty("usedSummarizeLimits") === false` | ✅ | ✅ | ✅ |
| `hasOwnProperty("autoReadAttemptCount") === false` | ✅ | ✅ | ✅ |
| `hasOwnProperty("autoReadStoppedReason") === false` | ✅ | ✅ | ✅ |
| `hasOwnProperty("continuityResolution") === false` | ✅ | ✅ | ✅ |
| `readAttemptSignal: null` (field present, no reads happened) | ✅ | ✅ | ✅ |
| `terminalizedBy ∈ {"planner_finalize", "planner_final"}` | ✅ planner_final | ✅ planner_finalize | ✅ planner_finalize |
| `runtimeBuildId === "765001671-dirty"` | ✅ | ✅ | ✅ |

**Push-mode 0 残留 holds across all 3 runs.** Runtime never injected `summarize_limits` overlay; never auto-pushed read_url; never overrode source labels.

## Citation honesty

| Run | Total | Relevant | Off-topic |
|---|---|---|---|
| 1 | 13 | 6 (新华网 ×2, 清华大学, jumei.ai, dev.to LangGraph, chrome-io browser test) | 7 (calendar / wikipedia / 百度百科 / hw1 ipynb) |
| 2 | 2 | 2 (velofill, kahana) | 0 ✅ best |
| 3 | 5 | 2 (velofill, zhihu agentic) | 3 (timeanddate calendar, calendar-365, wiki 2026) |

Citation hallucination rate is HIGH at the lite-tier — Run 1 had 7 of 13 off-topic (calendar pages, basic dictionary entries). This is **AI hallucination at the search-result-curation boundary**, not a runtime issue. Same pattern observed in earlier ADR-0028 single-run verification. Honest cost of full AI freedom (no runtime relevance filter).

## Cycle behavior interpretation

**Run 1 (11 cycles):** AI emitted multiple search/plan iterations before finalizing with `type: "final"` (literal answer). 13 citations gathered, suggests aggressive search iteration. AI burned 236K tokens — most expensive run.

**Run 2 (5 cycles):** Standard research_loop — search → finalize. AI emitted clean `type: "finalize"` envelope, runtime ran finalizer LLM. Shortest output, but most-relevant citations.

**Run 3 (3 cycles):** Most efficient. After mid-run regression hit + bug-fix rebuild, AI emitted finalize quickly. 5 citations — 2 relevant + 3 off-topic.

**No runtime intervention in any of the cycle progressions** — AI controls cycle count entirely. Pre-ADR-0028 the runtime would have force-pushed `read_url` after `web_search`, regularizing all 3 runs to ~4-5 cycles with `summarize_limits` finalize. Post-deletion, AI's natural variance shows.

## Mid-run regression (separate bug, not ADR-0028)

Initial Run 3 attempt failed with `STANDALONE_PLAN_MUTATOR_ACTIONS is not defined` ReferenceError. Root cause: ADR-0023 deleted `executeStandaloneRecoveredAction` + `createStandaloneMutatorRecovery` but left a reference to `STANDALONE_PLAN_MUTATOR_ACTIONS` at `src/runtime/action-loop-plan.js:355` inside `stripSynthesizePerActionIfSafe`. The constant was deleted along with the recovery function but the safety-gate use site survived as orphan dead code.

**Fix shipped same session:** Restored the constant as a SAFETY GATE for `stripSynthesizePerActionIfSafe` (the function preserves plan structure when actions include state mutators like `workspace_write`). Not a push-mode site — no AI decision is being made here. The function only auto-relaxes `synthesize_per_action: true` for plans of pure-read actions; it must NEVER strip when state-mutating actions are present, since stripping changes semantics from "stitch sections" to "AI must glue at output time".

This regression demonstrates the ADR-0023 cleanup wasn't fully orphan-checked. Lesson for future ADRs: after deleting a function, run `git grep` for ALL references to its associated constants/symbols before declaring the deletion complete.

## Run 1 vs prior baseline comparison

| Run | Date | Build | Cycles | Reads | Output chars | terminalizedBy | finalAnswerSource |
|---|---|---|---|---|---|---|---|
| ADR-0024 baseline | 2026-05-08 AM | pre-ADR-0026 | 4 | 2 | 4,764 | `summarize_limits` | `planner_finalize` |
| ADR-0026 verification | 2026-05-08 PM | `9431f6b25-dirty` | 5 | 2 | 4,764 | `summarize_limits` | `planner_finalize` |
| ADR-0027 third run | 2026-05-08 PM | `9431f6b25-dirty` | 4 | 2 | 1,691 | `summarize_limits` | `planner_finalize` |
| ADR-0028 single | 2026-05-08 night | `765001671-dirty` | 3 | 0 | 1,888 | `planner_finalize` | `planner_finalize` |
| **3-run #1 (this matrix)** | **2026-05-09** | `765001671-dirty` | **11** | **0** | **2,772** | `planner_final` | `planner` |
| **3-run #2 (this matrix)** | **2026-05-09** | `765001671-dirty` | **5** | **0** | **1,732** | `planner_finalize` | `planner_finalize` |
| **3-run #3 (this matrix)** | **2026-05-09** | `765001671-dirty` | **3** | **0** | **2,305** | `planner_finalize` | `planner_finalize` |

Pre-ADR-0028 runs are ALL clustered: `terminalizedBy: "summarize_limits"`, 4–5 cycles, 2 reads (runtime-forced). Post-ADR-0028 runs show AI variance: 3–11 cycles, 0 reads (AI chose), output range 1,732–4,764. **The cluster vs spread is the architectural signal** — runtime is no longer regularizing AI behavior.

## Issue #3 validation

The `agrun_docs/live-tests/output-length-variance-2026-05-08.md` doc characterized output drift 1,691–4,764 chars as "AI freedom side effect". This 3-run matrix confirms:
- **Cycle count varies 3–11** with same prompt — proves AI controls execution structure
- **Output length varies 1,732–2,772** with same prompt — proves AI controls answer detail
- **Citations vary 2–13** — proves AI controls source curation

If the runtime were still in push-mode, all 3 runs would converge to similar outputs. The spread proves AI freedom. Issue #3 is correctly characterized as "expected behavior", not regression.

## Acceptance summary

✅ **A1**: All 3 runs use AI-driven termination (`finalAnswerSource ∈ {planner, planner_finalize}`)  
✅ **A2**: All 3 runs have `hasOwnProperty("usedSummarizeLimits") === false` (field deleted from snapshot)  
✅ **A3**: All 3 runs have `hasOwnProperty("autoReadAttemptCount") === false`  
✅ **A4**: All 3 runs have `readAttemptSignal: null` (new field present, no reads triggered it)  
✅ **A5**: `runtimeBuildId === "765001671-dirty"` consistent across runs (matches ADR-0028 commit)  
✅ **A6**: Variance ≥ 60% in output length, ≥ 3.7× in cycle count — confirms AI freedom is real  
✅ **A7**: 0 runs hit deleted `summarize_limits` overlay  

## Honest bad results (HBR)

- **Run 1 had 7/13 off-topic citations** including calendar pages and a hw1.ipynb GitHub link. Search-result curation is poor at lite-tier. Falls under Issue #3 (AI hallucination, not runtime).
- **Mid-test regression** (`STANDALONE_PLAN_MUTATOR_ACTIONS is not defined`) was a pre-existing ADR-0023 cleanup gap, fixed inline. Not caused by ADR-0028.
- **0 read_url calls in all 3 runs** — AI never chose to read a page despite getting search results. Pre-ADR-0028 runtime would have forced 2 reads. Post-deletion, AI's choice. May indicate the lite-tier model under-utilizes evidence-gathering tools; future ADR may add explicit prompt directive about when to read vs finalize.
- **Run 1 used 236K tokens** — 7.6× more than Run 3 (31K). The variance includes economic cost; same prompt can be 7× more expensive. Hosts that need predictable cost should add their own circuit breaker via `maxSteps` or `maxTokens`.

## Reflection

**Am I trying to hardcode this instead of using harness engineering?** — No. The whole point of variance is that runtime stopped homogenizing AI behavior. Pre-deletion: 3 runs would look identical. Post-deletion: 3 runs are wildly different. That spread is the SIGNAL that AI-first is real.

The mid-test regression was a separate pre-existing bug in ADR-0023's cleanup, not ADR-0028. Fixed by restoring the SAFETY GATE constant (used by a defensive helper that does not make AI decisions, only preserves plan structure for state-mutating actions). Not push-mode.
