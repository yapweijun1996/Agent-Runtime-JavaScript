# P2 design — actually drop research from the consumer bundle (`@agrun/skills-research`)

Status: **DESIGN DRAFT for maintainer review — no code, no version bump.** Follows the
spike (`package-split-skills-research-spike.md`) and P1 (merged PR #74, main `256768aea`).
P1 PROVED a generic consumer *can* tree-shake all research out of the ESM build. P2 is the
**breaking** step that makes a real npm consumer's bundle actually drop it: remove the
research re-exports from the core barrel and ship research as a separate installable package.

---

## 1. What P1 left, and why P2 is breaking

After P1, the core barrel `src/index.js` STILL re-exports research (5 edges):

| line | re-export | source | disposition in P2 |
|---|---|---|---|
| 37 | `bundledAgentSkills`, `getBundledAgentSkill` | `default-agent-skills.js` | **SPLIT** (mixed — see §3) |
| 40 | `bundledRuntimeHooks` | `bundled-runtime-hooks.js` | **MOVE** to pack |
| 53 | `buildResearchEvidenceGraph`, `createEmptyResearchEvidenceGraph`, `materializeEvidenceGraph` | `research-evidence-graph.js` | **MOVE** |
| 63 | `buildClaimEvidenceTable` | `research-report-loop.js` | **MOVE** |
| 80 | `evaluateResearchAcceptanceProgress`, `refreshResearchAcceptanceEvaluator` | `research-acceptance-evaluator.js` | **MOVE** |

STAYS in core (these are the GENERIC kernel seams, not research — already domain-data only):
`createResearchReportLoopState` + `normalizeResearchReportLoopConfig` (kernel-report-loop.js),
`createResearchAcceptanceEvaluatorState` + `summarizeResearchAcceptanceEvaluator`
(kernel-acceptance-evaluator.js). (Their names still carry "Research" vocab — a later cosmetic
rename, NOT P2; renaming is itself a separate breaking change, batch it with this one only if
we also do the §6 vocabulary pass.)

**Why breaking:** a consumer doing `import { bundledRuntimeHooks } from "agrun"` today (e.g.
the repo's own `test/concerns/planner.test.js` and `test/node-agrun-3000-live.mjs` via dist)
stops resolving once line 40 leaves the barrel. That is the 3.0 trigger.

---

## 2. Target shape

```
agrun                    (core)   — generic OODAE runtime + kernel hook seams (default no-op).
                                    src/index.js NO LONGER re-exports any research-*.js.
                                    `import 'agrun'` pulls ZERO research into the dep graph.
@agrun/skills-research   (opt-in) — research behavior (bundledRuntimeHooks, evidence-graph,
                                    report-loop + acceptance BEHAVIOR) + the 4 research SKILL.md
                                    + the researcher role. peerDependency on agrun.
```

Host usage after P2 (the endpoint of the hook pattern):
```js
import { createRuntime } from "agrun";
import { bundledAgentSkills, bundledRuntimeHooks } from "@agrun/skills-research";
const runtime = createRuntime({ agentSkills: bundledAgentSkills, ...bundledRuntimeHooks });
```
`src/research-index.js` (shipped in P1) is already exactly this entry surface — P2 builds and
publishes it, and removes the duplicate re-exports from core.

---

## 3. The blocker P1 did not face — `bundledAgentSkills` is MIXED

`bundledAgentSkills` is ONE generated `Object.freeze([...])` from `default-agent-skills.js`,
built by `generate-source-agent-bundles.cjs` scanning `skills/`. Today `skills/` holds:
`deep-research-writer`, `long-web-research`, `web-research`, `report-writing` (RESEARCH×4) +
`expert-coder` (CODER) + `worldtime_tz` (DEMO/util). So `bundledAgentSkills` is NOT a research
artifact — moving it wholesale to `@agrun/skills-research` would drag coder + worldtime along.

Three ways to resolve (maintainer picks — DECISION D2):
- **D2-a (recommended): per-pack bundle generation.** Teach `generate-source-agent-bundles.cjs`
  to emit one bundle per pack from a manifest (research→research bundle, coder→coder bundle).
  `@agrun/skills-research` ships the research subset; a future `@agrun/skills-coder` ships coder.
  Core ships NO bundled skills (default `agentSkills:[]` already holds since v2.0).
- **D2-b: research-only pack now, leave coder/worldtime in core's bundle for one more release.**
  Smaller change; core bundle still carries coder skill bytes (honest but partial).
- **D2-c: one `@agrun/skills-default` meta-pack** = all current bundled skills, plus a thin
  `@agrun/skills-research` that re-exports the research subset. Most back-compat-friendly
  (`bundledAgentSkills` keeps its current contents, just from a new package).

This decision drives the build-generator change and is the main reason P2 is bigger than P1.

---

## 4. Repo shape — two real options (DECISION D1)

### D1-a — single tree, second build output (smaller change)
Keep `0_development/` as-is. Add a second package directory `0_development/packages/skills-research/`
with its own `package.json` (`@agrun/skills-research`) whose build bundles `src/research-index.js`
(via the same Rollup, preserveModules) into its own `dist/`. Core `package.json` stays at repo
root. Publish two packages from one repo without npm workspaces (each `npm publish` run from its
own dir). `examples/*` keep importing `../../../../src/index.js` (source) — UNAFFECTED.
- ✅ Least disruption; examples + CI relative paths unchanged; one Rollup config grows one input.
- ❌ Two `package.json` not formally linked; manual publish discipline; `peerDependency` not
  enforced locally without a link step.

### D1-b — npm workspaces (cleanest, structural)
Reorg to `packages/agrun/` + `packages/skills-research/`, root `package.json` with
`"workspaces": [...]`. Core's package.json structurally CANNOT import the research package.
- ✅ Enforces the boundary; standard 2025 monorepo; `peerDependency` + local symlink for free.
- ❌ Moves the whole `src/` tree; repoints every `examples/*` import (`../../../../src/index.js`)
  and the test harness; bigger CI diff. Higher risk against the "keep runtime simple" rule.

**Recommendation: D1-a for the 3.0 ship** (minimal blast radius, examples untouched), with D1-b
noted as a later structural hardening if the two-package discipline proves fragile.

---

## 5. Build changes (concrete, under D1-a + D2-a)

1. `generate-source-agent-bundles.cjs` → emit per-pack skill/role bundles from a manifest
   (research bundle + coder bundle). Core no longer ships a default bundle file (or ships an
   empty one). [D2 decides scope.]
2. `rollup.config.js` → add a 3rd output (or a 2nd config) with input `src/research-index.js`
   → `packages/skills-research/dist/` (ESM, preserveModules, sideEffects-free). Core outputs
   (UMD + ESM) unchanged.
3. `packages/skills-research/package.json` → `{ name:"@agrun/skills-research", type:"module"
   semantics via exports, sideEffects:false, peerDependencies:{ agrun:"^3.0.0" },
   exports:{ ".":"./dist/index.js" } }`.
4. `src/index.js` → DELETE the 5 research re-export blocks (lines 37/40/53/63/80 surface).
   Keep the kernel-seam data re-exports (report-loop/acceptance data) — they are generic.
5. Repoint internal consumers of the moved symbols: `test/concerns/planner.test.js` +
   `test/node-agrun-3000-live.mjs` import `bundledRuntimeHooks`/`bundledAgentSkills` from the
   research package's source entry (`src/research-index.js`) instead of `dist/agrun.js`.
6. `package.json` (core) version → **3.0.0**; add a `CHANGELOG`/migration note.

---

## 6. Back-compat & migration

- **Breaking surface:** `bundledAgentSkills`, `getBundledAgentSkill`, `bundledRuntimeHooks`,
  evidence-graph/report-loop/acceptance BEHAVIOR exports no longer importable from `"agrun"`.
- **Migration note:** "research moved to `@agrun/skills-research`; replace
  `import { X } from "agrun"` with `import { X } from "@agrun/skills-research"` for those names."
- **Soft landing option (DECISION D3):** keep a deprecated thin re-export in `src/index.js`
  for ONE 3.x release that re-exports from the research package with a console.warn-on-import
  shim — BUT that reintroduces the import edge and defeats the bundle drop, so **recommend NOT**
  doing a shim; make 3.0 a clean cut and rely on the migration note. (A shim would make the
  measurement regress — the whole point is the edge is gone.)

---

## 7. Litmus (unchanged harness + one new assertion)

- `npm run check` (incl. prompt-snapshot byte-identical) green.
- `node build/measure-bundle.cjs` still PASS (now trivially — research isn't even in the barrel).
- NEW: a published-shape test — install/resolve `agrun` alone, assert `bundledRuntimeHooks` is
  `undefined` on the core entry (proves the cut), and assert it IS defined from
  `@agrun/skills-research`.
- live `openai` 4/4 + live `node-3000` exit 0 (research run now imports the pack) + browser +
  long-task-lab builds green.

---

## 8. Decisions this draft needs from you

1. **D1 repo shape:** D1-a single-tree-two-builds (recommended) vs D1-b workspaces.
2. **D2 pack granularity:** D2-a per-pack bundles (recommended) vs D2-b research-only-now vs
   D2-c skills-default meta-pack.
3. **D3 soft landing:** clean 3.0 cut (recommended) vs one-release deprecation shim.
4. **Version/timing:** is this THE 3.0 milestone, and do we cut it together with or after the
   DeepSeek provider work now on main?
5. **Vocabulary pass:** batch the kernel-seam "Research"-named export rename into 3.0, or keep
   names (no extra break) and defer the rename?

---

## 9. Honest scope — what P2 delivers vs not

DELIVERS: a generic `import 'agrun'` consumer's bundle contains ZERO research code (not just
"can tree-shake it" — it is not in the dependency graph at all); research becomes a true
installable opt-in; the boundary is structurally hard to re-cross.

DOES NOT: make core's SOURCE vocabulary-free (kernel-seam field names + the runState readers
stay — §6 cosmetic pass, separate); move the `research-state` gate predicate
(`isResearchQualityGateRequired`, 9 importers — its own host-hook change, dangerous-last);
de-import `research-thread-sync` (serialization/token, its own 2.0 concern).

---

## 10. IMPLEMENTED — 3.0 (2026-06-08)

Shipped on branch `feat/agrun-313-p2-package-split` as the 3.0 milestone. Decisions
taken: D1-a (single tree, second build), D2-a (per-pack bundles), D3 clean cut (no shim),
D4 ship as 3.0 now, D5 defer the kernel-seam rename.

**Result — three packages, one repo:**
- `agrun` (core, **3.0.0**) — `import 'agrun'` pulls ZERO research/bundled-skill code.
- `@agrun/skills-research` (3.0.0) — `bundledRuntimeHooks` + evidence-graph/report-loop/
  acceptance behavior + the 4 research skills (deep-research-writer, long-web-research,
  web-research, report-writing). Skills + hooks.
- `@agrun/skills-coder` (3.0.0) — `expert-coder` + `worldtime_tz`. Skills only, no hooks.

Per-pack bundles are generated by `build/generate-source-agent-bundles.cjs` from an
explicit `SKILL_PACKS` map (a skill assigned to no pack is a hard build error). The full
`agent-skills-bundle.js` is retained for capability/drift tests only — shipped in no pack.

**BREAKING — migration:**
```js
// 2.x
import { createRuntime, bundledAgentSkills, bundledRuntimeHooks } from "agrun";
// 3.0
import { createRuntime } from "agrun";
import { bundledAgentSkills, bundledRuntimeHooks } from "@agrun/skills-research";
// coder/worldtime skills:
import { bundledAgentSkills as coderSkills } from "@agrun/skills-coder";
```
Symbols no longer exported by `agrun`: `bundledAgentSkills`, `getBundledAgentSkill`,
`bundledRuntimeHooks`, `buildResearchEvidenceGraph`, `createEmptyResearchEvidenceGraph`,
`materializeEvidenceGraph`, `buildClaimEvidenceTable`, `evaluateResearchAcceptanceProgress`,
`refreshResearchAcceptanceEvaluator`. Core KEEPS `createRuntime`, `bundledAgentRoles`, and
the kernel-seam DATA (`createResearchReportLoopState`, `normalizeResearchReportLoopConfig`,
`createResearchAcceptanceEvaluatorState`, `summarizeResearchAcceptanceEvaluator`).

**Verification:** `build/measure-bundle.cjs` PASS (core research-free; per-pack separation:
research pack has research skill+code & no coder skill, coder pack has coder skill & no
research code); `test/unit/package-split-shape.test.js` PASS; `npm run check` green;
live `node-3000` exit 0 (research run wires `@agrun/skills-research`); live `openai` short.

**NOT done (follow-ups, unchanged from §9):** domain ROLES still in core (3 importers —
own de-import); `research-state` gate predicate (host-hook, dangerous-last);
`research-thread-sync`; the kernel-seam "Research" vocabulary rename (D5 deferred).
