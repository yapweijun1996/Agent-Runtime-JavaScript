# Micro-kernel dependency-inversion seam (AGRUN-313-P2F, 2.0 prep)

> **Superseded (2026-06-09):** the kernel-seam hook mechanism described here was removed — see ADR-0054 and kernel-seam-removal-design.md.

Status: PROOF-OF-CONCEPT (one edge done on branch `feat/agrun-313-p2f-2.0`)
Relates to: AGRUN-313 (epic), AGRUN-313-P2F-2.0 (ticket), micro-kernel-phase2-plan.md

## Problem (why P2f is not "move files")

The litmus wins of AGRUN-313 (zero `long_research` literals, default
`agentSkills=[]`) are all **breaking** and gated to 2.0. But the deeper blocker
is structural and was proven by a dependency grep:

> **Core imports research.** `src/index.js`, `config.js`, `state.js`,
> `final-readiness.js`, `action-loop-action.js` (and more) directly `import` the
> ~18 research-domain files. There are **~67 such core→research import edges**.

Because the edges run core→research, there is **no clean leaf to relocate**.
Moving a research file into a `research/` subdirectory while core keeps importing
it across the new path is **cosmetic**: the litmus does not move, core still
depends on research, and it carries regression risk for zero architectural gain.

The real primitive is **dependency inversion of each edge**, not file movement.

## Mechanism (reuse the existing idiom — NO registry)

The runtime already has the right precedent: `drift-detector.js` accepts an
optional `similarityFn` from config and falls back to a built-in default. The
project decision (task.jsonl AGRUN-313 `phase2_plan.seam`) is explicit:
**"NO capability registry / mode bus (over-abstraction)."** So the seam is a
plain function hook on `runtimeConfig`, not a registry/service-locator.

Pattern, per inverted edge:

1. **Composition root wires the default.** In `config.js normalizeRuntimeConfig`,
   add a `runtimeConfig.<fooFn>` field defaulting to the research function
   (host override wins): `typeof config.fooFn === "function" ? config.fooFn : researchFoo`.
   `config.js` is the **single place** that imports the research function. This
   one line is what 2.0 flips (default moves behind the opt-in research plugin).
2. **Hot-path call sites read the hook, not the import.** Replace the direct
   `import { researchFoo }` + call with
   `const foo = runtimeConfig?.fooFn (function?) : <domain-free default>; foo(...)`.
   The kernel hot path now knows a generic verb, not a research function.
3. **Domain-free fallback.** When no classifier is wired (a runtime that opts out
   of research entirely), the fallback must be the domain-neutral answer, not the
   research impl. For evidence classification that is `"none"` (a kernel with no
   research concept has no evidence state).
4. **One-hop threading only.** If a call site does not already have
   `runtimeConfig` in scope, pass `runtimeConfig: session.runtimeConfig` through
   the single caller's options bag. No deep threading; no new context object.

Net effect per edge: the research import moves from N hot-path files to the
1 composition-root file, and the hot path becomes domain-neutral. Repeating this
across the ~67 edges concentrates all research imports at `config.js`, after
which 2.0 makes that wiring opt-in and the kernel is domain-free.

## Proof-of-concept edge: `classifyEvidenceState`

Smallest clean edge — a single pure function `classifyEvidenceState(researchContext, toolContext)`.

Before: imported by `action-loop-session-cycle.js` and `semantic-input-resolution.js`
(2 hot-path edges).

After (this PoC):
- `config.js`: `runtimeConfig.classifyEvidenceFn` defaults to `classifyEvidenceState`
  (the only file that now imports it).
- `action-loop-session-cycle.js`: reads `session.runtimeConfig.classifyEvidenceFn`,
  falls back to `() => "none"`; threads `runtimeConfig` one hop to the semantic path.
- `semantic-input-resolution.js`: reads `options.runtimeConfig.classifyEvidenceFn`,
  same fallback.

Verification: `evidence-state.js` is now imported by `config.js` only; behaviour is
byte-identical (default wiring = old function); `npm run check` green.

