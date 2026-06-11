# Live Test v16 — gemini-3.1-flash-lite + ADR-0033 Tier A (Compact Envelope Auto-Detect)

Date: 2026-05-20
Test: `test/node-agrun-3000-live.mjs` (3000-word research scenario)
Model: `gemini-3.1-flash-lite` (provider: gemini)
Planner mode: `envelope`
maxSteps: 90
Change under test: ADR-0033 Tier A — `isLiteTierModel()` heuristic in `provider-capabilities.js` + `selectPlannerSystemPromptProfile()` lite-tier override in `planner.js:537`. When lite-tier detected, `compactSystemPrompt: true` regardless of state (active skill / todo / workspace).

## Acceptance criteria (from ADR-0033)

- All 3 runs: `candidateWords > 1000` (vs baseline 437)
- At least 2/3: `candidateWords > 1500`
- `terminalRepairState.ignoredCount` median < 10 (vs baseline 21)
- No new invalid-envelope warnings vs. baseline

## Result: **FAILED**

| Run | candidateWords | runStatus | terminalizedBy | ignoredCount | successfulReadUrl | structureOk | duration |
|---|---|---|---|---|---|---|---|
| 1 | **410** | failed | (none) | 70 | 3 | true | 194s |
| 2 | **768** | failed | (none) | 57 | 1 | false | 220s |
| 3 | **566** | completed | max_steps_continuation | 71 | 1 | false | ~205s |
| **median** | **566** | — | — | **70** | — | — | — |
| **mean** | **581** | — | — | — | — | — | — |

Baseline (pre-Tier A): 437 words, ignored=21.

**None of the 3 runs cleared the 1000-word target. Median 566 < 1000.** Tier A is insufficient.

## Honest analysis

### What Tier A did NOT fix
1. **Per-step output ceiling.** Each `workspace_append`/`workspace_write` step adds ~6-15 words on flash-lite. With ~70 productive cycles available, the maximum reachable length is ~500-800 words regardless of prompt schema. Schema reduction cannot raise per-call token output of the model.
2. **Terminal-repair compliance.** ignoredCount went UP (70/57/71) vs baseline (21). The lite model continues to ignore repair guidance — the compact prompt did not make the guidance more salient.
3. **Source minimum.** Runs 2 and 3 only achieved 1 successful read_url (target 3). Flash-lite gets stuck on web_search loops instead of progressing to read_url + workspace draft.
4. **Structure quality.** Runs 2 and 3 produced duplicate headings/section numbers (`3 concrete patterns x2`, `4 anti-patterns x2`, ...). Compact prompt drops the workspace_write guidance block that warns against this; the lite model regressed.

### What we learned about the failure mode

Action distribution across runs:
- Run 1: plan(1), web_search(2), workspace_write(3), workspace_append(2), workspace_finalize_candidate(1), workspace_read(1), workspace_publish_candidate(3), finalize(4)
- Run 2: plan(1), web_search(13), read_url(1), workspace_write(7), workspace_append(3), workspace_replace(1), finalize(10)
- Run 3: plan(2), todo_plan(1), web_search(7), read_url(1), workspace_write(1), workspace_append(1), workspace_replace(1), finalize(6)

The runs spend their budget very differently: Run 1 stayed on workspace, Run 2 hammered web_search 13 times, Run 3 over-planned. **Variance is the dominant signal** — the schema isn't reliably driving any one strategy. Flash-lite cycles between strategies without convergence.

### What this tells us about Tier B

The mean improved from 437 → 581 (+33%), but the variance and structural deficits dwarf the gain. Tier B (Reflect→Act split: `{type:"reflect", next_intent, reasoning}` → `{type:"action", args}`) has a stronger theoretical argument here because:
1. The first call has 4 fields only — flash-lite can pick a coherent intent
2. The second call has a known intent context — args become deterministic
3. AI controls `next_intent`; runtime never prescribes (AI-first preserved)

But Tier B will not fix the per-step word output ceiling — that's a model capability fact. Tier B may still leave median <1500.

The deeper architectural question (not part of Tier A): **should the 3000-word scenario actually run on flash-lite at all?** A 3000-word research report requires sustained writing across many steps. Models with higher per-step capacity (gpt-5-mini, gemini-3-pro-preview) pass the same scenario in 15-20 cycles. For lite models, a different target length (e.g. 1000 words) or a different write strategy (single large workspace_write instead of incremental append) may be the right answer.

## Code state at test time

- `src/runtime/provider-capabilities.js` — `isLiteTierModel` exported, `LITE_TIER_MARKERS = ["flash-lite","flash","mini","haiku","nano"]`, word-boundary regex
- `src/runtime/planner.js:537` — `selectPlannerSystemPromptProfile()` returns `{ compact: true, reason: "lite_tier_model_compact" }` for `gemini-3.1-flash-lite`
- `dist/agrun.js` — built with Tier A wiring

Verification path: `node test/unit/lite-tier-compact-policy.test.js` (passes — `gemini-3.1-flash-lite` → `reason: "lite_tier_model_compact"`).

## Status update

- ADR-0033 Tier A status: **IMPLEMENTED but FAILED validation 2026-05-20**
- The code stays shipped (it does no harm; mean improvement +33% on flash-lite, zero impact on capable models per smoke test EXIT=0)
- ADR-0033 Tier B (`plannerMode: "split_envelope"` Reflect→Act) is now the next candidate
- Before Tier B: investigate whether the test scenario itself should be adjusted for lite-tier targets (separate concern)

## Artifacts

- `agrun_docs/live-tests/tier-a-2026-05-20/run1-flash-lite-tier-a.{jsonl,md}` + `run1-stdout.log`
- `agrun_docs/live-tests/tier-a-2026-05-20/run2-flash-lite-tier-a.{jsonl,md}` + `run2-stdout.log`
- `agrun_docs/live-tests/tier-a-2026-05-20/run3-flash-lite-tier-a.{jsonl,md}` + `run3-stdout.log`
