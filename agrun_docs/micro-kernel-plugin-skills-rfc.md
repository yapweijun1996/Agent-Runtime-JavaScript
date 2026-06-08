# RFC: agrun micro-kernel — unify skills as opt-in plugins, remove default domain opinion

**Status: ACCEPTED (direction + decisions resolved by maintainer; ready to graduate to ADR-0052).**
The four product/DX questions are resolved in "Decisions" below. All are deliberately
conservative and reversible before the 2.0 cut; the only irreversible step (Phase 3
default flip) is gated to a major version with a deprecation window.
**Author:** raised by maintainer (engineer feedback: "we don't need the bundled skills").
**Date:** 2026-06-07.

## Context

agrun.js is stated to be *"a general harness agent runtime JavaScript library for all
kinds of frontend systems"* and its project rules mandate *"build the real AI-first
architecture … remove the non-AI-first logic if needed"* and *"no hardcode"*. Today the
runtime violates its own stated principle at the architecture level, not just the
variable level.

**Evidence (current code, 2026-06-07):**

1. **Default opinion is forced.** `src/runtime/config.js:47`:
   ```js
   const resolvedFullAgentSkills = normalizeAgentSkills(
     config.agentSkills == null ? bundledAgentSkills : config.agentSkills);
   ```
   If the host passes no `agentSkills`, it is given the FULL bundled set
   (deep-research-writer, report-writing, expert-coder, long-web-research, …). A host
   *can* opt out with `agentSkills: []`, but only by reading source; the default is an
   opinion, and a default IS a form of hardcoding.

2. **Bundled skill code ships inside core.** `bundledAgentSkills` is imported in
   `src/index.js` and bundled into `dist/agrun.js`, so even a host that passes
   `agentSkills: []` still ships the domain code (bundle size + surface area).

3. **Domain enforcement machinery lives in core, not in the skill.** ~18 of 185
   `src/runtime/*.js` files are research/report domain-specific:
   `research-state, research-acceptance-evaluator, research-coverage-guard,
   research-domain-ownership, research-entity-resolution, research-evidence-graph,
   research-finalize-contract, research-report-loop, research-source-authority,
   research-thread-sync, candidate-quality-signal, virtual-workspace,
   workspace-candidate-lifecycle, terminal-repair-state, output-guardrail-recipes, …`
   Domain literals baked into core: `"workspace_publish_candidate"` ×46,
   `"workspace_finalize_candidate"` ×24, `"long_research"` ×10,
   `"candidate_quality_blocked"` ×5.

4. **Two skill tiers, and a hardcoded name list.** Bundled skills load automatically;
   custom skills go through `defineSkill`. The publish mode-gate
   (`planner-action-surface.js`) recognises long-research mode three ways — a clean
   capability check (`skill.capabilities.requiresPublishReadiness === true`), an explicit
   `researchActivation:"long_research"` flag, AND a HARDCODED name set
   (`research-state.js:6 LONG_RESEARCH_SKILL_IDS = ["deep-research-writer",
   "long-web-research"]`). The capability path is correct; the name list is a hardcode
   smell.

**The core problem:** a "general runtime" ships an opinionated research-report
application inside its core and turns it on by default. Engineers who do not write
research reports still pay for it (bundle, concepts, the `long_research` mode the core
knows about).

**The hardcode has three nested levels — naming only the shallowest under-states it:**

1. **Variable level** — the hardcoded name list `LONG_RESEARCH_SKILL_IDS =
   ["deep-research-writer","long-web-research"]` (`research-state.js:6`). The core knows
   specific skill *names*. Fixable by a capability declaration.
2. **Concept / mode level (the deeper one)** — the **existence of a `long_research`
   mode at all inside the kernel is itself the hardcode.** A general agent runtime has no
   business knowing what "long research" is, any more than it should know "issue an
   invoice" or "book a flight". `long_research` is a domain concept; that the kernel has a
   named mode for it (and gates a named tool behind it) is domain policy baked into core,
   independent of how the mode is triggered. This is the level that does **not** go away
   by swapping the name list for a capability — the *mode itself* must leave the kernel.
