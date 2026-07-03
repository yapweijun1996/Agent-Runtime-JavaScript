# ADR-0057: Deferred action loading — extend the skills discover→load pattern to built-in action namespaces

- Status: PROPOSED (design for maintainer review — no code has been changed under this ADR)
- Date: 2026-07-02
- Decision owner: Maintainer
- Related: `agrun_docs/audits/agrun-vs-openai-agents-sdk-benchmark-2026-07-02.md` (the
  measurement forcing this), ADR-0013 (skill discovery is a tool — the internal precedent),
  ADR-0033 (compact planner profile / lite-tier), ADR-0035 (prompt content as host-overridable
  defaults, byte-identity snapshot), ADR-0056 (workspace is general infrastructure — stays in
  core; this ADR defers its *description*, not its existence), CLAUDE.md "Dispatch-Path Parity
  (两道门规则)", `agrun_docs/audits/cross-cutting-dispatch-matrix-2026-06-10.md`, task.jsonl
  AGRUN-560 (real single-door/plan-door parity incident), AGRUN-564 (the benchmark), AGRUN-565
  (this proposal).

## Context

### The measured problem

The 2026-07-02 live benchmark (AGRUN-564) ran agrun (`dist/agrun.js`) and the OpenAI Agents
SDK against the identical model (`gpt-5-mini`), identical prompts, identical synthetic tool.
For a trivial "Reply with exactly: pong" turn, agrun used **5465 tokens vs 101 (~54x)** and was
~2.6x slower wall-clock. The exact-request-body capture in the benchmark writeup attributes the
gap to two distinct root causes; this ADR addresses the **larger** one:

> **~49% of the default 24620-char prompt** (available-actions list + args-examples +
> workspace-directives + research-directives) *is* correctly gated in code on `hasAction(...)`
> — but the gate is always open in practice, because nothing upstream of the prompt builder
> ever narrows `availableActions` down to what a given task actually needs.

Verified against source:

1. **Every built-in action registers unconditionally.** `buildActions` in
   `src/runtime/action-registry.js:84-133` assembles 3 skill-catalog actions +
   `execute_skill_tool` + a 25-entry `runtimeActions` list (`web_search`, `read_url`,
   `handoff_to_skill`, `spawn_subagent`, 5× `todo_*`, 13× `workspace_*`, 2× config-gated
   `repo_*`, `ask_clarification`) — ~26 actions in the default planner catalog. The only
   narrowing is the host-static `disabledActions` name-set subtraction
   (`src/runtime/action-availability.js:1`, applied at `src/runtime/action-loop-session.js:83-88`).
2. **The prompt describes all of them, twice, every turn.** The user message carries an
   "Available actions:" description list (`src/runtime/planner-prompt.js:377`; 4641 chars / 26
   actions in the captured default request); the system message carries an "Action args
   examples:" rendering of the same catalog (`src/runtime/planner-envelope-lines.js:139`; 3202
   chars).
3. **The per-namespace directive files already gate correctly — on input that never shrinks.**
   `buildSystemPromptLines` (`src/runtime/planner-prompt.js:136`, `hasAction` closure at `:141`)
   pushes `prompts/skill-directives.js` (`:167`), `prompts/workspace-directives.js` (`:169`,
   ~3460 chars, every line gated on `hasAction("workspace_*")`), `prompts/research-directives.js`
   (`:171`, ~770 chars, gated on `hasAction("read_url") || hasAction("web_search")`), and
   `prompts/todo-directives.js` (`:177`). Because the default registry always contains those
   actions, the gates are always true. Narrow the input list and these files shrink for free.
4. **Out of scope here:** the other root cause — `prompts/planner-compact-directives.js`
   (~5940 chars, `buildLines({runtimeConfig})` takes no action list at all) and
   `prompts/convergence-advisory.js` (no `hasAction` gating) are structurally unconditional
   (~25% of the prompt), and the ~3515-char mostly-idle `loopState` JSON is a third cost.
   Those need their own gating/compaction work; this ADR only fixes "the availability input
   never narrows".

### The internal precedent: skills already work the AI-first way

ADR-0013 locked the push→pull contract for skills: the runtime does **not** describe every
skill's full instructions every turn. Instead the AI *discovers* (`list_agent_skills`),
*loads* (`read_agent_skill`), and *activates* (`use_agent_skill`) — three catalog actions
registered in `src/runtime/action-registry.js:89-93`, with a two-line always-present hint
(`prompts/skill-directives.js:12`). Activation state lives in
`runState.agentSkillContext` (`src/runtime/state.js:85-97`), is written back on **both**
dispatch doors (`src/runtime/action-loop-action.js:647-669` single-action;
`src/runtime/action-loop-plan-actions.js:477` plan-batch), and the prompt *reacts* to it:
`selectPlannerSystemPromptProfile` (`src/runtime/planner.js:616`) switches compact→full when a
skill is active. The full skill instructions cost tokens only on turns that actually engaged a
skill.

