# ADR-0043 — handoff_to_skill action

**Date:** 2026-05-27  
**Status:** Accepted  
**Author:** yapweijun1996

---

## Context

agrun has two multi-agent primitives:
- `spawn_subagent` — parallel fork: child runs independently, result returns to parent. Depth=1.
- `use_agent_skill` — skill loader: activates a skill's instructions for the current loop.

Neither models **sequential handoff**: "I'm done with phase A; transfer control to skill B to continue the same session."

openai-agents-js (studied 2026-05-27) solves this with `Handoff` — the LLM calls `transfer_to_<agent>` as a function tool; the harness switches the active agent, optionally filters history via `inputFilter`, and continues the same loop.

agrun needs the same pattern for:
- Customer service flows: `triage → billing → refund` (same conversation, different skill)
- Pipeline stages: `research → write → review` where each stage has its own skill
- Skill chaining: AI explicitly delegates phase boundary to the host, host shows "now handled by X"

## Decision

Add `handoff_to_skill` action to agrun's bundled action catalog.

**Mechanics:**
1. AI calls `handoff_to_skill({ skillName, handoffContext?, inputFilter? })`
2. Action looks up target skill from `context.agentSkills` / `context.agentSkillIndexProvider`
3. Returns `{ kind: "agent_handoff", fromSkill, handoffChain, skill, handoffContext, inputFilter }`
4. Shared handoff side-effect logic handles outcome in both standalone and plan execution paths: sets `runState.agentSkillContext.activeSkill = skill`, stores `handoffContext`, records `handoffChain`, and applies any requested input filter
5. Planner prompt projects `handoffContext` into `loopState.handoffContext`, so the receiving skill can inspect the phase-boundary message alongside `loopState.activeAgentSkill`
6. Loop continues — next planner cycle runs under the new skill's instructions

**Distinct from `use_agent_skill`:**
- `use_agent_skill` = "load this skill to help me" (additive, no phase signal)
- `handoff_to_skill` = "I'm done; pass control to X" (explicit phase boundary + handoff message)
- Output event is `agent_handoff` (not `agent_skill_activated`) — hosts can intercept for UI phase indicators

**MVP scope (this ADR):**
- `skillName` + `handoffContext` args
- Skill lookup from bundled + provider
- `agent_handoff` step event
- `runState.agentSkillContext.handoffContext` for receiving skill to inspect
- `handoff_to_skill` is standalone-only in plan validation because it mutates active skill/run state
- `loopState.handoffContext` planner projection for the next skill cycle

**AGRUN-289b amendment: `inputFilter`**
- `handoff_to_skill` accepts optional `inputFilter`
- AI can pass a declarative filter object, for example:

  ```json
  {
    "actionHistory": { "keepLast": 3 },
    "toolHistory": { "keepLast": 0 },
    "readSources": { "keepLast": 2 },
    "sessionMemory": { "history": "clear", "recentTurns": { "maxChars": 1200 } }
  }
  ```

- Hosts can register named filters through `createRuntime({ handoffInputFilters })`; each filter may be a declarative object, alias string, or async function that receives a cloned history packet and returns the replacement packet
- Filterable packet fields are `actionHistory`, `toolHistory`, `lastToolResult`, `readSources`, `searchResults`, and `contextSnapshot.sessionMemory`
- Runtime records `agentSkillContext.handoffInputFilter` and `handoffInputFilterReport` for inspector/debug use, and emits `agent-handoff-input-filter-applied` / `agent-handoff-input-filter-skipped`

**AGRUN-289c amendment: cycle detection**
- Runtime tracks the sequential handoff path in `runState.agentSkillContext.handoffChain[]`
- Successful handoff appends the receiving skill; `use_agent_skill` resets the handoff chain anchor to the selected skill
- Before switching skill, `handoff_to_skill` checks whether the requested target already appears in the current chain
- If a repeated skill is found, the action emits `agent_handoff_cycle_detected`, records `agentSkillContext.handoffCycle`, returns `control: "complete"` with `error.code: "HANDOFF_CYCLE_DETECTED"`, and does not replace `activeSkill`
- This is a mechanical loop guard only. Runtime does not author a fallback answer or choose a different skill; the host/AI receives the structured terminal output

**Out of scope (future):**
- Cross-session handoff (AGRUN-289d)

## Alternatives Considered

### A. Re-use `use_agent_skill` with `handoff: true` flag
Rejected — conflates two semantically different intents. `use_agent_skill` is "I need this skill now"; `handoff_to_skill` is "I'm transferring phase ownership". Keeping them separate preserves clear event semantics and allows different guidance in planner prompts.

### B. openai-agents-js `transfer_to_<agentName>` pattern (dynamic tool names)
openai-agents-js generates one tool per agent (`transfer_to_billing`, `transfer_to_refund`, etc.). agrun uses a single `handoff_to_skill(skillName)` instead — consistent with agrun's action-catalog pattern where the action name is stable and the target is an arg. Avoids polluting the planner's tool namespace.

### C. Use spawn_subagent for sequential chaining
Rejected — spawn_subagent forks a child loop. The child's result returns to the parent, which must then decide what to do with it. Handoff is conceptually different: control does not return to the caller; the new skill takes over.

## Consequences

- New action in bundled catalog: no breaking changes to existing actions
- `runState.agentSkillContext` gains optional fields `handoffChain`, `handoffContext`, `handoffCycle`, `handoffInputFilter`, and `handoffInputFilterReport`
- `loopState.handoffContext` exposes the last handoff message to the receiving skill
- Hosts that intercept steps see a new `agent_handoff` step kind
- Cycle guards emit `agent_handoff_cycle_detected` and complete the run without changing the active skill
- Standalone and plan execution paths share the same handoff side-effect helper so the receiving skill sees consistent active-skill and filtered-history state
