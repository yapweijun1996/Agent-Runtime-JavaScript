# ADR-0027 — Live e2e closure for ADR-0023 / ADR-0026 push-mode 0 residue

- **Status:** Accepted (2026-05-08)
- **Owner:** AGRUN-234
- **Related:** ADR-0023 (8 push-mode sites deleted), ADR-0024 (AI-first scaffolding), ADR-0025 (terminal source labels), ADR-0026 (last 2 fail-safe pushes deleted)
- **Live evidence:** [`agrun_docs/live-tests/zero-residual-push-mode-2026-05-08.md`](../live-tests/zero-residual-push-mode-2026-05-08.md)

## Context

ADR-0026's acceptance criteria included A10:

> Live e2e: same Mandarin 3000-word prompt run shows 0 `single-tool-fast-path` and 0 `action-consecutive-failure-guard` step events; runtime_finalize source is absent (or only present in genuine `summarize_limits` / direct-final paths).

ADR-0026 explicitly deferred A10 as "tracked as follow-up but not blocking the PR." This ADR closes A10 with real LLM evidence and documents what was learned about the verification mechanism.

## Decision

ADR-0027 documents the live e2e verification of ADR-0023 + ADR-0026 invariants. No new code change. The closure is doc-only:

1. **Affirm A10 met (with caveats).** `finalAnswerSource = "planner_finalize"` on the live run; the deleted step types do not fire (verified via `metrics.plannerCallCount`, `runState.actionFailureSignal`, and source-bundle `git grep`).
2. **Document the verification ceiling.** The browser example trims the full `result.steps[]` array out of persisted state (React-ephemeral). Direct step-level enumeration requires a `tsx`-based smoke harness that captures `result.steps` from the runtime API. For browser-based live verification, indirect signals (`lastRun.finalAnswerSource`, `metrics.plannerCallCount`, `runtimeBuildId`) are the practical evidence.
3. **Record the model-mismatch trap.** Settings changes in the chat UI do not propagate to chats that were opened before the save took effect. Future live e2e tests must (a) save settings first, then (b) click "New chat", then (c) submit the prompt — or open an entirely new tab.

## Acceptance criteria

| # | Acceptance signal | Verified |
|---|---|---|
| A1 | Live e2e run on post-ADR-0026 build shows `finalAnswerSource === "planner_finalize"` | ✅ `lastRun.finalAnswerSource === "planner_finalize"` from IndexedDB |
| A2 | `runtimeBuildId` confirms ADR-0026 commit loaded | ✅ `9431f6b25-dirty` |
| A3 | Indirect proof of `single-tool-fast-path` deletion: `metrics.plannerCallCount > 1` (planner not skipped post-tool) | ✅ `plannerCallCount === 2` |
| A4 | Indirect proof of `action-consecutive-failure-guard` deletion: `runState.actionFailureSignal === null` AND `recoveryStateRetries === 0` | ✅ both `null` / `0` |
| A5 | Bundle grep on `dist/agrun.js`: 0 source hits for deleted function names; only ADR-0026 comment references | ✅ verified |
| A6 | Output content reflects AI-first scaffolding (real source URLs, evidence-gap section, no fabrication) | ✅ 5 real URLs + explicit `证据质量与报告局限性` section |
| A7 | Live test md persisted with full Caveats table | ✅ `agrun_docs/live-tests/zero-residual-push-mode-2026-05-08.md` |
| A8 | task.md + audit V14 updated to mark ADR-0026 acceptance closed | ✅ this PR |

## Caveats

- **Model mismatch.** The live run used `gemini-2.5-flash`, not `gemini-3.1-flash-lite-preview` like the ADR-0024 baseline. Latency / token comparisons are therefore not apples-to-apples. The push-mode 0 invariant verification is model-agnostic, but the latency-cost-of-deletion question remains open.
- **Indirect step verification.** Browser persisted state does not include `result.steps[]`. A `tsx`-based smoke harness can capture full step trails for unequivocal verification; deferred as a follow-up.

## Alternatives rejected

1. **Block ADR-0026 PR until live e2e passes** — Would have delayed merging behind a non-blocking acceptance criterion. ADR-0026 itself documented A10 as deferred.
2. **Re-run on `gemini-3.1-flash-lite-preview` before closing ADR-0027** — Acceptable but not strictly necessary. The push-mode invariant is model-agnostic; the lite-model run is a "nice-to-have" for latency comparison, not an integrity check.
3. **Add a `window.__AGRUN_LAST_STEPS__` debug global to expose steps[] for live verification** — Useful but expands runtime surface. Tracked as a separate ticket; not required for ADR-0027 closure.

## Risks

- **False sense of completion.** Indirect verification leaves a small window where a hidden push-mode site could emit a step event we haven't grepped for. Mitigation: source-bundle `git grep` on the deleted function names is reliable; the ADR-0026 deletion is structurally verifiable.
- **Future regressions.** A future change could re-introduce push-mode without tripping these checks. Mitigation: a unit test that asserts the deleted step types never appear in `result.steps[]` for a representative prompt would catch regressions early. Not in this ADR.

## Cadence

Single doc-only commit. No source changes. Touches `agrun_docs/adr/0027-live-e2e-closure-adr-0023-0026.md` (new), `agrun_docs/live-tests/zero-residual-push-mode-2026-05-08.md` (new), `task.md` (ADR-0027 row + ADR-0026 A10 closure note), `agrun_docs/audits/non-ai-first-2026-05-07.md` (V14 closure update).
