# Mastra + CopilotKit/AG-UI — Learning Notes for agrun

Date: 2026-06-07
Source: https://github.com/mastra-ai/mastra (MIT), https://github.com/CopilotKit/CopilotKit (MIT)
Sample code at: `sample-projects/mastra/`

## Executive Summary

Mastra and CopilotKit tackle the two sides of the agent equation: **backend intelligence** (Mastra: memory, workflows, tools) and **frontend interaction** (CopilotKit: AG-UI protocol, generative UI, shared state). Together with AG2B (browser runtime) and OpenHands (event sourcing), they complete the reference architecture for a production agent system.

**Verdict**: Mastra's Observational Memory is the most innovative single feature across all studied projects. CopilotKit's AG-UI protocol is the emerging industry standard for agent-UI communication — adopted by Google, AWS, Microsoft, and LangChain.

---

## Part 1: Mastra — Full-Stack TypeScript Agent Framework

### 1.1 Architecture: DI-Based Orchestration

Mastra uses a **central Mastra class** with dependency injection:

```
Mastra
├── Agents[]     — autonomous AI entities
├── Workflows    — graph-based execution (.then/.branch/.parallel)
├── Tools        — Zod-validated functions
├── Memory       — thread-based + observational + working
├── Storage      — pluggable (PG, LibSQL, MongoDB)
├── Vector       — unified vector store interface
├── MCP          — SSE/HTTP/Hono servers
├── Voice        — STT/TTS
├── Observability — typed spans, event-driven exports
└── Server       — Hono HTTP with OpenAPI
```

**Key distinction**: Agents handle open-ended reasoning; Workflows handle predetermined multi-step processes. This is the same distinction as agrun's research-report-loop (open-ended) vs action pipeline (predetermined).

### 1.2 Observational Memory — The Killer Feature

This is the most innovative feature across ALL studied projects. It's a **two-agent memory condensation system** inspired by human cognition.

**How it works:**

```
Recent Messages (30K token threshold)
    ↓ Observer Agent (background, async)
Observations (timestamped, prioritized, compressed 5-40x)
    ↓ Reflector Agent (at 40K token threshold)
Reflections (merged, deduplicated, pattern-identified)
```

**Observation format:**
```
🔴 HIGH  | User prefers TypeScript over Python for all new projects
🟡 MED   | Project uses PostgreSQL with pgvector extension  
🟢 LOW   | Minor code style preference mentioned in passing
✅ DONE  | Task completed: implemented user authentication
```

**Priority levels map to "intelligent forgetting":**
| Priority | Retention | Examples |
|----------|-----------|----------|
| 🔴 High | Keep forever | User facts, preferences, unresolved goals |
| 🟡 Medium | Keep unless contradictory | Project details, tool results |
| 🟢 Low | Discard first under pressure | Minor details, uncertain observations |
| ✅ Done | Archive after confirmation | Completed tasks, answered questions |

**Performance:**
- 5-40x compression ratio
- 94.87% on LongMemEval (SOTA, beats GPT-5-mini oracle baseline)
- Prompt-cacheable stable observation block

**Async buffering:**
- Observer runs at `bufferTokens` intervals (every 20% of threshold)
- Buffered observations activate INSTANTLY when threshold is hit — no blocking LLM call
- Safety: `blockAfter` threshold (1.2x) forces synchronous fallback

### 1.3 What agrun Can Adopt: Intelligent Compaction

**Current agrun problem**: `session/compaction.js` uses simple truncation — oldest messages dropped, no semantic understanding of what's important. This means critical early instructions can be lost while verbose tool output is preserved.

**Mastra-inspired solution**: Replace truncation with observation-based condensation:

```javascript
// Proposed: agrun Observer (inspired by Mastra Observational Memory)
class ConversationObserver {
  constructor({ messageTokenThreshold = 30000, model = 'gpt-mini' }) {
    this.threshold = messageTokenThreshold;
    this.model = model;  // cheaper model for observations
  }

  async observe(messages, existingObservations) {
    // 1. Estimate token count
    // 2. If under threshold + buffer: skip
    // 3. Call cheap model to produce structured observations
    // 4. Format: timestamp, priority, content
    // 5. Inject observations as system context instead of raw history
    return observations;
  }
}
```

