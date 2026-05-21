# ADR-0033: OODAE as Single-Call Structured Emission + Lite-Model Decomposition Strategy

Date: 2026-05-19
Status: Accepted (Tier A shipped + invalidated 2026-05-20; Tier B ABANDONED 2026-05-20 evening; Tier A.5/A.6 (B1+B4+B2) SHIPPED + VALIDATED 2026-05-20 evening — flash-lite cleared 1000-word target for first time at 1048 candidateWords; X1-X3 follow-up bottlenecks tracked separately. See "Part 4: Root Cause Re-Investigation" + `agrun_docs/live-tests/b1-b4-fix-2026-05-20/SUMMARY.md`)

## Context

- A recurring question during development: should OODAE (Observe, Orient, Decide, Act, Evaluate) require 5 separate LLM API calls per cycle — one per cognitive phase?
- ADR-0031 (2026-05-16) confirmed envelope mode as the canonical production path. The session producing this ADR reviewed ReAct (arxiv 2210.03629), Plan-and-Solve (arxiv 2305.04091), Least-to-Most (arxiv 2205.10625), Reflexion (arxiv 2303.11366), and Anthropic's Building Effective Agents article against agrun's live data.
- Empirical KB data (live test v8, 2026-05-19): gemini-3.1-flash-lite ran 84/90 cycles and produced only 437/3000 words (15%). Root cause: single envelope schema was cognitively too heavy for the lite model — it must simultaneously read 7+ convergence signals, write `reasoning`, choose `type`+`args`, and sometimes fill `finalReadiness.requirementsAssessment`. Average output was ~6 words per workspace step and readOnlyPlanningState was ignored 21 times.
- By contrast, gpt-5-mini (PASS 2/2) and gemini-3-pro-preview (PASS 1/1 stable run) complete the same task cleanly under the same envelope schema.
- Academic backing for cognitive-load decomposition: Plan-and-Solve (ACL 2023) showed dividing a task into "plan first, then execute subtasks" dramatically outperforms zero-shot chain-of-thought on GPT-3. Least-to-Most (ICLR 2023) showed sequential subproblem decomposition lifted GPT-3 from 16% to 99% on SCAN benchmark. Anthropic explicitly names "prompt chaining" as one of five endorsed agent workflow patterns.

## Decision

### Part 1: Envelope IS the single-call OODAE structured emission

Each envelope-mode LLM call completes a full OODAE cycle in one emission. Runtime does not split cognition across multiple API calls by phase.

The mapping is:

| OODAE Phase | How it appears in envelope mode | Owner |
|---|---|---|
| **Observe** | Runtime projects `toolContext.lastResult`, `readSources`, `virtualWorkspace`, `observation`, `loopState.*` into planner prompt | Runtime (mechanism) |
| **Orient** | `reasoning` field — AI's rationale before choosing action | AI (policy) |
| **Decide** | `type` + `name` + `args` — the chosen next step | AI (policy) |
| **Act** | Runtime executes chosen tool or terminal handler; no LLM call | Runtime (mechanism) |
| **Evaluate** | `finalReadiness.requirementsAssessment` on `finalize`; implicit in `reasoning` for non-terminal actions | AI (policy) |

This is structurally equivalent to ReAct: one LLM call per turn, reasoning + action interleaved, observation fed back as context. Envelope mode is richer than native_tools in this regard — it enforces a `reasoning` field and a structured `requirementsAssessment` that native tool_use does not.

**Rejected: 5-call-per-cycle per-phase split.**  
Runtime deciding "Observe call context", "Orient call context", etc. is push-mode: it requires runtime to slice AI's cognitive context, which is a new hardcode. The 3× cost / latency multiplier also renders lite models unusable as intended fast-turnaround workers.

### Part 2: Lite-model cognitive overload is the correct diagnosis for flash-lite failure

The root cause is not a harness signal gap — it is that the single envelope schema demands too much from a lite model in one emission. Adding more runtime advisory/veto signals makes this worse, not better.