## KEY CORRECTION (2026-06-07): the "18 research files" list over-includes GENERIC infra

An attempt to physically extract `evidence-state.js` into the opt-in pack (config
default -> domain-free null; research pack supplies `classifyEvidenceFn`) FAILED
the test suite: `test/concerns/approval-resume.test.js` — a **generic** agent flow
(web_search + read_url + approval, NO research skills wired) — asserts
`evidenceState === "snippet_only"`, which became `"none"` once classification was
gated behind the research pack.

**Conclusion: `evidence-state.js` is GENERIC infrastructure, not research-domain.**
Any agent that does web_search/read_url classifies evidence; core flows depend on
it. It belongs in core; config.js importing it is correct, not a hardcode
violation. The extraction was reverted.

**Principle (the real test for "is this file research-domain?"):** a file is only
extractable to the research plugin if NO generic (non-research) flow consumes it.
The test suite is the arbiter — if a non-research concern/unit test breaks when the
file is gated behind the research pack, the file is generic and stays in core.

**Implication for the backlog:** the `evidence-*` family (and likely
`terminal-repair-*`, `workspace-candidate-lifecycle` — used by generic terminal
recovery / workspace flows) are GENERIC infra mis-labeled as research. The truly
research-ONLY extractable set is the *orchestration* layer (research-report-loop,
research-acceptance-evaluator, research-coverage-guard, research-finalize-contract,
research-source-authority, research-domain-ownership, research-entity-resolution).
Each candidate must be proven research-only by a generic-consumer audit BEFORE
extraction. The general-runtime BEHAVIOR (default agentSkills=[] + L2 name-free
kernel) is already achieved and live-tested independent of this physical move.

## Scope reality (the go/no-go this PoC exists to inform)

This is **one edge of ~67**. The gate-coupled edges
(`shouldHideWorkspacePublishCandidateForMode` + AGRUN-299/300/301/307 + 305 +
terminal-repair) are deliberately **last and out of scope** for the early passes.
The token-persistence edges (`provider.js`, `research-thread-sync.js`) stay until
2.0 — removing the persisted `researchActivation="long_research"` token is the
serialization break (SPIKE finding on AGRUN-313). This branch never touches
released 1.x.

## Plugin-ization hook blueprint (2026-06-07) — the "research as a true plugin" design

