# Sample Reference Guide

## Purpose

This document explains what logic in `sample project for study logic/` is worth referring to when building `agrun.js`.

The sample folder is for **study and reference**, not for direct architectural adoption.

`agrun.js` must stay:

- browser-first
- skill-first
- capable enough for real agent-runtime use
- readable at the module boundary level
- small enough to ship as one output file

## Reference Rules

When using a sample project as reference:

1. borrow the **idea or pattern**, not the whole architecture
2. prefer the smallest safe logic that fits the current runtime direction
3. do not import product/platform assumptions into the runtime core
4. keep runtime logic separate from capability logic
5. avoid copying code directly without checking license and fit

## Recommended Priority

Use the samples in this order:

1. `swarm-main`
2. `ai-ai-6.0.119`
3. `agents-js`
4. `opencode-main`
5. `codex-main`
6. `langgraph-cli-0.4.14`
7. `continue-1.5.45`
8. `AutoGPT-autogpt-platform-beta-v0.6.50`

Additional topic-specific references:

- `hermes-agent-2026.4.8`
- `openclaw-2026.3.8`
- `aiverify-2.2.0`
- `goose-1.27.2`
- `claude-code-sourcemap-main`
- `open-webui-main`

Reason:

- `swarm-main` is the closest match to a compact agent execution loop
- `ai-ai-6.0.119` is useful for tool and result interface design, provider boundary thinking, and streaming architecture reference (SSE event protocol, AbortController cancellation, callback patterns)
- `agents-js` is useful for state contract thinking, skill packaging boundaries, and explicit adapt/defer review discipline
- `opencode-main` is useful for skill/tool execution contracts, agent mode boundaries, and explicit permission-vs-sandbox framing
- `codex-main` is useful for AGENTS.md precedence, skill layering, and structured user-input/approval boundaries
- `langgraph` is useful for state-flow ideas, but is much larger than `agrun.js`
- `continue` is better for workflow/checking ideas than runtime design
- `AutoGPT` is useful mainly as a warning about complexity and future-scale concerns
- `openclaw` is useful only for topic-specific study around context budgeting, memory boundaries, and thinking visibility, not as a default architecture template
- `aiverify` is useful selectively for schema-first metadata and result-envelope discipline, not as a default architecture template
- `goose` is useful selectively for provider-facing conversation repair, stable tool-result envelopes, session metadata boundaries, and approval/allowlist wording, not as a default architecture template
- `hermes-agent` is useful for pluggable memory provider patterns, tools registry with self-registration, subagent delegation with isolation, and lifecycle hooks — not for its Python/server-side architecture, closed learning loops, or multi-platform delivery
- `claude-code-sourcemap` is useful for tool→service→state layering, multi-agent coordination patterns, and state machine agent lifecycle — not for its TypeScript/Node architecture
- `open-webui` is useful for chat task lifecycle, active task IDs, cancellation, queued prompts, and event-driven progress — not for its backend/server/socket product architecture

## Reference Map

| Sample project | Refer to this logic | Likely `agrun.js` target | Do not copy into MVP |
| --- | --- | --- | --- |
| `claude-code-source-code-main` | QueryEngine orchestration, native tool calling, tool permission model, self-correction, task lifecycle, cost tracking | `src/runtime/planner.js`, `src/runtime/planner-tools.js`, `src/runtime/action-loop-action.js`, `src/runtime/state.js` | TypeScript/Anthropic API internals, CLI/TUI product surface, MCP, IDE integration, feature flags |
| `swarm-main` | execution loop, tool dispatch shape, result normalization, context passing | `src/runtime/*`, `src/skills/*` | multi-agent handoff, OpenAI client coupling, streaming internals |
| `ai-ai-6.0.119` | tool interface shape, typed result/output thinking, provider abstraction boundaries, `generateText()`/`streamText()` patterns (adopted), `jsonSchema()` tool conversion, AbortController cancellation | `src/skills/providers/openai-browser.js`, `src/skills/providers/gemini-browser.js`, `src/runtime/runtime-finalize.js` | monorepo structure, TypeScript-heavy abstractions, Node/provider packages in core runtime, full-pipeline streaming (agrun streams finalize only), AsyncIterable return types |
| `agents-js` | runtime state minimum contract, skill packaging boundaries, contract review discipline | `src/runtime/state.js`, `src/skills/*`, agrun_docs/process notes | Node+Browser dual-runtime strategy, dynamic skill loading, workspace/UI/approval complexity |
| `opencode-main` | tool execution contract, agent mode separation, permission-vs-sandbox clarity | `src/skills/*`, `src/runtime/result.js`, `src/runtime/errors.js`, `src/runtime/config.js` | Bun/TypeScript runtime assumptions, client/server architecture, desktop/TUI product surface |
| `codex-main` | hierarchical AGENTS.md scope, skill layering, structured request-user-input boundary | `agrun_docs/spec.md`, `agrun_docs/skill-system-architecture.md`, `src/runtime/input.js`, `src/runtime/config.js` | Rust workspace architecture, TUI/UI concerns, MCP/app-server/product integrations |
| `langgraph-cli-0.4.14` | explicit state transitions, graph-like step modeling, future multi-step ideas | `src/runtime/state.js`, future planner/router work | checkpointing, durable execution, deployment, LangSmith integration |
| `openclaw-2026.3.8` | topic-specific context budgeting, memory injection vs recall boundaries, reasoning visibility, and isolation boundaries | `agrun_docs/public-runtime-api.md`, `agrun_docs/runtime-state-and-memory-architecture.md`, `src/session/token-budget.js`, `src/session/compaction.js` | gateway product architecture, multi-agent routing, auth/session hosting, provider-specific thinking modes |
| `aiverify-2.2.0` | schema-driven plugin metadata, result envelope discipline, packaging boundaries | `agrun_docs/skill-system-architecture.md`, `src/runtime/result.js`, `src/runtime/action-registry.js`, `test/smoke.test.js` | Python plugin managers, filesystem discovery, portal/apigw/deployment architecture |
| `goose-1.27.2` | provider-facing conversation repair, tool-result envelope validation, session metadata typing, permission/allowlist wording | `src/session/provider-conversation.js`, `src/runtime/result.js`, `src/session/store.js`, `src/runtime/config.js`, `agrun_docs/runtime-internal-architecture.md` | Rust workspace, Electron/CLI/server product architecture, MCP extension hosting, SQLite/session search, scheduler/subagent features |
| `continue-1.5.45` | repo discipline, checks, markdown-driven quality gates | `test/`, docs, release checks | product-specific IDE integration, CLI behavior, large monorepo structure |
| `hermes-agent-2026.4.8` | pluggable memory providers (ABC interface, lifecycle hooks, prefetch), tools registry (self-registration, toolset grouping, availability checks), subagent delegation (isolation, restricted toolset, depth limit, progress relay), context compression (threshold-based, structured summary) | `src/session/global-memory.js`, `src/runtime/action-registry.js`, future memory-provider interface, future delegation system | Python server architecture, closed learning loop / trajectory RL, cron scheduler, Docker/SSH terminals, multi-platform delivery (Telegram/Discord/etc.) |
| `claude-code-sourcemap-main` | tool→service→state layering, multi-agent coordination, state machine agent lifecycle, formal agent-to-agent handoff protocol | `src/runtime/state.js`, `src/runtime/action-loop-*.js`, future agent coordination | TypeScript/Node architecture, IDE extensions, MCP server hosting |
| `open-webui-main` | chat task lifecycle, active task IDs, cancellation, queued prompts, socket progress, event-driven status updates | `examples/browser/src/hooks/*`, `examples/browser/src/runtime/*`, Inspector task/progress/debug projections | backend task server, WebSocket dependency, product-specific chat/message persistence |
| `AutoGPT-autogpt-platform-beta-v0.6.50` | benchmark/protocol mindset, workflow decomposition, future agent platform concerns | future `benchmarks/`, future protocol adapters | platform/server/frontend/marketplace/runtime complexity |

