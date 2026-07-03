# AGRUN-313 Micro-Kernel EPIC — Pre-Assessment (2026-06-12)

**Status:** ASSESSMENT ONLY — no code change in this PR. Same discipline as the
H10 pre-assessment ([terminal-repair-split-design-2026-06-12.md](./terminal-repair-split-design-2026-06-12.md)):
inventory current state, scope the remaining surface, name the breaking-change
and risk, propose a staged plan, and give an explicit ship-or-defer
recommendation. Every claim below was spot-verified against current `src/` (not
the `packages/*/dist` build artifacts).

The EPIC: *"micro-kernel — unify skills as opt-in plugins, remove default domain
opinion from core, flip default agentSkills=[]."* Two task rows remain `planned`:
`AGRUN-313` (the epic) and `AGRUN-313-P2F-2.0`.

---

## 1. What is ALREADY done (the headline goals shipped)

The visible, behavioral micro-kernel goals have **already landed** — a host that
wires nothing gets a generic agent loop with zero domain behavior:

| Goal | Evidence | Status |
|------|----------|--------|
| **Default `agentSkills` flipped to `[]`** | [config.js:73](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/config.js) `config.agentSkills == null ? [] : …` (AGRUN-313 P2f 2.0, BREAKING) | ✅ DONE |
| **Bundled skills out of core barrel** | [index.js:36-40](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/index.js) — `bundledAgentSkills`/`getBundledAgentSkill` moved to `@agrun/skills-research`; a generic `import "agrun"` pulls no skill/research code | ✅ DONE |
| **Bundled roles out of core barrel** | index.js:41-42 — `bundledAgentRoles`/`getBundledAgentRole` moved to the pack; core keeps only the `parseRoleMarkdown` mechanism | ✅ DONE |
| **Research BEHAVIOR out of core** | research-acceptance-evaluator + research-report-loop + evidence-graph **behavior** moved to `@agrun/skills-research`; core keeps only generic kernel-seam DATA shapes (`createResearchReportLoopState`, `normalizeResearchReportLoopConfig`) | ✅ DONE |
| **Kernel-seam hook removal (ADR-0054)** | [kernel-seam-removal-design.md](./kernel-seam-removal-design.md) — "COMPLETE (maintainer, 2026-06-09)", chunks A–D | ✅ DONE |
| **researchState starts null** | AGRUN-313-R2 — `state.js` initialises the slot null; readers are null-guarded | ✅ DONE |
| **`long_research` mode literals removed** | AGRUN-313-H2 — 0 `long_research` matches in the three core planner-prompt files | ✅ DONE |

Sub-tickets: **8 completed** (`P1-ESM-TREESHAKE`, `P2-3.0-STEPA/B`,
`ROLES-DEIMPORT`, `ROLES-PER-PACK`, `R1-CONVERGENCE-SEAM`, `R2-RESEARCHSTATE-NULL`,
`H2-REMOVE-LONG-RESEARCH-MODE`), **2 planned** (the epic + `P2F-2.0`).

Superseded design docs (do not re-plan from them): `micro-kernel-plugin-skills-rfc.md`
and `micro-kernel-dependency-inversion-design.md` are both marked superseded by
ADR-0054 / kernel-seam-removal; `micro-kernel-phase2-plan.md` is the P2a–P2d
record (shipped).

---

## 2. What REMAINS — and the critical reframing

The remaining surface is **domain machinery that is structurally in core but
behaviorally DORMANT for a generic agent**. This distinction is the crux:

- **It does not run for `agentSkills: []`.** terminal-repair, requirement-recovery,
  and the workspace/research evaluators are data-gated: `evaluateTerminalRepairState`
  derives `facts.activeDeficits` from research/workspace state
  (`researchReportLoop.gateSignal.acceptancePacket`, `requirementRecoveryEvaluator`,
  …). With no research/coder skill populating that state, `activeDeficits` is empty
  and repair never activates ([terminal-repair/core.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/terminal-repair/core.js)
  `evaluateTerminalRepairState`). So the generic agent already sees **no domain
  opinion at runtime** — the headline behavioral goal is met.

- **What's left is CODE LOCATION + prompt VOCABULARY, not a behavior flip.** The
  dormant machinery still ships in the core import graph, and the core planner
  prompt still speaks research vocabulary.

Concrete remaining surface in `src/runtime/`:

| Cluster | Size in core | Runs for `agentSkills:[]`? |
|---------|--------------|----------------------------|
| `terminal-repair/` | 6 files (just split in H10) | No — inert without deficit state |
| `research-*.js` | 9 files | No — inert without research state |
| `virtual-workspace*.js` (core + actions) | 2 files | No — workspace created but unused |
| `requirement-recovery-evaluator.js` | 1 file (~400 lines) | No — no deficits to recover |
| `candidate-quality-signal.js` / `final-readiness.js` | 2 files | No — publish-gate path unused |
| Core planner-prompt research vocabulary | ~88 "research" refs (84 in [planner-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js), 1+3 in base/native directives) | The prompt text renders; the concepts are inert |

