# agrun.js System Architecture

> **Last reviewed:** 2026-05-14 against ADR-0023..0029.
>
> This document captures the **canonical system shape** and remains accurate at that level. The major AI-first refactor (ADR-0023, 5/8) deleted 8 push-mode sites from the runtime. For the current decision-ownership boundary between runtime (mechanism + signals) and AI (policy + decisions), read [ADR-0023](./adr/0023-harness-as-tool-provider-only.md). For the long-research mechanism/policy split, read [ADR-0012](./adr/0012-long-research-belongs-to-skill.md).

## Purpose

This document is the canonical top-level system architecture for `agrun.js`.

For host-facing contracts, see:

- `agrun_docs/public-runtime-api.md`
- `agrun_docs/result-schema.md`
- `agrun_docs/webui-integration-contract.md`

`agrun.js` is a browser-first, single-file agent runtime library.
The project should be useful and feature-complete enough for real host integrations while still keeping boundaries clear.

The goal of this architecture is not "as few features as possible".
The goal is a capable runtime with clear boundaries.

If the boundaries stay clear, the system can grow without becoming a framework-sized blob.
If the boundaries blur, the runtime will quickly absorb too much responsibility and become hard to maintain.

## System Positioning

`agrun.js` is not:

- a UI framework
- an LLM framework
- a workflow builder
- a plugin marketplace
- a full-stack AI platform

`agrun.js` is:

- a fully functional agent runtime library
- a skill-based and action-capable execution engine
- a single-file browser runtime with host-facing contracts

It may also bundle local agent instruction packages from `skills/*/SKILL.md` at build time.
Those are browser-safe because they are bundled ahead of runtime, not loaded from the filesystem in the browser.

Its core job is simple:

```text
accept input
select capability
execute capability
record result
update state
```

Core principle:

```text
Runtime runs.
Skills provide capability.
```

Current bounded extension note:

```text
Runtime actions may exist for runtime-owned operations such as planning, approval, web search, and direct URL reading.
Those actions are not normal executable skills.
```

Direction note:

```text
Do not keep a separate legacy skill loop.
Prefer one runtime loop with clear extension points.
```

## Three-Layer Architecture

`agrun.js` should stay split into three layers:

```text
Client Layer
  ↓
Runtime Kernel
  ↓
Skill System
```

These layers must remain separate.

### 1. Runtime Kernel

The kernel is the unified execution core.

It is responsible for:

```text
receive input
normalize input
select skill
execute skill
derive observation
update state
append memory
assemble result
```

It must not collapse every concern into one undifferentiated layer such as:

```text
a planner
a capability toolbox
a workflow engine
a policy engine
a provider integration layer
```

Bounded exception:

The runtime kernel may own a bounded action surface when the operation requires runtime-owned coordination rather than ordinary skill selection.
Current examples include planner-selected `web_search`, `read_url`, approval handling, and bundled agent-skill activation.
Those remain kernel-owned because they update runtime policy state, research evidence, or other runtime-managed context.

### 2. Skill System

The skill system is the capability layer.

Examples:

```text
echo-skill
memory-skill
file-skill
web-request-skill
search-skill
```

The runtime decides which skill executes.
The skill decides what behavior runs and what output it returns.

Important current boundary:

- `read_url` is not a skill in `src/skills/*.js`
- `read_url` is a planner-facing runtime action in `src/runtime/actions/read-url-action.js`
- helper modules under `src/skills/providers/` may be reused by runtime actions without reclassifying the feature as a skill

### 3. Client Layer

The client layer is the external entry surface.

Examples:

```text
browser chatbox UI
debug panel
test runner
host page adapter
```

The client layer may present results, collect input, or integrate with a host environment.
It must not leak those concerns into runtime core modules.

## Runtime Kernel Boundary

The `Runtime Kernel` is the layer that most needs discipline.

It should own:

- the execution loop
- runtime state progression
- skill routing
- skill execution coordination
- observation normalization
- memory append orchestration
- final result assembly

In the current codebase, this also includes bounded runtime-owned action coordination for:

- planner-visible action registration
- action policy evaluation
- approval blocking and resume
- research evidence accumulation for `web_search` and `read_url`

The runtime kernel should not split into multiple long-term execution architectures such as:

- a legacy skill loop
- a separate planner loop with duplicated lifecycle responsibilities

It should not own:

- domain logic
- direct search/file/network behavior
- direct LLM provider calls in core modules
- workflow graph logic
- approval or planner behavior as a separate platform layer

