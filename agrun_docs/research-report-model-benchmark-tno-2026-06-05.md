# TNO / Globe3 ERP Model Benchmark - 2026-06-05

## Goal

Compare GPT, DeepSeek, and Gemini for a management-ready English research report about TNO Systems Pte Ltd and Globe3 ERP.

The live benchmark used Node.js, `dist/agrun.js`, real API keys from `.env.local`, `web_search`, `read_url`, virtual workspace writing, and SSE-like progress JSONL files.

## Scope

- Completed runs: 14.
- User-stopped live run with evidence: `gemini-3.5-flash-medium`.
- Not run after stop instruction: `gemini-3.5-flash-high`.
- Output folder: `test/benchmark-out-tno/`.
- Management HTML: `test/benchmark-out-tno/management-benchmark-report-en.html`.
- Browser/email copy: `test/benchmark-out4/management-benchmark-report-en.html`.

## Executive Result

GPT produced the best quality and cleanest production behavior, but management's cost concern is valid. If GPT is rejected for default production, the best cost-constrained direction is a DeepSeek pilot with strict source verification.

DeepSeek should not be used as an unchecked final-answer engine. The completed DeepSeek run was cheap and useful, but manual review found factual-risk signals such as unsupported/user-context information and malformed source details. It is suitable as a draft engine only when a human verifies important claims.

Gemini is not automatically safer as the current baseline. In this harness, multiple Gemini runs completed only after heavy terminal publish repair loops, high token burn, and limited publish behavior.

## Key Runs

| Model config | Status | Time | Cost | Usage tokens | Words | Production view |
|---|---:|---:|---:|---:|---:|---|
| OpenAI `gpt-5.4-mini` high | completed | 9.62 min | $0.52621 | 438,407 | 3,163 | Best quality and cleanest run; expensive relative to DeepSeek but cheaper than unhealthy Gemini 3.5 low. |
| DeepSeek `deepseek-v4-flash` high | completed | 31.15 min | $0.16798 | 1,500,165 | 2,998 | Best DeepSeek result; recommended pilot with mandatory human/source fact-checking. |
| Gemini `gemini-3.1-flash-lite` medium | completed | 3.32 min | $0.26806 | 1,337,962 | 3,058 | Fast, but manual review found repetition, weak structure, and limited source depth. |
| Gemini `gemini-3.1-flash-lite` high | completed | 36.10 min | $1.16953 | 6,380,764 | 3,174 | Completed via limited publish after heavy publish/repair loop; not production healthy. |
| Gemini `gemini-3.5-flash` low | completed | 41.18 min | $6.77392 | 4,159,258 | 3,114 | Highest-cost completed run; repeated publish-gated invalid actions; reject for this workload. |
| Gemini `gemini-3.5-flash` medium | user-stopped | 12.09 min | $2.22460 | 1,503,506 | 0 | Stopped after overlong draft repair churn: 31 workspace reads, 29 workspace replacements, no publish, no report. |
| OpenAI `gpt-5.4-mini` low | completed | 46.86 min | $3.52587 | 4,510,433 | 3,395 | Technically completed but exceeded target and looped around publish repair; bad setting. |

## DeepSeek Result

Only `deepseek-v4-flash` high completed. DeepSeek flash low/medium and all DeepSeek pro levels were killed by timeout with no report.

This means the production pilot should not blindly use every DeepSeek setting. The current evidence supports only `deepseek-v4-flash` high as a cost-constrained draft option.

## Gemini Result

Gemini has serious harness-fit risk in this workload.

- `gemini-3.1-flash-lite` low: 305 calls, 6.90M tokens, repeated invalid-action and publish repair.
- `gemini-3.1-flash-lite` high: 282 calls, 6.38M tokens, 48 publish-path-required events, 33 publish-gated events, 45 invalid-action events.
- `gemini-3.5-flash` low: 246 calls, 4.16M tokens, 120 publish-gated events, 127 invalid-action events, and several 40-80 second provider responses.
- `gemini-3.5-flash` medium: stopped after 12.09 minutes, 80 provider calls, 1.50M tokens, 1 web search, 4 read_url calls, 31 workspace reads, 29 workspace replacements, no publish, and no report.

