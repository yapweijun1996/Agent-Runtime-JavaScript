# ADR-0033 Tier B — Reflect+Act Two-Call Implementation Plan

Date: 2026-05-20
Status: **ABANDONED 2026-05-20 evening.** Parent ADR-0033 Part 4 root-cause re-investigation invalidated the premise: lite-model failure is NOT poor intent coherence (Tier B's value prop) but (a) Tier A self-inflicted regression dropping workspace guidance in compact mode, (b) terminalRepair lock without surfaced unlock action, (c) 500-char content mimicry of a prompt truncation marker. The 67-73 words/call measured per successful workspace operation contradicts the "6-15 words/step ceiling" claim that motivated Tier B. Fix path is Tier A.5/A.6/A.7 (prompt-level, ~2 days total), NOT a new envelope protocol. This document kept for historical context and as reusable design reference if a genuine intent-coherence problem surfaces in future data.
Parent: [0033-oodae-as-single-call-structured-emission.md](./0033-oodae-as-single-call-structured-emission.md) — see Part 4 for invalidation evidence.

---

**Original plan content below (DO NOT IMPLEMENT — kept for context).**

---

## Goal

Implement ADR-0033 Tier B (`split_envelope` planner mode) to fix lite-model cognitive overload observed in live test v8 (`gemini-3.1-flash-lite` produced 437/3000 words across 84/90 cycles).

Approach: split the single-envelope LLM call into two narrower calls per cycle:

1. **Reflect call** — AI evaluates previous tool result and picks next intent (or terminates).
2. **Act call** — AI emits concrete action args (skipped if Reflect terminates).

This decomposes the schema cognitive load while keeping each call AI-first (no runtime prescription of which action to pick).

## OODAE Mapping

```
Cycle N (split_envelope mode):
  Observe   → runtime injects context (lastResult, workspace, loopState)
  Orient    → runtime skill hook (unchanged)
  Reflect   → LLM call 1 (= last cycle's Evaluate + this cycle's Decide-intent)
  Act       → LLM call 2 (concrete action) OR short-circuit terminal
  Execute   → runtime tool execution
  Evaluate  → runtime hook records cycle (advisory; next Reflect re-evaluates)
```

Reflect satisfies the user requirement that "Evaluate should be LLM-driven and feed next observation": Reflect explicitly reads `toolContext.lastResult` and emits `last_action_helpful` + `observation_evidence` before choosing next intent.

## Protocol — Reflect Envelope Schema

Reflect emission is a single JSON object. Schema is intentionally narrow (5 required + 1 conditional field):

```json
{
  "type": "reflect",
  "last_action_helpful": "yes" | "no" | "partial" | "first_cycle",
  "observation_evidence": "<≤200 chars: direct quote from toolContext.lastResult, or 'first_cycle' if no prior action>",
  "next_intent": "search" | "read" | "workspace" | "skill_tool" | "todo" | "clarify" | "finalize" | "final",
  "reasoning": "<≤300 chars: why this intent given the evidence>",
  "terminal_payload": {              // REQUIRED iff next_intent in {finalize, final, clarify}
    "instruction": "...",            // when next_intent = finalize
    "answer": "...",                 // when next_intent = final
    "question": "...",               // when next_intent = clarify
    "finalReadiness": { ... }        // when contract requires
  }
}
```

### Schema design rationale (anti-affirm-bias)

| Field | Why |
|---|---|
| `last_action_helpful` is categorical (yes/no/partial/first_cycle), not boolean | Research (arxiv 2510.18254) shows 46.7% of self-evaluations affirm-bias when boolean; categorical "partial" gives an honest middle |
| `observation_evidence` is required quote from `toolContext.lastResult` | Forces grounding in real observation, kills hallucinated progress |
| `next_intent` is a closed enum | Lite model picks from list, doesn't have to generate action name from scratch |
| `terminal_payload` inline on terminal intents | Enables short-circuit (skip Act call) when AI is ready to terminate |
| `reasoning` capped at 300 chars | Reduces verbose padding from lite models |

## Protocol — Act Envelope Schema

When Reflect's `next_intent` is non-terminal (`search`/`read`/`workspace`/`skill_tool`/`todo`), runtime injects Reflect's output into the Act prompt as an anchor section, then makes a second LLM call.

Act emission reuses existing envelope types — no new schema:

```json
{ "type": "action", "name": "<tool_name>", "args": { ... } }
// or
{ "type": "plan", "actions": [ ... ] }
// or AI changes mind on second thought:
{ "type": "finalize", "instruction": "..." }
{ "type": "final", "answer": "..." }
```

AI is allowed to override Reflect's intent in Act — Reflect is advisory, not binding. This preserves AI-first: runtime never forces the AI to follow its own prior intent.

## Cycle Handler — Two-Call Dispatcher

```
function runReflectActCycle(options):
  // 1. Build Reflect prompt (narrow system + reflect schema lines)
  reflectPrompt    = buildReflectPrompt(options)
  reflectResponse  = await requestProviderCompletion(request, { prompt: reflectPrompt, ... })
  reflectEnvelope  = parseReflectEnvelope(reflectResponse)

  // 2. Fail-soft fallback
  if reflectEnvelope.error:
    pushStep("reflect-parse-failed", { reason })
    return planNextActionWithEnvelope(options)   // fall back to single-envelope mode for this cycle

  // 3. Short-circuit terminal
  if reflectEnvelope.next_intent in {"finalize", "final", "clarify"}:
    if reflectEnvelope.terminal_payload is valid:
      pushStep("reflect-short-circuit-terminal", { intent: reflectEnvelope.next_intent })
      return { decision: buildTerminalDecisionFromReflect(reflectEnvelope), ... }
    else:
      // intent says terminate but payload missing → force Act call
      pushStep("reflect-terminal-payload-missing", { intent })

  // 4. Act call with Reflect injection
  actPrompt    = buildActPrompt(options, reflectEnvelope)
  actResponse  = await requestProviderCompletion(request, { prompt: actPrompt, ... })
  actEnvelope  = parsePlannerEnvelope(actResponse)    // reuse existing parser

  // 5. Record both calls in plannerResponsePacket for inspector
  return {
    decision: actEnvelope.decision,
    reflectEnvelope,
    actEnvelope,
    ...
  }
```

### Cost characteristics

| Path | LLM calls | Cost vs single envelope |
|---|---|---|
| Normal (Reflect → Act) | 2 | ~1.6-2.0x (Reflect prompt is smaller, so not full 2x) |
| Short-circuit terminal | 1 | ~0.6x (Reflect schema is smaller than full envelope) |
| Reflect parse fail → fallback | 2 (1 reflect + 1 envelope) | ~1.4x |
| Empirical estimate over 30-cycle run | avg ~1.5x | Net cost increase, justified by ~3x throughput gain on lite model (target: 437→1000+ words) |

## Trigger Policy

`resolvePlannerMode()` in `provider-capabilities.js` extends to handle `split_envelope`:

```
configuredMode = read from request.plannerMode
if configuredMode === "split_envelope":  return { effectiveMode: "split_envelope", reason: "explicit" }
if configuredMode === "envelope":         return { effectiveMode: "envelope", reason: "explicit" }
if configuredMode === "native_tools":     return { effectiveMode: "native_tools", reason: "explicit" }
if configuredMode === "auto":
  if isLiteTierModel(request.model, { modelTier: request.modelTier }):
    return { effectiveMode: "split_envelope", reason: "lite_tier_auto" }
  return { effectiveMode: "envelope", reason: "default_envelope" }   // unchanged for capable
```

| Model class | Default mode | Override |
|---|---|---|
| flash-lite, flash, mini, haiku, nano | `split_envelope` | host can force `envelope` via `request.plannerMode` or `modelTier: "capable"` |
| gpt-5, gpt-4o, gemini-3-pro, claude-sonnet/opus | `envelope` (unchanged) | host can force `split_envelope` for A/B testing |

## Files Changed

| File | Change |
|---|---|
| `src/runtime/provider-capabilities.js` | Add `"split_envelope"` to `normalizeConfiguredPlannerMode`. Extend `resolvePlannerMode` to auto-select for lite. |
| `src/runtime/planner.js` | Add `planNextActionWithReflectAct(options)`. Dispatch from `planNextAction` when `effectiveMode === "split_envelope"`. |
| `src/runtime/planner-prompt-reflect.js` (NEW) | `buildReflectSystemPrompt(actions, options)`, `buildReflectPrompt(options)`. Reuses session context / loopState projections from existing planner-prompt.js but with narrow reflect-only directive set. |
| `src/runtime/planner-prompt-act.js` (NEW) | `buildActPrompt(options, reflectEnvelope)`. Reuses existing planner-prompt builder but injects Reflect output as anchor section. |
| `src/runtime/reflect-envelope-parser.js` (NEW) | `parseReflectEnvelope(response)`. Validates required fields; rejects empty `observation_evidence` on non-first cycle. |
| `src/runtime/action-loop-reflect-act.js` (NEW) | Two-call cycle handler with short-circuit + fail-soft. |
| `src/runtime/agent-workflow-packets.js` | Extend planner response packet with `reflectEnvelope` field for inspector observability. |
| `src/runtime/oodae.js` | Extend `createCycleRecord` with optional `reflect` slot (between `observe` and `decide`). |
| `src/runtime/skill-hooks.js` | Add `reflect` field to `createContext` in `runSkillOrientHook` and `runSkillEvaluateHook` (Q1 resolution). |
| `src/runtime/planner-prompt-reflect.js` (NEW) | Also implements `buildReflectIntentMap(availableActions)` for Q3 compact map. |
| Inspector frontend (`examples/browser/...`) | Render Reflect call separately from Act call. Show short-circuit indicator. |

No changes needed to: `cycle-outcome.js`, `runSkillEvaluateHook` body (only `createContext` shape changes), `run-skill-loop.js` core loop, terminal handlers.

## Reflect System Prompt (Draft)

```
[agrun:reflect-contract]
Internal contract: reflect on the last tool result and pick the next intent. Return exactly one JSON envelope per Reflect call.

Output schema (return JSON only):
{
  "type": "reflect",
  "last_action_helpful": "yes" | "no" | "partial" | "first_cycle",
  "observation_evidence": "<short quote from toolContext.lastResult, or 'first_cycle' on cycle 1>",
  "next_intent": "search" | "read" | "workspace" | "skill_tool" | "todo" | "clarify" | "finalize" | "final",
  "reasoning": "<short rationale>",
  "terminal_payload": { ... }   // ONLY when next_intent is finalize, final, or clarify
}

Rules:
- observation_evidence must quote toolContext.lastResult.text, error message, or workspace state. Do NOT paraphrase or invent. On the first cycle, write "first_cycle".
- If next_intent is finalize/final/clarify, you MUST include terminal_payload with the matching field (instruction/answer/question).
- last_action_helpful="yes" means the action moved the goal forward; "partial" means useful but incomplete; "no" means wrong direction or no progress; "first_cycle" only on cycle 1.
- Reasoning must reference observation_evidence — explain WHY based on what you actually saw.
- If you choose finalize/final on this Reflect call, the second Act call is skipped — your terminal_payload IS the final answer.
- Return JSON only.
```

## Act System Prompt (Diff vs Current Envelope)

Act prompt = current envelope prompt + new "Reflect Anchor" section:

```
=== Reflect Anchor (this cycle) ===
You just emitted:
  last_action_helpful: <value>
  observation_evidence: <quote>
  next_intent: <intent>
  reasoning: <text>

Now emit a concrete action consistent with that intent. If on reflection you realize the intent was wrong, you may emit a different envelope type (finalize/final/clarify) — but you must explain in reasoning.
```

## Fail-Soft Fallback Strategy

| Failure | Action |
|---|---|
| Reflect response is not JSON | Parse retry once with stricter prompt; if still fails, fall back to single-envelope mode for this cycle |
| Reflect schema invalid (missing `next_intent`) | Same as above |
| `observation_evidence` empty on cycle > 1 | Repair request (mirror existing envelope repair) |
| `next_intent` is terminal but `terminal_payload` missing | Skip short-circuit, force Act call |
| Act call fails | Reuse existing envelope repair / circuit breaker logic |
| Provider circuit open during Reflect | Reuse existing `createCircuitOpenPlannerResult` |

The system NEVER hangs or crashes from split_envelope failures — always falls back to working single-envelope path.

## Inspector Changes

Each cycle in the inspector panel adds a sub-section:

```
Cycle 5:
  ├─ Observe       (runtime)
  ├─ Reflect       (LLM call 1, 142 tokens out, 0.4s)
  │     last_action_helpful: partial
  │     evidence: "found 2 articles, need 1 more authoritative source"
  │     intent: search
  ├─ Act           (LLM call 2, 89 tokens out, 0.3s)
  │     type: action
  │     name: web_search
  │     args: { query: "..." }
  ├─ Execute       (runtime, 0.8s)
  └─ Evaluate      (runtime hook, recorded)
```

Short-circuit cycles show only Reflect + Execute (no Act):

```
Cycle 12:
  ├─ Observe
  ├─ Reflect       (short-circuited terminal)
  │     intent: finalize
  │     terminal_payload: { instruction: "..." }
  └─ Execute       (terminal handler)
```

## Test Plan

### Unit tests (mocked fetch)

| Test file | Coverage |
|---|---|
| `test/unit/reflect-envelope-parser.test.js` | Valid emission, missing fields, evidence on first vs later cycle, terminal_payload validation |
| `test/unit/action-loop-reflect-act.test.js` | Short-circuit terminal, fail-soft fallback, intent override in Act |
| `test/unit/provider-capabilities-split-envelope.test.js` | Auto-mode picks split for lite, envelope for capable, explicit override |
| `test/unit/reflect-prompt-builder.test.js` | System prompt content, narrow directive set, evidence rules |

### Integration test (mocked fetch)

| Test file | Coverage |
|---|---|
| `test/integration/reflect-act-cycle.mjs` | Full cycle: Reflect → Act → execute → next Reflect sees prior result via lastResult |
| `test/integration/reflect-act-short-circuit.mjs` | Reflect chooses finalize → no Act call → terminal handler runs |

### Live E2E (real API)

**Primary success criterion** (from ADR-0033 Tier A validation hook):

```
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
  node test/node-agrun-3000-live.mjs
```

Target: `candidateWords > 1000` (baseline: 437 words / 84 cycles).

**Secondary criteria**:
- `gpt-5-mini` PASS rate unchanged (regression check; capable model should be unaffected since default is still envelope)
- `gemini-3-pro-preview` PASS rate unchanged
- No new error spikes in `node-agrun-3000-live.mjs` results across 5 consecutive runs

## Rollback Plan

| Change | Rollback |
|---|---|
| `provider-capabilities.js` mode addition | Remove `"split_envelope"` from normalizer; auto-mode returns `envelope` |
| `planner.js` dispatch branch | Delete `if (effectiveMode === "split_envelope")` block |
| New files (`*-reflect.js`, `*-act.js`, `reflect-envelope-parser.js`, `action-loop-reflect-act.js`) | Delete |
| `agent-workflow-packets.js` reflectEnvelope field | Remove field; inspector renders nothing |
| `oodae.js` reflect slot | Remove field |
| Inspector changes | Hide Reflect section (renders nothing if field absent) |

No data migration. Existing capable-model runs are unaffected.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Lite model still fails despite split | High | Tier A compact prompt already partially mitigates; if Tier B insufficient, escalate to Tier C (AI-driven `think` envelope) |
| Capable model gets accidentally routed to split (regression) | Medium | Default keeps `envelope` for capable; explicit unit test guards `resolvePlannerMode` precedence |
| Reflect prompt creates new affirm-bias loop | Medium | Categorical fields + evidence quote + reasoning-cap (300 chars) per research recommendations |
| Two-call latency degrades UX on slow networks | Medium | Short-circuit terminal saves a call when ready; Reflect uses smaller prompt (faster than full envelope) |
| Inspector becomes too noisy | Low | Default collapse Reflect section; expand on click |
| Intent override in Act creates inconsistency | Low | Allowed by design (AI-first); inspector flags when Act.type differs from Reflect.next_intent |

## Estimated Timeline

| Phase | Work | Risk |
|---|---|---|
| P0 — ADR update + this plan | 0.5 day | Low |
| P1 — Reflect mode + prompt builder | 1 day | Low |
| P2 — Parser + Act prompt with injection | 1 day | Low |
| P3 — Two-call dispatcher + short-circuit + fail-soft | 2 days | **High** (touches main planner dispatch) |
| P4 — Inspector + unit tests + live e2e | 1-2 days | Medium |
| **Total** | **5-6 days** | |

## Resolved Decisions (Approved 2026-05-20)

| # | Decision | Resolution | Rationale |
|---|---|---|---|
| ❶ | Default mode for lite-tier (`flash`/`mini`/`haiku`/`nano`) | **Auto-enable `split_envelope`** | Lite-tier is the failing case from v8 (437/3000 words); auto-enable targets the actual problem. Capable models keep `envelope` default. |
| ❷ | Reflect schema: 5 required + 1 conditional field | **Approved** | Narrow schema (last_action_helpful / observation_evidence / next_intent / reasoning / terminal_payload?) matches research on schema decomposition for lite models. |
| ❸ | AI can override Reflect intent in Act emission | **Approved** | AI-first principle — runtime never binds AI to its own prior intent. Inspector flags mismatch for observability. |
| ❹ | Short-circuit on `clarify` intent (in addition to finalize/final) | **Approved** | Clarify is terminal for the cycle; if AI declares clarify with valid question payload, no Act call needed. |
| ❺ | Reflect parse/schema failure fallback path | **Single-envelope mode for that cycle (fail-soft)** | Never hang; degrade gracefully to working envelope path; emit `planner-reflect-fallback` step for telemetry. |
| ❻ | Inspector default presentation | **Collapse Reflect section by default; expand on click** | Reduce visual noise; AI behavior is still primarily Act-driven from the user's perspective. |
| Q1 | Pass `reflectEnvelope` to skill `createContext`? | **Yes** | See Resolved Open Questions section. |
| Q2 | Veto rules apply to Reflect or Act? | **Act only** | See Resolved Open Questions section. |
| Q3 | Action surface scope for Reflect? | **Compact intent-to-action map (names only)** | See Resolved Open Questions section. |

## Resolved Open Questions

### Q1 — Pass `reflectEnvelope` to skill `createContext`?

**Decision: YES.**

Skill `orient()` and `evaluate()` hooks receive an optional `context.reflect` field containing the parsed Reflect envelope when split_envelope mode is active (null otherwise). This lets skills observe AI's declared intent and stated reasoning before/after Act executes.

API surface addition to `skill-hooks.js`:
```js
createContext({
  error, observation, orientation, output, selectedSkill,
  reflect: reflectEnvelope || null     // NEW field, null in single-envelope mode
})
```

Skills must treat `context.reflect` as advisory observation — they MUST NOT branch logic that depends on Reflect being present (forward-compat with single-envelope mode).

### Q2 — Veto rules on Reflect or Act?

**Decision: Veto rules apply to Act only.**

Reflect is a free declaration of intent; the AI can declare any `next_intent` without runtime veto. Act emission is what binds — at Act time, `terminalRepairState`, `actionPatternConvergence`, `terminalRetryCooldown`, `readOnlyPlanningState`, and `structureRepairConvergence` all apply normally (unchanged from envelope mode).

Rationale:
- Vetoing Reflect would push runtime back into policy decisions (which intent is "allowed").
- The AI sees its own Reflect output in the Act prompt; if it declared an intent that the runtime would veto at Act time, the Act prompt's veto rules will reject it and the AI must change course.
- Keeps Reflect's schema narrow — no veto rule projections needed in the Reflect prompt.

The Act prompt MUST include all loopState veto rules from the current envelope system prompt, identical to single-envelope mode.

### Q3 — Action surface scope for Reflect?

**Decision: Compact intent-to-action map (names only, no descriptions).**

Reflect prompt shows ONLY the available intent categories and which actions back each category, without full descriptions or arg schemas. Example:

```
Available intent categories this cycle:
  search       → web_search
  read         → read_url
  workspace    → workspace_write, workspace_append, workspace_read, workspace_list, workspace_replace, workspace_finalize_candidate, workspace_publish_candidate
  skill_tool   → execute_skill_tool, list_agent_skills, read_agent_skill, use_agent_skill
  todo         → todo_plan, todo_advance, todo_run_next, todo_inspect
  clarify      → clarify (terminal)
  finalize     → finalize (terminal)
  final        → final (terminal)
```

Rejected: full action surface (defeats schema-decomposition purpose) and bare enum without action names (AI can't tell if "search" maps to anything available in the current host's action set).

Implementation: `buildReflectIntentMap(availableActions)` produces this block. Categories with zero backing actions are omitted from the list, so AI never declares an unavailable intent.

The Act prompt retains full action descriptions and arg schemas (unchanged from envelope mode).
