# Research Subsystem Decomposition Spike

> **SUPERSEDED 2026-05-07 by [ADR-0012](./adr/0012-long-research-belongs-to-skill.md) /
> AGRUN-217.** This spike proposed splitting the 3000-line research subsystem
> into 13 sibling modules. The follow-up audit showed most of those lines are
> *runtime doing AI work* (lexical triggers, search-query templates, action
> selection, prose authoring) rather than legitimate mechanism. AGRUN-217 deletes
> that surface instead of decomposing it. After deletion, runtime shrinks to
> ~600 lines of mechanism (authority + budget + duplicate + gate signal); a
> further split into modules may still be useful then, but is no longer urgent
> and is not part of AGRUN-217. Keep this file for historical reference only.

Status: Superseded by ADR-0012.
Date: 2026-05-07
Author: harness review
Scope: `src/runtime/research-evidence-graph.js` (1756 lines) and
`src/runtime/research-report-loop.js` (1218 lines).

## Why this exists

The long-research subsystem is functionally correct (3-topic Chrome MCP
E2E across company / person / project passed on 2026-05-07), but two
files now hold ~3000 lines and most of the cross-cutting harness logic.
Future research-quality slices (claim graph tweaks, new evidence tiers,
new coverage targets) all converge on the same two modules, which makes
review and regression cost grow super-linearly.

This document proposes a behavior-preserving decomposition: same public
exports, same outputs, smaller files with one responsibility each. It is
a planning spike — no code is moved by this document.

## Public surface to preserve

These exports must remain stable; callers across `src/index.js`,
`runtime/state.js`, `runtime/result.js`, `runtime/action-loop-terminal.js`,
`runtime/action-loop-action.js`, `runtime/action-loop-session-terminals.js`
import them today.

`research-evidence-graph.js`:
- `createEmptyResearchEvidenceGraph`
- `buildResearchEvidenceGraph`
- `compileResearchReportFromEvidence`
- `materializeEvidenceGraph`
- `createResearchFinalEnvelope`
- `classifyResearchClaimRisk`
- `collectFinalEvidenceSourceArtifacts`
- `collectResearchReportSourceArtifacts`

`research-report-loop.js`:
- `normalizeResearchReportLoopConfig`
- `createResearchReportLoopState`
- `maybeCreateResearchReportLoopVeto`
- `evaluateResearchReportLoop`
- `buildClaimEvidenceTable`
- `isFinalWithLimitations`
- `noteResearchCoverageSearchAttempt`
- `synthesizeCoverageQuery`

Public exports are NOT moved between files. Only internal helpers move
into sibling modules; the two top-level files become thin facades that
re-export from the new modules.

## Responsibilities found inside today

`research-evidence-graph.js` mixes five concerns:

1. **Source artifact normalization** — `createSourceArtifact`,
   `normalizeSourceMinimumWithArtifacts`, `extractSourceObservations`,
   `createSourceIdentityObservation`, `createRepositoryProjectObservation`.
2. **Claim graph construction** — `createDirectClaimEvidence`,
   `createProposedClaimEvidence`, `mergeClaimEvidence`, `buildClaimGraph`,
   `summarizeClaimAuthorityMix`, `chooseClaimDecision`,
   `classifyResearchClaimRisk`.
3. **Coverage and evidence-gap analysis** — `summarizeCoverage`,
   `createEvidenceGaps`, `formatRiskKindGap`, `hasDirectRiskClaim`.
4. **Snippet-tier evidence collection** — `collectSnippetEvidence`,
   `tokenizeForSnippetMatch`.
5. **Report rendering / compilation** —
   `compileResearchReportFromEvidence`, `buildSummaryParagraph`,
   `buildSourceQualityText`, `compileSynthesisFindings`,
   `compileReasonedInterpretation`, finding formatters,
   `filterFinalClaimEvidence`, `filterReportedButNotVerified`,
   `collectFinalEvidenceSourceArtifacts`,
   `collectResearchReportSourceArtifacts`,
   `collectScopedReadSourceArtifacts`, `collectSnippetSourceArtifacts`.

`research-report-loop.js` mixes seven concerns:

1. **Config + state factories** —
   `normalizeResearchReportLoopConfig`, `createResearchReportLoopState`,
   `normalizeLoopState`.
2. **Eligibility / required-gate check** — the
   `isResearchQualityGateRequired` short-circuit and
   `hasRequiredResearchExploration` test.
3. **Veto entry point** — `maybeCreateResearchReportLoopVeto`.
4. **Evaluator** — `evaluateResearchReportLoop`,
   `buildClaimEvidenceTable`, `isFinalWithLimitations`.
5. **Coverage targets** — `createCoverageTargets`,
   `reconcileCoverageTargetsWithEvidence`,
   `isCoverageTargetEvidencePassed`, `createCoverageTarget`,
   `readCoverageTargetsFromTodoState`, `selectNextSearchCoverageTarget`,
   `inferCoverageTargetFromSearchQuery`, label/predicate helpers.