Completion alone should not be counted as success. These runs were costly and unstable at the terminal publish stage.

## What The Agent Was Doing

The agents were not simply researching for a long time. The workflow was:

1. Search public sources.
2. Read URLs.
3. Write the long report in the virtual workspace.
4. Finalize and review the candidate.
5. Publish through `workspace_publish_candidate`.

The slowest runs were stuck mostly in steps 4-5. They repeatedly hit missing publish path, gated publish candidate, invalid action, and planner repair events.

## Harness Engineering Findings

1. Add redacted payload/response snapshots.
   - Current progress logs show provider timing, usage, action names, and repair events.
   - They do not show the exact model response body that caused the invalid action.

2. Add deterministic publish repair.
   - Repeated `workspace-publish-path-required` should not consume dozens of model calls.
   - If only mechanical runtime-owned publish fields are missing, the runtime should supply them or fail fast.

3. Add publish-loop stuck detection.
   - Repeated `workspace_publish_candidate`, `workspace-publish-candidate-gated`, `workspace-publish-path-required`, and planner repair should trigger deterministic fallback.

4. Add runtime hard timeout.
   - The benchmark child timeout wrote null usage/cost for killed runs.
   - Progress heartbeat proved tokens were spent before kill.
   - Runtime should return a structured timeout/fail result at the configured time limit.

## Recommendation

Use GPT when the output must be trusted and management accepts the cost.

If management rejects GPT because of cost, use DeepSeek `deepseek-v4-flash` high as a controlled pilot with human fact-checking, source verification, and a clear rule that important factual claims cannot be published unchecked.

Do not keep Gemini as the default for this long-report workflow unless the harness publish/repair loop is fixed and the output quality is revalidated.

## Harness Fixes Applied (2026-06-06)

Observability fixes for findings #1 (payload/response snapshot) and #4 (runtime hard timeout). Finding #3 (publish-loop stuck detection) and #2 (deterministic publish repair) remain open as AGRUN-307.

1. Invalid-action diagnostic snapshot — finding #1.
   - `src/runtime/action-loop-failure.js`: the `planner-invalid-action` step now carries `invalidKind` (why), `rejectedActionName` (which action), `repairAttempted`, and a bounded `responsePreview` (the offending body). Previously it carried only a counter, so a reviewer could not tell an unknown-action loop from a malformed-JSON loop.
   - `src/runtime/action-loop-session-loop.js`: the `!resolvedAction` branch (a structurally valid decision naming an action not on the current surface — the dominant Gemini churn, e.g. `workspace_replace`/`workspace_write` off-surface) now tags the diagnostic with `invalidKind: "unknown_action_name"` and the real `rejectedActionName`. Without this the raw planner result carried no offending name and the step reported `null`.
   - Tests: `test/unit/planner-invalid-action-diagnostic.test.js` — unit cases for the helper plus an integration case that drives the real runtime to the unknown-action branch and asserts the enriched step. Verified by code path + integration test (no live Gemini run).

2. Killed-run usage/cost salvage — finding #4 (backstop).
   - `test/helpers/bench-metrics.mjs` (new, SSOT for price table + `computeCost` + `salvageMetricsFromProgress`). `test/bench-tno-batch.mjs` `writeKilledMetrics` now reconstructs the last `provider_usage`/`heartbeat` from the progress JSONL instead of writing null. `test/bench-one.mjs` imports the shared cost helpers.
   - Test: `test/unit/bench-metrics-salvage.test.mjs`.

