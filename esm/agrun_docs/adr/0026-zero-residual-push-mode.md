# ADR-0026 — Zero residual push-mode (delete fail-safe pushes)

- **Status:** Accepted (2026-05-08)
- **Owner:** AGRUN-233
- **Related:** ADR-0023 (harness-as-tool-provider-only), ADR-0024 (AI-first scaffolding), ADR-0025 (terminal source labels)
- **Audit predecessor:** `agrun_docs/audits/non-ai-first-2026-05-07.md` V14 (ADR-0023 left two sites as fail-safes; ADR-0026 closes them)

## Context

ADR-0023 deleted 8 push-mode sites but explicitly preserved two as "fail-safes":

1. **`maybeEnforceConsecutiveFailureGuard`** — after 2 consecutive failures of the same action (e.g. broken `web_search` endpoint), runtime force-finalizes with a hardcoded "couldn't complete" instruction.
2. **`maybeApplySingleToolFastPath`** — after the first successful `execute_skill_tool`, runtime skips the next planner cycle and finalizes directly with a hardcoded "synthesize tool result" instruction.

Both still authored runtime instructions and both still emitted `finalAnswerSource = "runtime_finalize"`. ADR-0025 made them grep-able but did not delete them.

The 2026-05-08 invariant grep against ADR-0023 acceptance criteria showed:
- `single-tool-fast-path` step still fires in `approval-finalize.test.js` `missingMarkdown` and `emptyRetry` cases (verified by step assertions).
- `action-consecutive-failure-guard` step still fires in `web-search-smoke.mjs` against an invalid endpoint.

In other words: **ADR-0023's invariant of "0 push-mode" is not actually 0 — it is 2.** This contradicts the project rule:

> agrun.js is a general harness agent runtime javascript library for all kind frontend system. We must build the real AI-first architecture, follow by harness engineering principle, remove the non AI-first logic if needed.

The fail-safes were defensible at ADR-0023 time because we were de-risking a large deletion. With that PR landed, they are now the only push-mode residue. Time to close them.

## Decision

Delete both runtime force-finalize sites. Replace with read-only signals so the AI sees the same information and decides itself. If the AI ignores the signal and keeps retrying / not finalizing, the run hits `maxSteps` and surfaces `MAX_STEPS_EXCEEDED` to the host. That is the AI-first contract: the runtime offers signals + tools, never decides for the AI.

### Site A — `maybeEnforceConsecutiveFailureGuard`: delete + signal

**Before**: After 2 consecutive same-action failures, runtime calls `executeRuntimeFinalize` with `decision = { type: "finalize", instruction: "The X action has failed N times consecutively. Answer using whatever information is available..." }`. AI never sees the choice.

**After**:
- Function deleted from `action-loop-session-terminals.js`.
- Call site in `action-loop-session-loop.js:364` deleted.
- Replace with read-only signal: `runState.actionFailureSignal = { actionName, consecutiveCount, threshold: 2 }` whenever `countConsecutiveActionFailures` ≥ 2. Threaded into `loopState.actionFailureSignal` for the next planner prompt.
- Planner prompt gets one new line: "If `loopState.actionFailureSignal` shows the same action has failed N times consecutively, that endpoint or tool may be down. Consider switching tactics (different action, different query, or finalize with what you have) — do not retry the same exact call indefinitely."
- AI is responsible for choosing: switch action / finalize / keep retrying. If retry, `maxSteps` terminates eventually.

### Site B — `maybeApplySingleToolFastPath`: delete

**Before**: After the first successful `execute_skill_tool` whose `resultKind` is terminal-shaped (final / fast-path eligible), runtime skips the next planner cycle and calls `executeRuntimeFinalize` with hardcoded "synthesize tool result" instruction.

**After**:
- Function deleted from `action-loop-session-terminals.js`.
- Call site in `action-loop-session-loop.js:507` deleted.
- AI plans cycle 2 normally — sees the tool result via observation, decides to call `finalize` (yields `planner_finalize`) or take another action.
- Cost: +1 LLM round-trip per successful single-tool run. Acceptable per ADR-0023's "AI-first cost" framing.

`runtimeConfig.singleToolFastPath` config option is deleted (no longer meaningful).

### Surfaces preserved

