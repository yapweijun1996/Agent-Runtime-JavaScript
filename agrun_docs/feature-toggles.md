# agrun.js Feature Toggles Reference

Every knob an integrating engineer can flip — without forking or patching agrun.js.

Two levels of control:

- **Runtime-level** — passed to `createRuntime({ ... })`. Applies to every `run()` on that runtime.
- **Run-level** — passed as the second argument to `runtime.run(input, { ... })` or `session.run(input, { ... })`. Overrides for a single call.

If a feature is not in this document, it is not a supported toggle. Open an issue or email the maintainers before forking.

## Table of Contents

- [Actions (built-in tools)](#actions-built-in-tools)
- [Skills (provider layer)](#skills-provider-layer)
- [Planner](#planner)
- [Self-Correction](#self-correction)
- [Global Memory](#global-memory)
- [Action Policy (approval gates)](#action-policy-approval-gates)
- [Loop & Plan Limits](#loop--plan-limits)
- [Session Budget (Loop Convergence)](#session-budget-loop-convergence)
- [Research Report Loop & Acceptance Gate](#research-report-loop--acceptance-gate)
- [Publish Candidate Mode Gate](#publish-candidate-mode-gate)
- [Resilience](#resilience)
- [Approval Token Signing](#approval-token-signing)
- [Persistence](#persistence)
- [Agent Role](#agent-role)
- [Agent Skills (instruction packs)](#agent-skills-instruction-packs)
- [Skill Policy (skill/tool gates)](#skill-policy-skilltool-gates)
- [Observability](#observability)
- [Debug](#debug)
- [Quick Recipes](#quick-recipes)
- [FAQ — "Can we turn X on/off?"](#faq--can-we-turn-x-onoff)

## Actions (built-in tools)

Seven planner-selectable actions ship with agrun.js. Disable any subset.

| Action | Purpose |
|--------|---------|
| `web_search` | Search the web via configured search skill |
| `read_url` | Fetch and extract page content |
| `ask_clarification` | Agent proactively asks the user a question |
| `use_agent_skill` | Invoke a registered skill |
| `execute_skill_tool` | Call a specific tool exposed by a skill |
| `list_agent_skills` | Enumerate available skills to the planner |
| `read_agent_skill` | Read a skill's instruction markdown |

### Runtime-level

```js
createRuntime({
  skills,
  disabledActions: ["read_url", "ask_clarification"]
});
```

### Run-level (overrides runtime list)

```js
runtime.run(input, {
  disabledActions: ["web_search"]
});
```

Disabled actions are filtered out of the planner surface, hidden from native-tools schemas, and skipped in research continuation.

## Skills (provider layer)

Skills are registered by passing them in the `skills` array. **Not passing a skill = feature off.** There is no global "disable skill X" flag; you simply omit it.

Bundled skills exported from `agrun`:

| Skill | Purpose |
|-------|---------|
| `openaiBrowserSkill` | OpenAI Chat Completions by default; opt-in Responses API via `apiVariant: "responses"` |
| `geminiBrowserSkill` | Gemini generate content |
| `webSearchSkill` | Web search (SearxNG by default) |
| `timeSkill` | Current time / timezone |
| `memorySkill` | Explicit memory read/write tool |
| `newsBriefSkill` | News aggregation |
| `echoSkill` | Testing / harness verification |
| `fallbackSkill` | Safety net when no skill matches |

```js
createRuntime({
  skills: [openaiBrowserSkill, webSearchSkill, fallbackSkill]
  // geminiBrowserSkill omitted → Gemini not available this runtime
});
```

A skill marked `isFallback: true` is auto-extracted as the fallback. Pass `fallbackSkill:` explicitly to override.

OpenAI defaults to the Chat Completions-compatible path. Hosts that need
Responses API features can opt in per request:

```js
await session.run({
  provider: "openai",
  apiKey,
  endpoint: "https://proxy.example.test/v1",
  model: "gpt-5-mini",
  prompt: "Explain the plan briefly.",
  apiVariant: "responses",
  reasoningEffort: "high",
  reasoningSummary: "auto",
  toolChoice: "none"
});
```

When `apiVariant: "responses"` is set, `openaiBrowserSkill` routes through
`/responses` and exposes `output.reasoningSummary` when the provider returns a
reasoning summary. The default remains `"chat"` for backward compatibility.

## Planner

| Option | Default | Values | Effect |
|--------|---------|--------|--------|
| `plannerMode` | `"auto"` | `"auto"` \| `"native_tools"` \| `"envelope"` | `auto` lets agrun choose the provider/model/tool-surface encoding. Explicit values are advanced/debug overrides. |
| `nativeToolsFailurePolicy` | `"fallback_to_envelope"` | `"fallback_to_envelope"` \| `"hard_fail"` | When native tool planning fails, either retry the same planner prompt through envelope mode or return a planner error immediately |
| ~~`singleToolFastPath`~~ | _(removed in ADR-0026)_ | — | Removed in ADR-0026. The runtime no longer skips the post-tool planner cycle. To preserve legacy behavior, wire `onToolResult` and call your own finalize path. The option is silently ignored if still passed. |
| `preferFinalizeOnLastResult` | `true` | boolean | Use the last action result directly when goal is satisfied |
| `plannerDirectives` | `[]` | `string[]` | Extra system prompt lines appended to planner |
| `toolCallExamples` | `[]` | `Array<{skillName, toolName, args}>` | Few-shot examples shown to planner |

```js
// ADR-0026 — `singleToolFastPath` was removed; do not pass it.
createRuntime({
  plannerMode: "auto",
  nativeToolsFailurePolicy: "fallback_to_envelope",
  plannerDirectives: [
    "Prefer SGD as default currency.",
    "Never fabricate invoice numbers."
  ]
});
```

## Self-Correction

Automatic re-plan when an action errors.

| Option | Default | Effect |
|--------|---------|--------|
| `selfCorrection` | `{ enabled: true, maxRetries: 2 }` | Off: `false` |
| `selfCorrection.enabled` | `true` | Kill switch |
| `selfCorrection.maxRetries` | `2` | Positive integer |

```js
createRuntime({ selfCorrection: false });                     // off
createRuntime({ selfCorrection: { maxRetries: 4 } });         // retry more
```

## Global Memory

Cross-session preferences / facts / decisions stored in IndexedDB.

| Option | Default | Effect |
|--------|---------|--------|
| `globalMemory.enabled` | `true` | **Kill switch** — off skips extraction, recall, and writes |
| `globalMemory.minConfidence` | `0.7` | Auto-promotion floor (0–1) |
| `globalMemory.maxEntries` | `100` | LRU cap per database |
| `globalMemory.hookTimeoutMs` | `2000` | Extraction hook timeout |
| `globalMemory.sensitivityFilter` | `null` | `(entry) => boolean` — return `true` to block write |
| `globalMemory.promotionValidator` | `null` | `(entry) => boolean` — extra allow/deny gate |

```js
createRuntime({
  globalMemory: {
    enabled: true,
    minConfidence: 0.85,
    maxEntries: 50,
    sensitivityFilter: (e) => /tax_id|nric|passport/i.test(e.value || "")
  }
});
```

Setting `enabled: false` does **not** delete existing rows. Full contract: [agrun_docs/public-runtime-api.md](./public-runtime-api.md#disabling-global-memory).

## Action Policy (approval gates)

Per-action human-in-the-loop gating. Three values:

| Policy | Effect |
|--------|--------|
| `"allow"` | Execute immediately (default when no policy + no tier) |
| `"ask"` | Pause, return `output.kind === "approval_required"` with resume token |
| `"deny"` | Block, emit denial outcome |

```js
createRuntime({
  actionPolicy: {
    web_search: "allow",
    read_url: "ask",
    execute_skill_tool: "ask"
  }
});
```

If an action is not listed, the policy defaults to its `tier`:

| Tier | Default |
|------|---------|
| 0 / unset | `allow` |
| 1, 2 | `ask` |
| 3 | `deny` |

Approval resume flow: [agrun_docs/approval-flow.md](./approval-flow.md).

## Loop & Plan Limits

| Option | Default | Hard Cap | Effect |
|--------|---------|----------|--------|
| `maxSteps` | `8` | — | OODAE cycles per `run()` |
| `maxPlanActions` | `10` | `20` | Action count in a single plan |
| `maxPlanParallel` | `8` | — | Actions executed in parallel |
| `maxSectionParallel` | `4` | — | Parallelism within a plan section |

```js
createRuntime({
  maxSteps: 4,
  maxPlanActions: 5,
  maxPlanParallel: 2
});
```

Raising `maxPlanActions` above `20` throws at config time — by design.

### Plan recovery (bridge for small-model schema drift)

| Option | Default | Effect |
|--------|---------|--------|
| `recoverPlanMutator` | `true` | When a plan envelope contains an action whose action metadata marks it `allowedInPlan: false`, the runtime auto-extracts the first such action and runs it standalone, dropping siblings. Step `plan-mutator-recovery-skipped-siblings` records what was dropped. Set to `false` to disable and surface validation feedback to the planner instead. |

```js
createRuntime({
  recoverPlanMutator: true // default — bridge for small models that mis-emit schema
});
```

Bridge note: this toggle exists because small models (e.g. Gemini Flash-Lite) often re-emit state-mutating actions inside a plan envelope despite repair feedback, causing wasted cycles per long-run task. The standalone-only action list is derived from action metadata, not from a separate validation list. Auto-recovery converts these into one usable standalone action. Long-term goal: tighten envelope schema strictness on the planner side so this toggle becomes unnecessary, then deprecate.

## Session Budget (Loop Convergence)

A composite budget that guarantees long-running tasks converge. Enabled by default. Complements `maxSteps` (which is a hard ceiling) with four finer-grained caps that emit a **convergence signal** on `runState.sessionBudget`. The signal is surfaced to the planner via `loopState.sessionBudget`; the AI sees it and decides how to react (switch tactics, finalize, or accept the budget). The runtime does not force-finalize on breach — that push-mode site was removed per ADR-0026. See [action-loop-session-loop.js:121-122](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js) for the in-source tombstone.

Shipped in AGRUN-141 (P0). Design: [agrun_docs/long-running-multi-topic-tasks.md](./long-running-multi-topic-tasks.md).

| Cap | Default | Trigger |
|-----|---------|---------|
| `totalFailures` | `5` | Cumulative `action_error` across **all** tool names (replaces the old per-`actionName` guard for alternating-tool loops) |
| `invalidDecisions` | `3` | `planner_invalid_action` entries — planner keeps producing unparseable / unknown decisions |
| `sameFingerprintRepeats` | `2` | Same `name + skillName + toolName + stableStringify(args)` attempted twice (tight tool loop) |
| `cyclesSinceProgress` | `5` | `runState.toolContext.history.length` has not grown for N cycles (agent is spinning without gathering new evidence) |

Detection order (earliest breach wins): `fingerprint_repeat` → `total_failures` → `invalid_decisions` → `no_progress`.

### Runtime-level

```js
createRuntime({
  budget: {
    totalFailures: 8,            // allow more retries before giving up
    sameFingerprintRepeats: 3,   // tolerate one extra identical call
    cyclesSinceProgress: 10      // very long research tasks
    // invalidDecisions inherits default (3)
  }
});

createRuntime({ budget: false }); // disable entirely (legacy behavior, per-actionName guard only)
```

Each cap must be a **positive integer**; non-positive or non-integer values fall back to the defaults listed above.

### On breach

The runtime:

1. Emits a `session-budget-breach` step — `{ reason, count, cap, cycle }`.
2. Force-finalizes with an instruction derived from `describeBudgetBreach(breach)` so the LLM produces an honest "here is what I know; I could not complete X because Y" answer instead of hallucinating.
3. Sets `runState.sessionBudget.breachRecorded = breach` for post-hoc inspection.

Observe it:

```js
runtime.run(input, {
  onStep: (step) => {
    if (step.type === "session-budget-breach") {
      log.warn("agent hit budget cap", step.detail);
      // detail: { reason, count, cap, cycle }
    }
  }
});
```

### Interaction with existing guards

- The legacy `MAX_CONSECUTIVE_ACTION_FAILURES = 2` (per-`actionName` streak) is preserved as a subset — still fires for the classic single-tool retry storm. The composite budget adds coverage for alternating tools and repeated identical calls that the old guard missed.
- `maxSteps` remains the outer hard ceiling; the budget fires first whenever the agent is demonstrably stuck, so users do not wait `maxSteps` cycles for a trivially broken run.
- When `budget: false`, only the legacy per-`actionName` guard is active (full back-compat path).

## Research Report Loop & Acceptance Gate

Long-form research runs use three cooperating subsystems to surface evidence
quality to the planner without authoring content in runtime:

| Subsystem | Purpose | runState slot |
|-----------|---------|---------------|
| `researchReportLoop` | Long-form OODAE loop state, source minimum, evidence graph, gate signal | `runState.researchReportLoop` |
| `researchAcceptanceEvaluator` | Acceptance convergence signal (forbids clean `ready` when evidence gaps exist) | `runState.researchAcceptanceEvaluator` |
| `terminalRepairState` | Observable-deficit projection used to shape planner's allowed-action surface near terminal moves | `runState.terminalRepairState` |

### Activation contract — when does the gate actually fire?

The gate commits ONLY when at least one of these is true
(see `src/runtime/research-report-loop.js` → `shouldCommitResearchReportLoopGate`):

1. `evaluation.required === true` — i.e. `isLongResearchRun(runState) === true`. This is true only when:
   - host/envelope sets `runState.researchActivation = "long_research"`, OR
   - a long-research skill (`deep-research-writer`, `long-web-research`, etc.) is the active/selected skill via `agentSkillContext`.
   - **There is NO lexical-prompt path.** Mandarin/English/any prompt text is ignored; activation is skill-driven (ADR-0012).
2. The gate was already committed on a previous step (`previous.enabled === true`).
3. The model has emitted a publish attempt (`runState.publishBlockSignal`).
4. A length contract was extracted from the prompt AND a workspace candidate exists.
5. `workspace.quality.finalCandidateReady === true`.

For hosts that register **only data/ORM skills** and never declare long-research, none of these should fire and `runState.researchReportLoop` stays at its idle default. `terminalRepairState.active` should remain `false`.

### Toggles

| Option | Default | Values |
|--------|---------|--------|
| `researchReportLoop` | `{ enabled: true, ... }` | `false` \| `{ enabled, minReadSources, minRelevantSources, limit, maxPasses, maxIndependentSearchAttempts, maxResearchLoopVetoes }` |
| `researchReportLoop.enabled` | `true` | `false` to short-circuit `refreshResearchReportLoopGate` — gate never commits, no source minimum, no acceptance signal, no `terminalRepairState` source/length deficits |
| `researchReportLoop.minReadSources` | `3` | Positive integer. Number of distinct `read_url` successes counted as "enough" |
| `researchReportLoop.minRelevantSources` | `2` | Positive integer. Number of strong/medium relevance sources required |
| `researchCoverageGuard` | `{ enabled: true }` | `{ enabled: false }` to drop research coverage vetoes (separate from the report loop) |
| `citationCoverageGuard` | `{ enabled: true }` | `{ enabled: false }` to drop direct-source citation vetoes |

### When to disable

- **ERP / data-query hosts** that ground answers in registered tool skills (ORM, SQL, internal APIs) and never consume `web_search` / `read_url`:

  ```js
  createRuntime({
    skills: [...erpSkills],
    researchReportLoop: { enabled: false },
    researchCoverageGuard: { enabled: false },
    citationCoverageGuard: { enabled: false }
  });
  ```

- **Hosts that ship their own evidence/quality contract** via `onBeforeFinalize` and want runtime to stay quiet on source counting.

### When to keep enabled (default)

- Hosts that expose `web_search` / `read_url` and want runtime to surface evidence-gap signals to the planner.
- Hosts that declare long-research skills — required for the OODAE gate to populate `gateSignal.acceptancePacket`.

### Verifying the toggle landed

After construction:

```js
console.log(runtime.getRuntimeConfig().researchReportLoop);
// → { enabled: false, ... } when disabled
```

At runtime, inspect via `onStep` / debug bundle:

```js
runState.researchReportLoop // → idle defaults when gate never commits
runState.terminalRepairState.active // → false on healthy non-research runs
```

If `terminalRepairState.active === true` on a run that never declared long-research and never wrote a workspace candidate, that is a runtime bug — capture the JSON dump and report.

### Diagnosing model-imagined repair mode

Lite-tier planner models sometimes write reasoning like *"I am in terminal repair mode"* even when `runState.terminalRepairState.active === false`. Always confirm against the actual runState dump before treating it as a gate-firing bug — the model may be hallucinating the contract from planner-prompt teaching text.

## Publish Candidate Mode Gate

`workspace_publish_candidate` is a terminal action that publishes a virtual-workspace file directly as the final answer **without calling the runtime finalizer LLM** (`usedRuntimeFinalize=false`, tokens=0 on that step). It is designed for long-form `long_research` workflows where the AI has drafted, finalized, and read-back a candidate before publishing.

In `tool_loop` mode without a long-research skill, envelope-mode planners — verified Gemini Flash-Lite, reported by Globe3 ERP 2026-05-26 — can treat the action as a generic "give up" escape. They write fabricated reasoning into the workspace then publish it, producing user-visible "I could not access X" messages with no LLM finalize call (audit blind spot, tokens=0 reading breaks billing aggregators).

The gate **hides `workspace_publish_candidate` from the planner action surface** unless the run structurally belongs in long-research mode.

### Gate rule

The gate hides the action when ALL of the following hold:

1. `runtimeConfig.publishCandidateGate.enabled !== false` (default on).
2. `runState.terminalRepairState.active` is NOT `true`. When terminal repair owns the surface, its `allowedActions` list is the authoritative signal and the gate defers to it.
3. `isLongResearchRun(runState)` is `false` — i.e. no `researchActivation === "long_research"` on the runState, and no long-research skill (`deep-research-writer`, `long-web-research`) is the active/selected/last-read skill.

If the gate hides the action and the planner emits it anyway (hallucinated by name, not from the catalog), the runtime guard at the per-decision check rejects the emission through `handleInvalidPlannerDecision` — the next planner cycle sees a `plannerInvalidSignal` carrying "use finalize instead", so the planner converges instead of looping until `maxSteps`.

### Toggles

| Option | Default | Values |
|--------|---------|--------|
| `publishCandidateGate` | `{ enabled: true }` | `false` \| `{ enabled }` |
| `publishCandidateGate.enabled` | `true` | `false` to opt out of the gate. Restores the pre-2026-05-26 behavior — `workspace_publish_candidate` is reachable in any mode. Use only when your host intentionally publishes-direct outside long_research. |

### When to disable

- **Custom publish-direct flows.** Hosts that intentionally surface `workspace_publish_candidate` outside long_research (e.g. a tool-authored fast-path that writes a virtual-workspace candidate, finalizes, reads back, and publishes — without ever activating a long_research skill).

  ```js
  createRuntime({
    skills: [...],
    publishCandidateGate: { enabled: false }
  });
  ```

### When to keep enabled (default)

- **ERP / data-query hosts** (Globe3-shaped). No long_research skills, planner emits one tool call then finalizes. The gate prevents lite-tier planners from using `workspace_publish_candidate` as a fabrication-and-publish escape hatch.
- **Hosts that mix tool_loop and long_research.** Default behavior. When a long_research skill activates, the gate defers automatically.

### Diagnostics

When the runtime guard fires, look for:

- A step with `type === "workspace-publish-candidate-gated"` in the step ledger, carrying a `detail.detail` string that names the gate reason.
- `runState.plannerInvalidSignal.reason === "workspace_publish_candidate_gated"` on the next planner cycle.

If you see the gated step but `finalAnswerSource` is `continuation_required` instead of `planner_finalize`, the planner failed to converge to finalize within the budget — investigate whether the planner prompt is correctly receiving the `plannerInvalidSignal.requiredEnvelope` field.

## Resilience

| Option | Default | Values |
|--------|---------|--------|
| `circuitBreaker` | `null` (off) | `true` \| `{ threshold, cooldownMs, ... }` \| circuit breaker instance |

```js
createRuntime({
  circuitBreaker: true                            // defaults
});

createRuntime({
  circuitBreaker: { threshold: 3, cooldownMs: 30_000 }
});

createRuntime({ circuitBreaker: false });         // explicit off
```

See `src/skills/providers/fetch-resilience.js`.

## Approval Token Signing

Signs resume tokens with HMAC-SHA256 + nonce + TTL so a forged or replayed token is rejected. Default off — opt in for production.

| Option | Default | Values |
|--------|---------|--------|
| `approvalSigning` | `false` (off) | `true` \| `{ key, ttlMs, enforceSessionBinding, onDegraded }` |

```js
createRuntime({
  approvalSigning: true                                  // random key, 15-min TTL
});

createRuntime({
  approvalSigning: {
    key: hostSuppliedSecret,                             // string or Uint8Array; persisted across reloads
    ttlMs: 5 * 60 * 1000,                                // shorter TTL for sensitive flows
    enforceSessionBinding: true,                         // reject tokens issued for a different session
    onDegraded: ({ reason }) => log.warn("signer degraded", reason)
  }
});

createRuntime({ approvalSigning: false });               // explicit off (default)
```

When Web Crypto is unavailable, the signer falls back to nonce + TTL only and fires `onDegraded({ reason: "no_webcrypto" })` once. ADR: [agrun_docs/adr/0001-runtime-hardening-batch.md](./adr/0001-runtime-hardening-batch.md).

## Persistence

| Option | Default | Purpose |
|--------|---------|---------|
| `sessionStore` | in-memory | `createIndexedDBSessionStore({ dbName })` for persistence |
| `memory` | in-memory | Custom `{ readAll, append }` for per-runtime memory |
| `onStorageDegraded` | `null` | Callback fired once when IndexedDB writes fail and the store falls back to in-memory |

```js
import { createRuntime, createIndexedDBSessionStore } from "./dist/agrun.js";

createRuntime({
  sessionStore: createIndexedDBSessionStore({
    dbName: `agrun-${userId}`,
    onStorageDegraded: ({ reason, error }) => log.warn("storage degraded", reason)
  })
});
```

The session store auto-degrades to an `InMemorySessionStore` on `QuotaExceededError`, `InvalidStateError`, `SecurityError`, `NotAllowedError`, or `VersionError`. The fallback is one-way — once degraded, the runtime keeps using memory storage for the rest of the page lifetime.

Multi-tenant isolation: scope `dbName` per user. See README "Multi-tenant Deployment Pattern."

## Agent Role

Persona / system-prompt override.

| Option | Default | Values |
|--------|---------|--------|
| `role` | bundled default | `"name"` (bundled) \| `{ name, instructions, ... }` \| parsed via `parseRoleMarkdown(md)` |

```js
createRuntime({ role: "researcher" });

createRuntime({
  role: {
    name: "finance-assistant",
    instructions: "Answer only accounting questions. Decline everything else."
  }
});
```

Runtime-loadable: `parseRoleMarkdown(markdownString)` returns the object.

## Agent Skills (instruction packs)

`agentSkills` are markdown docs the planner reads to decide which tool to call. Different from executable `skills`.

| Option | Default | Values |
|--------|---------|--------|
| `agentSkills` | `bundledAgentSkills` | Array of skill instruction objects \| `[]` to clear |
| `agentSkillIndexProvider` | built-in adapter | `{ listManifests, getManifest, loadSkill }` |
| `skillCatalogTopK` | `10` | Non-negative integer |
| `skillCatalogMaxK` | `30` | Positive integer hard cap |
| `skillCatalogRanker` | built-in lexical ranker | Optional function hook |
| `skillPolicy` | allow all | Skill/tool allow, ask, deny, and availability filter |

```js
import { bundledAgentSkills, parseSkillMarkdown } from "./dist/agrun.js";

const customSkill = parseSkillMarkdown(`# My Skill\n...`);
createRuntime({
  agentSkills: [...bundledAgentSkills, customSkill]
});
```

Pass `agentSkills: []` to remove all bundled instructions.

For large catalogs, planner prompt exposure is ranked before each planner call:

```js
createRuntime({
  agentSkillIndexProvider,
  skillCatalogTopK: 10,
  skillCatalogMaxK: 30
});
```

The default ranker is deterministic and local to the browser. It does not add
Fuse.js, MiniSearch, or embedding dependencies. Use `skillCatalogRanker` when a
host wants to plug in a different ranking engine.

## Skill Policy (skill/tool gates)

`skillPolicy` controls which agent skills/tools are available. It is separate
from `actionPolicy`: action policy gates runtime actions, while skill policy
gates named skill/tool targets.

```js
createRuntime({
  skillPolicy: {
    skills: {
      "web-research": "allow",
      "dangerous-admin": "deny"
    },
    tools: {
      "web-research.search_web": "allow",
      "web-research.read_url": "ask"
    },
    availability: {
      browser: true,
      network: true,
      inputTypes: ["text"],
      features: ["web-search", "read-url"]
    }
  }
});
```

| Policy | Effect |
|--------|--------|
| `"allow"` | Skill/tool is visible, readable, activatable, and executable |
| `"ask"` | Visible/readable/activatable; `execute_skill_tool` pauses for approval |
| `"deny"` | Filtered from Top-K/list; explicit read/use/execute fails closed |

Manifest `riskTier` maps to `allow` for `0`/unset, `ask` for `1`/`2`, and
`deny` for `3`. Explicit `skillPolicy.skills` and `skillPolicy.tools` override
manifest tier. Availability filtering checks `requires`, `browser`, `network`,
`inputTypes`, and feature flags before Top-K ranking.

## Observability

All optional, all run-level callbacks. Runtime emits events; host decides what to log / stream.

| Callback | Fires on |
|----------|----------|
| `onStep(step)` | Every OODAE step — planner decisions, action outcomes, memory events |
| `onToken(delta)` | Token-level streaming from the LLM |
| `onPlannerDecision(decision)` | Each planner resolution (plan shape, confidence) |
| `onToolResult(result)` | Each action / tool result |
| `onBeforeFinalize(state)` | Just before the final response is synthesized |

```js
runtime.run(input, {
  onStep: (s) => console.log(s.type, s.detail),
  onToken: (t) => ui.appendChunk(t),
  onToolResult: (r) => telemetry.record(r)
});
```

Key step types for filtering: `global-memory-recalled`, `global-memory-written`, `global-memory-purged`, `global-memory-filtered`, `action-error`, `planner-repair`.

## Debug

| Option | Default | Values |
|--------|---------|--------|
| `debug` | off | `true` \| `{ level, logger, ... }` |

See `src/runtime/debug.js` for shape. Produces extra structured step events; turn on only during local debugging.

## Quick Recipes

### Lightweight Q&A bot (no search, no memory)

```js
createRuntime({
  skills: [openaiBrowserSkill, fallbackSkill],
  disabledActions: ["web_search", "read_url", "ask_clarification"],
  globalMemory: { enabled: false },
  circuitBreaker: false,
  maxSteps: 3
});
```

### Research agent (all capabilities, high limits)

```js
createRuntime({
  skills: [geminiBrowserSkill, webSearchSkill, newsBriefSkill, fallbackSkill],
  plannerMode: "auto",
  maxSteps: 15,
  maxPlanActions: 15,
  circuitBreaker: true
});
```

### Approval-gated write tool

```js
createRuntime({
  skills: [openaiBrowserSkill, writeSkill, fallbackSkill],
  actionPolicy: {
    execute_skill_tool: "ask"
  }
});
```

### Privacy-hard mode (no persistence, no cross-session)

```js
createRuntime({
  skills: [openaiBrowserSkill, fallbackSkill],
  globalMemory: { enabled: false }
  // no sessionStore → in-memory only, evaporates on refresh
});
```

## FAQ — "Can we turn X on/off?"

| Engineer request | Toggle |
|------------------|--------|
| "Disable web search globally." | `disabledActions: ["web_search"]` |
| "Disable read_url for this run only." | `runtime.run(input, { disabledActions: ["read_url"] })` |
| "Stop the agent asking clarifying questions." | `disabledActions: ["ask_clarification"]` |
| "Turn off cross-session memory." | `globalMemory: { enabled: false }` |
| "Lower memory confidence threshold." | `globalMemory: { minConfidence: 0.6 }` |
| "Require approval before search." | `actionPolicy: { web_search: "ask" }` |
| "Use agrun's provider capability matrix to choose tool calling vs JSON envelope." | `plannerMode: "auto"` |
| "Stop auto-retry on failures." | `selfCorrection: false` |
| "Let the agent take more steps." | `maxSteps: 20, maxPlanActions: 15` |
| "Tolerate more failed retries before giving up." | `budget: { totalFailures: 8 }` |
| "Disable the composite loop-convergence budget." | `budget: false` (leaves legacy per-action guard only) |
| "Disable the long-research source-minimum / acceptance gate for non-research hosts." | `researchReportLoop: { enabled: false }` — see [Research Report Loop & Acceptance Gate](#research-report-loop--acceptance-gate) |
| "Allow `workspace_publish_candidate` outside long_research mode (host has its own publish-direct flow)." | `publishCandidateGate: { enabled: false }` — see [Publish Candidate Mode Gate](#publish-candidate-mode-gate) |
| "Loosen the default 3 read sources / 2 relevant sources requirement." | `researchReportLoop: { minReadSources: 1, minRelevantSources: 1 }` |
| "Detect when the agent is spinning without progress." | Listen for `onStep` events with `step.type === "session-budget-breach"` |
| "Throttle parallel actions." | `maxPlanParallel: 2` |
| "Add a custom planner rule." | `plannerDirectives: ["Never mention pricing."]` |
| "Change the agent persona." | `role: "researcher"` or a custom role object |
| "Persist sessions across refresh." | `sessionStore: createIndexedDBSessionStore({ dbName })` |
| "Multi-tenant isolation." | Scope `dbName: \`agrun-\${userId}\`` |
| "Filter sensitive data out of memory." | `globalMemory.sensitivityFilter: (e) => ...` |
| "Stream tokens to my UI." | `runtime.run(input, { onToken: ... })` |
| "See every planner decision." | `runtime.run(input, { onStep: ..., onPlannerDecision: ... })` |
| "Register a new tool / skill." | Write a skill; add to `skills: [...]` |

### When the answer is "no, that's not a toggle"

- "Disable OODAE loop." → OODAE is the runtime. Not a flag.
- "Run on Node.js server." → Browser-only by design. See [agrun_docs/spec.md](./spec.md).
- "Use MCP servers as tools." → MCP needs stdio / server transport, incompatible with frontend-only. Not planned.
- "Disable planner entirely." → The planner is the runtime. ADR-0026 removed the single-tool fast path; every cycle goes through the planner. To skip the second planner round-trip, wire `onToolResult` and call your own finalize path.

If an engineer needs something that is not here and is not in the "no" list, route it through triage: bug vs config vs feature request.

## See Also

- [agrun_docs/public-runtime-api.md](./public-runtime-api.md) — full API reference
- [agrun_docs/usage-quickstart.md](./usage-quickstart.md) — getting started
- [agrun_docs/approval-flow.md](./approval-flow.md) — approval resume contract
- [agrun_docs/skill-system-architecture.md](./skill-system-architecture.md) — authoring skills
- [agrun_docs/planner-architecture.md](./planner-architecture.md) — planner internals
