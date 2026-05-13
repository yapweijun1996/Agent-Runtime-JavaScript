# Missing Readiness OODAE Trace — 2026-05-09

## Goal

Make the AI-first research finalize contract debuggable without guessing. When a long/deep research run tries to finalize without read_url evidence or AI-declared readiness, runtime may ask the planner to continue, but that continuation must appear as a complete OODAE transition.

## Fix

- `maybeContinueOnMissingAiReadiness` now records:
  - `lastAction`
  - `actState`
  - structured `observation`
  - `act.resultKind = "continue"`
  - `evaluate.outcome = "continue"`
  - `evaluate.researchFinalizeContract.status = "missing_ai_readiness"`
- Direct planner `final`, planner `finalize`, plan-finalize, and `synthesize_per_action` plan synthesis pass the active `cycleRecord`, so Inspector can show the full cycle.
- `synthesize_per_action` now observes `researchFinalizeContract` before running section synthesis. If no successful `read_url` and no AI-declared readiness exists, runtime records `missing_ai_readiness` and lets the planner choose the next action instead of silently producing a section-synthesized final.

## AI-First Boundary

Runtime does not choose the next research step and does not judge source sufficiency here. It only records that AI tried to finalize without the required readiness contract, then lets the next planner cycle decide whether to search, read a URL, inspect workspace, or finalize with limitations.

## Verification

- `node test/unit/action-loop-session-terminals.test.js`
- `node test/concerns/planner.test.js`
- `npm run build`
- `npm run dist:check`
- `git diff --check`
