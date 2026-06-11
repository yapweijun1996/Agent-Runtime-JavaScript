# ADR-0034: Invalid-Action Loop Convergence as AI-Visible Observation

## Context

When a host registers `disabledActions: ['web_search', 'read_url', ...]`
and the planner repeatedly emits one of those actions, the runtime
currently enters a long `planner-invalid-action → planner-repair-requested
→ planner-repair-failed → planner-invalid-signal-escalated` loop that
only terminates when step budget is exhausted.

Empirical evidence (mock repro 2026-05-25, agrun build `8abb8c19c-dirty`,
Globe3-shaped config: 32 ERP `agentSkills`, `disabledActions: [web_search,
read_url, todo_*]`, plannerMode=envelope, mock provider emitting
`web_search` with varied query strings):

| Step type                              | Count over 31 cycles |
|----------------------------------------|----------------------|
| `cycle-started`                        | 31                   |
| `planner-requested`                    | 31                   |
| `planner-invalid-action`               | 30                   |
| `planner-repair-requested`             | 30                   |
| `planner-repair-failed`                | 30                   |
| `planner-invalid-signal-escalated`     | 28                   |
| `action-executed`                      | **0**                |
| `terminal-repair-state-refreshed`      | 0                    |
| `action-pattern-convergence-refreshed` | 0                    |
| `research-report-loop-committed`       | 0                    |
| `terminalizedBy`                       | null (mock exhausted)|

Findings:

1. `terminalRepairState`, `researchReportLoop`, and
   `actionPatternConvergence.{terminalCorrectionState,terminalRetryCooldown,
   readOnlyPlanningState}` are **never** activated on this path —
   they all gate on `action-executed` events that never occur. So model
   reasoning text claiming "I am in terminal repair mode" against a
   non-research host is hallucination, not runtime state.
2. The 28 `planner-invalid-signal-escalated` events do not convert into
   a terminal stop or a structured signal the model can act on. They
   only contribute to step budget burn.
3. Hosts have no `runState` field they can show their UI to warn the
   user the agent is stuck on a forbidden-action loop. Step budget
   eventually fires, but only after wasted provider round-trips.

Affected modules / contracts:
- `src/runtime/planner.js` — emits `planner-invalid-action`,
  `planner-repair-requested`, `planner-repair-failed`.
- `src/runtime/planner-action-surface.js` — computes the action surface
  passed to the planner prompt; today `disabledActions` filters at
  validation, not at prompt-construction time, so the model still sees
  the disabled action as a candidate.
- `src/runtime/state.js` — runState shape; no slot today for
  invalid-action convergence.
- `agrun_docs/feature-toggles.md` — `disabledActions` is documented as
  a list, with no mention of loop behaviour when the planner persists
  on a disabled action.

## Decision

Add an AI-visible, host-observable signal for the
invalid-action / failed-repair loop. The runtime does NOT hard-kill the
loop; instead, it surfaces structured state the AI can read to choose a
different action, and a step event the host can subscribe to.

### Runtime contract additions

1. New `runState.invalidActionConvergence` slot, updated on every
   `planner-invalid-action` / `planner-repair-failed` event:

   ```js
   {
     kind: "invalid_action_convergence",
     active: boolean,
     consecutiveInvalidCount: number,
     consecutiveRepairFailureCount: number,
     lastInvalidActionName: string | null,
     lastInvalidReason: string | null,
     disabledActionsEncountered: string[],
     availableActions: string[],
     availableAgentSkillIds: string[],
     suggestedNextMoves: string[],
     firstObservedAtCycle: number | null,
     lastObservedAtCycle: number | null,
     escalation: "advisory" | "hard_signal",
     version: 1
   }
   ```

   `active=true` once `consecutiveInvalidCount >= 2` from the same
   `lastInvalidActionName`. `escalation="hard_signal"` once
   `consecutiveInvalidCount >= 4`.

   `availableActions` is computed by subtracting `disabledActions` from
   the planner action surface for the current run (no agentSkill listing
   here — those go in `availableAgentSkillIds`).

   `suggestedNextMoves` is derived deterministically from
   `availableActions` ∩ ("actions that produce observable progress" —
   i.e. `execute_skill_tool`, `use_agent_skill`, `finalize` when run
   has reached its budget). No prose, no MUST/SHOULD/NOW imperatives.

2. New step event `invalid-action-convergence-refreshed` with the
   same payload, emitted whenever the slot changes. Hosts subscribe
   via `onStep`.

