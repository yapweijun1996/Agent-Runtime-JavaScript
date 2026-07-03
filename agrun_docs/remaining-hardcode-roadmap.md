# Remaining hardcode — panorama + phased removal roadmap

> **Superseded (2026-06-09):** the kernel-seam hook mechanism described here was removed — see ADR-0054 and kernel-seam-removal-design.md.

Status: **MEASUREMENT + DESIGN ONLY — no code.** Written after the 3.0 package split +
roles de-import + R1/R2 all merged. Answers the question "is all hardcode removed?" with
measured numbers and a phased plan. **Short answer: NO — the BUNDLE half is done, the
SOURCE half is largely not.**

---

## 1. The honest status — two independent "no-hardcode" layers

| layer | meaning | status |
|---|---|---|
| **Bundle** | a generic `import 'agrun'` does NOT pull research/skill/role code into the consumer's bundle | ✅ **DONE** (measure-bundle PASS; research not in the createRuntime dependency graph) |
| **Source** | core's `src/runtime/` source contains no research-domain files, action names, or vocabulary | ❌ **largely NOT done** (numbers below) |

The session removed the **bundle** hardcode (the big practical win: a generic consumer
ships zero research bytes). It did NOT remove the **source-level** domain machinery — the
"research-report application living in the kernel" (north-star LEVEL 3) is physically still
in `src/runtime/`.

---

## 2. Measured remaining hardcode (src/runtime, raw grep — incl. prompt-guidance text + comments)

### Domain action literals
| literal | count | note |
|---|---|---|
| `workspace_read` | 168 | virtual-workspace action surface |
| `workspace_publish_candidate` | 147 | the report-publish action |
| `workspace_write` | 129 | |
| `final_candidate` | 121 | the report artifact name |
| `workspace_finalize_candidate` | 53 | |
| `workspace_review_candidate` | 32 | |
| `long_research` | 14 | **the MODE concept (LEVEL 2)** |
| `candidate_quality` | 6 | |
| `evidence_convergence` | 5 | |

(Counts include action-descriptor guidance that ships in the model prompt + comments +
real code; the actual action-registration sites are fewer, but the application IS in core.)

### research-*.js files still physically in src/runtime (~5,400 lines)
| file | lines | core importers | bundle? |
|---|---|---|---|
| research-evidence-graph.js | 1264 | 2 | tree-shakes out |
| research-finalize-contract.js | 889 | 2 | tree-shakes out |
| research-report-loop.js | 641 | 6 | tree-shakes out |
| research-acceptance-evaluator.js | 588 | 5 | tree-shakes out |
| research-state.js | 583 | 6 | tree-shakes out |
| research-coverage-guard.js | 311 | 3 | (generic infra?) |
| research-source-authority.js | 247 | 1 | leaf |
| research-thread-sync.js | 216 | 1 | serialization |
| research-entity-resolution.js | 163 | 1 | leaf |
| research-domain-ownership.js | 97 | 2 | leaf |
| research-activation-token.js | 21 | 4 | the legacy mode flag |

KEY: these tree-shake OUT of a generic consumer's bundle (bundle layer = done) but the
FILES physically sit in `src/runtime/` (source layer = not done). `ls src/runtime/research-*`
and `grep research src/runtime` both still light up.

### virtual-workspace machinery
`src/runtime/actions/virtual-workspace-actions.js` = **2,294 lines** — the whole
write→finalize→review→publish candidate workflow. This is the core of the report-writing
application; the `workspace_*` literals above mostly live here.

### Domain vocabulary in readers
`runState.researchState` reads: 125 · `runState.researchReportLoop` reads: 195. The §6
field-name residue across ~20 core files.

---

## 3. Classification — what is GENUINE domain vs generic-infra-mislabeled

From the stub-arbiter triage (micro-kernel-dependency-inversion-design.md):

