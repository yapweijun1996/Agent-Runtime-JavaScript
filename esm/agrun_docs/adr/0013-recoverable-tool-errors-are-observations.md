# ADR 0013: Recoverable tool errors are observations, not exceptions (AGRUN-238)

## Context

agrun.js is an AI-first agent runtime. The OODAE loop is supposed to let
the AI (planner) react to every observable state change in the tool
surface — including tool errors — and pick the next action. Until this
ADR, the action loop had a 3-way fatality split that contradicted that
contract:

1. **Validation catch** (`src/runtime/action-loop-action.js:96-159`) —
   when `validateActionArgs` rejected the planner-emitted args, after
   `selfCorrection.maxRetries` (default 2) self-corrects the run was
   terminated with `ACTION_EXECUTE_ERROR` and `runState.status = "failed"`.
2. **Preflight catch** (`src/runtime/action-loop-action.js:161-241`) —
   when an `action.preflight()` invariant threw, same shape.
3. **Execute catch** (`src/runtime/action-loop-action.js:612-714`) —
   when `await action.execute(...)` threw, same shape.

The three paths each had a copy of the `canSelfCorrect` gate that
incremented `runState.selfCorrectionCount` up to `maxRetries`, and on
the (N+1)th throw called `finalizeActionLoopFailure({code:
ACTION_EXECUTE_ERROR})` which set `runState.status = "failed"` and
ended the run.

In addition, `src/runtime/virtual-workspace.js` had four
input-validation throws that fed into the same fatal path:

- Line 136: `validateWorkspacePath` empty path
- Line 139: `validateWorkspacePath` unsafe path
- Line 264: `insertAfterWorkspaceSection` empty heading
- Line 338: `replaceWorkspaceFile` empty find text

Live evidence:

- **E2E v4** (2026-05-15, `npm run test:live:node-3000`) ended with
  `runStatus: "failed"` after 24 steps with `readOnlyPlanningIgnoredCount=5`,
  showing the harness was steering correctly but one tool throw
  discarded the whole run.
- **E2E v5** captured the exact `runError.code: ACTION_EXECUTE_ERROR`,
  `runError.message: "Action 'workspace_replace' failed during execution."`
  after 51 steps with `candidateWords=1570`, `sourceMinimum.passed=true`
  (3/3 read, 3/2 relevant), `terminalRepairState.active=true` and
  `activeDeficits=["length","structure","todo"]`. The AI was actively
  repairing the candidate; a single stale `workspace_replace` `find`
  string ended an otherwise healthy 51-step run.

This contradicts the project goal stated in `CLAUDE.md`:

> *Do not let runtime do AI work, must always believe and use AI-first
> logic, no hardcode.*

Treating a tool error as a fatal exception is the runtime making the
*"give up"* decision for the AI. The AI never sees the error; never
gets a chance to read fresh state, change args, choose a different
action, or publish a valid `limited` result. The convergence /
terminal-repair / read-only-planning signals all become moot because
the run is already dead.

## Decision

**Recoverable tool errors must surface as AI-observable observations,
not as exceptions that terminate the run.** This applies to:

- Argument validation errors (validation catch)
- Preflight contract violations (preflight catch)
- Action execute throws (execute catch)
- Workspace helper input-validation rejections

Only the following remain fatal:

- **Planner emits an unknown action** (`action-loop-action.js:68-84`,
  `PLANNER_INVALID_ACTION`) — the planner has hallucinated a tool name
  not in the registry; bounded by `maxSteps`.
- **Top-level provider / config errors** — `run-loop.js:91`
  `runState.status = "failed"` for missing API key, unsupported
  provider parameter, prompt budget exceeded; these happen before any
  action execution.
- **Approval denial** — `approval.js:86` keeps its existing fatal
  finalize path; denial is a deliberate user/host choice, not a
  recoverable AI mistake.
- **Planner / session loop / runtime finalize errors** — outside the
  action layer; not in scope.
- **Internal invariants in workspace helpers** — `ensureVirtualWorkspace`
  missing runState (programming error), `executeWorkspacePublishCandidateAction`
  empty publish guard (caught by readiness audit first), and the
  read-before-mutate / staleness preflight gates in
  `virtual-workspace-actions.js:1098, 1103` (these throw *only* in the
  action preflight path, which itself is now non-fatal — so the throws
  surface as `preflight` observations).

### Boundary contract

| Surface | Error kind | Disposition |
|---|---|---|
| `validateActionArgs` returns `{ok:false}` | recoverable | observation with `stage="validation"` |
| `action.preflight()` throws | recoverable | observation with `stage="preflight"` |
| `action.execute()` throws | recoverable | observation with `stage="execute"` |
| `workspace_replace` empty find | recoverable | `{status:"invalid_args"}` observation |
| `workspace_insert_after_section` empty heading | recoverable | `{status:"invalid_args"}` observation |
| `validateWorkspacePath` empty / unsafe | recoverable | `{status:"invalid_args"}` observation |
| `actionRegistry.get(name)` returns null | **fatal** | `PLANNER_INVALID_ACTION` finalize |
| top-level provider / config errors | **fatal** | `run-loop.js` finalize |
| approval denial | **fatal** | `approval.js` finalize |
| caller `AbortError` | **fatal** | caller-abort path (outer catch) |
| Node OOM / process crash | **fatal** | process exit (no catch) |

