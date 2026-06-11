# agrun.js Runtime Internal Architecture

> **Last reviewed:** 2026-05-14 against ADR-0023..0029.
>
> This document captures the **high-level shape** of the runtime kernel and remains accurate at that level. For the current AI-first push-mode architecture, see [ADR-0023](./adr/0023-harness-as-tool-provider-only.md). For the deep subsystem layout (~140 files in `src/runtime/`), see [`planner-architecture.md`](./planner-architecture.md), [`research-and-evidence-model.md`](./research-and-evidence-model.md), [`todo-state-integration.md`](./todo-state-integration.md), and [`error-handling-and-recovery.md`](./error-handling-and-recovery.md). The "File Boundaries" section below shows the original MVP layout — actual `src/runtime/` is now much larger; treat it as historical.

## Purpose

This document defines the internal runtime architecture of `agrun.js` for the MVP.

`agrun.js` is a browser-first agent runtime library. It is not a workflow engine builder, plugin marketplace, or hosted AI platform. The runtime should stay clear, predictable, and useful.

Core principle:

```text
Push capability into skills.
Keep the runtime focused.
```

For the planner/action surface, see `agrun_docs/action-contract.md`.

## Runtime Model

The runtime is a unified execution kernel for skills, runtime-owned actions, sessions, and approvals.

It is responsible for:

```text
routing
execution
state tracking
memory logging
result assembly
```

It is not responsible for:

```text
domain logic
tool capability
planning systems
multi-agent orchestration
```

## Core Components

The MVP runtime consists of five core components:

```text
Runtime
 ├ Runtime Loop
 ├ Skill Router
 ├ RunState
 ├ RuntimeState
 └ Memory Store
```

Post-MVP, the runtime kernel grew additional subsystems that remain owned by the runtime (as mechanism, not policy — see [ADR-0023](./adr/0023-harness-as-tool-provider-only.md)):

```text
+ Planner (envelope + native_tools modes)
+ Action Registry (tier-based policy gates)
+ TodoState subsystem (autopilot guards, autostart, debug)
+ Virtual Workspace (AI-authored files)
+ Research subsystem (evidence graph, source authority, acceptance + recovery evaluators)
+ Session Store (IndexedDB + memory + resilient)
+ Cost Ledger (observability)
+ Drift Detector / Goal Anchor (read-only signals)
```

All of these are **tool providers and read-only signal emitters**. AI owns all decisions.

The runtime now enters through one canonical `run()` execution path.
That unified entry may internally route into skill execution, planner/action execution, or approval resume handling, but those are implementation subflows rather than separate public runtime architectures.
Compatibility labels such as `mode` remain result metadata only.

### Runtime Loop

Owns the execution flow for a single `run()` call.

### Skill Router

Chooses the skill that will execute for the current input.

### RunState

Stores per-run execution state only.

### RuntimeState

Stores runtime-instance metadata only.

### Memory Store

Stores append-only memory entries for the runtime instance.

## Execution Flow

The runtime supports one execution route:

```text
run()
└ unified runtime loop
```

That loop may select a skill, a runtime action, or a terminal answer step depending on the current input and decision state.
Provider-style inputs first respect normal skill priority; when no skill matches, the same runtime entry continues into planner/action execution.
Approval-resolution inputs resume through the same runtime entry and return the same structured result contract.

Current internal subflows inside that one runtime entry are:

- skill execution
- planner/action execution
- approval resume handling

The project does not want to preserve a separate legacy skill loop.
Do not add new architecture or documentation that depends on compatibility mode labels as a permanent execution mode.

The runtime now uses an explicit OODAE loop:

```text
observe
↓
orient
↓
decide
↓
act
↓
evaluate
```

Mapped into the runtime:

```text
observe   -> inspect current input, prior observation, and memory surface
orient    -> derive the cycle frame the router will use
decide    -> select the next skill
act       -> execute the selected skill
evaluate  -> normalize outcome, update state, append memory, continue or finish
```

This keeps the loop inspectable without preserving dual execution architectures.

## State Model

`agrun.js` should keep run-scoped and runtime-scoped state separate.

### RunState

`RunState` exists only for the duration of one `run()` call.

Current runtime-level fields include:

```text
RunState
 ├ runId
 ├ status
 ├ mode
 ├ stepCount
 ├ cycleCount
 ├ turnCount
 ├ maxSteps
 ├ phase
 ├ selectedSkill
 ├ lastAction
 ├ availableActions[]
 ├ availableAgentSkills[]
 ├ pendingApproval
 ├ agentSkillContext
 ├ observation
 ├ error
 └ oodae
```

Purpose:

- track the current execution
- record the active cycle and phase
- expose the selected skill or runtime action
- surface pending approval and action/tool-loop context
- record the latest observation and final status

Boundary:

- `RunState` should not hold a second canonical `output` field
- direct execution `output` belongs in `RunResult`
- `observation` is the runtime-owned structure used to update state and decide memory behavior
- compatibility fields such as `mode` help hosts inspect current behavior, but they are not the public architecture contract

### RuntimeState