- **GENERIC infra mislabeled "research" → STAYS in core** (renaming is cosmetic): the
  evidence-convergence predicate (already relocated, R1), `research-coverage-guard`,
  evidence-state/pack/policy, terminal-repair, candidate-quality-signal,
  workspace-candidate-lifecycle. These are general long-form-output mechanisms.
- **GENUINE research application → should leave core source**: research-evidence-graph,
  research-finalize-contract, research-report-loop (behavior), research-acceptance-evaluator
  (behavior), + leaves (source-authority, domain-ownership, entity-resolution). Already
  bundle-de-imported (behind hooks); the FILES still live in core.
- **The virtual-workspace application** (workspace_publish_candidate etc.): the north-star
  position is this is a report-writing APPLICATION, not kernel — but "publish a long-form
  candidate with readiness" is arguably generic long-output infra. **This is the open
  architectural question that gates the biggest phase (§4 H4).**

---

## 4. Phased roadmap (effort × risk; each independently litmus + live verifiable)

### H1 — finish the cheap relocations/renames (LOW risk, mostly cosmetic)
- `refreshResearchState` (the populator) → a `researchStateHooks.refresh` hook (default
  no-op; research pack supplies it), like `reportLoopHooks.refreshGate`. Removes research-state.js
  from core hot-path imports. Slot-absent arbiter already GREEN, so low-risk.
- R-a renames at a breaking bump: `isResearchQualityGateRequired`→`isQualityGateRequired`,
  `research-state.js`→`convergence-state.js`, etc. Pure vocabulary; shrinks the grep.
- **Effect:** shrinks the research-named grep; does NOT move the heavy files yet.

### H2 — remove the "long_research" MODE concept (MEDIUM risk — north-star LEVEL 2)
The kernel still knows a mode literally called `long_research` (14 refs) + the
`researchActivation` token (research-activation-token.js). Replace the MODE with the
already-generic capability (`requiresEvidenceConvergence`) end-to-end, and migrate the
legacy activation token out (this intersects the 2.0 serialization change,
research-thread-sync). After H2 the kernel knows no "long research" mode by name.