3. **Application level** — the whole research stack (~18 files: research-state,
   candidate-quality, evidence-graph, publish gate, …) is a research-report application
   living in the kernel.

A fix that only addresses level 1 (capabilities instead of names) is necessary but
**not sufficient**: the kernel would still define and enforce a `long_research` mode.
True generality requires removing levels 2 and 3 — the mode concept and its enforcement
machinery move into the plugin; the kernel keeps only a generic capability-gating
mechanism with no named modes at all.

## Decision (proposed)

Adopt a **micro-kernel + opt-in plugins** architecture, matching ESLint (core ships zero
rules), webpack (zero loaders), and VS Code (zero features) — core provides *mechanism*
and a *single plugin entry point*; every domain capability is an opt-in plugin the
engineer chooses.

Concretely:

1. **Zero default opinion.** `config.agentSkills == null` defaults to `[]`, not
   `bundledAgentSkills`. Out of the box the runtime has no skills.

2. **One uniform skill mechanism.** Collapse the bundled-vs-custom tiers into a single
   plugin registration path. "Bundled" stops being special; it becomes an optional
   package the host imports and passes in like any custom skill.

3. **Skills are self-contained.** A skill plugin carries its full domain footprint:
   the AI-facing instructions (already there), its declared capabilities, its tools,
   AND its enforcement machinery. The research enforcement files move OUT of core into
   the plugin. Otherwise we would have "opt-in skills but the kernel still enforces
   research semantics" — a contradiction.

4. **Core keeps only generic mechanism, zero domain vocabulary.** No `"long_research"`,
   no `"workspace_publish_candidate"`, no research file in core. The kernel knows only:
   *an action may declare a required capability; capabilities are activated by
   registered plugins/host policy; the kernel gates accordingly.* Replace
   `LONG_RESEARCH_SKILL_IDS` (name list) with a capability declaration the kernel reads
   generically.

5. **Distribution.** Ship the former bundled skills as an optional package
   (e.g. `@agrun/skills-research`, `@agrun/skills-coder`). Provide a documented
   "starter pack" import so newcomer DX stays one line.

## Target architecture

```
agrun core (zero domain vocabulary)
  ├─ OODAE planner loop
  ├─ capability-gated action surface (reads declared capability, knows no names)
  ├─ convergence detection + generic finalize contract
  └─ ONE plugin registration entry point

@agrun/skills-research  (opt-in plugin package)
  ├─ deep-research-writer instructions (the AI playbook)
  ├─ enforcement: research-state, candidate-quality, publish gate, evidence graph
  └─ tools: workspace_publish_candidate, workspace_finalize_candidate, …

host project
  └─ imports only the plugins it wants + writes its own custom skills (same API)
```

**Litmus test for "done":** `grep -rE '"(long_research|workspace_publish_candidate|
report-writing)"' src/runtime/` returns zero. The core bundle contains no skill code.
A host that imports nothing gets a working generic agent loop with no research concepts.

## Alternatives

1. **Do nothing.** Keep bundled-by-default. Rejected: contradicts the project's own
   stated general-runtime / no-hardcode goal and the engineer feedback.
2. **Half measure — opt-out flag + docs only.** Add an explicit "no bundled skills"
   switch and document `agentSkills: []`. Cheap, non-breaking, but leaves domain code
   in core and the kernel still enforcing research semantics. Good as Phase 0, not the
   end state.
3. **Full micro-kernel (this RFC).** Highest correctness, matches industry norm; cost is
   a phased breaking change + a migration package.

## Migration plan (phased, non-breaking first)

- **Phase 0 (non-breaking, ship now):** make opt-out a first-class, documented one-liner;
  README + types state the default and how to run with zero skills. Buys breathing room.