Goal (the maintainer's correction): core must NOT depend on research code at all.
Research behaviors register into GENERIC extension points; with no research skill
loaded, core runs generically with zero research vocabulary. "Move files to a
sub-path" is NOT enough — if core still CALLS research, it still depends on it.

DONE (already capability-driven — the model to replicate):
- Evidence-convergence gate → skill capability `requiresEvidenceConvergence`.
- Publish-direct terminal → action capability `publishDirect` (action self-declares;
  core reads `runState.terminalActionPublishDirect`).
- Finalize contract (research-finalize-contract) → `runtimeConfig.finalizeContractHooks`
  bundle (2026-06-07, commit on `feat/agrun-313-2.1-litmus-burndown`). See the
  edge note below. This is the FIRST inverted research behavior.

STAYS IN CORE (generic infra — a non-research flow consumes it; proven by tests):
- evidence-state, evidence-pack, evidence-policy, terminal-repair-state,
  terminal-repair-strings, workspace-candidate-lifecycle, candidate-quality-signal,
  search-research-context. These are generic web-agent / terminal mechanism.
- research-coverage-guard `extractResearchCoverageTargets` — RECLASSIFIED generic
  2026-06-07 (was a candidate to invert). It is a pure prompt-parser (extracts
  list/news-like targets from the prompt text alone, no research state) consumed by
  GENERIC analyzers `analyzeFinalResponseQuality` + `buildEvidencePack` +
  citation coverage. PROVEN by the arbiter: stubbing it to `() => []` breaks two
  GENERIC tests with NO research skills wired — `citation-source-coverage.test.js`
  (asserts US/Malaysia/Singapore targets from a plain news prompt) and
  `final-response-quality.test.js`. So the "Research" in its name is misleading
  (like evidence-*, terminal-repair-*); it belongs in core. Its other two exports
  (`maybeCreateResearchCoverageVeto`, `collectExecutedSearchQueries`) have ZERO core
  importers (internal/leaf), so there is nothing else to invert here.

RESEARCH-SPECIFIC behaviors to invert into hooks (each woven into generic flow →
needs a null-safe generic default + per-edge test that generic flows still pass):
| Behavior (file) | core call sites | generic flow hits it? | proposed hook (default) |
|---|---|---|---|
| ~~finalize contract (research-finalize-contract)~~ **DONE** | action-loop-plan, action-loop-session-terminals (3 terminals) | YES (every terminal) | **shipped** `runtimeConfig.finalizeContractHooks` — atomic bundle of all 5 fns (default: generic no-op, see edge note below) |
| ~~report loop (research-report-loop)~~ **FULL DONE** | (was action-loop-action, action-loop-plan-actions, config, state) | only when research active | behavior → `reportLoopHooks` (edge 3); config normalizer + state-slot factory → `kernel-report-loop.js` seam (2.2). `src/runtime` grep clears; only pack imports it. |
| ~~acceptance evaluator (research-acceptance-evaluator)~~ **FULL DONE** | (was action-loop-action, action-loop-plan-actions, planner-prompt, state) | only when active | behavior → `acceptanceEvaluatorHooks` (edge 4); slot+summarizer → kernel seam (2.2). `src/runtime` grep clears; only pack + research-internal finalize-contract remain. |
| ~~coverage guard (research-coverage-guard)~~ **RECLASSIFIED → GENERIC, stays in core** | final-response-quality, final-response-sources, evidence-pack | YES (proven) | none — see STAYS IN CORE list above (arbiter: stub→[] breaks 2 generic tests) |
| ~~evidence graph (research-evidence-graph)~~ **FULL DONE (2.2)** | (was result + action-loop-terminal collector, state slot) | research-only (generic graph is empty/null) | resolved NOT by a kernel seam (data fns entangled) but by **store-on-graph**: materialize pre-computes `graph.compiledReportSources`, result/terminal read the field; slot starts null. Only research-report-loop (research-internal) imports it. |
| source-authority / domain-ownership / entity-resolution | research-internal leaves (via evidence-graph) | no | move with evidence-graph |

Hook-delivery vehicle: the opt-in pack exports `bundledRuntimeHooks` (research impls);
hosts wire `createRuntime({ agentSkills: bundledAgentSkills, ...bundledRuntimeHooks })`.
Core defaults every hook to the generic/no-op behavior, so a host that wires nothing
gets a clean generic loop and the research files tree-shake out (once no core import
remains). This is the publishDirect pattern generalized.

EXECUTION DISCIPLINE (learned from the reverted evidence-state attempt): invert ONE
behavior at a time; make the default the correct GENERIC behavior; run the full suite
AND a live flow; if a generic (non-research) test breaks, the behavior was generic
infra — keep it in core, do not hook it. This is a multi-week, per-edge, reviewed
effort, not a single-pass change.

### Edge 1 DONE — finalize contract (2026-06-07, `feat/agrun-313-2.1-litmus-burndown`)

First research behavior inverted into a hook. Shipped shape (refines the sketch above):

- **One ATOMIC bundle, not 5 separate `*Fn` fields.** `runtimeConfig.finalizeContractHooks`
  carries all 5 functions (`observe`, `maybeContinueOnMissingAiReadiness`,
  `maybeContinueOnLimitedAiReadiness`, `maybeContinueOnReadinessConflict`,
  `maybeContinueOnWorkspacePublishPath`). Why a bundle: the 5 are one cohesive
  behavior (observe produces a contract; the 4 continuations consume it). You can't
  half-wire it — a partial set would silently drop part of the contract. The reader
  (`kernel-finalize-contract.js readFinalizeContractHooks`) merges the wired bundle
  over the generic no-op defaults, so every key is always callable.
- **Generic default = no-op** (`GENERIC_FINALIZE_CONTRACT_HOOKS`, every fn `() => null`).
  This is byte-identical for generic flows by construction: `observe` already
  self-gated on `isResearchQualityGateRequired`, so a non-research flow always got
  `null` and pushed no `research-finalize-contract-*` step — exactly what the no-op
  yields. No generic test could break (and none did). The risk fully moved to the
  research-active path, covered by wiring the bundle wherever skills are wired.
- **Seam modules:** core no-op + reader = `src/runtime/kernel-finalize-contract.js`
  (no research import); the research impls = `src/runtime/bundled-runtime-hooks.js`
  exporting `bundledRuntimeHooks` (the ONE legitimate core→research import — it IS
  the opt-in pack wiring). `config.js` default-wires `normalizeFinalizeContractHooks`.
  `action-loop-plan.js` + `action-loop-session-terminals.js` no longer import
  `research-finalize-contract.js`; they read the hook bundle off `session.runtimeConfig`.
- **Wiring vehicle:** `createRuntime({ agentSkills: bundledAgentSkills, ...bundledRuntimeHooks })`.
  Wired in `test/concerns/planner.test.js` (helper), `test/node-agrun-3000-live.mjs`,
  and `examples/browser/src/runtime/agent.ts` — the same sites that opt into the skills.
- **MIGRATION CAVEAT (behavior change on the opt-in path):** "research active ⟺ skills
  loaded ⟺ hooks wired" is enforced by CONVENTION, not structurally (core can't
  auto-detect research without depending on it — that's the whole point). A 2.x host
  that writes `createRuntime({ agentSkills: bundledAgentSkills })` and FORGETS
  `...bundledRuntimeHooks` now silently loses the finalize contract, where before it
  got it for free. The migration note MUST say: wire BOTH.
- **Verified:** acceptance grep clean (only `bundled-runtime-hooks.js` imports the
  contract); `npm run check` green (incl. `planner.test.js` asserting
  `research-finalize-contract-observed` fires through the hook via `dist`); live
  `node-3000` published a 3040-word artifact (exit 0, all invariants); browser build
  exit 0. Source-only commit; `dist` rebuilt at release.

### Edge 3 PARTIAL DONE — report-loop BEHAVIOR (2026-06-07, same branch)

Second research behavior inverted — but a **deliberate PARTIAL** edge (the
maintainer chose "behavior-hook now, honestly labeled" over the larger full
de-import). Read this as the template for "invert the research behavior, leave the
generic plumbing, do not over-claim".

- **Arbiter first (the discipline that mattered).** Before touching code, stubbed
  `refreshResearchReportLoopGate` → null and ran `npm run check`: the ONLY breaks
  were the module's own unit test (a direct-import artifact, the module isn't
  deleted) and a research-skill-wired workspace test. NO generic/no-skill flow
  broke → the gate **behavior** is research-only. Contrast edge 2 (coverage-guard),
  where the same stub broke two generic tests → that one stayed in core. Same method,
  opposite verdict; the test suite decided, not the file name.
