# Todo Task Lifecycle

## Purpose

TodoState is the planner-owned plan. Todo Task Lifecycle is the host-facing projection of that plan for UI, recovery, cancellation, and audit.

It is read-only. It must not advance TodoState, create synthetic user messages, or infer work completion from UI state.

## Contract

`projectTodoTaskLifecycle(runState)` returns `null` when no structured TodoState exists. Otherwise it returns:

```ts
{
  taskId: "todo-task:<threadId>:<todoStateId>",
  todoStateId: string,
  threadId: string,
  runId: string | null,
  status: "running" | "paused" | "blocked" | "completed" | "abandoned",
  reason: "continuation_required" | "pending_approval" | null,
  goal: string | null,
  activeItemId: string | null,
  activeItemLabel: string | null,
  activePosition: number | null,
  counts: {
    total: number,
    pending: number,
    active: number,
    done: number,
    blocked: number,
    abandoned: number
  },
  canContinue: boolean,
  canCancel: boolean,
  version: number,
  updatedAt: number | null
}
```

## Status Rules

- `completed`: `todoState.status === "completed"`.
- `abandoned`: `todoState.status === "abandoned"`.
- `paused`: runtime ended with `continuation_required` / `max_steps_continuation`.
- `blocked`: pending approval exists, or blocked items exist with no active item.
- `running`: active structured TodoState is in progress.

## UI Rules

- Show task progress only when lifecycle exists and is relevant.
- If the developer detail setting is off, still show a compact progress bar while a TodoTask is running, paused, or blocked.
- Keep the compact bar in the same bottom position on desktop and mobile so users do not confuse it with a permanent side rail.
- Use the detailed side/sheet panel only when the user expands it or the developer detail setting is on.
- When `canContinue === true`, the browser host should auto-resume the existing TodoTask/TodoState as a host action.
- Auto-resume must not add a visible `"continue"` bubble to the transcript.
- Auto-resume must be bounded per session so a broken task cannot loop forever.
- Show `Stop` during an active run when `canCancel === true` and the host has an in-flight `AbortController`.
- Do not mark a paused TodoState abandoned by editing UI state. Use the runtime `todo_cancel` action.
- Do not show internal todo checklist in assistant prose.
- Do not submit `continue` as a chat message.

## Final Synthesis Rule

When the last active TodoState item is a synthesis / final report / answer item and the planner attempts to finalize, the runtime may complete that final item through the TodoState transition table before generating the final answer. This avoids leaving a finished answer stuck behind an active "write final report" item while still preventing generic tools from marking evidence-gathering work done.

## Cancel Contract

`todo_cancel` is the only structured runtime mutation for abandoning a TodoState.

Rules:

- Requires an existing TodoState.
- Moves unfinished items (`pending`, `active`, `blocked`) to `abandoned`.
- Preserves completed items as `done`.
- Clears `activeItemId`.
- Sets plan status to `abandoned`.
- Is idempotent when the plan is already abandoned.
- Rejects completed plans so history is not rewritten.

Host UI may expose cancel/abandon affordances, but the state change must flow through `todo_cancel` or an equivalent runtime call that delegates to `applyTodoCancel`.

## Browser Host Wiring

The browser example exposes two separate affordances:

- `Stop`: visible only during an active in-flight run; it aborts the current request.
- `Abandon`: visible only when the runtime is idle and `todoTask.canCancel === true`; it persists an abandoned TodoState through the runtime cancel adapter.

`Abandon` does not submit `continue`, does not call the LLM, and does not mutate the panel cache directly. The browser adapter opens the agrun session record, applies `applyTodoCancel`, saves the thread-scoped TodoState through the session store CAS path, and projects a fresh `todoTask` snapshot for the UI.

## Open WebUI Lesson

Open WebUI separates generation, task ids, socket status events, cancellation, and queued user prompts. agrun should follow that boundary: progress is event/state driven; continuation is a host task action, not a fake user prompt.

## Next Extension

The next layer should add lifecycle events:

- `task_started`
- `task_updated`
- `task_paused`
- `task_blocked`
- `task_completed`
- `task_cancel_requested`
- `task_cancelled`

These should be emitted from runtime state changes, not parsed from model prose.

## Debugging

### Live event stream (`onStep`)

Mutation and guard events flow through the existing `onStep` callback that hosts already pass to `runtime.run()`. Filter by step type prefix to capture TodoState activity without subscribing to a new channel:

```js
runtime.run(input, {
  onStep: (step) => {
    if (step.type === "todo-state-mutated") {
      // detail: { action, activeItemId, itemCount, status, version, ... }
      console.log("[todo]", step.detail.action, step.detail);
    } else if (step.type.startsWith("todo-") || step.type === "before-finalize-veto") {
      console.log("[todo-guard]", step.type, step.detail);
    }
  }
});
```

Step types currently emitted:

| Step type | Source | Meaning |
|---|---|---|
| `todo-state-mutated` | mutation handlers | A todo plan/advance/cancel/run_next succeeded; detail summarizes the new state and the delta |
| `todo-plan-required-before-tools` | `maybeCreateTodoPlanRequiredGuard` | Planner tried to call a tool before issuing `todo_plan` for a todo-shaped task |
| `todo-inspect-loop-vetoed` | `maybeCreateTodoInspectLoopGuard` | Planner repeated `todo_inspect` past the configured cap and was redirected |
| `todo-plan-items-truncated` | `executeTodoPlanAction` | Planner emitted more items than `runtimeConfig.todoAutopilot.maxItems` allowed |
| `before-finalize-veto` | `applyBeforeFinalizeVeto` | Some pre-finalize guard (autopilot, citation coverage, research coverage, response quality) blocked the finalize attempt; check `detail.observation` for the reason text |

### On-demand inspector (`inspectTodoState`)

For a structured snapshot at any point, import the read-only inspector:

```js
import { inspectTodoState } from "agrun";

const dump = inspectTodoState(runState, { steps: result.steps, eventLimit: 20 });
// dump = {
//   present:    boolean,
//   state:      TodoState | null,                 // raw state
//   summary:    { itemCount, byStatus, activeItemId, status, version, goal },
//   invariants: { singleActiveOk, activeIdMatches, allTransitionsLegal, violations },
//   guardState: { autopilot, inspectLoop, planRequired, citationCoverage, researchCoverage, finalQuality },
//   recentEvents: Step[]                          // last N todo-related events from steps
// }
```

The inspector is pure — calling it never mutates `runState`. Use it from devtools console, host UI panels, or test assertions. The `invariants` block flags the kind of bugs that used to require manual state diff: a stale `activeItemId`, two simultaneous active items, an unknown status value.

### Public constants

`TODO_STATE_CONSTANTS` is exported from `agrun` for code that needs to reason about valid statuses and transitions without re-deriving the table:

```js
import { TODO_STATE_CONSTANTS } from "agrun";

TODO_STATE_CONSTANTS.STATUSES;                  // ["active", "completed", "abandoned"]
TODO_STATE_CONSTANTS.ITEM_STATUSES;             // ["pending", "active", "done", "blocked", "abandoned"]
TODO_STATE_CONSTANTS.NOTE_KINDS;                // ["progress", "replan", "block"]
TODO_STATE_CONSTANTS.ALLOWED_ITEM_TRANSITIONS;  // status → allowed next-status[] table
```