## Study Checklist

Use this checklist when reading `sample project for study logic/`.

The goal is to answer:

- what logic is worth learning now
- where it maps into the current `agrun.js` codebase
- what must stay outside the MVP

### Current OODAE / Inspector Debugging Study Path

Use this path when debugging "the Activity says running/drafting but task progress never updates", "support bundle is running with provider n/a", or "Inspector cannot explain why AI finalized".

Read these sample areas first:

- `sample project for study logic/langgraph-cli-0.4.14/libs/langgraph/langgraph/types.py` — stream modes, tasks, snapshots, `Command`, and interrupt/resume shape.
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs` — stable success/error tool-result envelope validation.
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs` — separate agent-visible conversation repair from internal/debug records.
- `sample project for study logic/hermes-agent-2026.4.8/tools/registry.py` — action/tool registry availability, size limits, and normalized error dispatch.
- `sample project for study logic/hermes-agent-2026.4.8/website/docs/developer-guide/agent-loop.md` — simple public chat surface versus full run metadata/debug surface.
- `sample project for study logic/open-webui-main/backend/open_webui/tasks.py` and `backend/open_webui/socket/main.py` — active task IDs, cancellation, and event-driven progress.

Map the idea into agrun like this:

- One event log first: `runtime_steps` stays the SSOT.
- Views second: OODAE Cycle, AI Workflow, LLM Trace, Evidence, Todo Debug, and Support Bundle are projections.
- Interrupt/resume/abort must be explicit lifecycle events, not guessed from UI text.
- Tool/action result shape can be validated as protocol, but runtime must not judge final answer length/source sufficiency.
- Debug-only trace must stay separate from agent-visible prompt state unless a deliberate compact projection is passed to the AI.

Do not bring over:

- LangGraph checkpointing as a required dependency.
- Open WebUI backend task server or WebSocket architecture.
- Hermes server/terminal/scheduler architecture.
- Goose Rust/Electron/MCP hosting architecture.
- Any runtime hardcoded rule that decides whether an AI-written report has enough words, sources, or quality.

### Current LLM Payload / Response Optimization Study Path

Use this path when debugging "LLM Trace shows a large request but I cannot see
why", "read_url evidence was clipped and the AI needs the next window", or "we
need to optimize payload/response without dumping unsafe full raw JSON".

Read these sample areas first:

- `sample project for study logic/agents-js/utils/agent-trace.js` — bounded
  event trace, sensitive-key redaction, session summary, normalized events.
- `sample project for study logic/codex-main/codex-rs/core/src/rollout/list.rs`
  — cursor pagination for large transcript/session records.
- `sample project for study logic/codex-main/codex-rs/core/tests/common/responses.rs`
  — test harness request logs with exact `body_json()` inspection.
- `sample project for study logic/claude-code-source-code-main/src/remote/sdkMessageAdapter.ts`
  — explicit `compact_boundary` event and safe unknown-event logging.
- `sample project for study logic/open-webui-main/backend/open_webui/tasks.py`
  and `src/routes/+layout.svelte` — task id, cancellation, socket event, and
  streamed completion chunk lifecycle.
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs`
  and `tool_result_serde.rs` — agent-visible/user-visible separation and
  validated tool-result envelopes.
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`
  — context assembly/compaction budget metrics and before/after token counts.

Map the idea into agrun like this:

- Summary first: request id, cycle, phase, provider, model, size split, deltas,
  response size, tool calls, finish/error, top growth source.
- Window second: redacted request/response/evidence windows with
  `start`, `length`, `nextStart`, and `hasAfter`.
- Event schema third: project runtime signals into `stream_event`,
  `tool_event`, `checkpoint_event`, `debug_event`, and `window_event`.
- Visibility fourth: each debug payload must declare whether it is `debug_only`,
  `agent_projection`, or `user_visible`.
- Copy helpers should generate the next window args, similar to Read URL
  Windows `Copy next args`.
- Debug-only raw windows stay separate from agent-visible prompt state unless a
  deliberate compact projection is passed to the AI.
- Payload optimization hints must be mechanical signals only: repeated session
  context, schema growth, duplicated evidence, response truncation, compaction
  boundary, or provider error.

Implemented first slice:

- `InspectorLlmTraceSection` renders request/response windows from safe LLM
  trace summaries with range, total chars, preview availability, `nextStart`,
  source hash, redaction policy, and copyable next-window args.
- Support Bundle, Debug Report, Debug Index, and Raw tabs expose
  `inspector_event_stream` rows for `debug_event`, `stream_event`,
  `tool_event`, `checkpoint_event`, and `window_event`.
- `payloadOptimizationHints` are browser-side mechanical projections only; they
  do not judge final answer quality, source sufficiency, or requested length.

Do not bring over:

- Always-visible full raw request/response JSON.
- Backend transcript server, socket dependency, or database requirement.
- Secret-bearing export by default.
- Runtime-owned judgment that an answer is too short, under-sourced, or low
  quality.

### Study now: `swarm-main`

Read first:

- `sample project for study logic/swarm-main/swarm/core.py`
- `sample project for study logic/swarm-main/swarm/types.py`
- `sample project for study logic/swarm-main/tests/test_core.py`

Study these ideas:

- the run loop is explicit and easy to trace
- tool dispatch is centralized instead of spread across the codebase
- tool results are normalized into one predictable shape
- execution returns a structured response object

Map into `agrun.js`:

- `sample project for study logic/swarm-main/swarm/core.py` -> `src/runtime/runtime.js`
- `sample project for study logic/swarm-main/swarm/core.py` -> `src/runtime/router.js`
- `sample project for study logic/swarm-main/swarm/types.py` -> `src/runtime/state.js`
- `sample project for study logic/swarm-main/tests/test_core.py` -> `test/smoke.test.js`

Concrete study points:

- compare `Swarm.run()` with the current `select -> execute -> observe -> append memory -> finalize` flow
- compare `handle_tool_calls()` with `selectSkill()` plus runtime-owned helper boundaries
- compare `handle_function_result()` with `agrun.js` output normalization and final result shape

Do not bring over:

- OpenAI request building
- model-specific streaming logic
- multi-agent handoff behavior
- Python model classes and Pydantic patterns

### Study now: `ai-ai-6.0.119`

