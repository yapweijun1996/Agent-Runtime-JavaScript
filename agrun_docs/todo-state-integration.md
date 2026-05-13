# TodoState Integration Guide

How a host application enables, configures, observes, and overrides the structured TodoState subsystem (AGRUN-212a). This is the **integration contract** — for the architectural rationale and locked schema, see [agrun_docs/adr/0010-todo-state.md](./adr/0010-todo-state.md).

> **TL;DR** — TodoState is **opt-in** and **disabled by default**. To turn it on, pass `todoAutopilot: { enabled: true }` to `createRuntime`. The runtime then exposes five planner-visible actions (`todo_plan` / `todo_advance` / `todo_cancel` / `todo_run_next` / `todo_inspect`), enforces a single-active-item invariant, persists state per thread, and emits a stream of `todo-*` `onStep` events for host observation.

## Table of Contents

- [When to use TodoState](#when-to-use-todostate)
- [Quick start (minimum wiring)](#quick-start-minimum-wiring)
- [Configuration knobs](#configuration-knobs)
- [The five planner actions](#the-five-planner-actions)
- [State shape](#state-shape)
- [Persistence and threads](#persistence-and-threads)
- [Observability — `onStep` events](#observability--onstep-events)
- [Debug helper — `inspectTodoState`](#debug-helper--inspecttodostate)
- [Customising LLM-facing strings (`promptStrings`)](#customising-llm-facing-strings-promptstrings)
- [Customising regex policies](#customising-regex-policies)
- [Common integration recipes](#common-integration-recipes)
- [Troubleshooting](#troubleshooting)

---

## When to use TodoState

Turn it on when **any** of the following apply:

- Tasks routinely take 3+ planner cycles.
- The agent must survive context compaction (long sessions).
- The host UI wants a structured progress view, not a parsed prose checklist.
- The agent has a tendency to "drift" — finalise too early, forget mid-task, or replan in a way that loses prior work.

Skip it if every task in your product completes in 1–2 cycles. The autopilot vetoes are noise for trivial flows.

## Quick start (minimum wiring)

```js
import { createRuntime } from "agrun";

const runtime = createRuntime({
  skills: [/* ... */],
  todoAutopilot: { enabled: true }
});

const result = await runtime.run("Research X and write a 200-word brief", {
  onStep: (step) => {
    if (step.type.startsWith("todo-")) console.log(step.type, step.detail);
  }
});
```

That is the entire baseline. The planner now sees the five actions, the runtime injects an `ACTIVE TODO PLAN` block into every cycle, and host code receives mutation events.

## Configuration knobs

All knobs live under `runtimeConfig.todoAutopilot`. They are read by `normalizeTodoAutopilotConfig` ([src/runtime/todo-autopilot.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-autopilot.js)) — anything not listed here is ignored.

| Key | Default | Type | Effect |
|-----|---------|------|--------|
| `enabled` | `false` | boolean | Master switch. `false` disables planner-visible actions, the prompt block, vetoes, and events. |
| `autostart` | `false` | boolean | Inject a one-item planning placeholder when the planner has not yet called `todo_plan`. Off by default — the placeholder is a stability backstop while a host's planner prompt is still maturing. |
| `maxItems` | `10` | int (>0) | Items are truncated to this length on `todo_plan`; emits `todo-plan-items-truncated`. |
| `maxVetoes` | `6` (`GUARD_MAX_VETOES`) | int (>0) | Soft cap on consecutive non-required autopilot vetoes per task. Required-completion vetoes use `maxRequiredCompletionVetoes`. |
| `maxRequiredCompletionVetoes` | `6` (`GUARD_MAX_VETOES`) | int (>0) | Cap on repeated `requireCompletion: true` finalize vetoes. When the cap is reached and the veto has no existing redirect, the runtime returns a deterministic `todo_run_next` redirect instead of pure-blocking another finalize cycle. |
| `maxConsecutiveInspects` | `1` | int (>0) | Cap on consecutive `todo_inspect` calls before the runtime vetoes with a redirect. |
| `finalizationPattern` | `/synthesi[sz]e\|summari[sz]e\|finali[sz]e\|write\|answer\|present\|deliver\|report\|output/i` | RegExp \| string \| `null` | Detects "the active item is the final-synthesis step" so finalize is allowed. `null` disables the heuristic. |
| `verificationPattern` | `/verif…\|test\|check\|validat…\|qa\|smoke\|regression\|e2e/i` | RegExp \| string \| `null` | Triggers the verifier-nudge when a 3+ item plan completes without any matching item. `null` disables the nudge. |
| `actionProgressRules` | see [src/runtime/todo-autopilot-rules.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-autopilot-rules.js) | `{ [actionName]: { allow, block } }` | Per-action allow/block regex pairs that gate progress on substantive work actions such as `web_search`, `read_url`, `workspace_write`, `workspace_append`, `workspace_insert_after_section`, `workspace_replace`, and `workspace_finalize_candidate` against the active item label. Pass `null`/`false` for an action key to disable its rule entirely. |
| `promptStrings` | see [src/runtime/todo-prompt-strings.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-prompt-strings.js) | object | Deep-merge override of the prompt block + autopilot veto wording. See [Customising LLM-facing strings](#customising-llm-facing-strings-promptstrings). |

String regex values are compiled with the `i` flag. Empty strings, malformed regex, and non-string values fall back to the default — they do **not** throw.

## The five planner actions

All five are registered as `tier: 0` (auto-allow) and return `control: "continue"` so the planner can chain them in one cycle (e.g. `todo_plan` then `todo_advance`).

| Action | Mutation | Typical use |
|--------|----------|-------------|
| `todo_plan` | Replace items (or merge with completed history if `merge: true`); set `activeItemId`. | Initial plan; replan when evidence shifts the goal. |
| `todo_advance` | Flip a single item's `status` to `pending` / `active` / `done` / `blocked` / `abandoned`; optionally attach a note. | Mark progress on one item without disturbing others. |
| `todo_run_next` | Mark the active item `done`, promote the next pending item, OR — if no pending — close the plan as `completed`. | The 80% path: "this work unit is finished, what's next". |
| `todo_cancel` | Flip every unfinished item to `abandoned`; set plan `status: "abandoned"`. | User cancels; host requests abandonment; task is unsafe to continue. |
| `todo_inspect` | None (read-only). | Rare diagnostic call; capped at `maxConsecutiveInspects` to prevent loops. |

### Args examples

```js
// todo_plan
{
  goal: "Research Singapore AI safety regulations 2026",
  items: [
    { id: "i-1", label: "Search MAS / IMDA announcements" },
    { id: "i-2", label: "Read top-3 source articles" },
    { id: "i-3", label: "Verify cross-reference against official PDF" },
    { id: "i-4", label: "Synthesize 200-word brief" }
  ],
  activeItemId: "i-1",
  merge: false
}

// todo_advance
{ itemId: "i-2", nextStatus: "done", note: "completed via read_url" }

// todo_run_next
{ note: "completed this work unit" }

// todo_cancel
{ reason: "user cancelled the long-running task" }

// todo_inspect
{}
```

### Allowed status transitions

The state machine is locked by ADR-0010. Transitions outside this table throw at `applyTodoAdvance` time:

```
pending   → active | done | blocked | abandoned
active    → pending | done | blocked | abandoned
done      → pending | active | abandoned
blocked   → pending | active | done | abandoned
abandoned → pending | active
```

`done → blocked` is intentionally rejected — once an item is "done", returning it to "blocked" without going via `pending` or `active` is almost always a logic error.

## State shape

Importable as `TODO_STATE_CONSTANTS` from the package root:

```js
import { TODO_STATE_CONSTANTS } from "agrun";

TODO_STATE_CONSTANTS.STATUSES;                // ["active", "completed", "abandoned"]
TODO_STATE_CONSTANTS.ITEM_STATUSES;           // ["pending", "active", "done", "blocked", "abandoned"]
TODO_STATE_CONSTANTS.NOTE_KINDS;              // ["progress", "replan", "block"]
TODO_STATE_CONSTANTS.ALLOWED_ITEM_TRANSITIONS;
```

The full schema (also documented in `src/runtime/todo-state.js`):

```ts
type TodoState = {
  id:           string;        // stable per-thread plan id
  goal:         string;        // user-facing anchor (free text)
  items:        TodoItem[];    // order = array index, no priority
  activeItemId: string | null; // points into items[].id; at most one
  status:       "active" | "completed" | "abandoned";
  createdAt:    number;
  updatedAt:    number;
  version:      number;        // CAS token, bumped per mutation
};

type TodoItem = {
  id:          string;
  label:       string;
  status:      "pending" | "active" | "done" | "blocked" | "abandoned";
  notes?:      Array<{ at: number; kind: "progress" | "replan" | "block"; text: string }>;
  _provenance: { threadId: string; turnId: string | null } | null;
};
```

## Persistence and threads

- `runState.todoState` is the per-turn snapshot.
- After every turn, the runtime writes the snapshot back to `sessionRecord.threads[i].todoState` via the AGRUN-206 CAS-protected `sessionStore.saveSession` path. There is **no separate persistence API** — TodoState rides the surrounding session record.
- TodoState is **per thread**. When the topic router decides to bump to a new thread (AGRUN-144), the new thread starts with no plan; the previous thread's plan is preserved in its slot.
- Compaction is TodoState-aware (AGRUN-145): the structured plan is not summarized into prose, so a long session does not lose its task breakdown.

## Observability — `onStep` events

All TodoState events are step types prefixed with `todo-` plus the special `before-finalize-veto` (which the autopilot also fires for non-todo finalize blocks).

| Event | Emitted from | Detail (key fields) |
|-------|--------------|---------------------|
| `todo-state-mutated` | every successful action | `action`, `itemCount`, `activeItemId`, `status`, `version` |
| `todo-plan-items-truncated` | `todo_plan` when `items.length > maxItems` | `requested`, `truncatedTo` |
| `todo-plan-goal-anchored` | `todo_plan` when planner omitted `goal` and recovery kicked in | `recoveredFrom`, `goal` |
| `todo-plan-verifier-nudge` | `todo_run_next` on transition to `completed` with no verify-keyword item (3+ items) | `itemCount`, `reason` |
| `todo-autopilot-autostarted` | session loop on first cycle when `autostart: true` and no plan exists | `placeholder` shape |
| `todo-autopilot-plan-seeded` | session loop when the autostart placeholder is upgraded to a real plan | seeding metadata |
| `todo-autopilot-action-progress` | when an action result is gated by `actionProgressRules` | `actionName`, `decision` (`allow`/`block`) |
| `todo-placeholder-plan-required` | autopilot before-action veto: planner must replace the placeholder | `activeLabel` |
| `todo-plan-required-before-tools` | autopilot before-tools veto: long task with no plan yet | reason text |
| `todo-inspect-loop-vetoed` | autopilot when consecutive `todo_inspect` count > `maxConsecutiveInspects` | `consecutive`, `cap` |
| `before-finalize-veto` | autopilot before-finalize redirect or block | `source`, `decision`, `requireCompletion`, `vetoCount`, `requiredCompletionVetoCount`, `maxVetoes`, `maxRequiredCompletionVetoes`, `limitReached`, `remainingCount`, `activeLabel`, `recommendedEscapeAction` |
| `before-finalize-veto-action-skipped` | autopilot redirect was offered but the runtime skipped re-routing | reason |
| `todo-plan-blocked-by-planner-error` | planner crashed mid-plan | `error` |

A typical host observer:

```js
runtime.run(input, {
  onStep: (step) => {
    if (step.type.startsWith("todo-") || step.type === "before-finalize-veto") {
      ui.appendEvent(step);     // your structured progress sidebar
    }
  }
});
```

## Debug helper — `inspectTodoState`

A read-only projection for devtools, tests, or host UIs that want a snapshot without learning the internal field layout.

```js
import { inspectTodoState } from "agrun";

const result = await runtime.run(input);
const dump = inspectTodoState(result.runState, {
  steps: result.steps,    // optional — returns recent todo-* events
  eventLimit: 20          // default
});

dump.present;                     // boolean
dump.summary;                     // { itemCount, byStatus, activeItemId, status, version, goal }
dump.invariants.singleActiveOk;   // boolean
dump.invariants.violations;       // string[] — empty when healthy
dump.guardState.autopilot;        // veto guard counters
dump.recentEvents;                // recent todo-* / before-finalize-veto steps
```

This is the recommended starting point when investigating "why did the agent loop / over-veto / drift" in a session.

## Customising LLM-facing strings (`promptStrings`)

Every string the TodoState subsystem injects into a planner prompt or autopilot veto is sourced from `runtimeConfig.todoAutopilot.promptStrings`. The default catalog lives in [src/runtime/todo-prompt-strings.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-prompt-strings.js); host overrides deep-merge on top.

Two top-level sections:

- `prompt.*` — strings that appear in the per-cycle `ACTIVE TODO PLAN` block.
- `autopilot.*` — strings that appear in pre-action veto observations.

```js
createRuntime({
  todoAutopilot: {
    enabled: true,
    promptStrings: {
      prompt: {
        blockHeader: "TASK PLAN"        // override one string
      },
      autopilot: {
        // Function-shaped overrides receive a named-parameter object
        unfinishedItems: ({ remainingCount, activeLabel }) =>
          `Hold up — ${remainingCount} more steps before we finalise. `
          + `Currently working on: ${activeLabel}.`
      }
    }
  }
});
```

Rules (enforced by `normalizeTodoPromptStrings`):

- Override may supply any subset; missing keys keep the default.
- Strings: override must be a non-empty trimmed string. Empty / non-string values fall back.
- Functions: override must be a function. Non-function values fall back. Strings cannot replace functions (callers depend on the parameter substitution).
- Unknown keys are silently dropped.

The full list of overridable keys is the surface of `DEFAULT_TODO_PROMPT_STRINGS`.

## Customising regex policies

`finalizationPattern`, `verificationPattern`, and `actionProgressRules` accept either a `RegExp` or a string (compiled with `/i`). Pass `null` to disable.

```js
createRuntime({
  todoAutopilot: {
    enabled: true,
    // Match your task vocabulary — e.g. "compose" / "draft" instead of "write".
    finalizationPattern: /\b(compose|draft|publish|finali[sz]e)\b/i,
    // Disable the verifier-nudge entirely if your domain has no test/verify concept.
    verificationPattern: null,
    // Tighten read_url progress matching for a research-only product.
    actionProgressRules: {
      read_url: {
        allow: /\b(read|source|cite|reference)\b/i,
        block: /\b(write|publish|email)\b/i
      },
      web_search: null   // disable the rule for web_search
    }
  }
});
```

## Common integration recipes

### Render a structured progress sidebar

```js
runtime.run(input, {
  onStep: (step) => {
    if (step.type === "todo-state-mutated") {
      // step.detail.todoState lives on the runState; query it here:
      ui.renderTodos(runtime.session.getThread()?.todoState);
    }
  }
});
```

For most hosts the cleaner pattern is to read `result.runState.todoState` after `runtime.run` resolves and re-render once. The mutation event is for live-streaming UIs.

Terminal TodoState snapshots are audit records, not active plans. When a
snapshot contains `terminatedAt`, preserve it for Inspector/debug visibility,
but render it as a completed or ended progress summary in end-user UI. Do not
show active-step controls such as "Abandon", and do not feed that snapshot back
into the next planner prompt. If the host needs to display the plan goal to an
end user, keep the raw `goal` for runtime/debug contracts and render a separate
clean `displayGoal` that removes internal skill/workspace hints and exact
sentinel suffix instructions.

### Disable the verifier-nudge for trivial-task products

```js
createRuntime({
  todoAutopilot: { enabled: true, verificationPattern: null }
});
```

### Tighten the inspect cap to zero

```js
createRuntime({
  todoAutopilot: { enabled: true, maxConsecutiveInspects: 1 }
});
```

(Default is already `1`; pass a higher integer if your planner genuinely needs repeat inspects.)

### Localize the planner-facing prompt

```js
createRuntime({
  todoAutopilot: {
    enabled: true,
    promptStrings: {
      prompt: {
        blockHeader: "任务计划",
        blockFooter: "完成当前活动项的实际工作后,再调用 todo_advance / todo_run_next。"
      }
    }
  }
});
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Planner ignores TodoState; never calls `todo_plan` | `enabled: false` (default) | Set `todoAutopilot: { enabled: true }`. |
| `todo_inspect` fires repeatedly | Planner treats it as routine introspection | Default cap of 1 already vetoes. If you raised the cap, lower it back. |
| `before-finalize-veto` repeats every cycle | Plan has unfinished items + repeated `requireCompletion: true` vetoes | Check `requiredCompletionVetoCount`, `maxRequiredCompletionVetoes`, and `limitReached` in the `before-finalize-veto` step. Evidence-exhausted cases redirect immediately via `runState.autoReadStoppedReason`; other pure-block required-completion loops redirect to `todo_run_next` after the required-completion cap. |
| Items truncated unexpectedly | `items.length > maxItems` | Raise `maxItems` or reduce plan granularity. Watch for `todo-plan-items-truncated` in `onStep`. |
| Verifier-nudge never fires | Plan has fewer than 3 items, or some item label/note matches `verificationPattern` | Working as designed. Trivial plans skip the nudge. |
| Verifier-nudge fires on every short plan | You raised `VERIFIER_NUDGE_MIN_ITEMS` or pattern is too narrow | Restore default verification pattern, or set `verificationPattern: null` to disable. |
| Plan disappears between turns | TodoState is per-thread; the topic router bumped to a new thread | Inspect `sessionRecord.threads[*].todoState` to find the original plan; tune `topicRouter` if bumps are spurious. |
| Override prompt string ignored | Override was empty / wrong type / replaced a function with a string | See [Customising LLM-facing strings](#customising-llm-facing-strings-promptstrings) — overrides silently fall back to defaults on type mismatch. |

For deeper architectural questions:

- Schema rationale and amendments: [agrun_docs/adr/0010-todo-state.md](./adr/0010-todo-state.md).
- How TodoState interacts with compaction and threading: [agrun_docs/context-and-continuity-model.md](./context-and-continuity-model.md).
- Underlying runtime state pipeline: [agrun_docs/runtime-internal-architecture.md](./runtime-internal-architecture.md).