**Benefit**: 
- Keeps critical context (user goal, preferences) while dropping noise
- 5-40x effective context compression
- Observer uses cheap model (not the main agent model)
- Prompt-cacheable (observations are stable across turns)

**Implementation note**: agrun already has the infrastructure — `runtime-event-ledger.js` for event tracking, observer JSONL for streaming, and `compaction.js` as the integration point. The Mastra pattern is a direct upgrade to `compaction.js`.

### 1.4 Working Memory — Structured Persistent State

Separate from observational memory, Mastra's Working Memory stores **structured data**:

```typescript
// Template mode (Markdown — replace semantics)
memory.updateWorkingMemory(
  "User Name: John\nPreferences: dark mode, TypeScript\nGoals: ship v2 by Q3"
);

// Schema mode (JSON — deep merge semantics)
memory.updateWorkingMemory({
  name: "John",
  preferences: { theme: "dark", language: "TypeScript" },
  goals: ["ship v2 by Q3"]
});
```

**State signals** (experimental): delivers working memory as state signals instead of system prompt injection, with unified-diff deltas.

**agrun implication**: agrun's `runState` is the equivalent but less structured. A Working Memory abstraction would:
1. Separate persistent user facts from transient agent state
2. Support deep-merge updates
3. Deliver as state deltas (not full system prompt dump)

### 1.5 Workflow System — Graph-Based Execution

```typescript
workflow
  .then(step1)      // sequential
  .branch(condition, pathA, pathB)  // conditional
  .parallel(step2, step3)  // parallel
```

**agrun comparison**: agrun's OODAE cycle is a fixed 5-phase loop. Mastra's workflow system is more flexible — arbitrary DAG topology. But agrun's phases provide structure that Mastra's workflows lack (phase tracking, graceful degradation per phase).

### 1.6 Processors — Same Pattern as AG2B Hooks

Mastra's **Processors** are message interceptors before/after generation. This is the SAME pattern as AG2B's pre/on hooks and Vercel AI SDK's middleware. **Three independent projects converged on the same architecture.**

---

## Part 2: CopilotKit + AG-UI — Frontend Agent Protocol

### 2.1 AG-UI Protocol — The Industry Standard

CopilotKit created the **AG-UI (Agent-User Interaction) Protocol**, now adopted by:
Google ADK, AWS Strands, Microsoft Agent Framework, LangChain, Mastra, PydanticAI, Agno, LlamaIndex

**Core concept**: ALL traffic between agent and UI is a **typed event stream** over SSE/WebSocket:

```
Agent Backend → AG-UI Event Stream → Frontend UI
```

### 2.2 Event Type Taxonomy

AG-UI defines events in functional categories:

**Lifecycle:**
| Event | Purpose | agrun equivalent |
|-------|---------|------------------|
| `RUN_STARTED` | Agent begins (threadId, runId, parentRunId) | observer `run_start` |
| `RUN_FINISHED` | Agent completes | observer `run_end` |
| `RUN_ERROR` | Agent error | observer `error` |
| `STEP_STARTED` / `STEP_FINISHED` | Step boundaries | action loop cycle events |

**Text Messages (streaming triad):**
| Event | Purpose |
|-------|---------|
| `TEXT_MESSAGE_START` | Initialize message (messageId, role) |
| `TEXT_MESSAGE_CONTENT` | Incremental text delta |
| `TEXT_MESSAGE_END` | Finalize message |

**Tool Calls:**
| Event | Purpose |
|-------|---------|
| `TOOL_CALL_START` | Tool execution begins |
| `TOOL_CALL_ARGS` | Streaming JSON argument fragments |
| `TOOL_CALL_END` | Arguments complete |
| `TOOL_CALL_RESULT` | Final output |

**State Management:**
| Event | Purpose |
|-------|---------|
| `STATE_SNAPSHOT` | Full state replacement |
| `STATE_DELTA` | Incremental JSON Patch (RFC 6902) |
| `MESSAGES_SNAPSHOT` | All messages snapshot |

**Reasoning:**
| Event | Purpose |
|-------|---------|
| `REASONING_START/END` | Reasoning block boundaries |
| `REASONING_MESSAGE_CONTENT` | Streaming reasoning text |

