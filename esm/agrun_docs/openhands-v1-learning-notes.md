# OpenHands V1 — Learning Notes for agrun

Date: 2026-06-07
Source: https://github.com/OpenHands/OpenHands (MIT license)
Sample code at: `sample-projects/openhands-sdk/`

## Executive Summary

OpenHands V1 Software Agent SDK is the best peer reference for agrun. The two projects solve the same fundamental problem — how to build a stable LLM agent runtime — but from opposite directions: agrun is browser-first JavaScript with OODAE cycles + terminal repair, OpenHands is Python/server with event sourcing + pure-function components. The architectural patterns are language-agnostic and directly applicable.

**Verdict**: Worth deep study. 5 concrete patterns can improve agrun. 3 areas where agrun is already better.

---

## 1. Agent as Pure Function (Pattern to Adopt)

### OpenHands V1
```python
# Agent is a frozen dataclass (immutable Pydantic model)
# It has NO mutable state. It receives history, returns next action.

@dataclass(frozen=True)
class Agent(AgentBase):
    llm: LLM                          # immutably configured
    tools: list[Tool]                  # immutably configured
    condenser: CondenserBase | None    # immutably configured

    def step(self, conversation, on_event, on_token=None) -> None:
        # Pure: takes state, produces events
        state = conversation.state     # the only mutable thing
        pending = state.get_unmatched_actions(state.events)
        if pending:
            self._execute_actions(conversation, pending, on_event)
            return
        msgs = prepare_llm_messages(state.events, condenser=self.condenser)
        response = make_llm_completion(self.llm, msgs, tools=self.tools_map)
        match classify_response(response.message):
            case TOOL_CALLS:    self._handle_tool_calls(...)
            case CONTENT:       self._handle_content_response(...)
```

### agrun Current State

```javascript
// agrun's planner has state coupled through runState (80+ fields)
// The action-loop-session-loop.js owns the loop, not the planner

while (runState.cycleCount < maxSteps) {
    cycleRecord = await beginActionLoopCycle(session, "planner");
    await requestPlanner({ runState, actionHistory, ... });
    await executePlan(...);
    noteCycleCompleted(...);
    refreshTerminalRepairState(runState, pushStep);
}
```

### Gap & Opportunity

agrun's `requestPlanner()` is conceptually similar to `Agent.step()` — it builds a prompt, calls the LLM, and returns a decision. But it's coupled to `runState` mutation and spread across multiple files (`action-loop-planner.js`, `planner.js`, `planner-prompt.js`).

**What to change**: Extract a `Planner` (pure function) from the loop. The planner takes `(events, tools, config)` → returns `(decision, observation)`. The loop owns state mutation. This is exactly the separation OpenHands V1 demonstrates.

---

## 2. Immutable Event-Sourced SSOT (Partly Adopted)

### OpenHands V1
```python
# Every interaction is a typed, immutable Event
class Event(BaseModel, frozen=True):
    id: str
    source: Literal["agent", "user", "environment"]
    timestamp: float

class ActionEvent(Event):        # agent → environment
    action: Action
    tool_name: str
    ...

class ObservationEvent(Event):    # environment → agent
    observation: Observation
    tool_name: str
    ...

# EventLog is append-only
state.events.append(event)       # never edit, only supersede via CondensationEvent
```

### agrun Current State

agrun has THREE overlapping event representations:
1. `result.steps[]` — raw step array
2. `runtime-event-ledger.js` — normalized sequence + phase + mode
3. Observer JSONL — dual-stream (harness + model)

### Gap & Opportunity

These three could be unified into ONE append-only event log with typed events. The observer JSONL is already close — it has `seq`, `ts`, `channel`, `type`, and typed data. The next step is to make it the PRIMARY source of truth, not a derivative.

**What to change**: Define a formal `Event` type (like `ActionEvent`, `ObservationEvent`, `PlannerEvent`) and make the observer JSONL the canonical event log. `steps[]` and `event-ledger` become views derived from the same log.

---

## 3. Condenser as Pluggable Component (Pattern to Adopt)

### OpenHands V1
```python
class CondenserBase(ABC):
    """Produces condensation events that supersede old event ranges."""
    
    def handles_condensation_requests(self) -> bool: ...
    def compress(self, events) -> Condensation: ...

class LLMSummarizingCondenser(CondenserBase):
    max_size: int = 240
    keep_first: int = 2
    llm: LLM   # condenser uses its own (cheaper) LLM

# In the agent loop:
msgs_or_condensation = prepare_llm_messages(state.events, condenser=self.condenser)
if isinstance(msgs_or_condensation, Condensation):
    on_event(msgs_or_condensation)  # event supersedes old range
    return                           # rerun step with condensed context
```

### agrun Current State

agrun has `session/compaction.js` and `session/context-window-summary.js` which handle context overflow. But the coupling is high — the compaction policy is mixed with the session layer rather than being a pluggable component at the agent level.

### Gap & Opportunity

Make condensation a pluggable component (like `observer.mjs` is now). Agent configures: `condenser: "summarize"` or `condenser: "truncate"`. The condenser produces a `CondensationEvent` that marks which events are superseded. The prompt builder treats those ranges as summarized.

---

## 4. Action/Observation Strict Uni-direction (Pattern to Adopt)

