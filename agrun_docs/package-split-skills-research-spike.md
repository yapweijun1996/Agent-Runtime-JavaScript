# Package-split design spike — `@agrun/skills-research` (AGRUN-313 2.x)

Status: **SPIKE / PROPOSAL for review** — design only, NO build or code change in this
doc. Relates to: AGRUN-313 (epic), the micro-kernel dependency-inversion work
(`micro-kernel-dependency-inversion-design.md`).

Goal of this spike: define HOW to split agrun into a generic core + an opt-in
research package, so that **"wire nothing ⇒ generic agent loop, and research is not
in the core bundle"** — the打包 (bundle) half of the no-hardcode / general-runtime
goal. The maintainer reviews this before any build work begins.

---

## 1. Why this is the last missing piece

"No hardcode / general runtime" has TWO layers:

| Layer | Means | Status |
|---|---|---|
| **Behavior** | `agentSkills:[]` default ⇒ generic loop, zero research concepts at runtime | ✅ shipped v2.0.0 |
| **Bundle** | research code physically NOT in the core bundle (tree-shaken / separate package) | ❌ this spike |

The per-edge hook inversions (2.1) + the first full de-import (2.2) removed research
from core's **hot paths** (`grep research-finalize-contract / research-acceptance-evaluator
src/runtime` now shows only the pack module + research-internal callers). **But the
bundle still contains research**, for two concrete reasons proven below.

---

## 2. The two concrete blockers (evidence)

### Blocker A — the public barrel `src/index.js` still imports research

```
src/index.js:
  export { bundledAgentSkills, ... }      from "./runtime/default-agent-skills.js";   // research+coder skills
  export { bundledRuntimeHooks }          from "./runtime/bundled-runtime-hooks.js";  // imports research-finalize/report/acceptance
  export { ... }                          from "./runtime/research-evidence-graph.js";
  export { ... }                          from "./runtime/research-report-loop.js";
  export { ... }                          from "./runtime/research-acceptance-evaluator.js"; // behavior half
```

Any consumer doing `import 'agrun'` follows the barrel and pulls every research file
into their build. Removing hot-path **calls** does not change this — the **barrel
re-export** is the import edge that keeps research in the bundle.

### Blocker B — the packaging format is not tree-shakeable

Current `package.json` (the whole of it): `{ name:"agrun", version:"2.0.0", main:"dist/agrun.js" }`.
- **No `exports` map, no `module` field, no `type:"module"`, no `sideEffects` flag.**
- Build = Rollup, single input `src/index.js` → single **UMD** `dist/agrun.js`
  (`format:"umd", name:"Agrun"`), via `build:lib` (`generate-source-agent-bundles.cjs && rollup -c`).

UMD + no `sideEffects:false` ⇒ **bundlers cannot tree-shake agrun at all**. Even if the
barrel were conditional, a UMD blob is opaque to dead-code elimination. So the split
is not only a file-boundary change — it is a **packaging-format change**.

> Net: research leaves the core bundle only when (A) the core barrel stops importing
> research AND (B) research ships as a separately-importable, tree-shakeable unit.

---

## 3. Target architecture

Two published packages (monorepo or two `package.json`s under one repo):

```
agrun            (core)            — generic OODAE runtime, kernel hook seams (default no-op),
                                     ZERO import of any research-* orchestration file.
@agrun/skills-research (opt-in)    — research behaviors + research SKILL.md/role md +
                                     bundledRuntimeHooks + bundledAgentSkills(research subset).
```

Host usage after the split:

```js
// generic agent — installs only core, research bytes never enter the build
import { createRuntime } from "agrun";
const runtime = createRuntime({ /* no skills */ });

