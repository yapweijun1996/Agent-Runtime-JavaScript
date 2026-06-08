# AGRUN-305 Ready Candidate Not Published

Date: 2026-06-05

## Issue

The third AGRUN-303/304 live confirmation run produced a clean ready candidate but never published it:

- Artifact: `/tmp/agrun-live-verifier-agrun-304-confirm-20260605-154321`
- Candidate: 3014 words, structure clean, `userGoalSatisfied=true`
- Failure: `MAX_STEPS_EXCEEDED`, `publishedPath=null`
- Churn: repeated `workspace_finalize_candidate` / `workspace_review_candidate`, plus wrong-surface publish attempts

This was not an AGRUN-303/304 structure regression. The candidate was ready; the action surface and publish contract let the run keep looping instead of making publish the clear next move.

## Fix

1. Ready workspace publish narrowing no longer depends on the mode-hide / readiness-skill signal. If objective gates prove the candidate is finalized, freshly read, reviewed, clean, TodoState-synced, and source minimum is not blocked, the surface narrows to `workspace_publish_candidate`.
2. `workspace_publish_candidate` now auto-corrects runtime-owned mechanical `finalReadiness` fields from the latest `workspace_read`:
   - `checkedWorkspaceStats`
   - `observedLength`
   - `observedLengthUnit`
3. AI-owned judgment is still enforced. `decision=ready` with `evidenceSatisfied=false` still blocks.
4. Source minimum only blocks when publish readiness is required. A refreshed acceptance packet with `researchFinalReason=not_long_research` must not block a non-research workspace publish.

## Verification

- `node test/unit/planner-action-surface.test.js`
- `node test/unit/workspace-actions.test.js`
- `node --check src/runtime/planner-action-surface.js`
- `node --check src/runtime/actions/virtual-workspace-actions.js`

## HBR

This stays AI-first. Runtime does not decide report quality or author content. Runtime only exposes and corrects facts it owns, then keeps AI-owned judgment and host evidence gates authoritative.
