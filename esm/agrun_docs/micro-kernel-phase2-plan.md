# AGRUN-313 Phase 2 — Repro-First Implementation Plan

**Status:** IN PROGRESS — P2a–P2d shipped (commits b6630eba, 158a667f, 72aa2603, 3854ef42).
P2e next; P2f deferred to 2.0. Companion to
[micro-kernel-plugin-skills-rfc.md](./micro-kernel-plugin-skills-rfc.md).
**Date:** 2026-06-07. P0 + P1 done and pushed; P2a-P2d done.

## Goal

Remove ALL domain vocabulary from the kernel so a host importing zero skills gets
a generic OODAE loop with no research concepts — WITHOUT reopening the live-gap
bugs (AGRUN-299/300/301/307) baked into the publish / research / terminal-repair
interlock.

- **L1** — replace the hardcoded name list `LONG_RESEARCH_SKILL_IDS`
  (`research-state.js:6`) with a generic capability the kernel reads.
- **L2** — remove the `long_research` MODE CONCEPT from the kernel entirely; the
  kernel must define/enforce no named domain mode.
- **L3** — move the research ENFORCEMENT machinery (~18 files) out of core behind
  a plugin boundary.

**Litmus for done:** `grep -rE '"(long_research|workspace_publish_candidate)"' src/runtime/`
returns zero, and a no-skills host gets a working generic loop.

## 0. The load-bearing correction (read first)

There are **TWO distinct capabilities at this seam, not one** — conflating them
ships a silent convergence regression green:

| Signal | Exists? | Gates | Declared by |
|---|---|---|---|
| `requiresPublishReadiness` | YES (generic, `agent-skills.js:439` `normalizeCapabilities`) | ONLY the `workspace_publish_candidate` terminal (`planner-action-surface.js:128` `isPublishReadinessSkillActive`) | deep-research-writer, long-web-research, **report-writing** |
| `LONG_RESEARCH_SKILL_IDS` (`research-state.js:6`) | YES (hardcoded list — the L1 target) | the ENTIRE evidence-gap / convergence / acceptance stack (~18 files) via `isLongResearchRun()` → `refreshResearchState` | deep-research-writer, long-web-research |

`report-writing` is **deliberately** in the first set but NOT the second
(`planner-action-surface.js:30-32` comment: `requiresPublishReadiness` covers
publish WITHOUT activating the web-research evidence gate).

**Implication:** L1 must NOT map `LONG_RESEARCH_SKILL_IDS` onto
`requiresPublishReadiness` — that silently gives `report-writing` the evidence
gate → convergence regression. L1 introduces a SECOND new domain-neutral
capability (working name `requiresEvidenceConvergence`) declared by exactly
`{deep-research-writer, long-web-research}`.

The minimal kernel seam is therefore **exactly these two boolean capabilities** —
NOT a mode registry or capability bus. Larger abstraction = over-engineering.

## 1. Repro / baseline harness (capture BEFORE touching anything)

**Guardrail unit tests (must stay green):**
- `planner-action-surface.test.js` — primary publish-gate guardrail (line 507
  positive: report-writing exposes publish; 744-757 AGRUN-305 ready-promotion).
- `research-state.test.js` — `qualityGateRequired` activation (67-72 ON, 102/118/133 OFF).
- `gated-publish-convergence.test.js` — AGRUN-299/300 convergence.
- `terminal-repair-state.test.js`, `terminal-repair-ghost-event.test.js`,
  `terminal-repair-thresholds.test.mjs` — interlock #3.