// research agent — opt in to the separate package
import { createRuntime } from "agrun";
import { bundledAgentSkills, bundledRuntimeHooks } from "@agrun/skills-research";
const runtime = createRuntime({ agentSkills: bundledAgentSkills, ...bundledRuntimeHooks });
```

This is the publishDirect / hook pattern taken to its endpoint: core defines the
generic extension points (the `kernel-*.js` hook seams already shipped); the research
package fills them; a host that imports only `agrun` gets a clean loop and the research
files are **not in its dependency graph at all**.

---

## 4. Inventory — what moves vs what stays

Driven by the COMPLETE triage map (see dependency-inversion doc). 193 runtime files;
11 `research-*`, 3 `evidence-*`.

### MOVES to `@agrun/skills-research`
- **Research orchestration behavior** (the heavy logic, already hook-inverted in core):
  `research-finalize-contract`, `research-report-loop` (behavior), `research-acceptance-evaluator`
  (behavior), `research-evidence-graph` (+ leaves `research-source-authority`,
  `research-domain-ownership`, `research-entity-resolution`).
- **The pack wiring**: `bundled-runtime-hooks.js` (the `bundledRuntimeHooks` object).
- **Research SKILL.md + roles**: `skills/{deep-research-writer,long-web-research,web-research,report-writing}`,
  `roles/researcher`. (Coder pack: `skills/expert-coder`, `roles/coder` — a SECOND opt-in
  pack `@agrun/skills-coder`, or a shared `@agrun/skills-default`; decide in §9.)
- **The research half of the public API** currently re-exported from `src/index.js`.

### STAYS in core `agrun`
- The OODAE loop, planner, terminal/result projection, action surface.
- **The kernel hook seams** (default no-op): `kernel-finalize-contract.js`,
  `kernel-report-loop.js`, `kernel-acceptance-evaluator.js`, `kernel-terminal-actions.js`.
- **Generic infra mislabeled "research"** (proven by the stub-arbiter): `evidence-state`,
  `evidence-pack`, `evidence-policy`, `research-coverage-guard`, `terminal-repair-*`,
  `workspace-candidate-lifecycle`, `candidate-quality-signal`, `search-research-context`.
- **The pure-data plumbing already relocated in 2.2**: the acceptance-evaluator empty-slot
  shape + summarizer now live in `kernel-acceptance-evaluator.js`. The same treatment is
  the prerequisite for report-loop (see §6).

---

## 5. Build redesign (the crux — this is what makes the bundle drop research)

Three viable options, in increasing order of correctness and effort:

### Option B1 — keep UMD, build a SECOND bundle
Add a second Rollup output: input `src/research-index.js` (a new barrel that imports only
the research files) → `dist/agrun-skills-research.js`. Core barrel `src/index.js` stops
re-exporting research. Publish two files.
- ✅ Smallest build change; no ESM migration.
- ❌ Still UMD (not tree-shakeable within each bundle); two global UMD names; clunky for
  modern bundler consumers. A stop-gap, not the real answer.

### Option B2 — ESM + `exports` map + `sideEffects:false` (RECOMMENDED direction)
Migrate the published artifact to ESM with a proper `package.json`:
```jsonc
// agrun (core)
{ "name":"agrun", "type":"module", "sideEffects":false,
  "exports": { ".": { "import":"./dist/agrun.mjs", "require":"./dist/agrun.cjs" } } }
// @agrun/skills-research
{ "name":"@agrun/skills-research", "type":"module", "sideEffects":false,
  "peerDependencies": { "agrun": "^3.0.0" },
  "exports": { ".": "./dist/index.mjs" } }
