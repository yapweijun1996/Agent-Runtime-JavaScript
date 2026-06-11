# E2E v11/v12/v13 — AGRUN-237-GAP-01 HIGH_WATER_MARK Validation (2026-05-19)

## Run Config
- Model: `gemini-3.1-flash-lite`
- plannerMode: `envelope`
- maxSteps: 90
- Command: `GEMINI_MODEL=gemini-3.1-flash-lite NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs`

## AGRUN-237-GAP-01 Two-Part Fix

### Fix 1 — `src/runtime/terminal-repair-state.js`
```js
// NEW constant
const TERMINAL_REPAIR_HIGH_WATER_MARK = 6;

// CHANGED escalation condition
const escalation =
  (ignoredCount >= TERMINAL_REPAIR_HARD_VETO_THRESHOLD && facts.budgetState === "exhausted") ||
  ignoredCount >= TERMINAL_REPAIR_HIGH_WATER_MARK
    ? "hard_veto"
    : "advisory";
```

### Fix 2 — `src/runtime/action-loop-session-loop.js`
**Root cause discovered via v11 E2E:**

There are TWO separate code paths that block `finalize` during terminal repair:

| Path | Function | File | Had escalation check? |
|---|---|---|---|
| Direct decision | `maybeBlockDirectTerminalDuringRepair` | `action-loop-session-loop.js` | ❌ NO |
| Action preflight | `maybeBlockTerminalRepairAction` | `action-loop-action.js` | ✓ YES (PR 2) |

`maybeBlockDirectTerminalDuringRepair` fires when `decision.type === "final"|"finalize"` BEFORE action execution. It **never checked escalation** — always pushed `"terminal-repair-direct-terminal-blocked"` regardless of ignoredCount. This is why v11 showed ignoredCount reaching 29 with no hard_veto.

Fix: added `isHardVeto = readString(repair.escalation) === "hard_veto"` check. When true, pushes `"terminal-repair-hard-veto-blocked"` + `hardVetoActionNotAllowed` message.

**dist rebuild required** — live tests use `dist/agrun.js` bundle, not `src/` directly.

## v11 Result — FAIL (pre-fix dist, stale bundle)
ignoredCount reached 29 by cycle 72 with NO hard_veto event. Confirmed the session-loop gap.

## v12 Result — FAIL (fix 1 only, no rebuild)
Same as v11 — `maybeBlockDirectTerminalDuringRepair` still using old bundle.

## v13 Result — **PASS** (both fixes + rebuild)

| Cycle | Event | ignoredCount | budgetState | Remaining |
|---|---|---|---|---|
| 26 | convergence_block | 1 | enough | 64 |
| 41 | convergence_block | 2 | enough | 49 |
| 45 | convergence_block | 3 | enough | 45 |
| 54 | convergence_block | 4 | enough | 36 |
| 56 | convergence_block | 5 | enough | 34 |
| **57** | **hard_veto_fired** ← NEW | **6** | **enough** | **33** |
| 60 | hard_veto_fired | 7 | enough | 30 |
| 61 | hard_veto_fired | 8 | enough | 29 |
| 62 | hard_veto_fired | 9 | enough | 28 |
| 63 | hard_veto_fired | 10 | enough | 27 |

**Before fix (v8/v11):** hard_veto NEVER fired (or fired at cycle 90 = 0 remaining)
**After fix (v13):** hard_veto fires at cycle 57 (33 cycles remaining) ✓

Note: flash-lite model continues calling finalize even after hard_veto (cycles 60-63). This is expected model-ceiling behavior — harness enforces correctly, model is too weak to follow instructions. Stronger models (gpt-5-mini, gemini-2.5-pro) should switch to `workspace_publish_candidate` with `decision=limited` upon receiving the hard veto message.

## Unit Tests Added (`test/unit/terminal-repair-state.test.js`)
| Test | ignoredCount | budgetState | Expected | Result |
|---|---|---|---|---|
| HIGH_WATER_MARK trigger | 5→6 (via refresh) | enough | hard_veto | PASS |
| Below HIGH_WATER_MARK | 4→5 (via refresh) | enough | advisory | PASS |
| Below HIGH_WATER_MARK (low) | 4→5 (via refresh) | low | advisory | PASS |

`npm test`: 810 PASS 0 FAIL

