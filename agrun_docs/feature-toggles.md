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

## Provider Adapters and Host Tools

Provider adapters are registered by passing them in the `skills` array.
Host executable behavior should use `customActions` and/or `agentSkills`.
Deleted Set A skill-loop exports are no longer available in v1.0.0.

Bundled provider adapters exported from `agrun`:

| Adapter | Purpose |
|-------|---------|
| `openaiBrowserSkill` | OpenAI Chat Completions by default; opt-in Responses API via `apiVariant: "responses"` |
| `geminiBrowserSkill` | Gemini generate content |

```js
createRuntime({
  skills: [openaiBrowserSkill]
  // geminiBrowserSkill omitted → Gemini not available this runtime
});
```

For web search and URL reading, configure runtime-owned actions with
`actionPolicy`, `webSearchEndpoint`, and provider request fields. For app tools,
register `customActions: [defineAction(...)]` or expose executable agent skill
tools through `agentSkillIndexProvider`.

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

### Prompt Content Overrides (`prompts`)

`plannerDirectives` *appends* lines. `prompts` *replaces* a whole default
section. ADR-0035 extracted agrun.js's opinionated planner-prompt content into
named sections (see [`src/runtime/prompts/README.md`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/prompts/README.md))
that a host can replace per-section without forking. **Default behavior is
byte-identical** — passing no `prompts` config changes nothing.

| Option | Default | Values | Effect |
|--------|---------|--------|--------|
| `prompts` | `{}` | object keyed by section name | Per-section REPLACE. Value per key: `string[]`, `(ctx) => string[]`, or `null`/`false` to disable. Unknown keys / wrong types throw. |

Section keys: `basePlannerDirectives`, `compactPlannerDirectives`,
`skillDirectives`, `workspaceDirectives`, `researchDirectives`,
`convergenceAdvisory`, `todoDirectives`, `nativePlannerDirectives`.

`runtime.getRuntimeConfig().prompts` returns the full resolved set (host
override where given, default otherwise). Default text is dumped to
`dist/agrun_docs/prompts/*.md` by `npm run build`.

