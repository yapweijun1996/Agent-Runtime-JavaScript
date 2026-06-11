# Kernel-Seam Removal Design — agrun = general runtime + portable skills/tools only

**Status:** COMPLETE (maintainer, 2026-06-09). Chunks: A=`0238d067e`, B=`0c0d1244c`, C=`b0ba2061e`, D=this commit.
**Supersedes:** the kernel-seam half of `micro-kernel-plugin-skills-rfc.md` (2026-06-07). That RFC chose to *relocate* research enforcement behind a pack-hook boundary; this design *deletes* the enforcement layer instead and keeps ONLY portable skills/tools as the extension surface.

## Decision

agrun exposes exactly two extension surfaces, nothing else:

1. **General agent runtime** — the bare OODAE loop.
2. **Portable skills/tools** — `customActions` / `defineAction` + `agentSkills` / SKILL.md / `agentSkillIndexProvider`.

The **kernel-seam hook mechanism is removed entirely.** Rationale: external engineers will not adopt the hook seam (it couples to runtime internals, is not portable, requires reading core source). The seam is already inert-by-default (no-op) for generic runtimes, so removing it changes nothing for non-research hosts; it only deletes a confusing, redundant indirection layer.

**Risk accepted by maintainer:** the `finalizeContractHooks` are the only mechanism forcing a weak model (deepseek / gemini-flash) to keep gathering evidence past a premature "I'm ready." After removal, the AI's finalize decision is honored directly. Weak models may produce shorter / under-sourced reports. **Disposition: delete, hand the judgment to the AI** (aligns with "keep runtime simple, AI is strong now" + "do not let runtime do AI work"). Enforcement is NOT relocated into SKILL.md as forcing logic; at most a thin advisory note.

## What "kernel-seam" is (the removal target)

Three hook bundles, entering core via public `runtimeConfig` fields, defaulting to no-op, with real impls in `@agrun/skills-research`'s `bundledRuntimeHooks`:

- `finalizeContractHooks`: observe, maybeContinueOnMissingAiReadiness, maybeContinueOnLimitedAiReadiness, maybeContinueOnReadinessConflict, maybeContinueOnWorkspacePublishPath
- `reportLoopHooks`: refreshGate, noteSearchAttempt
- `acceptanceEvaluatorHooks`: refresh

**Total surface: 21 invocations across 5 files.** (Correction to earlier "14 / 2 files": the reportLoop + acceptance families add 7 more call sites in 3 more files.)

## What STAYS (do not touch)

- The runState slots `researchReportLoop` and `researchAcceptanceEvaluator` stay PRESENT but permanently empty (`createXState()` shape). ~35 core readers (planner-prompt.js + others) already null-check them; empty slot = inert. Excising the slots + readers is a *later* cleanup, NOT this work.
- DATA kept in the two kernel files (these are generic plumbing, not research logic):
  - `kernel-report-loop.js`: `normalizeResearchReportLoopConfig` (L63), `createResearchReportLoopState` (L99).
  - `kernel-acceptance-evaluator.js`: `createResearchAcceptanceEvaluatorState` (L62), `summarizeResearchAcceptanceEvaluator` (L110).
- `src/index.js` exports of those 4 data symbols — KEEP (no import-path change needed; data stays in the same files).
- `kernel-terminal-actions.js` — not a hook seam (PUBLISH_DIRECT_ACTION literals); untouched.
- `@agrun/skills-coder` — already pure portable skill, zero seam dependency. Untouched. It is the proof the target shape works.

## Build + test harness

- `npm test` = `node test/smoke.test.js`, auto-discovers `test/unit/*.test.js` + `test/concerns/`. Runs against `dist/agrun.js`, so **build must run before test** (confirm exact build script in `package.json` at chunk start).
- Each chunk's acceptance = build + `npm test` green, plus the chunk-specific assertions below.

---

## Chunk A — Remove reportLoop + acceptance hooks (7 call sites)

Lowest behavior risk (gate/convergence telemetry; both already no-op in generic mode).

**Call sites to delete:**
- `action-loop-action.js`: import L22 (`readAcceptanceEvaluatorHooks`), import L35 (`readReportLoopHooks`); L548 `noteSearchAttempt`; the wrapper `refreshLongRunAcceptanceGate` (def L1004, calls L1009 `refreshGate` + L1036 `refresh`) and its 3 call sites L560/L591/L702.
- `action-loop-plan-actions.js`: import L21, import L26; the wrapper `refreshPlanLongRunAcceptanceGate` (def L226, calls L229 `refreshGate` + L256 `refresh`) and its 3 call sites L350/L368/L401; L343 `noteSearchAttempt`.
- `actions/virtual-workspace-actions.js`: import L32; L1232 `refreshGate`.

**Approach:** read each wrapper body fully (`refreshLongRunAcceptanceGate` L1004–~1050, `refreshPlanLongRunAcceptanceGate` L226–~270). Since both hooks return null in generic mode and every downstream line is null-safe, the wrapper bodies are already inert no-ops in generic mode — delete the whole wrapper + its call sites, not just the hook line. Confirm by reading: anything the wrapper does AFTER the hook call only fires when the hook returned non-null, which only happens when the (now-deleted) pack is wired. Remove the resulting orphaned imports.

**Seam-file edits:**
- `kernel-report-loop.js`: delete L29–46 (`GENERIC_REPORT_LOOP_HOOKS`, `normalizeReportLoopHooks`, `readReportLoopHooks`). Keep everything from L48 down (data).
- `kernel-acceptance-evaluator.js`: delete L29–44 (`GENERIC_ACCEPTANCE_EVALUATOR_HOOKS`, `normalizeAcceptanceEvaluatorHooks`, `readAcceptanceEvaluatorHooks`). Keep the `import { cloneValue }` (still used by summarizer) and everything from L46 down (data).
- `config.js`: remove imports L39 (`normalizeReportLoopHooks`), L40 (`normalizeAcceptanceEvaluatorHooks`); remove wiring L133 (`reportLoopHooks: ...`), L138 (`acceptanceEvaluatorHooks: ...`). KEEP L41 import of `normalizeResearchReportLoopConfig` and its existing usage.

