# Open-Source AI Agent Projects — Study & Comparison

Date: 2026-06-05
Method: 10 parallel research subagents, each verifying license + architecture **directly from the live GitHub repo** (LICENSE file quoted, source tree read). Not from memory. Facts marked "unverified" where the subagent could not confirm at source-line level.

Purpose: learn how to build agents like **ChatGPT Deep Research**, **Claude Code / coding agents**, **browser-use agents**, and **enterprise/orchestration agents** — by studying the best open-source references.

---

## 0. Headline answers

**License question — all 10 are MIT at the core.** Only one caveat:
- **OpenHands**: core code is MIT, but the `enterprise/` directory has a *separate* license, so GitHub's repo-level SPDX reports `NOASSERTION` (mixed). Treat the core as MIT, the enterprise dir as not.
- Every other repo (open_deep_research, browser-use, opencode, langgraph, microsoft/agent-framework, srchd, dust, pydantic-ai, openai-agents-python) is **plain OSI MIT** — fully safe to study and reuse.

**Closest reference per category:**

| You want to build… | Study first | Why |
|---|---|---|
| ChatGPT Deep Research | **langchain-ai/open_deep_research** | Canonical open deep-research: supervisor→researcher fan-out, reflection (`think_tool`), cited report assembly. |
| Claude Code / coding agent | **anomalyco/opencode** (closest UX twin) + **OpenHands** (architecture depth) | opencode = provider-agnostic terminal coding agent w/ permission-gated tools; OpenHands = CodeAct "code-as-action" + sandbox + event stream. |
| Browser automation agent | **browser-use/browser-use** | Only true browser agent here: DOM serializer → indexed `selector_map` → action registry, on raw CDP. |
| Enterprise workflow agent | **dust-tt/dust** (product) + **microsoft/agent-framework** (SDK) | Dust = data-connected RAG platform w/ 50+ connectors; MAF = durable graph workflow engine for .NET/Python. |
| Agent framework / orchestration engine | **langgraph** (low-level) + **openai-agents-python** (minimal) + **pydantic-ai** (type-safe) | Three different altitudes of the same job. |

---

## 1. Repo comparison table

| # | Repo | License | Main purpose | Lang / stack | Agent type | Best learning value | Complexity | Beginner? |
|---|---|---|---|---|---|---|---|---|
| 1 | **langchain-ai/open_deep_research** | MIT | Open deep-research agent → long cited reports | Python on LangGraph | deep-research | Supervisor→researcher fan-out + reflection + report synthesis | Med-High | Partly (2nd project) |
| 2 | **browser-use/browser-use** | MIT | LLM drives a real browser from NL tasks | Python, async, raw CDP | browser | DOM→`selector_map`→action-registry loop | High (internals) | Use: yes / internals: no |
| 3 | **OpenHands/OpenHands** (was All-Hands-AI) | MIT core (`enterprise/` separate; repo SPDX = NOASSERTION) | Autonomous SWE agent: code, run, browse, edit repos | Python + React, Docker sandbox | coding (+browser, +orchestration) | CodeAct "code-as-action" + Event Stream + Action/Observation | High | No |
| 4 | **anomalyco/opencode** (moved from sst/opencode) | MIT | Provider-agnostic terminal coding agent (TUI) | TypeScript on Bun, Zig TUI (OpenTUI) | coding | Streaming agent loop + tool/permission model | High | No |
| 5 | **langchain-ai/langgraph** | MIT | Low-level stateful agent orchestration framework | Python (+JS SDK) | framework-orchestration | Pregel/BSP super-step + durable checkpointed state | Med-High | Partly (`create_react_agent` on-ramp) |
| 6 | **microsoft/agent-framework** | MIT | Production multi-agent SDK + workflow engine | C#/.NET + Python (polyglot) | framework-orchestration (+enterprise) | Graph workflow engine: executors+edges, checkpointing, time-travel | High | No |
| 7 | **dust-tt/srchd** | MIT | Multi-agent research harness (publish/review/cite) | TypeScript/Node, MCP, Drizzle, k8s | deep-research (multi-agent) | "Scientific-conference" publish/review collaboration pattern | High | No |
| 8 | **dust-tt/dust** | MIT | Enterprise AI-agent platform on company data | TypeScript (~92%) + Rust `core/` | enterprise-workflow | Rust block-based "LLM-app-as-pipeline" execution engine | High | No |
| 9 | **pydantic/pydantic-ai** | MIT | Type-safe Python agent framework | Python | framework-orchestration | Pydantic type-safety + DI + validated outputs w/ retry | Medium | Partly (yes) |
| 10 | **openai/openai-agents-python** | MIT | Lightweight multi-agent SDK (Swarm successor) | Python + Pydantic | framework-orchestration | Minimal explicit run loop: model→tool→handoff→output | Low-Med | **Yes — best starting point** |

