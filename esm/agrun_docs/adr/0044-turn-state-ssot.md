# ADR-0044: TurnState SSOT And NextStep Signals

Date: 2026-05-27

Status: Accepted; AGRUN-287 implementation slice landed 2026-05-27

## Context

AGRUN-286 reviewed `agrun` against `openai-agents-js` 0.11.5 for turn-loop state-machine rigor.

`openai-agents-js` uses a compact turn state contract:

- `RunState` owns the mutable run state, including the current agent, original input, generated items, latest model response, current turn, and `_currentStep`.
- `NextStep` is a discriminated union with four loop-control outcomes: `next_step_run_again`, `next_step_handoff`, `next_step_interruption`, and `next_step_final_output`.
- `applyTurnResult()` is the single write point for turn results. The outer loop then switches on `state._currentStep`.
- Approval/HITL resume starts from the preserved `RunState`, resolves the interrupted turn, applies the turn result, and either returns another interruption, reruns the same turn, or advances.

Local source evidence:

- `sample project for study logic/openai-agents-js-0.11.5/packages/agents-core/src/runner/steps.ts` defines the `NextStep` union.
- `sample project for study logic/openai-agents-js-0.11.5/packages/agents-core/src/runner/runLoop.ts` centralizes `applyTurnResult()` and `resumeInterruptedTurn()`.
- `sample project for study logic/openai-agents-js-0.11.5/packages/agents-core/src/runState.ts` keeps `_currentStep`, `_currentTurn`, `_originalInput`, `_generatedItems`, and interruption helpers on `RunState`.
- `sample project for study logic/openai-agents-js-0.11.5/packages/agents-core/src/run.ts` switches on `state._currentStep`.

`agrun` already has the pieces, but not one loop-control SSOT:

- `src/runtime/state.js` creates one large `runState` with kernel fields, planner fields, approval fields, skill fields, research/workspace/todo state, metrics, convergence state, and OODAE state.
- `src/runtime/run-state-projections.js` already split out a kernel projection and subsystem projections, but there is no turn-control projection equivalent to `NextStep`.
- `src/runtime/action-loop-session-loop.js` drives control flow through scattered `continue`, `return`, `handlePolicyBlock`, `handlePlannerFinalDecision`, `handlePlannerFinalizeDecision`, `executePlan`, `executeAction`, and max-step finalization paths.
- `src/runtime/action-loop-session-cycle.js` increments `cycleCount` / `turnCount`, updates `turnState`, and records OODAE phases, but `turnState` currently describes semantic context rather than the next loop control outcome.
- `src/runtime/oodae.js` records observe/orient/decide/act/evaluate phase data; it does not decide loop continuation.
- `src/runtime/approval-state.js` creates resume tokens with selected state slices; `src/runtime/approval.js` rehydrates a new session and then continues the action loop. This works for current approvals, but it is not yet a first-class `next_step_interruption` state.

## Decision

Adopt a future `TurnSignal` state machine as the SSOT for loop control, without changing runtime code in AGRUN-286.

Target shape:

```js
export const TURN_SIGNALS = Object.freeze({
  RUN_AGAIN: "run_again",
  HANDOFF: "handoff",
  INTERRUPTION: "interruption",
  FINAL_OUTPUT: "final_output"
});
```

The future `runState.turnControl` should be the single loop-control slot:

```js
{
  signal: "run_again" | "handoff" | "interruption" | "final_output",
  source: "planner" | "plan_action" | "policy" | "approval_resume" | "runtime_failure",
  cycle: number,
  actionName?: string,
  pendingApproval?: object,
  handoff?: object,
  output?: object,
  error?: object,
  observation?: object
}
```

Rules:

- Runtime may classify facts into `TurnSignal`; AI still chooses actions and terminal content.
- `TurnSignal` is not an AI-quality judge and must not reintroduce push-mode.
- Existing `runState.turnState` should remain semantic turn context. The new loop-control slot should be named `turnControl` or `nextStep` to avoid overloading.
- OODAE remains the phase/event trace. It should observe phases, not own loop control.
- Subsystems may return a `TurnSignal` envelope, but one future helper should apply it to `runState.turnControl` and emit the corresponding event/step.
- `interruption` must preserve enough state for AGRUN-287: conversation/request context, pending tool call, planner decision, action history, cycle/turn counters, workspace/todo/research state, agent skill context, and approval decision metadata.

