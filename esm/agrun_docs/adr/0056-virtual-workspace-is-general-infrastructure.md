# ADR-0056: virtual-workspace is general infrastructure — stays in core; research coupling is a data-gated seam

- Status: ACCEPTED
- Date: 2026-06-14
- Decision owner: Maintainer
- Related: `remaining-hardcode-roadmap.md` (§3 open question, §4 H4),
  `micro-kernel-313-preassessment-2026-06-12.md`, `workspace-edit-harness-design.md`,
  ADR-0015 (workspace activation opt-in), ADR-0023 (harness-as-tool-provider-only),
  ADR-0053 (research source-minimum pack default), ADR-0054 (kernel-seam removal).

## Context

`remaining-hardcode-roadmap.md` §3 left an **open architectural question** that gated
its largest, highest-risk phase (§4 **H4** — "extract the virtual-workspace / candidate-publish
APPLICATION"):

> *Is `virtual-workspace` publishing generic long-output infrastructure, or a research
> application?*

H4 was framed as the deepest phase: move the ~2,294-line workspace action surface +
the `workspace_*` action names out of core into an opt-in action pack, on the assumption
that the workspace IS a report-writing application living in the kernel.

This ADR resolves that question with a code-level fact-check (2026-06-14), so no future
contributor re-plans H4 from the stale "workspace = application" premise.

## Decision

**`virtual-workspace` is GENERAL INFRASTRUCTURE. It stays in core.**

The decision rests on three verified facts:

1. **The edit primitives are domain-agnostic.** `workspace_list / read / write / replace /
   propose_patch / apply_patch / insert_after_section / remove / move / multi_edit` are
   generic file mutators. `workspace-edit-harness-design.md` states the design intent
   verbatim: *"This keeps it a generic edit primitive, not a report-specific fixer."*
   Both the coder skill pack (editing code) and the research skill pack (drafting reports)
   register against the same primitives.

2. **"Draft → review → publish a candidate with a readiness gate" is generic long-output
   infrastructure.** Any agent producing a substantial deliverable (code, report, doc,
   plan) benefits from the same write→review→publish lifecycle. It is not research-specific.

3. **The only research-specific coupling is ALREADY data-gated (inert without research
   state).** `publish-readiness.js` reads `runState.researchState` and
   `runState.researchReportLoop.gateSignal.acceptancePacket.evidence`:
   - `readPublishSourceMinimum(runState)` returns `null` when there is no
     `researchReportLoop` → `sourceMinimumFailed` is `false`.
   - `researchGateBlocked = Boolean(researchState && researchState.qualityGateRequired ===
     true && researchState.finalAllowed === false)` → `false` when `researchState` is null.

   So for a coder / generic agent (no research state populated), the source-minimum and
   evidence gates are **inert**: workspace publish checks only the AI's own ready/limited
   declaration + length. The research gates activate **only** when a research skill
   populates the state. This is textbook "mask, don't remove" + capability-gating
   (harness-engineering-principles P3) — the research behavior is a *seam* that is null
   unless research state fills it.

**Therefore the H4 premise is partly a false premise:** there is no monolithic "research
application" buried inside the workspace to extract. The mechanism is generic; the research
coupling is already a correctly-architected data-gated seam.

### What engineers must preserve

- Do **NOT** move the workspace action surface out of core. Extracting it wholesale would
  remove generic infrastructure that coder (and any future long-output) agents depend on —
  an architecture regression.
- Keep the research coupling **data-gated**: core may read `researchState` /
  `researchReportLoop` defensively (null-guarded), and those reads must remain no-ops when
  the slots are null. Do not promote any research gate to fire unconditionally.

### Downgrade of H4

H4 is **downgraded** from "largest / highest-risk application extraction" to **H1-class
(cheap naming cleanup)**. The residual work is cosmetic, low-value, and optional:

- The research-named reads scattered in `publish-readiness.js`
  (`researchReportLoop.gateSignal.acceptancePacket…`) are a *naming/coupling smell*, not a
  *behavioral* coupling. They are already **data-gated** (null `researchState` /
  `researchReportLoop` → the gate does not fire) and routed through the
  `isResearchQualityGateRequired` capability predicate (`convergence-activation.js`). This
  data-gated read **is the accepted resting point** — leave it as is.

  > **Correction (2026-06-14):** an earlier draft of this bullet suggested formalizing
  > these reads into a named hook seam (`publishReadinessHooks`). That suggestion is
  > **withdrawn — it directly contradicts [ADR-0054](./0054-kernel-seam-removal-portable-skills-only.md),**
  > whose Alternative 2 ("relocate research enforcement behind `@agrun/skills-research`
  > hooks") was *rejected* and whose Decision *deleted* the kernel-seam hook mechanism
  > (`finalizeContractHooks`/`reportLoopHooks`/`acceptanceEvaluatorHooks` + 21 call sites).
  > Re-introducing a `publishReadinessHooks` seam would reinstate the exact non-portable
  > runtime-hook contract ADR-0054 removed. **Do NOT build a hook seam here.** A pure
  > vocabulary rename (research-named slots → generic names) is the only non-contradictory
  > option, but it is breaking (slot names are serialized via `run-state-portable` /
  > `research-thread-sync`), large (~195 `researchReportLoop` + ~125 `researchState` reads),
  > and cosmetic — scope it as a deliberate breaking 2.x effort if a clean `grep research
  > src/runtime` ever becomes a hard requirement, not as casual H1 work.

- ~~The `createVirtualWorkspace` default `activePath: "final_candidate.md"`~~ **DONE
  (2026-06-14, PR #177).** SSOT'd into the exported `DEFAULT_FINAL_CANDIDATE_PATH` constant
  in `workspace-candidate-lifecycle.js`; the 13 duplicated fallback/equality literals across
  the runtime now import it. The path was already AI-driven (per-run `quality.finalCandidatePath`);
  this only removed the duplicated default literal. NO behavior change — `npm run check`
  green, planner prompt snapshot byte-identical.
- The `research-*.js` source files physically in `src/runtime/` already tree-shake out of a
  generic consumer's bundle (bundle-clean is done); moving the *files* is the source-clean
  vs bundle-clean distinction with low practical payoff.

## Alternatives

1. **Extract the workspace as a research application (original H4).** Rejected: it would
   pull generic infrastructure out of core and break non-research (coder, long-output)
   agents that legitimately use the same write/draft/publish lifecycle. Based on the false
   "workspace = application" premise.
2. **Leave the question open.** Rejected: an open §3 question keeps re-inviting the
   high-risk H4 extraction from a stale premise; resolving it now prevents wasted re-planning.
3. **Promote the source/evidence gate to always-on for stronger publish discipline.**
   Rejected: violates AI-first (ADR-0023) and data-gating — a non-research agent would be
   blocked by a source-minimum it has no way to satisfy.

## Consequences

- Pros: closes the §3 open question; prevents a high-risk, low-value extraction; affirms the
  correct data-gated-seam architecture; clarifies that bundle-clean (done) is the 80/20 win.
- Cons: the `src/runtime/` grep still lights up with `workspace_*` / `research_*` vocabulary
  (source-clean not pursued); accepted as a deliberate resting point.
- Risks: low — this ADR is a disposition, not a behavior change. No code is modified by the
  decision itself; the optional H1-class cleanups are independently litmus-verifiable.

## Rollback

- This is a documentation/disposition decision; reverting means re-opening §3 and restoring
  H4 to its "application extraction" framing in `remaining-hardcode-roadmap.md`.
- If a future requirement genuinely needs the workspace to be a removable pack (e.g. a core
  so minimal it ships zero action surface), re-evaluate against the three facts above and
  supersede this ADR — but verify the data-gated seam still holds before extracting.