- **Phase 1 (extract, still default-on):** move bundled skill *definitions* (instructions
  + capabilities + tools) into a separate internal module / optional export; core imports
  them only through the plugin entry point. No behaviour change yet.
- **Phase 2 (extract enforcement):** move research enforcement files out of core behind
  the same plugin boundary; replace `LONG_RESEARCH_SKILL_IDS` with a generic capability;
  the kernel loses all domain literals. Behind a feature flag; keep tests green.
- **Phase 3 (flip default, major version):** default `agentSkills` to `[]`; publish the
  optional `@agrun/skills-*` packages + a one-line starter pack; deprecation window +
  codemod/migration note. This is the breaking release.

## Consequences

- **Pros:** true general runtime; smaller core; engineers decide their own skill surface;
  kernel has zero domain hardcode; cleaner mental model (kernel = mechanism, plugin =
  domain); aligns with stated project goal and industry norm.
- **Cons / costs:** multi-phase refactor across ~18 core files; a breaking major version
  at Phase 3; newcomer DX must be preserved via a starter pack; examples/tests that
  assume bundled skills must be updated.
- **Risks:** regressions while untangling enforcement from core (research convergence,
  publish gating, terminal repair are interlocked); scope creep. Mitigate with
  repro-first tests at each phase and a feature flag until Phase 3.

## Rollback

Each phase is independently revertible. Phase 0–2 keep default behaviour, so reverting is
a flag flip / import restore. Phase 3 (default → []) is the only breaking step; rollback =
restore the `config.js:47` default to `bundledAgentSkills` and re-export the bundle from
core. Keep the bundled skill definitions in version control regardless so they can be
re-vendored.

## Decisions (resolved by maintainer, 2026-06-07)

These were delegated to the implementer. All are reversible before the 2.0 cut; revisit
Q1/Q4 if real usage telemetry arrives.

1. **Package boundaries — split by coarse domain + an umbrella meta-pack.**
   Ship `@agrun/skills-research` (research / report / web-research / deep-research-writer /
   long-web-research) and `@agrun/skills-coder` (expert-coder); analysis folds into research
   for now. Also publish an umbrella `@agrun/skills` that re-exports everything for one-line
   onboarding. Rationale: a single monolithic pack would recreate the "you get everything"
   problem at the package layer; over-granular packs add npm/dependency friction. Coarse
   split + umbrella balances opt-in granularity with easy onboarding. Reversible (merge or
   split further before 1.0 of the packs).

2. **Breaking-change timing — yes, but Phase 3 is gated to agrun 2.0.**
   Ship P0–P2 in the current minor line (all non-breaking, default stays bundled). From a
   later minor, emit a runtime deprecation warning when `agentSkills` is unset. Flip the
   default to `[]` only at the 2.0 major. This commits to the direction while giving a real
   deprecation window; no surprise breakage.

3. **Starter-pack DX target — 2 lines.**
   A working report agent must cost one import + one config field:
   ```js
   import { createRuntime } from "agrun";
   import { starterPack } from "@agrun/skills";
   const rt = createRuntime({ agentSkills: starterPack });
   ```
   README leads with this so "batteries" are one import away — present, but now explicit and
   opt-in rather than silently default.

4. **Deprecation window — assume implicit dependence; use a full major-version cycle.**
   We have no telemetry on who relies on the bundled default, so default to the safe
   assumption that some hosts do. Therefore: never silently break — keep the bundled default
   working through the entire 1.x line with a deprecation warning, and only flip at 2.0 with a
   migration note (and a codemod if feasible). Revisit (shorten) only if telemetry/user survey
   shows negligible implicit dependence.

**Net effect:** the direction is accepted and the irreversible step is safely deferred. The
immediately actionable, zero-risk work is **Phase 0** (documented opt-out + a first-class
"run with no skills" switch + README/types stating the default), which can start now without
waiting on any of the above.