Recommended migration order:

1. Add a small `src/runtime/turn-signal.js` module with constants, normalizer, projector, and `applyTurnSignal(runState, signal)`.
2. Wire policy approval blocks to emit `turnControl.signal === "interruption"` while keeping the existing result shape.
3. Move approval resume rehydration toward serialized `turnControl.interruption` rather than a hand-picked resume token allowlist.
4. Project `turnControl` into inspector/debug surfaces so hosts can see why the loop paused, continued, handed off, or finalized.
5. Only after AGRUN-287 passes, consider replacing scattered loop returns with a central switch.

AGRUN-287 implementation note (2026-05-27):

- `src/runtime/turn-signal.js` now owns `TURN_SIGNALS`, `createTurnControl()`, `applyTurnControl()`, projection, and planner prompt summarization.
- Policy approval blocks emit a `next_step_interruption` step and set `runState.turnControl.signal === "interruption"` while preserving the existing `runState.pendingApproval` result contract.
- Approval resume tokens carry `turnCount`, `turnControl`, and existing workspace/research/todo/tool context slices. `hydrateApprovalSession()` restores the saved cycle/turn counters before starting the approval-resolution cycle.
- Approval denial records a `tool_rejection` observation, clears `pendingApproval`, sets `turnControl.signal === "run_again"`, and lets the planner choose the next action.
- The loop still has scattered return paths; central switch migration remains future work.

## Alternatives

Keep current scattered control flow.

- Pro: no migration work.
- Con: approval resume remains hard to reason about, and future stream/non-stream parity will duplicate branches.

Rename the existing semantic `turnState` to become the loop-control SSOT.

- Pro: fewer top-level fields.
- Con: current `turnState` already means semantic context, ambiguity, topic, and approval input context. Reusing it for loop control would mix two different concepts.

Port `openai-agents-js` `RunState` directly.

- Pro: proven state-machine shape.
- Con: `agrun` is browser-native and has richer workspace/research/todo/quality-signal state. A direct port would erase useful harness facts and would not fit ADR-0023.

## Consequences

Positive:

- AGRUN-287 gets a clear contract for HITL pause/resume.
- Hosts and inspectors can read one field to know why the loop is continuing, finalizing, handing off, or waiting for a user.
- Future stream/non-stream parity can share one apply-and-switch shape.
- State serialization becomes more explicit because the interruption payload has a named home.

Costs:

- Some existing branch paths in `action-loop-session-loop.js`, `approval.js`, and terminal handlers will need careful migration.
- Tests must cover the control signal and the legacy visible result shape during the transition.
- `turnControl` must stay factual. If it starts deciding whether the AI's answer is "good enough", it violates ADR-0023.

## Rollback

The AGRUN-286 slice was documentation-only. AGRUN-287 added observational runtime writes to `turnControl`.

Rollback should be incremental:

- keep the constants/projection module if it is only observational;
- disable writes to `runState.turnControl` behind a small compatibility helper;
- preserve existing `pendingApproval` / resume-token behavior until AGRUN-287 proves parity.

## Verification

AGRUN-286 verification scope:

- Codeloom status checked for `agrun` and local source reads confirmed the indexed findings.
- Reviewed local `agrun` files: `src/runtime/run-loop.js`, `src/runtime/action-loop-session.js`, `src/runtime/action-loop-session-loop.js`, `src/runtime/action-loop-session-cycle.js`, `src/runtime/oodae.js`, `src/runtime/state.js`, `src/runtime/run-state-projections.js`, `src/runtime/approval-state.js`, and `src/runtime/approval.js`.
- Reviewed local `openai-agents-js` files: `packages/agents-core/src/runner/steps.ts`, `packages/agents-core/src/runner/runLoop.ts`, `packages/agents-core/src/runState.ts`, and `packages/agents-core/src/run.ts`.
- No runtime code changed.
