# Learnings from Sample Projects

## Purpose

This document captures the key lessons learned from studying the sample projects in `sample project for study logic/`. It focuses on **what agrun.js can adopt** and **what gaps remain** — organized by the agentic patterns that matter most.

For the reference priority and mapping rules, see `agrun_docs/sample-reference-guide.md`.
For the OpenClaw-specific study guide, see `agrun_docs/openclaw-agrun-mapping.md`.

## Sample Projects Studied

| Project | Language | Focus Area |
|---------|----------|------------|
| `swarm-main` | Python | Compact agent loop, tool dispatch, agent handoff |
| `agents-js` | JavaScript | ReAct-Plus loop, skill packaging, state contracts |
| `claude-code-source-code-main` | TypeScript | QueryEngine orchestration, tool system, task lifecycle, MCP |
| `codex-main` | Rust | AGENTS.md discipline, skill layering, user input boundary |
| `langgraph-cli-0.4.14` | Python | State graph, durable execution, human-in-the-loop |
| `continue-1.5.45` | TypeScript | IDE integration, LLM abstraction, codebase indexing |
| `openclaw-2026.3.8` | TypeScript | Context budgeting, memory boundaries, multi-channel |
| `AutoGPT` | Python/TS | Platform architecture, continuous agents |
| `goose-1.27.2` | Rust | MCP integration, provider conversation repair |
| `ai-ai-6.0.119` | TypeScript | Provider abstraction, tool/result interfaces, streaming architecture |
| `aiverify-2.2.0` | Python/TS | Schema-driven metadata, result envelope discipline |
| `hermes-agent-2026.4.8` | Python | Closed learning loop, tools registry, subagent delegation, memory providers |
| `claude-code-sourcemap-main` | TypeScript | Source-mapped architecture, multi-agent coordination, tool→service→state |
| `opencode-main` | Go | Dual agent modes (build/plan), role-based permissions |
| `open-webui` (`8dae237`) | Python/Svelte | Chat task lifecycle, socket events, message queue, visible progress |

## Key Learnings

### 0b. Windowed LLM Payload/Response Inspector

**Learned from**: agents-js, Codex, Claude Code, Open WebUI, Goose, OpenClaw

The sample folder does not contain one complete Inspector to copy, but it shows
a clear combined solution for payload/response optimization: keep a bounded,
redacted trace capsule with summary metrics first and explicit windows for
deeper inspection.

Useful sample patterns:

- **agents-js**: `utils/agent-trace.js` records typed events, redacts sensitive
  keys, bounds event count, and exports a session trace with summary + normalized
  events.
- **Codex**: rollout/session listing uses cursor pagination; tests capture and
  inspect exact request bodies to prove prompt/payload behavior.
- **Claude Code**: compaction appears as a visible `compact_boundary` instead
  of disappearing inside hidden state.
- **Open WebUI**: task IDs, cancellation, socket events, and streamed chunks are
  first-class lifecycle signals.
- **Goose**: agent-visible/user-visible message separation and validated
  success/error tool result envelopes keep debug records distinct from model
  context.
- **OpenClaw**: context assembly/compaction contracts include token budget,
  tokens before/after, and compaction reason.

**agrun adaptation implemented in first slice**:

- Keep `runtime_steps` as the SSOT and make Inspector sections projections.
- Store LLM trace summaries always; expose request/response/evidence through
  redacted, pageable windows only when needed. Current LLM request/response
  windows are built from safe trace summaries, not full raw provider payloads.
- Use the same window contract for `read_url` evidence, request payload sections,
  response sections, and finalizer source context:
  `start`, `length`, `nextStart`, `hasAfter`.
- Normalize Inspector projections into stable event classes:
  `stream_event`, `tool_event`, `checkpoint_event`, `debug_event`, and
  `window_event`.
- Track debug visibility explicitly: `debug_only`, `agent_projection`, or
  `user_visible`, so raw payload evidence never silently becomes model context.
- Add mechanical payload optimization hints such as large payload/schema/session
  signals, request delta growth/reduction, slow/high-token responses, empty
  responses, and tool-call responses. Do not add runtime-owned answer quality
  gates.

