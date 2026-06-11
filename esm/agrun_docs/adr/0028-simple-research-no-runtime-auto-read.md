# ADR-0028 — Simple research belongs to AI (delete `resolveResearchContinuation`)

- **Status:** RESOLVED 2026-05-08 (AGRUN-235 ships test cascade + source-side delete in one PR)
- **Owner:** AGRUN-235
- **Supersedes:** ADR-0016 (was deferred 2026-05-07 due to identical test mock cascade)

> **Resolution 2026-05-08:** Source-side delete + test cascade both shipped in this PR.
> - `src/runtime/research-continuation.js` deleted (332 lines)
> - `test/unit/research-continuation.test.js` deleted
> - `src/runtime/action-loop-session-cycle.js` — removed `resolveResearchContinuation` import + call site; added `summarizeReadAttemptSignal` helper that populates `runState.readAttemptSignal` from `researchContext.readSources.length`. Continuity-related orient detail fields converted to `readAttemptSignal`.
> - `src/runtime/action-loop-session-loop.js` — removed `readContinuityDecision` import + `continuityDecision` preemption branch.
> - `src/runtime/action-loop-session-decision-utils.js` — removed `readContinuityDecision` (kept `isDecisionActionAvailable`).
> - `src/runtime/state.js` — dropped `usedSummarizeLimits`, `autoReadAttemptCount`, `autoReadStoppedReason`, `continuityResolution` fields. Added `readAttemptSignal`.
> - `src/runtime/planner-prompt.js` — added new directive line + `sanitizeReadAttemptSignalForPrompt` helper + `loopState.readAttemptSignal` field.
> - `src/runtime/action-loop-planner.js` — threaded `runState.readAttemptSignal` into `buildPlannerPrompt`.
> - `src/runtime/result.js` + `src/runtime/action-loop-terminal.js` — dropped the `summarize_limits` overlay (terminalizedBy now reflects the literal source label).
> - `src/runtime/todo-autopilot.js` — `readEvidenceExhaustedReason` now reads from `readAttemptSignal` (attemptCount >= threshold infers exhaustion). Returns the legacy `"auto_read_limit_reached"` string for telemetry continuity.
> - Test cascade rewrite (5 files):
>   - `test/concerns/approval-resume.test.js` — assertion on `continuity-resolved` step replaced with `pendingApproval.resumeToken.decision.args.url` check; `terminalizedBy` flipped to `planner_finalize`; `usedSummarizeLimits` removed.
>   - `test/concerns/research-flows.test.js` — 4 `usedSummarizeLimits` assertions removed; 2 `terminalizedBy === "summarize_limits"|"runtime_finalize"` flipped to `planner_finalize`; natural-language-search cycle count updated 3 → 2 (no auto-read between web_search and finalize).
>   - `test/concerns/session-topic-guardrails.test.js` — single `usedSummarizeLimits === true` assertion converted to `=== undefined`; `terminalizedBy` flipped to `planner_finalize`.
>   - `test/unit/todo-autopilot.test.js` — 3 instances of `autoReadStoppedReason` setup converted to `readAttemptSignal: { attemptCount, threshold }` shape; assertions on veto note format unchanged (legacy reason string preserved).
>   - `test/concerns/push-mode-invariants.test.js` — added `auto_read_limit_reached` + `continuity-resolved` to `DELETED_STEP_TYPES` array.
> - `test/helpers/mocked-fetch.js` — dense-search GoPro mock cascade rewritten: detection via `readSources` JSON parsing, per-cycle envelope (cycle 1 web_search → cycle 2 read_url investor → cycle 3 read_url retail → cycle 4 finalize). Same pattern applied to Mandarin variant. TNO-boss mock detection tightened (`deniedActions` regex match instead of substring). Finalizer-prompt assertions on `available public evidence is limited` and `If a page could not be read directly, say that clearly` removed (those strings came from deleted `buildSummarizeLimitsInstruction`).
> - `test/smoke.test.js` — wired `todo-autopilot.test` (regression protection); removed `research-continuation.test` require.
>
> **Verification:**
> - `npm run check` exit 0 — 676 PASS, 0 FAIL.
> - `git grep -n "resolveResearchContinuation\|buildSummarizeLimitsInstruction" src/` returns only 5 tombstone comments (no function calls).
> - `git grep -n "auto_read_limit_reached\|usedSummarizeLimits" src/runtime/` returns 4 hits — 2 are tombstone comments in `state.js`; 1 comment + 1 intentional legacy-reason-string return in `todo-autopilot.js` for telemetry continuity.
> - `test/concerns/push-mode-invariants.test.js` extended; all 4 scenarios green with the additional 2 step types.
- **Related:** ADR-0023 (8 push-mode sites deleted), ADR-0024 (AI-first scaffolding), ADR-0025 (terminal source labels), ADR-0026 (last 2 fail-safe pushes deleted), ADR-0027 (live e2e closure)
- **Live evidence:** Third live e2e run on 2026-05-08 evening (in `agrun_docs/live-tests/zero-residual-push-mode-2026-05-08.md`) revealed `autoReadStoppedReason: "auto_read_limit_reached"` + `usedSummarizeLimits: true` on a fresh tab, exposing this hidden push site

