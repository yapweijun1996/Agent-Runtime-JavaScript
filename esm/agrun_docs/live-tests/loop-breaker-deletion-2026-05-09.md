# Live test — Plan validation loop-breaker DELETION (AI-first, 2026-05-09)

- **Commit:** (this turn — supersedes `abfe576c6` plumbing patch)
- **Trigger:** User asked "why you hardcode?" after I shipped the plumbing-fix commit. They were right — the plumbing made a hardcoded directive injection actually work, instead of removing the anti-pattern.
- **Action:** Deleted `notePlanValidationFailure`, `runState.runtimePlannerDirectives`, `mergeRuntimeDirectivesIntoCycle` entirely. Plan-validation rejection now flows AI-first only.
- **Files touched:** `src/runtime/state.js`, `src/runtime/action-loop-plan.js`, `src/runtime/action-loop-planner.js`

## Why the previous "fix" was hardcode

Commit `abfe576c6` wired through this directive (line 411 of action-loop-plan.js, deleted today):

```
const directiveBase = "This turn must not use the plan envelope; emit a
single action envelope instead. Repeated plan validation errors detected.";
const directive = detail ? `${directiveBase} ${detail}` : directiveBase;
```

Three hardcode points:

| Point | Anti-pattern |
|---|---|
| Fixed English directive string | Runtime authoring AI's prompt — same shape as deleted `summarize_limits` overlay (ADR-0028) |
| Magic threshold `>= 2` | Runtime deciding when AI's behavior is "wrong enough" to intervene — runtime making strategy choice |
| Prescribed recovery `"emit a single action envelope instead"` | Runtime telling AI which recovery path to take — AI may have multiple valid paths (single action, ask_clarification, different plan structure, retry with different args) |

The CLAUDE.md root rule says "Do not let runtime do AI work, must always
believe and use AI-first logic, no hardcode, no hardcode, no hardcode."
The plumbing fix violated all three iterations of that rule.

## What stays — AI-first observation path

`validation.planner_feedback.detail` already reaches AI without runtime
mediation:

```
validatePlan() → validation.planner_feedback.detail (structured)
  → createPlanErrorOutput("validation", err, validation.planner_feedback)
  → output.planner_feedback (in plan_result)
  → continueAfterPlanObservation({ output, ... })
  → observation.lastResult.output (visible to next planner cycle)
  → AI reads detail, decides recovery
```

This was always there. The anti-pattern bolted a parallel
runtime-decision-making path on top of it, which created the phantom
feature in the first place. Removing the bolt-on leaves a clean AI-first
observation path.

The pre-existing `plan-validation-failed` and `plan-validation-rejected`
step events are preserved — they are pure telemetry for host debug, not
directives to AI.

## Files changed (deletion summary)

| File | Removed |
|---|---|
| `src/runtime/action-loop-plan.js` | `notePlanValidationFailure(...)` function (37 lines) + call site (1 line) |
| `src/runtime/state.js` | `runState.runtimePlannerDirectives = []` initialization (1 line + comment) |
| `src/runtime/action-loop-planner.js` | `mergeRuntimeDirectivesIntoCycle(...)` helper + planner-cycle merge call + clear logic (~25 lines) |

Net: ~70 lines deleted. Replacement: zero new lines of behavior code.
Tombstone comments left in place to prevent re-introduction by a future
"fix me" patch.

## Verification

| Check | Result |
|---|---|
| `npm run check` | ✅ exit 0 — all 676+ test cases pass (planner-directives append/replace, push-mode invariants, plan-validation-recovery) |
| `npm run build` | ✅ exit 0 — lib + browser bundle clean |
| `grep "notePlanValidationFailure\|runtimePlannerDirectives\|mergeRuntimeDirectivesIntoCycle\|planValidationFailures" src/ test/` | Returns only deletion-tombstone comments. Zero behavior references remain. |
| Validation observation path intact | `createPlanErrorOutput("validation", validation.error, validation.planner_feedback)` at action-loop-plan.js:101 still passes structured feedback into plan_result; AI receives via observation |

## Live retest expectations

Pre-deletion (with hardcoded loop-breaker plumbing):
- Some lite-tier runs would loop on `skill_mutator_in_plan` until directive armed (or never armed and fell back to `planner_final` text)

Post-deletion:
- AI-first only: lite-tier may still loop on the same invalid plan for the first 2-3 cycles
- AI sees `planner_feedback.detail` in observation each time and decides recovery
- If AI keeps emitting same invalid plan, that's a model capability constraint
- Hosts circuit-break via `maxSteps` / `maxTokens` / model selection

A live retest in this commit cycle showed the same Mandarin research
prompt completing cleanly via `planner_finalize` without invoking any
plan-rejection loop (the bug case is non-deterministic; some sessions
hit it, some don't). Multi-run variance is documented in
`adr-0028-variance-matrix-2026-05-09.md`.

## ADR-0028 invariants — strengthened

| Invariant | Status |
|---|---|
| Runtime never authors action decisions | ✅ stronger now — directive injection path deleted |
| `terminalizedBy ∈ {planner_finalize, planner_final}` | ✅ unchanged |
| Push-mode 0 残留 | ✅ stronger — one more push-mode site (loop-breaker) deleted |
| Field-deletion grep clean | ✅ no `runtimePlannerDirectives` / `notePlanValidationFailure` / `mergeRuntimeDirectivesIntoCycle` references in src or test |

## Honest bad results

- **Commit `abfe576c6` was hardcode** — shipped before catching it. User caught it on review with "why you hardcode?". Documented as deletion target rather than amending the original commit's history (preserves the lesson).
- **3-run live retest from `abfe576c6` was a false success signal** — none of the 3 runs triggered the loop-breaker arm (because lite-tier didn't emit invalid plan), so the directive injection never fired. The "fix" was working only because it wasn't actually being exercised. This deletion removes both the broken phantom feature AND the post-fix that made it "work" without ever having proved it should exist.
- **Lite-tier may regress to looping** — if `skill_mutator_in_plan` rejection happens, AI may emit same invalid plan twice before observation feedback adapts behavior. This is honest model-capability tradeoff for AI-first purity. Hosts must own the circuit breaker.
- **No e2e test for AI-first observation path** — the structured `planner_feedback.detail` path is verified by grep + concern tests for `validatePlan`, but no end-to-end mocked-AI test confirms "AI emits plan twice → reads detail → emits single action third time". Adding this coverage is queued.

## Reflection

**Am I trying to hardcode this instead of using harness engineering?** —
Not anymore. The fix is deletion, which is the strongest harness move
available. Runtime now provides only: tools, observation, telemetry.
AI provides: all decisions including recovery strategy.

Deeper reflection: my reflex on seeing a phantom feature (write-but-no-read)
was "make it work" instead of "should it exist". That reflex is the
hardcode root cause. Training data: when ADR-0023 / ADR-0026 / ADR-0028
all delete push-mode sites, my next encounter with a push-mode-shaped
construct should default to "delete" not "wire". Recorded in skill
`ai-first-push-deletion` Common Mistake (next update).

User's "why you hardcode?" was the correct intervention. Without it I
would have shipped the plumbing-fix as the final answer, leaving a
disguised push-mode site in the codebase indefinitely. AI-first
discipline requires external accountability when the developer's reflex
fails — that's literally the harness engineering principle applied to
the developer, not just to the runtime.