```js
// Shape 1 — SILENT HOST: ship a research-capable surface but suppress the
// built-in research coaching prose (you provide your own via plannerDirectives
// or a loaded skill). Other sections keep defaults.
createRuntime({
  prompts: { researchDirectives: false }
});

// Shape 2 — CUSTOM PERSONA: replace the base planner directives with your own
// house rules. Function form receives { availableActions, compactSystemPrompt }.
createRuntime({
  prompts: {
    basePlannerDirectives: ({ availableActions }) => [
      "[agrun:planner-contract]",
      "Return exactly one JSON envelope per cycle.",
      "Never expose internal runtime terms to the user.",
      availableActions.some((a) => a.name === "web_search")
        ? "Use web_search before answering time-sensitive questions."
        : "Answer from provided context only."
    ]
  }
});

// Shape 3 — RESTRICTED ACTION SET: a host with no workspace/research tools
// strips those sections so the lite-tier model never sees directives for tools
// it cannot call (prevents the planner-invalid-action loop ADR-0034 closes).
createRuntime({
  disabledActions: ["web_search", "read_url", "workspace_write"],
  prompts: {
    researchDirectives: false,
    workspaceDirectives: false
  }
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

For hosts that register **only host-owned data/tool skills** and never declare long-research, none of these should fire and `runState.researchReportLoop` stays at its idle default. `terminalRepairState.active` should remain `false`.

### Toggles

| Option | Default | Values |
|--------|---------|--------|
| `researchReportLoop` | `{ enabled: true, ... }` | `false` \| `{ enabled, minReadSources, minRelevantSources, limit, maxPasses, maxIndependentSearchAttempts, maxResearchLoopVetoes }` |
| `researchReportLoop.enabled` | `true` | `false` to short-circuit `refreshResearchReportLoopGate` — gate never commits, no evidence/source minimum, no acceptance signal, no `terminalRepairState` evidence/length deficits |
| `researchReportLoop.minEvidenceArtifacts` | `3` | Generic alias for the minimum evidence artifacts required by the loop. |
| `researchReportLoop.minRelevantEvidenceArtifacts` | `2` | Generic alias for the minimum relevant evidence artifacts required by the loop. |
| `researchReportLoop.minReadSources` | `3` | Web-research profile threshold. Legacy name for minimum evidence artifacts from successful page reads. |
| `researchReportLoop.minRelevantSources` | `2` | Web-research profile threshold. Legacy name for minimum relevant evidence artifacts. |
| `evidencePolicy` | `{ profile: "web_research", recoveryActions: ["web_search", "read_url"] }` | Configures which actions the runtime names when evidence recovery is needed. Use `{ profile: "host", recoveryActions: ["host_data_query"] }` for hosts with their own evidence actions. |
| `evidencePolicy.structuredToolEvidence` | `true` | Counts successful structured host/tool results and host `customActions` as generic evidence for `successfulEvidenceCount`. |
| `researchCoverageGuard` | `{ enabled: true }` | `{ enabled: false }` to drop research coverage vetoes (separate from the report loop) |
| `citationCoverageGuard` | `{ enabled: true }` | `{ enabled: false }` to drop direct-source citation vetoes |

### When to disable

- **Host-data / tool-backed chatboxes** that ground answers in registered host actions and never consume `web_search` / `read_url`:

  ```js
  createRuntime({
    skills: [...erpSkills],
    customActions: [ordersQueryAction, customersLookupAction],
    actionPolicy: {
      "orders.query": "allow",
      "customers.lookup": "allow"
    },
    disabledActions: ["web_search", "read_url"],
    evidencePolicy: {
      profile: "host",
      recoveryActions: ["orders.query", "customers.lookup"]
    },
    researchReportLoop: { enabled: false },
    researchCoverageGuard: { enabled: false },
    citationCoverageGuard: { enabled: false }
  });
  ```

- **Hosts that ship their own evidence/quality contract** via `onBeforeFinalize` and want runtime to stay quiet on source counting.
- Hosts that still use workspace publish self-audit can report generic
  `requirementsAssessment.successfulEvidenceCount` instead of the legacy
  web-research-only `successfulReadUrlCount`.
- `gateSignal.acceptancePacket.evidence.evidenceMinimum` is the generic
  projection for new host integrations. `sourceMinimum` remains as a legacy
  web-research alias so existing Inspector/tests do not break.
- `runState.researchReportLoop.evidenceMinimum` mirrors the same generic
  status. `sourceMinimum` remains for backward-compatible web-research
  consumers.
- Browser Inspector and support/debug packets prefer generic
  `evidenceMinimum` / `successfulEvidenceCount` labels and keep legacy
  read-url/source fields under compatibility names such as
  `source_minimum_legacy` or `successful_read_url_count_legacy`.
- Long-form workspace publish debug packets expose
  `candidateQualitySignal`. Node live output uses `acceptanceGateScore`
  as the mechanical gate score and keeps `qualityScore` as a compatibility
  alias. See [Candidate Quality Signal](./candidate-quality-signal.md).

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

Focused no-web host verification:

```bash
node test/concerns/host-evidence-policy.test.js
npm run test:live:host-evidence -- --provider openai --reasoning-effort high
npm run test:live:host-evidence -- --provider gemini --gemini-thinking-level high
```

This fixture disables `web_search` / `read_url`, runs a host `customAction`
named `host_data_query`, publishes via `workspace_publish_candidate`, and
asserts `successfulEvidenceCount=1` while `successfulReadUrlCount=0`.
The live runner uses real provider credentials from `.env.local`, writes
reviewable JSON/Markdown artifacts under ignored `agrun_debug_runs/`, and
asserts the same no-web evidence contract against real planner behavior.

If `terminalRepairState.active === true` on a run that never declared long-research and never wrote a workspace candidate, that is a runtime bug — capture the JSON dump and report.

### Diagnosing model-imagined repair mode

Lite-tier planner models sometimes write reasoning like *"I am in terminal repair mode"* even when `runState.terminalRepairState.active === false`. Always confirm against the actual runState dump before treating it as a gate-firing bug — the model may be hallucinating the contract from planner-prompt teaching text.

## Publish Candidate Mode Gate

> **TL;DR.** `workspace_publish_candidate` is a publish-direct terminal — it skips the runtime finalize LLM (`usedRuntimeFinalize=false`, `tokens=0` on that step). Because skipping the finalizer is unsafe by default, the action is **gated by default**. **Three equal opt-in paths** unhide it. The gate is *not* "long_research only" — it is "explicit opt-in required."

### Pick your path

| Your host scenario | Opt-in path | Action needed |
|---|---|---|
| Host data/tool chatbox — no long-form drafting | none | **Keep default.** Deliver answers via `finalize`. |
| Bundles a long-research skill (`deep-research-writer` / `long-web-research`) | **(b) skill activation** | None — gate defers automatically when the skill is active. |
| Custom publish-direct flow with **no** long-research skill | **(a) host config opt-out** | `publishCandidateGate: { enabled: false }` |
| Runtime in terminal-repair recovery | **(c) runtime recovery** | None — repair surface owns the action when its `allowedActions` includes it. |

### Path (a) — Host config opt-out

For hosts with a custom publish-direct flow that does not activate any long-research skill (e.g. a tool-authored fast-path that writes a virtual-workspace candidate, finalizes, reads back, and publishes):

```js
createRuntime({
  skills: [...],
  publishCandidateGate: { enabled: false }
});
```

### Path (b) — Long-research skill activation

For hosts that bundle long-form research workflows. The gate defers automatically when any of these are true on `runState`:

- `researchActivation === "long_research"` (set by the planner or the skill), OR
- the active / selected / last-read skill is `deep-research-writer` or `long-web-research`.

No config change required — registering the skill is enough:

```js
createRuntime({
  skills: [deepResearchWriter, ...]  // bundled, activates isLongResearchRun(runState)
});
```

### Path (c) — Runtime recovery (automatic)

When `runState.terminalRepairState.active === true`, the repair surface's `allowedActions` list is authoritative. The gate defers — if `allowedActions` contains `workspace_publish_candidate`, the planner sees it. No host action required.

### AI self-review for long-form candidates

When a long-form or research answer uses the workspace publish path, the AI
must read and self-review the latest candidate before direct publish:

```text
workspace_read -> workspace_review_candidate -> workspace_publish_candidate
```

The self-review action records the AI's summary, issues, repair plan,
optional final section title, and ready-to-publish judgment. The runtime does
not grade prose or write the report. It only computes `candidateQualitySignal`
from objective facts: read/review freshness, word-count consistency, cited URL
readability, and reusable workspace structure inspection.

If the candidate is changed after review, publish is blocked with
`missing_latest_candidate_review` until the AI reads and reviews the new
candidate. `decision: "limited"` remains available for honest partial results
when objective blockers are cleared or the AI names concrete remaining gaps.

Full contract: [Candidate Quality Signal](./candidate-quality-signal.md).

### Toggles reference

| Option | Default | Values |
|---|---|---|
| `publishCandidateGate` | `{ enabled: true }` | `false` \| `{ enabled }` |
| `publishCandidateGate.enabled` | `true` | `false` restores pre-2026-05-26 behavior — `workspace_publish_candidate` reachable in any mode. |

### Two enforcement layers

1. **Catalog filter (cooperative planners).** `selectPlannerActions` hides the action from the planner's allowedActions, so well-behaved planners never see the name in the first place.
2. **Per-decision runtime guard (hallucinated emissions).** If a lite-tier planner emits the name from memory despite it being hidden, the guard in `action-loop-session-loop.js` rejects through `handleInvalidPlannerDecision`. The next planner cycle receives a `plannerInvalidSignal` carrying "use finalize instead" — the planner converges in the next cycle instead of looping until `maxSteps`.

### Diagnostics

| Signal | Meaning |
|---|---|
| Step `type === "workspace-publish-candidate-gated"` in ledger | Runtime guard fired — planner emitted the name despite the catalog hiding it. Inspect `detail.detail` for the gate message. |
| `runState.plannerInvalidSignal.reason === "workspace_publish_candidate_gated"` | Next planner cycle will receive the gate detail and a `requiredEnvelope: "finalize"` directive. |
| `finalAnswerSource === "planner_finalize"` after gated step | ✅ Convergence succeeded — gate worked as designed. |
| `finalAnswerSource === "continuation_required"` after gated step | ❌ Planner failed to converge within budget. Investigate whether the planner prompt is correctly receiving `plannerInvalidSignal.requiredEnvelope`. |

### Why this gate exists

`workspace_publish_candidate` was designed for the long-form `long_research` flow where the AI drafts, finalizes, and reads-back a candidate before publishing it directly as the final answer. Because that publish path bypasses the runtime finalize LLM, it has two side effects:

- `usedRuntimeFinalize=false`, `tokens=0` on the terminal step → **audit blind spot** for token-cost aggregators that key on `tokens > 0`.
- A fabricated workspace draft is published verbatim → **fabrication risk** if the planner uses the action as a "give up" escape.

Globe3 ERP (integrator email 2026-05-26) reported 6 runs across 3 days where lite-tier envelope-mode planners (Gemini Flash-Lite) treated the action as a generic escape, producing fabricated "I could not access ERP" answers with `tokens=0`. Their `disabledActions: [..., 'workspace_publish_candidate']` workaround verified working, but every host would have had to rediscover this independently. The gate ports that fix into the runtime as a default-on contract.

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
  skills: [openaiBrowserSkill],
  disabledActions: ["web_search", "read_url", "ask_clarification"],
  globalMemory: { enabled: false },
  circuitBreaker: false,
  maxSteps: 3
});
```

