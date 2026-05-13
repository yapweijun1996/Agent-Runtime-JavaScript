# agrun.js Skill System Architecture

## Purpose

This document defines the MVP skill system for `agrun.js`.
It refines the top-level system boundaries defined in `agrun_docs/spec.md` and focuses only on the skill layer.

It does not define the planner-driven tool-loop action surface.
That contract lives in `agrun_docs/action-contract.md`.

It also does not define bundled agent instruction packages from `skills/*/SKILL.md`.
That contract lives in `agrun_docs/agent-skills.md`.

The runtime is intentionally focused. Skills remain the main capability model of the system.

In this document, "skill" means executable runtime skill objects in `src/skills/*.js`.

Core principle:

```text
Push capability into skills.
Keep the runtime focused.
```

## Role of the Skill System

The runtime decides:

```text
which skill executes
when it executes
how the result is recorded
```

The skill decides:

```text
what capability is performed
what domain logic runs
what output is produced
```

Architecture:

```text
Runtime
  ↓
Skill Router
  ↓
Skill
  ↓
Output
```

## Skill Design Principles

### Small

A skill should stay focused on one capability.

Examples:

```text
echo-skill
memory-skill
web-request-skill
file-skill
```

A skill should not become a mini framework.

### Independent

Skills should be isolated from each other at the architecture level.

Rules:

- a skill should not call another skill directly
- a skill should not depend on runtime internals
- a skill may use shared utilities or adapters that are not other skills

The runtime remains the orchestrator.

### Stateless

A skill should not own mutable runtime state.

Cross-run or execution state should come from:

```text
context.state
context.memory
```

Read-only configuration or injected utilities are acceptable. What matters is that skills do not become private state containers for the runtime.

## Skill Contract

Each skill should follow the same MVP contract:

```text
name
canHandle(context)
orient(context)? 
execute(context)
evaluate(context)?
```

Field meaning:

| Field     | Purpose                                  |
| --------- | ---------------------------------------- |
| name      | skill identifier                         |
| canHandle | whether the skill matches                |
| orient    | optional selected-skill orientation hook |
| execute   | perform the skill behavior               |
| evaluate  | optional selected-skill evaluation hook  |

Rules:

- `orient(context)` is optional
- `evaluate(context)` is optional
- both hooks run only for the selected skill
- both hooks may return structured records for the current OODAE cycle
- hooks must not directly mutate runtime state

## Skill Lifecycle

Inside the runtime, a skill moves through:

```text
registered
↓
selected
↓
executed
↓
observed
```

This lifecycle should stay explicit and inspectable for the MVP.

## Skill Router Boundary

The `Skill Router` is a runtime component, not a skill.

Its job is:

```text
choose skill
```

Input:

```text
input
context
skills
```

Output:

```text
selectedSkill
```

MVP routing strategy:

```text
first match
```

Logic:

```text
for skill in skills
  if skill.canHandle(context)
     return skill
```

If no skill matches:

```text
fallback skill
```

Future routing strategies such as priority or scoring remain router concerns, not skill categories.

## Skill Context

The only runtime-to-skill interface is `context`.

Suggested shape:

```text
context
 ├ input
 ├ state
 ├ memory
 ├ config
 └ helpers
```

Field meaning:

| Field   | Meaning                    |
| ------- | -------------------------- |
| input   | current input              |
| state   | current run state          |
| memory  | read-only memory interface |
| config  | runtime config             |
| helpers | narrow runtime capabilities |

`helpers` should stay intentionally small.

Suggested MVP helper surface:

```text
appendMemory
log
```

Rules:

- skills interact with the runtime only through `context`
- helpers expose stable capabilities, not internal runtime objects
- helpers should not allow router mutation
- helpers should not allow direct runtime instance state mutation
- `helpers.appendMemory(entry)` is the only MVP write path into runtime memory
- `context.memory` is read-only and should expose read methods such as `readAll()`

## Skill Execution

After the router selects a skill, the runtime may perform:

```text
skill.orient(context)
↓
skill.execute(context)
↓
skill.evaluate(context)
```

`orient(context)` receives the selected-skill context before execution and may return a skill-specific orientation record.

`evaluate(context)` receives the selected-skill context after the runtime has derived an observation and may return a skill-specific evaluation record.

The required execution step remains:

```text
skill.execute(context)
```

The skill returns an `output`.

The runtime then derives an `observation` from the execution outcome and uses it to:

```text
update state
append memory
build result
```

This keeps skill behavior separate from runtime bookkeeping.

## Memory Interaction

A skill may use memory through `context.memory`.

Suggested MVP read operations:

```text
readAll()
```

MVP memory behavior:

```text
append-only
in-memory
simple read semantics
```

Rules:

- the runtime owns the overall memory entry contract
- skills should request memory writes through `helpers.appendMemory(entry)`
- the runtime should normalize those requests into the canonical stored entry shape
- advanced query behavior is out of scope for MVP

## Skill Categories

As the system grows, skills may fall into categories such as:

### Interaction Skills

```text
echo-skill
chat-skill
```

### Memory Skills

```text
memory-skill
recall-skill
```

### Tool Skills

```text
web-request-skill
file-skill
search-skill
```

These categories describe capability type only. They do not change the runtime contract.

## Skill Registry

For the MVP, the skill registry is simply the runtime's registered skill list.

At runtime creation:

```text
createRuntime({
  skills: [...]
})
```

The router scans that registered list during execution.

The MVP does not need a more complex registry component until explicit lifecycle operations such as dynamic add, remove, or replace are introduced.

## Failure Handling

The skill system must define predictable failure behavior.

Failure cases:

- `canHandle(context)` throws
- `execute(context)` throws
- no skill matches and no valid fallback exists

Expected MVP behavior:

- mark the current run as `failed`
- record a failure observation
- append a failure step in the execution trace
- return a structured error result instead of failing silently

## Skill Isolation

Skills should not:

```text
modify runtime internals
access internal modules directly
call other skills directly
```

All interaction should go through:

```text
context
```

This provides:

- maintainability
- testability
- reuse

## Summary

The skill system should preserve a clean separation:

```text
Runtime = execution engine
Skills  = capabilities
```

The runtime is responsible for:

```text
routing
execution
state
memory
```

Skills are responsible for:

```text
behavior
actions
domain logic
```

When the system grows, the default move should be:

```text
add skills
not runtime complexity
```