The correct mitigation is **progressive schema reduction**, not per-phase call splitting.

**INVALIDATED (2026-05-20 evening, raw emission audit).** This entire diagnosis was wrong. The 6-15 words/step figure was derived from `final_candidateWords / total_cycles` — a misleading average that mixed productive workspace cycles with the 56-71 hard_veto'd finalize attempts. When the v16 run2 JSONL was audited directly:

- flash-lite wrote **67-73 words per successful workspace_write/workspace_append** call (normal capacity)
- 11 of 14 workspace operations were `workspace_write` (overwrite!), each restarting the file with a fresh "# Definition" opening, losing all prior work
- 52-66 hard_veto_fired events of type `finalize/terminal-repair-hard-veto-blocked` consumed 50%+ of cycles without producing content
- AI never escaped the terminal-repair lock because attempting forbidden `finalize` increments `ignoredCount` but never reduces `activeDeficits`

There is **no per-step word output ceiling on flash-lite**. The bottleneck is a runtime/prompt regression introduced by Tier A itself (compact mode strips the workspace_write-vs-append guidance, see Part 4). See "Part 4: Root Cause Re-Investigation" for full data and the actual fixes.

### Part 3: Three-tier remediation path (ordered from cheapest to richest)

**Tier A — Compact Envelope Auto-Detection (IMPLEMENTED 2026-05-20)**

- When the effective model name matches a lite-tier marker (`flash-lite`, `flash`, `mini`, `haiku`, `nano`) using word-boundary matching, the runtime forces `compact: true` in `selectPlannerSystemPromptProfile()` with reason `"lite_tier_model_compact"`. The override wins over rich state (active skill / todo / workspace) but yields to the explicit host opt-out (`request.compactPlannerSystemPrompt === false`).
- `compactExamples: true` was already the runtime default in `buildPlannerSystemPrompt` (`planner-prompt.js:132`); Tier A adds the matching `compactSystemPrompt: true` policy for lite models so the heavier guidance lines are also trimmed.
- Hosts can override the name-string heuristic with `request.modelTier: "lite"|"capable"` — the long-term migration target named in the Risks section.
- Code pointers:
  - `src/runtime/provider-capabilities.js` — `isLiteTierModel(model, { modelTier })`, `LITE_TIER_MARKERS`. Word-boundary regex (`\b...\b`) prevents `mini` from false-matching inside `gemini`.
  - `src/runtime/planner.js:537` — `selectPlannerSystemPromptProfile()` applies the lite-tier override before state-based checks.
  - `test/unit/provider-capabilities.test.js` — heuristic + override unit tests.
  - `test/unit/lite-tier-compact-policy.test.js` — policy precedence tests (opt-out > override > heuristic > state).
  - `test/helpers/planner-assertions.js` — compact-mode prompt asserter now handles `workspace_publish_path_required` (`Terminal finalize envelope is unavailable now`) the same way the base-mode branch always did.
- Validation hook: `NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite node test/node-agrun-3000-live.mjs` — target `candidateWords > 1000` (vs current baseline 437).
- **Validation result (2026-05-20): FAILED.** 3 live runs produced 410 / 768 / 566 words (median 566, mean 581). None cleared 1000. ignoredCount went UP (70/57/71 vs baseline 21).
- **Self-inflicted regression discovered (2026-05-20 evening, see Part 4).** Tier A's `compactSystemPrompt: true` override for lite-tier directly REMOVES the load-bearing workspace_write-vs-append guidance block (`planner-prompt.js:173-184`) and `buildGuidanceLines()` returns empty (`planner-prompt.js:138`) in compact mode. The removed guidance is the exact text lite-tier needs to choose `workspace_append` over `workspace_write` for incremental writing. Tier A's premise ("compact prompt helps lite model focus") was correct for the system_lines but wrong for the guidance_lines block — that block contained decomposition instructions, not noise.
- **Status revision**: Tier A is now considered a partial regression. The lite-tier detection mechanism (`isLiteTierModel`, `LITE_TIER_MARKERS`) is kept as a useful policy hook, but the `compactSystemPrompt: true` action it triggers will be REVERSED in Tier A.5 fix — lite-tier needs MORE guidance for incremental writing, not less.