Approx stars (point-in-time, mid-2026): browser-use ~97k · opencode ~170k · OpenHands ~76k · langgraph ~34k · openai-agents ~27k · pydantic-ai ~17.5k · open_deep_research ~11.6k · MAF ~11k · dust ~1.4k · srchd ~85.

**Suggested learning order for a beginner:** 10 (openai-agents) → 9 (pydantic-ai) → 5 (langgraph) → 1 (open_deep_research) → 2 (browser-use) → 4 (opencode) → 3 (OpenHands) → 6 (MAF) → 7/8 (srchd/dust).

---

## 2. Architecture breakdown (per important project)

### 2.1 langchain-ai/open_deep_research — the Deep Research reference
- **Folders** (`src/open_deep_research/`): `deep_researcher.py` (graph+nodes), `configuration.py`, `prompts.py`, `state.py`, `utils.py`. Root: `langgraph.json`, `pyproject.toml`.
- **Entry point:** `langgraph.json` → `deep_researcher` graph built by `deep_researcher_builder`.
- **Core loop:** hierarchical 3-level LangGraph — **main graph → supervisor subgraph → researcher subgraph**. Main flow: `clarify_with_user` → `write_research_brief` → `research_supervisor` → `final_report_generation`.
- **Planner:** `clarify_with_user` (structured decision to ask or not) → `write_research_brief` produces a `ResearchQuestion` brief → supervisor decomposes brief into sub-topics and delegates via a `ConductResearch` tool.
- **Tool execution:** `researcher_tools` runs tool calls in parallel with `asyncio.gather()`; `execute_tool_safely()` wraps errors; `get_all_tools()` aggregates search + MCP + `think_tool`.
- **Search:** Tavily + native provider web search (OpenAI/Anthropic) + MCP. **No headless browser** — search-API-driven.
- **State/memory:** LangGraph typed states `AgentState` / `SupervisorState` / `ResearcherState`, selective `update_payload`; LangGraph checkpointing.
- **Reflection:** `think_tool` exposed to supervisor + researchers for strategic reflection; `ResearchComplete` signals done; bounded by `max_researcher_iterations`, `max_react_tool_calls`, `max_concurrent_research_units`.
- **Final report:** `final_report_generation` synthesizes notes; on token-limit it truncates findings ~10%/attempt (max 3 retries).

### 2.2 browser-use/browser-use — the Browser agent reference
- **Folders** (`browser_use/`): `agent/` (loop + MessageManager), `tools/` (action registry/controller), `browser/` (CDP session + watchdogs), `dom/` (serializer/snapshot/markdown), `llm/`, `tokens/`, `mcp/`, `filesystem/`, `skills/`.
- **Entry point:** `Agent` class in `agent/service.py`; `await agent.run()` (up to `max_steps`).
- **Core loop (perceive→decide→act):** each step → `get_browser_state_summary()` (URL, title, tabs, screenshot, interactive elements) → `_get_next_action()` (LLM) → `_execute_actions()`.
- **Tool/action exec:** `Tools` class holds a `Registry`; actions registered `@registry.action(..., param_model=PydanticModel)`. Built-ins: click, input, navigate, scroll, search, extract, select_dropdown, upload_file, send_keys, tab switch/close, write/read file, `evaluate` (JS), wait, `done`. Per-action timeout (default 180s); multiple actions chained per step.
- **Browser control:** **raw CDP** (their own `cdp-use` lib, NOT Playwright). DOM captured by a **serializer** → indexed **`selector_map`** of interactive elements (accessibility-tree style) + screenshots + markdown extractor (hybrid).
- **Memory:** `MessageManager` history; per-step `BrowserStateSummary` injected; `AgentHistoryList` records output+results+state+metadata.
- **Error/retry:** `_handle_step_error()`; model-parse retry; rate-limit/provider error → `fallback_llm`; at `max_failures` agent is forced to only the `done` tool.
- **Final result:** any action with `is_done=True`. `done()` = `DoneAction` (text+success+files) or `StructuredOutputAction` (validated JSON when `output_model` set).