See
`agrun_docs/audits/sample-project-inspector-payload-response-2026-05-10.md` for
the full review.

### 0. AI-Owned Readiness Continuation Signal

**Learned from**: AI SDK ToolLoopAgent, agents-js, Goose, Swarm

The current agrun failure mode is not that the AI lacks tools. The real Chrome
QA showed the AI had workspace stats, research gaps, and `finalReadiness=limited`,
but still chose `finalize`. The relevant sample-project lesson is to make the
AI's own "not satisfied" declaration part of the next visible loop step instead
of converting it into a runtime-authored content gate.

Useful sample patterns:

- **AI SDK ToolLoopAgent**: `stopWhen`, `onStepFinish`, `prepareStep`, and
  lifecycle callbacks make each step visible and allow continuation policy to be
  expressed as loop state rather than hidden prompt text.
- **agents-js**: minimal `TurnState` + evaluator can emit hints such as
  `need_clarification` without introducing a full workflow engine.
- **Goose**: tool-result envelopes are validated before being reused as model
  context, preventing state mismatch from becoming invisible.
- **Swarm**: the compact loop keeps model decision, tool execution, and returned
  observations easy to follow.

**Recommended agrun adaptation**:

- When AI declares `finalReadiness.decision=limited` or
  `requirementSatisfied=false` / `lengthSatisfied=false`, runtime records that
  declaration and may return a one-time `readiness_continuation_signal`
  observation if budget remains.
- The signal tells the AI: "you declared this is not fully satisfied; continue
  with tools/workspace if you can improve it, or finalize intentionally with
  limitations."
- Runtime must not parse requested word counts, judge source sufficiency, or
  rewrite final answers.

See
`agrun_docs/audits/sample-project-workflow-review-2026-05-10.md` for the full
sample review.

### 1. Native Tool Calling is the Industry Standard

**Learned from**: Claude Code, Swarm, Vercel AI SDK

All modern agentic systems use the LLM provider's native tool/function calling API rather than asking the LLM to return JSON text for parsing.

- **Swarm** (`core.py`): Uses OpenAI `tool_calls` directly, dispatches via `handle_tool_calls()`
- **Claude Code** (`QueryEngine.ts`): Uses Anthropic native `tool_use` content blocks
- **Vercel AI SDK** (`ai-ai-6.0.119`): Provider-agnostic tool abstraction with typed schemas

**Adopted in agrun.js**:
- `plannerMode: "native_tools"` — uses OpenAI/Gemini native tool calling
- `src/runtime/planner-tools.js` — converts action registry to provider tool definitions
- Provider layer now passes `tools` and parses `tool_calls` / `functionCall` responses

**Adopted default**: agrun now defaults to native tools mode while preserving envelope mode as an explicit opt-out and compatibility fallback.

### 2. LLM Self-Correction on Errors

**Learned from**: Claude Code, agents-js

Claude Code feeds errors back into the conversation context so the LLM can self-correct on the next turn. This is more resilient than terminating on first failure.

- **Claude Code**: Tool errors become assistant messages in the conversation, LLM adjusts
- **agents-js**: ReAct-Plus loop retries with updated context on tool failure

**Adopted in agrun.js**:
- `selfCorrection: { enabled: true, maxRetries: 2 }` — default on
- Action errors recorded in `actionHistory` with descriptive summary
- Planner sees error in next cycle and can choose different approach

### 3. Centralized Tool Dispatch with Normalized Results

**Learned from**: Swarm, Claude Code, Vercel AI SDK

Tool execution should go through a centralized dispatch with normalized result shapes.

- **Swarm**: `handle_tool_calls()` → `handle_function_result()` → normalized `Result` type
- **Claude Code**: `Tool.ts` defines typed tool results with structured outputs
- **Vercel AI SDK**: Unified tool result interface across providers

**Already in agrun.js**:
- `action-registry.js` centralizes action dispatch
- `action-loop-action.js` normalizes all action results
- `result.js` assembles structured run results

**Could improve**: Stronger typed schemas for action arguments (currently inferred from `argsExample`).

### 4. Explicit Run Loop that is Easy to Trace