6. **Veto / backstop policy** —
   `updateCoverageSearchAttempts`, `updateGuidanceVetoCount`,
   `noteResearchCoverageSearchAttempt`, `synthesizeCoverageQuery`,
   `buildCoverageQueryCandidates`, `guessOfficialDomainHint`,
   `collectAttemptedQueries`, plus the two MAX constants.
7. **Search dead-end detection** — `readSearchDeadEnd`,
   `findUnreadSearchResult`, `minimumUnreadCandidateScore`,
   `scoreUnreadSearchResult`.

## Proposed file layout

Behavior-preserving split. Public exports stay on the original two
files; new modules carry the implementation.

```text
src/runtime/research/
  evidence/
    sources.js         # source artifact normalization + observation builders
    claim-graph.js     # claim merge, decision, authority mix, risk classifier
    coverage.js        # evidence-gap + summary + risk-kind formatters
    snippet-tier.js    # snippet collection + tokenization
    report-renderer.js # compile/final-with-limitations/full-report formatters
    final-sources.js   # collectFinal* + collectScoped* + collectSnippet*
    index.js           # re-export the public surface used by graph facade
  report-loop/
    config.js          # normalize + state factories
    eligibility.js     # gate-required predicate (no side effects)
    coverage-targets.js   # creation, reconciliation, todoState parsing,
                          # next-target selector, label predicates
    veto-policy.js     # attempts + veto counters, MAX_* constants
    backstop.js        # synthesizeCoverageQuery + candidate builder +
                       # collectAttemptedQueries + guessOfficialDomainHint
    search-dead-end.js # readSearchDeadEnd + unread candidate scorer
    evaluator.js       # evaluateResearchReportLoop body
    veto-entry.js      # maybeCreateResearchReportLoopVeto body
    index.js           # re-export the public surface used by loop facade
```

Top-level facades stay where they are:

- `src/runtime/research-evidence-graph.js` becomes a thin module that
  imports from `./research/evidence/*.js` and re-exports the eight
  public symbols.
- `src/runtime/research-report-loop.js` becomes a thin module that
  imports from `./research/report-loop/*.js` and re-exports the eight
  public symbols.

Result: zero caller-side changes anywhere in `src/index.js`,
`runtime/state.js`, `runtime/result.js`, `runtime/action-loop-*.js`,
`runtime/action-loop-session-terminals.js`. Tests under
`test/unit/research-evidence-graph.test.js`,
`test/unit/research-report-loop.test.js`,
`test/concerns/research-report-loop.test.js`, and
`test/concerns/research-flows.test.js` continue to import the same
module paths.

## Acceptance contract for the eventual ticket

When this spike is promoted to an AGRUN ticket (suggested id
AGRUN-216), acceptance must include:

- [ ] No public export of `research-evidence-graph.js` or
      `research-report-loop.js` is moved or renamed.
- [ ] No caller import path changes anywhere under `src/`.
- [ ] Each new module under `src/runtime/research/**` is < 350 lines.
- [ ] No file under `src/runtime/research/**` exports more than one
      logical concern (e.g. coverage targets do not also export
      veto policy).
- [ ] `npm run check` passes (build + dist:check + smoke + 107 unit +
      20 concern tests).
- [ ] 3-topic Chrome MCP regression (company / person / project) reruns
      with the same `?qa=...` style URL and produces the same final
      report mode (`final_with_limitations` / `full_report`) per topic.
- [ ] No new constants are introduced; existing `DEFAULT_*` and
      `MAX_*` values move with their owning concern, not duplicated.

## Risk register

- **Cycle risk between evidence/ and report-loop/**: today
  `research-report-loop.js` already imports
  `buildResearchEvidenceGraph` and `materializeEvidenceGraph` from
  `research-evidence-graph.js`. The split must keep the dependency
  direction one-way: `report-loop/*` may import from `evidence/`, but
  not vice versa.
- **Test-file co-location**: existing concern/unit tests target the
  current module paths. The spike preserves those paths via the facade
  pattern, so no test moves are required. If a future refactor decides
  to test internal modules directly, that is an additive step, not a
  precondition.
- **Module count**: the proposal adds 13 small files. This is a
  deliberate trade — single-responsibility wins over file-count
  minimization once a subsystem crosses 1500 lines. The browser bundle
  is unaffected because Rollup tree-shakes ESM re-exports.

## Non-goals

- No behavior change. No new tier, no new gate, no new prompt.
- No change to `researchState`, `researchEvidenceGraph`,
  `researchReportLoop`, or `researchWorkspace` shape.
- No change to live-test recipes.
- No ADR yet — write ADR-0012 only when the implementation lands and
  the boundary becomes a real architecture decision.

## Recommended next step

Promote this spike to AGRUN-216 under the
`Runtime harness contract hardening` arc, sized as a single sprint
slice. Land in two PRs to keep diff review tractable:

1. Evidence subtree (5 files + facade rewire). Run `npm run check`
   and the 3-topic Chrome MCP regression before merging.
2. Report-loop subtree (8 files + facade rewire). Same verification.

After both land, re-evaluate whether `virtual-workspace.js` (876
lines) and `planner-tools.js` (817 lines) need similar treatment.
