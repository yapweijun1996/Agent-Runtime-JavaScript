# agrun.js MVP

## Summary

`agrun.js` is a browser-first JavaScript agent runtime library.

It ships as a single bundled file:

```text
dist/agrun.js
```

The public entrypoint remains:

```js
const runtime = createRuntime(options);
```

The current MVP is already a shipped, working library.
It is a fully functional browser-first agent runtime, not just a skill runner.
The current baseline includes a unified runtime, multi-cycle execution, session-backed continuity, planner/action-capable turns, approval resolution, and bundled agent instruction packages while still staying browser-only and single-file.

For exact contracts, see:

- `agrun_docs/spec.md`
- `agrun_docs/public-runtime-api.md`
- `agrun_docs/result-schema.md`
- `agrun_docs/webui-integration-contract.md`
- `agrun_docs/action-contract.md`
- `agrun_docs/agent-skills.md`

## Product Position

`agrun.js` is:

- a fully functional agent runtime library
- browser-targeted at runtime
- skill-first in capability design
- packaged as a single JavaScript bundle
- suitable for host UIs that need structured results, traceable execution, approval-aware flows, bundled agent skills, and session continuity

The current MVP includes first-class agent runtime behavior:

- one unified `runtime.run(input)` entrypoint
- multi-cycle execution bounded by `maxSteps`
- planner/action execution for provider-style turns
- approval resolution inside the same runtime contract
- bundled agent instruction packages for tool-loop flows
- session-backed multi-turn history and semantic memory

`agrun.js` is not:

- a multi-agent orchestration platform
- a subagent handoff network
- a workflow engine
- a plugin marketplace
- a full-stack AI platform
- a Node.js runtime target

Direction note:

- keep one runtime loop as the long-term architecture
- keep planner/action and approval handling inside that unified loop
- keep skill priority ahead of provider/tool-loop routing
- treat compatibility fields such as `mode` as metadata, not the product control surface

## Current MVP Scope

### In Scope

1. Runtime creation and inspection
   - `createRuntime(options)`
   - `runtime.getState()`
   - `runtime.getMemory()`
   - `runtime.getAgentSkills()`
   - required `skills`
   - optional `memory`, `fallbackSkill`, `sessionStore`, `sessionPolicy`
   - advanced runtime config such as `maxSteps`, `actionPolicy`, and bundled `agentSkills`

2. Unified run entry
   - `runtime.run(input)`
   - text-like input
   - structured object input
   - provider-style input
   - approval-resolution input
   - skill-first routing with planner/action fallback when appropriate

3. Session APIs and continuity
   - `runtime.createSession(options?)`
   - `runtime.openSession(sessionId)`
   - `session.run(input)`
   - `session.getHistory()`
   - `session.getMemory()`
   - `session.getState()`
   - session-scoped history, summaries, and semantic memory

4. Multi-cycle and action-capable runtime behavior
   - multi-cycle execution bounded by `maxSteps`
   - OODAE-style traceable execution state
   - planner/action-capable turns for provider-backed requests
   - approval-aware blocked states and resume flow
   - bundled agent skills available to the tool-loop path

5. Structured run results
   - `output`
   - `error`
   - `steps`
   - `runState`
   - `memoryEntriesAdded`
   - `finalAnswerSource`
   - compatibility fields such as `mode` and `normalizedInput`

6. Host-facing browser integration support
   - structured result envelopes
   - step traces for activity derivation
   - approval-capable UI states
   - documented Web UI and result contracts

7. Single-file distribution and verification
   - build output at `dist/agrun.js`
   - smoke-test coverage
   - browser example application

### Out of Scope

- multi-agent orchestration
- subagent handoff networks
- framework-sized workflow modeling
- persistent database-backed memory as the core MVP storage model
- public planner/router runtime APIs
- server-only or non-browser runtime targets
- dynamic plugin marketplaces or runtime package loading
- treating `tool_loop` / `skill_loop` as long-term public architecture modes

## Current MVP Behavior

The current MVP proves that the library can:

- create a runtime instance from a small config object
- accept different turn input shapes through one public `run(input)` API
- route first through registered executable skills
- continue into planner/action execution for provider-style turns when no direct skill match exists
- execute multi-cycle runs up to `maxSteps`
- return structured, UI-consumable results instead of raw execution output
- persist multi-turn session history and semantic session memory
- expose read-only state, memory, and bundled agent skill inspection APIs

At a high level:

