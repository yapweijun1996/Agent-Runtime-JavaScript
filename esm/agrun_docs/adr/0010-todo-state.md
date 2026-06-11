# ADR 0010: TodoState runtime harness

## Context

AGRUN-211 added a browser Todo Progress panel that builds its view by
extracting "todo list / current status / next step" sections from
assistant prose. That works as a UI bridge but cannot be the
production harness for long-running tasks: prose is non-deterministic,
prose-extracted state cannot survive thread compaction, and concurrent
edits silently overwrite each other.

AGRUN-212a converts long-task progression into a structured runtime
state — `TodoState` — that the planner mutates explicitly, the
session store persists, and the UI consumes directly. This ADR locks
the schema and the surrounding contracts so future refactors do not
quietly drift.

Affected surfaces:
- `src/runtime/todo-state.js` (schema + transitions)
- `src/runtime/todo-state-prompt.js` (per-cycle prompt block)
- `src/runtime/run-state-thread.js` (hydration of `runState.todoState`)
- `src/runtime/actions/todo-actions.js` (planner-visible actions)
- `src/runtime/action-registry.js` (registration)
- `src/session/thread.js` (per-thread persistence field)
- `src/session/handle.js` (end-of-turn write-back)
- `src/runtime/todo-task-lifecycle.js` (host-facing lifecycle projection)
- `src/runtime/thread-provenance.js` (compaction-trim exemption)
- `examples/browser/src/runtime/todo-progress.ts` (UI consumer)

## Decision

### Schema (locked, 5 fields on state, 5 on item)

```ts
TodoState = {
  id:            string         // stable per-thread plan id
  goal:          string         // user-facing anchor (free text)
  items:         TodoItem[]     // order = array index, no priority
  activeItemId:  string | null  // single item; at most one `active`
  status:        "active" | "completed" | "abandoned"
  createdAt:     number
  updatedAt:     number
  version:       number         // CAS token, bumped per mutation
}

TodoItem = {
  id:           string
  label:        string
  status:       "pending" | "active" | "done" | "blocked" | "abandoned"
  notes?:       Array<{ at: number, kind: "progress"|"replan"|"block", text: string }>
  _provenance:  { threadId, turnId } | null  // AGRUN-145 reuse
}
```