## Acceptance Criteria
- [x] `TERMINAL_REPAIR_HIGH_WATER_MARK = 6` constant added to `terminal-repair-state.js`
- [x] Escalation condition updated: `(>= 3 && exhausted) || >= 6`
- [x] `maybeBlockDirectTerminalDuringRepair` in `action-loop-session-loop.js` checks `repair.escalation`
- [x] 3 new unit tests covering HIGH_WATER_MARK path
- [x] `npm run build` + `npm test` 810 PASS 0 FAIL
- [x] E2E v13: `hard_veto_fired` fires at cycle 57 with `budgetState="enough"` (33 cycles remaining)

## v14 Result — PASS (gpt-5-mini, corrected context engineering)

### Run Config
- Model: `gpt-5-mini` (via OpenAI provider)
- maxSteps: 90 (only used 23)
- Command: `NODE_AGRUN_LIVE_PROVIDER=openai NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs`

### Result

| Metric | Value | Target |
|---|---|---|
| runStatus | **completed** | completed ✓ |
| candidateWords | **3019** | ≥ 3000 ✓ |
| terminalizedBy | **workspace_publish_candidate** | workspace_publish_candidate ✓ |
| relevantSources | **2** | ≥ 2 ✓ |
| successfulReadUrlCount | **3** | ≥ 3 ✓ |
| cycleCount | **23** | ≤ 90 ✓ |
| hard_veto_fired | **never** | — |
| terminalRepairIgnoredCount (max) | **1** | — |

### Behavior Pattern
- Cycle 5: finalize → advisory block (ignoredCount=1)
- Cycles 13-16: web_search × 2 + read_url (self-initiated research recovery)
- Cycles 17-19: workspace_write + workspace_append × 2 (content built to 3019 words)
- Cycle 20: workspace_finalize_candidate → terminalRepairActive=false (repair cleared)
- Cycle 21-23: workspace_publish_candidate → completed

### Key Insight
gpt-5-mini needed only **1 advisory block** to correct behavior. HIGH_WATER_MARK hard_veto never triggered.
This validates the harness design: advisory blocks work for capable models; hard_veto is the safety net
for weak models that ignore advisory signals (flash-lite pattern).

### Context Engineering Fix Validated
Before fix: hardVetoActionNotAllowed message said "budget is exhausted" even when budgetState=enough.
After fix: message accurately reflects actual budgetState. Planner prompt describes correct thresholds
(ignoredCount>=6 regardless of budget, OR >=3 when exhausted).

## AGRUN-237-GAP-02 — readOnlyPlanning Hard_Veto Context Fix (2026-05-19)

### Root Cause
`maybeBlockReadOnlyPlanningLoop` in `action-loop-action.js` only fires when `escalation==="hard_veto"`,
but its message was advisory-tone and step type `"read-only-planning-action-blocked"` was the same as
advisory blocks — model couldn't distinguish hard_veto from advisory in the observation stream.

### Fix (`src/runtime/action-loop-action.js`)
| Field | Before | After |
|---|---|---|
| `message` | "Read-only planning convergence is active: do not repeat..." | "HARD VETO — read-only planning has blocked ${actionName} ${ignoredCount} time(s)..." |
| `output.kind` | `"read_only_planning_preflight_block"` | `"read_only_planning_hard_veto_block"` |
| `pushStep type` | `"read-only-planning-action-blocked"` | `"read-only-planning-hard-veto-blocked"` |
| `pushStep detail` | missing escalation | added `escalation: "hard_veto"` |

### Fix (`test/node-agrun-3000-live.mjs`)
- Added `"read-only-planning-hard-veto-blocked"` to `isHardVeto` check
- Removed `"read-only-planning-action-blocked"` from `isAdvisoryBlock` (it was always hard_veto)

### E2E v15 Note (flash-lite, 2026-05-19)
readOnlyPlanning hard_veto was NOT triggered — flash-lite went into workspace_write/workspace_append
loop (different failure mode). `maybeBlockReadOnlyPlanningLoop` only blocks forbiddenActions (web_search
etc.), not workspace mutations. readOnlyPlanningIgnoredCount reached 10 but no hard_veto fired — by
design, workspace writes are allowed even when readOnlyPlanning is active.

### Acceptance Criteria
- [x] `maybeBlockReadOnlyPlanningLoop` uses HARD VETO message prefix
- [x] New step type `"read-only-planning-hard-veto-blocked"` + kind `"read_only_planning_hard_veto_block"`
- [x] `escalation: "hard_veto"` included in pushStep detail
- [x] `onStep` in live test classifies as `hard_veto_fired` (not `convergence_block`)
- [x] `npm test`: 810 PASS 0 FAIL
- [x] `npm run build`: success