The built-in workspace/research/todo action families never got this treatment. They are
always-fully-described, which is exactly the cost the benchmark measured.

### The external precedent

OpenAI's Agents SDK (JS) ships the directly analogous mechanism, "Deferred Tool Loading with
Tool Search" (https://openai.github.io/openai-agents-js/guides/tools/#deferred-tool-loading-with-tool-search,
verified live 2026-07-02; `toolNamespace` and `toolSearchTool` re-confirmed against the SDK API
reference index the same day): `toolNamespace({name, description, tools})` groups related tools
under one lightweight namespace description; tools/namespaces marked `deferLoading: true` are
not sent to the model up front; a `toolSearchTool()` meta-tool lets **the model itself** search
and load full definitions on demand. Notably OpenAI gates this behind newer model tiers
(GPT-5.4+ class) — the discover-then-load hop assumes a model competent enough to take it.

### The mechanism this proposal builds on (already in core)

- `selectPlannerActions` (`src/runtime/planner-action-surface.js:51`, consumed at
  `src/runtime/action-loop-planner.js:79`) already narrows the per-turn planner catalog for
  other reasons (AGRUN-256 publish gate, convergence forbids, terminal-repair allowlist) — and
  its AGRUN-256 comment documents the required pairing: a surface-hide must come with a
  per-decision runtime guard, because envelope planners can emit hidden actions by name.
- Both dispatch doors already enforce availability: the single-action door via
  `isDecisionActionAvailable` (`src/runtime/action-loop-session-loop.js:433-455`, emits an
  `action-disabled` observation and continues), the plan-batch door via `isActionAvailable` +
  `validateRuntimeActionSurface` (`src/runtime/action-loop-plan-validation.js:45-55`, def
  `:228`). AGRUN-560 is the standing proof of what happens when a mechanism reaches one door
  but not the other.
- The prompt-shape safety net exists: `test/unit/prompt-snapshot.test.js` locks
  `buildSystemPromptLines` output byte-identically for explicit configs **including narrowed
  action sets** (`globe3-shape`, `research-only`, `workspace-shape`, `skills-shape`) — proving
  today that the prompt already shrinks correctly when the input list is smaller.

## Decision

**Extend the ADR-0013 discover→load pattern from skills to the built-in action registry:
group workspace/research/todo actions into declared namespaces; when a namespace is deferred,
the prompt shows only its one-line description, and the AI opens it with an explicit action —
`open_action_namespace` — loading the full member definitions + directives for the rest of the
run.**

### 1. Namespace metadata is declarative data, not a classifier

Each built-in action descriptor gains an optional `namespace` field (mechanism-level metadata,
same tier as `permission`/`tier` in `action-registry.js`). Initial namespaces:

| Namespace | Members | Prompt cost deferred (from the benchmark's file attribution) |
|---|---|---|
| `workspace` | 13 `workspace_*` actions | ~3460 chars directives + 13/26 share of the 4641+3202-char catalog blocks |
| `research` | `web_search`, `read_url` | ~770 chars directives + 2/26 catalog share |
| `todo` | 5 `todo_*` actions | todo-directives + 5/26 catalog share |

Everything else (skill catalog trio, `execute_skill_tool`, `ask_clarification`,
`handoff_to_skill`, `spawn_subagent`, custom actions) stays namespace-less = always-on.
A namespace manifest carries `{name, description}` where `description` is a 1-2 line summary
("workspace: draft, edit, review and publish long multi-section deliverables in a virtual
file workspace. Open before any multi-section drafting.") — authored once, host-overridable
via the ADR-0035 `prompts` map convention.

### 2. Opt-in deferral; loading decision belongs to the AI

`createRuntime({ deferredNamespaces: ["workspace", ...] })` (default `[]` — today's behavior,
byte-identical prompts). When a namespace is deferred and not yet opened:

- Its member actions are **excluded from `plannerActions`** (the same
  `filterAvailableActions`-style subtraction at `action-loop-session.js:87-88`, extended to a
  namespace-aware filter). All existing `hasAction()` gates in
  `workspace-directives.js` / `research-directives.js` / `todo-directives.js` /
  `skill-directives.js` and both catalog renderings then shrink automatically — zero changes
  to the gated prompt files.
- The prompt instead carries one hint line per closed namespace (mirroring ADR-0013's two-line
  skill hint): *"Closed action namespaces: workspace (…), research (…). Call
  open_action_namespace with the namespace name before using its actions."*
- A new built-in action `open_action_namespace(namespace)` marks the namespace open. **The AI
  decides when** — same policy boundary as `list_agent_skills`. The runtime never guesses task
  type; there is no keyword heuristic and no extra classification LLM call (CLAUDE.md "no
  hardcode / AI-first"). With only 3 namespaces the hint lines ARE the catalog, so no separate
  `search` meta-tool is needed yet; a `list/search_action_namespaces` discovery action becomes
  warranted only if namespace count grows (same threshold logic as ADR-0013's "embedding
  ranking when the catalog outgrows substring search").
- `open_action_namespace` is standalone-only (`plan: STANDALONE_PLAN_ACTION`, exactly like
  `use_agent_skill` at `src/runtime/actions/use-agent-skill-action.js:22`) because it mutates
  the planner action surface. The existing plan-contract check
  (`action-loop-plan-validation.js:56-65`) then rejects it inside plan batches for free.

### 3. Open state: same shape as skill activation, per run

New runState slot beside `agentSkillContext` (`state.js:85`):

```
actionNamespaceContext: {
  deferred: [...],          // from runtimeConfig at run start
  opened: { workspace: { openedAtCycle } }
}
```

- **Within a run:** opened stays open for all subsequent planner cycles — the very next prompt
  renders full member definitions + directives. This mirrors `agentSkillContext.activeSkill`
  persistence within a run, and `selectPlannerSystemPromptProfile`-style state-reaction is
  presentation mechanism, not task classification.
- **Across session turns:** v1 matches the skill-activation shape — `agentSkillContext` is
  created fresh per run and is NOT carried by `hydrateRunStateWithThread`
  (`src/runtime/run-state-thread.js:55`), so namespace opens reset each turn and cost one
  re-open round-trip on continuation turns. A follow-up (Phase 3 below) may carry
  `openedNamespaces` through thread hydration using the established `todoState` slot pattern
  **including its terminal-reset rule** (`run-state-thread.js:79-90`: carry while the work unit
  is live, clear when it terminates) so a continued drafting task keeps its namespace open but
  an unrelated next question starts clean. That carry is deliberately NOT in v1: it needs live
  evidence about stale-open prompt bloat vs re-open cost first.
- **Crash-recovery/importState:** the slot rides `snapshotRunState` like `agentSkillContext`
  (`state.js:208-218`), sanitized to plain data.

### 4. Two-door enforcement (两道门规则) — the non-negotiable part

Action-availability gating is a cross-cutting mechanism, so the closed-namespace gate must be
wired and tested on **both** dispatch doors, via one shared predicate (per CLAUDE.md: "extract
to a shared module, import on both paths" — the second copy is the next AGRUN-560):

- **Shared module** (new, e.g. `src/runtime/action-namespace-gate.js`):
  `resolveClosedNamespaceForAction(runState, runtimeConfig, actionName)` → `null` or
  `{namespace, hint}`. Single source of truth for "is this action currently behind a closed
  namespace".
- **Single-action door:** checked in `action-loop-session-loop.js` beside the existing
  `isDecisionActionAvailable` disabled-check (`:433-455`). Emitting a closed-namespace action
  by name yields a **recoverable structured observation** (the AGRUN-256 guard+detail pattern
  and the ADR-0034 invalid-action surface): *"workspace_write is in the closed namespace
  'workspace'; call open_action_namespace {namespace:'workspace'} first."* The AI corrects
  itself next cycle; no runtime fallback is synthesized.
- **Plan-batch door:** the same predicate checked in `action-loop-plan-validation.js` beside
  `isActionAvailable` (`:49`) / `validateRuntimeActionSurface` (`:52`), returning the same
  error code + detail so plan feedback and single-action feedback are word-for-word consistent.
  Ordering: namespace check sits with the availability checks, BEFORE the `runPreToolCall`
  policy hook (`:79`) — availability precedes permission, matching today's order.
- **Third door to triage:** `spawn_subagent` — child runs build fresh runState, so children
  start with namespaces closed (fresh discovery). The implementation must explicitly triage
  `deferredNamespaces` against the subagent option strip-list and
  `CHILD_PARENT_STATE_BLANKLIST` in `spawn-subagent-capability.js` and write the outcome into
  the dispatch matrix (`agrun_docs/audits/cross-cutting-dispatch-matrix-2026-06-10.md`), which
  gains a row for this mechanism.
- **One test per door** is part of the acceptance bar, not optional: (a) single-action
  emission of a closed action → structured observation, loop continues; (b) plan batch
  containing a closed action → plan validation error with the same code; (c) open→use flow on
  each door; (d) `open_action_namespace` inside a plan → standalone-only rejection.

Design note — "auto-open on use" (treating the AI's emission of `workspace_write` as an
implicit open) was considered and deferred: it is arguably AI-first, but the model emitted the
action without ever seeing its args schema, so the call likely fails validation anyway, and an
implicit open makes the gate unobservable. v1 keeps the explicit action; auto-open can be
revisited with live-matrix evidence.

### 5. Subsystem self-consistency: state-driven auto-open (data-gated, not a classifier)

Two runtime subsystems hand the AI a *contract* that names namespace actions; the namespace
must not be closed while such a contract is live, or the contract deadlocks:

- `terminalRepairState.allowedActions` (consumed by `selectPlannerActions`,
  `planner-action-surface.js:55-57,101-103`) may list `workspace_*` repair actions;
- an active `researchReportLoop` / evidence-convergence run assumes `web_search`/`read_url`.

Rule: when runtime state already references a namespace's actions, the namespace is treated as
open. This is the ADR-0056 data-gated-seam pattern — reacting to state the AI's own earlier
actions created is mechanism (contract self-consistency), not the runtime classifying the task.
In practice these states can only arise after the AI opened the namespace anyway; the rule
exists so resumes/repairs can never wedge.

### 6. Model-tier posture: no hardcoded gate in v1

OpenAI restricts deferred loading to GPT-5.4+ class models. agrun's equivalent lever exists —
`isLiteTierModel` (`src/runtime/provider-capabilities.js:60`) with the host-overridable
`request.modelTier` escape hatch (`planner.js:620-629`) — but v1 does **not** auto-disable
deferral for lite-tier models: deferral is host-opt-in already, lite models benefit most from
smaller prompts (the whole point of ADR-0033 compact mode), and a tier-based auto-off is a
hardcoded capability guess. Instead the pilot measures lite-tier open-rate; if lite models
demonstrably fail to open namespaces they need, the remedy is a documented host recommendation
(don't defer for lite tiers) or a `modelTier`-aware default that reuses the existing override
shape — never a new runtime classifier.

### 7. Phased rollout

- **Phase 0 (no behavior change):** namespace metadata on descriptors + manifest + shared gate
  module + hint-line renderer, all inert with `deferredNamespaces: []`. New prompt-snapshot
  configs for closed shapes. `npm run check` green with existing snapshot values byte-identical.
- **Phase 1 (pilot = workspace):** `deferredNamespaces: ["workspace"]` opt-in. Workspace is the
  single biggest measured contributor (~3460 directive chars + 13/26 of both catalog blocks).
  Re-run `examples/agent-sdk-benchmark` minimal tier with the flag on; expected input-token
  drop on trivial turns is roughly the disabled-actions probe's direction (default 5130 →
  2335 with everything off; workspace-only deferral lands in between). Add the two-door tests.
- **Phase 2:** `research`, `todo` namespaces; re-measure; verify research-skill and todo
  autopilot live flows still open what they need.
- **Phase 3 (decision point, own evidence):** thread-hydration carry of `openedNamespaces`
  (todoState pattern), possible default-on for fresh sessions, possible auto-open-on-use — each
  gated on a live matrix à la ADR-0013 PR 3 (key metric: open-rate when the task genuinely
  needs the namespace, e.g. "write a long report" must lead to `open_action_namespace`
  → `workspace_write`).

## Alternatives

1. **Host-level static config only (`disabledActions`).** Already works today
   (`action-availability.js`, `config.js:151`, per-run merge in `default-run-options.js:36-40`)
   and the benchmark's probe proved the mechanism: disabling all built-ins cut input tokens 54%.
   Zero new code. Rejected as the *complete* answer: every host must hand-curate action-name
   lists (and keep them in sync with registry evolution), the choice is static for the whole
   session/run — a chat that starts as Q&A and becomes "now write me a full report" cannot
   re-enable workspace mid-session — and it pushes an AI-capability decision onto host
   engineers. It remains the right tool for capabilities a host wants *never* available, and it
   composes with this design (disabled trumps open).
2. **Runtime-side automatic classification** (keyword/regex heuristic, or an extra LLM
   classification call, deciding which namespaces a request needs). Rejected. The heuristic
   variant violates the project's explicit "no hardcode / AI-first" rule — it is exactly the
   push-mode runtime opinion ADR-0013 deleted for skills (and its Cell-C2 failure mode:
   English-centric heuristics scoring zero on Mandarin prompts). The LLM variant adds a
   classification call's latency+cost to every turn, unamortized on single-shot tasks, and
   still splits the decision across two models. The loading decision stays with the planner AI,
   which already has the request in context.
3. **Prompt-only compaction without availability change** (render the catalog once instead of
   twice; drop idle loopState keys; gate the two unconditional directive files). Real,
   complementary, and smaller-risk — these are the benchmark's follow-ups #2-#4 and they attack
   the ~25% unconditional bucket this ADR deliberately leaves alone. Not chosen *instead*
   because they cannot reach the ~49% availability-driven bucket: a deduped catalog of 26
   actions is still a catalog of 26 actions. Do both; this ADR is the availability half.

## Consequences

- Pros:
  - Directly attacks the measured ~49% availability-driven prompt share on turns that need no
    workspace/research/todo; fresh trivial turns stop paying ~2800 tokens of registry tax.
    Lower prefill cost should also claw back part of the 2.2-2.6x wall-clock gap.
  - Architecturally consistent: one discovery pattern (skills AND built-ins), matching both
    agrun's own ADR-0013 and the OpenAI SDK's deferred-loading posture, instead of two
    philosophies in one runtime.
  - The `hasAction()` gating investment finally pays off — the gated files shrink with zero
    edits to them.
  - Opt-in and additive: default `deferredNamespaces: []` keeps prompts byte-identical; no
    host breaks. `actionPolicy` and approval flows are untouched (availability is checked
    before policy, same as today); hosts allow-listing workspace actions see no change unless
    they opt in.
  - Custom actions are unaffected (namespace-less = always-on), so
    `test/unit/custom-actions-registration.test.js`'s "host action must appear in planner
    catalog" contract holds.
- Cons:
  - One extra planner round-trip (the open call) on runs that DO need a deferred namespace —
    the ADR-0013 cold-start cost shape. Amortized within the run and tiny against a drafting
    task's total, but real on short workspace tasks.
  - Opening mid-run changes the system prompt → one provider prompt-cache invalidation per
    open.
  - v1's per-run open state means continuation turns re-pay the open round-trip until Phase 3's
    thread carry ships.
  - More prompt-shape surface: hint lines + open/closed variants multiply snapshot configs.
- Risks:
  - **AI never opens the namespace it needs** (the ADR-0013 risk, same mitigation): the hint
    line's wording is the policy lever; measure open-rate in the Phase 1/2 live matrix before
    any default-on decision; lite-tier models are the watch item (§6).
  - **Door drift**: a namespace gate on the prompt/plan path but not the single-action path
    (or vice versa) recreates AGRUN-560. Mitigation is structural: one shared predicate module
    + a test per door + a new row in the cross-cutting dispatch matrix. Reviewers should reject
    any implementation PR that inlines the check twice.
  - **Contract deadlock** with terminal-repair / research-loop states listing closed actions —
    prevented by §5 state-driven auto-open; needs its own regression test (repair contract
    active + namespace nominally closed → actions still surfaceable).
  - **Test churn, contained**: `test/unit/prompt-snapshot.test.js` compares the config-key SET,
    so adding closed-shape configs requires regenerating the sidecar — the acceptance bar is
    that all pre-existing keys' rendered values stay byte-identical (only new keys added).
    `test/unit/planner-prompt-envelope-lines.test.js` gains a closed-vs-open size assertion
    following its existing `compactExamples` pattern (`:118-137`,
    `assert.ok(compactLines.length < fullLines.length)` plus contract-line matches).
  - **Benchmark honesty**: the projected savings derive from one benchmark's char/token
    attribution; Phase 1 must re-measure rather than assume (the audit itself needed two
    rounds of correction — measure the mode actually selected at runtime).

## Rollback

- Phase 0/1 are opt-in behind `deferredNamespaces` (default `[]`): rollback = hosts drop the
  flag; defaults were never affected. Full removal = delete the gate module,
  `open_action_namespace`, the hint-line renderer, and the namespace metadata fields; remove
  the added snapshot config keys and regenerate the sidecar; existing snapshot values are
  untouched by construction, so reverting cannot move them.
- `actionNamespaceContext` lives only in per-run state in v1, so no persisted-session migration
  exists to unwind. If Phase 3's thread carry shipped, stale `openedNamespaces` slots in saved
  session records are ignored by readers on rollback (versioned-data tolerance, same posture as
  ADR-0055's reader aliases).
- Docs to restore/update on revert: this ADR (mark REJECTED/SUPERSEDED with the evidence),
  the dispatch-matrix row, `public-runtime-api.md` if `deferredNamespaces` was documented, and
  the benchmark audit's follow-up list (re-open item 1).