### H3 — physically MOVE the research behavior files to the pack (LARGE — structural)
The ~5,400 lines of research-*.js are bundle-de-imported but physically in `src/runtime/`.
To make `grep research src/runtime` actually return ~0, the files must MOVE to
`packages/skills-research/src/` and the pack build owns them. This needs the **D1-b
workspaces** repo shape (deferred in the 3.0 spike) OR a source relocation + the pack
importing from a shared internal path. Big, mostly-mechanical, but touches the build + the
hook wiring (core's kernel seams must not import the moved files — they already don't reach
them in the bundle, so it's tractable).

### H4 — extract the virtual-workspace / candidate-publish APPLICATION (LARGEST — LEVEL 3)

> **RESOLVED + DOWNGRADED (2026-06-14, ADR-0056).** The §3 open question
> ("workspace = generic vs application") is closed: a code-level fact-check proved
> **virtual-workspace is GENERAL INFRASTRUCTURE — it stays in core.** The edit primitives
> are domain-agnostic (the design doc itself: *"generic edit primitive, not a report-specific
> fixer"*); both the coder and research packs register against them. The only research
> coupling (`sourceMinimum`/evidence in `publish-readiness.js`) is **already data-gated** —
> `readPublishSourceMinimum` returns null and `researchGateBlocked` is false when no research
> state is present, so a coder/generic agent experiences the workspace as pure generic infra.
> **Do NOT extract the workspace surface out of core** — that would remove generic
> infrastructure and regress non-research agents. H4 is downgraded to **H1-class naming
> cleanup** (residual optional items in ADR-0056: name the data-gated research read as a
> capability seam; make the `final_candidate.md` default config-driven). The original
> "extract the application" framing below was based on the now-falsified premise.

~~The 2,294-line virtual-workspace-actions.js + the `workspace_*` action surface is the
report-writing application. The north-star end state: the OODAE loop + a capability-gated
action surface that knows NO domain action names stay in core; the workspace actions become
an opt-in action pack registered via `customAction`/`defineAction`. This is the deepest,
highest-risk phase and needs its own design spike (is workspace-publish generic long-output
infra, or a research application? — §3 open question decides the boundary).~~

---

## 5. Honest recommendation

The **bundle** win (done) is the 80/20: a generic consumer already ships zero research
code. The **source** purge (H3/H4) is a large, multi-step effort whose practical payoff is
mostly "the source tree / grep is clean" — the consumer's bundle is already clean regardless.

Suggested order by value/risk: **H1** (cheap, shrinks the grep) → **H2** (kills the LEVEL 2
mode concept, real architectural value) → then DECIDE whether H3 (the heavy structural
source move) is worth it, or whether "bundle-clean + source has labeled-but-tree-shakeable
research" is an acceptable resting point.

> **Update (2026-06-14):** **H2 is DONE**; **H4 is RESOLVED + downgraded to H1-class**
> (ADR-0056 — workspace is general infra, stays in core). The only structural phase left is
> **H3** (physically moving the `research-*.js` files), whose practical payoff is "the source
> grep is clean" — the consumer bundle is already clean. Recommended resting point:
> **bundle-clean (done) + source has labeled, tree-shakeable, data-gated research** is
> acceptable; pursue H3 only if a clean source grep becomes a hard requirement.

**Do NOT claim "all hardcode removed"** until at least H2 lands and the litmus
`grep -rE '"(long_research|workspace_publish_candidate)"' src/runtime` returns 0.

---

## H2 — DONE (4.0.0, breaking): the `long_research` MODE concept removed

The kernel no longer knows a "long research" mode by name. Evidence-convergence activation
is now SOLELY capability-driven: a skill declares `requiresEvidenceConvergence` (ships in
@agrun/skills-research); engaging the skill (its capability rides on
`agentSkillContext.activeSkill`/`lastReadSkill`) activates the generic long-running
convergence support. `grep long_research src/runtime` → 0.

Removed end-to-end (BREAKING): the `researchActivation: "long_research"` request INPUT +
its provider validation (provider.js / src/skills/providers/request.js), the runState
setter (action-loop-session.js), the persisted/rehydrated field
(research-thread-sync.js — a serialization break for threads persisted < 4.0), the
provider-timeout mode read, the convergence read, and `research-activation-token.js`
(deleted). Both research SKILL.md files dropped the "declare `mode: long_research`"
instruction (the skill activates by being engaged).

> **Superseded by AGRUN-522:** the `@agrun/skills-*` ESM packages referenced below were
> later removed. The research/coder skills now ship as in-tree DATA
> (`src/runtime/default-research-skills.js` / `default-coder-skills.js`), so wherever the
> migration steps say "install `@agrun/skills-research`", import that DATA module instead.

**MIGRATION (3.x → 4.0):**
- A host that passed `researchActivation: "long_research"` in the request: REMOVE it. To
  run a research/long-convergence workflow, supply the in-tree research skills DATA
  (`src/runtime/default-research-skills.js`) and let the agent engage the skill
  (`use_agent_skill`) — its `requiresEvidenceConvergence` capability activates the gate. No mode flag.
- Persisted threads from < 4.0 carrying `researchActivation` lose that field on rehydrate
  (it is no longer read; the run re-derives convergence from the engaged skill capability).
- Version: core `agrun` + `@agrun/skills-research` + `@agrun/skills-coder` → 4.0.0
  (peerDependency `agrun: ^4.0.0`). (3.0 was unpublished, so these may be renumbered before
  the first npm publish.)

Verification: `npm run check` EXIT 0 (prompt-snapshot byte-identical — the mode line was
not in the model prompt); `measure-bundle` PASS; live `node-3000` EXIT 0 (research
activates via capability seed, gate refreshed 21×, decision=limited). LEVEL 2 of the
north-star is now cleared. (H3/H4 — physically moving research files + the virtual-workspace
application — remain.)