- **What inverted:** the 2 behavior fns `refreshResearchReportLoopGate` (long-run
  acceptance gate) + `noteResearchCoverageSearchAttempt` (per-`web_search` coverage
  note) → `runtimeConfig.reportLoopHooks` (`{ refreshGate, noteSearchAttempt }`,
  default generic no-op in `kernel-report-loop.js`). `action-loop-action.js` +
  `action-loop-plan-actions.js` no longer import `research-report-loop.js`; they read
  the hook. Pack supplies the impls via `bundledRuntimeHooks.reportLoopHooks`.
- **What deliberately STAYED (why this is PARTIAL, not DONE).** `config.js` still
  imports `normalizeResearchReportLoopConfig` (config normalizer) and `state.js` still
  imports `createResearchReportLoopState` (state-slot factory). A second arbiter run
  (stub the state-factory → `undefined`) proved the slot MUST exist — removing it
  breaks `.enabled`/`.recentQueries` reads in the globe3/thread-sync paths. So
  `grep research-report-loop src/runtime` still shows `config.js` + `state.js` (+ the
  pack module). This commit removed the **2 hot-path BEHAVIOR import edges**, not the
  whole file. Honest status: report-loop behavior = inverted; normalizer + state-slot
  = **pending move** (NOT "generic infra that stays" — that classification is unproven
  and would need the full-de-import follow-up: normalize pack-side + lazy null-safe
  slot).
