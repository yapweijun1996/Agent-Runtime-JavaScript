# OpenClaw To agrun Mapping

## Purpose

This document answers one narrow question:

> What logic should `agrun.js` study from `openclaw-2026.3.8`, and what should it explicitly avoid copying?

This is a study-and-adapt guide, not an implementation template.

Use it together with:

- `agrun_docs/sample-reference-guide.md`
- `agrun_docs/runtime-state-and-memory-architecture.md`

## Suitability

`OpenClaw` is suitable for `agrun.js` mainly as a reference for:

- context window discipline
- long-run continuity without drift
- memory injection versus recall boundaries
- deterministic compaction and degradation

`OpenClaw` is not suitable as a full architecture template for `agrun.js`.

Do not copy:

- platform-scale context-engine APIs
- multi-agent lifecycle and routing
- gateway/session hosting logic
- provider-specific thinking matrices
- large product prompt-assembly pipelines

## Best Logic To Learn

### 1. Direction-first context

What to learn:

- treat current direction as first-class context
- protect the active goal, topic, query, and unresolved clarification before protecting older transcript
- preserve direction even when the prompt must shrink

Map to `agrun.js`:

- `src/session/context-window-plan.js`
- `src/session/compaction.js`
- `src/session/session-memory.js`
- `src/runtime/inquiry-context-resolution.js`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`

Do not copy:

- a general-purpose context-engine layer with plugin-style prompt segments

### 2. Tiered context assembly

What to learn:

- build the prompt from explicit tiers instead of a flat history dump
- keep stable instructions separate from continuity context
- separate current working context from older historical context

Suggested agrun tiers:

- instructions
- inquiry context
- confirmed memory
- summary
- recent turns
- selected or last-read source

Map to `agrun.js`:

- `src/session/compaction.js`
- `src/session/context-window-plan.js`
- `agrun_docs/runtime-state-and-memory-architecture.md`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/legacy.ts`

Do not copy:

- OpenClaw's full prompt-builder surface and legacy compatibility layers

### 3. Budget-first prompt control

What to learn:

- estimate prompt size before sending
- compact only when needed
- keep compaction behind a narrow boundary

Map to `agrun.js`:

- `src/session/token-budget.js`
- `src/session/policy.js`
- `src/session/compaction.js`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/legacy.ts`

Do not copy:

- context-engine configuration sprawl
- product-level policy knobs that exceed current `agrun.js` needs

### 4. Priority-preserve compaction

What to learn:

- shrink low-value context first
- preserve direction before details
- use deterministic degradation order

Good agrun degradation order:

- drop low-value free memory
- drop older history
- trim recent turns
- compress summary
- fail if direction still does not fit

Map to `agrun.js`:

- `src/session/context-window-plan.js`
- `src/session/compaction.js`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/legacy.ts`

Do not copy:

- large opaque compaction pipelines that are hard to inspect in browser debug

### 5. Structured summary instead of free-text drift

What to learn:

- summaries should preserve task direction, not just compress text
- summary should have stable headings so later prompt assembly is predictable

Good agrun summary fields:

- current goal
- current topic
- constraints
- confirmed facts
- decisions
- open questions
- next step

Map to `agrun.js`:

- `src/session/compaction.js`
- `agrun_docs/runtime-state-and-memory-architecture.md`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`

Do not copy:

- provider-specific reasoning summaries
- user-visible thinking dumps as summary storage

### 6. Injected memory versus recall-only memory

What to learn:

- not all memory should be injected every turn
- keep a small injected layer for continuity
- keep larger or less certain memory behind on-demand recall

Good agrun split:

- injected: current goal/topic/query, pending clarification, confirmed decisions/preferences/facts
- recall-only: older semantic memory not needed every turn

Map to `agrun.js`:

- `src/session/session-memory.js`
- `agrun_docs/runtime-state-and-memory-architecture.md`
- `src/memory/store.js`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/memory/index.ts`

Do not copy:

- full memory indexing/search subsystem
- embeddings-first memory design
- remote memory services

### 7. Recent-turn anchoring

What to learn:

- recent turns should not mean only "last N messages"
- keep the turns that anchor the active goal or unresolved clarification
- preserve the turns that introduced or resolved the current direction

Map to `agrun.js`:

- `src/session/context-window-plan.js`
- `src/session/compaction.js`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`

Do not copy:

- a larger transcript-management subsystem than the session layer needs

### 8. Hard failure instead of silent context drift

What to learn:

- if even the protected direction context does not fit, fail explicitly
- never silently continue with a half-broken prompt

Map to `agrun.js`:

- `src/session/compaction.js`
- `src/runtime/errors.js`
- `agrun_docs/result-schema.md`

Study in OpenClaw:

- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`

Do not copy:

- product hosting or recovery workflows that belong outside the browser runtime

## What Not To Learn From OpenClaw

These are the main areas that look powerful but should stay out of `agrun.js`:

- multi-agent routing and identity
- product hosting and per-agent session directories
- provider-specific thinking or reasoning-level controls
- large context-engine APIs with many extension points
- auth, gateway, or workspace-level architecture

Why:

- `agrun.js` needs a focused browser runtime, not a hosted agent platform
- these areas will increase control-plane weight faster than they improve answer quality

## Recommended Use In agrun

Use OpenClaw as a source for:

- context-window policy
- prompt compaction order
- summary structure
- memory boundary design
- long-run direction preservation

Do not use OpenClaw as a source for:

- planner architecture
- clarification policy
- tool orchestration
- runtime execution loop

For those topics, keep prioritizing:

- `swarm-main`
- `agents-js`
- `codex-main`
- `opencode-main`

## One-Line Rule

The best OpenClaw lesson for `agrun.js` is:

> do not preserve more context; preserve the most important direction.