```js
const runtime = createRuntime({
  skills: [echoSkill, memorySkill, fallbackSkill]
});

const result = await runtime.run("remember: ship the MVP");
```

Baseline result shape:

```js
{
  input,
  normalizedInput,
  selectedSkill,
  output,
  error,
  memoryEntriesAdded,
  steps,
  runState,
  finalAnswerSource,
  mode
}
```

This document stays high-level.
For exact field contracts, use `agrun_docs/result-schema.md`.

## Getting Started

### 1. Install dependencies

At the repo root:

```bash
npm install
```

If you also want to run the browser example:

```bash
cd examples/browser
npm install
```

### 2. Build and verify

At the repo root:

```bash
npm run check
```

That command builds `dist/agrun.js` and runs the smoke suite.

### 3. Use a simple runtime setup

```js
import {
  createRuntime,
  echoSkill,
  fallbackSkill,
  memorySkill
} from "../dist/agrun.js";

const runtime = createRuntime({
  skills: [echoSkill, memorySkill, fallbackSkill]
});

const result = await runtime.run("hello agrun");

console.log(result.output);
console.log(runtime.getState().lastRun);
console.log(runtime.getMemory().readAll());
```

### 4. Use a session when you need continuity

```js
const session = await runtime.createSession();

await session.run("remember: ship the MVP");
const followUp = await session.run("what should we remember?");

console.log(followUp.output);
console.log(await session.getHistory());
console.log(await session.getMemory());
```

### 5. Run the browser example

From `examples/browser`:

```bash
npm run dev
```

Then open the local Vite URL in a browser.

## Current High-Level Structure

The repo is organized around a small runtime core plus browser-facing examples and contracts:

```text
src/
  index.js
  runtime/
  skills/
  memory/
  session/

agrun_docs/
  mvp.md
  spec.md
  public-runtime-api.md
  result-schema.md
  webui-integration-contract.md
  action-contract.md
  agent-skills.md

dist/
  agrun.js

examples/
  browser/

test/
  smoke.test.js
```

This layout is descriptive of the current library, not a speculative future structure.

## Current MVP Acceptance Criteria

The current MVP is successful if:

- a developer can create a runtime with registered skills and optional sessions
- `runtime.run(input)` returns a structured result envelope for normal, provider-style, and approval-resolution turns
- session handles can persist history and semantic memory across turns
- the runtime can complete or fail multi-cycle execution predictably within `maxSteps`
- the bundle builds to `dist/agrun.js`
- the runtime works in browser-targeted integrations
- hosts can consume the documented result and Web UI contracts without depending on planner internals or `mode`

## What This MVP Already Proves

- a small JavaScript agent runtime library can stay readable while still exposing structured execution state
- skills remain the main capability layer even when the runtime supports provider/action flows
- provider-backed, approval-capable, and session-backed turns can still fit inside one public runtime surface
- host UIs can build on returned results, debug snapshots, and step traces without reaching into runtime internals
- bundled agent instructions can extend tool-loop behavior without turning the runtime into a multi-agent platform

## Next Direction

The next engineering direction is internal convergence and maintainability, not broadening the public surface.

- keep `runtime.run(input)` as the single host entrypoint
- keep skill priority ahead of planner/action routing for provider-shaped inputs
- keep approval resolution inside the same runtime entry contract
- keep session continuity as a host-facing feature, not a separate runtime mode
- retain compatibility `mode` values only as result metadata
- prefer refactoring, module boundaries, and file-size control over expanding public planner APIs

## Risks

### Risk 1: Runtime scope grows into a platform

Mitigation:

- keep public APIs small
- keep architecture boundaries in `agrun_docs/spec.md`
- push capability into skills, actions, or host adapters before expanding runtime core

### Risk 2: Compatibility details become architecture commitments

Mitigation:

- document transitional fields as compatibility-only
- avoid teaching new integrations to branch on `mode`
- keep host integrations aligned to `runState.status`, `pendingApproval`, `output`, and `steps`

### Risk 3: Agent-like features get overstated as multi-agent support

Mitigation:

- describe planner/action flows as limited runtime-owned behavior
- keep multi-agent orchestration and subagent handoff explicitly out of scope
- keep `agrun_docs/agent-skills.md` separate from executable runtime skill docs

### Risk 4: Browser scope drifts toward non-browser assumptions

Mitigation:

- keep runtime behavior browser-safe
- keep the distributed artifact as a single JavaScript bundle
- avoid adding Node.js-only runtime requirements to the library contract
