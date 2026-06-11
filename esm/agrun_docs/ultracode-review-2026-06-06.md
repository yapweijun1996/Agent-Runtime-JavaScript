# Ultracode Codebase Review — 2026-06-06

**Scope**: 12 critical runtime files reviewed, AI-first compliance audit, test coverage audit, new test file review  
**Method**: 17-agent ultracode workflow (pipeline + parallel phases)  
**Results**: 106 issues found, 17 new AGRUN tickets created, 11 KB-MCP memories saved

---

## Executive Summary

1. **OODAE Phase Tracking Gap (CRITICAL)**: Regular actions NEVER complete the act/evaluate cycle phases — only plan/finalize/approval paths do. The most common execution path produces permanently incomplete cycle records.

2. **Gate Interaction Bugs**: `planner-action-surface.js` has a critical bypass where `readyWorkspacePublishOnly` early-return skips all hard-veto convergence signals. `terminal-repair-state.js` has `isOutputGuardrailStructureBlock` returning true for ANY guardrail block when pre-existing structure exists.

3. **AI-First Audit: CLEAN for Decision Logic**: Zero new regex-on-prompt patterns, zero new hardcoded model/provider names, zero new push-mode patterns. The uncommitted changes are AI-first compliant (diagnostic observability, not AI decisions).

4. **AI-First Violations in Observation Layer**: Runtime mutates AI-declared state in `virtual-workspace-actions.js` (`checkedWorkspaceStats` override, evidence count mid-audit correction) and `output-guardrail-recipes.js` (silent LLM verifier failures, no timeout).

5. **Test Coverage at 54.1%**: 10 highest-risk files have zero coverage, including `action-loop-session-loop.js` (849-line core loop, recently modified), `errors.js` (imported by 13 files), `planner-repair.js` (521 lines, critical to agent recovery). 5 files are potentially dead code (zero imports).

---

## Top 5 Critical Issues

| Rank | Issue | Severity | Files | Description |
|------|-------|----------|-------|-------------|
| 1 | **OODAE act/evaluate phases never complete for regular actions** | CRITICAL | `action-loop-session-loop.js`, `action-loop-action.js` | Only plan/finalize/approval paths complete act/evaluate. Regular actions via `executeAction()` produce null cycleRecord.act and cycleRecord.evaluate. |
| 2 | **readyWorkspacePublishOnly bypasses hard-veto signals** | CRITICAL | `planner-action-surface.js` L59-61 | The early return for ready-publish-only narrows to a single publish action, skipping `readOnlyPlanningForbiddenActions`, `workspaceMutationGrowthForbiddenActions`, and `structureRepairForbiddenActions` checks. |
| 3 | **isOutputGuardrailStructureBlock false-structure deficit** | HIGH | `terminal-repair-state.js` L816-830 | Returns true for ANY guardrail block when pre-existing structure observation exists. Language bias or image dimension guardrails incorrectly trigger structure deficits. |
| 4 | **checkedWorkspaceStats overrides AI-declared false to true** | HIGH | `virtual-workspace-actions.js` L1761-1770 | Runtime silently overrides AI's own checklist status. Violates AI-first principle: runtime should surface signal, not mutate AI fields. |
| 5 | **extractMarkdownSectionText regex too narrow** | HIGH | `action-pattern-convergence.js` L1039-1066 | Strict regex misses setext headings, closing #, HTML headings. Returns empty string → hashStructureSection returns null → false-positive "section rewritten" clears at L1113. |

---

## Architectural Debt Themes

### 1. OODAE Phase Tracking Gap
**Files**: `action-loop-session-loop.js`, `action-loop-action.js`  
Regular (non-terminal, non-plan) actions never complete the OODAE act or evaluate phases. Only specialized paths (plan, finalize, approval) have complete phase tracking via external modules. This means the cycle record is permanently incomplete for the most common execution path.

### 2. AI-First Boundary Violations in Observation Code
**Files**: `virtual-workspace-actions.js`, `output-guardrail-recipes.js`  
Runtime mutates AI-declared state: `checkedWorkspaceStats` override, evidence count mid-audit correction, `aiVerifierGuardrail` silently swallows LLM failures, no timeout around verifier calls.