Explicitly rejected from MVP:
- `dependencies: string[]` (DAG complexity → AGRUN-212b).
- `priority: number` / explicit `order` field (list index is authoritative).
- Cross-thread plan refs (deferred to AGRUN-212b).
- Automatic completion rules in `evaluate` (the planner LLM owns
  every transition; no hardcoded "if action == 'web_search' → mark
  done" shortcuts).

### Persistence

- TodoState lives at `sessionRecord.threads[i].todoState`.
  Thread-scoped because AGRUN-144 already established `thread = task
  unit`. One session, multiple threads, multiple plans — switching
  threads switches plans without leakage.
- Persistence rides `sessionStore.saveSession(record)`. There is no
  separate `saveTodoState` API, no separate object store, no separate
  CAS contract. AGRUN-206's `version` token on the surrounding
  `sessionRecord` protects nested mutations automatically.
- `runState.todoState` is a per-turn snapshot. Hydrated via
  `hydrateRunStateWithThread` from the active thread; written back to
  `sessionRecord.threads[i].todoState` by id match in handle.js after
  the action loop, before saveSession.
- `createThread()` defaults the field to `null`. Legacy threads (saved
  before AGRUN-212a) hydrate cleanly without a migration step.

### Mutation discipline

Two and only two functions mutate state:
- `applyTodoPlan(state, plan)` — full plan replacement (the
  `todo_plan` action). Preserves `id` + `createdAt`; bumps `version`;
  drops stale `activeItemId` so callers must explicitly point it at a
  surviving item; stamps `replan` notes when supplied.
- `applyTodoAdvance(state, advance)` — single-item status flip
  (the `todo_advance` action). Enforces the `ALLOWED_ITEM_TRANSITIONS`
  table; promoting an item to `active` automatically demotes the
  previously-active item to `pending`; clears `activeItemId` when the
  active item moves off `active`.

Direct field mutation (`state.items[i].status = ...`) is forbidden.
Helpers throw on invalid transitions rather than silently coerce.

### Action surface (3, not 5)

- `todo_plan({ goal, items, activeItemId, note })` — create or replace.
- `todo_advance({ itemId, nextStatus, note })` — flip one item.
- `todo_inspect()` — read-only deep-clone snapshot for the planner
  when the windowed prompt summary is not enough.

Rejected:
- `todo_create` / `todo_complete` / `todo_update` / `todo_get_current`
  — all subsumed by the three above. Planner schema-selection cost
  scales with action count; three is the ceiling unless a new
  semantic verb (not a synonym) appears.

### Token budget on prompt injection

`buildTodoStateBlockForCycle(runState)` (in `todo-state-prompt.js`)
emits the planner-prompt block for the cycle. Hard contract:

- Always show the active item plus ±2 surrounding items (5 visible).
- Surface `omittedBefore` / `omittedAfter` counts so the planner sees
  scale without the items themselves.
- Empty string when `runState.todoState` is null or itemless — no
  placeholder text inflating short turns.
- Full-plan dumps are reachable via `todo_inspect`, never via the
  per-cycle prompt block.

The block size MUST stay under ~1500 chars across plan lengths from
5 to 500 items. Regression test:
[test/unit/todo-state-prompt-budget.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/todo-state-prompt-budget.test.js).

### Compaction exemption

TodoState is exempt from thread-compaction window trim. Rationale: the
plan is the active-task truth source; folding it into a summary loses
item ids, statuses, and notes that the planner needs the next turn.

Implementation: `trimRunStateForThreadWindow` carries an explicit
inline note that `runState.todoState` is intentionally left
untouched. Compaction works on messages and writes a separate
summaries store; it does not (and must not) mutate
`sessionRecord.threads[i].todoState`. Regression test:
[test/unit/todo-state-compaction.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/todo-state-compaction.test.js).

### Browser UI contract

`buildTodoProgressSnapshot(messages, agentState, todoState?)` accepts
the structured TodoState as a third argument. When present and non-
empty, the panel renders from it with `source: 'structured'`. When
absent or itemless, the AGRUN-211 prose parser builds the snapshot
with `source: 'prose'` — backwards compatible with existing legacy
sessions.

Runtime status mapping onto the panel's three buckets:
- `done` → `done`
- `active` → `active`
- `pending`, `blocked`, `abandoned` → `pending`

When the panel grows distinct rendering for `blocked` / `abandoned`,
that mapping is the only place to update.

### Wire-format type duplication

`examples/browser/src/runtime/todo-progress.ts` declares its own
minimal `RuntimeTodoState` interface that mirrors the runtime shape
without importing it. The browser example must run standalone against
`dist/agrun.js`, so the runtime module is not directly importable.
Treat that interface as wire format: any change to the runtime schema
MUST update the browser interface in the same PR.

## Alternatives

1. **Cross-runtime CAS token specific to TodoState.** Rejected — adds
   a second concurrency contract. AGRUN-206 already CAS-protects the
   surrounding sessionRecord, which is a strict superset.
2. **Independent IndexedDB object store for TodoState.** Rejected —
   compounds persistence complexity and breaks "one session record =
   one transactional unit". The current `threads[i].todoState`
   embedding rides existing serialization.
3. **5 actions including `todo_create` / `todo_complete`.** Rejected
   — synonyms inflate planner schema-selection cost without adding
   semantic distinctions.
4. **Schema with `dependencies` and `priority` from day one.** Rejected
   — DAG cycle detection, topological sorting, and priority rebalancing
   blow up the MVP scope. Deferred to AGRUN-212b once 212a runs in
   production for one cycle.
5. **Strip-and-reattach during compaction.** Initial scope assumed
   thread compaction would mangle TodoState. Code review showed
   compaction never touches thread records — it operates on messages
   and the separate summaries store. Replaced "strip and reattach"
   with "regression test that proves no mutation".

## Consequences

Pros:
- Long tasks survive session reopen, multi-tab edits, and thread
  compaction without losing the plan.
- Three actions are easy for the LLM to discriminate; the planner
  prompt grows by O(1) per cycle, not O(plan_length).
- Reuses every harness laid by AGRUN-201..206: turn ordering, run
  identity, IndexedDB schema, session CAS. No new persistence
  primitive.
- ADR-locked schema means a future contributor cannot quietly add a
  field that pulls the system back toward AGRUN-211's prose mush.

Cons:
- The browser interface is a hand-maintained mirror, not a generated
  type. Drift risk if the runtime schema changes silently.
- Three actions are still three more actions in the planner's choice
  set. For very short turns where no plan is needed, those slots
  consume schema budget. Mitigated by the per-cycle prompt block
  emitting nothing when `todoState` is null.
- The 5-state → 3-bucket UI collapse hides `blocked` / `abandoned`
  from the panel until the UI is enriched.

Risks:
- Failure path (`handlePreparedSessionError`) does NOT write back
  TodoState mutations. If a planner that called `todo_plan` then hit
  an approval / clarification error, the plan would not persist. Low
  risk in practice (mutations require a successful action loop), but
  documented here so debugging that case is easier.
- Multi-tab race against `sessionRecord.version` will surface as
  `SessionVersionConflictError` from saveSession. The retry harness
  AGRUN-206 built for run-id generation does NOT yet wrap the
  end-of-turn save path. Worst case: one tab loses a turn and must
  retry. Acceptable for MVP; promote to AGRUN-212b if production
  traffic shows this matters.

## Rollback

- All AGRUN-212a changes ship as additive — no existing data path is
  rewritten. Reverting the seven feat commits (Phases A-F + smoke)
  restores the AGRUN-211 prose-only behavior. Persisted TodoState
  fields on sessionRecord.threads[i].todoState are silently ignored
  by older builds because every reader normalizes through
  `normalizeThread`, which simply drops unknown fields.
- Removing this ADR slot from AGRUN-121's checklist is the final
  step of a rollback so the missing-ADR sweep does not re-spawn it.

---

## Amendment 2026-04-26 — TodoState is internal; auto-progression via `todo_run_next`

Two corrections to the original ADR after dogfooding the framework:

### 2A. Plan is internal agent state, NOT user-facing by default

The original "UI contract" section described the browser Todo
panel as the canonical surface for TodoState. That framing was
wrong: most end-user UIs (chatbox, FAQ assistant, customer
support) should NEVER show the agent's internal todo list to
users. The plan is implementation detail, not product feature.

Decision:
- The library exposes structured TodoState data (unchanged).
- The browser example's `TodoProgressPanel` is now gated behind
  `settings.showTaskProgress` (default **false**).
- Hosts that want plan transparency (research tools, dev
  inspectors, IDE-style agents) opt in explicitly.
- Hosts that want a clean answer-only UX get it for free.

The original "prefer structured TodoState first" contract on
`buildTodoProgressSnapshot` is unchanged — when `todoState` is
supplied, structured wins over prose. What changed is the
*default visibility* of the panel itself.

### 2B. `todo_run_next` action — automatic next-pending promotion

The original ADR rejected "automatic completion rule" as a
hardcoded shortcut around the planner LLM. That rejection is
correct and stands — completion judgment is semantic, the LLM
must own it.

But the original also implicitly required the LLM to manually
compute "which is the next pending item" via `todo_inspect` +
hand-rolled selection. This is data lookup, not judgment, and
forcing it through the LLM wastes tokens for no decision value.

Decision: add a fourth action `todo_run_next` that:
- Marks the currently-active item as `done` (if any).
- Promotes the first remaining `pending` item to `active`.
- Returns the new active item id, or `null` if the plan is
  complete.

This is **data query, not LLM judgment** — runtime knows the
list order and can compute "next pending" deterministically.
The LLM still decides:
- WHEN to call `todo_run_next` (after finishing the current
  step's substantive work).
- WHEN the plan is done (when `todo_run_next` returns null).
- WHEN to replan instead (call `todo_plan` if circumstances
  changed).

The classification:
- "Is the current item done?" → semantic → LLM (via
  `todo_advance` with explicit nextStatus).
- "Which item is pending after this one?" → data → runtime
  (via `todo_run_next`).

This complements rather than replaces `todo_advance`. The
typical autopilot loop becomes:

```
turn 1 (single session.run):
  planner: todo_plan(items=5, active=item-1)
  planner: <work on item-1>
  planner: todo_run_next        // marks done, promotes item-2
  planner: <work on item-2>
  planner: todo_run_next        // marks done, promotes item-3
  ...
  planner: todo_run_next        // returns null — plan complete
  planner: finalize
```

The whole long task can advance within one `session.run()` call,
gated only by AGRUN-141's max-steps composite budget. No
cross-turn user input required for the agent to make progress.

### 2C. Distinction: `todo_advance` still required for non-linear cases

`todo_run_next` covers the common "linear walk through pending
items" case. For non-linear flow (an item turns out to be
blocked, the planner wants to skip ahead, or a previously-done
item needs revisiting) the planner uses `todo_advance` directly
with an explicit `itemId` and `nextStatus`. The two actions are
complementary, not redundant.

### 2D. Per-call provider timeout, elevated when a plan is in flight

Live test (2026-04-26, OpenAI gpt-5-mini) ran `todo_plan` + 5
`todo_run_next` cleanly inside one `session.run()`, persisted
plan v=11 status=completed to IndexedDB, then errored out on the
**finalize call** with "signal timed out" — the assistant was
composing a 5-section comparison table when the provider's
`AbortSignal.timeout(60_000)` fired.

The 60 s default in `fetch-resilience.js::DEFAULT_LLM_TIMEOUT_MS`
is right for short turns. It is wrong for long-output finalize
calls that compact a multi-step research stack into one answer.

**Fix is structural, not a global knob bump:**

- New helper `src/runtime/provider-timeout.js` —
  `deriveProviderTimeoutMs({ runState, kind, baseTimeoutMs })`.
- Returns `null` when no plan is in flight → caller falls
  through to provider default. **No regression for short turns.**
- Returns 120 000 ms for `kind: "planner"` and 180 000 ms for
  `kind: "finalize"` when a TodoState plan exists with at least
  one item (status `active` or `completed`).
- Explicit `request.timeoutMs` always wins (host opt-out path).
- Wired in `runtime-finalize.js` (per-finalize override) and
  `action-loop-planner.js` → `planner.js` (per-cycle override
  applied to all three planner call sites: native_tools,
  envelope, strict_retry).
- Provider layer change: `provider.js::createRequestOptions`
  now honors `overrides.timeoutMs` (previously dropped).

**Why structural, not a flag:**
The signal that "this turn is long-running" is the plan itself.
A plan exists ⇒ the user asked for structured multi-step work
⇒ the answer is likely large. We do not need a separate
`runtimeConfig.autopilotTimeoutMs` knob; the data is already on
`runState.todoState`. Hardcoding a higher global default would
be 补丁思维 — every short turn would pay the longer ceiling.

**UI half:** `ChatWorkspaceComposer` now classifies
`signal timed out` / `TimeoutError` / `AbortError` separately
from hard failures: amber "Response took too long" banner with
"plan progress was persisted — you can resume" hint, instead of
the red "Request failed" panel. Confirms to the user that the
plan in IndexedDB is intact. (Resume path itself — i.e. a new
turn that picks up from `status=completed` plan and only does
the finalize — is amendment 2E future work.)

**Pinned by:** `test/unit/provider-timeout.test.js` covers
no-plan fallthrough, planner/finalize elevation, explicit-base
override, invalid-base ignore, float-floor, and frozen
defaults object. Eight cases.

**Live test transcript:** `agrun_docs/live-tests/todo-progress-panel-2026-04-26.md`
(plan-completion-then-finalize-timeout; pre-fix evidence).

### 2E. Autostart placeholder is opt-in; terminal plans never carry over

Two related issues surfaced from the 2026-04-26 live test:

**Issue 1 — `todo-autostart` was 补丁思维.**
The runtime's `maybeAutostartTodoState` was originally added as a
stability backstop: when the planner skipped `todo_plan` on a
prompt that "looked long", the runtime auto-injected a single-item
"Planning task breakdown" placeholder. This filled a runtime-shaped
void with generic content that conflicted with the harness contract:
**the planner should read the user prompt, decide whether the task
is multi-step, and call `todo_plan` with task-specific items**.
Auto-injecting a placeholder treated the symptom ("no plan yet")
instead of the root cause ("planner prompt didn't trigger plan
creation").

**Issue 2 — completed plans inherited into new turns.**
`hydrateRunStateWithThread` mirrored the active thread's
`todoState` onto runState even when `status === "completed"` or
`"abandoned"`. Result: after a plan finished, every subsequent
turn in the same thread inherited the same 5/5-done plan and the
UI kept showing "Task progress 5/5" as if it were the current
turn's progress. Live test caught it: prompt run-1 (5-step research)
completed; run-3 (4-step compare different topic, same thread)
showed stale "5/5" even though the model never created a new plan.

**Fix (both halves are structural, not补丁):**

- `normalizeTodoAutopilotConfig` now exposes a separate
  `autostart: boolean` field. **Default `false`**, including when
  the legacy shorthand `true` is passed. Hosts that want the
  placeholder backstop must opt in explicitly with
  `{ enabled: true, autostart: true }`. The vetoes path remains
  available — it just no longer fabricates a plan.
- `maybeAutostartTodoState` early-returns when `autostart` is
  false. Code retained for the explicit opt-in path; nothing was
  deleted.
- `hydrateRunStateWithThread` (run-state-thread.js) now resets
  `runState.todoState` to `null` when the incoming hydration
  payload carries a terminal status. Active plans still carry
  over (the legitimate "continue across turns" path).
- `handle.js` writeback sees `runState.todoState === null` after
  a no-plan turn and writes `null` to the thread record, so the
  stale plan disappears from IndexedDB on the next save.

**Why this is the right harness shape:**
- The planner-prompt already teaches the model to call `todo_plan`
  for complex tasks (see `todo-auto-planner-prompt.test.js`).
  Removing autostart **forces the planner to do its job** instead
  of the runtime papering over a planner gap.
- Terminal-state reset matches the user's explicit contract:
  *"agent 每完成一步调用 todo_run_next 或 todo_replan"* — once a
  plan is done, the work unit is done; new turn = new work unit
  unless the planner says otherwise.
- Topic-router pivots already create a new thread (clean slate
  via `thread.todoState === null` on creation). The bug is only
  in the same-thread continuation case where the previous plan
  reached terminal status.

**Pinned by:**
- `test/unit/todo-autopilot.test.js` — autostart default-false
  assertion + explicit-opt-in shape.
- `test/unit/todo-autostart.test.js` — `{ enabled: true }`
  alone returns null; `{ enabled: true, autostart: true }`
  fires; idempotent on existing TodoState.
- `test/unit/thread-hydration.test.js` test 16 — active carries
  over, completed/abandoned reset to null.

**What this does NOT fix (deferred):**
- 1/5 → 2/5 → 3/5 → 4/5 → 5/5 incremental UI display. The
  emit-time diagnosis on 2026-04-26 showed the runtime emits
  `done: 5` from the very first onStep — but only because the
  hydration was already returning the stale 5/5-done plan. With
  amendment 2E in place we expect the next live test to show
  fresh increments because hydration starts at `null`. If
  increments still batch, that becomes amendment 2F (mid-turn
  emit shape).
- Resume after 180s timeout. Still amendment 2D's roll-forward.

### Rollback for the amendment

- Reverting the panel-gate commit restores "panel always
  visible" behavior (regression to the over-exposed UI default).
- Removing `todo_run_next` from the action registry forces
  callers back to `todo_inspect` + manual selection (verbose but
  functional).
- Reverting `provider-timeout.js` import + call sites in
  `runtime-finalize.js` / `action-loop-planner.js` restores the
  60 s flat default (regression to the autopilot-finalize
  timeout bug).

## Amendment 2026-04-27 — host-facing Todo task lifecycle

Open WebUI review clarified the missing boundary: long-running task
status should be an event/state surface, not assistant prose and not
host auto-submission of a fake user `continue` message.

AGRUN now adds `projectTodoTaskLifecycle(runState)` as a read-only
projection over `runState.todoState`. It produces a stable host-facing
task id (`todo-task:<threadId>:<todoStateId>`), lifecycle status
(`running` / `paused` / `blocked` / `completed` / `abandoned`), counts,
active item metadata, and affordance booleans (`canContinue`,
`canCancel`).

Hard boundary:
- The projection does not mutate TodoState.
- The projection does not advance items.
- The projection does not create synthetic user messages.
- `canContinue` means the host may auto-resume the existing task as a host action, bounded by host policy.

Runtime step snapshots now include `todoTask` beside `todoState`, so
browser hosts can consume lifecycle state directly without parsing
assistant text.

**Pinned by:**
- `test/unit/todo-task-lifecycle.test.js`

## Amendment 2026-04-27 — explicit Todo cancel contract

Paused/active long-running tasks need a real runtime abandonment path.
The browser UI must not set `todoState.status = "abandoned"` directly,
because that bypasses version bumps, provenance stamps, and terminal-state
rules.

AGRUN now adds `applyTodoCancel(state, cancel)` and the planner-visible
`todo_cancel` action. The contract is:

- Existing TodoState is required.
- `pending` / `active` / `blocked` items become `abandoned`.
- `done` items remain `done`.
- `activeItemId` clears and plan status becomes `abandoned`.
- Already-abandoned plans are idempotent no-ops.
- Completed plans reject cancellation to avoid rewriting finished history.

This keeps cancellation as a harness state transition, not a UI patch.

**Pinned by:**
- `test/unit/todo-state.test.js`
- `test/unit/todo-actions.test.js`

---

## Amendment 2G — TodoState SSOT layers + replan-aware merge mode + direction-segment overflow fix (2026-04-27)

### Problem

Three independent issues surfaced in this iteration, two from a code review, one from live e2e.

1. **Hardcoded autopilot policy.** Finalization-item detection (`isFinalizationItem`) and action-progress matching (`ACTION_PROGRESS_RULES` for `read_url` / `web_search`) lived as inline regexes inside `todo-autopilot.js` / `todo-action-progress.js`, with no override path. Hosts could not adapt the autopilot to their domain — that is "补丁思维" (patch-thinking) at the runtime level.

2. **Fragmented query/detection layer.** `isTodoShapedRun` was duplicated in 4 modules (autopilot, autostart, plan-progress, failure-state) with subtly different regexes (core vs extended). `findActiveTodoItem` was duplicated in 4 places with the same cascading id→active fallback. `readString` was a private helper in 5+ files. The mutation layer respected SSOT (`applyTodo*`) but the query/detection/rule layers did not.

3. **Direction-segment overflow on long tasks.** Live e2e on 2026-04-27 with Gemini 2.5 Flash crashed at step 2 of a 6-item plan with `estimatedPromptTokens=52544 > inputBudgetTokens=32768`. Root cause: `inquiryContext.lastReadSource` (which holds the full scraped body of the last read URL) was carried verbatim into the **pinned** `direction` context-window segment. Because `direction` is `pinned: true` it is never droppable, so a single 50 KB page body could blow past the entire input budget — compaction had no recourse and "stage: error" returned.

### Decision

Stratify the TodoState subsystem into four explicit SSOT layers, expose autopilot policy via config, add merge-mode replanning, and bound the prompt-bound projection of `lastReadSource`.

#### TodoState SSOT layers

```
┌─ Mutation SSOT      → todo-state.js          (applyTodoPlan / applyTodoAdvance / applyTodoCancel)
├─ Detection SSOT     → todo-detection.js      (isTodoShapedRun core/extended, readString)
├─ Query SSOT         → todo-queries.js        (findActiveTodoItem cascading, findFirstPendingItem,
│                                               countItemsByStatus, findItemIndexById)
└─ Rule SSOT          → todo-autopilot-rules.js (DEFAULT_FINALIZATION_PATTERN,
                                                DEFAULT_ACTION_PROGRESS_RULES,
                                                normalizeFinalizationPattern,
                                                normalizeActionProgressRules)
```

`normalizeTodoAutopilotConfig` now exposes `finalizationPattern` and `actionProgressRules` so hosts can override:

```js
runtimeConfig: {
  todoAutopilot: {
    enabled: true,
    finalizationPattern: /\b(ship|publish)\b/i,            // RegExp or string; null disables
    actionProgressRules: {
      read_url: null,                                       // remove default
      web_search: { allow: "...", block: "..." },           // override
      custom_crawl: { allow: /\bcrawl\b/i, block: null }    // extend new action
    }
  }
}
```

The detection layer separates "core" mode (matches autostart / plan-progress semantics: `multi-step / progress / todo / task list / long research / deep research`) from "extended" mode (core + research-style verbs: `research / news / report / audit / review / compare / debug / investigate / implement / build`). Callers opt into extended mode explicitly.

#### Replan-aware merge mode

`applyTodoPlan(state, { merge: true })` preserves `done` and `abandoned` items from the existing plan and appends the new `plan.items` after them. Items in `plan.items` whose `id` collides with a preserved terminal item override that item (the planner is explicitly redoing it). Active-item resolution still draws only from the *new* items — terminal items can never become active again. The `replan` note is stamped on **new** items only; preserved terminal history is not retroactively annotated.

`todo_plan` action exposes `merge: false` (default) and `merge: true`, with planner guidance: "When replanning mid-task, prefer `merge: true` so completed work is preserved as audit history."

#### Direction-segment overflow fix

A new pure projection `summarizeReadSourceForDirection(readSource, options)` in `context-snapshot-fields.js` keeps url / title / status / ok / contentType / mode / platform / tier / truncated / bytes / originStatus / reason verbatim while capping `text` / `snippet` / `message` / `error` to a configurable char budget (default 600 chars). When a cap fires it appends `...` and sets `_truncatedForDirection: true`. The full canonical content is **not** mutated — `inquiryContext.lastReadSource` keeps the unbounded record for any non-prompt consumer (memory, evidence, recent-turns).

Two call sites apply the projection:

- `context-window-plan.js::readDirectionObject` — projects into the pinned `direction` segment so the segment can no longer single-handedly overflow the input budget.
- `prompt.js::buildSessionContextPromptBlock` — projects into the rendered "Last read source" prompt section so the projection is consistent with what the LLM sees.

### Verification

- **Unit tests** (113 PASS): see `test/unit/todo-{state,detection,queries,autopilot,autopilot-rules,action-progress}.test.js` and `test/unit/direction-segment-budget.test.js`.
- **Live e2e** on Gemini 2.5 Flash via the browser example: same prompt that crashed at step 2 with 52K-token direction segment now runs 80 turns / 961 steps (full `maxSteps` budget) without any context-window error. The agent completes step 1 (Singapore search) end-to-end, calls `todo_plan` a second time with `merge: true` to preserve i-1 done state, and exits gracefully via `continuation_required` when the per-turn step budget is reached.
- **Direction segment estimated tokens** dropped from ~52,000 to 266 in the regression test (target: 4915, the 15% maxShare of a 32K input budget).
- **Merge mode** triggered in production for the first time during the live e2e — IndexedDB shows the resulting TodoState at version 3 with i-1.status="done" and notes from both the original plan and the merged plan preserved.

### Out of scope (follow-ups)

- **Failed-read recovery loop.** During resume after a `read_url` that returned `ok=false` (HTTP error / blocked content / scraper failure), the planner LLM gets stuck calling `todo_inspect` repeatedly. Diagnostic IndexedDB query confirms the planner has all the state it needs: `inquiryContext.candidateSources` is populated (5 entries), `lastReadSource.url` is set, `lastReadSource.ok=false`, `lastReadSource.text=""`, `selectedSource=null`. The planner just lacks an autopilot signal that says "the read failed — try the next candidate source". *Note: an earlier draft of this amendment claimed `contextSnapshot.inquiryContext` was empty after resume — that was a measurement error in the diagnostic IndexedDB query (I queried `thread.contextSnapshot` but the field lives on the session record). Persistence works correctly; the follow-up is a planner-guidance / autopilot-veto issue, not a state-loss issue.*
- **Planner step efficiency.** During the live e2e, the planner used 80 turns / 961 steps to complete only item 1 of 6. This points to inefficiency in the planner prompt or the autopilot loop — not a runtime correctness issue. A separate follow-up will add diagnostics for "consecutive non-mutating actions" and consider an autopilot veto for long inspect-only streaks.

**Pinned by:**
- `test/unit/todo-detection.test.js`
- `test/unit/todo-queries.test.js`
- `test/unit/todo-autopilot.test.js` (host-injected pattern overrides)
- `test/unit/todo-action-progress.test.js` (host-injected actionProgressRules)
- `test/unit/todo-state.test.js` (merge-mode preserve / drop / default)
- `test/unit/direction-segment-budget.test.js`

## Amendment 2H — Policy/Mechanism separation: TodoState prompt strings SSOT (2026-04-27)

### Problem

After Amendment 2G stabilized the four mechanism-layer SSOTs (mutation, detection, query, rule), three further regressions shipped in rapid succession — all rooted in **wording** rather than mechanism:

1. **Inspect-loop bug (live e2e on gpt-5-mini and gemini-2.5-flash).** Planner LLMs called `todo_inspect` 8–15 times in a row after `todo_plan`. Two compounding causes: (a) the per-cycle `BLOCK_FOOTER` advertised "Use todo_inspect to read the full plan", which planners read as an instruction; (b) `todo_inspect` is read-only and its result never re-enters the next prompt cycle, so once picked, the planner has no signal to stop. Fix landed in commit `c721c61d`: removed the invitation + added `maybeCreateTodoInspectLoopGuard` autopilot veto.

2. **Placeholder copy regression.** The planning-placeholder text inside `todo-state-prompt.js` was reworded twice in two weeks to nudge different model families — each round was a code change, not a config change.

3. **Veto observation drift.** Six autopilot veto strings (in `todo-autopilot.js`) were slowly diverging in tone and structure as different models needed different nudges. No single source defined the canonical wording.

The mechanism layer was correct each time. The **policy layer** — the wording of veto observations, the prompt block header / footer / placeholder, the templated count strings — is a moving target that varies by planner model. Hard-coding it inline meant every tuning round was a 补丁思维 (patch-thinking) source-code edit instead of a host-config change.

### Decision

Add a fifth SSOT layer for **LLM-facing strings**, fully separate from mechanism:

```
┌─ Mutation SSOT       → todo-state.js
├─ Detection SSOT      → todo-detection.js
├─ Query SSOT          → todo-queries.js
├─ Rule SSOT           → todo-autopilot-rules.js
└─ Prompt Strings SSOT → todo-prompt-strings.js  (NEW)
```

`todo-prompt-strings.js` exports:

- `DEFAULT_TODO_PROMPT_STRINGS` — frozen catalog with two sections:
  - `prompt.*` — appears in the per-cycle `ACTIVE TODO PLAN` block (header, footer, placeholder, goal line, plan-status line, omitted-before / omitted-after counts).
  - `autopilot.*` — appears in pre-action veto observations (needsPlanBeforeFinalize, proseOnlyChecklist, placeholderNotReplaced, finalSynthesisItem, unfinishedItems, inspectLoop + remediation pair, todoPlanRequired).
- `normalizeTodoPromptStrings(override)` — deep-merges host overrides on top of defaults, with strict type rules: function-typed defaults reject non-function overrides (otherwise parameter substitution silently breaks); empty / wrong-type values fall back to defaults; unknown sections are dropped silently.

`normalizeTodoAutopilotConfig` now exposes `promptStrings`:

```js
runtimeConfig: {
  todoAutopilot: {
    enabled: true,
    promptStrings: {
      prompt: { blockFooter: "计划结束。继续执行下一个工作单元。" },
      autopilot: {
        unfinishedItems: ({ remainingCount, activeLabel }) =>
          `还有 ${remainingCount} 项未完成: ${activeLabel}`
      }
    }
  }
}
```

Five consumers were rewired to read from the normalized config instead of literals:

- `todo-autopilot.js` — all 9 hardcoded observation strings → `normalized.promptStrings.autopilot.*`
- `todo-state-prompt.js` — header / footer / placeholder / goal line / plan-status / omitted counts → resolved via `options.promptStrings` (with normalize-once-or-pass-normalized fast path)
- `action-loop-planner.js` — threads `runtimeConfig.todoAutopilot.promptStrings` into `buildTodoStateBlockForCycle`

Defaults preserve historical wording byte-for-byte. The change is purely additive: no caller is forced to migrate, and all six pre-existing test files (todo-state, todo-autopilot, todo-state-prompt-budget, todo-inspect-loop-guard, todo-detection, todo-queries) pass without modification.

### Out of scope (deferred to v2)

- `actions/todo-actions.js` static `description` and `planner.guidance` text (≈15 strings across 5 actions). These are read once at action-registry construction, not cycle-by-cycle, so they belong to the **action-catalog** policy surface rather than the **runtime-veto** policy surface. A separate amendment will extend the SSOT to cover them.

### Verification

- **New SSOT test** `test/unit/todo-prompt-strings.test.js` — 8 cases: defaults frozen + match historical wording byte-for-byte; full override flows through `normalizeTodoAutopilotConfig`; override surfaces in inspect-loop guard; override surfaces in finalize veto observation; override surfaces in plan-required guard; override surfaces in prompt block; garbage values (empty string, wrong type, function→string demotion, unknown sections) all fall back safely; default block preserves pre-extraction byte-for-byte rendering.
- **Pre-existing regression suite** — all 6 todo-related test files pass unchanged. No default wording drifted.
- **Why no live e2e for this amendment** — the change is *routing*, not new mechanism. Default path is identical to pre-extraction (covered by the 2G live e2e); override path is exhaustively covered by the new unit test against all 5 consumers. Adding a Chrome MCP run would be ceremonial, not evidentiary.

**Pinned by:**
- `src/runtime/todo-prompt-strings.js`
- `test/unit/todo-prompt-strings.test.js`

## Amendment 2I — Plan-drift goal-anchor (2026-04-27)

### Problem

Live e2e on 2026-04-27 with gpt-5-mini and gemini-2.5-flash exposed a follow-on bug after Amendment 2H landed. User asked for "Singapore + Malaysia AI safety regulation news". First `todo_plan` call was correct. Second `todo_plan` call (replan with `merge: true`) produced generic recovery items completely off-topic from the user request:

- "Recover paused task state and identify last completed step"
- "Re-establish connections and dependencies"
- "Execute next work unit(s) to advance the task"

### Root cause (static analysis)

Two compounding policy-layer issues:

1. **Planner omits `goal` on replan.** The `todo_plan` action description and `planner.guidance` told the planner *what to do* but did not require re-passing `goal` from the user request. Small models drop optional fields.
2. **Empty goal cascade.** `applyTodoPlan` preserves prior goal when new args omit it. If the prior goal was already empty (because the first call also did not pass it), the new plan inherits an empty anchor. With no goal anchor and a "replan" framing in the system prompt, the LLM falls back to a generic "recover paused task" template it was trained on.

The User request line *is* in the planner system prompt (`planner-prompt.js:281`), but the planner has no explicit instruction to extract `goal` from it on each `todo_plan` call.

### Decision

Two-tier fix. **Tier 1 = prompt; Tier 2 = runtime backstop.**

#### Tier 1 — Prompt anti-drift contract

`src/runtime/actions/todo-actions.js`:

- `todoPlanAction.description` now marks `goal` as REQUIRED on every call and explicitly forbids generic recovery templates.
- `todoPlanAction.planner.guidance` now contains a `REPLAN ANCHOR (anti-drift)` section that:
  - Requires `goal` to be re-extracted verbatim from the User request line on every call (including replans).
  - Lists the three forbidden phrases observed in the live bug ("Recover paused task state", "Re-establish connections", "Execute next work unit") with explicit "if you are writing those, stop and re-read the User request" instruction.

#### Tier 2 — Runtime goal-anchor backstop

`executeTodoPlanAction` now resolves the goal via `readGoalForPlan(args, runState, context)` instead of using `args.goal` directly:

```
1. args.goal (trimmed, non-empty) — planner did the right thing
2. runState.observationSummary.prompt — backstop when planner omitted goal;
   emits pushStep("todo-plan-goal-anchored", {...}) so the host activity
   stream surfaces every backstop fire
3. "" — no signal anywhere; let applyTodoPlan preserve prior state
```

This is **not** silent magic — the `todo-plan-goal-anchored` step is observable in the activity log, and the prompt tier is the canonical contract; the backstop only catches LLM noncompliance.

### Why two tiers

The mantra from CLAUDE.md is "do not use 补丁思维" — the runtime backstop on its own would be patch-thinking (silent fallback hides the LLM bug). Without the prompt tier, hosts could not see the anchor problem; without the runtime tier, LLM noncompliance slips into production. Together they form a Harness Engineering pattern: explicit contract via prompt + observable backstop via runtime + activity-stream evidence when backstop fires.

### Verification

- **New unit test** `test/unit/todo-plan-goal-anchor.test.js` — 6 cases:
  1. Prompt tier pins description / guidance contract (REQUIRED, REPLAN ANCHOR, forbidden phrases).
  2. Explicit goal flows through unchanged, no backstop step emitted.
  3. Missing goal triggers backstop, `todo-plan-goal-anchored` step emitted with reason + promptLength payload.
  4. Whitespace-only goal also triggers backstop.
  5. No `observationSummary.prompt` → no false-positive backstop fire.
  6. Production replan scenario (first plan correct, replan omits goal, merge:true) → goal stays anchored to user request, observability step emitted.
- **Regression** — all 6 pre-existing todo test files (todo-actions, todo-state, todo-autopilot, todo-inspect-loop-guard, todo-prompt-strings, todo-state-prompt-budget) pass unchanged.
- **Live e2e** deferred — same rationale as Amendment 2H: this fix is observable via the new `todo-plan-goal-anchored` step in the activity stream once it ships; if production still drifts, the host's IndexedDB will show whether the backstop fired (LLM-side issue) or did not fire (runtime-side issue), so we have a clean diagnosis path without ceremonial pre-ship e2e.

**Pinned by:**
- `test/unit/todo-plan-goal-anchor.test.js`

## Amendment 2K — Verifier nudge on plan completion (2026-04-28)

### Problem

claude-code's `TodoWriteTool` ships a structural reminder: when the main-thread agent closes out a 3+ item list and none of those items mentions verification, the tool result appends a nudge to spawn the verification agent. agrun had no equivalent — a planner could mark all items `done` and head straight to `finalize` without ever running tests, smoke checks, or e2e validation. Self-improvement (AGRUN-210) reflects after the fact; we needed a structural reminder *at the moment of completion*, before finalize.

### Decision

Extend `todo_run_next` with a structural verifier nudge that fires **only at the transition-to-completed moment** when:

1. The plan transitions from active → completed in this call (not on terminal_noop / promoted / advanced).
2. Item count ≥ 3 (mirrors claude-code; trivial 1-2 step plans skip the overhead).
3. No item label or note matches `DEFAULT_VERIFICATION_PATTERN` (`verify` / `test` / `check` / `validate` / `qa` / `smoke` / `regression` / `e2e`).

When all three hold, the runtime:
- Attaches an optional `verifierNudge: string` field to `result.output` (absent otherwise — preserves the byte-shape of existing consumers).
- Emits a `todo-plan-verifier-nudge` step with `{ itemCount, reason }` so the host activity stream can see the reminder fire.
- Suffixes the action summary with ` +verifier-nudge` for log-grep diagnosis.

### SSOT layering (extends Amendment 2H)

| Layer | Module | Symbol |
|---|---|---|
| Pattern (mechanism) | `src/runtime/todo-autopilot-rules.js` | `DEFAULT_VERIFICATION_PATTERN` + `normalizeVerificationPattern(value, fallback)` |
| Text template (policy) | `src/runtime/todo-prompt-strings.js` | `autopilot.verifierNudge({ itemCount })` |
| Detection helper (mechanism) | `src/runtime/actions/todo-actions.js` | `detectVerifierNudge(context, todoState)` |
| Threshold (mechanism boundary) | `src/runtime/actions/todo-actions.js` | `VERIFIER_NUDGE_MIN_ITEMS = 3` |

Hosts override via:
- `runtimeConfig.todoAutopilot.verificationPattern` (string / RegExp / `false` to disable)
- `runtimeConfig.todoAutopilot.promptStrings.autopilot.verifierNudge` (function template)

### Why post-action (not pre-action veto)

Pre-action vetoes (`todo-autopilot.js`) intercept and redirect *wrong* actions before they commit. The verifier nudge rides on the result of a *correct* action (`todo_run_next` with completion). It is structural evidence, not a course correction — the planner is free to ignore it and finalize anyway. Putting it inside `todo-autopilot.js` would conflate "veto wrong choice" with "remind on right choice"; it lives in `todo-actions.js` next to the result builder it modifies.

### Why not re-fire on terminal_noop

Repeated `todo_run_next` on an already-completed plan is a planner mistake; spamming the nudge each time would inflate prompt context with duplicate reminders. The nudge is a one-shot signal at the *transition-to-completed* moment — the same moment claude-code's `verificationNudgeNeeded` fires.

### Action surface contract (updates Amendment 2C)

`todo_run_next` action result now has the shape:

```ts
{
  control: "continue",
  output: {
    action: "completed" | "advanced" | "promoted" | "completed" | "abandoned",
    completedItemId: string | null,
    kind: "todo_run_next_result",
    nextActiveItemId: string | null,
    todoState: SerializedTodoState,
    verifierNudge?: string  // NEW (2K) — present only when nudge fires
  },
  summary: string  // suffixed with " +verifier-nudge" when nudge fires
}
```

`verifierNudge` is **strictly optional** — `result.output.verifierNudge === undefined` is the stable shape for completion calls that include verification, plans below threshold, terminal_noop, advance, and promotion variants.

### Verification

- **New unit cases** in `test/unit/todo-actions.test.js` (4 cases):
  - 10e: 3+ item completion without verify keyword → `verifierNudge` present, `todo-plan-verifier-nudge` step emitted with `itemCount: 3`.
  - 10f: 3-item plan with `"Run tests"` label → `verifierNudge` absent, no step emitted.
  - 10g: 2-item plan completion → below threshold, `verifierNudge` absent, no step emitted.
  - 10h: terminal_noop on already-completed 3-item plan → `verifierNudge` absent, no step emitted.
- **Regression** — all 7 pre-existing `todo_run_next` cases (7, 8, 9, 10, 10b autopilot loop, 10c post-completion, 10d post-cancel) pass unchanged. Test 10b's 5-item autopilot loop's final call now produces `verifierNudge` in output, but the test asserts only `{action, completedItemId, nextActiveItemId}` so the new optional field is invisible to it.
- **Build** — `npm run build` regenerates `dist/agrun.js`; bundle keyword count for `verifierNudge` / `verifier-nudge` / `DEFAULT_VERIFICATION_PATTERN` = 13 (constants + helper + template + event name + output field).
- **Live e2e** deferred — change is observable via the new `todo-plan-verifier-nudge` step; production diagnosis is the same loop as Amendment 2I (host IndexedDB shows whether the runtime-side fired correctly).

**Pinned by:**
- `test/unit/todo-actions.test.js` cases 10e / 10f / 10g / 10h
- Cross-reference: claude-code `src/tools/TodoWriteTool/TodoWriteTool.ts:76-86` (origin pattern)

## Amendment 2L — Evidence-exhausted redirect (2026-04-28)

### Problem

User Support Bundle (2026-04-28) on real research prompt "Find the latest AI browser news and give me 3 links worth reading today" — using Gemini 3.1 Flash Lite preview in browser without a `readUrl` proxy endpoint configured:

- 80 cycles, 980 runtime steps
- Terminalized by `max_steps_continuation` after 75 identical wasted veto cycles
- `finalAnswerSource: "continuation_required"` (no actual final answer)
- LLM returned a generic "I paused this long-running task to preserve direction and progress" placeholder, NOT the requested links

Cycle pattern from cycles 6-80:

```
phase-decide-completed | actionName=finalize | decisionSource=continuity
phase-act-started
before-finalize-veto | source=budget_finalize
before-finalize-veto | source=planner_finalize
cycle-started   ← back to top, no state change
```

### Root cause

Two-layer:

1. **`read_url` failed CORS** for both candidate news sources (`humai.blog`, `vtnetzwelt.com`). User had `readUrl.endpoint: ""` so the browser tried direct fetch → blocked. Both attempts logged as `read-url-failed | error=fetch_failed`.

2. **Fallback veto bypassed maxVetoes cap.** `runState.autoReadStoppedReason` became `auto_read_limit_reached` after the second failure. The orient phase then signaled `usedSummarizeLimits: true`. Planner picked finalize. `maybeCreateTodoAutopilotVeto` reached the fallback path at [todo-autopilot.js:128-132](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-autopilot.js:128) which returned:

   ```js
   return stampVeto(runState, normalized, context, {
     activeLabel,
     observation: strings.unfinishedItems({ remainingCount, activeLabel }),
     requireCompletion: true   // ← this bypasses the maxVetoes cap
   });
   ```

   The veto contained no `decision.type === "action"` redirect, so `applyBeforeFinalizeVeto` fell through to `return { action: "continue" }`. Next cycle, planner saw the same state (no progress possible — read_url all failed, no other tools to try) and picked finalize again. Same veto fired. Loop until `max_steps_continuation`.

The bug pattern: a "must complete plan" invariant (correct in principle) had no escape hatch when the environment made completion impossible.

### Decision

When the fallback veto fires with `runState.autoReadStoppedReason` set, **redirect** to `todo_run_next` instead of pure-block. Each redirect advances one TodoState item with an "evidence-constrained" provenance note. Plan drains item-by-item until `status === "completed"`, at which point line 94 returns null (no more veto) and the planner's finalize is allowed.

Implementation in [todo-autopilot.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-autopilot.js):

```js
const exhaustionReason = readEvidenceExhaustedReason(runState);
if (exhaustionReason && activeItem) {
  return stampVeto(runState, normalized, context, {
    activeLabel,
    decision: {
      type: "action",
      name: "todo_run_next",
      args: {
        note: `Evidence-gathering exhausted (${exhaustionReason}); advancing with snippet-only evidence available.`
      }
    },
    observation: strings.evidenceExhausted({ activeLabel, reason: exhaustionReason }),
    requireCompletion: true
  });
}
```

`readEvidenceExhaustedReason` reads `runState.autoReadStoppedReason` (set by orient phase via `research-continuation.js`).

`evidenceExhausted` template added to `DEFAULT_TODO_PROMPT_STRINGS.autopilot` in [todo-prompt-strings.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/todo-prompt-strings.js) — host-overridable via `runtimeConfig.todoAutopilot.promptStrings.autopilot.evidenceExhausted`.

### Why redirect (not just lift the cap)

Two alternatives were rejected:

1. **Lift the maxVetoes cap for `requireCompletion: true`**: would let finalize through after N attempts, but the planner would emit a final answer without TodoState reflecting that work was abandoned. Misleads the audit trail.
2. **Force finalize through orient phase**: would skip the autopilot guard entirely, undermining its purpose.

Redirect to `todo_run_next` is correct because it (a) advances the plan with an explicit "evidence-constrained" note, preserving audit trail; (b) is the same pattern as the existing `finalSynthesisItem` redirect at line 113-126 (planner-driven progress); (c) terminates after at most `pendingItems.length + 1` cycles regardless of `requireCompletion: true` flag.

### Verification

**Tier 1 unit:**
- 3 new cases in `test/unit/todo-autopilot.test.js`:
  - Redirect fires with correct decision shape when `autoReadStoppedReason` is set
  - Without exhaustion signal, fallback stays as pure-block (regression-safe — preserves behavior for happy path)
  - 2-item plan with synthetic redirect→advance→redirect sequence terminates cleanly with no veto on completed state
- All 17 pre-existing autopilot tests pass unchanged.

## Amendment 2M: Required-completion veto circuit breaker

**Date:** 2026-04-29

### Problem

Amendment 2L fixed the browser `read_url` evidence-exhausted loop, but the broader contract still let `requireCompletion: true` TodoState vetoes bypass `maxVetoes` indefinitely. Any pure-block required-completion path with no environment exhaustion signal could still repeat:

```text
planner finalize -> before-finalize-veto(requireCompletion=true, no decision)
-> cycle continues with unchanged TodoState -> planner finalize again
```

Host `onBeforeFinalize` could not reliably recover because built-in TodoState autopilot runs first in the before-finalize chain.

### Decision

Add `runtimeConfig.todoAutopilot.maxRequiredCompletionVetoes` with the same default as `GUARD_MAX_VETOES` (`6`). This cap is separate from `maxVetoes`, so non-required and required-completion vetoes are observable independently.

When a `requireCompletion: true` veto reaches the required-completion cap and has no existing redirect decision, the runtime returns a deterministic `todo_run_next` redirect:

```js
{
  type: "action",
  name: "todo_run_next",
  args: {
    note: "Required-completion finalize veto limit reached; advancing TodoState item: ..."
  }
}
```

This preserves the audit trail by advancing TodoState through the normal action surface instead of silently allowing finalize while items remain active/pending.

Existing required-completion redirects, such as final synthesis item completion and evidence-exhausted advancement, keep their specific decisions and do not need the circuit breaker.

### Observability

`before-finalize-veto` now includes:

- `requireCompletion`
- `vetoCount`
- `requiredCompletionVetoCount`
- `maxVetoes`
- `maxRequiredCompletionVetoes`
- `limitReached`
- `remainingCount`
- `activeLabel`
- `decision`
- `recommendedEscapeAction`

The step detail is built by `buildBeforeFinalizeVetoStepDetail` (in `test/helpers/before-finalize-veto-detail.mjs`) so event-shape tests can verify it without importing the full action-loop dependency graph.

### Verification

- `test/unit/todo-autopilot.test.js` covers config normalization, required-completion cap redirect, and enriched veto detail.

**Tier 1 full suite:**
- Root `npm test` (15 concern suites + 92 unit test files): all green
- `npm run build`: dist regenerated cleanly

**Tier 3 whole-system e2e:**
- Same prompt as the original Support Bundle: "Find the latest AI browser news and give me 3 links worth reading today"
- Same model (`gemini-3.1-flash-lite-preview`), same browser env, same CORS-blocked read_urls
- Result: 10 cycles (vs 80), 20 activities (planning 7, execution 6, observation 4, error 2, **final_answer 1**), real 3-link answer produced
- Compare original: 80 cycles, no `final_answer` activity, terminalized by `max_steps_continuation`

**Pinned by:**
- `test/unit/todo-autopilot.test.js` (3 new cases, lines after "Host overrides the finalizationPattern")
- Tier 3 e2e snapshot recorded in IndexedDB session `qa-fix-2L-real-research`
