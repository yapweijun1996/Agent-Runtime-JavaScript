# openai-agents-js-0.11.5 Architecture Review

**Date:** 2026-05-27  
**Source:** `sample project for study logic/openai-agents-js-0.11.5/`  
**Purpose:** Identify harness patterns agrun can borrow; confirm what agrun already does better.

---

## 1. Core Agent Loop Pattern

openai-agents-js uses a `while(true)` loop driven by a **`NextStep` discriminated union** (state machine signal):

```
NextStep =
  | { type: "next_step_handoff",      agent }
  | { type: "next_step_final_output", output }
  | { type: "next_step_run_again" }
  | { type: "next_step_interruption", interruptions }
```

Each turn follows a fixed pipeline:

```
prepareModelCall()          → systemPrompt + tools + modelSettings
model.call()                → raw ModelResponse
processModelResponse()      → categorize into actions (function calls / handoffs / computer / shell)
resolveTurnAfterModelResponse() → execute tools, determine NextStep
applyTurnResult()           → write back to RunState (SSOT)
switch(nextStep)            → handoff / run_again / interruption / final_output
```

**Key insight:** `processModelResponse` is pure categorization (no side effects). `turnResolution` is pure execution. `applyTurnResult` is the single write point. This separation is what makes stream and non-stream paths share the same logic.

---

## 2. RunState as SSOT

`RunState` carries all mutable state across turns:

| Field | Purpose |
|-------|---------|
| `_currentAgent` | Active agent reference |
| `_originalInput` | Current turn's input |
| `_generatedItems` | Items produced this turn |
| `_currentStep` | Latest NextStep signal |
| `_toolUseTracker` | Tracks which tools were called (for toolUseBehavior) |
| `_inputGuardrailResults` / `_outputGuardrailResults` | Guardrail results |
| `_lastTurnResponse` | Last raw ModelResponse |
| `_currentTurn` | Turn counter |

All writes go through `applyTurnResult()`. No code outside this function mutates state directly.

---

## 3. HITL (Human-in-the-Loop) interruption/resume

When a tool requires human approval, the loop emits `next_step_interruption` and **suspends without discarding state**. On resume:

```javascript
resumeInterruptedTurn(state, approvalDecisions)
  → resolveInterruptedTurn()   // replay with approved/rejected results
  → applyTurnResult()
  → return { action: "advance_step" | "return_interruption" | "rerun_turn" }
```

The entire `RunState` is preserved — conversation history, pending tool calls, turn counter — so resumption is seamless. This is the **biggest gap** in agrun's current runtime.

---

## 4. Agent-as-Tool

`agent.asTool()` wraps any agent as a callable function tool:

```typescript
const researchAgent = new Agent({ name: "researcher", ... });
const mainAgent = new Agent({
  tools: [researchAgent.asTool({ toolName: "run_research" })]
});
```

The nested agent runs its own full loop inside the tool call. Supports streaming and approval passthrough.

---

## 5. Session Compaction

`OpenAIResponsesCompactionAwareSession` interface:

```typescript
interface OpenAIResponsesCompactionAwareSession extends Session {
  runCompaction(args?: { responseId?, compactionMode?, store?, force? }):
    Promise<{ usage: RequestUsage } | null>
}
```

Compaction can be manual (`runCompaction()`) or automatic (triggered on token threshold). Replaces the full history with a compressed version while preserving continuity.

---

## 6. toolUseBehavior — 4 stop strategies

| Strategy | Behavior |
|----------|---------|
| `run_llm_again` (default) | Always continue after tool calls |
| `stop_on_first_tool` | Stop after any tool returns |
| `stopAtToolNames: string[]` | Stop when specific tools are called |
| `(results) => "stop" \| "run_again"` | Custom function |

agrun has no equivalent — loop always continues after tool execution.

---

## 7. Guardrails

```typescript
defineInputGuardrail({ name, execute, runInParallel: true })   // before model call
defineOutputGuardrail({ name, execute })                        // after final output
```

- Input guardrails: run in parallel by default (can be `runInParallel: false` to block)
- If any guardrail returns `{ tripwireTriggered: true }`, throws `InputGuardrailTripwireTriggered`
- Guardrails run via `Promise.all()` with span tracing

---

## 8. Handoff with inputFilter

```typescript
handoff({
  agent: billingAgent,
  inputFilter: (ctx, items) => items.filter(i => i.type === "message"),
})
```

Only filtered history is forwarded to the next agent. Prevents context leakage between specialized agents.

---

## 9. Stream vs Non-stream — shared state

Both paths share `RunState` and `applyTurnResult`:

- **Non-stream:** `await model.call()` → process full response at once
- **Stream:** `for await (event of model.stream())` → collect events → same `processModelResponse` + `applyTurnResult`
- `StreamedRunResult` exposes an async iterator — caller consumes tokens as they arrive while the loop continues internally

---

## 10. agrun Advantage Areas

Things **agrun does that openai-agents-js does not**:

| agrun Feature | Why It Matters |
|--------------|---------------|
| **Browser-native runtime** | Zero server requirement; runs in any frontend chatbox |
| **Virtual Workspace** | Full content production system: read/write/patch/finalize/publish lifecycle |
| **Fuzzy replace (7+4 layers)** | Tolerates AI whitespace drift, quote variants, block anchor matching |
| **Publish protocol + readiness gates** | Quality gate before content is emitted to host |
| **AI-first permission judge** | AI classifies action permissions; cached; tier-based fallback |
| **Skills manifest system** | `defineSkill()` + `capabilities` flags; host-injectable |
| **Atomic multi-edit with rollback** | Batch workspace mutations, undo on any failure |
| **Per-turn diff tracking** | `createTurnDiffSnapshot()` / `commitTurnDiff()` for audit trail |
| **Read-before-write enforcement** | Harness-level gate; AI cannot mutate without prior read |
| **Workspace mutex** | Promise-chain lock prevents concurrent write corruption |
| **TodoState integration** | Task lifecycle tracking built into workspace |
| **Typed bus events** | `publishWorkspaceEvent()` for workspace mutation observability |

---

## 11. Gaps to Close (AGRUN-286–288)

| Ticket | Gap | Priority |
|--------|-----|---------|
| AGRUN-286 | RunState SSOT + NextStep state machine — clarify agrun's turn loop control flow | P2 |
| AGRUN-287 | HITL interruption/resume — suspend loop, preserve state, resume on approval | P1 |
| AGRUN-288 | Session compaction study — evaluate token threshold + compaction interface for agrun | P3 |

---

## 12. Verdict

> **openai-agents-js is NOT better than agrun overall — they solve different problems.**

- openai-agents-js = general-purpose agent orchestration SDK (server-side, multi-agent)
- agrun = browser-native AI-first content production harness

openai-agents-js wins on: state machine rigor, HITL, agent nesting, tracing, TypeScript  
agrun wins on: browser deployment, document quality gates, fuzzy editing, permission AI, workspace safety

The RunState + NextStep pattern is worth borrowing. HITL interruption/resume is the highest-value gap to close.
