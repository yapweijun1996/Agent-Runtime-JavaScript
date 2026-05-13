# ADR-0025 — Terminal source labels distinguish AI-driven from runtime-forced

- **Status:** Accepted (2026-05-08)
- **Owner:** AGRUN-232
- **Related:** ADR-0023 (harness is tool provider only), ADR-0024 (AI-first scaffolding)
- **Live-test predecessor:** [`agrun_docs/live-tests/ai-first-scaffolding-2026-05-08.md`](../live-tests/ai-first-scaffolding-2026-05-08.md)

## Context

After ADR-0023 + ADR-0024, both live e2e runs reported `finalAnswerSource: "runtime_finalize"` even when the AI explicitly chose `finalize` decision (AI-driven). The label is misleading: "runtime_finalize" implies runtime forced the finalize, but in both runs the AI initiated it. The same label is also used by the legitimate runtime push paths (`maybeEnforceConsecutiveFailureGuard`, `maybeApplySingleToolFastPath`).

This conflation makes telemetry useless for distinguishing AI-first runs from runtime-pushed runs. Acceptance criteria like "0 runtime_finalize" cannot be checked directly because they hit AI-initiated finalize paths too.

## Decision

Thread an explicit `terminalSource` option through `executeRuntimeFinalize` so each caller declares whether the finalize is AI-driven or runtime-forced. The label is then surfaced via both `finalAnswerSource` and `terminalizedBy` (with the existing `summarize_limits` overlay for `terminalizedBy` only).

### Label surface (post-ADR-0025)

| Label | Set by | Meaning |
|---|---|---|
| `planner_final` | `handlePlannerFinal` | AI emitted `type:"final"` with answer text directly. No second LLM call. |
| `planner_finalize` | `handleRuntimeFinalize` with `terminalSource="planner_finalize"` | AI emitted `type:"finalize"` decision; runtime called LLM second time to compose answer. AI-driven. |
| `plan_synthesize` | `handlePlanSynthesize` | AI emitted `type:"plan"` with `synthesize_per_action: true`; sections were synthesized. |
| `runtime_finalize` | `handleRuntimeFinalize` with default `terminalSource="runtime_finalize"` | Runtime forced finalize via `maybeEnforceConsecutiveFailureGuard` or `maybeApplySingleToolFastPath`. Push-mode (allowed only as bounded fail-safe per ADR-0023). |
| `direct_final` | `handleDirectFinal` | `execute_skill_tool` returned ready directFinal artifact. |
| `policy` | `handlePolicyBlock` | Approval-required terminal. |
| `continuation_required` | `action-loop-continuation.js` | Max-steps continuation marker. |
| `summarize_limits` | `terminalizedBy` overlay only | Context overflow occurred during finalize; overrides whatever else `terminalizedBy` would have been. `finalAnswerSource` stays accurate (AI-driven vs runtime-forced). |

## Implementation

1. **`src/runtime/runtime-finalize.js`** — `executeRuntimeFinalize` reads `options.terminalSource` (default `"runtime_finalize"`) and forwards to `handleRuntimeFinalize` via `options`.

2. **`src/runtime/action-loop-terminal.js`** — `handleRuntimeFinalize` reads `options.terminalSource`, defaults to `"runtime_finalize"`, sets:
   - `runState.finalAnswerSource = terminalSource`
   - `runState.terminalizedBy = usedSummarizeLimits ? "summarize_limits" : terminalSource`

3. **Caller updates** — pass `terminalSource: "planner_finalize"` from:
   - `handlePlannerFinalizeDecision` (AI emitted finalize decision)
   - `executePlan` after plan completes successfully (AI emitted plan with synthesize → finalize, AI-driven)

   Keep default `runtime_finalize` for:
   - `maybeEnforceConsecutiveFailureGuard`
   - `maybeApplySingleToolFastPath`

4. **`src/runtime/result.js`** `normalizeTerminalMetadata` — extend to recognize `planner_finalize` as a separate source (does not normalize to `runtime_finalize`).

## Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| A1 | `executeRuntimeFinalize` accepts `terminalSource` option | grep src/ |
| A2 | `handlePlannerFinalizeDecision` passes `terminalSource: "planner_finalize"` | grep src/ |
| A3 | `executePlan` plan-finalize path passes `terminalSource: "planner_finalize"` | grep src/ |
| A4 | `maybeEnforceConsecutiveFailureGuard` keeps default `runtime_finalize` | grep src/ |
| A5 | `maybeApplySingleToolFastPath` keeps default `runtime_finalize` | grep src/ |
| A6 | `npm run check` no new failures | terminal |
| A7 | `npm run build` exits 0 | terminal |
| A8 | Live re-run of ADR-0024 prompt: `finalAnswerSource: "planner_finalize"` (NOT `runtime_finalize`) | live-test md or telemetry |

## Why split the label

Telemetry that conflates AI-initiated vs runtime-forced finalize cannot answer the basic question "did the runtime push?" — which is the whole point of ADR-0023. After ADR-0025, the answer is grep-able: `finalAnswerSource === "runtime_finalize"` means push-mode fired (consecutive-failure guard or single-tool-fast-path); `finalAnswerSource === "planner_finalize"` means AI chose to finalize via the second-LLM-call path. Both are valid, but they're now distinguishable.

## Alternatives rejected

1. **Keep one label `runtime_finalize` and add a separate `runtime_initiated_finalize: bool` flag** — Rejected: more state, more places to forget to set, plus the existing label name implies push-mode which is misleading.
2. **Rename `runtime_finalize` to `finalizer_call` to remove the push-mode connotation** — Rejected: breaks existing consumers more than splitting; `runtime_finalize` semantics are still meaningful for the actual runtime push paths.
3. **Use the already-existing `runState.usedRuntimeFinalize` boolean as the AI-vs-push distinguisher** — Rejected: that field tracks WHETHER the finalizer code path ran, not WHO initiated it. Different question.

## Risks

- **Existing tests asserting on `finalAnswerSource === "runtime_finalize"`** for AI-driven planner_finalize paths will need to be updated to check for `"planner_finalize"`. Mitigated by running the test suite after the change; one-time mechanical fix.
- **Browser inspector display** shows the source label as-is. New labels (`planner_finalize`) just appear; no UI changes needed.

## Cadence

Single PR. Pure label refactor + targeted test updates.
