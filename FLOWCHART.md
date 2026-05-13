# agrun.js Flowchart

Last reviewed: 2026-05-13

Audience: end users, Web UI integrators, and new engineers who want to understand what agrun does before reading source code.

## One Sentence

agrun.js is a browser-first agent harness runtime: the host UI sends a user request, agrun builds structured context, an AI planner chooses tools or skills, the runtime executes only allowed actions, every step becomes observable state, and the host renders the final result or approval/error state.

## Latest System Development Principles Applied

These principles are based on current agent engineering guidance checked on 2026-05-13:

- OpenAI agent guidance: agent systems are built from model choice, tools, instructions, orchestration loops, and layered guardrails.
- AWS agentic AI guidance: trusted autonomy needs identity, guardrails, observability, auditability, and runtime controls.
- DORA continuous delivery guidance: high-quality systems stay deployable through automation, testing, observability, security, and low-risk change flow.

How agrun maps those principles:

| Principle | agrun meaning | Main code/docs |
|---|---|---|
| AI-first decision ownership | Runtime exposes contracts, tools, observations, and quality signals. AI/skills decide user-facing work and prose. | `src/runtime/action-loop-session-loop.js`, `agrun_docs/architecture-ssot.md` |
| Harness, not hardcode | Runtime should not special-case client topics or write brittle lexical answer rules. It should provide reusable gates and state. | `agrun_docs/architecture-ssot.md`, `src/runtime/planner-prompt.js` |
| Tool/provider separation | Host owns provider keys/endpoints. Runtime normalizes OpenAI/Gemini calls and exposes tools through an action registry. | `src/runtime/provider.js`, `src/runtime/action-registry.js` |
| Observable by default | Every run returns `steps`, `runState`, OODAE phase data, diagnostics, and result metadata for inspectors. | `src/runtime/result.js`, `agrun_docs/result-schema.md` |
| Policy at action boundary | Tool policies are allow/ask/deny by action and tier. Approval can block and resume a run. | `src/runtime/policy.js`, `agrun_docs/webui-integration-contract.md` |
| Durable context | Sessions persist messages, memory, thread routing, compaction, and TodoState across turns. | `src/session/handle.js`, `src/session/store.js` |
| Verify source to dist | Source is the SSOT; build produces browser-ready `dist/`; tests and dist checks protect regressions. | `README.md`, `build/usage-doc-plugin.cjs` |

External references:

- [OpenAI: A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- [AWS Prescriptive Guidance: Build trust through identity, guardrails, and observability](https://docs.aws.amazon.com/prescriptive-guidance/latest/strategy-operationalizing-agentic-ai/focus-areas-trust.html)
- [DORA: Continuous delivery capability](https://dora.dev/capabilities/continuous-delivery/)

## Chart 1: Whole System Big Picture

```mermaid
flowchart TD
  subgraph SourceDist["Source, Build, And Distribution"]
    Source["src/ runtime source"]
    Docs["README / FLOWCHART / agrun_docs"]
    Build["npm run build"]
    Dist["dist/agrun.js + dist docs + dist/example"]
  end

  subgraph Host["Host Product Surface"]
    User["End user"]
    HostUI["Web UI / chatbox"]
    Settings["Provider settings, model, endpoints, auth mode"]
    ApprovalUI["Approval UI"]
    InspectorUI["Inspector, Debug Report, Support Bundle"]
  end

  subgraph PublicAPI["Public Runtime API"]
    CreateRuntime["createRuntime(options)"]
    RuntimeConfig["Runtime config: skills, agentSkills, policies, stores, hooks"]
    RunAPI["runtime.run(input)"]
    SessionAPI["createSession() / openSession(id) / session.run(input)"]
    Getters["getState / getMemory / getRuntimeConfig / getActionRegistry"]
  end

  subgraph ContextHarness["Context And State Harness"]
    Normalize["Normalize input envelope"]
    SessionStore["Session store: IndexedDB or memory"]
    ThreadRouter["Thread router: new task / follow-up / drill-down"]
    Compaction["Prompt context and compaction"]
    Memory["Session memory + global memory"]
    GoalAnchor["Goal anchor and continuity snapshot"]
    RunState["RunState: runId, phase, cycles, pendingApproval, diagnostics"]
  end

  subgraph Routing["runLoop Route Layer"]
    RunLoop["runLoop()"]
    ApprovalResume{"approval_resolution?"}
    ProviderCheck{"provider present?"}
    DirectSkill{"direct skill match?"}
    SkillLoop["Skill loop"]
    ActionLoop["AI planner action loop"]
  end

  subgraph PlannerProvider["Planner And Provider Layer"]
    PlannerPrompt["Planner prompt projection: context + actions + observations"]
    PlannerMode["native_tools or envelope mode"]
    ProviderAdapter["OpenAI / Gemini provider adapter"]
    Model["LLM model"]
    PlannerDecision{"Planner decision: final, action, plan, clarification"}
  end

  subgraph ActionSurface["Action Registry And Capabilities"]
    ActionRegistry["Action registry SSOT"]
    AgentSkillCatalog["list/read/use agent skill"]
    ExecuteSkillTool["execute_skill_tool"]
    WebSearch["web_search"]
    ReadUrl["read_url"]
    TodoActions["TodoState actions"]
    WorkspaceActions["Virtual workspace actions"]
    RepoTools["optional repo_rg / repo_read_file"]
    Clarify["ask_clarification"]
  end

  subgraph Gates["Policy, Safety, And Human Control"]
    PolicyGate{"Action policy: allow / ask / deny"}
    PendingApproval["pendingApproval + resumeToken"]
    Denied["blocked or denied result"]
  end

  subgraph WorkState["Work Artifacts And Evidence"]
    TodoState["TodoState progress audit"]
    VirtualWorkspace["Browser-safe virtual draft workspace"]
    ResearchContext["Research context: search passes, read sources, evidence"]
    ToolContext["Tool context and last tool result"]
    OODAE["OODAE cycle trace: observe, orient, decide, act, evaluate"]
  end

  subgraph Terminal["Terminal Result And UI Consumption"]
    Observation["Structured observation"]
    Continue{"continue?"}
    Finalize["planner_finalize / direct_final / plan_synthesize"]
    Publish["workspace_publish_candidate"]
    Error["structured failure"]
    Result["Canonical result: output, error, steps, runState, diagnostics"]
    HostRender["Render answer, blocked approval, or error"]
    Persist["Persist messages, memory, thread metadata, TodoState"]
  end

  Source --> Build
  Docs --> Build
  Build --> Dist
  Dist --> HostUI
  Dist --> InspectorUI

  User --> HostUI
  HostUI --> RunAPI
  HostUI --> SessionAPI
  Settings --> RuntimeConfig
  RuntimeConfig --> CreateRuntime
  CreateRuntime --> RunAPI
  CreateRuntime --> SessionAPI
  Getters --> InspectorUI

  RunAPI --> Normalize
  SessionAPI --> Normalize
  Normalize --> ThreadRouter
  ThreadRouter --> Compaction
  Compaction --> Memory
  Memory --> GoalAnchor
  GoalAnchor --> RunState
  SessionStore --> ThreadRouter
  RunState --> RunLoop

  RunLoop --> ApprovalResume
  ApprovalResume -- yes --> PendingApproval
  ApprovalResume -- no --> ProviderCheck
  ProviderCheck -- no --> SkillLoop
  ProviderCheck -- yes --> DirectSkill
  DirectSkill -- yes --> SkillLoop
  DirectSkill -- no --> ActionLoop

  ActionRegistry --> PlannerPrompt
  RunState --> PlannerPrompt
  ToolContext --> PlannerPrompt
  ResearchContext --> PlannerPrompt
  TodoState --> PlannerPrompt
  VirtualWorkspace --> PlannerPrompt
  ActionLoop --> PlannerPrompt
  PlannerPrompt --> PlannerMode
  PlannerMode --> ProviderAdapter
  ProviderAdapter --> Model
  Model --> PlannerDecision

  PlannerDecision -- final --> Finalize
  PlannerDecision -- clarification --> Clarify
  PlannerDecision -- action or plan --> PolicyGate
  PolicyGate -- ask --> PendingApproval
  PolicyGate -- deny --> Denied
  PolicyGate -- allow --> ActionRegistry

  ActionRegistry --> AgentSkillCatalog
  ActionRegistry --> ExecuteSkillTool
  ActionRegistry --> WebSearch
  ActionRegistry --> ReadUrl
  ActionRegistry --> TodoActions
  ActionRegistry --> WorkspaceActions
  ActionRegistry --> RepoTools
  ActionRegistry --> Clarify

  AgentSkillCatalog --> Observation
  ExecuteSkillTool --> Observation
  WebSearch --> ResearchContext
  ReadUrl --> ResearchContext
  TodoActions --> TodoState
  WorkspaceActions --> VirtualWorkspace
  RepoTools --> Observation
  Clarify --> Observation
  ResearchContext --> Observation
  TodoState --> Observation
  VirtualWorkspace --> Observation

  Observation --> OODAE
  OODAE --> RunState
  Observation --> Continue
  Continue -- yes --> ActionLoop
  Continue -- no --> Result
  Finalize --> Result
  Publish --> Result
  PendingApproval --> Result
  Denied --> Result
  Error --> Result
  SkillLoop --> Result

  Result --> HostRender
  Result --> InspectorUI
  Result --> Persist
  Persist --> SessionStore
  Persist --> Memory
  HostRender --> User
  ApprovalUI --> SessionAPI
  Result -- pendingApproval --> ApprovalUI
```

How to read this chart:

1. Start from the left/top: source docs and runtime source build into `dist/`, which is what another engineer can receive.
2. The host product owns UI, provider settings, auth mode, approval controls, and debug panels.
3. agrun's public API turns a host request into normalized context, session/thread/memory state, and `runState`.
4. `runLoop()` chooses approval resume, skill loop, or AI planner action loop.
5. The planner sees context plus the action registry, then the policy gate decides allow/ask/deny before any action executes.
6. Actions update structured work state: research evidence, TodoState, virtual workspace, tool context, and OODAE trace.
7. The terminal result always returns one canonical envelope for UI rendering, Inspector, persistence, and debugging.

The rest of this document expands the big chart into smaller focused charts.

## Chart 2: Runtime Creation And Public API

```mermaid
flowchart LR
  Create["createRuntime(options)"] --> Config["normalize config"]
  Create --> Skills["register executable skills"]
  Create --> AgentSkills["load agent skill catalog"]
  Create --> Store["create session store: IndexedDB or memory"]
  Config --> RuntimeObj["runtime object"]
  Skills --> RuntimeObj
  AgentSkills --> RuntimeObj
  Store --> RuntimeObj

  RuntimeObj --> Run["runtime.run(input)"]
  RuntimeObj --> CreateSession["runtime.createSession()"]
  RuntimeObj --> OpenSession["runtime.openSession(id)"]
  RuntimeObj --> Inspect["getState / getMemory / getRuntimeConfig / getAgentSkills / getActionRegistry"]
```

User-facing meaning:

- `createRuntime()` is the setup point.
- `runtime.run()` is the one-turn simple API.
- `runtime.createSession()` and `runtime.openSession()` are for multi-turn chat.
- Inspector/debug tools should use the read-only getters and result envelope instead of guessing hidden runtime state.

## Chart 3: Session Run Flow

```mermaid
flowchart TD
  Start["session.run(input)"] --> AppendUser["append user message"]
  AppendUser --> RouteThread["route to thread: new task / follow-up / drill-down"]
  RouteThread --> Compact["prepare prompt context and compaction"]
  Compact --> Memory["recall session/global memory"]
  Memory --> RunLoop["runLoop(normalized input, context)"]
  RunLoop --> PersistAssistant["persist assistant/result messages"]
  PersistAssistant --> PersistState["persist thread metadata, memory, TodoState"]
  PersistState --> Return["return canonical result envelope"]
```

Important detail:

- Session logic is not just chat history.
- It protects long-running work from losing context by keeping thread identity, summaries, memory entries, and per-thread TodoState.

## Chart 4: runLoop Route Decision

```mermaid
flowchart TD
  Input["Normalized input"] --> Approval{"approval_resolution?"}
  Approval -- yes --> Resume["resolve blocked action approval"]
  Approval -- no --> Provider{"provider present?"}
  Provider -- no --> SkillLoop["runSkillLoop"]
  Provider -- yes --> DirectSkill{"direct skill match?"}
  DirectSkill -- yes --> SkillLoop
  DirectSkill -- no --> ActionLoop["runActionLoop with AI planner"]
  Resume --> Result["result"]
  SkillLoop --> Result
  ActionLoop --> Result
```

Current code fact:

- `src/runtime/run-loop.js` is the route switch.
- Provider-less or direct-skill turns use the skill loop.
- Provider-backed general agent turns use the action loop.
- Approval resume is a first-class input path, not a UI-only workaround.

## Chart 5: OODAE Action Loop

```mermaid
flowchart TD
  Observe["Observe: read request, context, last result, state"] --> Orient["Orient: build planner prompt / tool surface"]
  Orient --> Decide["Decide: AI planner selects final, action, plan, or clarification"]
  Decide --> Policy{"Action policy allow / ask / deny?"}
  Policy -- deny --> BlockOrContinue["blocked or denied result"]
  Policy -- ask --> Approval["pendingApproval for host UI"]
  Policy -- allow --> Act["Act: execute registered action"]
  Act --> ToolResult["Tool result becomes observation"]
  ToolResult --> Evaluate["Evaluate: continue, finalize, blocked, failed"]
  Evaluate -- continue --> Observe
  Evaluate -- final --> Final["terminal output"]
  Evaluate -- blocked --> Approval
  Evaluate -- failed --> Error["structured error"]
```

Why this matters:

- The runtime does not need to know the business topic.
- It provides a repeatable loop: observe, orient, decide, act, evaluate.
- Failures, blocks, and weak readiness become structured signals the UI and AI can see.

## Chart 6: Planner Action Surface

```mermaid
flowchart LR
  Planner["AI planner"] --> SkillCatalog["list_agent_skills / read_agent_skill / use_agent_skill"]
  Planner --> SkillTool["execute_skill_tool"]
  Planner --> Web["web_search"]
  Planner --> Read["read_url"]
  Planner --> Todo["todo_plan / todo_advance / todo_cancel / todo_run_next / todo_inspect"]
  Planner --> Workspace["workspace_list / read / write / replace / append / insert / finalize / publish"]
  Planner --> Repo["optional repo_rg / repo_read_file"]
  Planner --> Clarify["ask_clarification"]

  SkillTool --> Policy["policy tier gate"]
  Web --> Policy
  Read --> Policy
  Todo --> Policy
  Workspace --> Policy
  Repo --> Policy
  Clarify --> Policy
```

Action design:

- The action registry is the SSOT for planner-visible tools.
- Tools are described with name, schema, guidance, tier, and executor.
- Tier 0 defaults to allow, tier 1/2 defaults to ask, tier 3 defaults to deny unless overridden.

## Chart 7: Virtual Workspace For Long Answers

```mermaid
flowchart TD
  NeedLong["Need complex or long answer"] --> Write["workspace_write draft.md"]
  Write --> ReadDraft["workspace_read draft.md"]
  ReadDraft --> Improve{"Need revision?"}
  Improve -- yes --> Edit["workspace_replace / append / insert_after_section"]
  Edit --> ReadDraft
  Improve -- no --> Finalize["workspace_finalize_candidate"]
  Finalize --> ReadFinal["workspace_read latest candidate"]
  ReadFinal --> SyncTodo["sync TodoState with real completed work"]
  SyncTodo --> Publish["workspace_publish_candidate"]
  Publish --> Done["final answer uses candidate text directly"]
```

End-user meaning:

- For long reports, agrun can let AI draft into a browser-safe virtual workspace.
- The workspace never writes real local files.
- `workspace_publish_candidate` is the path that avoids the finalizer LLM shortening or rewriting the selected candidate.
- Runtime checks protocol facts like "was it finalized after latest write?" and "was it read after latest change?", but it does not hardcode answer quality by topic.

## Chart 8: TodoState And Progress

```mermaid
stateDiagram-v2
  [*] --> none
  none --> planned: todo_plan
  planned --> active: todo_advance start item
  active --> active: tool/workspace/search progress
  active --> blocked: todo_advance blocked
  active --> done: todo_advance done
  blocked --> active: recover / replan
  done --> active: next pending item
  done --> terminal_observed: final answer
  active --> terminal_observed: final answer with unfinished work
  terminal_observed --> [*]
```

Important rule:

- TodoState is an audit/progress contract.
- Runtime should not fake unfinished tasks as done at terminal.
- If AI finalizes early, the Inspector should show stale or unfinished TodoState instead of hiding the issue.

## Chart 9: Result And UI Consumption

```mermaid
flowchart TD
  Result["Canonical result"] --> Status{"runState.status"}
  Status -- completed --> Answer["render result.output"]
  Status -- blocked --> ApprovalUI["render pendingApproval UI"]
  Status -- failed --> ErrorUI["render structured error"]
  Result --> Steps["derive activity from result.steps"]
  Result --> OODAE["render OODAE cycles in Inspector"]
  Result --> Diagnostics["render diagnostics / failedTools / finalAnswerSource"]
  Result --> Support["support bundle / debug report"]
```

Host integration rule:

- UI should not collapse blocked and failed into the same state.
- `result.steps` and `runState` are the source for activity and inspector views.
- `phase` and OODAE are useful for debug, but normal UI should mainly follow `completed`, `blocked`, or `failed`.

## Chart 10: AI-First Harness Boundary

```mermaid
flowchart LR
  Runtime["Runtime owns"] --> Contracts["schemas, action contracts, result envelope"]
  Runtime --> Gates["policy/readiness/protocol gates as signals"]
  Runtime --> Execution["safe tool execution"]
  Runtime --> Observability["steps, runState, diagnostics"]

  AI["AI / skill owns"] --> TaskPlan["task-specific plan"]
  AI --> Prose["user-facing explanation"]
  AI --> ToolChoice["which tool to call next"]
  AI --> QualitySelfAudit["declared readiness and limitations"]

  Host["Host app owns"] --> UI["UI rendering and message storage"]
  Host --> Auth["provider keys, server proxy, fetch"]
  Host --> Approval["human approval controls"]
  Host --> Persistence["external persistence policy"]
```

This is the main mental model:

- Runtime owns the harness.
- AI owns the work decision.
- Host owns UI, auth, and product integration.
- If a bug is "the AI answered too weakly", the best harness fix is usually better observable contracts, skill workflow, or verifier feedback, not a hidden hardcoded answer rule.

## Source Reading Map

Start here if you want to inspect the code after reading the charts:

| Area | File |
|---|---|
| Runtime API | `src/runtime/runtime.js` |
| Route decision | `src/runtime/run-loop.js` |
| Main action loop | `src/runtime/action-loop-session-loop.js` |
| Planner | `src/runtime/planner.js` |
| Provider adapters | `src/runtime/provider.js` |
| Action registry | `src/runtime/action-registry.js` |
| Policy | `src/runtime/policy.js` |
| Result envelope | `src/runtime/result.js` |
| Session run | `src/session/handle.js` |
| Session storage | `src/session/store.js` |
| Virtual workspace actions | `src/runtime/actions/virtual-workspace-actions.js` |
| Todo actions | `src/runtime/actions/todo-actions.js` |
| Public runtime docs | `agrun_docs/public-runtime-api.md` |
| Result schema docs | `agrun_docs/result-schema.md` |
| Web UI contract docs | `agrun_docs/webui-integration-contract.md` |
| Architecture SSOT | `agrun_docs/architecture-ssot.md` |

## Practical Reading Order

1. Read Chart 1 and Chart 10 to understand the boundary between host, runtime, and AI.
2. Read Chart 4 and Chart 5 to understand how a request becomes either a skill loop or an AI planner loop.
3. Read Chart 6 to understand what the AI planner is allowed to do.
4. Read Chart 7 and Chart 8 to understand long-running, long-answer work.
5. Read Chart 9 before building UI, because the UI should render from the canonical result contract.

## Current Known Limitation

The current harness direction is strong, but not magic:

- Runtime can expose weak readiness, stale TodoState, missing read evidence, and publish protocol problems.
- Runtime should not secretly rewrite the answer or invent task completion.
- Weak model workflow discipline must be improved through skill instructions, planner-visible contracts, tests, and Inspector feedback.
