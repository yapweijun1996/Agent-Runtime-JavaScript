# ADR-0053: Research source-minimum default is pack policy, not a kernel constant

- Ticket: AGRUN-455
- Status: ACCEPTED
- Date: 2026-06-09
- Related: ADR-0045 (research-finalize intent AI-owned), ADR-0051 (output-guardrail host
  policy), the micro-kernel RFC (`micro-kernel-plugin-skills-rfc.md`, graduating to
  ADR-0052), AGRUN-297 (structure-issue severity host-configurable), the 2026-06-09
  source/citation gate AI-first fix (commit `9800c4403`).

## Context

The long-research convergence gate evaluates a `sourceMinimum` signal: "are there enough
read sources / relevant sources for the AI to finalize?". The two numeric thresholds —
`minReadSources = 3` and `minRelevantSources = 2` — were baked into the kernel as
constants in `src/runtime/kernel-report-loop.js` (`normalizeResearchReportLoopConfig`,
the CORE config normalizer imported by `config.js`).

"How many sources are enough" is a **research-domain semantic judgment**, not a generic
runtime mechanism. Baking the numbers into the kernel:

- contradicts the no-hardcode / AI-first mandate (the runtime should OBSERVE + EXPOSE
  sufficiency, the AI should judge it),
- contradicts the micro-kernel direction (ADR-0052): domain semantics belong in the
  opt-in `@agrun/skills-research` pack, not in `src/runtime/` core,
- applied one fixed bar to every convergence task regardless of need.

The signal was already NON-BLOCKING (the publish veto `maybeCreateResearchReportLoopVeto`
was deleted 2026-05-09; `sourceMinimum.passed` only feeds the advisory candidate-quality
signal and `activeDeficits=["source"]` for terminal-repair) and already host-overridable
via `runtimeConfig.researchReportLoop.minReadSources`. The residual gap was purely
**structural**: the numeric DEFAULT still lived in core.

## Decision

CORE ships **no** numeric research source-minimum default. The opt-in research pack owns
the default policy.

- `kernel-report-loop.js` `normalizeResearchReportLoopConfig` no longer injects `3`/`2`.
  When the host supplies neither `minReadSources`/`minRelevantSources` nor the
  `minEvidenceArtifacts` aliases, the minimums are left **absent (0)**. The
  `DEFAULT_MIN_READ_SOURCES`/`DEFAULT_MIN_RELEVANT_SOURCES` constants were removed from
  core. (Loop-budget defaults — vetoes / search passes — are generic mechanism and stay.)
- `research-report-loop.js` (pack-side; tree-shaken out of `dist/agrun.js`) keeps its own
  `DEFAULT_MIN_READ_SOURCES = 3` / `DEFAULT_MIN_RELEVANT_SOURCES = 2` and applies them in
  `refreshResearchReportLoopGate` via a new
  `normalizeResearchReportLoopConfigWithPackDefaults(value)` overlay: core-normalize
  first, then restore `3`/`2` when the host supplied no minimum. A host-supplied minimum
  (already non-zero out of the core normalizer) is preserved.

This mirrors AGRUN-297 / the 2026-06-09 candidate-quality precedent: keep DETECTION
meaningful (the signal stays falsifiable, `passed` can still be `false`), move the POLICY
to the edge (pack default + host override), never re-introduce a hardcoded publish veto.

Engineers must preserve:

- the signal stays **observable + non-blocking** — AI owns finalize-with-limitations;
- the kernel/pack boundary test in `test/unit/research-report-loop.test.js`
  (`normalizeResearchReportLoopConfig({})` → `minReadSources === 0`; pack `refreshGate` →
  `sourceMinimum.minReadSources === 3` and `passed` falsifiable). If the kernel ever
  re-bakes `3`/`2`, that test fails.

Why a `refreshGate` overlay (not threading a defaults param through both config call
sites): `refreshGate` is the single pack entry that re-normalizes the config and the only
caller of `evaluateResearchReportLoop` (which computes `passed`), so the overlay there
covers every config-derived consumer (gate signal, acceptance packet, evidence graph) in
one place. The pack already owns the `3`/`2` constants.

## Alternatives

1. **Zero-default everywhere (no overlay).** Rejected: `min = 0` → `passed = readSources
   >= 0` always true → `activeDeficits=["source"]` never fires → the AI never sees the
   sufficiency signal. That is blind, not AI-first. AI-first = keep observing, stop
   blocking.
2. **Keep the default in core but only re-document it.** Rejected as a no-op: the residual
   issue is specifically that the numeric DEFAULT lives in CORE; re-documenting does not
   move the boundary.
3. **Thread a `defaults` argument from the pack through `config.js` + all three
   `refreshGate` call sites.** Rejected as heavier: the pack already holds the constants,
   and `refreshGate` is the sole config re-normalizer / `passed` computer, so a local
   overlay is the smaller SSOT.

## Consequences

- Pros: core `src/runtime/` ships no research source-minimum number; the pack owns its
  policy; host override unchanged; signal stays observable + non-blocking (no weak-model
  publish deadlock regression).
- Cons: the `3`/`2` constants now exist in two pack files (`research-report-loop.js` and
  `research-evidence-graph.js`, both pack-side / tree-shaken from `dist/agrun.js`) — minor
  duplication, acceptable as pack-internal defaults; a future cleanup could SSOT them.
- Risks: low. All ~17 downstream readers consume `sourceMinimum.minReadSources` off the
  computed object that `refreshGate` builds (no own defaults), so the effective threshold
  still reaches them through the pack overlay. Generic / no-pack flows are unaffected
  (`refreshGate` is a no-op without the pack; the 0 core default is never observed there).

## Rollback

- Revert AGRUN-455: restore `DEFAULT_MIN_READ_SOURCES`/`DEFAULT_MIN_RELEVANT_SOURCES` in
  `kernel-report-loop.js` `normalizeResearchReportLoopConfig`, drop
  `normalizeResearchReportLoopConfigWithPackDefaults` in `research-report-loop.js`, and
  remove the boundary assertions in `test/unit/research-report-loop.test.js`. Rebuild
  `dist/agrun.js`.
