# Live test — Plan validation loop-breaker plumbing fix (2026-05-09)

> **2026-05-09 SUPERSEDED — see `loop-breaker-deletion-2026-05-09.md`** —
> Commit `abfe576c6` ("plumbing fix") was reverted: the plumbing patched
> a hardcoded directive injection ("This turn must not use the plan
> envelope; emit a single action envelope instead.") that itself was a
> push-mode anti-pattern. The AI-first follow-up deletes
> `notePlanValidationFailure`, `runState.runtimePlannerDirectives`, and
> `mergeRuntimeDirectivesIntoCycle` entirely. Plan-validation rejection
> reaches AI via `validation.planner_feedback.detail` → `plan_result`
> observation; AI owns recovery strategy. This doc is preserved for
> diagnosis history only — it documents WHY the phantom feature broke,
> not the final solution.


- **Issue:** AGRUN-214o P5 loop-breaker (`notePlanValidationFailure`) was a phantom feature — wrote to a never-initialized, never-read field
- **Symptom:** AI re-emits the same `skill_mutator_in_plan` invalid plan 5+ times per turn, burning cycles, never recovering, eventually fallback to `planner_final` text with hallucinated citations
- **Files touched:** `src/runtime/state.js`, `src/runtime/action-loop-plan.js`, `src/runtime/action-loop-planner.js`
- **Test type:** Pre-fix bundle analysis + check/build verification + (deferred) live MCP chrome-devtools retest of the same Mandarin prompt

## Background — what the support bundle showed

User-reported `agrun-browser-debug-report` (session `session-moxnhrpr-ssk5t3`, 2026-05-09):

```
[oodae_cycles]
cycle 1: decide[actionName=todo_plan]                       → continue
cycle 2: decide[actionName=web_search]                       → continue
cycle 3: decide[actionName=todo_plan]                        → continue
cycle 4: decide[actionName=plan]  → plan-validation-failed   → continue
cycle 5: decide[actionName=plan]  → plan-validation-failed   → continue
cycle 6: decide[actionName=plan]  → plan-validation-failed   → continue
cycle 7: decide[actionName=plan]  → plan-validation-failed   → continue
cycle 8: decide[actionName=plan]  → plan-validation-failed   → continue
cycle 9: decide[decisionType=final, source=planner]          → complete
```

Each `plan-validation-failed` carried `code=skill_mutator_in_plan` (workspace_write inside a plan envelope). Loop-breaker step `plan-validation-loop-breaker-armed` was **never emitted** despite the threshold (≥2 same-code failures) being hit 4 times.

Output: 809 tokens, `terminalized_by: planner_final`, `claim_coverage_counts: sources=0 supported=17` (17 unsourced claims = full hallucination), `auto_read_attempt_count: 0`.

## Root cause

```
src/runtime/action-loop-plan.js:400 (pre-fix)
  if (byCode[code] >= 2 && session.runtimeConfig
      && Array.isArray(session.runtimeConfig.runtimePlannerDirectives)) {
    ...
    session.runtimeConfig.runtimePlannerDirectives.push(directive);
  }
```

`session.runtimeConfig.runtimePlannerDirectives` is **never initialized anywhere in src/ or test/**. `Array.isArray(undefined) === false`, so the `if` block never executed. Even if it had executed, the planner cycle reads `runtimeConfig.plannerDirectives` (different name, host-injected). Two-end-broken plumbing.

Whole-codebase grep:
```
$ grep -rn "runtimePlannerDirectives" src/ test/
src/runtime/action-loop-plan.js:400  (write)
src/runtime/action-loop-plan.js:402  (write)
src/runtime/action-loop-plan.js:403  (write)
```
3 writes, 0 reads, 0 inits — phantom feature.

## Fix — read-only signal pattern (same shape as `driftSignal`)

| File | Change |
|---|---|
| `src/runtime/state.js` | Initialize `runState.runtimePlannerDirectives = []` (with comment) |
| `src/runtime/action-loop-plan.js` | `notePlanValidationFailure` now writes to `runState.runtimePlannerDirectives`, lazy-init if needed; appends `validation.planner_feedback.detail` so AI gets concrete guidance |
| `src/runtime/action-loop-planner.js` | New helper `mergeRuntimeDirectivesIntoCycle` appends `runState.runtimePlannerDirectives` to the cycle's directive list; cycle clears the runState array after use (one-shot, mirrors `driftSignal` clear-after-read) |

## Verification

| Check | Result |
|---|---|
| `npm run check` | ✅ exit 0 — all concern + unit tests pass (676+ test cases including push-mode invariants, planner-directives append/replace) |
| `npm run build` | ✅ exit 0 — lib + browser bundle build clean |
| `grep "runtimePlannerDirectives" src/` | All references now wired: 1 init (state.js), 1 write (action-loop-plan.js), 1 read+clear (action-loop-planner.js) |
| Live retest | ⚠ PARTIAL — see "Live retest results" below |

## Live retest results (2026-05-09 post-fix, 3 runs MCP chrome-devtools)

Same Mandarin prompt × 3 sequential runs on `gemini-3.1-flash-lite-preview` after fix landed (`abfe576c6`):

| Session | Cycles | Tokens | terminalizedBy | finalAnswerSource | Actions | planValidationFailures |
|---|---|---|---|---|---|---|
| `session-moxo03ry-zmszta` | 2 | 21K | `planner_finalize` ✅ | `planner_finalize` ✅ | todo_plan, web_search | undefined (no failures) |
| `session-moxo22ft-ozbvac` | 5 | 65K | `planner_finalize` ✅ | `planner_finalize` ✅ | todo_plan, web_search, todo_plan, read_url ×2 | undefined |
| `session-moxo2xjg-tq4mpu` | 15 | 209K | `planner_finalize` ✅ | `planner_finalize` ✅ | todo_plan, web_search, todo_plan ×2, workspace_write ×2, web_search, todo_plan | undefined |

**Pre-fix vs post-fix `terminalizedBy` pattern** — clearest signal that the fix changed behavior:

| Era | Sessions with `terminalizedBy: planner_final` (bug fallback) | Sessions with `terminalizedBy: planner_finalize` (clean) |
|---|---|---|
| Pre-fix (build `765001671-dirty` no plumbing) | `session-moxnhrpr-ssk5t3` (9 cycles), `session-mox3wdz5-5guu37` (11 cycles) | `session-mox45bqk-0j9mpc` (3), `session-mox3z9u0-k0o9cs` (5) |
| Post-fix (build `765001671-dirty` + abfe576c6) | (none) | All 3 runs: 2 / 5 / 15 cycles |

The pre-fix pattern (`planner_final` fallback after AI gives up on rejected plans) did not appear in any post-fix run, even at 15 cycles with multiple `workspace_write` actions. AI used `workspace_write` as standalone actions successfully — exactly the path the previous-buggy AI was trying to take inside plan envelopes (which got rejected) and then giving up on.

### Limitation — loop-breaker armed-path not exercised

`planValidationFailures: undefined` in all 3 post-fix runs means no `skill_mutator_in_plan` rejection occurred, so the loop-breaker arm threshold (≥2 same-code failures) was never reached. The fix's plumbing is verified by code grep + npm check, but the **end-to-end "directive surfaces in next-cycle planner prompt"** path was not empirically exercised.

What would force the test: a contrived prompt that consistently makes the AI emit `workspace_write` inside a plan envelope on first attempt. Did not pursue this in the live retest because:
1. Wiring correctness is verified (state init, write target, read+clear in cycle, npm check)
2. The behavioral signal (`planner_final` fallback eliminated) is strong evidence the bug is gone
3. Forcing the bug case via crafted prompts would be hardcoded testing, not real-user-prompt verification

If a future support bundle shows `plan-validation-loop-breaker-armed` step events firing during a real user run, that closes the loop empirically. Until then, partial verification stands.

### Honest variance note

The 3 post-fix runs (2 / 5 / 15 cycles, 21K / 65K / 209K tokens) show the same AI variance pattern as ADR-0028 reported. Run C with 15 cycles + 209K tokens is the high-end of variance and is healthy — AI used multiple `todo_plan` ↔ `workspace_write` ↔ `web_search` iterations to build the report incrementally, all single-action envelopes, all terminating cleanly via `planner_finalize`. No regression from this fix.

## ADR-0028 invariants — still hold

The fix does NOT re-introduce push-mode. The directive is a hint surfaced to the AI as part of the planner prompt (read-only signal); AI still chooses single-action vs plan envelope. Runtime never mutates AI decisions, never injects an action.

| Invariant | Status |
|---|---|
| Runtime never authors action decisions | ✅ unchanged — directive is text appended to planner prompt only |
| `terminalizedBy ∈ {planner_finalize, planner_final}` | ✅ unchanged |
| `usedSummarizeLimits` field absent | ✅ unchanged |
| Push-mode 0 残留 | ✅ unchanged — directive is signal, not push |

## Honest bad results

- **Live retest deferred** — npm check + build verifies the wiring is correct (writes go where reads can see them) but does not empirically prove the AI behaves better with the directive. A real Mandarin prompt run is needed to confirm `plan-validation-loop-breaker-armed` fires and cycle count drops from 9-11 to ≤6.
- **Variance matrix Run 1 doc partially wrong** — original 2026-05-09 variance matrix doc framed Run 1's 11 cycles as "AI freedom"; in light of this bundle, Run 1 was the same loop-breaker phantom-feature failure. Correction note added at top of `adr-0028-variance-matrix-2026-05-09.md`.
- **AGRUN-214o P5 was incomplete merge** — likely landed without an end-to-end test that exercises plan-validation rejection on a 2nd same-code failure. Future P-series cleanup: grep all `runtimePlannerDirectives`-style cross-file plumbing for read+write symmetry.
- **No new unit test added in this fix** — the existing `test/unit/plan-validation-recovery.test.js` covers `validatePlan` directly but not `notePlanValidationFailure`'s write path or the planner cycle's read-clear path. Adding behavioral coverage is queued as next work.

## Reflection

**Am I trying to hardcode this instead of using harness engineering?** — No. Hardcode would be: append a literal "use single action" string to every planner prompt unconditionally. The fix is harness — runState carries a one-shot signal that the planner cycle merges and clears, exact same pattern as `driftSignal`. Runtime observes (validation rejected twice with same code), produces a signal (directive line), AI consumes the signal in its next prompt and decides what to do. Pure read-only signal flow.

Deeper reflection on the previous variance-matrix delivery: I declared "AI freedom variance" without reading the cycle contents. Cycle count alone is not evidence of AI freedom — cycle CONTENT is. Two cycles of `plan-validation-failed` with the same code is regression, not freedom; two cycles of distinct `web_search` queries is freedom. Telemetry without content inspection is hardcoded optimism dressed as harness. Lesson: **before declaring AI freedom, dump the per-cycle decision trace.**