Clarification:

- the runtime may orchestrate provider-backed planning/finalization and runtime-owned actions
- but it should not turn every domain capability into a new core action when a normal skill or adapter boundary would be sufficient

If a new feature can be implemented as a skill, adapter, or client integration, it should not be added to runtime core first.

## Skill System Boundary

Skills are registered capability modules.

Each skill should answer two questions:

```text
Can I handle this input?
What output do I produce if selected?
```

The skill contract is:

```text
name
canHandle(context)
execute(context)
```

Skills are responsible for:

- determining fit
- performing capability logic
- returning output

Skills are not responsible for:

- defining the runtime loop
- defining `RunState`
- defining the canonical memory schema
- mutating runtime internals
- tightly coupling to other skills

Important rule:

```text
Routing belongs to runtime.
```

`router-skill` or `planner-skill` patterns should not become part of the MVP runtime model.

## Client Layer Boundary

The client layer may call the runtime, but it does not own runtime internals.

For the MVP, the public execution surface should stay narrow:

```js
const runtime = createRuntime({ skills, fallbackSkill });
const result = await runtime.run(input);
```

The runtime constructs skill `context` internally.
Callers do not pass runtime-owned fields such as:

- `helpers`
- `memory`
- internal `state`
- router configuration for a single run

If future versions need per-run caller options, that surface should be a separate caller-owned options object rather than a raw runtime context override.

## System Data Flow

The standard flow should be:

```text
Client receives user input
↓
Client calls Runtime
↓
Runtime normalizes input
↓
Skill Router selects matching skill
↓
Runtime executes skill
↓
Skill returns output
↓
Runtime derives observation
↓
Runtime updates state
↓
Runtime appends memory entry
↓
Runtime returns result
↓
Client presents result
```

Provider-backed research-style turns currently extend that flow as:

```text
Client receives provider-backed request
↓
Client calls Runtime
↓
Runtime normalizes input
↓
Runtime checks for direct skill match
↓
If no direct skill matches, planner selects a runtime action
↓
Runtime executes action such as web_search or read_url
↓
Runtime stores structured research evidence
↓
Runtime finalizes the user answer with that evidence (streaming tokens if onToken provided)
↓
Client presents result (incrementally if streaming, otherwise on completion)
```

There should be one canonical runtime flow.
If compatibility code still exists for an older `legacy skill loop`, that code should be treated as temporary migration logic rather than a supported architectural boundary.

Important distinction:

- `output` is the direct result returned by the skill
- `observation` is the runtime's normalized interpretation of that execution result

These must stay separate so the runtime can own state updates, memory append behavior, and result normalization.

## Streaming (AGRUN-104)

Token-level streaming applies only to the **finalize phase** — the final answer generation to the end user.

### Scope

```text
OODAE Cycle:  discrete step callbacks (onStep) — no streaming
Finalize:     token streaming (onToken) — opt-in callback
```

The OODAE loop phases (observe/orient/decide/act) produce structured outputs (JSON decisions, tool calls). Streaming partial JSON is meaningless and would break the harness control model. Only the finalize phase generates free-form text suitable for incremental display.

### Design Principles

1. **Opt-in callback** — `onToken` is an optional callback on `runtime.run()` / `session.run()`. If not provided, behavior is identical to the current blocking model. Return value shape does not change.
2. **Provider layer isolation** — Streaming is implemented via `streamText()` from Vercel AI SDK (`ai` + `@ai-sdk/openai` + `@ai-sdk/google`). Non-streaming uses `generateText()`. Both return the same response shape to the runtime.
3. **Harness control preserved** — The step callback mechanism (`onStep`) is unchanged. Token streaming runs in parallel as a separate channel during finalize only.
4. **Cancel via AbortController** — Host can pass `AbortController` signal to abort mid-stream. Already-received tokens are preserved as partial output.

### Not in Scope

- Streaming during planner/action phases (structured outputs, not free text)
- AsyncIterable return types (would break `runtime.run()` contract)
- `toUIMessageStream()` or similar protocol adapters (browser layer owns rendering)

### Callback Contract

```js
runtime.run(input, {
  onStep(step, snapshot) { /* existing — discrete phase events */ },
  onToken(token) { /* new — string delta during finalize */ }
})
```

`onToken` is called zero or more times during finalize. After all tokens are delivered, `onStep("provider-responded", ...)` fires as before, and `runtime.run()` resolves with the complete result.