**Learned from**: Swarm, LangGraph

The run loop should be explicit, inspectable, and bounded.

- **Swarm**: `while len(history) - init_len < max_turns` — clean bounded loop
- **LangGraph**: Named nodes with explicit state transitions

**Already in agrun.js**:
- OODAE cycle with named phases (observe/orient/decide/act/evaluate)
- `steps` trace for full execution visibility
- `maxSteps` bounding

**agrun advantage over samples**: agrun's OODAE cycle is more structured than Swarm's flat while-loop, providing better traceability.

### 5. Context Window Discipline

**Learned from**: OpenClaw, agents-js

Long-running conversations need explicit context budgeting, not unlimited message accumulation.

- **OpenClaw**: Direction-first context (protect active goal before older transcript), tiered assembly, budget-first prompt control
- **agents-js**: CJK-aware token management, automatic history compaction

**Already in agrun.js**:
- `src/session/context-window-policy.js` — compaction policies
- `src/session/context-window-summary.js` — summarization
- `src/session/token-budget.js` — token budgeting

**Could improve**: Adopt OpenClaw's tiered context assembly more explicitly (instructions → inquiry context → confirmed memory → summary → recent turns).

### 6. Permission/Approval as Policy Layer

**Learned from**: Claude Code, Codex, opencode

Approval should be a policy wrapper, not embedded in the execution loop.

- **Claude Code**: `CanUseToolFn` permission checking, separate from tool execution
- **Codex**: Sandbox and approval as optional policy, not core runtime
- **opencode**: Agent modes (read-only vs full-access) separate from execution

**Already in agrun.js**:
- `policy.js` with tier-based `allow/ask/deny`
- `actionPolicy` config for host overrides
- Approval flow with resumable control envelopes

### 7. Agent Skills as Instruction Packages

**Learned from**: agents-js, Codex

Skills should be self-contained packages with tools, instructions, and metadata.

- **agents-js**: Skill directory with `SKILL.md` manifests, tool definitions, risk profiles
- **Codex**: AGENTS.md hierarchy with scope and precedence

**Already in agrun.js**:
- `skills/` directory with bundled instruction packages
- `agent-skills.js` for registration and normalization
- Planner-facing tool catalog operations

### 8. Task Lifecycle and Status Tracking

**Learned from**: Claude Code

Long-running operations benefit from explicit task lifecycle management.

- **Claude Code** (`Task.ts`): Task states (pending/running/completed/failed/killed), terminal detection, output file management

**Gap in agrun.js**: No explicit task abstraction. `RunState.status` covers basic states but lacks the granularity of Claude Code's task system. Consider adding if use cases require long-running background operations.

### 9. Structured Clarification Boundary

**Learned from**: Codex, Claude Code

Clarification should be a structured input/output exchange, not hidden prompt parsing.

- **Codex**: `tui-request-user-input.md` — structured request/response boundary
- **Claude Code**: Structured user confirmation for tool use

**Already in agrun.js**:
- Structured `pendingClarification` objects
- `ask_clarification` action with structured question/response
- Clarification lifecycle tracking in inquiry context

### 10. Provider Conversation Repair

**Learned from**: Goose

When provider responses are malformed, the system should attempt structured repair.

- **Goose**: Provider-facing conversation repair, stable tool-result envelope validation

**Already in agrun.js**:
- Four-stage planner repair cascade (parse → soft repair → envelope repair → strict retry → fallback)
- Native tools mode reduces the need for repair since providers validate natively

### 11. Pluggable Memory Provider Architecture

**Learned from**: Hermes Agent

Hermes uses an ABC-based pluggable memory system with strict rules: one built-in provider + max one external cloud provider. Memory manager orchestrates lifecycle hooks (`on_turn_start`, `on_session_end`, `on_pre_compress`, `on_memory_write`, `on_delegation`).

- **Hermes**: `memory_provider.py` + `memory_manager.py` + 8 providers (honcho, mem0, hindsight, holographic, etc.)
- Prefetch queuing for async memory loading before turn starts
- Context fencing: recalled memory wrapped in `<memory-context>` tags