3. Runtime whole-run deadline — finding #4 (primary).
   - New opt-in `runtimeConfig.runDeadlineMs` (`src/runtime/config.js`). `src/runtime/action-loop-session-loop.js` checks elapsed at each cycle boundary (after ≥1 cycle) and returns a structured `RUN_DEADLINE_EXCEEDED` result carrying the cost ledger, instead of relying on a host SIGKILL that loses in-memory usage/cost. `test/bench-one.mjs` sets `runDeadlineMs` so a long run self-terminates before the batch SIGKILL. A single overrunning provider call is still the SIGKILL+salvage path — a loop-boundary check cannot interrupt an in-flight request.
   - Test: `test/unit/run-deadline.test.js`.

Verification: `npm test` (full smoke suite), `npm run build`, `npm run dist:check` all pass. New logic confirmed present in `dist/agrun.js`.

## Publish-Loop Root Cause + Fix (AGRUN-307, 2026-06-06)

Finding #3 (publish-loop stuck detection). Resolves AGRUN-306's "ROOT CAUSE OPEN".

Root cause (confirmed by code path + the gpt-low progress JSONL action histogram, not by re-running — `bench-one.mjs` `onStep` is reason-blind so the trace only carries `stepType`/`actionName`): the ~30 min, $3.53 non-convergence was driven by `workspace_review_candidate` (×97). A re-review makes no observable progress and, in `terminal-repair-state.js`, was counted as **neither** a terminal attempt (`isTerminalAttempt` = publish/finalize/final) **nor** a no-progress recovery (`isNoProgressRecoveryAttempt` = preflight blocks + `workspace_propose_patch`). So `ignoredCount` never climbed, `hard_veto` never fired, and the existing `publishLoopEscapeGranted` valve never opened. The separate `action-pattern-convergence` `repeatedFingerprintCount` only climbs on consecutive-identical fingerprints, defeated by the interleaved `review→read→patch→review` pattern (it detected ×11 but did not terminalize).

Fix (two parts): `src/runtime/terminal-repair-state.js`.
1. `isNoProgressMaintenanceChurn` counts an unproductive `workspace_review_candidate` while repair is active as a no-progress attempt — unless the publish protocol is waiting for exactly that review (`getPublishProtocolRequiredActionForReason` guard). Reuses the existing escape path, not a parallel counter.
2. A **run-level cumulative counter** (`runState.terminalRepairCumulativeIgnored`, host-overridable `absoluteIgnoredCap` default 8) that **survives `clearTerminalRepairState`**. The per-state `ignoredCount` is reset by clear, so a clear↔reactivate oscillation sawtooths it below threshold forever; the cumulative counter does not reset on a transient clear (only on real terminal completion), so a genuinely stuck loop still escalates. Only no-progress cycles increment it, so healthy runs never approach it. 5 test cases (review churn → escape; cumulative cap survives clear/reactivate; interleaved churn; contract-required review not penalised; healthy converging run not force-published).

Live verification (cost-capped gpt-5.4-mini-low, ~$0.5, 6-min `runDeadlineMs` ceiling):
- v1 (part 1 only): `ignoredCount` sawtoothed 0→2→0 via clear/reactivate, never escalated → deadline-failed, **0 words**. Confirmed the clear/reactivate gap.
- v2 (+ part 2): `ignoredCount` reached 6, run **completed with a 1644-word report**.

Honest caveat: the v2 improvement is **not cleanly attributable** to the fix — v2's dominant repair reason was `candidate_quality_blocked` (×37), which is **deliberately excluded** from the publish-loop escape (AGRUN-300/301: do not force-publish a quality-broken report), and two stochastic gpt-low runs are not a controlled A/B. The fix is correct and unit-tested for the clear/reactivate gap on **non-candidate-quality** terminal/review/source loops; the **candidate-quality** loop (unread citations / duplicate sections) is a separate open item (AGRUN-300/301 continuation). `runDeadlineMs` (AGRUN-308) remains the ultimate cost backstop ($0.44–0.60/6 min vs original $3.53/46 min).