### Mechanism

A single internal helper `recordRecoverableActionError({stage, ...})`
in `src/runtime/action-loop-action.js` replaces the three copies of
the `canSelfCorrect`/fatal branch:

1. Increments `runState.selfCorrectionCount` (kept as observability
   tally, no longer reads as fatal trigger anywhere).
2. Pushes to `runState.failedTools` (preserves LLM signal via
   `final-response-prompt.js:495`).
3. Pushes to `actionHistory` with `kind: "action_error"`.
4. Sets `runState.observation = { actionName, kind: "error", message,
   stage }`.
5. Calls `refreshActionPattern` with a stage-tagged status so the
   convergence layer can react.
6. From the execute path only, also calls `refreshTerminalRepair`.
7. Returns `{ done: false }` so the action loop continues.

### Convergence signal

A new `convergenceSignal.patternKind: "repeated_action_throw"` in
`src/runtime/action-pattern-convergence.js` fires when the same
`fingerprintAction(decision)` throws `>= DEFAULT_REPEAT_THRESHOLD` (2)
times in a row. The signal carries `forbiddenMove:
"repeat_same_action_args_after_throw"`, `allowedNextMoves:
[read_url, workspace_write, workspace_append, workspace_replace, ...]`,
and a `requiredCorrection` string telling the AI to read fresh state
or pick different args. A single successful (non-error) refresh
resets the `errorRepeatCount` so the signal does not stick after
recovery.

The planner prompt (`src/runtime/planner-prompt.js`) projects the
signal so the AI sees it in the next cycle.

## Consequences

- `runState.status === "failed"` no longer fires from action errors.
  The only run terminators for action-related throws are `maxSteps`
  (planner budget) and explicit caller abort.
- `failedTools` is the canonical AI-visible signal for tool failures.
  It is populated on every recoverable error (all three stages) and is
  surfaced via `final-response-prompt.js:495` `buildFailedToolsBlock`.
- Existing convergence signals (`transitional_only_progress`,
  `read_only_planning_active`, `structure_repair_micro_loop`,
  `repeated_action_throw`, `semantic_terminal`, `exact_action`,
  `terminalCorrectionState`, `terminalRetryCooldown`) carry the recovery
  guidance. The runtime never picks the AI's next action.
- `runState.selfCorrectionCount` is preserved but loses its fatal-gate
  role. Hosts that previously read it as "approaching failure" should
  switch to `runState.actionPatternConvergence.errorRepeatCount` or
  `failedTools.length` for a structured equivalent.
- The 12 pre-existing `runState.status === "failed"` assertions in
  `test/concerns/**` are non-action-throw paths (provider config,
  memory budget, approval denial, top-level errors) and remain green.
- The legacy skill-router `SKILL_EXECUTE_ERROR` fatal path
  (`run-skill-loop.js`, exercised by `test/concerns/runtime-basic.test.js:96`
  and `test/concerns/memory.test.js:169`) is *outside* the action loop
  and stays fatal. Skills are deterministic host code, not AI-driven
  tool calls; that abstraction layer keeps its existing contract.

## Risks

- **`failedTools` array growth on long runs** — bounded by `maxSteps`
  (~50–100), and each entry is a 4-field object, so memory cost is
  negligible. If a future host wants to cap the array, do it via a
  ring-buffer in `failedTools` push, not by re-introducing a fatal
  cap.
- **Hosts that depended on fast `runState.status="failed"` for early
  abort** — there is no such known consumer in this repo; browser
  example consumes `failedTools` and convergence signals via Inspector
  panels. If a host wants early abort on N action errors, it can
  inspect `failedTools.length` and call `runtime.abort()` from its own
  policy layer.
- **AI confusion from non-fatal repeated errors** — mitigated by the
  new `repeated_action_throw` convergence signal in the planner prompt.
  Live e2e is the final gate on whether the AI converges; if not,
  follow-up work tunes the prompt copy, not the runtime fatality.

## Verification

For this ADR:

- `node test/unit/virtual-workspace.test.js` — 3 new invalid_args cases
  green plus all existing.
- `node test/unit/action-pattern-convergence.test.js` — 2 new
  `repeated_action_throw` cases green plus all existing.
- `node test/smoke.test.js` — full smoke regression green; 12
  pre-existing `runState.status === "failed"` assertions remain green
  (non-action-throw paths).
- `npm run build:lib` — dist rebuild green.
- `npm run test:live:node-3000` — v6 e2e produces
  `runStatus === "completed"` (or at worst `terminalizedBy ===
  "max_steps_continuation"`), never `"failed"`, for the same prompt
  that v4/v5 failed on.
- `git grep -n "finalizeActionLoopFailure({.*ACTION_EXECUTE_ERROR" src/runtime/`
  returns zero hits after Phase B.

## References

- AGRUN-236: Transitional vs productive progress classification —
  the harness *observation* layer fix.
- AGRUN-237: `readOnlyPlanningState` stickiness + structure repair
  convergence signals.
- AGRUN-238: This ADR's implementation. Closes the patch chain by
  fixing the *exception* layer.
- ADR-0012: Long-research belongs to agent skill, not runtime —
  precedent for "policy in prompt, mechanism in runtime".
- ADR-0015: Virtual workspace as AI scratchpad — input contract
  for workspace mutators.