Read first:

- `sample project for study logic/ai-ai-6.0.119/architecture/provider-abstraction.md`
- `sample project for study logic/ai-ai-6.0.119/skills/use-ai-sdk/references/type-safe-agents.md`
- `sample project for study logic/ai-ai-6.0.119/examples/ai-functions/README.md`
- `sample project for study logic/ai-ai-6.0.119/AGENTS.md`
- `sample project for study logic/ai-ai-6.0.119/packages/ai/src/generate-text/stream-text.ts` — streaming architecture reference for AGRUN-104

Study these ideas:

- tools should have a stable input/output interface
- results should be normalized so callers and UIs can consume one predictable shape
- provider-specific code should sit behind a boundary instead of leaking into runtime logic
- examples can be organized around capability contracts, not around runtime internals
- streaming should use callbacks (`onChunk`, `onFinish`, `onAbort`) rather than changing the return type
- AbortController is the standard cancellation mechanism for streaming
- SSE event types (`text-delta`, `tool-call`, `finish`) provide a clean streaming protocol

Map into `agrun.js`:

- `sample project for study logic/ai-ai-6.0.119/architecture/provider-abstraction.md` -> future provider adapter boundary, not core runtime
- `sample project for study logic/ai-ai-6.0.119/skills/use-ai-sdk/references/type-safe-agents.md` -> `src/skills/*` result and tool contract thinking
- `sample project for study logic/ai-ai-6.0.119/examples/ai-functions/README.md` -> future examples and smoke coverage organization
- `sample project for study logic/ai-ai-6.0.119/AGENTS.md` -> interface layering reference only
- `sample project for study logic/ai-ai-6.0.119/packages/ai/src/generate-text/stream-text.ts` -> `src/skills/providers/*` streaming pattern, `src/runtime/runtime-finalize.js` callback threading

Concrete study points:

- define skill outputs so `run()` can always return a predictable result shape
- keep tool or provider adapters outside `src/runtime/runtime.js`
- if provider support is added later, make runtime depend on a small interface, not on provider-specific implementation details
- separate caller-facing contracts from provider wiring and test them independently
- AI SDK's `streamText()` streams all steps (text, tools, reasoning); agrun only needs finalize streaming — borrow the callback pattern, not the full-pipeline model
- AI SDK's `fullStream` / `textStream` AsyncIterable pattern changes the return type; agrun's `onToken` callback preserves `runtime.run()` contract

Do not bring over:

- pnpm workspace or monorepo assumptions
- TypeScript-first architecture into the browser-first/browser-safe vanilla JS runtime core
- provider package sprawl
- Node.js runtime assumptions
- framework integration layers
- UI typing patterns as runtime requirements
- full-pipeline streaming (agrun streams finalize only, not planner/action phases)
- AsyncIterable as public return types (`fullStream`, `textStream`) — agrun wraps in `onToken` callback
- `toUIMessageStream()` protocol — agrun's browser layer already has step → activity pipeline
- `useChat` / `useCompletion` React hooks — agrun browser layer owns its own state management

### Study now: `agents-js`

Read first:

- `sample project for study logic/agents-js/agrun_docs/architecture.md`
- `sample project for study logic/agents-js/agrun_docs/state-min-spec.md`
- `sample project for study logic/agents-js/agrun_docs/skills.md`
- `sample project for study logic/agents-js/agrun_docs/reference-alignment-review.md`

Study these ideas:

- define a focused runtime state contract before growing planners, evaluators, or routers
- keep capability packaging separate from runtime core responsibilities
- use explicit `Adapt` / `Defer` decisions when borrowing ideas from larger agent systems
- preserve a core-first layering where runtime contracts stabilize before higher-level features

Map into `agrun.js`:

- `sample project for study logic/agents-js/agrun_docs/architecture.md` -> `agrun_docs/spec.md` and `src/runtime/runtime.js` boundary thinking
- `sample project for study logic/agents-js/agrun_docs/state-min-spec.md` -> `src/runtime/state.js` and future runtime state docs
- `sample project for study logic/agents-js/agrun_docs/skills.md` -> `src/skills/*` capability packaging and documentation boundaries
- `sample project for study logic/agents-js/agrun_docs/reference-alignment-review.md` -> future reference-review discipline in docs, not runtime code

Concrete study points:

- define `RunState` fields and invariants before adding new runtime branches
- keep state transitions inspectable without turning the runtime into a workflow engine
- write down which sample ideas are adopted versus deferred so the MVP stays intentional
- keep skill-facing capability docs separate from runtime loop design

Do not bring over:

- Node.js + Browser dual-platform assumptions
- dynamic skill discovery and runtime loading
- workspace, RAG, UI, or AFW subsystems
- approval, sandbox, and trace-event platform contracts
- planner, evaluator, and guard subsystems as MVP runtime requirements

### Study now: `opencode-main`

Read first:

- `sample project for study logic/opencode-main/README.md`
- `sample project for study logic/opencode-main/packages/opencode/AGENTS.md`
- `sample project for study logic/opencode-main/SECURITY.md`

Study these ideas:

- agent modes or permission levels should be separate from the core execution loop
- tool execution contracts should stay narrow and explicit
- failures should be normalized into a predictable runtime-owned shape
- permission prompts should never be described as sandbox security

Map into `agrun.js`:

- `sample project for study logic/opencode-main/README.md` -> `agrun_docs/spec.md` and `src/runtime/config.js` for future caller-owned mode or policy options
- `sample project for study logic/opencode-main/packages/opencode/AGENTS.md` -> `src/skills/*`, `src/runtime/result.js`, and `src/runtime/errors.js`
- `sample project for study logic/opencode-main/SECURITY.md` -> `agrun_docs/runtime-internal-architecture.md` and future security notes

Concrete study points:

- keep read-only versus full-access behavior outside `src/runtime/run-loop.js`
- define skill execution around a narrow `context` contract instead of runtime object reach-through
- normalize failures in runtime-owned code so callers always receive a predictable error shape
- if approvals are added later, document them as UX or policy, not as isolation

Do not bring over:

- Bun-specific APIs or TypeScript-first implementation patterns
- client/server split or desktop/TUI architecture
- built-in subagent orchestration
- local-server and provider product assumptions

### Study now: `codex-main`

Read first:

- `sample project for study logic/codex-main/README.md`
- `sample project for study logic/codex-main/agrun_docs/agents_md.md`
- `sample project for study logic/codex-main/agrun_docs/tui-request-user-input.md`
- `sample project for study logic/codex-main/agrun_docs/sandbox.md`

Study these ideas:

- instruction files need explicit scope and precedence
- skills and prompts should remain a separate layer from the runtime loop
- clarification or interruption should use a structured request/response boundary
- sandbox and approval policy should remain outside the runtime kernel

Map into `agrun.js`:

- `sample project for study logic/codex-main/README.md` -> `agrun_docs/spec.md` for client/runtime boundary thinking
- `sample project for study logic/codex-main/agrun_docs/agents_md.md` -> `agrun_docs/skill-system-architecture.md` and future instruction-layer docs
- `sample project for study logic/codex-main/agrun_docs/tui-request-user-input.md` -> `src/runtime/input.js` and future caller interruption surfaces
- `sample project for study logic/codex-main/agrun_docs/sandbox.md` -> `src/runtime/config.js` and future policy docs

