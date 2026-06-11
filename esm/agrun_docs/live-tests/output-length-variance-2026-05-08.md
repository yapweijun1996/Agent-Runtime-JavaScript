# Output length variance 1691–4764 chars — characterisation 2026-05-08

## Observation

Across three live e2e runs on `gemini-3.1-flash-lite-preview` (lite-tier baseline matching ADR-0024) with the same Mandarin 3000-word research prompt, the final answer length varied:

| Run | Date | Cycles | Output chars | Notes |
|---|---|---|---|---|
| First (ADR-0023+0026 verification) | 2026-05-08 morning | 2 | 4764 | full report with explicit limitations section |
| Second (re-run for ADR-0027 closure) | 2026-05-08 afternoon | 2 | 2612 | shorter report; same scaffolding sections present |
| Third (ADR-0027 closure) | 2026-05-08 evening | 4 | 1691 | runtime auto-read fired (`autoReadAttemptCount: 2`, `usedSummarizeLimits: true`); output truncated by deleted `buildSummarizeLimitsInstruction` overlay |

## Diagnosis

Two distinct factors:

1. **Runs 1 and 2 (4764 vs 2612)** — pure AI-output variance. Lite-tier models are non-deterministic at the same prompt + seed: the AI emitted a longer / more detailed report on run 1 and a more compact one on run 2. Both reports contain the ADR-0024-mandated scaffolding (核心结论 / 证据要点 / 对比分析 / 局限性 / 建议). This is the expected side effect of giving the AI total control over finalize prose — variance is the *signal* that runtime is no longer regularising output.

2. **Run 3 (1691)** — caused by a now-deleted runtime push site (`resolveResearchContinuation`). After read attempts hit the cap (2), runtime auto-finalized with the `summarize_limits` overlay, which injected `buildSummarizeLimitsInstruction`'s prose into the finalize prompt. AI received the instruction "Summarize the best publicly available evidence gathered so far. State clearly when the available public evidence is limited or indirect" and produced a shorter, evidence-gap-focused answer. The 1691-char ceiling was an artefact of runtime-authored prose, not AI choice.

## Resolution status

- **Run 3 cause** is gone post-ADR-0028: `resolveResearchContinuation` deleted, `summarize_limits` overlay removed, AI now controls all finalize prose. After the next live e2e, expect the lite-tier output to settle into a wider range determined by AI variance alone.
- **Runs 1 & 2 variance** is expected and not a regression. Hosts that need length-stable outputs should provide their own scaffolding via `runtimeConfig.systemPrompt` or `plannerDirectives`, not rely on runtime trimming.

## Verification plan

After ADR-0028 lands, re-run the same Mandarin prompt 3 times on lite-tier and record output length. Acceptance:

- All 3 runs use 2 cycles (no auto-read cap firing).
- All 3 runs surface `terminalizedBy === "planner_finalize"` and `usedSummarizeLimits === undefined`.
- Output range likely 2500–5000 chars; no run truncated below 2000.

## Reflection

Am I trying to hardcode this instead of using harness engineering? — No. The runtime correctly defers to AI on output length; the bug was a leftover push site (run 3 evidence). Doc characterises behaviour, not policy.
