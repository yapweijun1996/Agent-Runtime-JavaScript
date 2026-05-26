# Reply to Globe3 — AGRUN-264 JSONL evidence + structure-deficit Q

Subject: Re: AGRUN-264 — JSONL slices from job e0f52c12

---

Thanks. The per-cycle dump answered every open question in one pass. Direct answers below, then a short list of what we're doing with it.

## Direct answer to your Q (structure / candidate_empty)

**No** — `structure.candidate_empty` does NOT independently force `finalize` into `forbiddenDecisions` for a host like Globe3 that has no workspace candidate by design. AGRUN-263 + AGRUN-264 shipped together is sufficient. You do not need an AGRUN-265-structure ticket.

Trace (`src/runtime/terminal-repair-state.js`):

1. Line 478-490: structure is recorded into `observableDeficits.structure` but is **explicitly NOT pushed to the `deficits` array**. The comment at 478-481 calls this out as a Phase-3 design decision — "structure is likewise display-only, not a deficit … the runtime does not force repair."
2. Line 633-638: `buildForbiddenDecisions(deficits)` only reads `deficits` (= `activeDeficits`). Since "structure" is never in that list, it cannot add `finalize` to forbidden.
3. The only path structure forces repair is `finalizedStructureBlocked` (line 506) — which requires `isFinalizedCandidateSelected(runState) === true`. Globe3 has no candidate → false → not your path.
4. Once AGRUN-264 nullifies `sourceMinimum` semantically under `enabled:false`, `deficits.push("source")` at line ~446 stops firing. With no other deficit-pushers active on your run, `activeDeficits` collapses to `[]`. Then `forceActive` (line 527-533) is false on every branch — `readOnlyPlanningActive && activeDeficits.length > 0` is the relevant clause and it requires `length > 0`. No terminal_repair activates. No `forbiddenDecisions` are built.

So your AGRUN-264-alone-stuck-via-structure hypothesis does not happen. Good news.

## What your JSONL changes in our plan

- **Headline 1 (default-state poisoning)** — confirmed. AGRUN-264 fix scope unchanged.
- **Headline 2 (cycle 7 activation)** — `cycle_07_excerpt.json` becomes our regression fixture. We'll assert: with `researchReportLoop:{enabled:false}` + the cycle-7 runState shape, after AGRUN-264 the activator at line 541 evaluates false because `activeDeficits === []`.
- **Headline 3 (Path 3 absorbed)** — confirmed via `evidenceGaps` derivation. No AGRUN-266 needed. AGRUN-264 closes the planner-prompt switch as a side effect.
- **Headline 4 (structure)** — answered above. No new ticket.
- **Headline 5 (`actionPatternConvergence.readOnlyPlanning` projection is null)** — separate small bug. Tracking as **AGRUN-266** (projection layer prunes the field; consumer can't tell "detector quiescent" from "detector tripped but projection empty"). Low priority, doc-only workaround until then: trust `terminalRepairState.reason === "read_only_planning_with_observable_deficits"` as the authoritative signal.

## Field name rename

Your projection emits `{reads, minReads, relevant, minRelevant}` and the source emits `{readSources, minReadSources, relevantSources, minRelevantSources}`. Same semantics, projection-time rename — confirmed. We'll align field names in our regression fixture to match source.

## Tool offer

Yes, please share `tools/parse_recent_steps.py` — even read-only-DB form is useful. Our test harness has a clean path for synthetic runState but no live-tail of planner request bodies, and adding one is on our "would be nice" list.

## What ships

One PR, three things, in this order:

1. **AGRUN-264** — Pattern A → Pattern B conversion on `researchReportLoop`. `createResearchReportLoopState()` returns `sourceMinimum:null` when `enabled:false`; consumers (`action-pattern-progress.js:227`, `terminal-repair-state.js:446`) treat `null` as "no minimum required". `isLongResearchHarnessActive` promoted from private helper.
2. **AGRUN-263** — `tool_result` productive dimension with dedup-by-args fingerprint; `runtimeConfig.productiveProgressDimensions` opt-in.
3. **Doc** — Pattern B canonical shape in `agrun_docs/feature-toggles.md`; snapshot-vs-planner-body distinction (closes your earlier Q4).

AGRUN-266 (projection field exposure) tracked separately, not blocking your unblock.

## ETA

Implementation can start now on static-read basis; regression test uses your `cycle_07_excerpt.json`. We'll send the bundle commit hash when CI passes.

— agrun.js team
