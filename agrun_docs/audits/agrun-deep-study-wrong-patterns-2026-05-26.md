# agrun Deep Study — What We Do Wrong (2026-05-26)

## Purpose

Session 2026-05-26 deep architecture audit: full codebase scan, KB recall,
ADR review, task.md analysis, and LLM-call-count verification. Findings
organized into 4 root-cause themes.

---

## Theme 1 — AI-first principle violated

**Root decision pattern:** runtime engineers write hardcode gates when they
want to constrain AI behavior, instead of surfacing state signals and letting
AI judge.

### Evidence

| Site | Violation | Status |
|------|-----------|--------|
| `planner-prompt.js` `BASE_SYSTEM_LINES` / `COMPACT_SYSTEM_LINES` | ~150 lines of opinionated prompt directives buried in JS string arrays; no host-override path; engineers must grep `dist/agrun.js` to read them | ADR-0035 OPEN — 0 lines of implementation |
| `planner-prompt.js:57` | `readOnlyPlanningState` directive hardcoded 6-item action list instead of using the 9-item SSOT constant | **Fixed 2026-05-26** (this session) |
| `planner-native-system-prompt.js:36` | Same `readOnlyPlanningState` list, same SSOT bug, still hardcodes 7 items (missing `list_agent_skills`, `read_agent_skill`, `use_agent_skill`) | Pending (AGRUN-262 pre-Phase-3) |
| AGRUN-246-K | Wrote hardcode quality gate for search query diversification | Rolled back — hardcode violation |
| AGRUN-246-L | Wrote second hardcode quality gate, different shape | Rolled back again — hardcode violation |
| AGRUN-246-N | Third attempt at same problem | OPEN — waiting for correct AI-first shape |

### Root cause

The team knows "no hardcode" but defaults to hardcode when they want to **force
a quality constraint** the model isn't reliably applying. The real fix is:
expose the quality signal as AI-observable loopState, let AI decide, and
measure whether AI obeys. The 246-K/L/N cycle proves that without a quality
baseline, the team can't verify whether the signal is effective — so they
revert to gates.

### Fix

1. Implement ADR-0035 (AGRUN-262): extract prompts → `src/runtime/prompts/`
   with `runtimeConfig.prompts` host-override API.
2. Fix `planner-native-system-prompt.js:36` SSOT bug (AGRUN-262 pre-Phase-3).
3. Resolve AGRUN-246-N by exposing `queryAngle`/`queryIntent` as AI-authored
   fields on search observations — let AI diversify, let baseline verify.

---

## Theme 2 — Complexity debt

**Root decision pattern:** each new convergence/repair/evaluator feature gets
its own file instead of being merged into an existing evaluator. Total file
count has grown past single-engineer maintainability boundary.

### Evidence

| Metric | Value |
|--------|-------|
| `src/runtime/` file count | 181 JS files |
| Largest file — `terminal-repair-state.js` | 1964 lines |
| `action-pattern-convergence.js` | 1770 lines |
| `planner-prompt.js` | 1361 lines |
| `final-response-prompt.js` | 532 lines |

### LLM calls per cycle (verified 2026-05-26)

| Path | LLM calls | Source file |
|------|----------:|-------------|
| Base (every cycle) | 1 | `action-loop-planner.js` → `requestPlanner` |
| `finalize` path | +1 | `runtime-finalize.js` → `requestFinalizerProviderResponse` |
| Repair path | +1–2 | `planner.js` → `requestPlannerEnvelopeRepair` |
| Plan synthesis | +1 | `action-loop-plan-synthesize.js` → `requestProviderCompletion` |
| Semantic judge | +1 | `semantic-judge.js` → `requestProviderCompletion` |
| **Worst case** | **5** | — |

opencode comparison: 1 LLM call per cycle (no repair/synthesis paths).
agrun is 5× heavier per cycle in worst case.

### Fix

- No immediate refactor required — complexity debt is a maintenance risk,
  not a correctness bug.
- Long-term: ADR-0035 (prompt extraction) reduces `planner-prompt.js` size.
- AGRUN-260 (collapse LLM evaluators to rule-based fast-paths) targets
  the 5-call-per-cycle overhead.