- **Verification asymmetry (important).** Unlike edge 1, the offline suite barely
  covers this gate — `npm run check` was *nearly green with the gate fully stubbed*.
  So byte-identical confidence rests on the **live** run, which here actually
  exercised the path: `research-report-loop-gate-refreshed` fired **2×** through the
  wired hook (gate returned non-null), published `final_candidate.md`, exit 0, all
  invariants. Plus full `npm run check` exit 0 + browser build exit 0.

### Edge 4 PARTIAL DONE — acceptance-evaluator BEHAVIOR (2026-06-07, same branch)

Third research behavior inverted; same PARTIAL shape as report-loop. Confirms the
emerging rule: invert the research behavior, prove (don't assert) what plumbing
must stay, label honestly.

- **Arbiter:** stubbed `refreshResearchAcceptanceEvaluator` → null + `npm run check`.
  The ONLY breaks were **direct-module tests** — `evidence-policy.test.js` (imports
  the fn and asserts its `acceptanceConvergenceSignal`), `action-loop-session-terminals.test.js`,
  and the module's own `research-acceptance-evaluator.test.js`. Every full-loop
  GENERIC test passed (convergence / recovery / "generic evidence count" all green).
  So the refresh behavior is research-only. (A 0-skill test name like "evidence-policy"
  is NOT a generic-flow signal when it *direct-imports* the research fn — that's a
  module test that stays valid post-inversion since the module isn't deleted.)
- **What inverted:** `refreshResearchAcceptanceEvaluator` (readiness-conflict /
  convergence signal) → `runtimeConfig.acceptanceEvaluatorHooks` (`{ refresh }`,
  default no-op in `kernel-acceptance-evaluator.js`). Both core call sites
  (`action-loop-action.js`, `action-loop-plan-actions.js`) already `if (evaluator && …)`
  null-guard the result, so the no-op default is byte-identical. Pack supplies the
  impl via `bundledRuntimeHooks.acceptanceEvaluatorHooks`.
- **What deliberately STAYED (partial):** `state.js` (slot factory) +
  `planner-prompt.js` (the `summarizeResearchAcceptanceEvaluator` LLM-facing
  projection) keep importing the file. The third caller, `research-finalize-contract.js`,
  is **research-internal** — it's only reached via the edge-1 finalize-contract pack
  hook, so its direct call is research→research, not a core→research edge. So
  `grep research-acceptance-evaluator src/runtime` still shows state + planner-prompt
  (+ pack). Honest status: behavior = inverted; summarizer + slot = pending move.
- **Verified (live is the real arbiter, same asymmetry as report-loop):**
  `research-acceptance-evaluator-refreshed` fired **2×** through the wired hook,
  published a 2514-word artifact (exit 0, all invariants); `npm run check` exit 0;
  browser build exit 0. Source-only commit.

### Edge 5 TRIAGED — research-evidence-graph: research-only but THREAD-BLOCKED → DEFER (no code change)

Ran the stub-arbiter; the verdict is a THIRD category (distinct from edge 1 "clean
invert" and edge 2 "generic, stays"): **research-only behavior that cannot be
cleanly inverted yet.** Recorded so the next pass doesn't re-investigate.

- **Arbiter result:** stubbing `collectResearchReportSourceArtifacts → []` +
  `buildResearchEvidenceGraph → empty` + `materializeEvidenceGraph → noop` and
  running `npm run check` broke ONLY `research-evidence-graph.test.js` (the module's
  own unit test — artifact; it also aborted the suite early). Ran the candidate
  generic tests directly against the stubbed `dist` — all passed
  (no-regex-on-prompt, approval-todo-state, final-response-prompt,
  run-state-projections, final-answer-internal-progress). Structural reason: a
  generic flow's `runState.researchEvidenceGraph` is the EMPTY slot (the builder runs
  only inside the report-loop gate, which is behind the edge-3 hook), so
  `collectResearchReportSourceArtifacts(emptyGraph) → []` either way. Behavior is
  research-only.
- **Why it's NOT a clean edge (the blocker):** the only non-research-internal
  consumers are `result.js` + `action-loop-terminal.js`, both calling
  `collectResearchReportSourceArtifacts(graph)` inside `createCompiledReportSourcePayload(graph)`
  — a pure helper whose callers (`collectTerminalOutputSources(runState, …)`,
  `collectTerminalFinalSources(runState, request, …)`) carry `runState` but NOT
  `runtimeConfig`. Reading a hook there needs MULTI-HOP `runtimeConfig` threading
  (THREAD class — signature churn the project defers in early passes). The builder
  (`build`/`materialize`) is research-internal (called only via the report-loop gate
  hook), so its import edge rides on the report-loop file, which itself stays in core
  for the normalizer/slot (edge-3 partial). The state-slot factory
  (`createEmptyResearchEvidenceGraph`) is plumbing.
- **Decision: DEFER.** No standalone clean inversion exists. Finishing this belongs
  to the report-loop FULL de-import follow-up (when report-loop leaves core, its
  evidence-graph builder import goes with it) plus a deliberate decision on how the
  terminal/result source projection reads a hook (thread `runtimeConfig`, or carry
  the collector on `runState`). Not forced now — multi-hop threading on the terminal
  hot path is exactly the early-pass churn the design warns against.

## 2.2 FULL de-import — acceptance-evaluator cleared from `src/runtime` (2026-06-07, branch `feat/agrun-313-2.2-full-deimport`)

The first FULL de-import after the per-edge phase. Pattern for "finish removing a
research file core already partially-inverted": separate the research **behavior**
from the **pure-data plumbing**, move only the data.

- **Arbiter that picked the strategy:** stubbed `createResearchAcceptanceEvaluatorState
  → null` (slot ABSENT, never tested in edge 4 which only stubbed `refresh`) and ran
  `npm run check` — **green, zero failures**. All 12 readers of
  `runState.researchAcceptanceEvaluator` already null-guard. So the slot can be null;
  but I kept the empty-shape factory (byte-identical, zero risk) and just moved it.
- **What moved to `kernel-acceptance-evaluator.js` (pure data, no research logic):**
  `createResearchAcceptanceEvaluatorState` (empty 18-field shape) +
  `summarizeResearchAcceptanceEvaluator` (null-safe read-only projection for the
  planner prompt) + its private `buildNextMoveContract` + copies of 3 trivial
  coercers. Export names preserved → no public-API break.
- **What stayed:** the heavy BEHAVIOR (`refresh`/`evaluate`/`buildNextEvaluatorState`,
  ~700 lines) stays in `research-acceptance-evaluator.js`, imported only by
  `bundled-runtime-hooks` (pack) + `research-finalize-contract` (research-internal,
  behind the edge-1 finalize-contract hook). It tree-shakes out at the package split.
- **Import rewires:** `state.js` + `planner-prompt.js` import the data fns from the
  kernel seam (not the research file). `src/index.js` splits its public re-export:
  data fns from the kernel seam, behavior fns still from the research module (the
  barrel is `src/index.js`, outside the `src/runtime` acceptance grep; it's the
  package-split surface). The module's own test imports `summarize` from the seam.
- **Why relocate, not hook:** `planner-prompt.js` carries NO `runtimeConfig` and
  `buildPlannerPrompt` has 3 call sites — hooking the summarizer would thread a new
  cross-cutting dependency through the whole prompt path. The summarizer is a pure
  projection (the advisor's framing: core already carries the slot vocabulary in the
  12 readers, so relocating adds none). Decide on risk, not purity.
- **Result:** `grep research-acceptance-evaluator src/runtime` now shows ONLY
  `bundled-runtime-hooks.js` + `research-finalize-contract.js` — the file is cleared
  from core, same as finalize-contract. **Honest scope:** this does NOT make core
  domain-vocabulary-free (the 12 readers + slot field names stay); it removes the
  static import so the heavy behavior tree-shakes at the package split.
- **Verified byte-identical:** `npm run check` exit 0 (incl. `planner.test.js` +
  the module's own test through `dist`); live `node-3000` published a 3084-word
  artifact (score 75, exit 0, all invariants) with `research-acceptance-evaluator-refreshed`
  firing **2×** through the wired hook; browser build exit 0. Source-only.

## COMPLETE triage map (2026-06-07) — all 11 `research-*.js` classified, per-edge clean-invert phase DONE

Every `research-*.js` file in `src/runtime` has now been run through the
stub-arbiter or an importer audit. The headline: **the cleanly-invertible
research-only behaviors are exhausted** (edges 1/3/4 took all of them). What
remains is NOT more of the same — it is the bigger structural moves.

| File | Category | Status / next move |
|---|---|---|
| research-finalize-contract | ① CLEAN INVERT | **DONE (full)** — edge 1, grep clears, only the pack imports it |
| research-report-loop | ① CLEAN INVERT | **FULL DONE** — edge 3 (behavior) + 2.2 de-import (normalizer + state-slot factory → kernel-report-loop seam); `src/runtime` grep clears, only pack imports it |
| research-acceptance-evaluator | ① CLEAN INVERT | **FULL DONE** — edge 4 (behavior) + 2.2 de-import (slot+summarizer moved to kernel seam); `src/runtime` grep clears |
| research-coverage-guard | ② GENERIC, STAYS | **DONE (classified)** — edge 2; generic test breaks under stub |
| research-evidence-graph | ③ research-only, was THREAD-BLOCKED | **FULL DONE (2.2)** — resolved via store-on-graph (materialize pre-computes `compiledReportSources`, result/terminal read the field) + null slot; `src/runtime` grep clears, only research-report-loop (research-internal) imports it |
| research-source-authority | research-internal leaf | DEFER — imported only by evidence-graph; moves with it |
| research-domain-ownership | research-internal leaf | DEFER — imported only by evidence-graph (+ source-authority) |
| research-entity-resolution | research-internal leaf | DEFER — imported only by evidence-graph |
| research-state | GATE / dangerous-last | DEFER — `isResearchQualityGateRequired` = `isEvidenceConvergenceRun` is the gate predicate read by planner-action-surface + convergence + planner-prompt (9 core importers); AGRUN-299/300/301/307 intersection. Needs the gate-predicate-as-hook redesign, explicitly LAST. |
| research-thread-sync | TOKEN / 2.0 | DEFER — `applyResearchSliceToRunState` restores persisted research slice; serialization break = 2.0 |
| research-activation-token | TOKEN / 2.0 seam | INTENTIONAL — `LEGACY_RESEARCH_ACTIVATION_TOKEN="long_research"` kept for thread-resume back-compat until the 2.0 serialization migration |

GENERIC infra siblings (proven stay-in-core, despite research-ish names):
evidence-state, evidence-pack, evidence-policy, terminal-repair-state,
terminal-repair-strings, workspace-candidate-lifecycle, candidate-quality-signal,
search-research-context.

**What this means for the remaining litmus progress (no more quick per-edge wins):**
1. ~~Full de-import for acceptance-evaluator~~ **DONE (2.2)** — slot factory +
   summarizer moved to the kernel seam (pure data, byte-identical); `grep
   research-acceptance-evaluator src/runtime` now shows only the pack +
   research-internal finalize-contract. **report-loop's full de-import remains** —
   but it is NOT this playbook: 168 readers of `runState.researchReportLoop` + the
   evidence-graph drag mean it should be designed against the package-split
   boundary, not ground out reader-by-reader. Doing it also unblocks evidence-graph
   (its builder rides on report-loop) and the 3 research-internal leaves.
2. **Gate-predicate redesign** (research-state) — the dangerous-last edge; the
   publish/quality gate predicate stays in core as a host-supplied hook, the rest of
   research-state leaves. Gated on AGRUN-299/300/301/307.
3. **Token migration** (research-thread-sync + research-activation-token) — the 2.0
   serialization break.
4. **Package split** — a separate `@agrun/skills-research` entry-point so the bundle
   actually drops research once no core import remains. **Design spike:
   `agrun_docs/package-split-skills-research-spike.md`** (the two bundle blockers —
   barrel re-export + non-tree-shakeable UMD — the target two-package shape, the
   build-format options B1/B2/B3, the side-effects audit that gates everything, and
   the non-breaking→3.0 phasing). This is the move that finally drops research from a
   generic consumer's bundle; the per-edge inversions above are its prerequisite.

These are reviewed, multi-commit efforts, not chat-turn grinds — the per-edge hook
inversions (this session) were the safe, incremental layer; the above is the
remaining architecture work.

## Classified backlog (measured 2026-06-07) — why this is NOT a mechanical batch

After the PoC, every other candidate edge was checked for one-hop cleanliness.
**Finding: `evidence-state` was the ONLY clean single-pure-function edge whose
call sites already had `runtimeConfig` in scope.** Each remaining core→research
edge is entangled — it needs one of: multi-export hook design, multi-hop
threading of `runtimeConfig` through pure helpers (signature churn the advisor
ruled out for early passes), or it touches gate/terminal/publish code that is
2.0-only. So the remainder is real per-edge design work, not a quick sweep.

CORE importers per research file (research↔research internal edges excluded):

| Research file | CORE importers | Class | Why deferred |
|---|---|---|---|
| evidence-state | config (✅) | **DONE** | inverted in PoC |
| evidence-pack | citation-source-coverage, final-response-quality | THREAD | `analyzeCitationTargetCoverage(runState)` has no config in scope → multi-hop |
| research-coverage-guard | final-response-quality, final-response-sources, web-search-planner | THREAD | pure helpers, no `runtimeConfig` at call site |
| candidate-quality-signal | virtual-workspace-actions | MULTI+GATE | 2 exports; quality-signal is publish-gate-adjacent |
| workspace-candidate-lifecycle | virtual-workspace | MULTI+GATE | 9 exports; publish lifecycle |
| evidence-policy | virtual-workspace-actions, config, final-readiness | NORMALIZER | already wired via config normalizer; woven into readiness |
| research-finalize-contract | action-loop-plan, action-loop-session-terminals | GATE/TERMINAL | finalize/terminal coupled |
| search-research-context | action-loop-action-context, action-loop-action, action-loop-plan-actions | HOT LOOP | core action loop, broad |
| research-evidence-graph | index, action-loop-terminal, result, state | BROAD | 4 core incl. public index + result |
| research-report-loop | index, action-loop-action, action-loop-plan-actions, virtual-workspace-actions, config, state | BROAD | 6 core |
| research-acceptance-evaluator | index, action-loop-action, action-loop-plan-actions, planner-prompt, state | BROAD | 5 core |
| research-state | action-loop-action, action-loop-plan-actions, action-pattern-convergence, virtual-workspace-actions, planner-action-surface, planner-prompt, planner, state | GATE | planner-action-surface = the gate predicate |
| research-thread-sync | run-state-thread, handle, thread | **TOKEN/2.0** | persisted researchActivation token |
| terminal-repair-state | 9 incl. planner-action-surface | GATE/LAST | AGRUN-299/300/301/307 intersection |
| terminal-repair-strings | action-loop-action, action-loop-session-loop | TERMINAL | terminal surface |

Recommendation: treat the remainder as a **scheduled 2.0 task**, not an inline
grind. The PoC proves the mechanism; this table costs the work. Each non-DONE row
is its own reviewable change (design the hook, thread or pick the seam, prove
byte-identical with `npm run check`), and the GATE/TOKEN rows must not move before
the 2.0 break is accepted.
