# Agentic Execution Flow

## Purpose

This document provides a complete end-to-end walkthrough of how agrun.js processes a user prompt through its agentic loop, from input normalization to final result assembly.

For the internal architecture overview, see `agrun_docs/runtime-internal-architecture.md`.
For the planner/action contract, see `agrun_docs/action-contract.md`.

## Entry Point

All execution enters through `runtime.run(input)`, which calls `runLoop()`.

```text
runtime.run(input)
  └ runLoop(options)
      ├─ Approval resolution?        → runApprovalResolution()
      ├─ Not a tool-loop request?    → INVALID_RUN_INPUT (rejected)
      └─ Tool-loop provider request  → runActionLoop()
```

### Route Selection Logic

There are exactly two accepted inputs; everything else is rejected. The legacy
skill-loop router (the removed `runSkillLoop` / `findDirectSkillMatch` /
`skill-probe` infrastructure) and the `legacySkillLoop` config option were
deleted in AGRUN-274d.

1. **Approval Resolution**: If the input is an approval resolution carrying a `resumeToken` from a prior pending-approval result, the runtime resumes the interrupted action through `runApprovalResolution()`.

2. **Tool-Loop Provider Request → Action Loop (Planner Path)**: A request with `prompt` + `provider` + `apiKey` + `model` drives the full multi-cycle OODAE action loop. There is no direct-skill-match shortcut: skills participate through planner/tool actions and engaged skill capabilities, never by bypassing the planner.

3. **Anything else → `INVALID_RUN_INPUT`**: Any non-tool-loop input (a bare `string`, `{type:"web_search",…}`, etc.) is rejected with `INVALID_RUN_INPUT` — there is no skill-only fallback path. Hosts that previously routed such inputs through the `canHandle` router must either pass a tool-loop provider request or register their capability as a `customAction` via `defineAction`.

## The OODAE Cycle

The action loop executes an explicit **Observe-Orient-Decide-Act-Evaluate** loop. Each iteration is one "cycle."

```text
┌─────────────────────────────────────────────┐
│              OODAE Cycle N                  │
│                                             │
│  OBSERVE   → Inspect input, memory, prior   │
│               observation state              │
│                                             │
│  ORIENT    → Semantic input resolution,     │
│               context snapshot assembly,     │
│               execution class routing,       │
│               read-attempt signal            │
│                                             │
│  DECIDE    → Planner request or guardrail   │
│               override → action selection    │
│                                             │
│  ACT       → Execute selected action        │
│               (web_search, read_url,         │
│                execute_skill_tool, etc.)     │
│                                             │
│  EVALUATE  → Record result, update state,   │
│               decide continue or terminate   │
│                                             │
└──────────── next cycle or exit ─────────────┘
```

### Phase 1: OBSERVE

**Source**: `beginActionLoopCycle()` → `createObserveRecord()`

Captures the current cycle's starting conditions:

- `inputType`: Type of the normalized input
- `hasTextInput`: Whether text content exists
- `memoryEntries`: Count of current memory entries
- `previousObservationKind`: Outcome kind from the prior cycle
- `previousSkill`: Skill selected in the prior cycle
- `observationSummary`: Semantic summary of the prompt (signal strength, topic hints)

### Phase 2: ORIENT

**Source**: `beginActionLoopCycle()` → multiple resolution steps

This is the most complex phase. It assembles the full context the planner needs to make a decision.

**Step 2a: Semantic Input Resolution**

`createSemanticInputResolution()` classifies the input:

- `intentState`: Goal, topic, and query extracted from the prompt
- `ambiguityState`: How ambiguous the request is (`clear`, `moderate`, `high`)
- `evidenceState`: What evidence exists from prior cycles (`none`, `partial`, `sufficient`)
- `directToolCandidate`: If a low-risk bundled tool can handle this directly
- `clarificationStatus`: Whether clarification is pending or resolved
- `inquiryContext`: Active goal, topic, query, and pending clarification state

**Step 2b: Context Snapshot Assembly**

Builds a `contextSnapshot` combining:

- `sessionMemory`: Facts, preferences, and decisions from session history
- `inquiryContext`: Current goal/topic/query and clarification state
- `readAttemptSignal`: Read-only count/threshold signal for the AI planner

**Step 2c: Research Continuity Signals**

The runtime records prior search/read state and exposes observations to the AI:

- Examines prior search results and read sources
- Checks verification state
- Counts recorded `read_url` results as `readAttemptSignal`
- Does not select a URL, force `read_url`, or force finalization
- Lets the planner/skill choose the next research action

**Step 2d: Execution Class Classification**

`classifyExecutionClass()` determines the routing strategy:

- `clarification_gate`: Required information is missing → force clarification
- `research_loop`: Full planner path required (default for all queries)