Concrete study points:

- if `agrun.js` adds AGENTS-like files later, resolve scope before skill selection starts
- keep instruction layering and custom prompts out of `src/runtime/runtime.js`
- if the runtime later needs clarification, model it as structured input exchange instead of hidden prompt parsing inside skills
- keep approvals and sandboxing as optional policy wrappers, not as core runtime behavior

Do not bring over:

- Rust crate layout or CLI workspace complexity
- TUI overlays and terminal-specific interaction details
- MCP, app-server, or auth platform surfaces
- large product-level config and release machinery

### Study now: `langgraph-cli-0.4.14`

Read first:

- `sample project for study logic/langgraph-cli-0.4.14/README.md`

Study these ideas:

- state should be explicit
- step boundaries should be named and inspectable
- orchestration logic should stay separate from state shape

Map into `agrun.js`:

- `sample project for study logic/langgraph-cli-0.4.14/README.md` -> `src/runtime/state.js`
- `sample project for study logic/langgraph-cli-0.4.14/README.md` -> `src/runtime/runtime.js`

Concrete study points:

- keep `RunState` explicit instead of hiding data in closures or side effects
- keep step records readable so future planner work can build on the same execution trace
- use graph/state thinking only to improve clarity, not to introduce a graph framework

Do not bring over:

- durable execution
- checkpoint persistence
- human-in-the-loop infrastructure
- framework-scale abstractions

### Study now: `claude-code-source-code-main`

Read first:

- `sample project for study logic/claude-code-source-code-main/src/QueryEngine.ts`
- `sample project for study logic/claude-code-source-code-main/src/Tool.ts`
- `sample project for study logic/claude-code-source-code-main/src/Task.ts`
- `sample project for study logic/claude-code-source-code-main/src/commands.ts`

Study these ideas:

- the agent orchestration loop should handle multi-tool sequences with native tool calling
- tool execution should be type-safe with structured permission checking
- errors should feed back into the conversation context for LLM self-correction
- task lifecycle (pending/running/completed/failed) should be explicit and inspectable
- cost tracking and token usage should be runtime-accessible for budget control
- extended reasoning (thinking mode) should be caller-configurable, not runtime-hardcoded

Map into `agrun.js`:

- `sample project for study logic/claude-code-source-code-main/src/QueryEngine.ts` -> `src/runtime/planner.js`, `src/runtime/action-loop-session.js` for orchestration loop thinking
- `sample project for study logic/claude-code-source-code-main/src/Tool.ts` -> `src/runtime/action-registry.js`, `src/runtime/planner-tools.js` for tool definition contracts
- `sample project for study logic/claude-code-source-code-main/src/Task.ts` -> `src/runtime/state.js` for future task lifecycle abstraction
- `sample project for study logic/claude-code-source-code-main/src/commands.ts` -> `src/runtime/agent-skills.js` for command/skill modular loading patterns

Concrete study points:

- compare QueryEngine's multi-turn tool use loop with agrun's OODAE cycle — both are bounded loops with max turns, but Claude Code lets the LLM drive tool selection natively while agrun adds guardrails and execution class routing
- compare Tool.ts permission checking (`CanUseToolFn`) with agrun's `evaluateActionPolicy()` — both use allow/deny patterns, but Claude Code's is function-based while agrun's is tier-based
- compare how Claude Code feeds tool errors back as assistant messages vs agrun's `selfCorrection` that records errors in `actionHistory` — both achieve self-correction but through different mechanisms
- study Claude Code's cost tracking (`cost-tracker.ts`) for future token budget enforcement in agrun

Do not bring over:

- TypeScript-first architecture into browser-first/browser-safe vanilla JS runtime
- Anthropic API-specific message types and streaming internals
- CLI/TUI product surface (ink components, terminal interaction)
- MCP server connections and coordinator mode
- Desktop app, VS Code extension, or IDE integration concerns
- History snipping and migration infrastructure
- Feature flag system (`feature()` conditional imports)

### Study selectively: `openclaw-2026.3.8`

See also:

- `agrun_docs/openclaw-agrun-mapping.md`

Use this sample only when a change needs one of these topics:

- prompt-window budgeting and compaction boundaries
- injected memory versus on-demand recall boundaries
- reasoning/thinking visibility as a UI or config concern
- isolation boundaries that show why multi-agent belongs outside the MVP

Read first:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/legacy.ts`
- `sample project for study logic/openclaw-2026.3.8/src/auto-reply/thinking.ts`
- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/multi-agent.md`

Study these ideas:

- context-window management should sit behind an explicit policy or engine boundary
- injected bootstrap context and recall-style memory should be treated as separate mechanisms
- reasoning visibility and thinking level are caller-facing controls, not runtime-core architecture
- multi-agent isolation is mostly a product and hosting concern, not an MVP runtime requirement

Map into `agrun.js`:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md` -> `agrun_docs/public-runtime-api.md`, `agrun_docs/runtime-state-and-memory-architecture.md`, and `src/session/token-budget.js`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts` -> future context-boundary notes near `agrun_docs/public-runtime-api.md` and current session budgeting/compaction modules
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/legacy.ts` -> `src/session/compaction.js` as a reference for wrapping legacy behavior behind a narrow boundary
- `sample project for study logic/openclaw-2026.3.8/src/auto-reply/thinking.ts` -> `agrun_docs/action-contract.md` and future provider/config docs for reasoning visibility language only
- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/multi-agent.md` -> `agrun_docs/mvp.md` as a boundary marker for what stays out of scope

Concrete study points:

- study the split between always-injected bootstrap files and on-demand memory retrieval, but do not copy the whole prompt-builder architecture
- study budget estimation plus deterministic degradation paths, but keep the `agrun.js` session contract smaller than OpenClaw's context-engine API
- study how reasoning visibility is separated from final-answer delivery, but do not copy provider/model-specific thinking matrices into the runtime core
- study multi-agent docs mainly to understand why agent identity, auth, and routing should stay outside the MVP kernel

Do not bring over:

- gateway/server hosting architecture
- per-agent auth/session directories and bindings
- subagent spawning and lifecycle hooks
- provider-specific thinking enums or channel-specific reasoning delivery behavior
- large docs, CLI, and platform operations surface area

### Study selectively: `aiverify-2.2.0`

Read first:

- `sample project for study logic/aiverify-2.2.0/aiverify-test-engine/README.md`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.plugin.schema.json`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.algorithm.schema.json`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.testresult.schema.json`
- `sample project for study logic/aiverify-2.2.0/aiverify-test-engine/aiverify_test_engine/plugins/plugins_manager.py`
- `sample project for study logic/aiverify-2.2.0/stock-plugins/aiverify.stock.veritas/algorithms/veritastool/aiverify_veritastool/algo.meta.json`

Study these ideas:

- capability packages can declare small machine-readable metadata files
- runtime-facing results can use a stable envelope with metadata separated from domain output
- schemas can keep plugin and result contracts explicit without coupling them to runtime internals
- capability discovery should sit behind a boundary instead of leaking into the core loop

Map into `agrun.js`:

- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.plugin.schema.json` -> `agrun_docs/skill-system-architecture.md` for future skill manifest thinking
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.algorithm.schema.json` -> `agrun_docs/skill-system-architecture.md` and `src/runtime/action-registry.js`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.testresult.schema.json` -> `src/runtime/result.js` and `test/smoke.test.js`
- `sample project for study logic/aiverify-2.2.0/aiverify-test-engine/aiverify_test_engine/plugins/plugins_manager.py` -> `src/runtime/action-registry.js` as a boundary reference only

Concrete study points:

- if `agrun.js` later adds skill manifests, keep them tiny and declarative: identity, description, supported inputs, output hints
- keep runtime result normalization separate from skill-specific payloads so callers always see one stable outer shape
- validate contracts at build time or test time, not through browser-time filesystem scanning
- require sample/example metadata close to the skill package so docs and tests stay aligned with the capability contract

Do not bring over:

- Python interface hierarchies and manager classes for data/model/pipeline/serializer plugins
- filesystem glob discovery, `sys.path` mutation, or runtime module importing in the browser
- portal, API gateway, worker, Docker, or Kubernetes architecture
- domain-specific fairness, explainability, report-template, and widget systems

### Study selectively: `goose-1.27.2`

Use this sample only when a change needs one of these topics:

- provider-facing conversation repair before making a model or tool call
- a stable outer success/error envelope around tool results
- explicit session metadata vocabulary and update boundaries
- approval or allowlist wording that stays separate from sandbox or isolation claims

Read first:

- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/session/session_manager.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/permission/permission_confirmation.rs`
- `sample project for study logic/goose-1.27.2/crates/goose-server/ALLOWLIST.md`
- `sample project for study logic/goose-1.27.2/AGENTS.md`

Study these ideas:

- malformed tool-request and tool-response history should be repaired at the provider or conversation boundary, not deep inside planner logic
- tool results should keep a small stable outer envelope even when individual tool payloads differ
- session metadata can be explicit and typed without pulling storage or product complexity into the runtime core
- approvals, allowlists, and permissions should be documented as policy layers, not as isolation guarantees

Map into `agrun.js`:

- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs` -> `src/session/provider-conversation.js` and `agrun_docs/public-runtime-api.md`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs` -> `src/runtime/result.js` and future action/skill result normalization notes
- `sample project for study logic/goose-1.27.2/crates/goose/src/session/session_manager.rs` -> `src/session/store.js` and `agrun_docs/runtime-state-and-memory-architecture.md`
- `sample project for study logic/goose-1.27.2/crates/goose/src/permission/permission_confirmation.rs` -> `src/runtime/config.js` and `agrun_docs/spec.md`
- `sample project for study logic/goose-1.27.2/crates/goose-server/ALLOWLIST.md` -> `agrun_docs/runtime-internal-architecture.md` and future policy docs
- `sample project for study logic/goose-1.27.2/AGENTS.md` -> contributor/process wording only, not runtime design

Concrete study points:

- normalize tool-call transcripts before provider dispatch so malformed history does not leak into runtime decisions
- keep `success` versus `error` outer result handling predictable even when skill or action payloads are heterogeneous
- keep session type, name, and working-context metadata explicit instead of growing anonymous object fields
- if allowlists or approvals grow later, document them as caller policy and UX constraints, not as a security boundary by themselves

Do not bring over:

- Rust crate/workspace architecture, `sqlx` storage, or `utoipa` schema surface
- CLI, desktop app, server, or MCP extension product structure
- remote allowlist fetching, scheduler/recipe flows, subagent session types, or session search UX
- multi-model/provider orchestration and eval infrastructure
- test/build rules that depend on the Rust toolchain

### Study now: `continue-1.5.45`

Read first:

- `sample project for study logic/continue-1.5.45/README.md`
- `sample project for study logic/continue-1.5.45/CONTRIBUTING.md`

Study these ideas:

- checks should be repository-native and easy to run
- quality expectations should be written down, not assumed
- validation should stay lightweight at MVP stage

Map into `agrun.js`:

- `sample project for study logic/continue-1.5.45/README.md` -> `test/smoke.test.js`
- `sample project for study logic/continue-1.5.45/CONTRIBUTING.md` -> future small contributor docs

Concrete study points:

- keep one small smoke test that proves the runtime contract
- keep review rules in markdown so implementation stays aligned with the MVP
- prefer simple repeatable checks over a large CI/tooling surface

Do not bring over:

- Node-heavy CLI assumptions into the browser runtime
- editor/IDE product integration
- monorepo-scale process overhead

### Study later only: `AutoGPT-autogpt-platform-beta-v0.6.50`

Read only when needed:

- `sample project for study logic/AutoGPT-autogpt-platform-beta-v0.6.50/README.md`
- benchmark or protocol docs under its `agrun_docs/` tree if the project later adds adapters or evals

Study these ideas:

- protocol boundaries should be separate from runtime core
- benchmarks should be a separate layer
- platform and UI concerns should not leak into the runtime package

Map into `agrun.js`:

- future `benchmarks/`
- future protocol adapters
- future external integration docs

Concrete study points:

- use it as a boundary marker for what not to build in MVP
- borrow decomposition ideas only after `agrun.js` already has a stable core runtime shape

Do not bring over:

- hosted platform architecture
- frontend builder concepts
- marketplace or deployment stack
- continuous autonomous platform behavior

## Detailed Guidance

### 1. `swarm-main`

Primary files:

- `sample project for study logic/swarm-main/swarm/core.py`
- `sample project for study logic/swarm-main/swarm/types.py`
- `sample project for study logic/swarm-main/README.md`

Useful logic to refer to:

- a small execution loop with clear phases
- normalization of function/tool results into one result shape
- controlled passing of context into tool execution
- returning a structured response object after a run

What to borrow conceptually:

- one loop with explicit state updates after each execution step
- a thin runtime that orchestrates execution instead of embedding domain capability
- a small result model so callers get predictable output

How to map into `agrun.js`:

- `Swarm.run()` loop is a reference for `select -> execute -> observe -> update`
- `handle_function_result()` is a reference for normalizing skill output
- `handle_tool_calls()` is a reference for dispatching registered capabilities through a narrow runtime surface

What not to borrow:

- OpenAI-specific request construction
- multi-turn chat completion behavior
- agent handoff logic
- streaming transport logic
- Python/Pydantic object model

Why:

`agrun.js` is a browser-first runtime library, not a hosted LLM conversation engine.

### 2. `ai-ai-6.0.119`

Primary references:

- `sample project for study logic/ai-ai-6.0.119/architecture/provider-abstraction.md`
- `sample project for study logic/ai-ai-6.0.119/skills/use-ai-sdk/references/type-safe-agents.md`
- `sample project for study logic/ai-ai-6.0.119/examples/ai-functions/README.md`

Useful logic to refer to:

- a clean separation between user-facing functions and provider implementations
- consistent tool input/output thinking
- stable result shapes that support downstream rendering or inspection
- examples organized around capability validation

What to borrow conceptually:

- keep provider-specific behavior behind an adapter boundary
- keep skill contracts explicit so output handling stays predictable
- keep result parts structured enough for future UI or debugging use without changing the runtime core
- keep examples focused on capability smoke coverage

How to map into `agrun.js`:

- use this as a future reference for provider adapters, not for the MVP runtime loop
- use this to tighten skill result contracts in `src/skills/*`
- use this to keep runtime-owned result normalization separate from external integrations

What not to borrow:

- monorepo package architecture
- TypeScript-heavy type systems
- framework integration packages
- Node.js dev/runtime assumptions
- large provider surface area in the core runtime

Why:

`agrun.js` may later need provider or tool adapters, but the core runtime should stay provider-bounded and architecture-focused.

### 2a. `agents-js`

Primary references:

- `sample project for study logic/agents-js/agrun_docs/architecture.md`
- `sample project for study logic/agents-js/agrun_docs/state-min-spec.md`
- `sample project for study logic/agents-js/agrun_docs/skills.md`
- `sample project for study logic/agents-js/agrun_docs/reference-alignment-review.md`

Useful logic to refer to:

- a core-first layering that keeps runtime concerns separate from higher-level subsystems
- explicit minimum state contracts with named fields and invariants
- capability packaging rules that keep skill logic outside the runtime kernel
- review discipline that records which larger-system ideas are adopted and which are deferred

What to borrow conceptually:

- define runtime state shape explicitly before adding more orchestration logic
- keep architecture decisions contract-first and explicit in markdown
- use `Adapt` / `Defer` framing when a larger sample contains both useful and excessive ideas
- keep skill packaging and skill documentation independent from runtime core modules

How to map into `agrun.js`:

- use this to tighten `RunState` boundaries in `src/runtime/state.js`
- use this to keep `src/skills/*` capability-oriented instead of turning skills into mini runtimes
- use this as a agrun_docs/process reference when evaluating future sample borrowings

What not to borrow:

- Node + Browser shared-core strategy as a project requirement
- dynamic skill loading or discovery workflow
- workspace, RAG, approval, trace, and UI-heavy subsystems
- planner/evaluator/guard contracts as MVP runtime dependencies

Why:

`agents-js` is useful as a contract and boundary reference, but its system scope is much broader than the `agrun.js` MVP.

### 3. `opencode-main`

Primary references:

- `sample project for study logic/opencode-main/README.md`
- `sample project for study logic/opencode-main/packages/opencode/AGENTS.md`
- `sample project for study logic/opencode-main/SECURITY.md`

Useful logic to refer to:

- separating agent modes or permission posture from the execution kernel
- using a narrow tool contract with explicit context
- normalizing execution failures instead of letting tool-specific error shapes leak upward
- documenting that permission prompts are not a sandbox boundary

What to borrow conceptually:

- keep access mode and approval policy caller-owned rather than hardwired into the runtime loop
- keep skill execution behind a small contract with stable context shape
- prefer runtime-owned error normalization so `run()` can stay predictable
- write down security boundaries explicitly when tools can touch the host environment

How to map into `agrun.js`:

- use `README.md` as a future reference for optional mode or policy flags in `src/runtime/config.js`
- use `packages/opencode/AGENTS.md` to tighten skill execution and error/result boundaries in `src/skills/*`, `src/runtime/result.js`, and `src/runtime/errors.js`
- use `SECURITY.md` as a docs reference for keeping approval UX separate from any future sandbox claims

What not to borrow:

- Bun runtime coupling
- TypeScript and Zod implementation choices
- desktop/TUI/client-server architecture
- server mode, provider UX, or subagent product features

Why:

`opencode-main` is helpful for capability contract discipline and safety framing, but its product scope is much larger than the `agrun.js` runtime kernel.

### 4. `codex-main`

Primary references:

- `sample project for study logic/codex-main/README.md`
- `sample project for study logic/codex-main/agrun_docs/agents_md.md`
- `sample project for study logic/codex-main/agrun_docs/tui-request-user-input.md`
- `sample project for study logic/codex-main/agrun_docs/sandbox.md`

Useful logic to refer to:

- explicit scope and precedence for repository-local instruction files
- keeping skills and prompt customizations outside runtime-core modules
- representing clarification as a structured request-user-input boundary
- separating sandbox and approval policy from the core loop

What to borrow conceptually:

- define instruction layering before it reaches skill routing
- keep custom prompts, skills, and caller affordances as outer layers around the runtime
- if the runtime must pause for user clarification, use a structured event shape instead of ad hoc strings
- keep approval and sandbox concerns configurable and external to the kernel

How to map into `agrun.js`:

- use `README.md` to reinforce the client/runtime split in `agrun_docs/spec.md`
- use `agrun_docs/agents_md.md` as a future instruction-layer reference in `agrun_docs/skill-system-architecture.md`
- use `agrun_docs/tui-request-user-input.md` as a future reference for structured interruption handling near `src/runtime/input.js`
- use `agrun_docs/sandbox.md` as a future reference for optional policy flags in `src/runtime/config.js`

What not to borrow:

- Rust workspace structure
- terminal UI overlays and rendering details
- MCP/app-server integrations
- product-scale configuration, authentication, and release plumbing

Why:

`codex-main` is useful for instruction hierarchy and user-input boundary design, but those should stay as outer layers around the `agrun.js` MVP core.

### 5. `langgraph-cli-0.4.14`

Primary reference:

- `sample project for study logic/langgraph-cli-0.4.14/README.md`

Useful logic to refer to:

- explicit state transition thinking
- graph-step execution boundaries
- separation between state shape and step logic
- future direction for deterministic multi-step flows

What to borrow conceptually:

- keep state explicit instead of hiding it in side effects
- model execution as a small number of named steps
- treat orchestration as a flow problem, not as ad hoc branching

How to map into `agrun.js`:

- keep `RunState` small and explicit
- keep routing and execution separate modules
- use this as inspiration only if `agrun.js` later adds multi-step planning

What not to borrow:

- long-running orchestration
- persistence/checkpoint systems
- human-in-the-loop infrastructure
- subgraphs and advanced graph abstractions
- framework-scale dependency surface

Why:

LangGraph solves a larger problem space than the `agrun.js` MVP.

### 6. `aiverify-2.2.0`

Primary references:

- `sample project for study logic/aiverify-2.2.0/aiverify-test-engine/README.md`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.plugin.schema.json`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.algorithm.schema.json`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.testresult.schema.json`
- `sample project for study logic/aiverify-2.2.0/aiverify-test-engine/aiverify_test_engine/plugins/plugins_manager.py`
- `sample project for study logic/aiverify-2.2.0/stock-plugins/aiverify.stock.veritas/algorithms/veritastool/aiverify_veritastool/algo.meta.json`

Useful logic to refer to:

- declarative plugin and algorithm metadata
- schema-defined result envelopes with clear metadata and payload separation
- packaging discipline where capabilities ship with manifest, schema, and README together
- a registration/discovery boundary that keeps capability catalog concerns outside the execution loop

What to borrow conceptually:

- if skills later need manifests, keep them as small JSON-like descriptors instead of embedding catalog metadata in runtime code
- keep the runtime responsible for outer result normalization and let the skill own only its domain payload
- use schemas or test fixtures to lock result shape before adding more skill types
- keep capability metadata, examples, and docs close to the skill package

How to map into `agrun.js`:

- use `aiverify.plugin.schema.json` and `aiverify.algorithm.schema.json` as references for future `skill.meta` conventions in `agrun_docs/skill-system-architecture.md`
- use `aiverify.testresult.schema.json` as a reference for the boundary between runtime-owned result envelope and skill-owned output in `src/runtime/result.js`
- use `plugins_manager.py` only as a cautionary reference for registry boundaries near `src/runtime/action-registry.js`
- use example manifests like `algo.meta.json` to keep documentation and smoke fixtures aligned in `test/smoke.test.js`

What not to borrow:

- Python-first plugin runtime assumptions
- on-disk plugin discovery in the browser runtime
- manager-heavy architecture for data/model/pipeline loading
- portal, worker, gateway, and deployment surface area
- large domain-specific plugin ecosystems as an MVP requirement

Why:

`aiverify` is useful for contract discipline around capability packaging, but its platform architecture is far too large for the `agrun.js` MVP.

### 6a. `goose-1.27.2`

Primary references:

- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/session/session_manager.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/permission/permission_confirmation.rs`
- `sample project for study logic/goose-1.27.2/crates/goose-server/ALLOWLIST.md`

Useful logic to refer to:

- repairing malformed tool-call transcripts before sending them downstream
- serializing tool results behind a stable outer success/error envelope
- keeping session metadata explicit and updatable through a narrow boundary
- naming approval and allowlist choices as policy, not as sandboxing

What to borrow conceptually:

- put provider-facing conversation cleanup in a boundary module instead of spreading it through planner or runtime code
- keep outer tool result handling stable even when the inner payload shape changes
- treat session name, type, and working context as explicit metadata fields instead of ad hoc runtime state growth
- use permission vocabulary that can cleanly map to caller policy without claiming isolation

How to map into `agrun.js`:

- use `conversation/mod.rs` as a reference near `src/session/provider-conversation.js`
- use `tool_result_serde.rs` as a reference near `src/runtime/result.js`
- use `session_manager.rs` as a reference near `src/session/store.js`
- use `permission_confirmation.rs` and `ALLOWLIST.md` as references near `src/runtime/config.js` and `agrun_docs/runtime-internal-architecture.md`

What not to borrow:

- Rust implementation patterns, tracing, or SQLite-backed product storage
- desktop, CLI, server architecture, and MCP extension lifecycle
- allowlist network fetch or caching behavior
- recipe, scheduler, terminal, gateway, or subagent product concepts

Why:

`goose` is useful for boundary discipline around conversation, results, sessions, and policy wording, but its product/runtime surface is far larger than the `agrun.js` MVP.

### 7. `continue-1.5.45`

Primary reference:

- `sample project for study logic/continue-1.5.45/README.md`

Useful logic to refer to:

- repository-level quality workflow
- automated checks mindset
- markdown-defined review and validation expectations

What to borrow conceptually:

- keep validation close to the repo
- define simple smoke checks early
- make review criteria explicit instead of implicit

How to map into `agrun.js`:

- add small browser smoke tests
- document acceptance criteria for runtime behavior
- keep docs and checks aligned with the MVP contract

What not to borrow:

- monorepo-scale structure
- IDE/editor product integrations
- product-specific command tooling behavior
- large operational surface area

Why:

This sample is more useful for delivery discipline than for runtime architecture.

### 8. `AutoGPT-autogpt-platform-beta-v0.6.50`

Primary reference:

- `sample project for study logic/AutoGPT-autogpt-platform-beta-v0.6.50/README.md`

Useful logic to refer to:

- decomposition of agents into workflows and blocks
- protocol/benchmark thinking
- separation between runtime, UI, and deployment concerns

What to borrow conceptually:

- future benchmarking can be a separate concern from the runtime
- future protocol compatibility should remain an adapter, not core runtime logic
- platform concerns must stay outside the core runtime

How to map into `agrun.js`:

- maybe useful later for `benchmarks/`
- maybe useful later for agent protocol adapters
- useful now mainly as a boundary marker for what **not** to include in MVP

What not to borrow:

- server platform architecture
- frontend builder ideas
- marketplace concepts
- Docker/deployment setup
- continuous autonomous agent platform assumptions

Why:

This sample is much broader than the `agrun.js` MVP and would pull the project away from the stated runtime boundaries.

## Topic Guide: What To Study vs Clone

Use this section when the question is not "which sample first?" but "which logic for this topic is safe to study or adapt?"

### Context window management

Study:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/legacy.ts`
- `src/session/token-budget.js`
- `src/session/compaction.js`

Safe to adapt:

- explicit token-budget policy
- compaction as a separate boundary from the main runtime loop
- deterministic fallback/degradation when the prompt is too large

Do not clone:

- the full context-engine plugin API
- subagent spawn hooks
- product-specific prompt assembly pipeline

### Memory

Study:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/memory/index.ts`
- `agrun_docs/runtime-state-and-memory-architecture.md`
- `src/session/session-memory.js`

Safe to adapt:

- split "always injected memory" from "retrieve on demand"
- keep runtime-owned memory normalization separate from recall helpers
- keep semantic memory small and useful for continuity

Do not clone:

- OpenClaw's full memory indexing/search subsystem
- provider-specific embeddings or remote memory services
- filesystem-heavy workspace memory product behavior

### Conversation and session integrity

Study:

- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/session/session_manager.rs`
- `src/session/provider-conversation.js`
- `src/session/store.js`
- `src/runtime/result.js`

Safe to adapt:

- normalize provider-facing message history at one narrow boundary
- keep tool result success/error envelopes stable and runtime-owned
- make session metadata explicit instead of implicit object growth

Do not clone:

- Goose's full conversation/message model
- SQLite and session search infrastructure
- desktop or CLI session product behavior

### Multi-agent

Study:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/multi-agent.md`
- `agrun_docs/mvp.md`

Safe to adapt:

- only the boundary lesson: isolate agent identity/routing from the runtime kernel

Do not clone:

- multi-agent routing
- per-agent workspaces/auth/session directories
- channel bindings, account routing, or gateway hosting

Current rule:

- multi-agent remains out of MVP scope

### Thinking / reasoning visibility

Study:

- `sample project for study logic/openclaw-2026.3.8/src/auto-reply/thinking.ts`
- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `agrun_docs/action-contract.md`

Safe to adapt:

- separate internal reasoning metadata from final user-visible answer
- keep reasoning visibility as config/output policy, not as core loop design

Do not clone:

- provider/model-specific thinking level matrices
- channel-specific reasoning-stream behavior

### OODAE

Study:

- `agrun_docs/action-contract.md`
- `src/runtime/oodae.js`
- `sample project for study logic/swarm-main/swarm/core.py`
- `sample project for study logic/agents-js/agrun_docs/state-min-spec.md`

Safe to adapt:

- a compact explicit cycle record
- named phases that improve traceability
- small runtime-owned observe/orient/evaluate records

Do not clone:

- graph frameworks
- multi-agent decision networks
- planner stacks that require a second architecture beside the main runtime loop

Current rule:

- OODAE is an `agrun.js` internal execution discipline, not something to import wholesale from OpenClaw

## Safe Reference Decisions For Current MVP

### Current workflow issue: weak research finalize after limited readiness

Use these references when debugging the case where AI sees short workspace
output or weak evidence, declares limited readiness, but still finalizes:

- `sample project for study logic/ai-ai-6.0.119/content/docs/07-reference/01-ai-sdk-core/16-tool-loop-agent.mdx`
- `sample project for study logic/ai-ai-6.0.119/content/cookbook/05-node/56-web-search-agent.mdx`
- `sample project for study logic/agents-js/docs/state-min-spec.md`
- `sample project for study logic/agents-js/docs/evaluator-min-spec.md`
- `sample project for study logic/agents-js/utils/agent-turn-state.js`
- `sample project for study logic/agents-js/utils/agent-evaluator.js`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs`
- `sample project for study logic/swarm-main/swarm/core.py`

Safe to adapt:

- per-step loop observability;
- compact turn-state fields;
- a continuation observation based on AI-declared limited readiness;
- tool/result envelope validation;
- Inspector rows that show the AI's declared readiness vs observed state.

Do not clone:

- AI SDK's full `stopWhen` API surface;
- agents-js hardcoded completion/evidence thresholds;
- LangGraph durable graph architecture;
- any runtime rule that parses user-requested word count, language, or source
  minimum.

Current rule:

- `finalReadiness` is AI-authored. Runtime may surface and feed back the AI's
  own limited/unsatisfied declaration as a continuation signal, but runtime must
  not become the judge of answer sufficiency.

For the current `agrun.js` MVP, these are the safest references:

### Runtime loop

Refer mainly to:

- `sample project for study logic/swarm-main/swarm/core.py`

Borrow only:

- loop shape
- result normalization
- controlled capability dispatch

### State design

Refer mainly to:

- `agrun_docs/mvp.md`
- `sample project for study logic/langgraph-cli-0.4.14/README.md`
- `sample project for study logic/agents-js/agrun_docs/state-min-spec.md`

Borrow only:

- explicit state ownership
- clear step boundaries
- compact state-field and invariant thinking

### Context window and session compaction

Refer mainly to:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `sample project for study logic/openclaw-2026.3.8/src/context-engine/types.ts`
- `src/session/token-budget.js`
- `src/session/compaction.js`

Borrow only:

- explicit prompt-window policy
- compaction as a bounded session concern
- deterministic budget checks and degradation

### Memory boundary

Refer mainly to:

- `sample project for study logic/openclaw-2026.3.8/agrun_docs/concepts/system-prompt.md`
- `agrun_docs/runtime-state-and-memory-architecture.md`
- `src/session/session-memory.js`
- `src/memory/store.js`

Borrow only:

- injected-vs-retrieved memory separation
- runtime-owned memory normalization
- small semantic-memory discipline

### Conversation and session boundary

Refer mainly to:

- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/mod.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs`
- `sample project for study logic/goose-1.27.2/crates/goose/src/session/session_manager.rs`
- `src/session/provider-conversation.js`
- `src/session/store.js`

Borrow only:

- provider-facing conversation cleanup
- stable outer tool result envelopes
- explicit session metadata ownership

### Skill and error contract

Refer mainly to:

- `sample project for study logic/ai-ai-6.0.119/skills/use-ai-sdk/references/type-safe-agents.md`
- `sample project for study logic/opencode-main/packages/opencode/AGENTS.md`
- `sample project for study logic/goose-1.27.2/crates/goose/src/conversation/tool_result_serde.rs`

Borrow only:

- narrow skill execution contracts
- structured result and error normalization
- explicit separation between capability code and runtime-owned bookkeeping

### Skill manifest and result schema

Refer mainly to:

- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.plugin.schema.json`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.algorithm.schema.json`
- `sample project for study logic/aiverify-2.2.0/common/schemas/aiverify.testresult.schema.json`

Borrow only:

- declarative skill metadata
- stable outer result envelopes
- schema or fixture driven contract checks

### Instruction and approval boundary

Refer mainly to:

- `sample project for study logic/codex-main/agrun_docs/agents_md.md`
- `sample project for study logic/codex-main/agrun_docs/tui-request-user-input.md`
- `sample project for study logic/opencode-main/SECURITY.md`
- `sample project for study logic/goose-1.27.2/crates/goose/src/permission/permission_confirmation.rs`
- `sample project for study logic/goose-1.27.2/crates/goose-server/ALLOWLIST.md`

Borrow only:

- explicit instruction precedence
- structured clarification requests
- clear wording that approvals are not a sandbox guarantee

### Verification

Refer mainly to:

- `sample project for study logic/continue-1.5.45/README.md`

Borrow only:

- lightweight checks
- explicit review criteria

## Current Repo Study Order

After reading the sample files, review the matching local files in this order:

1. `agrun_docs/spec.md`
2. `agrun_docs/skill-system-architecture.md`
3. `agrun_docs/runtime-state-and-memory-architecture.md`
4. `agrun_docs/public-runtime-api.md`
5. `src/runtime/runtime.js`
6. `src/runtime/router.js`
7. `src/runtime/state.js`
8. `src/session/provider-conversation.js`
9. `src/session/store.js`
10. `src/runtime/result.js`
11. `src/runtime/errors.js`
12. `src/runtime/input.js`
13. `src/runtime/config.js`
14. `src/runtime/action-registry.js`
15. `src/session/token-budget.js`
16. `src/session/compaction.js`
17. `src/session/session-memory.js`
18. `src/memory/store.js`
19. `src/runtime/oodae.js`
20. `src/skills/echo-skill.js`
21. `src/skills/memory-skill.js`
22. `test/smoke.test.js`

This keeps the study path aligned to the current MVP:

- runtime loop first
- instruction, session, and memory boundaries second
- selection and state third
- result, error, and OODAE traceability fourth
- policy and memory boundaries fifth
- sample skills sixth
- verification last

## Logic We Should Not Take From Samples

The following should stay out of the MVP runtime:

- hosted platform features
- multi-agent handoff networks
- persistent checkpoint systems
- deployment stacks
- UI/product builder logic
- marketplace/plugin ecosystems
- heavy provider-specific abstractions
- approval UX treated as a sandbox guarantee

## Working Rule For Future Implementation

When implementing a new `agrun.js` module, write the reference note first:

```text
Reference:
- sample project X
- file Y
- borrowed idea: Z
- intentionally excluded: A, B, C
```

That keeps the project aligned with the sample folder without letting sample complexity leak into the runtime core.

Use this decision rule:

- if the sample teaches loop shape, state clarity, or test discipline, it is likely useful
- if the sample teaches instruction layering, skill contracts, or explicit safety boundaries, it may be useful if kept outside runtime core
- if the sample introduces hosting, framework, provider, deployment, or product complexity, exclude it from the MVP