## Context

ADR-0016 identified the problem and proposed deletion. It was deferred because the test cascade (`approval-resume.test.js` + dense-search dependent tests) explicitly assert on the auto-read URL selection + `summarize_limits` finalize push. ADR-0023 + ADR-0024 + ADR-0025 + ADR-0026 since then established the recipe for this kind of conversion (mock-surgery via cycle-2 branches, signal-based replacement, 4 Hard-Rules deletion).

ADR-0027's third live e2e (2026-05-08 evening) exposed the same push site STILL firing in production: `autoReadAttemptCount: 2`, `autoReadStoppedReason: "auto_read_limit_reached"`, `usedSummarizeLimits: true`, `terminalizedBy: "summarize_limits"`. Output truncated to 1,691 chars (vs. earlier runs of 2,612–4,764 chars) because runtime stopped read_url at attempt 2 + auto-finalized with hardcoded "summarize limits" prose. Functionally identical to the deleted `maybeApplySingleToolFastPath` push from ADR-0026: **runtime decides "AI doesn't need more" + force-finalizes with runtime-authored instruction.**

This is the LAST remaining push-mode site in the runtime. Push-mode 0 残留 invariant is incomplete until this is gone.

## Decision

Delete `resolveResearchContinuation` and its helpers entirely. Replace with read-only signal exposed via `loopState.readAttemptSignal`. AI sees the count + stop-reason on the next planner cycle and decides whether to:
1. Call `read_url` again (different URL)
2. Call `web_search` with a fresh query
3. Call `finalize` with whatever evidence is gathered

If AI keeps retrying without progress, `maxSteps` terminates. The runtime no longer makes the decision.

### Sites deleted

| File | Symbol | What it did (push-mode) |
|---|---|---|
| `src/runtime/research-continuation.js` | entire file | (1) Auto-picked next URL via `selection.nextCandidate.url`; (2) Counted attempts + force-stopped at threshold; (3) Auto-emitted `finalize` decision with `buildSummarizeLimitsInstruction` prose when stopped |
| `src/runtime/action-loop-session-cycle.js` | `resolveResearchContinuation` import + call site at line 79–99 | Wrote `runState.autoReadAttemptCount` + `runState.autoReadStoppedReason` + `runState.usedSummarizeLimits` from continuation. Now: kept as signal, no longer drives decisions |
| `src/runtime/action-loop-session-loop.js` | `readContinuityDecision` + `continuityDecision` branch (lines 121–150) | Used the runtime-injected continuation decision to PREEMPT the planner |

### Replacement

- `runState.readAttemptSignal = { attemptCount, threshold }` is computed from `researchContext.readSources.length` (count of read_url attempts in this turn). Exposed via `loopState.readAttemptSignal` to AI on next planner cycle.
- New planner-prompt directive line: "If `loopState.readAttemptSignal` shows you've already read N URLs this turn, you can finalize with what you have, run a fresh `web_search` with a different query, or pick a different URL — your call. The runtime will not stop you; it will hit `maxSteps` if you keep retrying without progress."
- `usedSummarizeLimits`, `autoReadStoppedReason` deleted from `runState` (no longer meaningful).

