# AGRUN-303 Output-Guardrail Repair Convergence

Date: 2026-06-05

## Result First

After AGRUN-302 added the strict `section_rehash_repeated_paragraph_openers`
guardrail, a follow-up live rerun stalled: Gemini native_tools low correctly
hit the block, then churned `workspace_multi_edit` / `workspace_read` through
cycle 76 with candidate words stuck around 1534 and never published. The run
was manually stopped; no artifact directory was written.

AGRUN-303 fixes the runtime side of that stall **without authoring content**.
A deterministic offline gate now reproduces and verifies the fix. A live Gemini
rerun is the pending secondary confirmation.

## Root Cause (verified against primary source)

The repair-convergence machinery already existed and was correct for the
heading/number axis — it was simply **unreachable** for a `section_rehash`
block.

- `updateStructureRepairConvergence` (`src/runtime/action-pattern-convergence.js`)
  derives its no-progress signature from `readStructureSnapshot`, which reads
  only `runState.virtualWorkspace.quality.finalCandidateStructure`
  (`duplicateHeadingCount` / `duplicateNumberCount` / heading+number samples).
- `inspectWorkspaceCandidateStructure` (`virtual-workspace.js`) computes that
  structure from duplicate headings/numbers only — it is blind to paragraph
  rehash. For a clean-heading candidate, `finalCandidateStructure.ok === true`.
- So on a `section_rehash` block, `updateStructureRepairConvergence` took the
  clear branch (line 819: `snapshot.ok === true`) or the early-return (line
  828) **every cycle**, never incrementing `repeatedStructureNoProgressCount`,
  never reaching `STRUCTURE_REPAIR_HARD_VETO_THRESHOLD`, never escalating.
- The coarse-rewrite machinery — `DEFAULT_STRUCTURE_REPAIR_FORBIDDEN_ACTIONS`
  (forbids `workspace_multi_edit`) and `DEFAULT_STRUCTURE_REPAIR_ALLOWED_NEXT_MOVES`
  (opens `workspace_replace` / `workspace_write` / `finalize`) — was fully
  wired but could not activate for this block type.

This is "runtime blurred the signal" (wrong structural axis), not "AI wrote bad
structure". The AI's weak section was legitimately caught by the guardrail; the
defect was that the runtime never made the productive repair path obvious.

## The Three Boundaries the Fix Threads

1. **AI-First** — runtime exposes facts + action contracts only; it must not
   rewrite the report or add provider-specific fallback.
2. **No over-narrowing** — a prior bug showed that narrowing the action surface
   too hard makes weak models emit forbidden actions and loop on
   `unknown_action_name`. The fix widens *detection*, and the allowed-moves set
   stays non-empty.
3. **AGRUN-301 gating invariant** — limited-publish / terminal escape must not
   be reachable while a repairable blocker + repair budget coexist. The fix
   never touches the publish gate.

## Fix

A dedicated **guardrail-section axis** inside `updateStructureRepairConvergence`
(`src/runtime/action-pattern-convergence.js`), kept separate from the
heading/number axis to avoid regressions:

- `readLiveStructureGuardrailBlock(context)` reads the live block off
  `context.output.outputGuardrailBlock.info.issues[]`, filtered to structural
  issue codes (`section_rehash*` / `duplicate_*`), and extracts the affected
  section heading (`issue.section`). Length/source/citation blocks are excluded
  so they never force a structure axis.
- The block is persisted as `openGuardrailBlock` (`{ section, issueCodes,
  sectionHash }`) in the convergence state, because the live block appears only
  on the publish-attempt cycle while the loop is the edit/read churn after it.
- `hashStructureSection` extracts the blocked H2 section's text (read-only) and
  hashes it. **No-progress** = a repair action ran but that section's hash is
  byte-identical to the previous cycle. The whole-candidate progress signal is
  intentionally not used (a `workspace_write` bumps the workspace version every
  cycle and would mask the loop).
- A **genuine section rewrite** (hash change, or a renamed/renumbered heading
  the extractor can no longer resolve) **clears** the block — recovery work on
  this or any other section is never punished. Re-arming requires a fresh live
  `output_guardrail_blocked`; the next publish re-runs the host guardrail to
  decide whether the section is truly fixed.
- At `STRUCTURE_REPAIR_NO_PROGRESS_THRESHOLD` the state becomes `active`; the
  existing forbidden set drops `workspace_multi_edit` and the allowed-moves set
  steers to `workspace_replace` / `workspace_write` / `finalize`.
  `planner-action-surface.resolveStructureRepairForbiddenActions` applies the
  forbidden set on `active === true` (it is generic, not keyed to the
  heading/number axis). `requiredCorrection` names the blocked section and tells
  the AI to read then rewrite/replace it — the runtime authors none of it.

### Producer verification (why this is not a silent no-op live)

`reportQualityGuardrail` returns `{ block: true, info: { issues }, reason }`
(`output-guardrail-recipes.js:198-201`) with each issue carrying
`section: section.heading`. `normalizeOutputGuardrailBlock`
(`virtual-workspace-actions.js:1601`) passes `info` through unchanged, so
`info.issues[].section` reaches the convergence updater live — not just in the
unit fixture.

## Deterministic Gate

`test/unit/agrun-303-section-rehash-repair-convergence.test.js` (registered in
`test/smoke.test.js`):

1. **No-op churn → hard_veto.** Block once on section "Definition", then
   `multi_edit`/`read` churn with the section byte-identical (workspace version
   bumping). `structureRepairConvergence` activates, escalates to `hard_veto`,
   forbids `workspace_multi_edit`, and opens `workspace_replace`/`workspace_write`.