The ~88 research references in the core planner prompt are the most visible
residual "domain opinion": even a generic agent's planner prompt carries research
framing. Whether each reference is (a) genuinely generic phrasing, (b) gated by a
skill/capability flag already, or (c) dead research vocabulary, is **unaudited**
and is the real first step (see Plan §4).

---

## 3. Breaking-change & risk surface

1. **terminal-repair is the highest-risk file in the runtime.** It was *just*
   split in H10 (AGRUN-502..508) and owns the escalation → `hard_veto` →
   `publishLoopEscapeGranted` churn-escape (AGRUN-307/309/310). Moving it to the
   opt-in package is a structural change to the same surface H10 deliberately
   touched mechanically-only. Doing it now, right after the split, compounds risk
   on the riskiest file for **zero runtime-behavior benefit** (it's already inert
   for the generic agent).

2. **Test surface.** ~130 of ~257 unit tests reference research/evidence/workspace/
   terminal-repair. Moving the machinery to the package means those tests must
   either move with it (into a `@agrun/skills-research` test suite) or explicitly
   wire the research skill in setup. That's a large, mechanical-but-error-prone
   migration with regression potential across the whole suite.

3. **"Inert" must be PROVEN per module before moving.** The safety precondition
   mirrors H10's: before relocating any cluster, prove it is truly unreachable for
   `agentSkills: []` (a characterization test that runs a generic agent and asserts
   the module never activates). Without that proof a move could silently drop a
   path some non-research flow depends on (the AGRUN-495 "is it really
   single-path?" lesson).

4. **Public API / import-path break.** Relocating modules that are still re-exported
   from the core barrel (the kernel-seam DATA shapes) is a 3.x breaking change for
   any host importing them directly — needs the same explicit migration note the
   `agentSkills` flip got.

---

## 4. Staged plan (IF pursued — same ladder discipline as H10)

Do **not** start with a code move. The ordered, low-risk path:

1. **Prompt-vocabulary audit (doc + small PRs, no relocation).** Triage the ~88
   core planner-prompt research references into {generic / already-gated / dead}.
   Remove the dead, gate the domain-specific behind the skill/capability flag they
   should already key on. This is the highest-value, lowest-risk step and it
   directly attacks "domain opinion in core" without touching the high-risk
   machinery. Pinned by prompt-snapshot tests (regenerate, word-diff verify).

2. **Inertness characterization tests (no relocation).** Add tests that run a
   generic `agentSkills: []` agent and assert terminal-repair / requirement-recovery
   / virtual-workspace never activate. These become the safety net for any later
   move AND independently document the dormancy claim in §2.

3. **Relocate the leaf research evaluators** (`research-*.js` that the package's
   behavior already shadows) behind the package boundary, one module per PR,
   barrel-compat preserved, suite green by exit code at each rung — exactly the H10
   ladder shape.

4. **terminal-repair / requirement-recovery LAST, and only if forced.** These are
   the highest-risk, just-split surfaces. Defer until a concrete need (a second
   non-research host that must ship without them) actually forces the cut. A
   no-benefit move on the riskiest file is poor risk/reward (the same reasoning
   that deferred H10 until it was user-directed).

---

## 5. Recommendation: **stay DEFERRED**

The micro-kernel's user-visible promise — *a generic runtime with zero domain
opinion by default* — is **already delivered** (`agentSkills: []` default, bundled
skills/roles/behavior out of core, kernel-seam removed). The remaining work is
code-location hygiene and prompt-vocabulary cleanup whose only benefit is a
smaller import graph and a cleaner core prompt — real, but modest — bought against
the runtime's highest-risk surface and a ~130-test migration, immediately after
H10 just rewrote that surface's file layout.

Recommended posture:
- **Pursue now (cheap, safe, high-signal):** Plan §4 step 1 (prompt-vocabulary
  audit) and step 2 (inertness characterization tests). Both are doc/test work
  with no relocation risk and they retire the most visible residual domain opinion.
- **Defer (expensive, risky, low runtime benefit):** §4 steps 3–4 (the actual
  module relocation), until a concrete second-host need forces it — then run it as
  an H10-style mechanical ladder with the inertness proofs from step 2 as the net.

This keeps `AGRUN-313` open as a tracked epic, converts `AGRUN-313-P2F-2.0` from
"flip + move everything" (largely done for the flip) to "vocabulary audit +
inertness proofs now, relocation when forced," and avoids a no-benefit churn on
terminal-repair days after stabilising it.