**Tier B — Two-Step Reflect→Act Mode (FALSIFIED 2026-05-20 late evening by owner-directed PoC — fully abandoned)**

**Final status (2026-05-20 late evening):** Project owner directed a PoC implementation despite the academic review opposing it. The PoC was built (~1 hour), live-tested on `gemini-3.1-flash-lite`, and produced **fewer candidateWords (941) than the simpler B1+B4 single-envelope baseline (1048)** at roughly equal LLM cost. The Reflect protocol itself worked flawlessly (43/43 parse success), but the narrow Reflect `next_intent` enum dropped B1+B4's "use workspace_append after first write" guidance, leading to 19 workspace_write overwrites (vs 4 in B1+B4 baseline). The PoC empirically reproduced the predictions of Illusions of Reflection (same-constraint violation repeats under reflection) and Anthropic's Building Effective Agents (non-decomposable tasks don't benefit from prompt chaining). PoC artifacts: `agrun_docs/live-tests/tier-b-poc-2026-05-20/SUMMARY.md`. PoC code reverted from the working tree; the experiment lives in git history for future reference.

Tier B is now considered SETTLED — neither prompt-chaining nor schema decomposition are viable mitigations for the B1/B2/B4 failure class. The same hypothesis should not be re-opened unless future live data shows a distinct new pattern (e.g. flash-lite emissions failing JSON parse, or reasoning collapse on >5000-token prompts) that the original academic citations did not address.

Reason for abandonment: root-cause investigation 2026-05-20 evening invalidated the premise. Tier B's claimed value was "intent coherence on lite model"; raw data shows the failure is not poor intent coherence but runtime hard_veto'ing AI's intended finalize attempts 56-71 times per run while AI cannot find the unlock action. Splitting LLM calls into Reflect+Act does NOT change the hard_veto fire rate, does NOT restore the missing workspace guidance, and does NOT raise the (already-fine) per-step word capacity. Implementation plan archived at `0033-tier-b-reflect-act-implementation-plan.md` with "ABANDONED" status. Reuse for capable-model A/B testing only if a genuine intent-coherence problem is observed in future data.

**Academic review supporting the abandonment (2026-05-20 evening, 7 papers reviewed):**

| Paper | Finding | Applicability to agrun B1/B2/B3 |
|---|---|---|
| ReAct (arxiv 2210.03629, ICLR 2023) | One LLM call interleaving reasoning + action beats RL baseline by +34%/+10%. ReAct itself is single-call, NOT two-call. | Misapplied as Tier B basis. Envelope mode already IS ReAct. |
| Plan-and-Solve (arxiv 2305.04091, ACL 2023) | "Plan then execute subtasks" beats Zero-shot-CoT on GPT-3. | Supports Reflect+Act in principle — but ONLY when task is cleanly decomposable. |
| Least-to-Most (arxiv 2205.10625, ICLR 2023) | GPT-3 on SCAN: 16% → 99% with sequential subproblem decomposition. | Supports decomposition for weak models — but the decomposition needed is "split task into subsections" (which the prompt already does), not "split intent from args". |
| Small LLMs Are Weak Tool Learners (arxiv 2401.07324) | Planner + caller + summarizer split outperforms single LLM; weak models benefit most. | Strongest theoretical support for Tier B — but only when the BUG is intent-action mismatch, not when prompt is missing guidance. |
| Self-reflection effect (arxiv 2405.06682, FLLM 2024) | 9 LLMs show significant lift from self-reflection (p<0.001). | Supports reflection in general; doesn't speak to whether reflection fixes hard_veto loops specifically. |
| **Illusions of Reflection (arxiv 2510.18254, 2025)** | **LLM reflection repeatedly violates the same constraints; improvements come from "accidentally generating legal output" not "principled error correction". Reliable constraint adherence needs EXTERNAL enforcement, not AI self-reflection.** | **Direct invalidation of Tier B for B2**: AI declaring `next_intent: finalize` in Reflect would still pick `finalize` in Act → still hard_veto → same wasted cycle, now with 2x LLM cost. |
| Anthropic "Building Effective Agents" | Prompt chaining only worth it when task cleanly decomposes into fixed subtasks. Otherwise just adds latency. | Act output depends on runtime veto state that Reflect doesn't observe → not a clean decomposition. |
| Reflexion (arxiv 2303.11366) | Reflexion's power is CROSS-episode (between trials), not within-cycle per-step decomposition. | Applying Reflexion to within-cycle Reflect+Act conflates two different concepts. |

**Per-bug analysis (academic + empirical) showing Reflect+Act cannot fix B1/B2/B3:**

| Bug | Could Reflect+Act fix? | Reasoning |
|---|---|---|
| B1 (workspace guidance dropped in compact) | ❌ No | Both Reflect and Act calls receive the same compact prompt without the guidance. Splitting LLM calls doesn't restore deleted text. |
| B2 (terminalRepair lock, AI re-tries forbidden finalize) | ❌ No | Per Illusions of Reflection: AI declaring `next_intent: finalize` then picking `finalize` in Act produces the same hard_veto. Reflect doesn't enforce constraints; runtime veto does. |
| B3 (500-char content mimicry) | ❌ No | Both Reflect and Act prompts expose the same `serializePromptValue(...500)` truncation marker. Mimicry source is unchanged. Doubles the exposure if anything. |

**When Reflect+Act WOULD genuinely help (conditions to watch for in future live data):**

1. Strategy drift: AI cycles between workspace/search/finalize within ~10 cycles without committing to one. `next_intent` enum would force commitment.
2. Intent-action mismatch: AI's reasoning says "search" but its action picks `workspace_write`. Anchor section keeps them aligned.
3. Post-A.5/A.6/A.7 ignoredCount still > 20: AI cannot find allowed actions even with guidance present; structured Reflect/Act anchor would help.

None of these patterns appear in v8/v16/B1+B4 data. Tier B remains correctly abandoned until live data shows one of these specific patterns.

**Original Tier B spec (kept for historical context, do NOT implement):**

- Status: implementation plan approved at [0033-tier-b-reflect-act-implementation-plan.md](./0033-tier-b-reflect-act-implementation-plan.md). Lite-tier models would default to `split_envelope` mode (auto-detected via `isLiteTierModel()`); capable models remain on single-envelope default. Code work paused until AGRUN-243 decision lands (Tier B vs Alternative 5).
- **Acceptance criteria** (must match or beat for Tier B to be worth the protocol complexity):
  - `candidateWords` median ≥ 1000 across 3 consecutive `gemini-3.1-flash-lite` live runs on `node-agrun-3000-live.mjs` (baseline: 566 median after Tier A)
  - `ignoredCount` median ≤ 30 (baseline: 66 after Tier A; lower = better intent adherence)
  - No regression on capable models: `gpt-5-mini` PASS rate unchanged, `gemini-3-pro-preview` PASS rate unchanged
- **Cost** (additional vs single-envelope):
  - Normal path: ~1.6-2.0x LLM calls per cycle (Reflect call has narrower prompt, not full 2x)
  - Short-circuit terminal: ~0.6x (Reflect smaller than full envelope, no Act call)
  - Empirical estimate over 30-cycle run: avg ~1.5x cost
- **Why Tier B might still help despite per-step ceiling**: Tier B does NOT raise the per-step word output ceiling. It improves **intent coherence** — flash-lite stops mixing "I should write content" and "I should finalize" in the same cycle, so more cycles are actually spent on productive `workspace_append` rather than wasted finalize attempts that the runtime vetoes. Best case: Tier B converts 21 ignored advisory signals + 6 vetoed finalizes into productive workspace cycles, gaining roughly +200-400 words. This MAY clear the 1000-word target on a 3000-word scenario but is not guaranteed.
- Cycle becomes two lightweight emissions:
  1. **Reflect call** — AI emits `{type:"reflect", last_action_helpful, observation_evidence, next_intent, reasoning, terminal_payload?}`. Schema is 5 required + 1 conditional field. `last_action_helpful` is categorical (yes/no/partial/first_cycle); `observation_evidence` quotes `toolContext.lastResult` to ground the assessment (anti-affirm-bias per arxiv 2510.18254).
  2. **Act call** — Runtime injects Reflect output as anchor section into Act prompt. AI emits a standard envelope (`{type:"action"|"plan"|"finalize"|"final"|"clarify", ...}`). AI may override the Reflect-declared intent; inspector flags the mismatch for observability.
- Short-circuit: when Reflect's `next_intent` is `finalize`/`final`/`clarify` AND `terminal_payload` is valid, the Act call is skipped and runtime terminates the cycle directly from Reflect.
- Fail-soft: Reflect parse/schema failure falls back to single-envelope mode for that cycle (no hang, telemetry emitted).
- Veto rules (`terminalRepairState`, `actionPatternConvergence`, `terminalRetryCooldown`, etc.) apply to the Act emission only; Reflect is a free intent declaration.
- AI-first: runtime never prescribes the next intent; never binds the AI to its prior Reflect output.

**Tier C — AI-Driven `think` Envelope (long-term)**

- AI may emit `{type:"think", reasoning:"...", need_more_thought:true}` when it judges another reasoning step is needed before acting.
- Runtime loops on `think` up to a per-cycle ceiling (e.g. 3), then forces an Act call.
- Most AI-first option: AI controls its own reasoning step count. No runtime heuristic for "should this model get more thinking steps?"
- The forced Act call at the ceiling is a **bounded fail-safe**, not push-mode policy: runtime is not choosing the AI's content or intent, it is only stopping a `think` loop from running unbounded. This is the same exception class as the existing circuit-breaker pattern (ADR-0033 Part 1 rejects push-mode policy; bounded resource bounds are acceptable).
- Requires: `think` envelope type, cycle-level loop guard, empirical data on when lite models use it.

### Part 4: Root Cause Re-Investigation (2026-05-20 evening)

After Tier A validation FAILED and a planning session proposed Tier B (Reflect→Act, 5-6 days work) and Alternative 5 (`maxTargetWords:1000`), Codex review challenged the underlying assumption with "you trying to kills the model ability by hardcode?" A raw-emission audit of `tier-a-2026-05-20/run*-flash-lite-tier-a.jsonl` was performed before any code work began.

**Findings (data-grounded, not inferred):**

| Metric | Previous claim | Actual measurement |
|---|---|---|
| Per-step word output of flash-lite | "6-15 words/step ceiling" | **67-73 words per successful workspace_write/workspace_append call** — normal capacity |
| Where the words came from | "AI is writing short" | AI writes adequately; AI keeps choosing `workspace_write` (overwrite) — 11/14 workspace operations in run2 are workspace_write, each restarting the file |
| Why cycles are wasted | "Lite cognitive overload" | **52-66 of 90 cycles consumed by `hard_veto_fired: finalize/terminal-repair-hard-veto-blocked`** — AI's finalize attempts blocked, but no deficit-reducing alternative taken |
| Why AI doesn't take allowed action | unclear | `terminalRepairState.allowedActions` whitelist is buried in loopState; lite-tier model never surfaces it as the salient next step |
| Why content is always 500 chars exactly | unknown | flash-lite mimics the `serializePromptValue(value, 500)` truncation marker visible in prompt for `lastResolution` and `pendingClarification`; it is NOT a runtime cap on workspace content |

The three concrete bugs are:

**B1 — Tier A self-inflicted regression (workspace guidance dropped in compact mode).**
- `src/runtime/planner-prompt.js:138` — `buildGuidanceLines()` returns `[]` when `compactSystemPrompt: true`.
- `src/runtime/planner-prompt.js:173-184` — the entire "Virtual workspace tools..." guidance block is gated by `!compactSystemPrompt`.
- `src/runtime/action-registry.js:78-80` — `workspaceWriteAction` is listed BEFORE `workspaceAppendAction`, creating position bias when guidance is absent.
- Effect: lite-tier (which Tier A forced into compact mode) loses the only prompt text that says "use append when remainingLength is large" and "do NOT call workspace_write again after an append".

**B2 — terminalRepairState lock not surfaced to AI in actionable form.**
- `src/runtime/terminal-repair-state.js:10,14` — `TERMINAL_REPAIR_HARD_VETO_THRESHOLD=3`, `TERMINAL_REPAIR_HIGH_WATER_MARK=6`. Once `ignoredCount ≥ 6`, hard_veto fires regardless of budget.
- `src/runtime/terminal-repair-state.js:127` — `forbiddenDecisions: ["ready","finalize","final_answer","plain_workspace_publish_candidate"]` when active.
- `src/runtime/terminal-repair-state.js:80` — clearing requires `activeDeficits.length === 0`.
- `src/runtime/action-loop-session-loop.js:820-867` — hard_veto observation message: "must use workspace_publish_candidate with decision=limited".
- Effect: AI sees a forbid-list but no salient SINGLE next action. AI re-tries forbidden finalize → ignoredCount climbs → no deficit reduces → permanent lock until cycle/budget exhaustion.

**B3 — 500-char prompt truncation marker copied by lite model into its outputs.**
- `src/runtime/planner-prompt.js:283,286` — `serializePromptValue(plannerState.lastResolution, 500)`, same for `pendingClarification`.
- `src/runtime/planner-prompt-skills.js:88-106` — truncation appends `"..."` and caps at the provided length.
- Effect: flash-lite reads the prompt, observes that loopState fields are 500 chars max, and pattern-matches by writing exactly 500-char workspace content. Capable models do not exhibit this behavior. There is no actual cap on workspace content.

**Causal chain (how the three bugs combine into 437-768 word failure):**

```
B1 (no guidance) → AI picks workspace_write (registry position bias)
   ↓
AI overwrites prior work with each call (~500 chars × B3 mimicry)
   ↓
length deficit never decreases (each write resets the file)
   ↓
B2: activeDeficits.length stays > 0 → terminalRepair never clears
   ↓
AI tries finalize → hard_veto → ignoredCount++ → AI tries finalize again
   ↓
50%+ of cycles wasted on vetoed finalize attempts
   ↓
Final candidateWords = words in single last workspace_write + few appends ≈ 400-800
```

**The fixes (Tier A.5 / A.6 / A.7, all small prompt/observation changes, no architecture change):**

**Tier A.5 — Restore workspace guidance in compact mode (B1 fix).**
- `planner-prompt.js`: gate workspace decision guidance on `hasAction("workspace_write")` ONLY, drop the `!compactSystemPrompt` requirement for the load-bearing append-preference lines.
- Specifically the line "if remainingLength is still large, use workspace_append to expand further rather than calling workspace_write again" must appear in compact mode too.
- Optional: reorder `action-registry.js` to list `workspaceAppendAction` before `workspaceWriteAction` to remove position bias.
- Effort: ~0.5 day. Risk: low — additive prompt change.

**Tier A.6 — Surface allowed-action as salient observation when terminalRepair veto fires (B2 fix).**
- `action-loop-session-loop.js`: when hard_veto blocks an action, the observation message includes ONE concrete next-action recommendation pulled from `terminalRepairState.allowedActions[0]`, with the exact action name and a one-line rationale derived from the active deficit.
- Example transformation: instead of "terminal repair HARD VETO — direct final/finalize blocked; must use workspace_publish_candidate with decision=limited", emit "terminal repair HARD VETO. To unlock: call workspace_append on `final_candidate.md` to reach the requested length (current: 437 words, target: 3000). After 3+ successful appends, finalize will become available."
- This is AI-first decomposition: harness helps lite model see ONE clear next step without choosing for it. AI may still pick a different allowed action.
- Effort: ~1 day. Risk: medium — observation text affects all veto cases including capable models; must regression-test.

**Tier A.7 — Eliminate 500-char content mimicry (B3 fix).**
- `planner-prompt.js:283,286`: replace `serializePromptValue(value, 500)` with a non-numeric summarization (e.g. `summarizeFieldForPrompt(value)`), OR explicitly add a line to workspace tool descriptions: "The `content` field accepts text of any length. Typical long-form chunks are 200-2000+ characters per call."
- Effort: ~0.5 day. Risk: low — descriptive only.

**Validated impact (post Tier A.5 + A.6 + A.7, single run 2026-05-20 evening):**

| Metric | Baseline | Tier A | Expected | **Actual (B1+B4 fix run)** |
|---|---|---|---|---|
| candidateWords | 437 | 566 | >2500 | **1048** ✅ (cleared 1000-target) |
| Canonical path adherence | mixed | mixed | 100% | **100%** ✅ |
| workspace_write share | unknown | ~78% | <20% | **44%** (improved, not at target) |
| ignoredCount | 21 | 66 | <10 | **77** (regressed numerically) |
| hard_veto fire count | unknown | 56-71 | <5 | **72** (regressed numerically) |
| runStatus | failed | failed | passed | failed (MAX_STEPS_EXCEEDED) |

**Interpretation**: candidateWords and canonical-path goals achieved decisively. Hard-veto/ignoredCount numerically regressed but for a "good" reason — AI is now writing real content, which triggers structure-repair convergence on each write (each 500-char chunk creates new duplicate headings), which keeps `workspace_publish_candidate` blocked. The remaining gap to the 3000-word target is gated by three new bottlenecks (X1-X3 below), not by B1/B4 fix quality.

**Newly identified bottlenecks (out of B1/B2/B3/B4 scope, opened as separate tasks):**

- **X1 — Structure-repair convergence lock**: `structureRepairConvergence` removes `workspace_publish_candidate` from `allowedActions` when `duplicate_headings`/`duplicate_section_numbers` detected. flash-lite's 500-char writes each re-introduce duplicates, so structure never clears. Needs either threshold tuning for lite-tier, or "structure=fail + budget=exhausted → publish=allowed" exception.
- **X2 — 500-char content mimicry persists**: flash-lite continues to write exactly 500-char chunks despite explicit "content accepts any length" counter-instruction. The `serializePromptValue(value, 500)` truncation marker in the prompt for `lastResolution` and `pendingClarification` is the source. Needs runtime change: replace numeric truncation marker with non-numeric ellipsis.
- **X3 — Terminal repair high-water-mark too aggressive**: `TERMINAL_REPAIR_HIGH_WATER_MARK = 6` was tuned when AI wrote ~400 words; with B1/B4 fixes AI now writes 1048 words and hits more structure issues, accumulating ignoredCount faster. Hard_veto locks in even though AI is making progress. Consider: reset ignoredCount when AI takes a non-terminal action that mutates workspace, OR raise threshold for lite-tier.

**Lessons (for future ADRs):**

1. Compute per-step capacity from successful workspace cycles, NOT from `total_words / total_cycles`. The latter conflates productive cycles with veto-wasted cycles.
2. When proposing a new tier, audit the previous tier's raw emissions FIRST. ADR-0033 Tier B was 80% specified before the raw audit; that work is now discarded.
3. Compact prompt modes must preserve decomposition instructions (which are load-bearing) and strip only noise (rare-case explanations, multi-paragraph rationales). Tier A drew this line in the wrong place.
4. Hard_veto observations must surface ONE actionable next step, not a forbid-list. Telling a weak model what NOT to do, without telling it what TO do, creates the exact lock observed here.

## Alternatives

1. **5-call-per-cycle OODAE split** (Observe / Orient / Decide / Act / Evaluate as separate LLM calls). Rejected: runtime must slice context per phase (push-mode); 5× cost/latency; Anthropic principle #1 is "maintain simplicity."
2. **Replace lite model with capable model** (stop supporting flash-lite). Rejected: CLAUDE.md rule "harness must support weak models via decomposition"; lite models serve fast-turnaround conversational tasks.
3. **Raise maxSteps only** (give lite model more cycles). Rejected: treats symptom; lite model already ignores advisory signals at 84 cycles. More cycles → more ignored steps, not more progress.
4. **Add more runtime veto signals** (harder enforcement). Rejected: flash-lite already ignores 21 advisory signals; adding harder blocks without reducing schema load does not help.
5. **Reduce scenario target for lite-tier** (PROPOSED then REJECTED 2026-05-20 evening). Initially proposed to define `maxTargetWords: 1000` for lite-tier. **Rejected** after Part 4 root-cause investigation: there is no per-step output ceiling on flash-lite (67-73 words per successful call measured). Reducing the target hardcodes a false capability limit derived from a misleading aggregate metric, violating CLAUDE.md's "harness must support weak models via decomposition (not capability capping)" rule. The real issue is fixable via Tier A.5/A.6/A.7 (prompt-level, no architecture change).

## Consequences

- Pros:
  - Part 1 definitively settles the "5 calls vs 1 call" design question. Engineers won't revisit it.
  - Part 4 produced a data-grounded root cause (B1/B2/B3) replacing the previous chain of inferred ceilings; the fixes are small prompt/observation adjustments, not architecture changes.
  - Tier A's `isLiteTierModel()` lite-tier detection hook (`provider-capabilities.js`) remains useful as a policy switch — Tier A.5+ will use it to route DIFFERENTLY (keep workspace guidance, not drop it).
- Cons:
  - Tier A as shipped is a partial regression (compact mode dropped load-bearing workspace guidance). Tier A.5 fix is required before Tier A can be called net-positive for lite-tier.
  - The ADR went through 24 hours of speculative tier proposals (Tier B Reflect→Act, Alternative 5 maxTargetWords) before raw-emission audit revealed all of them addressed misdiagnosed root causes. Lesson recorded in Part 4 "Lessons".
- Risks:
  - Tier B `next_intent` may be misused by runtime as a router (push-mode risk). Implementers must ensure runtime only uses it as context, not as a forced routing decision.
  - Tier A lite-tier detection via model name string is fragile; should eventually move to a `modelTier: "lite"|"capable"` runtime config field.

## Rollback

- Part 1 is a documentation decision; rollback is deleting this ADR section.
- Tier A: revert `selectPlannerSystemPromptProfile()` in `src/runtime/planner.js:537` to state-only checks (remove the lite-tier branch added by Tier A). Delete `isLiteTierModel`, `LITE_TIER_MARKERS`, and `LITE_TIER_PATTERN` from `src/runtime/provider-capabilities.js`. Remove `modelTier` from public runtime request options. Delete `test/unit/lite-tier-compact-policy.test.js`. The previously-existing `compactExamples` default in `buildPlannerSystemPrompt` is untouched by Tier A — it stays as `compactExamples: opts.compactEnvelopeExamples !== false`.
- Tier B: ABANDONED — never implemented, no rollback needed. Implementation plan archived at `0033-tier-b-reflect-act-implementation-plan.md` with ABANDONED status.
- Tier C: delete `think` envelope type and loop guard if/when implemented.
- Tier A.5 (workspace guidance restoration): revert the `planner-prompt.js` change that moved workspace decision guidance back into compact mode; restore original `!compactSystemPrompt` gating; reset `action-registry.js` action order if reordered.
- Tier A.6 (allowed-action observation): revert the `action-loop-session-loop.js` hard_veto observation message to the original forbid-list-only form; remove the `allowedActions[0]` synthesis.
- Tier A.7 (500-char marker fix): revert `planner-prompt.js:283,286` to original `serializePromptValue(value, 500)`; remove any workspace tool description text added about content-length neutrality.
- Alternative 5 (scenario-target reduction): never implemented, no rollback.
