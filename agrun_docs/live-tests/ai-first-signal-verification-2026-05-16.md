# AI-First Signal Verification — 2026-05-16

## Goal

Verify with a real Node live e2e + jsonl/md trace that the agrun runtime emits `terminal_repair_*` as **observations / state-refresh signals** to the planner, not as runtime force-finalize actions. Verify the AI authors all publish / finalize decisions itself.

This run was triggered by the 2026-05-16 doc-code drift goal which assumed multiple pieces of the documentation overstated push-mode behavior. Fact-check before execution narrowed the punch list to:

- ✅ SSOT extraction of "Terminal repair mode is active..." strings into `src/runtime/terminal-repair-strings.js`.
- ✅ `feature-toggles.md` Session Budget wording updated to remove "honest forced finalize" (matches code's signal-only path — see `action-loop-session-loop.js:121-122` tombstone).
- ✅ `task.md` header timestamp bumped to 2026-05-16.
- ⛔ `approval-flow.md:195` "forces a finalize decision" — **SKIPPED, NEEDS_APPROVAL.** The doc accurately describes `src/runtime/approval.js:256-281` which still calls `executeRuntimeFinalize` after `MAX_CONSECUTIVE_DENIALS=2`. Rewriting the doc to AI-first wording without first deleting the code path would create reverse drift. A separate ADR (proposed: ADR-0031) is required to delete the push-mode site and then update the doc.
- ⛔ `planner-architecture.md:~65` — **SKIPPED.** Line 65 contains the "Final Decision" heading, not force language. The "forces `finalize`" language at line 208 (Reusable tool result guard) is still consistent with `src/runtime/config.js:91 preferFinalizeOnLastResult` which is an active host-toggleable config, not stale doc.
- ⛔ git add 3 uncommitted live-test traces — **SKIPPED, false premise.** `git ls-files --others --exclude-standard agrun_docs/live-tests/` returned zero. No untracked trace files exist.

## Command

```bash
AGRUN_DEBUG=1 \
NODE_AGRUN_LIVE_WORDS=1000 \
NODE_AGRUN_LIVE_MAX_STEPS=40 \
npm run test:live:node-3000
```

Model: `gemini-3-flash-preview` (from `.env.local`).

## Run summary

| Field | Value |
|---|---|
| Artifact (jsonl) | `agrun_debug_runs/2026-05-16T13-00-56-028Z.jsonl` |
| Artifact (md) | `agrun_debug_runs/2026-05-16T13-00-56-028Z.md` |
| runStatus | `failed` |
| runError.code | `MAX_STEPS_EXCEEDED` |
| terminalizedBy | `""` (run did not reach a terminal output) |
| candidateWords | 1106 / 1000 requested  ✓ |
| finalCandidateStructureOk | `true`  ✓ |
| sourceMinimum.passed | `true` (3 reads / 3 relevant)  ✓ |
| successfulReadUrlCount | 3  ✓ |
| terminalRepairState.active (final) | `false` |
| Action counts (top) | `workspace_write` ×7, `workspace_finalize_candidate` ×4, `workspace_replace` ×4 |
| `workspace_publish_candidate` count | 1 (did not terminalize) |

## Signal-mode verification (the actual goal of this trace)

### 1) `terminal_repair_*` is a state-refresh signal, not a runtime force action

`grep -oE '"type": "[^"]*terminal[^"]*"'` against the markdown debug trace returned **112 occurrences of a single step type**:

```
112 "type": "terminal-repair-state-refreshed"
```

Zero `terminal-repair-preflight-block` events fired in this run (the AI followed the protocol surface and never tripped a block). Each `terminal-repair-state-refreshed` entry is a **read-only state mutation** the planner observes on the next cycle. Sample shape (line 3076-3090 of the md):

```json
{
  "actionName": "todo_run_next",
  "active": true,
  "activeDeficits": ["todo"],
  "allowedActions": ["todo_advance", "todo_cancel", "todo_run_next", "workspace_publish_candidate"],
  "status": "terminal_repair",
  "type": "terminal-repair-state-refreshed"
}
```

The runtime *exposes the allowed surface* (a list of action names + active deficits) and *the planner chooses* from it on the next cycle. There is no path here where the runtime calls `executeRuntimeFinalize` based on terminal repair state. Confirmed by inspection: `grep -n "executeRuntimeFinalize" src/runtime/` shows the only call sites are `runtime-finalize.js` itself, `action-loop-session-terminals.js:111` (handles `decision.type === "finalize"` authored by the AI), and `approval.js:262` (the consecutive-denial push-mode residue called out above as SKIPPED).

**Verdict: PASS for terminal-repair signal mode.**

### 2) Approval denial → AI authors publish_limited (no auto-finalize)

This run does **not exercise the approval denial path** — no approval prompt was issued during the live e2e (the deep-research prompt does not require approval). The "approval denial → AI decides publish_limited" criterion is therefore **untestable in this run shape**.

Static evidence regarding the criterion:

- `src/runtime/approval.js:256-281` still calls `executeRuntimeFinalize` with a hardcoded instruction string after `MAX_CONSECUTIVE_DENIALS=2`. This is a **real runtime force-finalize** site that survived ADR-0023 / ADR-0026.
- To make the criterion verifiable, that push-mode site must first be deleted (signal-only replacement) per a follow-up ADR, then re-run a live with an injected denial path.

**Verdict: NOT-VERIFIABLE in this run; static code review fails the criterion.** Tracked as proposed ADR-0031.

### 3) SSOT extraction landed cleanly

```
$ grep -rn '"Terminal repair mode is active' src/runtime/
src/runtime/terminal-repair-strings.js:34: ...
src/runtime/terminal-repair-strings.js:48: ...
```

Zero residuals in `action-loop-action.js` or `action-loop-session-loop.js`. Both files now `import { DEFAULT_TERMINAL_REPAIR_STRINGS }` from the SSOT module.

**Verdict: PASS for SSOT.**

### 4) npm test smoke green

```
$ npm test
...
Push-mode invariants concern tests passed.
```

All test suites pass after the SSOT extraction.

**Verdict: PASS.**

### 5) `force-finalize` / `honest forced` residual scan

```
$ grep -n "honest forced\|forces a finalize\|forces finalize" agrun_docs/feature-toggles.md
(no output)

$ grep -n "honest forced\|forces a finalize" agrun_docs/approval-flow.md
agrun_docs/approval-flow.md:29:  (or force finalize after 2 consecutive denials)
agrun_docs/approval-flow.md:195: ... the runtime forces a `finalize` decision ...

$ grep -n "honest forced\|forces a finalize\|forces.*finalize" agrun_docs/planner-architecture.md
agrun_docs/planner-architecture.md:208: ... forces `finalize` to prevent infinite loops ...
```

`feature-toggles.md` is clean. `approval-flow.md` and `planner-architecture.md` still mention the force paths — kept deliberately because they accurately describe the still-present code paths (`approval.js` denial guard; `config.preferFinalizeOnLastResult` toggle). Removing the wording without removing the code would be reverse drift.

**Verdict: PARTIAL.** Three of three docs were checked; one was cleaned; two were intentionally left because they accurately describe code that has not yet been refactored to signal-only.

## Overall pass / fail per goal criteria

| Goal criterion | Status | Notes |
|---|---|---|
| jsonl shows `terminal_repair_*` as observation, not force | ✅ PASS | 112 `terminal-repair-state-refreshed` step events; no preflight blocks tripped; no `executeRuntimeFinalize` from this path. |
| Approval denial → AI authors publish_limited | ⛔ NOT-VERIFIABLE | Test prompt does not exercise approval. Static code review shows push-mode residue. |
| New `terminal-repair-strings.js` used by both call sites; old strings 0 residue | ✅ PASS | grep verified. |
| `npm test` smoke all green | ✅ PASS | Full suite. |
| 3 docs no `force-finalize` / `honest forced` residue | ⛔ PARTIAL | `feature-toggles.md` cleaned; other two intentionally kept (accurate). |
| dist synced; `npm run build` ran first | ✅ PASS | Build + dist:check (169 markdown) before live. |
| 1000/40 smoke green → 3000/80 full run | ❌ FAIL | 1000/40 hit `MAX_STEPS_EXCEEDED` despite all content criteria met (1106 words ≥ 1000, structure OK, sources passed). Same exhausted-budget-publish failure pattern as 2026-05-16 prior runs. Per goal Stop condition "中间挂任一条不许往下走", **3000/80 was NOT executed.** |

## Honest Bad Result (HBR)

- **The 1000/40 smoke ran failed at the terminal stage despite producing all required content.** The trace shows the model emitting 6 consecutive `workspace_finalize_candidate` calls at end-of-budget instead of converging on `workspace_publish_candidate` with a valid `finalReadiness`. This is the same exhausted-budget convergence gap ADR-0030 (drafted earlier on 2026-05-16) is designed to address by exposing a prospective `exhaustedBudgetPublishContract`. ADR-0030 remains NEEDS_APPROVAL.
- The "approval denial → publish_limited" criterion in the goal is **not currently testable on agrun** because the runtime still force-finalizes via `approval.js:256-281` after 2 consecutive denials. The doc reflects this truth. A separate ADR-0031 (proposed) is required to migrate this site to a signal-only design, after which the criterion would become verifiable.
- 3000/80 was not run because the smoke was not green. This respects the goal's "中间挂任一条不许往下走" hard rule rather than burning Gemini API quota on a known harder failure mode.

## Token / latency cost

The 1000/40 run consumed 39 cycle planner calls plus tool calls. Per `node_agrun_live_summary` event the run did not record a final cost ledger (no terminal output). Roughly: ~40 planner round-trips × low-mid tokens each → estimated < $0.10 against `gemini-3-flash-preview` pricing. Negligible.

## Recommendations

1. **(Best)** Get approval to ship ADR-0030 (exhausted budget publish contract). Re-run the 1000/40 ladder; expect the model to converge on a single valid `workspace_publish_candidate` once it sees the prospective `requiredGapKeywords` / `requiredGapPhrases` block in the planner prompt.
2. Draft ADR-0031 to delete `approval.js` consecutive-denial push-mode site. Replace with `runState.consecutiveDenialSignal`. After it ships, this trace file can be re-run with a denial-injection harness to satisfy criterion #2.
3. Consider tightening the `npm run test:live:node-3000` harness to fail fast and emit a structured summary when the run is "all dimensions met but terminalizedBy empty" — current shape requires manual jsonl inspection.