### 2.3 OpenHands/OpenHands — the Coding-agent architecture reference
- **Folders:** `agenthub/` (agent impls), `openhands/` (`controller/`, `runtime/`, `events/`, `llm/`, `memory/`, `core/`, `server/`, `security/`, `storage/`), `frontend/`, `evaluation/`. (v1.x `main` restructured into an SDK; details below from tag 0.9.0.)
- **Entry point:** `core/` runner / `server/` instantiates `AgentController` + `EventStream` + `Runtime`, feeds task as a `MessageAction`.
- **Core loop:** `AgentController._step()` — enforce `max_iterations` / `max_budget_per_task`, handle delegation, call `agent.step(state)`, publish action to event stream, run `_is_stuck()` loop detection.
- **Planner / CodeAct:** `agenthub/codeact_agent`. `_get_messages()` builds context; `step()` calls `llm.completion()` with stop tokens (`</execute_bash>`, `</execute_ipython>`, `</execute_browse>`). Planning = **code as action** (unified code action space, not discrete tool slots).
- **Tool/action exec:** `action_parser.parse()` → typed Actions: `CmdRunAction`, `IPythonRunCellAction`, `FileEditAction`, `BrowseURLAction`, `AgentDelegateAction`, `AgentFinishAction`. Each → matching **Observation** (Action/Observation abstraction).
- **Sandbox:** `runtime/` executes actions inside an isolated **Docker** container via in-container client; browsing via headless-browser plugin.
- **Memory/state:** `events/stream.py` `EventStream` = single source of truth; `add_event()` assigns sequential IDs + persists JSON; `subscribe()` fans to controller/runtime/UI; history condensation trims context.
- **Error/retry:** LLM errors caught + `report_error()`; stuck-loop → `ERROR`; LLM layer retries.
- **Final result:** `AgentFinishAction` → state `FINISHED`; diffs read from sandbox.

### 2.4 anomalyco/opencode — Claude-Code-style terminal coding agent
- **Layout:** Bun monorepo `packages/` — `opencode` (core), `server`, `web`, `desktop`, `sdk`, `plugin`, `llm`, `enterprise`, `identity`. TUI is now **OpenTUI** (Zig core + TS bindings), replacing the old Go/Bubble Tea TUI in v1.0.
- **Entry point:** `packages/opencode` bin → `./bin/opencode`; dev `bun run ./src/index.ts`.
- **Core loop** (`src/session/processor.ts`): `SessionProcessor.process` calls `llm.stream(...)`, pipes events via `handleEvent` (text-delta, tool-call, reasoning, step-start/finish); tools `ensureToolCall`→`updateToolCall`→`completeToolCall`; returns `continue`/`compact`/`stop`.
- **Planner:** exposed as tools — `plan.ts`, `task.ts` (sub-agent), `todo.ts`.
- **Tool exec:** `src/tool/` paired `.ts`+`.txt` (description): bash/shell, edit, write, read, grep, glob, apply_patch, webfetch/websearch, task, skill. `registry.ts` registers; **`permission/`** gates execution (deny → `ctx.blocked` halts loop).
- **Providers:** multi-provider via `llm` package + `src/provider` (Anthropic, OpenAI, Google, Bedrock, OpenRouter, local).
- **Memory/session:** `src/session/` (`run-state.ts`, message v2, `compaction.ts`/`overflow.ts`, snapshot/revert); SQLite persistence.
- **Coding tools:** dedicated `src/lsp/` (LSP), `git`, `worktree`, `patch`, `shell`.
- **Error/retry/permissions:** `session/retry.ts`, `message-error.ts`, `permission/`.
- **Final result:** streamed to TUI/clients incrementally until `step-finish`.