**Gap in agrun.js**: Current global memory (`global-memory.js`) is a single IndexedDB implementation with no provider abstraction. No lifecycle hooks, no prefetch mechanism, no context fencing tags.

**Adoption path**: Add `MemoryProvider` interface with `load()`, `save()`, `search()`. IndexedDB becomes the built-in provider. Prepare hook points for future cloud providers.

### 12. Tools Registry with Self-Registration

**Learned from**: Hermes Agent

Hermes uses a centralized `ToolRegistry` singleton where tools self-register at import time. Tools are grouped into toolsets ("terminal", "file", "web", "memory") with per-tool availability checks and size limits.

- **Hermes**: `tools/registry.py` — 350 lines, toolset grouping, `check_fn()` per schema generation
- Tools declare availability at runtime (e.g., "only available if Docker is running")

**Gap in agrun.js**: Actions are hardcoded in `action-registry.js`. No dynamic registration, no grouping, no runtime availability checks.

**Adoption path**: Low priority — current action set is small enough. Consider if action count grows beyond 15.

### 13. Subagent Delegation with Isolation

**Learned from**: Hermes Agent, Swarm

Hermes delegates to subagents with strict isolation: fresh conversation, restricted toolset (⊂ parent tools), MAX_DEPTH=2, blocked tools (delegate_task, memory_write), and progress relay back to parent.

- **Hermes**: `tools/delegate_tool.py` — 500+ lines
- **Swarm**: Agent handoff via returning new Agent objects

**Gap in agrun.js**: Single-agent per runtime, no delegation mechanism.

**Adoption path**: Web Worker-based delegation. Child gets focused prompt, restricted skill set, progress callback. Consider for Phase 4+ if complex multi-step workflows require it.

### 14. Provider Abstraction with Failover

**Learned from**: Vercel AI SDK, Goose, OpenClaw

Multiple projects implement provider rotation with configurable fallback chains and health checks.

- **Vercel AI SDK**: Layered abstraction (specification → utils → concrete providers)
- **OpenClaw**: Multiple auth profiles per provider, rotation + failover
- **Goose**: Health checks before provider selection

**Gap in agrun.js**: Provider selection is static per runtime instance. No failover, no rotation, no health checks.

**Adoption path**: Medium priority. Add `providerFallback` config to `createRuntime()`. If primary provider returns 429/500, auto-retry with fallback provider.

### 15. Finalize-Only Streaming (Not Full-Pipeline Streaming)

**Learned from**: Vercel AI SDK (`ai-ai-6.0.119`), Harness Engineering (`harness_engineering.txt`)

The Vercel AI SDK implements full-pipeline streaming where `streamText()` streams every step (text-delta, tool-call, reasoning, metadata) through a unified `fullStream` / `textStream` AsyncIterable. This is the right model for an SDK that wraps raw provider calls.

However, for a harness-first runtime like agrun.js, full-pipeline streaming is architecturally wrong:

- **AI SDK** (`stream-text.ts`): `streamText()` returns `fullStream` (all event types) and `textStream` (text deltas only). Every step — tool calls, reasoning, text — is streamed through one pipe. Callbacks: `onChunk`, `onStepFinish`, `onFinish`, `onAbort`.
- **AI SDK UIMessageStream** (`create-ui-message-stream.ts`): `text-start` → `text-delta` → `text-end` protocol for incremental UI updates.
- **Harness Engineering**: "If you cannot see execution, you cannot trust it." Streaming is an observability concern — the finalize phase is the only phase with no intermediate feedback.

**Design decision for agrun.js**:

Stream only during **finalize** (the final answer generation to end user). OODAE cycle phases (observe/orient/decide/act) remain discrete step callbacks because their outputs are structured (JSON decisions, tool calls) — partial JSON is meaningless.

Key differences from AI SDK:

| Dimension | AI SDK | agrun.js |
|-----------|--------|----------|
| Streaming scope | All steps (text, tools, reasoning) | Finalize text only |
| Return type | AsyncIterable (`textStream`, `fullStream`) | Callback (`onToken`) — return value unchanged |
| Provider integration | SDK-managed (internal stream handling) | AI SDK adopted — `generateText()` / `streamText()` via `@ai-sdk/openai` + `@ai-sdk/google` |
| Cancel mechanism | `AbortController` + `onAbort` | `AbortController` (adopted from AI SDK pattern) |
| Multi-step streaming | Built-in (`stopWhen`, `onStepFinish`) | Not needed — OODAE loop is discrete |

**Adopted from AI SDK**:
- `@ai-sdk/openai` + `@ai-sdk/google` as provider implementations — replaces raw fetch + manual response parsing
- `generateText()` for non-streaming LLM calls (planner, finalize without onToken)
- `streamText()` + `textStream` async iterator for streaming finalize
- `AbortController` pattern for early cancellation (user sees wrong direction, aborts)
- Callback-based token delivery (`onToken` wraps AI SDK's `textStream` iterator)
- `jsonSchema()` for tool parameter conversion

**Explicitly not adopted**:
- `fullStream` / `textStream` AsyncIterable as public return types — agrun wraps in `onToken` callback, `runtime.run()` contract unchanged
- `toUIMessageStream()` — agrun's browser layer already has step → activity pipeline
- Streaming during planner/action phases — discrete step callbacks are correct for structured outputs
- `useChat` / `useCompletion` React hooks — agrun browser layer owns its own state management

**Implementation approach**:
- Provider layer: `generateText()` for non-streaming, `streamText()` + `for await (textStream)` for streaming, both from Vercel AI SDK
- Runtime layer: `onToken` callback threaded through `runtime-finalize.js`, opt-in (not passed = falls back to `generateText`)
- Browser layer: token accumulator in `chat-turns.ts`, streamed text injected into message parts during streaming

### 16. State Checkpointing for Resumability

**Learned from**: LangGraph, agents-js

LangGraph persists full agent state to SQLite/Postgres with interrupt points for human review. agents-js uses JSON snapshots for session recovery.

- **LangGraph**: Deterministic replay via checkpoint recovery
- **agents-js**: Serializable session snapshots

**Gap in agrun.js**: Session state is in-memory during execution. If browser tab closes mid-run, state is lost. IndexedDB stores completed turns but not mid-run state.

**Adoption path**: Low priority for browser-first. Consider if long-running workflows (>5 minutes) become common.

### 17. Chat Task Lifecycle Without Fake User Continue

**Learned from**: Open WebUI (`open-webui` commit `8dae237`)

Open WebUI separates chat generation, progress events, queued user prompts, and cancellation. The useful lesson for agrun is not "make the user click continue"; it is "do not model runtime continuation as a fake user chat prompt."

- **Frontend chat flow** (`src/lib/components/chat/Chat.svelte`): `submitPrompt()` creates the user message, then `sendMessage()` sends a request containing `session_id`, `chat_id`, `id`, `parent_id`, feature/tool metadata, and optional background task config. If a response is already generating, user prompts go into a message queue and run after the active response finishes.
- **Task event flow** (`src/lib/components/chat/Chat.svelte`): socket events update `statusHistory`, message deltas, files, errors, follow-ups, and `chatTasks`. Progress is event-driven, not parsed from assistant prose.
- **Task UI** (`src/lib/components/chat/Messages/ResponseMessage/TaskList.svelte`): the task list only appears when active tasks exist. It is a current-run status surface, not a permanent chat chrome.
- **Backend task lifecycle** (`backend/open_webui/main.py`, `backend/open_webui/tasks.py`, `backend/open_webui/socket/main.py`): chat requests create backend task IDs, emit `chat:active`, support cancellation, restore active task IDs by chat, and persist event-driven deltas/status updates.

**Decision for agrun.js**:

TodoState should remain a structured runtime state and host progress surface. When a bounded runtime hits `continuation_required`, the browser host should auto-resume the existing TodoTask as a host action, without inserting a visible `continue` user bubble.

**Adopt from Open WebUI**:
- Event-driven status updates: TodoState snapshots and step/status events should be emitted as state, not duplicated in assistant prose.
- Active-run task visibility: the progress panel should appear when TodoState is active or continuation is required, and collapse/vanish when not relevant.
- Cancellation/stop as a first-class path: long tasks need a stable stop boundary, not only a generation stop button.
- Queue semantics for user prompts: if a user sends another message while generation is active, queue or interrupt explicitly; do not treat that user message as agent self-continuation.
- Reload recovery: active task IDs or continuation metadata should restore enough state for the user to understand what is paused.

**Explicitly not adopted**:
- Host auto-continue implemented as a synthetic user message.
- Backend-heavy task orchestration as a required runtime dependency; agrun remains browser/library-first.
- Assistant-visible progress checklists as the source of truth; TodoState stays structured and UI-owned.

### 18. OODAE Inspector Trace Modes Instead of Runtime Guessing

**Learned from**: LangGraph, Goose, Hermes Agent, Open WebUI

The most useful answer from the sample folder for the current agrun Inspector issue is not a smarter runtime gate. It is a clearer trace contract:

- **LangGraph** separates stream views such as values, updates, tasks, debug, and messages. The lesson for agrun is to treat Inspector panels as derived views over one event log, not as separate logic branches.
- **Goose** keeps provider/tool results in stable success/error envelopes and repairs only the provider-facing conversation projection. The lesson for agrun is to separate agent-visible prompt state from debug-only records, and to validate action/result protocol shape without judging answer quality.
- **Hermes Agent** exposes tool registry availability, per-tool size boundaries, progress, and interrupt behavior. The lesson for agrun is to show why a tool/action was available, blocked, or capped in Inspector/support bundles.
- **Open WebUI** models active chat tasks, cancellation, socket progress, and task IDs explicitly. The lesson for agrun is to make run/task/abort lifecycle observable, not to implement a backend task server.

**Decision for agrun.js**:

Use a browser-first Inspector trace model:

- `runtime_steps` remains the SSOT event log.
- OODAE Cycle, AI Workflow, LLM Trace, Todo Progress Debug, Evidence, and Support Bundle are read-only projections over that log and run state.
- Approval, stop, abort, waiting, resume, and stuck states should be explicit trace events with stable IDs.
- Action/result envelopes should expose `status`, `kind`, `actionName`, `cycle`, `source`, and bounded `value`/`error` metadata.
- Debug-only records must not become agent-visible content unless deliberately summarized for the planner.

**AI-first boundary**:

Runtime may record protocol facts such as successful `read_url` count, AI-declared `finalReadiness`, workspace text stats, missing readiness, action policy block, provider latency, and abort signal state.

Runtime must not decide whether a 3000-character report is good enough, whether source coverage is enough for the user, or whether the AI should continue research. Those remain AI decisions. Inspector can show raw facts and AI declarations so the user or developer can debug without guessing.

**Adoption path**:

1. Formalize Inspector trace modes as documented projections over `runtime_steps` and existing ledgers.
2. Add explicit interrupt/resume/abort lifecycle rows to OODAE debug output.
3. Add action registry availability and result-size metadata to Support Bundle.
4. Keep all warnings non-blocking unless they are protocol errors, policy denials, provider failures, or user/host aborts.

## What NOT to Adopt

Based on the study, these patterns are explicitly excluded from agrun.js:

| Pattern | Source | Why Excluded |
|---------|--------|-------------|
| Multi-agent handoff | Swarm | agrun is single-agent per runtime |
| Durable execution / checkpointing | LangGraph | Too heavy for browser-first runtime |
| Platform/marketplace architecture | AutoGPT | Not relevant to library-level runtime |
| Node.js-specific APIs | Various | Browser-only constraint |
| MCP server hosting | Claude Code, Goose | Platform concern, not runtime |
| Multi-channel routing | OpenClaw | Product-level, not runtime |
| Full-pipeline streaming (all steps) | Vercel AI SDK | agrun streams finalize only; OODAE phases stay discrete |
| Synthetic `continue` user messages | Open WebUI comparison / TodoState live review | Fake user messages pollute the transcript and confuse ownership; resume must be host task state, not chat content |
| AsyncIterable return type for run() | Vercel AI SDK | Callback-based onToken; run() return shape unchanged |
| TUI/CLI product surface | Codex, opencode | agrun is a library, not a product |
| Closed learning loop / trajectory RL | Hermes | Research-oriented, too heavy for browser runtime |
| Cron scheduler | Hermes | Requires persistent process; browser tabs are ephemeral |
| Multi-platform delivery (Telegram, Discord, etc.) | Hermes, OpenClaw | Product-level routing, not runtime concern |
| Docker/SSH terminal backends | Hermes | Server-side only |
| Runtime-authored answer sufficiency gates | Misapplied research gate pattern | Inspector can expose raw facts and AI declarations, but runtime must not decide whether the AI has enough content/sources for a user-facing report |
| Backend task server as runtime requirement | Open WebUI | Useful lifecycle reference, but agrun must remain browser-first and embeddable |

## Adoption Status

| Learning | Status | Files |
|----------|--------|-------|
| Native tool calling | Adopted | `planner-tools.js`, `planner.js`, `provider.js`, `openai-browser.js`, `gemini-browser.js` |
| LLM self-correction | Adopted | `action-loop-action.js`, `config.js`, `state.js` |
| Centralized dispatch | Already existed | `action-registry.js`, `action-loop-action.js` |
| Explicit OODAE loop | Already existed | `oodae.js`, `action-loop-session.js` |
| Context window discipline | Already existed | `session/context-window-*.js` |
| Permission/approval policy | Already existed | `policy.js`, `approval.js` |
| Agent skills packaging | Already existed | `agent-skills.js`, `skills/` |
| Structured clarification | Already existed | `clarification-state.js`, `ask-clarification-action.js` |
| Repair cascade | Already existed | `planner-repair.js`, `planner-recovery.js` |
| Task lifecycle | Gap | No explicit task abstraction yet |
| Tiered context assembly | Partial | Could adopt OpenClaw's explicit tier ordering |
| Memory provider abstraction | Gap | Single IndexedDB impl, no provider interface |
| Tools registry / dynamic registration | Gap (low priority) | Current action set small enough |
| Subagent delegation | Gap (future) | Consider Web Worker-based for Phase 4+ |
| Provider failover | Gap | Static provider per runtime, no rotation |
| Finalize-only streaming | Adopted (AGRUN-104) | `onToken` callback for finalize phase, AI SDK `streamText()` |
| State checkpointing | Gap (low priority) | Mid-run state lost on tab close |
| Event-driven long-task progress | Partial | TodoState panel exists; task IDs/cancel/reload semantics still lighter than Open WebUI |
| Host-level auto-resume boundary | Adopted | Runtime emits `continuation_required`; browser auto-resumes the same TodoTask without creating a user `continue` message |
| Cost tracker (Harness #11) | Adopted (ADR-0029) | `src/runtime/cost-ledger.js`: per-call ledger + host-supplied pricing join + phase/model sub-totals. Read-only; AI never sees cost. |
| OODAE Inspector trace modes | Partial | `runtime_steps`, OODAE Cycle, AI Workflow, LLM Trace, Support Bundle exist; interrupt/resume/abort and registry availability can be clearer |
| Debug-only vs agent-visible projection | Partial | LLM/AI Workflow traces are sanitized; next step is documenting and enforcing projection boundaries consistently |

## Future Study Areas

1. **Hermes memory_provider.py** — Study the ABC-based provider interface and lifecycle hooks for pluggable memory
2. **Hermes delegate_tool.py** — Study isolation patterns (restricted toolset, depth limit, progress relay) for future subagent support
3. **Vercel AI SDK tool interface** — Study the typed tool result contract for stronger argument validation
4. **Vercel AI SDK advanced patterns** — `prepareStep`, `stopWhen`, `onStepFinish` for multi-step agent loops; `experimental_output` for structured streaming
5. **agents-js ReAct-Plus** — Study the enforced Thought → Plan → Action sequence as a possible planner enhancement
6. **LangGraph conditional edges** — Study conditional routing for future multi-step planning
7. **Swarm agent handoff** — Study the minimal `return Agent()` pattern as lightweight delegation alternative
8. **Open WebUI task events** — Study task IDs, cancellation, reload recovery, and message queue semantics for future TodoState host integration