**Tests:** rewrite `test/unit/research-report-loop.test.js` (gate/refresh assertions → assert slot stays empty / config normalizer still works, keep L86–89 config asserts) and `test/unit/research-acceptance-evaluator.test.js` (refresh assertions → drop or assert no-population). Note: `refreshResearchReportLoopGate` / `refreshResearchAcceptanceEvaluator` still EXIST in the research behavior files (pruned in Chunk C); these unit tests may import them directly — decide keep-as-pack-unit vs delete.

**Acceptance:** build + `npm test` green; `createRuntime({})` generic smoke green.

---

## Chunk B — Remove finalizeContract hooks (14 call sites) — BEHAVIOR CHANGE

**Call sites to delete:**
- `action-loop-plan.js`: import L16; L133–152 (4 calls: `observe`, `maybeContinueOnMissingAiReadiness`, `maybeContinueOnLimitedAiReadiness`, `maybeContinueOnReadinessConflict`).
- `action-loop-session-terminals.js`: import L9; `handlePlannerFinalDecision` L39–60 (5 calls); `handlePlannerFinalizeDecision` L82–103 (5 calls incl. `maybeContinueOnWorkspacePublishPath`).

**Approach:** each `maybeContinueOn*` currently returns `{ done: false }` / `{ action: "continue" }` to FORCE the loop to continue past the AI's terminal decision. Removing means: honor the AI's `final`/`finalize`/`synthesize` decision directly. Read each handler's full control flow and delete the hook block so the decision proceeds to its normal terminal path. `observe` is read-only with no consumer once the guards are gone — delete it too. Delete `kernel-finalize-contract.js` entirely. Remove `config.js` import L38 (`normalizeFinalizeContractHooks`) + wiring L127 (`finalizeContractHooks: ...`).

**Tests:** rewrite `test/unit/action-loop-session-terminals.test.js` L64–83 (was: asserts forced continue + `researchFinalizeContractStatus`) → assert the AI finalize decision is honored (terminal proceeds, no forced continue).

**Acceptance:** build + `npm test` green; rewritten terminal test green; one live research run (`node-agrun-3000-live.mjs`, see Chunk C for the spread removal) still produces a report end-to-end (quality may drop on weak models — accepted).

---

## Chunk C — Make @agrun/skills-research a pure portable skill

**Edits:**
- Delete `src/runtime/bundled-runtime-hooks.js`.
- Remove `bundledRuntimeHooks` export from the research barrel (`src/research-index.js` — confirm path; built to `packages/skills-research/dist/esm/research-index.js`).
- Prune now-dead behavior: `research-finalize-contract.js` is fully dead (its only entry was `bundledRuntimeHooks`). In `research-report-loop.js` the `refreshGate`/`noteSearchAttempt` halves are dead; in `research-acceptance-evaluator.js` the `refresh` half is dead. KEEP still-exported/used: `buildClaimEvidenceTable`, `evaluateResearchAcceptanceProgress`, `buildResearchEvidenceGraph` + graph helpers, `bundledAgentSkills`/`getBundledAgentSkill`, `bundledAgentRoles`/`getBundledAgentRole`.
- `test/unit/package-split-shape.test.js`: rewrite L43–48 (was: asserts `pack.bundledRuntimeHooks` with all 3 hook groups) → assert research pack ships skills-only (no `bundledRuntimeHooks`), mirroring coder-pack assertion L55.
- `test/node-agrun-3000-live.mjs`: remove the `...bundledRuntimeHooks` spread (~L170); keep `bundledAgentSkills` wiring (~L167).
- Rebuild the `packages/skills-research` package.

**Acceptance:** rewritten shape test green; `node-agrun-3000-live.mjs` runs wiring `bundledAgentSkills` only.

---

## Chunk D — Docs + browser example + live smoke + commit

- Write an ADR (supersede the kernel-seam decision in `micro-kernel-plugin-skills-rfc.md`): record the shift from "relocate enforcement behind the seam" to "delete enforcement, portable-skill-only." Note skills-coder was already compliant.
- Update `task.jsonl` with the completed chunks + evidence.
- Update `agrun_docs/` that describe the kernel-seam (e.g. `skill-system-architecture.md`, `agent-skills.md`) so they no longer advertise `bundledRuntimeHooks`.
- Integrate the latest logic into the browser example and confirm it runs (project rule: browser example must stay working after agrun changes).
- Run one live research smoke (deepseek or gemini per `.env.local`) to confirm end-to-end report production.
- `git commit` ONLY the files changed for this work (never `git add -A`).

---

## Biggest risk + detection

`finalizeContractHooks` were the only force-continue guard for weak models. Detection: run the 3000-word task SKILL.md-only (post-Chunk-B/C) and compare report **word count vs ~3000**, **successful `read_url` count**, **`sourceMinimum.passed`** against current behavior. gemini-flash / deepseek are where regression surfaces. Maintainer has accepted this; record the actual delta in Chunk D for the record.

## Open items (already resolved by maintainer 2026-06-09)

1. Relocate-vs-delete the finalize-contract behaviors → **DELETE** (incl. `maybeContinueOnWorkspacePublishPath`; at most a thin SKILL.md advisory note, no forcing).
2. Empty slots vestigial vs excised now → **keep vestigial** this round; excise later.
3. RFC status → amend via ADR in Chunk D.
