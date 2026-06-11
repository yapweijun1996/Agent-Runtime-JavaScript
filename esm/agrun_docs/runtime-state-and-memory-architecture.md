# agrun.js Runtime State And Memory Architecture

## Purpose

This document refines the state and memory boundaries for the `agrun.js` MVP.
It should be read together with `agrun_docs/spec.md`.

The goal is to keep `state`, `memory`, `output`, and `observation` clearly separated.
If those boundaries blur, the runtime will quickly become harder to reason about and harder to extend.

## Core Distinction

The most important rule is:

```text
State is not memory.
Memory is not state.
```

### State

`state` belongs to the current run.

It answers questions such as:

- what run is currently executing
- what skill was selected
- what the latest observation is
- whether the run is running, finished, or failed

State is:

```text
current-run
ephemeral
execution-oriented
```

### Memory

`memory` belongs to the runtime instance across runs.

It answers questions such as:

- what important observations were retained from earlier runs
- what later skills can read as historical context

Memory is:

```text
cross-run
append-only
history-oriented
```

### Session History

`session history` is a separate layer from runtime memory.

It answers questions such as:

- what the user and assistant said in one session
- which recent turns should be replayed for provider-backed follow-up turns

Session history is:

```text
session-scoped
message-oriented
prompt-window oriented
```

## Session Context Model

Session-backed provider turns now separate continuity into two canonical layers:

```text
session memory
inquiry context
```

`session memory` is the durable semantic layer rebuilt from summary, confirmed memory entries, and recent transcript.
It contains facts, preferences, decisions, summary/compacted context, and recent turns.

`inquiry context` is the session-scoped working set for the active investigation.
It contains the active goal/topic/query, candidate and selected sources, last search/read state, and clarification working state.

Per-run intent-like helpers may still exist as temporary runtime projections.
They are not canonical continuity state and should never be persisted as durable memory.

The runtime now exposes these layers through `runState.contextSnapshot`:

```text
contextSnapshot.sessionMemory
contextSnapshot.inquiryContext
runState.readAttemptSignal
```

`sessionContextView` remains as a compatibility alias for debug consumers, but `contextSnapshot` plus read-only run signals are the canonical continuity model.

Compatibility rule:

- transitional fields such as `turnIntent` may still appear in debug projections while the codebase converges
- those fields are compatibility-only and must not become a source of truth

## Prevent Lost Direction

The runtime should preserve direction before preserving volume.

The most important continuity fields are:

- `activeGoal`
- `activeTopic`
- `activeQuery`
- `pendingClarification`
- `lastClarificationResolution`
- `selectedSource`
- `lastReadSource`

These fields together define where the current session is going.

If prompt compaction or continuity reduction happens, these fields should be protected before:

- older transcript
- low-value free memory
- generic history
- debug-oriented projections

Direction rule:

```text
Do not preserve more context.
Preserve the most important direction.
```

## Clarification Boundary

`pendingClarification` is the only canonical unresolved-clarification state.

Derived fields such as:

- `clarificationStatus`
- `openAmbiguity`
- `ambiguityState`

may still be exposed for planner, evaluate, or debug views, but they must be derived from:

- `pendingClarification`
- `lastClarificationResolution`

They must not become separate stored truth.

Clarification should stay a last resort.

Do not create a persistent clarification state when:

- the missing input is optional
- a low-risk direct tool path already exists
- the runtime can safely apply a default

## Anti-Overengineering Rules

To keep continuity understandable and prevent direction drift:

- do not add a separate semantic pre-pass as canonical turn truth
- do not duplicate goal/topic/ambiguity across multiple independent state layers
- do not let debug projections become planner truth
- do not let free-text ambiguity summaries outrank structured clarification objects
- do not let compaction logic infer new task semantics; compaction should only shrink context

## State Model

The MVP should keep state intentionally small and explicit.

### RunState

`RunState` is the runtime's internal state for one `run()` call.

Suggested fields:

```text
runId
status
stepCount
cycleCount
phase
selectedSkill
observation
error
oodae
```

Rules:

- `RunState` is per-run only
- `RunState` should not become a general history object
- `RunState` should not own a separate canonical `output` field in the MVP
- `phase` should expose the currently active OODAE phase
- `oodae.cycles` should keep cycle-scoped observe/orient/decide/act/evaluate records

Why no `output` field in `RunState`:

- the skill's direct `output` already belongs in `RunResult`
- `observation` is the runtime-owned interpretation used for state and memory work
- duplicating both in `RunState` makes the model harder to keep coherent

### RuntimeState

`RuntimeState` is runtime-instance scoped.

Suggested MVP field:

```text
lastRun
```

`lastRun` should be a small summary of the most recent run.
It should not become full run history.

## Output, Observation, And Memory

These three layers must remain separate.

### Output

`output` is the direct result returned by the selected skill.

It belongs to:

```text
skill execution result
external run result
```

### Observation

`observation` is the runtime's normalized interpretation of that execution outcome.

It belongs to:

```text
runtime bookkeeping
state update
memory decision
```

### Memory Entry

`memory entry` is the long-lived record the runtime chooses to append for future runs.

It belongs to:

```text
cross-run history
runtime-instance memory
```

Correct flow:

```text
skill returns output
↓
runtime derives observation
↓
runtime decides whether to append memory
```

## Memory Model

The MVP memory model should be:

```text
append-only
in-memory
runtime-instance scoped
```

This is intentionally not:

```text
a database
a vector store
a knowledge graph
a tracing backend
```

## Memory Contract

The runtime owns the canonical memory entry shape.

Skills do not write arbitrary objects directly into the underlying memory store.

MVP contract:

- skills read memory through `context.memory.readAll()`
- skills request memory writes through `helpers.appendMemory(entry)`
- the runtime normalizes that request into the canonical stored memory entry

