# ADR: Publish-loop escape valve (artifact-preserving)

## Context

- On a `long_research` task that drafts and publishes a workspace report, a weak
  model can get pinned in a `workspace_publish_candidate` loop. An active deficit
  (e.g. unfinished todos the model never marks done, because it believes the
  report is complete) forces the publish into the `"limited"` contract. The model
  keeps emitting `decision:"ready"` — invalid under that contract — so every
  publish is vetoed (`terminal_repair_invalid_publish`). `ignoredCount` climbs to
  `hard_veto`, a terminal-correction cooldown then engages, yet NOTHING accepts
  the publish. The run burns the entire step budget and returns the generic
  "I paused this long-running task…" continuation stub via
  `maybeFinalizeMaxStepsContinuation` — no usable report is delivered.
- The workspace publish path is a strict multi-step protocol
  (`write → finalize → read → review → publish`) whose `finalReadiness` facts
  must EXACTLY match observed candidate stats (`observedLength` === actual word
  count) AND clear every active deficit. It is hard-but-satisfiable; a weak model
  thrashes it.
- This is the publish-protocol sibling of the source-deficit thrash fixed in
  commit `03f259cf0` (ADR precedent: `sourceUnresolvable` escape). That escape
  opened `final`/`finalize` because that case had NO candidate — finalize was its
  only terminal. It does not generalize here: a real artifact exists.
- Affected: `terminal-repair-state.js`, `action-loop-action.js`
  (`maybeBlockTerminalRepairAction`, `maybeBlockTerminalCorrectionRetry`),
  `actions/virtual-workspace-actions.js` (the publish action).

## Decision

- `evaluateTerminalRepairState` grants a new read-only flag
  `publishLoopEscapeGranted = !sourceUnresolvable && escalation === "hard_veto" &&
  hasSelectedFinalCandidateContent(runState)`.
- The THREE publish gates honor that flag and ACCEPT the AI's
  `workspace_publish_candidate` as-is instead of vetoing it:
  1. `maybeBlockTerminalRepairAction` (terminal-repair preflight) — returns
     `null` (allow) for publish when the flag is set.
  2. `maybeBlockTerminalCorrectionRetry` (terminal-correction cooldown) — same.
  3. The publish action — skips the protocol / readiness-audit /
     candidate-quality / todo-sync blocks; the unmet facts stay observable on the
     output's `publishProtocol` + `readinessAudit`.
- The escape routes through **publish, NOT finalize**: it delivers the full
  report ARTIFACT (`finalAnswerSource = workspace_publish_candidate`), preserving
  the candidate content. Finalize would re-summarize/compress it (the explicit
  reason `shouldAllowFinalizeAfterReadinessPublishBlock` returns `false`).
- Narrow by design: `hard_veto` means the AI has ignored the advisory past the
  high-water mark (≥6 attempts); a genuinely convergeable publish lands in 1–2
  steps, far below that. A non-empty candidate must exist, so it never fabricates
  a report from nothing and never fires on a convergeable publish.

## Alternatives

1. Open `final`/`finalize` at hard_veto (mirror the source-deficit escape).
   Rejected: finalize compresses the workspace candidate into a short summary,
   throwing away the full report the AI spent the run writing — a regression
   wearing a fix's clothes. The artifact-preserving terminal is publish.
2. Relax the publish contract for all hard_veto publishes (accept any). Rejected:
   broader than needed; keyed instead on the explicit `publishLoopEscapeGranted`
   signal + real-candidate guard.

## Consequences

- Pros: a stuck publish loop now delivers the real report artifact with honest
  limitations (output keeps `publishProtocol`/`readinessAudit` facts), instead of
  burning the budget and returning a useless stub. AI-first: the runtime stops
  vetoing rather than authoring content.
- Cons: a candidate published under escape may not have passed the full protocol
  (finalize/read/review) or exact-fact audit; the unmet facts are surfaced but
  the AI's `decision:"ready"` claim may overstate readiness.
- Risks: if `hard_veto` fired too eagerly the escape could accept a premature
  publish. Mitigated by the high-water-mark threshold (≥6 ignored advisories) and
  the unit narrowness tests (no fire below hard_veto, no fire without a candidate).

## Rollback

- Remove the `publishLoopEscapeGranted` computation in `terminal-repair-state.js`
  and the three `publishLoopEscapeGranted`/`publishLoopEscape` guards in
  `action-loop-action.js` and `actions/virtual-workspace-actions.js`. The
  source-deficit escape (`sourceUnresolvable`) is independent and unaffected.
- Restore the deterministic gate (`test/livekit/repro-workspace-publish-loop.mjs`
  would revert to `continuation_required`) and the unit assertions in
  `test/unit/terminal-repair-state.test.js`.