3. Planner-prompt projection: when
   `invalidActionConvergence.active === true`, the planner prompt
   includes a compact observation block listing the action the
   model has been emitting, the fact that it is in `disabledActions`,
   and the `availableActions` / `availableAgentSkillIds` it should
   choose from instead. The prompt does **not** tell the model what
   to do — it shows the observable fact and lets the AI decide.

4. No hard kill. The existing `budget.cyclesSinceProgress` /
   `budget.invalidDecisions` still terminate the run if the AI ignores
   the signal. AI-first stays intact: runtime surfaces facts, AI
   chooses.

### Host-facing knobs

- No new feature flag. `disabledActions` already exists; this ADR
  changes what the runtime publishes when the planner persists on a
  disabled action, not the input contract.
- `runtime.getRuntimeConfig()` continues to expose `disabledActions`.
  Hosts inspecting `runState.invalidActionConvergence.escalation` can
  drive their own UI ("Agent is stuck on a disabled action").

### Out of scope

- Changing `disabledActions` to remove disabled actions from the
  planner-visible action catalog at prompt-construction time. That is
  a separate optimization (planner-action-surface.js change) that
  reduces the bug's surface but is not part of this ADR. Filed as a
  follow-up.
- Bundled-skill self-exclusion when required actions are disabled
  (Globe3 ASK #4 redesign). That is a separate ADR; this one stays
  scoped to the invalid-action loop signal.

## Alternatives

1. **Hard kill after N invalid actions.** Rejected — violates AI-first.
   Runtime would be deciding when AI gives up. Identical to existing
   budget gate but with a smaller threshold, which is just hardcoding
   a different magic number.
2. **Strip disabled actions from the planner action surface at
   prompt-construction time so the model never sees them.** Reduces
   bug surface significantly, but does not eliminate it (model can
   still emit any action name even outside the surface, and lite-tier
   models do). Worth doing as a follow-up but not sufficient on its
   own — the signal layer above is still needed for the residual cases.
3. **Rely on existing `actionPatternConvergence.semanticTerminal`
   path.** Doesn't fit — that path activates on terminal-action
   (publish/finalize) repeats only. `web_search` is not a terminal
   action, so this path never fires for the Globe3 loop. Confirmed
   empirically: 0 flips across 30 invalid emissions.

## Consequences

- Pros:
  - Hosts gain a single `runState` field + step event to surface
    "stuck on disabled action" to UI.
  - AI gets a structured observation in the planner prompt that lets
    it switch to a registered skill / `finalize` / `ask_clarification`
    without the runtime authoring its move.
  - Discriminates against the model-hallucination failure mode: when
    the model says "I am in terminal repair mode" but
    `runState.terminalRepairState.active === false` AND
    `runState.invalidActionConvergence.active === true`, the host
    knows it's an invalid-action loop, not a terminal-repair loop.
- Cons:
  - One more runtime state slot, one more step event, one more
    planner-prompt block. Increases surface area.
  - The signal can be ignored by the model (by design). Hosts that
    want hard kill must still tune `budget.invalidDecisions`.
- Risks:
  - Planner-prompt projection adds tokens to every cycle once active.
    Mitigation: only emit the block while `active === true`; clear
    immediately when the next valid action executes.

## Rollback

- Delete `runState.invalidActionConvergence` slot and the step event.
- Delete the planner-prompt projection block.
- The existing `planner-invalid-action` / `planner-repair-failed`
  event sequence is unchanged — rollback is purely additive removal.
- `agrun_docs/feature-toggles.md` `disabledActions` row needs its
  follow-up note removed.

## Verification (when implemented)

- Unit: extend `/tmp/globe3-repro.mjs` shape into
  `test/unit/invalid-action-convergence.test.js`. Assertions:
  - After 2 consecutive `web_search` emissions against
    `disabledActions: ['web_search']`, `runState.invalidActionConvergence.active === true`.
  - After 4 consecutive, `escalation === "hard_signal"`.
  - `availableActions` excludes `web_search` and includes
    `execute_skill_tool` / `finalize`.
  - One `action-executed` of any valid action clears
    `active` back to `false`.
- Live: re-run Globe3 trace 1 (`"i need sales report 2010"`) against
  the next build with `disabledActions` matching their production
  list. Expected: `runState.invalidActionConvergence.active` flips
  true by cycle 3-4; planner prompt then surfaces the available ERP
  skills; flash-lite picks `execute_skill_tool` against
  `sales-report` or `report-catalog` and the run terminates with a
  real answer.