### 2.5 langchain-ai/langgraph — the orchestration foundation
- **Folders** (`libs/`): `langgraph` (core), `prebuilt` (`create_react_agent`, `ToolNode`), `checkpoint` (+ `-sqlite`, `-postgres`, `-conformance`), `cli`, `sdk-py`, `sdk-js`.
- **Core abstraction:** `StateGraph` — nodes (functions) + edges (incl. conditional). Execution on a **Pregel/BSP** runtime.
- **Execution:** discrete **super-steps**; active nodes run (parallel where independent) → write to **channels** → activate downstream. Loops are first-class (not a plain DAG).
- **State:** typed state (TypedDict/Pydantic); each key has a **reducer** (e.g. append messages vs overwrite). No reducer → overwrite.
- **Checkpointing:** pluggable checkpointers (memory/SQLite/Postgres), per-**thread** → resume-after-crash, inspection, **time-travel** (replay/fork).
- **HITL:** **interrupt** at defined points, persist, await human, resume (approval gates, state edits).
- **Prebuilt:** `create_react_agent`, `ToolNode`. Native streaming of tokens/state/events.
- **Why foundational:** cycles + durable state + checkpointing + HITL = the substrate for deep-research loops, coding agents, multi-agent systems.

### 2.6 microsoft/agent-framework — durable enterprise orchestration SDK
- **Folders:** `dotnet/`, `python/`, `declarative-agents/` (YAML), `docs/`, `schemas/`. .NET: `Microsoft.Agents.AI(.Abstractions/.Workflows/.OpenAI/.Anthropic/.Hosting/.Mcp/.DurableTask/...)`. Python: `core`, `declarative`, `orchestrations`, provider pkgs, Azure integrations, `devui`, `a2a`, `mem0`, `redis`, `durabletask`.
- **Core abstractions:** `AIAgent` (base), `ChatClientAgent`; workflows = **executors** + **edges**.
- **Agent loop:** `.run()`/`.RunAsync()` through a **middleware/interceptor** chain.
- **Multi-agent patterns:** sequential, concurrent, handoff, group-chat, **magentic** (AutoGen Magentic-One manager).
- **Workflow engine:** graph of executors+edges, streaming, **HITL**, **time-travel**, **checkpointing/restartability**, `DurableTask` for durable execution.
- **Tools:** function tools + **MCP**. **Memory:** thread/conversation + pluggable stores (mem0/redis/Cosmos). **Observability:** built-in **OpenTelemetry**.
- **Enterprise:** Hosting (AspNetCore/AzureFunctions), Purview/governance, Foundry, durability. Successor of **Semantic Kernel + AutoGen** (ships migration guides).

### 2.7 dust-tt/srchd — emergent multi-agent research harness
- **Folders:** `agents/` (profiles: prompt.md/settings.json/Dockerfile), `problems/` (IMO/security/ARC-AGI-2), `src/` (`runner/`, `tools/`, `db/`, `models/`, `server/`, `computer/`, `migrations/`).
- **Entry:** `src/srchd.ts` CLI; UI at `localhost:1337`.
- **Loop:** `src/runner/` tick-based — load system prompt + history → init LLM → connect MCP tool servers → generate w/ tool calls → execute + store → record tokens → loop.
- **Planner/reflection:** **emergent via publication/review** (no monolithic planner); agents self-edit their own system prompt (`system_prompt_self_edit.ts`) + peer-review publications.
- **Tools (MCP):** `publications.ts`, `goal_solution.ts`, `system_prompt_self_edit.ts`, `web.ts` (search/scrape, optional Firecrawl), `computer_process.ts` (commands in k8s pods).
- **Memory:** Drizzle DB — `messages`, `evolutions`, `agents`, `publications`, `solutions`.
- **Final output:** `solutions` + `goal_solution`; UI shows publications + citation graph. (Claims real CVE discoveries in Tor/ksmbd.)