### 3. Duplicated `readString` Utility
**Files**: `action-loop-failure.js`, `invalid-action-convergence.js`, `planner-recovery.js`  
Identical `readString` defined privately in 3 closely-related files. Any normalization change must be replicated across all copies.

### 4. Dead Code and Orphaned State Fields
**Files**: `action-pattern-convergence.js`, `terminal-repair-state.js`  
`isReadOnlyPlanningPreflightBlock` (never called), `isStructureImproved` (diverged from actual logic), `consecutiveExecutedPublishCount` (computed but never read). `version` fields (×3) written but never read for migration.

### 5. Inconsistent Observation and Action Tracking Shapes
**Files**: `action-loop-session-loop.js`, `action-loop-action.js`  
`runState.observation` shape varies across 3+ guard paths. `runState.lastAction` not consistently updated — 6 guard paths fail to set it.

### 6. Hardcoded Constants and Undocumented Limits
**Files**: `planner-action-surface.js`, `config.js`, `terminal-repair-state.js`  
Fixed budget threshold of 10 steps, magic source minimum of 3, `HARD_MAX_PLAN_ACTIONS` throws without rationale, 3 config fields skip normalization.

### 7. Critical Test Coverage Gaps
**Files**: 10 files with zero coverage (see below)  
54.1% coverage (100/185 runtime files). Highest risk: `action-loop-session-loop.js`, `errors.js`, `planner-repair.js`, `action-loop-failure.js`, `action-loop-utils.js`, `utils.js`. 5 files have zero imports (potentially dead code).

---

## New AGRUN Tickets

### P0 (Must Fix)
| ID | Title | Files |
|----|-------|-------|
| AGRUN-400 | Complete OODAE act/evaluate phase tracking for regular actions | `action-loop-session-loop.js`, `action-loop-action.js` |
| AGRUN-401 | Fix isOutputGuardrailStructureBlock early-return bug | `terminal-repair-state.js` |

### P1 (Should Fix)
| ID | Title | Files |
|----|-------|-------|
| AGRUN-402 | Remove AI-first violations in inspectPublishReadiness | `virtual-workspace-actions.js` |
| AGRUN-403 | Fix extractMarkdownSectionText regex for non-standard headings | `action-pattern-convergence.js` |
| AGRUN-404 | Broaden proactiveBudgetRepair to all deficit types | `terminal-repair-state.js` |
| AGRUN-411 | Fix nearDuplicateSectionsGuardrail heading hierarchy FPs | `output-guardrail-recipes.js` |

### P2 (Important)
| ID | Title | Files |
|----|-------|-------|
| AGRUN-405 | Normalize observation shape across guard paths | `action-loop-session-loop.js` |
| AGRUN-406 | Remove dead code and orphaned state fields | `action-pattern-convergence.js`, `terminal-repair-state.js` |
| AGRUN-407 | Extract duplicated readString to shared utility | 4 files |
| AGRUN-408 | Add unit tests for 10 highest-risk uncovered files | 6 files |
| AGRUN-409 | Fix heading text normalization inconsistency | `output-guardrail-recipes.js` |
| AGRUN-410 | Fix collectSectionRehashIssues early-return | `output-guardrail-recipes.js` |
| AGRUN-412 | Add timeout/error callback to aiVerifierGuardrail | `output-guardrail-recipes.js` |
| AGRUN-413 | Fix readBudgetState proportional threshold | `terminal-repair-state.js` |
| AGRUN-414 | Fix citation metric naming mismatch | `candidate-quality-signal.js` |
| AGRUN-415 | Fix resolveStructureRepairForbiddenActions escalation | `planner-action-surface.js` |

### P3 (Nice to Have)
| ID | Title | Files |
|----|-------|-------|
| AGRUN-416 | Clean up dead API surface in resolvePlannerMode | `planner.js`, `provider-capabilities.js` |

---

## Test Coverage Audit

**Overall**: 54.1% (100 of 185 src/runtime/ files have dedicated tests)

### Highest Risk Uncovered Files (P2 priority)