## AI-First Tool Selection

Since the AI-first refactor (AGRUN-129), **all tool and action selection goes through the LLM planner**. There are no hardcoded regex patterns that bypass the planner.

Removed:
- `direct-tool-candidate.js` — regex detection for time/date queries
- `direct-tool-terminal.js` — hardcoded early-exit for worldtime tool
- `prefer_direct_tool` guardrail — forced time/date tool over planner choice
- `NEWS_INTENT_PATTERN` / `TIME_QUERY_PATTERNS` — skill `canHandle()` regex
- Keyword-based web search fallback (`boss|director|company|singapore`)

Retained:
- `clarification_gate` execution class — forces clarification when required info is missing
- `finalize_to_clarify` / `clarify_to_finalize` guardrails — safety nets
- Research continuity state — legacy/simple auto-read may still exist, but
  ADR-0012 long research must not use runtime-synthesized research actions
- Consecutive failure guard — prevents infinite retry loops

The planner always sees all available tools via `resolveSkillActionSurface() → "full"`, including bundled skill tools like `worldtime_tz`. The planner selects them through native tool calling (AI SDK `generateText` with `toolChoice`).

## Anti-Overengineering Guardrails

The architecture should prefer one small runtime flow over multiple semantic control layers.

Rules:

- do not add a required semantic pre-pass before planner execution
- do not add hardcoded regex shortcuts that bypass the planner for specific query types
- do not duplicate `goal`, `topic`, or `clarification` truth across multiple state layers
- do not let debug projections become runtime control truth
- do not add new kernel abstractions when a small skill, adapter, or bounded runtime action is enough

The runtime should not maintain several independent semantic truths such as:

- one truth for continuity
- one truth for planner
- one truth for evaluation
- one truth for debug

There should be one canonical continuity source, and other views should be derived from it.

## Prevent Lost Direction

The system should preserve direction before preserving volume.

The most important continuity fields are:

- `activeGoal`
- `activeTopic`
- `activeQuery`
- `pendingClarification`
- `lastClarificationResolution`
- `selectedSource`
- `lastReadSource`

If context must be compacted or degraded, protect those fields before:

- older transcript
- low-value generic memory
- compatibility/debug-only projections

Direction rule:

```text
Do not preserve more context.
Preserve the most important direction.
```

## Clarification As Last Resort

Clarification is allowed, but it must stay a last resort.

The runtime should not ask for clarification when:

- the missing input is optional
- a safe direct tool path already exists
- a reasonable default can be applied without changing the meaning of the task

Clarification is justified only when the missing information would materially block correct execution or force the runtime to choose between meaningfully different paths.

This rule exists to prevent:

- clarification abuse
- simple requests being over-processed
- planner loops that ask instead of act
- direction drift caused by premature ambiguity modeling

## State And Memory Model

The MVP should keep state intentionally small.

There are two main runtime-owned data structures:

### Run State

`RunState` is per-run and ephemeral.

Suggested fields:

```text
runId
status
stepCount
selectedSkill
observation
error
```

It exists only to track the current run.
`RunState` should not own a separate canonical `output` field in the MVP.
The skill's direct `output` belongs in `RunResult`, while `observation` is the runtime-owned structure used for state and memory work.

### Runtime State

`RuntimeState` is runtime-instance scoped.

Suggested fields:

```text
lastRun
```

It should stay focused and should not become full run history.
`lastRun` is a runtime-instance summary, not part of the current `RunState`.

### Memory

MVP memory should be:

```text
append-only
in-memory
runtime-instance scoped
```

The purpose of memory is not to become a database or knowledge graph.
Its purpose is to preserve a focused semantic log across runs.

Memory ownership rule:

```text
The runtime owns the canonical memory entry shape.
```

Skills may read memory through `context.memory.readAll()`.
Skills may request a memory append only through `helpers.appendMemory(entry)`.
The runtime is responsible for normalizing that request into the canonical stored memory entry.

This keeps schema ownership in the runtime while still allowing skills to trigger useful memory writes.
Not every run event should become semantic memory.
In the MVP, failed runs should remain visible through `error`, `observation`, `steps`, and `lastRun`, but should not append semantic memory entries by default.

## Routing Model

The MVP routing strategy should stay deterministic:

```text
first match
```

Algorithm:

```text
for skill in skills
  if skill.canHandle(context)
     return skill
```

If no skill matches:

```text
use fallback skill
```

Routing extensions such as:

```text
priority routing
score routing
model-assisted routing
```

are future router strategies, not new skill categories.

## Failure Model

The architecture must define predictable failure behavior.

MVP failure cases:

- `canHandle(context)` throws
- `execute(context)` throws
- no skill matches and no usable fallback exists

Required runtime behavior:

- set `RunState.status` to `failed`
- capture a structured `error`
- derive a failure observation
- append a failure step to the trace
- return a structured error result

The runtime should never fail silently.

## Extension Model

`agrun.js` should grow at the edge, not in the kernel.

Preferred extension points:

- new skills
- new adapters
- new client integrations
- runtime-owned actions only when the capability must own runtime policy, approval, evidence state, or bundled agent-skill coordination

Examples:

```text
file access skill
search skill
persistent memory adapter
browser UI integration
embedded page integration
```

Current architecture note:

- generic end-user capabilities should still default to skills or adapters
- `read_url` is a justified runtime action because it participates in planner selection, policy gating, approval resume, and `researchContext.readSources`
- that does not make "URL reading" the default pattern for all future capabilities

The default extension move should be:

```text
add edge capability
not kernel complexity
```

## Build And Cross-Environment Architecture

`agrun.js` has two structural goals:

### Development Structure

Use multiple small source modules.

Why:

- easier to read
- easier to test
- easier to keep under the 300-line guidance

### Distribution Structure

Ship a single JavaScript file:

```text
dist/agrun.js
```

This means:

```text
modular in development
single-file in distribution
```

The runtime must also remain portable:

- no DOM dependency in runtime core
- no Node-only API in runtime core
- platform-specific behavior belongs in skills or adapters

## Design Principles

The system architecture can be summarized in six rules:

1. Keep the runtime focused and internally coherent.
2. Push capability into skills.
3. Routing belongs to runtime.
4. The runtime owns state and memory structure.
5. Grow at the edge, not in the kernel.
6. Stay domain-neutral.

### Stay Domain-neutral

`agrun.js` is a generic agent runtime consumed by many different host
applications (ERP, CRM, developer tools, research assistants, etc.).
Runtime code and bundled skills must not encode assumptions that are
only true for one host's domain.

Concretely:

- Do not add regexes, keyword lists, entity detectors, or prompt
  fragments that reference domain-specific concepts (customers,
  invoices, tickets, patients, etc.).
- Do not tune default thresholds, classifications, or filters to the
  needs of a single host. Defaults must be defensible for any host.
- The sensitive-content filter in global memory intentionally covers
  only universal credential patterns (api keys, tokens, passwords,
  bearer strings). PII and business-data redaction is a host policy,
  not a runtime policy.
- When a host surfaces a domain-specific need (ERP wants to redact
  customer names; a medical host wants to redact PHI), the answer is
  a **host hook** — a host-supplied callback the runtime invokes at a
  defined extension point. The runtime owns the mechanism; the host
  owns the policy.
- Prefer one generic hook over many specific flags. A single
  `sensitivityFilter(entry) => boolean` is better than
  `filterCustomerNames`, `filterInvoiceNumbers`, etc.
- If a fix feels like it would help one host but make the runtime
  weirder for all others, it belongs in the host, not in `agrun.js`.

This rule also applies in reverse: do not strip generic capability
from the runtime because one host does not need it. Generic means
useful to the set of hosts, not the intersection.

When rule 2 and current implementation appear to conflict, prefer this interpretation:

- use skills by default
- use runtime actions only for capabilities that must participate in runtime-owned planner, policy, approval, or evidence bookkeeping

## Post-MVP Evolution

The preferred order of growth is:

1. add more skills
2. add cleaner adapters
3. add tracing and logging hooks
4. add richer routing strategies
5. keep advanced planner, approval, and action behavior bounded inside the unified runtime instead of turning it into a new public platform layer

This order matters.

The current codebase already includes advanced runtime behavior such as planner/action execution and approval resolution.
Those features should be treated as bounded extensions inside the same runtime kernel, not as permission to grow multiple parallel runtime architectures or a framework-sized platform surface.

## Summary

`agrun.js` should remain a small system with clear ownership:

```text
Runtime Kernel = execution
Skill System   = capability
Client Layer   = integration
```

When extending the system, the default question should be:

```text
Should this be a skill?
Should this be an adapter?
Should this stay outside runtime core?
```