### Surfaces preserved

- `runState.researchContext.searchResults` and `readSources` — AI reads these directly to decide next move.
- `runState.researchContext.verification` (verification state) — informational only; AI decides what it means.
- `usableReadSourceCount` / `strongReadSourceCount` — kept as signals exposed to AI; no decision made by runtime.

## Acceptance criteria

| # | Acceptance signal | Verification |
|---|---|---|
| A1 | `git grep -n "resolveResearchContinuation\|buildSummarizeLimitsInstruction" src/` returns 0 hits | grep |
| A2 | `git grep -n "auto_read_limit_reached\|usedSummarizeLimits" src/runtime/` returns 0 hits in source modules (test files retain negative assertions) | grep |
| A3 | `runState.readAttemptSignal` populated when `readSources.length >= threshold` | unit test |
| A4 | `loopState.readAttemptSignal` surfaces in planner prompt | planner-prompt unit test |
| A5 | `npm run check` exits 0 | terminal |
| A6 | `npm run build` exits 0 | terminal |
| A7 | `test/concerns/push-mode-invariants.test.js` adds `auto_read_limit_reached` step type to `DELETED_STEP_TYPES` array (regression protection) | test |
| A8 | Existing `usedSummarizeLimits === true` test assertions become `usedSummarizeLimits === undefined` (field removed) OR rewritten to verify AI emits planner_finalize | test |
| A9 | `test/unit/research-continuation.test.js` deleted (function gone) | grep |
| A10 | `mocked-fetch.js` mock cascades for `approval-resume` / dense-search emit AI-driven `read_url` after `web_search` returns | test |

## Risks

- **HIGH blast radius across tests.** ADR-0016 was deferred for this reason. ADR-0028 plan: do mock surgery in same commit (just like ADR-0026 did for `approval-finalize.test.js`). Pattern: cycle-2 mock branches keyed off `loopState.toolContext.lastResult` to emit AI-driven `read_url` / `finalize`.
- **`usedSummarizeLimits` was the documented overlay label** for context-overflow finalize. Removing it shifts `terminalizedBy` to plain `planner_finalize`. Telemetry consumers must update.
- **AI may fabricate without prodding.** Pre-ADR-0028, the runtime force-summarized when evidence was thin to prevent hallucination. Now AI is responsible for honest evidence-gap disclosure (ADR-0024 scaffolding already nudges this — third live e2e showed AI added `证据局限性说明` section unprompted, indicating ADR-0024 directive carries the load).

## Cadence

Single PR. Touches:
- `src/runtime/research-continuation.js` (DELETE)
- `src/runtime/action-loop-session-cycle.js` (drop import + call site + 3 runState writes)
- `src/runtime/action-loop-session-loop.js` (drop continuityDecision branch)
- `src/runtime/planner-prompt.js` (new directive line + loopState field)
- `src/runtime/state.js` (drop fields)
- `src/runtime/todo-autopilot.js` (autoReadStoppedReason reference cleanup)
- `src/runtime/todo-prompt-strings.js` (autoReadStoppedReason reference cleanup)
- ~5 test files (mock surgery + assertion updates)
- `test/concerns/push-mode-invariants.test.js` (extend `DELETED_STEP_TYPES`)
- `test/unit/research-continuation.test.js` (DELETE)
- This ADR + task.md + audit V14 closure update

## Migration notes for hosts

Hosts upgrading from pre-ADR-0028:

1. If you read `runState.autoReadAttemptCount` for telemetry: replace with `runState.readAttemptSignal?.attemptCount` (renamed, same semantics).
2. If you read `runState.usedSummarizeLimits` or `runState.autoReadStoppedReason`: these fields are deleted. The same context-overflow scenarios now surface as ordinary `planner_finalize` decisions where the AI itself acknowledges thin evidence (per ADR-0024 scaffolding).
3. If you depended on auto-read URL selection (runtime picking next URL after web_search): wire `onPlannerDecision` and call your own selection logic. Search results remain available via `runState.researchContext.searchResults`.