### 2.8 dust-tt/dust — enterprise data-connected agent platform
- **Folders:** `front/` (Next.js builder UI), `front-api/`, `core/` (**Rust** engine), `connectors/` (TS ingestion), `sdks/`, `cli/`.
- **Core "Dust apps"/blocks engine (Rust):** `core/src/` `app.rs` + `run.rs` + `blocks/`. Block types: `llm.rs`, `chat.rs`, `code.rs`, `curl.rs`, `browser.rs`, `search.rs`, `data_source.rs`, `database.rs`, + control-flow `map.rs`/`reduce.rs`/`while.rs`/`input.rs`/`output`. Apps = composable block pipelines run by Rust engine; Deno sandbox for dynamic JS/TS.
- **Agents:** visual builder (instructions + tools + knowledge sources), invoked by `@mention`.
- **Tools/RAG:** `connectors/` for Notion, Slack, Google Drive, GitHub, Confluence, Intercom, Salesforce, Zendesk, Snowflake, BigQuery, webcrawler… (50+). `data_sources/` + `search_stores/` = embedding/retrieval.
- **Enterprise:** workspaces, SAML SSO, RBAC, audit logs, OAuth per connector (`core/src/oauth`).
- **Final answers:** LLM blocks synthesize retrieved RAG context.

### 2.9 pydantic/pydantic-ai — type-safe agent framework
- **Module:** `pydantic_ai_slim/pydantic_ai/`. `Agent` class in `agent/__init__.py` (`class Agent(AbstractAgent[AgentDepsT, OutputDataT])`); siblings `_agent_graph.py`, `tools.py`, `result.py`, `output.py`, `messages.py`, `_run_context.py`; folders `models/`, `providers/`, `toolsets/`, `common_tools/`.
- **Core abstraction:** generic `Agent[DepsT, OutputT]` — typed deps + typed output (compile-time checked).
- **Run loop:** model calls interleaved with tool calls until final output; internally a graph (`_agent_graph.py`); `agent.iter` for node-by-node iteration; **pydantic-graph** for complex control flow.
- **Tools:** `@agent.tool` / `@agent.tool_plain`; first arg `RunContext` carries deps; args → Pydantic-validated JSON schema.
- **Structured output:** `output_type` validated by Pydantic; on failure **re-prompt to retry** (self-correction).
- **DI:** typed `RunContext[DepsT]` injects deps into tools + dynamic instructions/system prompts.
- **Errors:** `ModelRetry` exception requests a retry; validation failures auto re-prompt.
- **Final result:** `AgentRunResult.output`, guaranteed to match `output_type`.