This preserves a controlled boundary:

- skills can use memory
- runtime keeps schema ownership and append policy

## Memory Append Policy

Not every run event should become semantic memory.

MVP default policy:

- successful observations may produce memory entries
- explicit skill requests through `helpers.appendMemory(entry)` may produce memory entries
- failed runs do not append semantic memory entries by default

Failure information should still be visible through:

- `error`
- failure `observation`
- `steps` trace
- `lastRun` summary

This keeps `memory` focused on cross-run context rather than turning it into a generic trace log.

## Session History, Memory, And Knowledge

These three concepts must remain separate:

- `session history`: raw multi-turn messages for one session
- `memory`: retained semantic facts for later runs or later turns
- `knowledge`: external retrieval or document context supplied by skills

The session MVP should only add:

- session history
- session-scoped semantic memory
- structured session evidence for planner/provider reconstruction
- internal compaction summaries for prompt-window control

It should not add:

- a built-in knowledge base
- retrieval persistence inside runtime core
- a vector index inside the runtime kernel

## Session Memory Loop

Session memory should not stop at persistence.
For conversational continuity, the runtime needs a closed loop:

```text
session history
↓
semantic memory extraction
↓
structured evidence snapshot
↓
planner / provider prompt reconstruction
↓
direct answer or clarification
```

Rules:

- session history stores raw `user` and `assistant` messages
- session memory stores high-value confirmed facts, preferences, and decisions
- prompt reconstruction should expose those as separate evidence sections, not one loose memory blob
- recall-style questions should check confirmed session evidence before choosing clarification
- failed turns and unresolved ambiguity should not be promoted into confirmed session memory

## State Transition Responsibility

The runtime owns state transitions.

That means:

- skills return `output`
- runtime derives `observation`
- runtime updates `RunState`
- runtime updates `RuntimeState.lastRun`

Skills must not define or directly mutate runtime state structure.

## Cross-Run Cooperation

During skill execution, the runtime may expose both:

- current run state through `context.state`
- prior retained history through `context.memory.readAll()`

This gives the skill two distinct views:

- what is happening now
- what was retained from earlier runs

Those views should remain separate.

## Design Principles

The state and memory model can be summarized as:

1. `state` is for the current run.
2. `memory` is for cross-run continuity.
3. the runtime owns state transitions.
4. the runtime owns memory structure and append policy.
5. `output`, `observation`, and `memory entry` are different layers.
6. append-only memory is the right MVP model.
7. memory policy is domain-neutral; host-specific policy plugs in via hooks.

### Domain-neutral Memory Policy

Memory promotion, sensitivity filtering, and recall selection must
stay generic. The runtime has no business-domain knowledge and must
not grow any.

- Sensitive-content filters in `global-memory.js` cover only
  universal credential patterns (api keys, tokens, passwords, bearer
  strings). Customer names, invoice numbers, patient ids, account
  balances, and other domain PII are the host's responsibility.
- Confidence thresholds, kind classifications, and slot schemas are
  tuned to be defensible for any host, not optimized for one.
- Hosts that need stricter filtering, validation against domain
  records, or redaction of business data should use runtime-provided
  extension points (e.g. a `sensitivityFilter` hook) rather than
  asking the runtime to learn their schema.
- New memory-promotion logic that would require the runtime to
  understand a specific business concept is a signal the work
  belongs in a host hook, not in `agrun.js`.

### Disabling Cross-Session Memory

Hosts that do not want any cross-session promotion can pass
`createRuntime({ globalMemory: { enabled: false } })`. When disabled
the runtime:

- skips the per-turn semantic extraction LLM call,
- does not read from the `globalMemory` IndexedDB store at turn start,
- does not promote any extracted entries.

Per-session memory (`memoryEntries` writes from skills via
`helpers.appendMemory` or the `memory-skill` "remember:" command)
keeps working. Existing `globalMemory` rows stay on disk; toggling
`enabled` back to `true` restores recall and promotion. See
[public-runtime-api.md "Disabling Global Memory"](./public-runtime-api.md#disabling-global-memory)
for the full contract.

### Sensitive Content Filter

`promoteToGlobalMemory()` refuses to persist entries whose text, metadata,
or key names match a known secret shape. The filter covers generic labels
(`api_key`, `password`, `authorization`, `x-api-key`, `aws_secret_access_key`,
…), provider-specific key formats (`sk-…`, `sk-ant-…`, `AIza…`, `ya29.…`,
`ghp_/gho_/ghu_/ghs_/ghr_…`, `AKIA…`), PEM private keys, and JWT triples.
The scan recurses into nested objects and arrays with cycle protection; a
key named `apiKey`, `client_secret`, or `bearer` blocks the entry regardless
of the value. See [src/session/global-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/global-memory.js)
and the fixture list in
[test/unit/global-memory-sensitive.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/global-memory-sensitive.test.js).

### IndexedDB Resilience

`createSessionStore()` wraps the primary IndexedDB store with
[createResilientSessionStore()](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-resilient.js). A single
fatal storage error (Safari private mode `InvalidStateError`, quota
exhaustion, permission denial) swaps the primary with an in-memory fallback
for the remainder of the session and fires `onStorageDegraded({ reason, method })`
via the session store options. Non-fatal errors continue to throw so callers
can retry. Session continuity within the page survives the degrade; durability
across reloads does not (the host UI should surface the telemetry to warn the
user).

## Summary

`agrun.js` stays clean when it keeps these boundaries:

```text
RunState     = current execution state
RuntimeState = last run summary for the instance
Output       = direct skill result
Observation  = runtime interpretation
Memory       = retained cross-run context
```

The smaller and clearer these boundaries stay, the easier the runtime will be to implement, test, and extend.