If those questions stay in place, `agrun.js` can remain small, stable, and readable while still evolving over time.

## Fetch Resilience Model

All external HTTP calls are protected by the modular `fetch-resilience.js` module (`src/skills/providers/fetch-resilience.js`). This avoids duplicate timeout/retry logic across providers.

### Shared Utilities

```text
fetchWithTimeout(fetch, url, init, opts)   — single fetch + AbortController timeout
fetchWithRetry(fetch, url, init, opts)     — timeout + exponential backoff retry
withDeadline(ms)                           — multi-step operation deadline
```

### Default Configuration

```text
Web search (SearXNG / Gemini grounding)   15 s timeout, 1 retry
LLM API (Gemini / OpenAI)                 60 s timeout, 1 retry
URL reader                                10 s timeout, 1 retry (action level)
Web search multi-pass deadline            45 s total
```

### Design Rationale

- **Modular**: Any new provider or action can import `fetchWithRetry` or `withDeadline` without reimplementing resilience
- **Cascading signals**: `withDeadline` produces an `AbortSignal` that propagates to all child fetches
- **Graceful degradation**: Multi-pass web search preserves partial results when the deadline expires
- **Configurable**: Each call site can override `timeoutMs` via request args; hosts can tune per deployment

For implementation details, see `agrun_docs/error-handling-and-recovery.md` → "Fetch Resilience".

## AI SDK Integration

LLM provider calls use the Vercel AI SDK (`ai` + `@ai-sdk/google` + `@ai-sdk/openai`) instead of raw `fetch`.

### Provider Modules

| Module | SDK Used | Purpose |
|--------|----------|---------|
| `gemini-browser.js` | `@ai-sdk/google` via `generateText` / `streamText` | Planner + finalize calls |
| `openai-browser.js` | `@ai-sdk/openai` via `generateText` / `streamText` | Planner + finalize calls |
| `gemini-grounding.js` | Raw `fetch` (unchanged) | Web search grounding (google_search tool) |

### Why AI SDK for LLM, Raw Fetch for Grounding

- LLM calls benefit from AI SDK's unified tool calling, streaming, retry, and error handling
- Gemini grounding uses a specialized `google_search` tool format that the AI SDK does not expose `groundingMetadata` for — raw fetch is needed to access `groundingChunks` and `webSearchQueries` directly

### Tool Schema Format

AI SDK v6 uses `inputSchema` (not `parameters`) with `jsonSchema()` wrapper:

```js
tools: {
  web_search: {
    description: "Search the web",
    inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] })
  }
}
```

Tool call results use `call.input` (not `call.args`) and are converted to the agrun `{ name, arguments }` format.

### Bundle

The AI SDK is bundled into `dist/agrun.js` via `@rollup/plugin-node-resolve` + `@rollup/plugin-commonjs`. Zero external runtime dependencies.

## Gemini Grounding: Synthetic Fallback

Since mid-2025, Gemini's `google_search` grounding no longer returns `groundingChunks` with source URLs. The model searches and answers, but does not expose clickable links.

`gemini-grounding.js` detects this and builds **synthetic items** from the model's text answer and `webSearchQueries`. The ranking pipeline (`web-search-ranking.js`) accepts items with `snippet` even without `url`, and `hasUsableSearchEvidence()` treats them as valid evidence.

This prevents the planner from endlessly retrying a search that structurally cannot return URLs.

## Production Deployment Model

`agrun.js` is a **browser-first runtime library**. It does not own API key management or credential security.

In production deployments, the host application is responsible for:

```text
API key storage and rotation       → backend (PHP, Node.js, Go, etc.)
Provider API proxying              → backend reverse proxy
Rate limiting and quota management → backend middleware
Credential injection               → backend-to-frontend secure channel
```

`agrun.js` runtime receives provider credentials from the host at configuration time. It does not persist, encrypt, or manage those credentials.

This means:

- Browser-side API keys during development are expected (local dev convenience only)
- Production systems must proxy provider calls through a backend that owns the keys
- `agrun.js` does not add key sanitization, encryption, or vault integration — that is the host's responsibility
- Error objects and continuation state may contain request metadata; the host backend should strip sensitive data before logging

```text
Development:  Browser → Provider API (direct, dev keys in settings)
Production:   Browser → Host Backend (proxy) → Provider API (backend keys)
```

This boundary keeps `agrun.js` focused on runtime execution and avoids duplicating security infrastructure that every production backend already provides.
