# AGRUN-246-L — Simulator Pivot Evidence 2026-05-25

## Scope

Gate `npm test`-grade evidence that `gemini-3.1-flash-lite` actually pivots
when the `search_query_diversification_signal` elevates. Per
AGRUN-246-K lesson: simulator-first (`~1s/iteration`) before canonical
live verify (`~10 min/run`). The 246-K series cost 9+ live reruns because
this gate was skipped.

## Script

`scripts/simulate-agrun-246-l-pivot.mjs` — fully offline-built
synthetic runState; only the live LLM call hits Gemini REST. Builds the
real planner prompt via `buildPlannerPrompt()` and the real signal via
`refreshSearchQueryDiversificationSignal()` so the prompt the model
sees matches what the runtime will surface in production.

## Variants

| Variant | Synthetic state | Expected signal | Expected behavior |
|---|---|---|---|
| `same-angle-repeat` | 2 prior `web_search` both declared `queryAngle="evaluation_framework"` | `same_angle_repeat` (elevated) | Model picks a DIFFERENT `queryAngle` on the next call |
| `quiet-baseline` | 2 prior with distinct angles (`definition` + `production_reliability`) | `quiet` | Model is free to choose any action |
| `unknown-angle` | 1 prior with `queryAngle: null` | `unknown_angle` | Model either declares an angle or picks a different action |

## Results

Real Gemini API calls at ~1.2-1.7 seconds each.

| Variant | Run | Picked action | Picked `queryAngle` | Verdict |
|---|---|---|---|---|
| same-angle-repeat | #1 | `web_search` | `technical_implementation` | **PASS** |
| same-angle-repeat | #2 | `web_search` | `implementation_best_practices` | **PASS** |
| same-angle-repeat | #3 | `web_search` | `engineering_methodology` | **PASS** |
| quiet-baseline | #1 | `todo_plan` | (n/a) | **PASS** (signal quiet → no forced change) |
| unknown-angle | #1 | `todo_plan` | (n/a) | INCONCLUSIVE (model chose to plan rather than search; not a failure) |

**Elevated-signal pivot rate: 3 / 3 = 100%.**

Direct comparison to AGRUN-246-K (where the read-phase signal was
ignored): 246-K simulator-equivalent showed 0 pivots; 246-L shows 3/3.
The structural difference is `forbiddenMove` + `allowedNextMoves` +
enum status (KB-informed v2 design) versus the soft NL hint string that
246-K shipped.

## Model reasoning (verbatim)

The model's `reasoning` field in run #1:

> "Previous searches were too focused on evaluation frameworks. To
> understand 'Harness Engineering' in the context of AI agents, I need
> to broaden the search to include system design patterns and testing
> infrastructure for agentic workflows."

This is the AI explicitly acknowledging the signal AND broadening on
its own — exactly the harness-engineering target behavior. Runtime
exposed the structured fact; AI judged and pivoted.

## What this gates

- ✅ Mechanism is behavior-effective on `gemini-3.1-flash-lite` at the
  simulator layer. Cleared for the next step.
- ✅ Justifies paying the cost of the ≥3 canonical Mandarin live verify
  (task #18). Without this evidence, live verify is a coin flip per
  246-K.

## What this does NOT prove

- Real long-form research has many more cycles, many more competing
  signals (terminal_repair_state, action_pattern_convergence, etc.).
  Simulator is single-shot. Live verify can still fail even with
  simulator PASS — but probability is materially lower than 246-K's
  unverified attempt.
- `rerun4`-shaped fixture rows (2 distinct fine angles inside the same
  broad cluster) cannot be tested at the simulator level because the
  generic rule already misses them at fixture level. Live trace
  diagnosis remains the way to identify any new boundary cases.
- The simulator uses `temperature=0.7`. A different temperature might
  change pivot rate. The live runtime also uses default sampling.

## HBR

- Only the elevated case was tested for pivot; the quiet-baseline and
  unknown-angle variants used 1 run each. If the live verify is
  borderline, repeat them with 3 runs each to characterize noise.
- The model was given a planner prompt with full live planner surface
  (terminalRepairState, etc.) so the test environment matches
  production. But the simulator prompt has NO accumulated workspace
  state; in real runs the workspace_write/replace activity may
  influence the model differently.
- The `[simulate-246-l] verdict=INCONCLUSIVE` for unknown-angle is
  because the model chose `todo_plan` — this is technically acceptable
  (planning before searching), but the simulator script should be
  extended to recognize "AI-respects-allowedNextMoves-without-search"
  as a separate PASS category later.

## Next step

Proceed to AGRUN-246-L task #18: ≥3 canonical Mandarin live verify
with the same prompt that produced the 3/7 = 43% baseline. Rollback if
any source-fail trace shows the signal elevated but the model did not
pivot.