### OpenHands V1
```python
# Every action produces EXACTLY ONE observation. No ambiguity.
observation = tool(action_event.action, conversation)
assert isinstance(observation, Observation), "Tool must return Observation"

obs_event = ObservationEvent(
    observation=observation,
    action_id=action_event.id,   # links back to the action
    tool_name=tool.name,
)
```

### agrun Current State

agrun's `action-result-envelope.js` has `normalizeActionResultEnvelope` which tries to enforce this contract but the pattern is not universal.

### Gap & Opportunity

Enforce strict unidirectional Action → Observation coupling. Every action handler MUST return an observation. The action_id ↔ observation_id link must be a structural guarantee, not a convention.

---

## 5. StuckDetector as Independent Plugin (Pattern to Inform)

### OpenHands V1
```python
# StuckDetector is separate from Agent — reads events, produces warning
class StuckDetector:
    max_repeated_actions: int = 10
    no_progress_threshold: int = 15
    
    def check(self, events: EventLog) -> StuckDetection | None:
        # pure function: events in, detection out
        ...
```

### agrun Current State

agrun's `terminal-repair-state.js` + `action-pattern-convergence.js` + `action-pattern-progress.js` together cover stuck detection AND repair. This is MORE sophisticated than OpenHands' approach (OpenHands just offers restart/stop, agrun offers graceful degradation).

### Gap & Opportunity

agrun's stuck detection could be EXTRACTED from the action loop into a separate `StuckDetector` utility (like `observer.mjs` was extracted from `live-observe.mjs`). The repair logic (`terminal-repair-state.js`) would then consume the detector's output rather than being interleaved in the loop.

---

## 6. Iterative Refinement (Pattern to Consider)

### OpenHands V1
```python
# After FinishAction, agent can run a critic check
# If critic says "not good enough", inject a user message with specific feedback
batch.finalize(
    check_iterative_refinement=lambda ae: (
        self._check_iterative_refinement(conversation, ae)
    ),
    mark_finished=...,
)

# The followup message becomes the next user input:
on_event(MessageEvent(source="user", llm_message=Message(
    role="user", content=[TextContent(text=followup)]
)))
```

### agrun Current State

agrun's terminal repair + output guardrails (`output-guardrail-recipes.js`) are similar — they detect quality issues and steer the agent toward repair. But they work at the level of action blocking/recovery rather than injecting structured feedback as a user message.

### Gap & Opportunity

Consider adding a "critic" phase to the OODAE cycle. After evaluate, a critic can inject specific, actionable feedback before the next observe. This would formalize the current ad-hoc repair feedback loop.

---

## 7. Model Routing for Cost Optimization (Future Pattern)

### OpenHands V1
```python
# Experimental: route to cheaper model by default,
# switch to expensive model for complex tasks
class RuleBasedCostSavingRouter:
    primary_llm: LLM      # expensive (gpt-5.5)
    secondary_llm: LLM     # cheap
    context_threshold: int
    
    def route(self, messages: list[Message]) -> str:
        if needs_multimodal(messages): return self.primary_llm.service_id
        if exceeds_context(messages, self.context_threshold): return self.primary_llm.service_id
        return self.secondary_llm.service_id
```

### agrun Implication

agrun benchmark data (AGRUN-306) shows gpt-low is MORE expensive than gpt-high due to churn ($3.53 vs $0.53). A model router that selects gpt-high for report tasks and gpt-low for quick facts could optimize cost without sacrificing quality.

---

## What agrun Does BETTER

| Capability | agrun | OpenHands V1 |
|-----------|-------|--------------|
| **Graceful degradation** | AGRUN-307/309: terminal repair → guaranteed deliverable | Restart/stop only |
| **Citation verification** | Evidence graph + source authority + claim coverage | None |
| **Output guardrails** | Quality recipes (near-duplicate, structure, rehash) | None |
| **OODAE phase tracking** | 5-phase cycle records | Implicit in event log |
| **Dual-stream observer** | LLM requests + harness events in one stream | Event log only |
| **Browser-first** | Native browser runtime | Docker/containers required |
| **Tool policy (allow/ask/deny)** | `policy.js`, per-action tiers | Confirmation mode (binary) |
| **Research report loop** | `research-report-loop.js` | Not domain-specific |

---

## Concrete Action Items for agrun

### Short-term (this milestone)
- [ ] Extract `Planner` from `action-loop-planner.js` as a pure-function module
- [ ] Define formal `Event` types (matching observer JSONL shape)
- [ ] Document the event log as SSOT in architecture docs

### Medium-term (next milestone)
- [ ] Extract `StuckDetector` from `action-pattern-convergence.js` + `action-pattern-progress.js`
- [ ] Make `Condenser` a pluggable component at the agent config level
- [ ] Enforce strict Action → Observation uni-direction across all paths

### Long-term / research
- [ ] Model routing for cost optimization (cheap for facts, expensive for reports)
- [ ] Formal "critic" phase in OODAE cycle
- [ ] Event replay for time-travel debugging

---

## References

- OpenHands SDK source: `sample-projects/openhands-sdk/`
- Key file: `openhands-sdk/openhands/sdk/agent/agent.py` (Agent.step loop)
- Key file: `openhands-sdk/openhands/sdk/agent/base.py` (AgentBase configuration)
- SDK paper: arXiv 2511.03690
- OpenHands article: https://www.openhands.dev/blog/agent-control-plane
