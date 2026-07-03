# H10 Pre-Assessment — terminal-repair-state.js Split Design + Coverage Map

**Date:** 2026-06-12 · **Task:** AGRUN-500 · **Status:** PRE-ASSESSMENT ONLY (zero code change). This document is the gate H10 must pass BEFORE any extraction commit. Source audit: [audits/codebase-runtime-audit-2026-06-10.md](./audits/codebase-runtime-audit-2026-06-10.md) (H10, deferred with preconditions).

---

## 1. Facts (verified 2026-06-12)

- `src/runtime/terminal-repair-state.js` is **3,138 lines, ~130 top-level functions, 16 exports**. It has grown since the audit (3,089 → 3,138; M13/AGRUN-493 invariant comments etc.).
- **No module-level mutable state.** All constants are frozen; all mutation happens on the passed-in `runState`. A mechanical move is therefore *feasible* — the hazards are ordering, not shared state.
- **Public API surface:** `src/index.js:79-86` re-exports **6** functions (`createTerminalRepairState`, `evaluateTerminalRepairState`, `isValidTerminalRepairPublishArgs`, `refreshTerminalRepairState`, `shouldEmitAdvisoryPersistenceSignalStep`, `summarizeTerminalRepairState`). Any split MUST keep the module path `./runtime/terminal-repair-state.js` resolving to all 16 exports (barrel), so `src/index.js`, all 7 internal consumers, and all test files need **zero edits**.
- **Internal consumers** (named imports, verified per file):

  | Consumer | Imports |
  |---|---|
  | `state.js` | createTerminalRepairState |
  | `action-loop-action.js` (door 1) | refreshTerminalRepairState, buildTerminalRepairRefreshedStepDetail, shouldEmitAdvisoryPersistenceSignalStep, buildBudgetRemainingForExpansionSignal, isValidTerminalRepairPublishArgs, explainTerminalRepairPublishArgs, isPublishProtocolRequiredActionForRepair |
  | `action-loop-plan-actions.js` (door 2) | refreshTerminalRepairState, buildTerminalRepairRefreshedStepDetail, shouldEmitAdvisoryPersistenceSignalStep |
  | `hooks/terminal-repair-hook.js` (door 3) | refreshTerminalRepairState, summarizeTerminalRepairState, shouldEmitAdvisoryPersistenceSignalStep, buildBudgetRemainingForExpansionSignal |
  | `planner-action-surface.js` | isPublishProtocolRequiredActionForRepair, isWorkspaceRepairInspectionActionForRepair |
  | `planner-prompt.js` | summarizeTerminalRepairState |
  | `actions/virtual-workspace-actions.js` | isValidTerminalRepairPublishArgs, isBudgetConstrainedForLimitedPublish |

- `refreshTerminalRepairState` is a **state transition** called at up to 3 lifecycle phases (preRequest / onResponse / per-action post on either door) — see the invariant block at `terminal-repair-state.js:98` (AGRUN-493). Caching it is incorrect; the split must not change call counts.

## 2. Coverage map (precondition 1 of the H10 deferral)

9 unit files cover this module, all auto-discovered by `smoke.test.js` (regression net intact). Main suite `terminal-repair-state.test.js` = 2,437 lines / 67 PASS cases spanning activation, deficits, publish protocol, escalation ladder (incl. AGRUN-307/309 escape valves), candidate quality, guardrail structure blocks.

**Per-export status: 14/16 covered; 2 untested; 4 weak.**

| # | Gap | Export | What's missing |
|---|---|---|---|
| G1 | UNTESTED | `buildTerminalRepairRefreshedStepDetail` | step-detail shape, array truncation, advisory null-coalescing — it is the SSOT step payload on BOTH doors (AGRUN-460), deserves its own test |
| G2 | UNTESTED | `getPublishProtocolRequiredActionForReason` | direct test of all 4 reason→action mappings |
| G3 | WEAK | `summarizeTerminalRepairState` | 1 case; add escalation=hard_veto / publishLoopEscapeGranted / inactive→null shapes |
| G4 | WEAK | `buildBudgetRemainingForExpansionSignal` | signal kind asserted once; content (gap/unit/observed/requested) and the 3 null-gates never asserted |
| G5 | WEAK | `isBudgetConstrainedForLimitedPublish` | never called directly; add budgetState low/exhausted/enough × escalation matrix |
| G6 | WEAK | `isOutputGuardrailStructureBlock` | exercised only via integration; add isolated test of the 8 code-keyword classes |