### Research agent (all capabilities, high limits)

```js
createRuntime({
  skills: [geminiBrowserSkill],
  actionPolicy: { web_search: "allow", read_url: "allow" },
  plannerMode: "auto",
  maxSteps: 15,
  maxPlanActions: 15,
  circuitBreaker: true
});
```

### Approval-gated write tool

```js
createRuntime({
  skills: [openaiBrowserSkill],
  customActions: [writeAction],
  actionPolicy: {
    execute_skill_tool: "ask"
  }
});
```

### Privacy-hard mode (no persistence, no cross-session)

```js
createRuntime({
  skills: [openaiBrowserSkill],
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

## Pattern B canonical opt-out shape (AGRUN-264)

When a runtime subsystem ships an `enabled: false` opt-out, the producer
must guard state assignment BEFORE writing a default. The absence of
state IS the disabled signal — never a poisoned numeric default that
consumers must learn to ignore.

**Canonical example:** [src/runtime/research-coverage-guard.js:59](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-coverage-guard.js#L59).

```js
const normalized = normalizeResearchCoverageConfig(config);
if (!normalized.enabled) return null;          // ← guard BEFORE assignment
// ... only on enabled path:
runState.researchCoverageGuard = { ... };
```

**AGRUN-264 fix applied this to `researchReportLoop`:**
`createResearchReportLoopState()` now returns `sourceMinimum: null` when
the loop is disabled. `normalizeLoopState()` likewise drops sourceMinimum
to null whenever `enabled !== true`. Every consumer
(`terminal-repair-state.js`, `action-pattern-progress.readSourceMinimum`,
`requirement-recovery-evaluator`, `terminal-final-contract`,
`research-acceptance-evaluator`) already null-checks before applying
deficit semantics, so `null` cleanly means "no minimum declared, do not
gate."

The anti-pattern (and why AGRUN-264 happened): shipping a default
`{ passed: false, minReadSources: 3, ... }` that says "evaluated and
failed" when the truth is "never evaluated because the loop is off."
Downstream consumers cannot distinguish the two without reading
`loop.enabled === true` themselves at every site — and at least one of
them inevitably forgets.

When you add a new `*Gate.enabled` / `*Loop.enabled` / `*Guard.enabled`
flag, audit:

1. The state-creator: does it ship a "poisoned" default that downstream
   gating reads without checking `enabled`?
2. The normalizer / hydrator: same question; does it re-poison on every
   read?
3. Every consumer of the gated field: is the read site null-safe AND
   semantically aware ("null means no gate")?

## `productiveProgressDimensions` (AGRUN-263)

Runtime config knob for tool-loop hosts where the default productive
dimensions (`["workspace", "source"]`, plus `evidence` when
`evidencePolicy.profile` is host-owned) are too narrow.

```js
runtimeConfig: {
  productiveProgressDimensions: ["workspace", "source", "tool_result"]
}
```

**Semantics:** explicit REPLACEMENT (not merge) of the default
whitelist. Misconfiguration is loud rather than silently additive — a
host who writes `["tool_result"]` alone has explicitly opted out of
treating workspace / source growth as productive.

**`tool_result` dimension** — fires when `toolContext.history` grew this
step AND the current decision's `actionName + ":" + stableStringify(args)`
fingerprint is NOT in the last 5 recorded fingerprints. The dedup window
prevents the planner from gaming the detector by re-issuing identical
tool calls (the AGRUN-256 trap, applied defensively).

**`evidence` dimension** — generic host evidence progress. It is included
automatically when `evidencePolicy.profile` is not `web_research`, so
successful host-owned evidence can clear read-only-planning loops without
pretending to be `read_url` source progress.

**Who needs `tool_result`:** tool-loop hosts whose normal
flow `list_agent_skills → use_agent_skill → execute_skill_tool` is all
classified as read-only planning per
`DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS`. Without this knob, the
detector trips at threshold 3 even on successful tool calls returning
real data.

**Who must NOT enable `tool_result`:** long-form research / drafting
hosts. Adding `tool_result` to their whitelist would mask genuine
read-only loops where the planner keeps fetching without writing.

## Snapshot vs planner-request projection

`runtime.snapshot.runState.terminalRepairState` is a stripped view (e.g.
`actionPatternConvergence.readOnlyPlanning` may be pruned from the
projection); the canonical state is `loopState.terminalRepairState` in
the planner request body. When two views of "the same" state disagree,
the planner request body is the load-bearing surface. Use
`terminalRepairState.reason === "read_only_planning_with_observable_deficits"`
as the authoritative signal for that activation path.

## See Also

- [agrun_docs/public-runtime-api.md](./public-runtime-api.md) — full API reference
- [agrun_docs/usage-quickstart.md](./usage-quickstart.md) — getting started
- [agrun_docs/approval-flow.md](./approval-flow.md) — approval resume contract
- [agrun_docs/skill-system-architecture.md](./skill-system-architecture.md) — authoring skills
- [agrun_docs/planner-architecture.md](./planner-architecture.md) — planner internals
