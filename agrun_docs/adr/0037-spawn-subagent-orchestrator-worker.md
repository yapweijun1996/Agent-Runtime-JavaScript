# ADR-0037: spawn_subagent — Orchestrator/Worker via Recursive Session

## Context

Today every agrun run is a single linear action loop. AI selects tools
from one flat surface, and a "what's today's date?" sub-question must
be answered inline by the same agent that is composing a long-form
report. The runtime already lays the groundwork for a richer model:

- `sessionRecord.parentSessionId` (AGRUN-240) records lineage.
- Session lineage now flows through every `pushStep` / event-ledger
  emission (AGRUN-240-followup commit 523580877).
- `parentSessionId` is documented as enabling
  "orchestrator-worker task tree debugging"
  ([session/messages.js:22](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/messages.js)).

What is still missing is the mechanism by which an action loop can
delegate a focused sub-task to a worker session and consume its
result. Hosts asked for the canonical user-facing example:

```
User:        What is today's date?
Main agent:  → spawn_subagent({ task: "get today's date" })
                ↘ Worker session asks web/tool → returns "2026-05-26"
Main agent:  ← receives result → replies to user
```

The architectural blocker the design must address: `action.execute`
receives a `context` object that does **not** carry a reference to the
runtime ([action-loop-action.js:375-388](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-action.js)).
The action handler cannot call `runtime.run()` directly; some
capability must be threaded in.

## Decision

Add a new built-in action `spawn_subagent` registered in
`action-registry.js`. The runtime threads a `spawnSubagent` callable
through `runLoop` options into the action `context` (mirroring how
`webSearchEndpoint` is already injected). The action invokes the
callable, which constructs a child session with the parent's
`sessionId` as its `parentSessionId`, runs a focused action loop, and
returns a normalized result envelope.

### 5 design decisions

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Recursion containment | **Depth = 1 via physical filter.** The child's action registry is built with `spawn_subagent` filtered out. No depth counter, no runtime check — structural impossibility. |
| 2 | Abort propagation | **Shared `callerAbortSignal`.** The child inherits the parent's `callerAbortSignal` via `mergeAbortSignals`. Parent stop → child stops at next top-of-cycle check. |
| 3 | Cost rollup | **Token usage rolls up to parent `cumulativeUsage`; child `maxSteps` is independent.** Step counts stay isolated so the parent's trace shows "child used N cycles" cleanly, but billing aggregates. |
| 4 | Tool surface | **Child inherits parent's full tool registry minus `spawn_subagent`; caller may narrow via optional `tools: [...]`.** Default is permissive (AI-first); narrowing is opt-in. |
| 5 | Inspector event tagging | **Already done.** AGRUN-240-followup auto-injects `sessionId` and `parentSessionId` on every `step.detail` and event-ledger entry, so child events are already attributable to the parent's task tree. |

### Action shape

```js
// src/runtime/actions/spawn-subagent-action.js
export const spawnSubagentAction = {
  name: "spawn_subagent",
  description: "Delegate a focused sub-task to a worker agent and return its final answer.",
  tier: 1,
  planner: {
    decisionType: "action",
    argsExample: {
      task: "Get today's date in ISO format",
      tools: ["read_url", "web_search"],
      maxSteps: 15
    },
    argsSchema: {
      task:     { type: "string",  required: true },
      tools:    { type: "array",   required: false },
      maxSteps: { type: "number",  required: false }
    },
    guidance: "Use spawn_subagent to scope a self-contained sub-question (look up a fact, summarize one source) so its tool calls do not pollute the main turn's history."
  },
  outputSchema: {
    kinds: ["subagent_result"],
    controls: ["continue"],
    metrics: { childCycles: "count" }
  },
  execute: executeSpawnSubagent
};
```

### Result envelope

```js
// observation passed back to main agent
{
  control: "continue",
  output: {
    kind: "subagent_result",
    childSessionId: "session-xyz-child-1",
    childRunId: "run-7",
    finalResponse: "Today is 2026-05-26.",
    status: "completed",       // "completed" | "failed" | "aborted"
    cycleCount: 3,
    usage: { promptTokens: 234, completionTokens: 89 },
    error: null                // populated when status !== "completed"
  },
  summary: "spawn_subagent(get date) -> completed in 3 cycles"
}
```

### Capability injection

`runLoop` constructs a `spawnSubagent` callable bound to the active
runtime, threads it via options, and `action-loop-action.js` adds it
to the `context` object passed to `action.execute`:

```js
// runtime/run-loop.js — assembled once per run
function createSpawnSubagentCapability({ runtime, sessionStore, parentSessionId, callerAbortSignal, parentMaxSteps }) {
  return async function spawnSubagent({ task, tools, maxSteps }) {
    const childMaxSteps = clampMaxSteps(maxSteps, parentMaxSteps);
    const childSession = await runtime.createSession({ parentSessionId });
    const childResult = await childSession.run(
      { prompt: task, parentSessionId },
      {
        disabledActions: buildChildDisabledActions(tools),  // includes spawn_subagent always
        callerAbortSignal
      }
    );
    return normalizeChildResult(childResult);
  };
}
```

`buildChildDisabledActions(tools)`:

- Always returns `["spawn_subagent", ...]` so the child cannot recurse.
- When `tools` is a non-empty array, every action NOT in the list is
  appended to the disabled set — this is how "narrow the surface"
  becomes a single contract (`disabledActions` already exists, no new
  filtering primitive).

## Alternatives

1. **Factory closure** — `createSpawnSubagentAction(runtimeRef)` registered
   like `createListAgentSkillsAction`. Rejected: requires a mutable ref
   to resolve the chicken-and-egg between runtime and registry, and
   couples the action module to runtime construction. Context injection
   matches the existing `webSearchEndpoint` shape and keeps the action
   module pure.

2. **Inline single-call delegation** — `spawn_subagent` makes one LLM
   call with a focused prompt and tool surface, no nested loop.
   Rejected: insufficient for any sub-task that needs more than one
   tool call. Would re-implement loop logic per-action.

3. **Skip depth=1 enforcement** — let the model spawn arbitrary depth.
   Rejected: a lite-tier model can trivially spawn 50 sub-agents for a
   trivial question, and recursive sub-agent state explosion is the
   single biggest risk surface of this whole pattern. Physical filter
   in the child registry is the cheapest containment.

## Consequences

**Pros**:
- Reuses every existing runtime primitive (action registry, run-loop,
  session store, abort signal, cost ledger).
- Lineage trace already works (G3 plumbing).
- Host engineers can adopt with zero config — the action shows up in
  the planner's action surface automatically.
- Depth=1 makes the worst-case blast radius small and predictable.

**Cons**:
- Each `spawn_subagent` call spins up a full session — heavier than an
  inline tool call. Acceptable: caller chose to delegate.
- Child loses access to parent's `runState` (workspace, todo, research
  context). This is by design (scope isolation); the worker only sees
  the `task` string.

**Risks**:
- Lite-tier models may over-call `spawn_subagent` if guidance is
  unclear. Mitigation: `planner.guidance` text emphasizes "focused
  sub-question" wording; existing `actionPatternConvergence` already
  detects repeated identical action calls.
- Cost rollup must use the same `cumulativeUsage` accumulation path as
  parent's own LLM calls. If we miss a hook, child cost is invisible.
  Mitigation: child runs through the same `runLoop`, which already
  records `runState.metrics.usage` via the standard provider hooks; we
  just need to merge `childResult.runState.metrics.usage` into the
  parent's pre-step snapshot.

## Rollback

Revert the commits that add:
- `src/runtime/actions/spawn-subagent-action.js`
- `spawnSubagent` option in `run-loop.js`
- `spawnSubagent` key in the `action.execute` context in
  `action-loop-action.js`
- registry entry in `action-registry.js`
- tests under `test/unit/spawn-subagent-*.test.js` and any
  integration test referencing the new action

The runtime returns to the AGRUN-240-followup state. No data
migration; child sessionRecords created during the rollback window
become orphan top-level sessions in the store (`parentSessionId`
remains stamped but no longer wires into anything).

---

## Follow-up — AGRUN-255 (child-tool approval)

**Discovered 2026-05-26 in live e2e**: child runLoop has its onStep / per-event
callbacks intentionally stripped (event isolation, Decision 5). When the AI
spawned a child with `tools: ["web_search"]`, the child hit `web_search` (tier=1
→ `inferTierPolicy` returns `"ask"`), the approval gate fired *inside the child*,
but the request never reached the parent UI (no onStep). The child eventually
hit `MAX_STEPS_EXCEEDED`. Reported by parent's normalized envelope as
`status: "failed"`.

**Decision** — `tools: [...]` allowlist doubles as a **pre-approval contract**.

When the user approves the parent's `spawn_subagent` call, they have implicitly
approved the declared tool surface (the surface is shown to them at approval
time via the existing parent-side approval dialog). The capability layer
translates that into auto-allow entries in the child's `runtimeConfig.actionPolicy`,
which `evaluateActionPolicy` checks before tier fallback.

Implementation: `buildChildActionPolicy(parentPolicy, requestedTools)` in
`src/runtime/spawn-subagent-capability.js`. Invariants:

1. **Parent `"deny"` is never overridden** — host security boundary. Both
   string `"deny"` and object `{action:"deny", reason:"..."}` shapes are
   detected.
2. **Empty / omitted `tools` adds no entries** — safe default. AI must
   explicitly declare its needs.
3. **`spawn_subagent` is never auto-allowed** — defense in depth against
   depth-limit escape via the policy channel (already blocked by
   `disabledActions`).
4. **Other parent policy entries preserved** — auto-allow is additive.

Rejected alternatives:

- **Auto-inherit parent's approval ledger** — leaks parent's prior approvals
  into a child that didn't ask for those tools; violates "AI declares its
  needs" principle.
- **Separate `approveTools` arg on `spawn_subagent`** — duplicates `tools`
  semantics; AI would have to declare the same tool twice.
- **Dedicated `onChildStep` callback for child approvals** — requires host UI
  task-tree / child approval dialog work that's out of runtime scope.
  Deferred as a separate UI ticket. With Option C, the host's existing
  parent-side approval dialog SHOULD surface the declared `tools` in the
  prompt text so users see what they're approving.

Tests: 6 new cases in `test/unit/spawn-subagent-capability.test.js`
(Tests 12-16) covering the four invariants.