```
- ✅ Real tree-shaking; clean dual-package; the standard 2025 shape.
- ❌ Biggest change: dual CJS/ESM output, `sideEffects:false` requires auditing that no
  module relies on import-time side effects (the skill/role **generated bundles** +
  the build-id transform are the suspects — verify). Browser example + tests import
  `../../../../src/index.js` directly (source), so they're unaffected by the dist format,
  but the published-package smoke tests change.

### Option B3 — monorepo workspaces (npm/pnpm workspaces)
Physically split into `packages/agrun` + `packages/skills-research`, each its own build.
- ✅ Cleanest long-term; enforces the boundary structurally (core's package.json cannot
  depend on the research package).
- ❌ Repo reorg (the current single `0_development` tree → packages/*); CI + the
  `examples/*` relative imports (`../../../../src/index.js`) must be repointed.

**Recommendation:** target **B2** (ESM + exports + sideEffects) as the format, and decide
B3 (workspaces) vs single-repo-two-builds as a separate call. B1 only if a fast
intermediate ship is needed.

> KEY BUILD FACT to resolve first: does anything in core rely on **import-time side
> effects**? `sideEffects:false` is a lie if it does, and tree-shaking will silently drop
> needed code. Audit `generate-source-agent-bundles.cjs` output (`agent-skills-bundle.js`,
> `agent-roles-bundle.js`), the `__AGRUN_RUNTIME_BUILD_ID__` transform, and any top-level
> registration. This audit is the first concrete spike task.

#### SIDE-EFFECTS AUDIT — DONE (2026-06-07): core is side-effect-free → `sideEffects:false` is SAFE

Scanned all of `src/index.js` + `src/runtime/*.js` for import-time side effects:
- **0 top-level executable (non-declaration) lines** across the whole tree — every
  module-scope line is `import` / `export` / `const` / `let` / `function` / `class`.
- **No IIFEs** at module scope; **no module-level mutation at import** (`.set`/`.push`/
  `.add`/`.register` at col 0); **no top-level `await`**; **no global/prototype
  mutation at import** (the only `globalThis.crypto` uses are inside function bodies in
  `approval-signing.js` — runtime, executed only when called).
- The generated bundles (`agent-skills-bundle.js`, `agent-roles-bundle.js`) are pure
  `export const X = Object.freeze([...])` data bindings (a frozen value export is
  tree-shakeable, not a side effect). The `__AGRUN_RUNTIME_BUILD_ID__` transform is a
  build-time string replace producing a `const`, not a runtime side effect.

**VERDICT: the gating fact is GREEN.** Core has no import-time side effects, so
`sideEffects:false` is honest and tree-shaking will not silently drop needed code. The
B2 path (ESM + `exports` map + `sideEffects:false`) is viable. This unblocks P1/P2.

#### P0 BUNDLE MEASUREMENT — DONE (2026-06-07): de-imports pay off, AND UMD's limit is proven

Built the current bundle vs a core-only variant (the 5 research-surface re-exports —
`bundledAgentSkills`, `bundledRuntimeHooks`, and the evidence-graph/report-loop/
acceptance-evaluator behavior re-exports — stripped from `src/index.js`, then rebuilt
with the existing UMD Rollup), measured size + grepped research markers:

| | Full bundle | Core-only (research surface stripped) |
|---|---|---|
| size | 3,785,172 B | **3,661,159 B** (−124,013 B, −3.3%) |
| `observeAiFirstResearchFinalizeContract` | 2 | 0 (dropped) |
| `refreshResearchAcceptanceEvaluator` | 4 | 0 (dropped) |
| `deep-research-writer` (skill) | 2 | 0 (dropped) |
| report-loop `"Pattern B canonical opt-out"` | present | **0 (research-report-loop.js fully dropped)** |
| evidence-graph `RESEARCH_EVIDENCE_NOISE_RE` | present | 3 (**lingers**) |

TWO conclusions, both useful:
1. **The de-imports pay off:** even under plain UMD (which barely tree-shakes), removing
   the research surface drops ~124 KB and eliminates finalize-contract, acceptance-evaluator,
   report-loop, and the research skill from the core bundle. Without the 2.1/2.2 de-imports
   these would have been entangled and un-droppable.
2. **UMD's tree-shaking limit is now EMPIRICALLY PROVEN:** evidence-graph content lingers
   under UMD even though it is reachable only via the (stripped) report-loop. This is
   exactly the spike's thesis — UMD + `commonjs()` cannot fully tree-shake; **B2 (ESM +
   `sideEffects:false`) is REQUIRED to drop research completely.** The side-effects audit
   above confirms B2 is safe to adopt.

So P0 evidence strongly supports the B2 plan: side-effects-free core (audited) + a
research-only entry + an ESM build with `sideEffects:false` will fully drop research from
a generic consumer's bundle. (Measurement was a temp strip of `src/index.js`, restored;
no source change shipped from the measurement itself.)
(Caveat: a freshly-added top-level statement in any core module would reintroduce a
side effect; a CI lint that rejects top-level executable statements in `src/runtime`
would keep the invariant — cheap to add when P2 lands.)

---

## 6. Hard edges — how the package boundary handles them

The triage map flagged three files that the per-edge playbook can NOT cleanly clear.
The package split is exactly the boundary that resolves them — but each needs a decision.

### report-loop (168 readers of `runState.researchReportLoop` + drags evidence-graph)
Do NOT grind reader-by-reader. Apply the **2.2 data/behavior split** at the package
boundary: move the report-loop BEHAVIOR (gate/evaluate + the evidence-graph builder it
calls) to the research package; keep in core ONLY the pure-data the 168 readers need —
either (a) relocate the empty-slot factory + config normalizer to a `kernel-report-loop`
data section (like acceptance-evaluator 2.2), or (b) accept that the 168 readers keep
the vocabulary and only the import edge moves. The slot-absent arbiter (stub the slot
factory → null, run `npm run check`) decides whether (a) is even needed. evidence-graph
+ the 3 leaves ride along (they're imported only by report-loop's builder).

### research-state (the gate predicate `isResearchQualityGateRequired = isEvidenceConvergenceRun`)
Dangerous-last. The predicate is read by `planner-action-surface`, convergence,
planner-prompt (9 core importers) and intersects AGRUN-299/300/301/307. Boundary
decision: the **gate predicate stays in core as a host-supplied hook**
(`runtimeConfig.requiresQualityGateFn`, default `() => false`); the research pack supplies
the real predicate; the rest of `research-state` (state factories, thread helpers) splits
per its own arbiter. This is its own reviewed change AFTER the split lands.

### In-core vocabulary residue (the honest limit)
Even after the split, core retains DOMAIN FIELD NAMES in readers
(`runState.researchAcceptanceEvaluator.acceptanceConvergenceSignal`, `runState.researchReportLoop.*`).
The package split removes the research **code/import** from core's bundle; it does NOT by
itself make core's source **vocabulary-free**. Making the readers read generic runState
slots (renamed / hook-projected) is a SEPARATE, later, mostly-cosmetic pass. **State this
plainly in any "done" claim.**

---

## 7. Migration plan (incremental, non-breaking until the format flip)

1. **P0 (non-breaking — ADDITIVE):** introduce a `src/research-index.js` barrel that
   re-exports the research surface, and build it as a SECOND output
   (`dist/agrun-skills-research.js`) **while `src/index.js` keeps re-exporting research
   for back-compat**. Both import paths work ⇒ no consumer break. (Removing research
   from `src/index.js` is itself breaking — consumers do `import { bundledRuntimeHooks }
   from "agrun"` today, e.g. planner.test.js via dist — so that removal is deferred to
   the P2/3.0 flip.) Goal of P0: prove the research surface is cleanly importable from a
   separate entry, and that the core entry can be built WITHOUT research (measure it).
2. **P1 (non-breaking):** the `sideEffects` audit (§5); fix any import-time side effects;
   add `sideEffects:false` once safe. Measure bundle size before/after with a tree-shaking
   test harness (import only `createRuntime`, assert research strings absent).
3. **P2 (BREAKING ⇒ 3.0):** flip to ESM + `exports` map (B2); publish `@agrun/skills-research`
   as a separate package; migration note "research import path moved". This is the version
   bump that actually drops research from a generic consumer's bundle.
4. **P3 (follow-on):** report-loop boundary split (§6), research-state gate-hook, vocabulary
   residue pass. Each its own reviewed change.

Litmus at each step: `npm run check` + live `node-3000` + browser build green; plus a NEW
**bundle-content test** (P1+) asserting a no-skills build contains no research symbols.

---

## 8. Open decisions for the maintainer (this spike asks you to choose)

1. **Format:** B2 (ESM + exports, recommended) vs B1 (two UMD bundles, faster) vs B3
   (workspaces, cleanest)?
2. **Pack granularity:** one `@agrun/skills-research`, or also `@agrun/skills-coder` +
   a `@agrun/skills-default` meta-pack? (skills/: research×4, expert-coder×1, worldtime_tz.)
3. **Repo shape:** keep the single `0_development` tree with two builds, or reorg to
   `packages/*` workspaces (repoints `examples/*` + CI)?
4. **Public API names:** keep `createResearchAcceptanceEvaluatorState` etc. (research vocab
   in core's kernel seam, no break) or rename generic + ship the research names from the
   pack (cleaner, breaking)?
5. **Version:** is the format flip the 3.0 milestone?

---

## 9. Honest scope — what the split delivers and what it does NOT

DELIVERS:
- A generic consumer (`import 'agrun'`, no skills) gets a build with **zero research code**.
- Research becomes a true installable opt-in plugin, not a defaulted-off in-bundle feature.
- The structural boundary makes "core depends on research" impossible to reintroduce
  (core's package.json has no path to the research package).

DOES NOT (by itself):
- Make core's SOURCE vocabulary-free (the runState field-name readers stay — §6 residue).
- Move the gate predicate (research-state) — that's P3.
- Reduce anything until the FORMAT flip (P2/3.0); P0/P1 are prep that don't shrink a
  consumer's bundle on their own.

This spike's recommendation: approve **B2 + P0→P3 phasing**, start with the **side-effects
audit** (the one fact that gates everything) and the **P0 barrel split** (non-breaking,
immediately clears `src/index.js` of research and proves the boundary).