Note: The `direct_tool` execution class was removed in the AI-first refactor (AGRUN-129). All tool selection is now handled by the LLM planner via native tool calling.

### Phase 3: DECIDE

**Source**: `continueActionLoop()` → planner request or shortcut

Two decision sources, checked in priority order:

1. **Execution Class Decision**: If execution class is `clarification_gate`, bypass the planner with a pre-built clarification decision.

2. **Planner Request**: Call `requestPlanner()` to get an LLM-driven decision. This is the default path for all user queries (AI-first).

After the planner responds, **guardrails** may override:

- `finalize_to_clarify`: Prevents finalization when goal is unstable or evidence is missing
- `clarify_to_finalize`: Promotes clarification to finalization when ambiguity is inferable and evidence exists

### Phase 4: ACT

**Source**: `continueActionLoop()` → action execution

Based on the decision type:

| Decision Type | Handler |
|---------------|---------|
| `final` | `handlePlannerFinal()` — planner provided a direct answer |
| `finalize` | `executeRuntimeFinalize()` — runtime synthesizes answer from evidence |
| `clarify` | Maps to `ask_clarification` action |
| `action` | Resolves and executes the named action |

For `action` type decisions:

1. Resolve the action from the action registry
2. Evaluate action policy (`allow` / `ask` / `deny`)
3. If `ask` → return pending approval envelope to host
4. If `deny` → return policy block result
5. If `allow` → execute the action and record results

### Phase 5: EVALUATE

After action execution:

- Action result is recorded in `actionHistory`
- Research context is updated (search results, read sources)
- Agent skill context is updated if a skill tool was executed
- Observation is updated with the outcome
- If `actionResult.done` is true → exit loop and return result
- Otherwise → continue to next cycle

## Termination Conditions

The loop exits when any of these occur:

| Condition | Outcome |
|-----------|---------|
| Planner returns `type: "final"` | Direct answer from planner |
| Planner returns `type: "finalize"` | Runtime synthesizes answer from gathered evidence |
| Planner returns `type: "clarify"` | Ask user for clarification |
| Action policy is `ask` | Return pending approval to host |
| Approval denied (< 2 consecutive) | Record denied, planner picks alternative |
| Approval denied (≥ 2 consecutive) | Force finalize with available info |
| Action policy is `deny` | Return policy block |
| `cycleCount >= maxSteps` | Failure: max steps exceeded |
| Unrecoverable planner error | Failure: structured error |

## Result Assembly

`finalizeResult()` assembles the return envelope:

```text
RunResult
 ├ input          — original raw input
 ├ normalizedInput — normalized input object
 ├ selectedSkill  — skill name (if applicable)
 ├ output         — skill/action output or final answer
 ├ runState       — complete execution state snapshot
 ├ memoryEntriesAdded — entries to persist
 ├ steps          — execution trace for debugging
 ├ error          — structured error (if failed)
 └ runtimeState   — updated runtime instance state
```

## Comparison with Claude Code

| Aspect | agrun.js | Claude Code |
|--------|----------|-------------|
| **Reasoning Loop** | Explicit OODAE with cycle records | Implicit LLM reasoning per turn |
| **Decision Source** | Planner (LLM) + guardrails + continuity shortcuts | LLM tool selection directly |
| **Tool Selection** | Envelope mode (JSON parsing) OR native tool calling (provider API) — configurable via `plannerMode` | LLM native tool use |
| **Multi-Cycle** | Built-in research continuation across cycles | Single-turn tool use, context carries over |
| **Context Management** | Structured context snapshots with semantic extraction | Message-list history |
| **Approval** | Resumable with control envelopes and resume tokens | Real-time user confirmation |
| **Evidence Tracking** | Explicit research context (search results, read sources, quality tiers) | Evidence flows through conversation context |
| **Execution Routing** | AI-first: LLM planner decides all tool selection; only clarification_gate bypasses | LLM decides tool vs direct answer |
| **Error Recovery** | Planner repair cascade + LLM self-correction (configurable) | LLM self-corrects in next turn |

### What's Unique to agrun.js

- **OODAE cycle-based execution**: Every decision is traceable through observe/orient/decide/act/evaluate records
- **Dual planner modes**: Choose between JSON envelope parsing or provider-native tool calling via `plannerMode`
- **LLM self-correction**: Action errors are fed back to the planner for retry with a different approach (configurable via `selfCorrection`)
- **Research continuity**: Search/read state tracking, ranking inputs, and
  stopping signals. Automatic URL reading is legacy/simple continuity only and
  is not the ADR-0012 long-research policy path.
- **AI-first tool selection**: All tool/action decisions go through the LLM planner — no hardcoded regex shortcuts
- **Planner guardrails**: Runtime-level overrides prevent unsafe finalization or unnecessary clarification
- **Agent skills as first-class citizens**: Bundled instruction packages with tools, discoverable through catalog operations