2. **Genuine rewrite → reset/inactive.** Build the counter, then actually
   rewrite the Definition section. Counter resets to 0 and the state is inactive
   (surface re-allows `multi_edit`).
3. **Fixed-then-stable → no re-arm.** After a rewrite, keep editing/reading
   while the now-fixed section stays stable. The detector does not re-escalate —
   recovery on other sections is not punished.

A composition guard in `test/unit/planner-action-surface.test.js` calls the real
`selectPlannerActions` on the escalated state and asserts the surface (a) drops
`workspace_multi_edit`, (b) stays non-empty, and (c) keeps the coarse
`workspace_write` path — closing the "makes the productive path obvious" half of
the acceptance and the over-narrowing (d57d79df) risk deterministically, not via
the live rerun.

The live linchpin is verified end-to-end against the producer:
`executeWorkspacePublishCandidateAction` (`virtual-workspace-actions.js:1324-1336`)
sets `status: "output_guardrail_blocked"` **and** `outputGuardrailBlock` on the
guardrail branch — exactly the two fields `readLiveStructureGuardrailBlock`
reads. So the fix is not a silent no-op live.

## Verification

- PASS `node test/unit/agrun-303-section-rehash-repair-convergence.test.js`
- PASS `node test/unit/action-pattern-convergence.test.js`,
  `terminal-repair-state`, `planner-action-surface`, `workspace-actions`,
  `output-guardrail-report-quality`, `step-snapshot-convergence` (no regression)
- PASS `npm test` (smoke; AGRUN-303 registered)
- PASS `npm run build:lib` + `node --check dist/agrun.js`

## Live Run 2026-06-05 (did NOT reproduce the target)

Debug dir: `/tmp/agrun-live-verifier-agrun-303-fix-20260605-131805`
(gemini-3.1-flash-lite, `native_tools`, thinking=low, `reportQualityGuardrail=1`,
`report-writing` skill).

Outcome: the run did **not** exercise this fix. There were **0**
`output_guardrail_blocked` and **0** `section_rehash` events, and the
guardrail-section path never ran (confirmed: 0 `openGuardrailBlock` /
`output_guardrail_section_not_changing`). So the live run is **no regression but
also not a live confirmation** of AGRUN-303.

Instead, gemini-lite produced a different defect first: it **duplicated the
entire outline** (sections 1–6, then 2–6 again at lines 55–102 →
`duplicate_headings` / `duplicate_section_numbers` / `non_monotonic_section_numbers`),
then churned `workspace_multi_edit` ×22 / `workspace_read` ×21 to
`MAX_STEPS_EXCEEDED` at cycle 90 with `publishedPath=null`. The **existing
heading/number `structureRepairConvergence` stayed `advisory` the whole run** and
never forbade `multi_edit`, for a **not-yet-pinned** reason.
`workspaceMutationGrowthConvergence` reached `hard_veto` on the length axis but
does not forbid `multi_edit`.

Cause — **PINNED** by `test/unit/agrun-304-duplicate-outline-structure-churn.test.js`:
**improvement-oscillation reset.** Two verified facts: (1) `refreshWorkspaceQuality`
recomputes `finalCandidateStructure` after every mutation, so the snapshot is
`present:true, ok:false` every churn cycle → the early-return gates (lines ~819/828)
do **not** fire (presence/timing ruled out); (2) `isStructureImproved` returns true
on **any decrease** in issue/duplicate counts, and the counter resets on `improved`.
A model that partially repairs then re-breaks the outline makes the duplicate count
oscillate (5→4→5→4…), tripping `improved` on every down-cycle and zeroing the
no-progress counter. The diagnostic proves it: a **stable** defect escalates to
`hard_veto` (control), an **oscillating** defect keeps the counter at
`[0,0,1,0,1,…]` max=1 and never escalates. The earlier "signature changes each
cycle" guess is struck (signature change feeds `structureProgressCount`, not the
gate).

This is a distinct, pre-existing gap on the heading/number axis (the dead-path is
**not** the cause here, since `finalCandidateStructure.ok===false`). Fixed under
**AGRUN-304**: the no-progress counter now treats progress as a **new best**
(lowest `issueCodes.length + totalDuplicateCount` over the block) instead of
better-than-the-previous-cycle, so an oscillating/stalled defect escalates while a
monotone-improving model is never punished. Gate:
`test/unit/agrun-304-duplicate-outline-structure-churn.test.js`. The frozen
artifact (`run.log` + `.jsonl` + `report.md`) is the repro evidence.

Net: AGRUN-303's verification remains the deterministic offline gate. A
`section_rehash` live repro is still pending — gemini-lite is non-deterministic
and produces the target shape only on some runs.

## Success Criterion and HBR

Success is **"the runtime deterministically suppresses the no-op loop and makes
the coarse-rewrite path obvious"**, not "this model always converges".
Convergence remains the model's job.

HBR / known limits:

- **Live not yet confirmed.** A Gemini native_tools low rerun is the pending
  secondary confirmation; do not call the live path successful until run.
- **Heading-text matching** includes any section number; a renamed/renumbered
  heading clears gracefully (degrades to re-arm-on-next-block) rather than
  mis-tracking.
- **Shape-C out of scope.** Different-but-still-bad edits each cycle (the
  section changes every time but never improves) are intentionally not
  suppressed — only unchanged-section churn is. Judging whether changed content
  is "good enough" is the host guardrail's job on the next publish, not the
  runtime's.
- **Initial-extraction failure fails safe.** If the guardrail's `section`
  heading never resolves to an extractable section (`sectionHash` stays null),
  the detector simply never arms — no false escalation. Low likelihood because
  the extractor normalizes headings the same way the guardrail emits them.