---

## Theme 3 — Production quality gap

**Root decision pattern:** quality verification is manual and deferred.
No automated cross-model baseline means every ADR lands without knowing
whether it improved or regressed weak-model performance.

### Evidence

| Signal | Value |
|--------|-------|
| `gemini-3.1-flash-lite` strict pass rate (7 test cases) | **43% (3/7)** |
| Cross-model baseline status | **PAUSED** (battery/resource constraint 2026-05-25) |
| AGRUN-246-K/L: rejected after implementation | No baseline to verify effect |
| AGRUN-255 acceptance criterion (`spawn_subagent` e2e) | Not verified — tool approval gate untested |

### Root cause

Running the full cross-model baseline costs real API tokens and takes
time. Without it, team decisions are made on intuition about model behavior
instead of data. The 43% flash-lite pass rate means the canonical harness
fails the canonical weak model more than half the time — but the exact
failure mode is not known because the baseline is paused.

### Fix

1. Resume cross-model baseline with a minimal smoke set (3 cases minimum).
2. Lock pass/fail counts as regression thresholds — any PR that drops
   flash-lite from 3/7 → 2/7 is a regression, not just a "quality concern."
3. AGRUN-246-N solution must be verified against the smoke baseline before
   merge.

---

## Theme 4 — Observability gap

**Root decision pattern:** inspector shows parent session events but child
sessions and multi-LLM-call cycles are invisible.

### Evidence

| Missing capability | Ticket | Status |
|-------------------|--------|--------|
| SSE typed event bus (real-time event push to host UI) | AGRUN-255 | OPEN |
| Per-message JSON storage (durable session messages) | AGRUN-256 | OPEN |
| Compaction as real session turn | AGRUN-257 | OPEN |
| Debug CLI | AGRUN-258 | OPEN |
| Child session (`spawn_subagent`) observability | AGRUN-259 follow-up | OPEN |

### Concrete impact

After ADR-0037 shipped `spawn_subagent`:
- Parent inspector shows `spawn_subagent` action with `status: completed/failed`.
- Child session's individual cycles (what it searched, what it read, why it
  failed) are invisible — child events are intentionally isolated
  (ADR-0037 Decision 5).
- Without SSE (AGRUN-255), host UI cannot stream child events even if they
  are made available.
- Without per-message storage (AGRUN-256), session replay is impossible.

The 5-LLM-calls-per-cycle finding from Theme 2 is also unobservable:
the inspector shows 1 provider call per cycle, but the finalizer/repair/
synthesis calls are separate steps not surfaced as "cycle overhead."

### Fix

1. AGRUN-255 (SSE) — highest priority; enables all other observability.
2. AGRUN-256 (per-message storage) — durable session replay.
3. After SSE: expose child session events via the typed event ledger
   (AGRUN-248-C infrastructure) with `parentSessionId` filter.

---

## Summary table

| Theme | Root pattern | Severity | Current fix ticket |
|-------|-------------|----------|--------------------|
| AI-first violated | Hardcode gates instead of AI-observable signals | P0 | AGRUN-262 (ADR-0035) |
| Complexity debt | Feature-per-file growth, no consolidation | P2 | AGRUN-260 (LLM evaluators) |
| Quality gap | No automated cross-model baseline | P1 | Resume baseline first |
| Observability gap | No SSE, no child session visibility | P1 | AGRUN-255, 256 |

---

## Artifacts

- `agrun_docs/adr/0035-prompt-content-as-host-overridable-defaults.md`
- `agrun_docs/audits/prompt-content-leak-surface-2026-05-25.md` (updated 2026-05-26)
- `task.md § AGRUN-262` (new ticket)
- `agrun_docs/audits/agrun-cross-model-baseline-paused-2026-05-25.md`
- `task.md § AGRUN-255, 256, 257, 258, 259, 260`

## Session commits (2026-05-26)

- `34e44ddfc` — SSOT fix (`planner-prompt.js:57`) + AGRUN-262 docs