- `countConsecutiveActionFailures` utility stays exported. Hosts who want the legacy behavior wire it via `onToolResult` or compose their own logic outside the runtime loop.
- `MAX_CONSECUTIVE_ACTION_FAILURES = 2` constant is renamed `CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD = 2` and exported.
- `direct-final` fast-path (when AI's tool returns valid `markdown` + `resultKind: "final"`) is **kept** — it is not push-mode because the AI's tool deliberately requested it via the structured envelope. Runtime is just unwrapping a tool result the AI already shaped as final.
- `requestFinalizerProviderResponse` empty-response retry is **kept** — bounded one-shot retry to avoid an empty stream from a flaky provider; not a finalize decision, just a transport-layer retry on identical intent.

## Alternatives rejected

1. **Add `onConsecutiveFailure` + `onSingleToolReady` host hooks** — Adds two new public-API surfaces. Complicates the runtime contract. Hosts who need this can already wire `onToolResult` and inspect `actionHistory`. Rejected.
2. **Default `singleToolFastPath: false`** — Still leaves the code path. Residual push-mode by definition. Rejected.
3. **Keep the consecutive-failure guard but raise threshold to 5** — Same problem, different number. Still a runtime decision. Rejected.

## Acceptance criteria

| # | Acceptance signal | Verification source |
|---|---|---|
| A1 | `git grep -n "maybeEnforceConsecutiveFailureGuard\|maybeApplySingleToolFastPath" src/` returns 0 hits | grep |
| A2 | `git grep -n "single-tool-fast-path\|action-consecutive-failure-guard" src/` returns 0 hits (step types deleted) | grep |
| A3 | `runState.actionFailureSignal` populated when consecutive count ≥ 2 (read-only) | unit test |
| A4 | `loopState.actionFailureSignal` surfaced to planner prompt | planner-prompt unit test |
| A5 | `npm run check` exits 0 | terminal |
| A6 | `npm run build` exits 0 | terminal |
| A7 | `approval-finalize.test.js` `missingMarkdown` case now reports `finalAnswerSource = "planner_finalize"` (AI-driven cycle 2 finalize) instead of `runtime_finalize` | test |
| A8 | `approval-finalize.test.js` `emptyRetry` case shows finalizer-empty-retry firing during AI's `planner_finalize` path (not runtime push) | test |
| A9 | `web-search-smoke.mjs` invalid-endpoint case terminates via AI-driven path (planner_finalize OR MAX_STEPS_EXCEEDED), not via guard force-finalize | test |
| A10 | Live e2e: same Mandarin 3000-word prompt run shows 0 `single-tool-fast-path` and 0 `action-consecutive-failure-guard` step events; runtime_finalize source is absent (or only present in genuine `summarize_limits` / direct-final paths) | live-test md |

A1–A6 are gated on this PR. A7–A9 are test-level. A10 is the post-PR live verification (reuses ADR-0024 baseline).

## Risks

- **AI ignores `actionFailureSignal` and burns through `maxSteps` retrying a broken endpoint.** Acceptable per ADR-0023 framing — host can clamp `maxSteps` lower or wire a custom hook. The runtime no longer takes the decision away from the AI.
- **Per-run latency increase for single-tool flows.** Was ~2 LLM calls (planner + finalizer); now ~3 (planner + planner-finalize + finalizer). 33–50% latency cost on the single-tool happy path. Worth it for AI-first purity per the project rule.
- **Tests previously asserting push-mode behavior must be rewritten.** Already done in this PR (approval-finalize, web-search-smoke).
- **`onBeforeFinalize` host hook is now the only path for hosts that want runtime-side veto / push-mode.** Already documented in ADR-0023 migration notes; same pattern applies here.

## Cadence

Single PR. Touches `src/runtime/action-loop-session-terminals.js` (delete 2 functions), `src/runtime/action-loop-session-loop.js` (remove 2 call sites + add signal write), `src/runtime/planner-prompt.js` (one new directive line + thread `actionFailureSignal` into loopState), `src/runtime/action-loop-session-decision-utils.js` (rename constant), `src/runtime/run-state.js` (init `actionFailureSignal`), 3 test files, this ADR, `task.md`, `agrun_docs/audits/non-ai-first-2026-05-07.md`, `agrun_docs/error-handling-and-recovery.md`. Acceptance gate: A1–A9 (test-level) — A10 (live e2e) tracked as follow-up but not blocking the PR since ADR-0024 already verified the no-push state for the research path.

## Migration notes for hosts

Hosts upgrading from pre-ADR-0026:

1. If you depended on the consecutive-failure guard force-finalizing your run on broken endpoints: read `runState.actionFailureSignal` after each cycle and use `onToolResult` or `onPlannerDecision` to inject your own veto / finalize. The `countConsecutiveActionFailures` utility is still exported.
2. If you depended on `runtimeConfig.singleToolFastPath` (default `true` previously): the option is removed. The runtime now always lets the AI plan cycle 2. Latency cost is one extra LLM call per single-tool run. To preserve old behavior, wire `onToolResult` to call your own finalize path when the tool result is terminal-shaped.
3. Update step-event filters: `action-consecutive-failure-guard` and `single-tool-fast-path` step types no longer fire. New `action-failure-signal` step fires when consecutive count ≥ 2.

## Open questions

- The remaining "borderline push" surface is `requestFinalizerProviderResponse` empty-response retry (one-shot). Currently kept because it is provider-level transport retry, not a content decision. Re-evaluate in ADR-0027+ if invariant grep shows it firing in healthy runs.
- ADR-0024 scaffolding only covers the research class. Non-research substantial-output requests (code reviews, multi-step plans, comparison tables) still rely on AI's own initiative. Track as separate work — orthogonal to ADR-0026.