| File | Risk | Lines | Imported By | Notes |
|------|------|-------|-------------|-------|
| `action-loop-session-loop.js` | HIGH | 849 | 1+ | Core session loop, recently modified |
| `errors.js` | HIGH | ~80 | 13 | Shared error infrastructure |
| `action-loop-failure.js` | HIGH | 225 | 5 | Recently modified failure path |
| `planner-repair.js` | HIGH | 521 | 2 | Critical to agent recovery |
| `action-loop-utils.js` | HIGH | ~100 | 6 | Recently modified, shared code |
| `utils.js` | HIGH | ~150 | 45 | Most-depended-upon module |
| `task-state.js` | HIGH | ~200 | 8 | Task lifecycle state |
| `final-readiness.js` | HIGH | ~250 | 8 | Determines termination readiness |
| `finalizer.js` | HIGH | ~200 | 7 | Finalization pipeline |
| `run-loop.js` | HIGH | 175 | 2 | Core runtime orchestrator |

### Potentially Dead Code (Zero Imports)
- `failure-outcome.js` (87 lines)
- `multimodal.js` (186 lines)
- `output-guardrail-recipes.js` (494 lines) — imported via `index.js` for host use
- `semantic-memory.js` (111 lines)
- `todo-auto-planner-guidance.js` (16 lines)

---

## AI-First Compliance Audit

**Verdict: CLEAN**

- `node test/unit/no-regex-on-prompt.test.js` — PASS
- Zero new hardcoded model/provider names found
- Zero new push-mode patterns found in hotspot files
- `ALLOWLIST_MAX` in no-regex-on-prompt.test.js accurately reflects current codebase
- Uncommitted `action-loop-failure.js` changes are AI-first compliant (diagnostic observability, not decisions)
- `action-loop-session-loop.js` adds `runDeadlineMs` as host-configurable opt-in safety mechanism

---

## Uncommitted Changes Review

### `src/runtime/action-loop-failure.js` (+43 lines)
**Verdict: APPROVED** — High quality, AI-first compliant. Adds diagnostic fields (`invalidKind`, `rejectedActionName`, `repairAttempted`, `responsePreview`) to `planner-invalid-action` step events. Directly addresses TNO benchmark blind spot.

Minor concern: `readString()` is duplicated across 3 files (existing codebase pattern, not new).

### `test/smoke.test.js` (+24 lines)
**Verdict: APPROVED** — Three new smoke tests correctly registered: `runPlannerInvalidActionDiagnosticSmoke`, `runBenchMetricsSalvageSmoke`, `runRunDeadlineSmoke`.

### `test/helpers/bench-metrics.mjs` (NEW)
**Verdict: APPROVED** — Clean SSOT extraction. `PRICING` table + `computeCost` + `salvageMetricsFromProgress`. Minor: `PRICING` not `Object.freeze`'d.

### `test/unit/bench-metrics-salvage.test.mjs` (NEW)
**Verdict: APPROVED** — 5 cases covering rich JSONL, torn lines, missing files, no-signal files, bad input. Minor: missing `try/finally` cleanup, `lastElapsedMs` untested.

### `test/unit/planner-invalid-action-diagnostic.test.js` (NEW)
**Verdict: APPROVED** — 3 cases: native tool call, malformed text, long body truncation. Minor: Case 3 uses `<= 2000` instead of exact bound.

---

## Verification

```bash
npm test                          # Full suite green (baseline confirmed)
node test/unit/no-regex-on-prompt.test.js  # AI-first guard green
git status --short                # 7 changed files, 3 new untracked
```

---

## Next Steps

1. **Immediately**: Fix AGRUN-400 (OODAE phase gap) and AGRUN-401 (isOutputGuardrailStructureBlock bug) — these are the P0 issues
2. **This sprint**: Implement P1 tickets AGRUN-402-404, AGRUN-411
3. **Next sprint**: P2 tickets for test coverage (AGRUN-408), dead code removal (AGRUN-406), DRY fixes (AGRUN-407)
4. **Continuous**: Raise test coverage from 54.1% to 65%+ by adding tests for the 10 highest-risk uncovered files

---

*Generated by Ultracode Workflow (17 agents, 1.4M tokens, 8.3 min) — 2026-06-06*