**Special:**
| Event | Purpose |
|-------|---------|
| `RAW` | Pass-through untransformed events |
| `CUSTOM` | User-defined extensibility |

### 2.3 State Snapshots vs Deltas — Critical Pattern

AG-UI supports TWO state update modes:

- **`STATE_SNAPSHOT`** — Full state object. Use at session start.
- **`STATE_DELTA`** — JSON Patch (RFC 6902). Use during streaming.

```json
// STATE_DELTA example
[
  { "op": "add", "path": "/currentStep", "value": 3 },
  { "op": "replace", "path": "/progress", "value": 0.75 },
  { "op": "remove", "path": "/pendingActions/0" }
]
```

**agrun implication**: agrun's observer currently emits FULL state on every event. This is wasteful — most events only change 1-2 fields. Switching to STATE_DELTA for incremental updates + periodic STATE_SNAPSHOT would:
1. Reduce JSONL file size 10-50x
2. Enable real-time inspector updates with minimal bandwidth
3. Support time-travel debugging (apply/revert patches)

### 2.4 Branching / Time Travel

AG-UI supports `parentRunId` on `RUN_STARTED`, creating **git-like branching**:
```
Run A (parentRunId: null)
├── Run B (parentRunId: A) — continuation
└── Run C (parentRunId: A) — alternative branch
```

**agrun implication**: This enables "what if" debugging — replay from any point with different model/tool choices. agrun's observer JSONL already records all events; adding `parentRunId` would enable branching.

### 2.5 Event Compaction

AG-UI supports merging events for storage efficiency:
- Multiple `TEXT_MESSAGE_CONTENT` → single `TEXT_MESSAGE_CHUNK`
- Multiple `STATE_DELTA` → final `STATE_SNAPSHOT`
- Remove intermediate reasoning events

**agrun implication**: This is exactly what agrun's observer already does (JSONL is append-only) but without the compaction step. Adding compaction would reduce storage while keeping replay capability.

### 2.6 Three-Layer Architecture

CopilotKit defines a clean three-layer separation:

```
┌─ UI Component Layer ─────────────────────────────────┐
│ <CopilotSidebar>, useCopilotChat, useAgent           │
│ Generative UI — agents render React components        │
├─ Runtime Middleware ─────────────────────────────────┤
│ @copilotkit/runtime — protocol conversion, state,    │
│ prompt injection protection, auth                    │
├─ Agent System ───────────────────────────────────────┤
│ LangGraph, CrewAI, Mastra, Google ADK, AWS Strands   │
│ AG-UI protocol endpoint                              │
└──────────────────────────────────────────────────────┘
```

**agrun alignment**: agrun already has these three layers:
1. Host chat UI (the consuming application)
2. agrun runtime (action loop, policy, observer)
3. LLM provider layer

What agrun is MISSING: the AG-UI protocol as the formal contract between layers 1 and 2. Currently the contract is ad-hoc (host calls `runtime.run()`, gets back `result`). AG-UI would formalize this as a typed event stream.

---

## Part 3: Pattern Convergence Across ALL Studied Projects

### 3.1 The "Hook/Middleware" Pattern — 4/4 Projects Agree

| Project | Name | Mechanism |
|----------|------|-----------|
| **AG2B** | Hooks | preRequest, onResponse, preToolCall (discriminated union returns) |
| **Vercel AI SDK** | Middleware | onGenerate, tool approval callbacks |
| **Mastra** | Processors | Message interceptors before/after generation |
| **OpenHands** | Condenser | Pluggable condensation component |

**Conclusion**: The "simple core + pluggable hooks" pattern is NOT a preference — it's the **industry consensus architecture** for agent runtimes. agrun should adopt it (AGRUN-418).

### 3.2 The "Typed Event Stream" Pattern — 3/4 Projects Agree

| Project | Event System |
|----------|-------------|
| **AG2B** | 12 typed `AgentEvent` discriminated union |
| **Vercel AI SDK** | `fullStream` typed parts |
| **AG-UI** | Typed event taxonomy (lifecycle + text + tool + state + reasoning) |

**Conclusion**: All major JS agent frameworks use typed event streams. agrun's observer JSONL is structurally similar but lacks formal typing. Formalizing it (AGRUN-419) would align with industry standards AND enable AG-UI compatibility.