- `research-acceptance-evaluator.test.js`, `research-report-loop.test.js`,
  `x2-research-phase-contract.test.js` — convergence/acceptance (interlock #1).
- `research-thread-sync.test.js` — `mode:"long_research"` normalization (L2 path).
- `skill-capabilities.test.js` — capability normalization (mechanism L1 builds on).

**THE BASELINE GAP — add a characterization test as step zero (P2a).**
No test asserts the NEGATIVE: a `report-writing` skill active
(requiresPublishReadiness=true, NOT a research skill) leaves
`qualityGateRequired=false`. All current `=false` cases use no-skill runStates.
This is the hole the conflation regression ships through. P2a closes it.

**Behavioral baseline:** record a green unit run before any change. Live anchor:
`test:live:publish-gate` (locks the verified n=3 A/B: long_research eliminates
`workspace_publish_candidate_gated` churn). `npm run dist:check` must regenerate
`agent-skills-bundle.js` consistently after any SKILL.md capability edit.

## 2. Classification of the 12 `long_research` literal sites

| File:line | Type | L | Disposition |
|---|---|---|---|
| `research-state.js:6` (`LONG_RESEARCH_SKILL_IDS`) | name list | L1 | MOVE → capability |
| `research-state.js:460` (`=== "long_research"`) | string literal | L2 | MOVE |
| `research-state.js:39` (`"not_long_research"` reason) | diagnostic | L2 | rename generic |
| `provider.js:220` (validation must be `"long_research"`) | enforcement | L2 | MOVE — kernel must not validate a mode name |
| `provider-timeout.js:71` (`=== "long_research"`) | literal | L2/L3 | MOVE behind plugin signal |
| `planner-prompt.js:885` (`=== "long_research"` + name compares) | literal | L2 | MOVE → capability |
| `research-thread-sync.js:194` (`mode` → `"long_research"`) | normalization | L2 | MOVE — where `mode:"long_research"` is born |
| `requirement-recovery-evaluator.js:710` (`!== "not_long_research"`) | literal | L2 | rename generic |
| `action-loop-session-loop.js:356` (`reason: "mode_gate_not_long_research"`) | diagnostic | L3 | rename generic |
| `action-loop-action.js:1400,1467` (`long_research_*_block` kinds) | diagnostic | L3 | MOVE behind plugin |
| `config.js:139`, `planner-action-surface.js:16-27` | comments | — | reword, no behavior |

## 3. The seam (the ONE minimal mechanism the kernel keeps)

Two domain-neutral boolean capabilities read via the existing
`normalizeCapabilities` path. The kernel knows the capability names (generic verbs)
but ZERO skill names and ZERO mode names:

1. `requiresPublishReadiness` (exists) → expose the publish-direct terminal.
   Consumer: `isPublishReadinessSkillActive`.
2. `requiresEvidenceConvergence` (NEW) → output must pass an evidence/convergence
   gate before terminal. Consumer: a renamed capability-reading `isLongResearchRun`
   (→ `isEvidenceConvergenceRun`).

`report-writing` declares only #1 — preserving today's deliberate behavior. The
host `researchActivation`/`mode` string becomes a plugin-owned activation that
SETS these bits; the kernel never compares against `"long_research"`.

**Over-abstraction flags:** no capability registry, no mode-plugin bus, no generic
"enforcement subsystem" interface for two booleans.

## 4. Staged sub-steps (each independently shippable + test-green)

Feature flag: gate the mode-concept-removal behind a `config.js` switch (reuse the
`publishCandidateGate` normalization shape) so literal-removal lands dark, flips
atomically. L1 capability swaps are behavior-identical, no flag needed.

- **P2a — Characterization ✅ DONE (commit b6630eba).** Added missing negative test
  (report-writing → `qualityGateRequired=false`) + explicit positive
  (deep-research-writer → true). Guardrail: `research-state.test.js` + full
  `npm test` green.
- **P2b — Introduce `requiresEvidenceConvergence` ✅ DONE (commit 158a667f).** Added to
  `skills/deep-research-writer/SKILL.md` + `skills/long-web-research/SKILL.md`
  (NOT report-writing). `isLongResearchRun` reads capability. Behavior-identical.
- **P2c — Remove the name list ✅ DONE (commit 72aa2603).** Deleted `LONG_RESEARCH_SKILL_IDS`;
  `isLongResearchRun` reads only capability. Litmus:
  `grep deep-research-writer src/runtime/research-state.js` → zero.
  ⚠️ BREAKAGE: `planner-action-surface.test.js:497` — test fixture needs
  `capabilities: { requiresEvidenceConvergence: true }` to match new behavior (P2d follow-up).
- **P2d — Rename kernel fn/diagnostics off "research" ✅ DONE (commit 3854ef42).**
  `isLongResearchRun` → `isEvidenceConvergenceRun`; diagnostic reason strings →
  generic. Pure rename behind the new vocabulary.
- **P2e — Remove the `"long_research"` STRING-LITERAL mode path (L2 core).**
  Replace the literal compares (research-state.js:460, provider.js:220,
  research-thread-sync.js:194, provider-timeout.js:71, planner-prompt.js:885) with
  capability-bit reads; the plugin maps the host string → bits at the boundary.
  Flag-gated. Litmus: `grep '"long_research"' src/runtime/` → zero.
- **P2f — Move enforcement files behind the plugin boundary (L3).** Relocate the
  ~18 research files + 184 `workspace_publish_candidate` refs out of core; kernel
  keeps only generic hooks. Largest diff, do last, cluster-by-cluster, each proven
  by its own test. Final litmus + no-skills clean loop.

## 5. Honest risk callouts

- **Most dangerous edit:** P2b/P2c — the `isLongResearchRun` activation set
  (`research-state.js:457-467`). If the new capability lands on `report-writing`
  or the OR widens the set, `report-writing` silently gains the evidence gate →
  the forbidden convergence regression. P2a is the ONLY catch. Treat the set
  `{deep-research-writer, long-web-research}` as a frozen invariant.
- **Second:** `planner-action-surface.js:153` `shouldConstrainToReadyWorkspacePublish`
  (AGRUN-305 ready-promotion) depends on publish protocol fields; any L3 move risks
  reopening AGRUN-305. Keep `planner-action-surface.test.js:744` green every step.
- **Third:** `provider.js:220` throws on any `researchActivation` != `"long_research"`.
  Removing the literal changes a validation contract — the flag must preserve
  back-compat at the boundary during migration.
- **Terminal-repair coupling:** `shouldHideWorkspacePublishCandidateForMode` defers
  to `terminalRepair.active` (`planner-action-surface.js:122`). Do not reorder these
  predicates or AGRUN-301/307 reopen.

## 6. Current state (2026-06-07)

P2a–P2d shipped and pushed. Next: P2e (mode-string-literal removal — the core
kernel logic becomes name-free). P2f deferred to 2.0 per the P2e+P2f merged plan
below.

**Immediate action needed:** Fix `planner-action-surface.test.js:497` — the test
fixture passes `activeSkill: { skillId: "deep-research-writer" }` without the
`requiresEvidenceConvergence` capability, which no longer activates the gate after
P2c. Add `capabilities: { requiresEvidenceConvergence: true }` to the fixture.

## 7. Recommended next sub-step

**P2e-1** — establish the translation seam (additive, no deletion). At the session
seam, co-populate the capability when `researchActivation:"long_research"` is set.
Read-only spike first: verify whether `action-pattern-convergence.test.js`'s 20+
direct assignments flow through the seam or bypass it.

---

## P2e + P2f merged plan (added 2026-06-07, after P2a–P2d shipped)

P2a–P2d are done and pushed. This section plans the final two stages together
because they are coupled: P2e's "map host activation string → capability bit"
needs the boundary P2f's plugin extraction defines.

### Decision (load-bearing): P2f is a 2.0 step, not 1.x. STOP P2 at the boundary.

`runState.researchActivation = "long_research"` is not just a host input string —
it is an **internal runState protocol value**: 20+ tests set it directly
(`action-pattern-convergence.test.js`), thread-sync persists and re-hydrates it
(`research-thread-sync.test.js`), and `provider-request.test.js` locks the string.
Hosts that snapshot/restore runState (the documented thread-resume feature) have
this token baked into persisted state. Therefore:

- **Ship P2e in 1.x (non-breaking):** make the kernel's branching logic name-free —
  it no longer *reads* the `"long_research"` literal to make decisions; it reads the
  `requiresEvidenceConvergence` capability. The literal is translated to a capability
  at one ingress seam.
- **Defer P2f to 2.0:** the physical move of ~18 enforcement files + 184
  `workspace_publish_candidate` refs, AND the default-flip, are a serialization-format
  + behavior break. Moving the machinery in a patch release also risks reopening
  AGRUN-299/300/301/307. The plugin boundary is *designed* now; the extraction ships
  behind the major with a migration guide for the persisted `researchActivation` token.

This matches the RFC Q2 decision (default flip at 2.0).

### The ONE seam

`action-loop-session.js:99-102` (`readResearchActivation` helper at 186-191) is the
single ingress where `request.researchActivation` (host input) becomes
`runState.researchActivation`. This is the translation point: map the legacy string
to the capability channel `isEvidenceConvergenceRun` already reads. Minimal — a
1:1 string→capability translation, NOT a registry/mapper (one legal string, one
capability; a map would be speculative generality).

### provider.js:217-222 — keep as-is (back-compat anchor)

It validates the host request envelope (throws on non-`"long_research"`). Keep it
byte-identical; it is the public string-level contract. The kernel becomes name-free
by translating at the session seam, NOT by changing what the provider accepts.
Decouples the two concerns: provider guards the string, kernel reads capability.

### Staged sub-steps (P2e only; P2f deferred to 2.0)

- **P2e-1** — establish the translation seam (additive, no deletion). At the session
  seam, co-populate the capability when `researchActivation:"long_research"` is set, so
  `isEvidenceConvergenceRun` returns true from capability alone. Keep the literal stamp.
  Guardrail: all `action-pattern-convergence.test.js` cases green.
- **P2e-2** — switch the live branches (research-state.js:466 already done via capability,
  provider-timeout.js:71, planner-prompt.js:885) to read capability instead of the literal.
  Behavior-identical after P2e-1.
- **P2e-3** — collapse the C-category name lists: planner-prompt.js:888 (second L1 remnant,
  same capability fix as P2c) + research-thread-sync.js:194. Verify no import cycle before
  importing the capability predicate into planner-prompt; duplicate the tiny predicate or
  extract a shared leaf module if needed.
- **P2e-4** — rename the D-category diagnostic strings (`not_long_research`,
  `mode_gate_not_long_research`, `long_research_*_block`) to generic equivalents AND update
  their consumers in the same commit (e.g. requirement-recovery-evaluator.js:710 string-matches
  `"not_long_research"`). Highest silent-breakage risk: finalReason strings matched by value
  across files.
- **P2e-DONE:** kernel branching logic is name-free; only provider.js:220 (contract) and the
  `runState.researchActivation` token value itself remain — both intentionally retained for
  1.x back-compat. Litmus: no kernel *decision* reads the `"long_research"` literal.

### P2f (2.0 milestone — designed, not executed in 1.x)

Move enforcement behind the plugin boundary, cluster order safest→most dangerous:
(1) leaf evidence files (evidence-pack/state, candidate-quality-signal, entity-resolution);
(2) mid-tier evaluators (acceptance, coverage, source-authority, evidence-graph);
(3) gate-coupled LAST (finalize-contract, report-loop, workspace-candidate-lifecycle,
terminal-repair-*, thread-sync). **The publish-candidate gate predicate
(`shouldHideWorkspacePublishCandidateForMode`, planner-action-surface.js:106-124) STAYS in
core as a hook** — it is where AGRUN-299/300/301/307 + AGRUN-305 + terminal-repair all
intersect; the plugin declares capabilities, it does NOT own the gate predicate. The
single most dangerous move is anything touching that gate's predicate ordering.

### Recommended next step: a read-only SPIKE before P2e-1

Verify whether `action-pattern-convergence.test.js`'s 20+ direct
`runState.researchActivation="long_research"` assignments flow THROUGH the
`action-loop-session.js` seam or BYPASS it. This determines the P2e-2 design:
- through the seam → translation lives in the seam function, P2e-2 is clean.
- bypass (set the field directly) → the capability must be co-populated by a setter on
  the field itself, or `isEvidenceConvergenceRun` must keep honoring the raw literal as a
  back-compat read. Read-only, reversible, resolves the highest-uncertainty risk.