**Gap-fill = ~6 focused tests.** This is **Step 0** and is worth shipping even if the split never happens (it hardens today's behavior).

## 3. Module boundary design (amended from the audit's 4-module sketch)

Call-graph clustering confirms the audit's 4 clusters but adds two findings: (a) deficit-fact reading (`readRepairFacts` + ~13 helpers) is its own high-cohesion cluster consumed only by `evaluateTerminalRepairState`; (b) ~20 tiny read/normalize utilities are used by *every* cluster and must be a shared internal module to avoid duplication.

**Target layout — 5 internal modules + the existing path becomes a pure barrel:**

```
src/runtime/terminal-repair-state.js          ← BARREL ONLY (re-export everything; zero consumer edits)
src/runtime/terminal-repair/core.js           ← evaluate/refresh/create/clear, progress snapshot+diff,
                                                 resolveActiveRepairReason, thresholds, summarize, step detail
src/runtime/terminal-repair/facts.js          ← readRepairFacts + deficit builders/mergers/readers
                                                 (citation, readiness, guardrail blocks, budget state, todo/length/structure status)
src/runtime/terminal-repair/allowed-actions.js← buildAllowedActions + its ~22 orbit helpers, MOVED AS ONE BLOCK
src/runtime/terminal-repair/publish-contract.js← protocol SM (resolvePublishProtocolActionContract …),
                                                 publish args validation/explanation, valid-publish contract + args examples,
                                                 buildRequiredRepair
src/runtime/terminal-repair/signals.js        ← workspace repair signal, length expansion, advisory persistence,
                                                 action ordering signals, heading outline / section deltas / text stats
src/runtime/terminal-repair/internal-utils.js ← readRecord/readString/readStringArray/readNumber/readNullableNumber
                                                 + normalize* family (NOT exported from the barrel)
```

Cross-module imports after the split are exactly the existing cross-cluster call sites (verified): core→facts (1), core→allowed-actions (1), core→signals (4), core→publish-contract (2), allowed-actions→facts queries (4), allowed-actions→publish-contract (2), everyone→internal-utils. No cycles: dependency order is `internal-utils ← {facts, publish-contract, signals} ← allowed-actions ← core ← barrel`.

## 4. Hazards (why "mechanical" still needs discipline)

1. **`buildAllowedActions` (≈356 lines, 60+ branches) is order-load-bearing** (hard-veto before budget before protocol before deficit combos). It moves **verbatim as a single block** — any "tidy while moving" is forbidden.
2. **Snapshot-before-diff ordering** in `evaluateTerminalRepairState` (`createProgressSnapshot` → … → `diffProgress`) is load-bearing for ignoredCount progression (the AGRUN-307/309/310 churn escape).
3. **Three-door refresh parity** (AGRUN-460): door wiring itself doesn't change, but every extraction PR must rerun `terminal-repair-runtimeconfig-parity.test.js` + `terminal-repair-refresh-phase-guard.test.js` explicitly.
4. **History:** this file yielded 2 latent bugs in AGRUN-459. Treat every step as high-risk regardless of how mechanical it looks.
5. **Fold-in temptations are OUT OF SCOPE for the move PRs:** M13's intra-call redundancy (progress snapshot vs readRepairFacts re-reads) and AGRUN-421's `ignoredCount === 3` magic number (→ `resolveTerminalRepairThresholds`) are *follow-up* changes AFTER the split settles, each with its own test.

## 5. Execution plan (if/when GO is given)

One small PR per step; suite + `dist:check` green at every step; live `session`+`planner` spot-check after the last step.

| Step | PR scope | Verify |
|---|---|---|
| 0 | Gap-fill the 6 tests of §2 (no src change) | suite green, new tests fail when target neutered |
| 1 | Extract `internal-utils.js` | suite green |
| 2 | Extract `publish-contract.js` | suite + parity tests |
| 3 | Extract `signals.js` | suite green |
| 4 | Extract `facts.js` | suite green |
| 5 | Extract `allowed-actions.js` (verbatim block) | suite + full escalation cases |
| 6 | Reduce `terminal-repair-state.js` to barrel (+`core.js`) | suite + dist:check + live e2e spot-check |

Estimated effort: ~7 small PRs. Rollback unit = one PR.

## 6. Recommendation (unchanged from the audit deferral)

**Default: DO NOT proceed past Step 0.** The split is a pure structural refactor with zero behavioral benefit, against the repo's highest-risk file. **Step 0 (gap-fill tests) is recommended now**; Steps 1–6 only when a concrete driver appears (e.g. a feature must modify `buildAllowedActions` or the publish contract, and the 3,138-line file demonstrably blocks it). This document removes the *planning* cost from that future decision — the remaining cost is execution + review risk only.

## 7. EXECUTED (2026-06-12, user-directed) — ladder complete

The user explicitly chose to run the full ladder. All steps shipped, one PR each, every step verified **by exit code** (suite + build + `dist:check`; live `session` 3/3 + `planner` 8/8 with real keys against the fresh dist after Step 6):

| Step | Task / PR | Module | Decls |
|---|---|---|---|
| 0 | AGRUN-502 / #114 | gap-fill tests (16/16 exports direct-tested) | — |
| 1 | AGRUN-503 / #115 | `internal-utils.js` (579 L) | 46 |
| 2 | AGRUN-504 / #116 | `publish-contract.js` (505 L) | 19 |
| 3 | AGRUN-505 / #117 | `facts.js` (573 L) | 23 |
| 4 | AGRUN-506 / #118 | `signals.js` (439 L) | 16 |
| 5 | AGRUN-507 / #119 | `allowed-actions.js` (650 L) | 17 |
| 6 | AGRUN-508 / #120 | `core.js` + pure barrel | 15 |

**Execution-time amendments to §3 (both dependency-forced, documented in the step PRs):**
1. `createTerminalRepairState` + the threshold consts/`resolveTerminalRepairThresholds` live in `internal-utils.js`, not core — `publish-contract.js` needs the constructor and the graph must stay acyclic.
2. `facts.js` extracted **before** `signals.js` — `buildWorkspaceRepairSourceSummary` (signals) calls `readAcceptancePacket`/`readSourceMinimum` (facts). Final order: `internal-utils ← publish-contract ← facts ← signals ← allowed-actions ← core ← barrel`.

**Method:** every move was a scripted line-range cut (bodies never retyped); `buildAllowedActions` (357 L) was diffed **byte-identical** against HEAD before the Step 5 commit. `terminal-repair-state.js` is now a 41-line pure barrel re-exporting the same 16 names; `src/index.js`, all 7 runtime consumers, and every test were untouched throughout.

The §6 recommendation stands as written for FUTURE god-objects; for this one the decision was the user's, and the ladder held: zero behavior change, zero consumer edits, suite green at every rung.