### 3.3 The "Memory as Compression" Pattern — Mastra Leads

| Project | Memory Approach |
|----------|----------------|
| **Mastra** | Observational Memory — 2-agent condensation, 5-40x compression, SOTA benchmark |
| **OpenHands** | Condenser — LLM-summarizing condenser, keep_first=2, max_size=240 |
| **agrun** | Compaction.js — simple truncation, no semantic understanding |

**Conclusion**: Mastra's observational memory is the most advanced and directly applicable to agrun.

---

## Part 4: Concrete Action Items

### Short-term (this milestone)
- [ ] **AGRUN-423: AG-UI compatible event types** — Align observer JSONL event types with AG-UI protocol (RUN_STARTED, STEP_STARTED, TEXT_MESSAGE_CONTENT, TOOL_CALL_START, etc.). This makes agrun's inspector AG-UI compatible without changing the protocol.
- [ ] **AGRUN-424: Observer agent for smart compaction** — Replace simple truncation in compaction.js with a lightweight observation agent (inspired by Mastra). Use cheap model for observations. Start with messageTokenThreshold=30000.

### Medium-term (next milestone)
- [ ] **AGRUN-425: State deltas (JSON Patch)** — Add STATE_DELTA events to observer using RFC 6902 JSON Patch. Keep STATE_SNAPSHOT for session start. Reduce JSONL size 10-50x.
- [ ] **AGRUN-426: Working Memory abstraction** — Extract user facts/preferences from runState into a separate WorkingMemory with schema mode (JSON deep merge) and template mode (Markdown replace).
- [ ] **AGRUN-427: Branching support** — Add parentRunId to observer events for time-travel debugging ("what if" replay from any cycle).

### Long-term / research
- [ ] Full AG-UI protocol compliance — agrun runtime exposes AG-UI SSE endpoint, inspector consumes AG-UI events natively
- [ ] Reflector agent for observation consolidation (when observations cross 40K tokens)
- [ ] Generative UI — agent reports render as React components (charts, tables) instead of plain markdown

---

## Part 5: Updated Comparison Matrix (All Projects)

| Dimension | agrun | AG2B | Vercel AI SDK | OpenHands | Mastra | CopilotKit/AG-UI |
|-----------|-------|------|---------------|-----------|--------|------------------|
| **Runtime** | Browser JS | Browser JS | Node/Edge | Python/Docker | Node.js | Any + UI |
| **Agent loop** | OODAE 5-phase | while(true)+hooks | maxSteps | Agent.step() | Agent + Workflow | Backend-agnostic |
| **Hooks** | Interleaved | 11 typed hooks | Middleware | Condenser | Processors | AG-UI events |
| **Memory** | Compaction (truncation) | History (append) | (provider-managed) | Condenser (LLM summarize) | **Observational (2-agent)** | State snapshots |
| **Event stream** | Observer JSONL | AgentEvent gen | fullStream parts | EventStream SSOT | Typed spans | **AG-UI protocol (standard)** |
| **Error handling** | Ad-hoc strings | 6 typed classes | Categories | Exception hierarchy | Typed spans | RUN_ERROR event |
| **Tool system** | action-contract | Zod schema | Zod + execute | Action/Observation | Zod + toolsets | AG-UI tool events |
| **State updates** | Full state per event | Full history | Incremental | Event append | Working Memory | **Snapshot + JSON Patch** |
| **Multi-agent** | (planned) | Plugin system | External orchestrator | — | Supervisor agents | CoAgents state machine |
| **Graceful degradation** | **AGRUN-307/309 (unique)** | None | None | Restart only | Retry logic | (runtime-agnostic) |
| **Citation verification** | **Evidence graph (unique)** | None | None | None | None | None |

---

## References

- Mastra source: `sample-projects/mastra/`
- Mastra docs: https://mastra.ai/docs
- Observational Memory: https://mastra.ai/docs/memory/observational-memory
- CopilotKit: https://github.com/CopilotKit/CopilotKit
- AG-UI Protocol: https://docs.ag-ui.com
- AG-UI Events: https://docs.ag-ui.com/sdk/js/core/events
- LongMemEval benchmark: Mastra OM achieves 94.87% (SOTA)