`RuntimeState` exists for the lifetime of the runtime instance.

Suggested fields:

```text
RuntimeState
 └ lastRun
```

Purpose:

- expose focused instance-level metadata
- avoid turning the runtime into an implicit tracing system

The MVP should not keep full run history in `RuntimeState`.
`lastRun` should remain an instance-level summary rather than a mirror of full `RunState`.

## Memory Store

The MVP memory design is intentionally constrained.

Properties:

```text
append-only
in-memory
runtime-instance scoped
```

Suggested memory entry shape:

```text
MemoryEntry
 ├ timestamp
 ├ skill
 ├ input
 ├ output
 └ metadata
```

The memory store is not:

```text
a database
a vector store
a knowledge graph
```

Its job is to provide a readable append log for later runs and skills.

Write boundary:

- skills should not append directly to the underlying memory store
- `context.memory` should expose read access only
- runtime-owned helpers should accept append requests and normalize them into canonical memory entries

## Observation Model

The runtime should distinguish between:

- `output`: the direct result returned by the skill
- `observation`: the runtime's normalized interpretation of the execution outcome

The runtime uses the observation to:

- update `RunState`
- append memory
- build the final result

This keeps execution output and runtime bookkeeping separate.
In the MVP, failed runs should still produce a failure observation, but they should not append semantic memory entries by default.

## OODAE State

The runtime keeps OODAE explicit in `RunState`.

Suggested fields:

```text
phase
oodae.currentPhase
oodae.cycles[]
```

Each cycle record should contain:

```text
cycle
observe
orient
decide
act
evaluate
```

This is intentionally cycle-scoped and inspectable.
It is not a durable workflow history or replay system.

## Steps Trace

`steps` is a lightweight execution trace for the current run.

It is intended for:

```text
debug
inspection
verification
```

It is not intended to become a general-purpose event bus.

Suggested step shape:

```text
Step
 ├ type
 ├ timestamp
 ├ skill
 └ details
```

Examples:

```text
skill-selected
skill-executed
memory-appended
run-failed
```

Boundary:

- `steps` is transient and run-scoped
- `memory` is semantic and readable across runs

The runtime should avoid duplicating the same payload in both unless needed.

## Run Result

The runtime should return a structured result from `run()`.

Suggested shape:

```text
RunResult
 ├ input
 ├ selectedSkill
 ├ output
 ├ runState
 ├ memoryEntriesAdded
 └ steps
```

Field meaning:

- `input`: original user input
- `selectedSkill`: chosen skill name
- `output`: skill output
- `runState`: final `RunState`
- `memoryEntriesAdded`: entries appended during the run
- `steps`: lightweight execution trace

## Runtime Configuration

The runtime is still created with a small public config surface, but the current MVP already supports a broader internal execution model.

Current public runtime config includes:

```text
RuntimeConfig
 ├ skills
 ├ memory
 ├ sessionStore
 ├ sessionPolicy
 ├ maxSteps
 ├ actionPolicy
 ├ agentSkills
 ├ agentSkillIndexProvider
 └ customActions
```

Notes:

- `skills` is optional and now primarily carries provider adapter wrappers
- `memory` is optional and defaults to the in-memory implementation
- Set A fallback skill-loop exports were removed in v1.0.0; host tools belong in `customActions` / `agentSkills`
- `maxSteps` is part of the current multi-cycle runtime behavior
- `actionPolicy` and `agentSkills` support planner/action-capable turns without creating a second public runtime API

## Failure Model

The runtime should fail predictably.

Failure cases:

- `canHandle(context)` throws
- `execute(context)` throws
- no skill matches and no usable fallback exists

Expected MVP behavior:

- set `RunState.status` to `failed`
- capture an `error`
- record a failure observation
- append a failure step
- return a structured error result

The runtime should not fail silently.

## Design Boundaries

The runtime should not:

```text
contain domain-specific skills
call platform-specific APIs in core modules
let skills mutate router internals
let skills mutate runtime instance state directly
```

This is necessary to keep the runtime portable across browser environments without Node.js assumptions.

## File Boundaries

Top-level boundary (still current):

```text
src/
  runtime/   ← runtime kernel + subsystems (~140 files; see subsystem docs)
  session/   ← session record, compaction, IndexedDB store
  memory/    ← append-only memory store
  skills/    ← bundled built-in skills
  index.js   ← public API surface
```

`index.js` exports public API only. Runtime logic stays inside `src/runtime/`. The original MVP four-file layout (`create-runtime.js` / `runtime-loop.js` / etc.) is **historical** — the kernel split into focused modules per subsystem (planner, action-loop, research, todo, virtual-workspace, etc.). See [`agrun_docs/research-subsystem-decomposition.md`](./research-subsystem-decomposition.md) for one example of how a subsystem is decomposed.

## Summary

The internal architecture of `agrun.js` should remain intentionally small:

```text
Runtime = execution kernel
Skills  = capabilities
Memory  = append-only run log
State   = explicit execution bookkeeping
```

As long as the runtime stays focused on routing, execution, state, and memory, it will remain readable and extensible without turning into a bloated framework.