### 2.10 openai/openai-agents-python — minimal multi-agent SDK (best first read)
- **Module** (`src/agents/`): `agent.py`, `run.py`, `tool.py`, `guardrail.py`, `result.py`, `run_state.py`, `stream_events.py`, `exceptions.py`; subpkgs `handoffs/`, `tracing/`, `memory/` (sessions), `models/`, `mcp/`, `voice/`, `realtime/`.
- **Core abstractions:** `Agent` (instructions + tools + guardrails + handoffs), `Runner` (executes loop).
- **Run loop** (`Runner.run`/`run_sync`): model call → execute requested tools → feed results back → handoffs → repeat until final output or `max_turns`.
- **Handoffs:** agent-to-agent delegation modeled as a special tool.
- **Tools:** Python function tools (auto-schema'd), hosted tools (web search, file search, computer use), MCP.
- **Guardrails:** parallel input/output validation; tripwire halts run.
- **Sessions/memory:** `memory/` Sessions API auto-manages history across runs.
- **Structured output:** Pydantic `output_type` → typed `final_output`.
- **Tracing:** built-in spans (model/tool/handoff/guardrail) → Agents Tracing UI.
- **Errors:** `MaxTurnsExceeded` bounds loop; guardrail tripwires stop execution.

---

## 3. Deep Research architecture map (text diagram)

Reference implementation: **open_deep_research** (+ srchd for the multi-agent variant).

```
                          ┌─────────────────────────────────────────────┐
                          │  USER TASK ("write a report on X")           │
                          └───────────────────────┬─────────────────────┘
                                                  ▼
                    ┌────────────────────────────────────────────────────┐
                    │ CLARIFY  (ask follow-ups only if scope ambiguous)  │  ← structured decision
                    └───────────────────────┬────────────────────────────┘
                                            ▼
                    ┌────────────────────────────────────────────────────┐
                    │ WRITE RESEARCH BRIEF  → ResearchQuestion (plan)    │  ← PLANNER
                    └───────────────────────┬────────────────────────────┘
                                            ▼
              ┌──────────────────────────────────────────────────────────────┐
              │ SUPERVISOR  — decompose brief into sub-topics                 │
              │   delegates via ConductResearch tool (fan-out, bounded by     │
              │   max_concurrent_research_units)                              │
              └───────┬───────────────┬───────────────┬──────────────────────┘
                      ▼               ▼               ▼      (parallel researchers)
            ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
            │ RESEARCHER A  │ │ RESEARCHER B  │ │ RESEARCHER C  │   each = bounded ReAct loop
            │  ┌──────────┐ │ │     ...       │ │     ...       │
            │  │ SEARCH   │ │ │               │ │               │   ← Tavily / native web search / MCP
            │  │ (web/api)│ │ │               │ │               │     (browser-use here if you need
            │  └────┬─────┘ │ │               │ │               │      real page interaction)
            │       ▼       │ │               │ │               │
            │  READ SOURCES │ │               │ │               │   ← read_url / fetch page content
            │       ▼       │ │               │ │               │
            │ EXTRACT EVIDENCE                │ │               │   ← pull facts + citations
            │       ▼       │ │               │ │               │
            │ REFLECT (think_tool):           │ │               │   ← "enough? what's missing?"
            │   gap? → loop SEARCH again       │ │               │      bounded by max_react_tool_calls
            │   done? → ResearchComplete        │ │               │
            │       ▼       │ │               │ │               │
            │  COMPRESS notes│ │               │ │               │
            └───────┬───────┘ └───────┬───────┘ └───────┬───────┘
                    └───────────────┬─┴───────────────┬─┘
                                    ▼                 ▼
                    ┌────────────────────────────────────────────────────┐
                    │ SUPERVISOR REFLECT — coverage gap? → spawn more     │  ← bounded by
                    │   researchers ; else → finalize                     │     max_researcher_iterations
                    └───────────────────────┬────────────────────────────┘
                                            ▼
                    ┌────────────────────────────────────────────────────┐
                    │ FINAL REPORT GENERATION                            │
                    │   synthesize all notes → long cited report          │
                    │   token-limit guard: truncate ~10%/attempt (≤3)     │
                    └───────────────────────┬────────────────────────────┘
                                            ▼
                                   ┌─────────────────┐
                                   │  CITED REPORT   │
                                   └─────────────────┘

STATE / MEMORY (cross-cutting): LangGraph typed state (AgentState/SupervisorState/
ResearcherState) + checkpointer → resumable, inspectable, time-travel.
```

**Key transferable lessons for agrun:**
1. **Separate planner (brief) from workers (researchers)** — don't make one loop do everything.
2. **Reflection is an explicit tool** (`think_tool` / ResearchComplete), not implicit — this is the convergence control agrun's benchmark runs were missing.
3. **Bound every loop** (`max_*_iterations`, `max_react_tool_calls`) — the cure for the 30-min publish/repair non-convergence seen in the gpt-low benchmark.
4. **Grounding > fluency** — extract evidence + citations per source (srchd enforces this via publish/review). Matches the agrun KB finding that DeepSeek fabricates fluent numbers.

---

## 4. Coding Agent architecture map (text diagram)

Reference: **OpenHands (CodeAct)** + **opencode** (tool/permission UX). This mirrors how Claude Code works.

```
        ┌─────────────────────────────────────────────────────────────┐
        │ USER TASK ("fix bug / add feature in this repo")            │
        └──────────────────────────────┬──────────────────────────────┘
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │ REPO SCAN / CONTEXT GATHER                                  │
        │   bash: ls / grep / glob ; read files ; LSP symbols         │  ← tools: read, grep, glob, lsp
        └──────────────────────────────┬──────────────────────────────┘
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │ PLAN  (todo list / plan tool)                              │  ← opencode plan.ts/todo.ts;
        │   decompose into ordered steps                              │     OpenHands: plan = next code action
        └──────────────────────────────┬──────────────────────────────┘
                                        ▼
   ╔════════════════════════ AGENT LOOP (per step) ════════════════════════╗
   ║                                  ▼                                     ║
   ║   ┌───────────────────────────────────────────────────────────────┐  ║
   ║   │ DECIDE next ACTION (LLM)                                       │  ║
   ║   │   CodeAct: emit code block (bash / python / file-edit)         │  ║  ← model call (stream)
   ║   └───────────────────────────────┬───────────────────────────────┘  ║
   ║                                   ▼                                    ║
   ║   ┌───────────────────────────────────────────────────────────────┐  ║
   ║   │ PERMISSION GATE  (opencode permission/) — user/auto approve?   │  ║  ← halt if denied (ctx.blocked)
   ║   └───────────────────────────────┬───────────────────────────────┘  ║
   ║                                   ▼                                    ║
   ║   ┌───────────────────────────────────────────────────────────────┐  ║
   ║   │ EXECUTE ACTION in SANDBOX                                      │  ║
   ║   │   FileEditAction / apply_patch  → write code                  │  ║  ← Docker sandbox (OpenHands)
   ║   │   CmdRunAction (bash)           → run tests / build           │  ║     or local shell (opencode)
   ║   └───────────────────────────────┬───────────────────────────────┘  ║
   ║                                   ▼                                    ║
   ║   ┌───────────────────────────────────────────────────────────────┐  ║
   ║   │ OBSERVATION  (test output / stack trace / diff)               │  ║  ← Action→Observation pair,
   ║   └───────────────────────────────┬───────────────────────────────┘  ║     appended to Event Stream
   ║                                   ▼                                    ║
   ║   ┌───────────────────────────────────────────────────────────────┐  ║
   ║   │ ERROR ANALYSIS / REFLECT                                      │  ║
   ║   │   tests fail? → diagnose → PATCH → loop                       │  ║  ← stuck-loop detection
   ║   │   stuck (repeat action)? → break / escalate                   │  ║     (_is_stuck / fingerprint)
   ║   │   context too big? → COMPACT history                          │  ║  ← compaction/overflow
   ║   └───────────────────────────────┬───────────────────────────────┘  ║
   ║                                   ▼                                    ║
   ║              tests green & goal met?  ── no ──┐ (loop, bounded by      ║
   ║                                   │            │  max_iterations/budget)║
   ╚═══════════════════════════════════│════════════┘                       ║
                                        │ yes
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │ FINAL SUMMARY  (AgentFinishAction)                          │
        │   diff / changed files / what was done / how verified        │
        └─────────────────────────────────────────────────────────────┘

STATE / MEMORY (cross-cutting): OpenHands Event Stream (every Action+Observation
persisted, sequential IDs, replayable) ; opencode sessions + SQLite + snapshot/revert.
```

**Key transferable lessons for agrun:**
1. **Action/Observation as the unit + a durable Event Stream** = exactly the "SSE-like JSONL progress" agrun already adopted; OpenHands shows the mature version (replayable, single source of truth).
2. **Permission gate before execute** (opencode) — clean separation of "model proposes" vs "runtime allows," the pattern agrun KB already noted other agents use.
3. **Stuck-loop / fingerprint detection** (`_is_stuck`, action-fingerprint-repeat) — directly relevant to agrun's terminal-repair non-convergence (504 repair-state refreshes in the gpt-low benchmark).
4. **Compaction when context overflows** — opencode `compaction.ts`/`overflow.ts`; agrun should treat this as first-class, not emergency.
5. **CodeAct "code-as-action"** vs discrete tool slots — a unified action space reduces the "model picks wrong tool surface" failures agrun hit (AGRUN-301/305).

---

## 5. How this maps back to agrun (why we studied this)

- **Convergence control is the #1 gap.** Every mature agent here *bounds its loops* and has *explicit stuck detection* (OpenHands `_is_stuck`, open_deep_research `max_*_iterations`). agrun's benchmark non-convergence (gpt-low: 504 terminal-repair refreshes / 30 min) is the symptom of a missing deterministic bound + reflection-as-tool.
- **Permission/tool surface separation** (opencode, openai-agents handoffs) supports the agrun direction of separating skill-tool namespace from runtime action namespace.
- **Event stream as SSOT** (OpenHands) validates agrun's progress-JSONL choice — and the next step (redacted payload/reason capture) is exactly what OpenHands' Action/Observation already carries.
- **Grounding > fluency** (srchd publish/review, open_deep_research evidence extraction) matches the agrun KB finding that DeepSeek produces fluent but fabricated numbers — enforce primary-source citation, not URL reachability.

---

## Sources
All facts verified by 10 parallel research subagents reading each repo's live LICENSE + source tree on 2026-06-05. Items the subagents could not confirm at source-line level are marked "unverified" in their raw reports. Star counts and release dates are point-in-time (mid-2026) approximations.
