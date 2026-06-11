# AGRUN-248-A — Workspace Candidate Lifecycle

Date: 2026-05-24

Status: DONE with HBR

## Scope

AGRUN-248-A promotes the virtual workspace candidate path contract into a first-class state machine:

```js
{
  activePath,
  draftPaths,
  lastWrittenPath,
  lastReadPath,
  finalizedPath,
  publishedPath,
  status
}
```

The runtime still does not choose report prose, source relevance, source scores, or the final candidate path for the AI. It only records mechanical artifact facts and exposes `candidatePathMismatchSignal` when candidate identity and file activity diverge.

## Reproduction

The motivating failure came from AGRUN-246-J after-traces on 2026-05-24:

- `agrun_docs/live-tests/agrun-246-j-after-trace-2026-05-24.md`
- Escalated Harness Engineering trace: selected `final_candidate.md` stayed empty while the model wrote an 80-word `report.md`.
- That was not a content-quality judgment failure alone; it was an artifact lifecycle visibility gap.

The later canonical post-249/250/251 retest improved path discipline (`final_candidate.md` held), but still failed length/source/structure quality:

- `agrun_docs/live-tests/agrun-246-j-mandarin-post-249-2026-05-24.md`
- Run `2026-05-24T13-30-33-942Z`
- `candidateCjkChars=1858/3000`, structure failed, source minimum failed, `qualityScore=31`

## Implementation

Runtime additions:

- `src/runtime/workspace-candidate-lifecycle.js`
  - State factory and normalizers.
  - Projection helper.
  - Write/read/finalize/publish lifecycle recorders.
  - `candidate_path_mismatch_signal` normalizer.
- `src/runtime/virtual-workspace.js`
  - `candidateLifecycle` and `candidatePathMismatchSignal` are part of normalized workspace state.
  - `workspace_write`, `workspace_replace`, `workspace_insert_after_section`, `workspace_apply_patch`, `workspace_move`, draft promotion, `workspace_read`, `workspace_finalize_candidate`, and publish candidate lifecycle paths update the state.
  - Workspace prompt block projects lifecycle facts and mismatch facts.
- `src/runtime/actions/virtual-workspace-actions.js`
  - Action outputs include lifecycle/mismatch projection where relevant.
  - Stale candidate publish emits `publish_stale_path` while preserving the existing publish behavior.
- `src/runtime/state.js`, `src/runtime/context.js`, approval resume state
  - `candidatePathMismatchSignal` is a loopState-level observable field.
- Inspector projections:
  - Node live summary includes `workspaceDiagnostics.candidateLifecycle` and `workspaceDiagnostics.candidatePathMismatchSignal`.
  - Browser `workspace_workflow_packet` and Debug Index include candidate lifecycle and mismatch signal.
  - Virtual Workspace Inspector UI displays active/written/read/finalized/published path facts.

## Acceptance Evidence

Focused unit coverage added:

- Write to selected path (`final_candidate.md`) records `lastWrittenPath` and emits no signal.
- Write to a different path (`report.md`) emits:

```js
{
  mismatchKind: "write_to_non_selected_path",
  selectedPath: "final_candidate.md",
  writtenPath: "report.md"
}
```

- Finalize without prior write emits `finalize_without_prior_write`.
- Publishing `final_candidate.md` after a fresher `report.md` write emits:

```js
{
  mismatchKind: "publish_stale_path",
  selectedPath: "final_candidate.md",
  writtenPath: "report.md"
}
```

The stale publish test completes rather than blocks, proving the signal is observable and non-authoring.

## Verification

Focused checks passed before full-suite verification:

- `node --check src/runtime/workspace-candidate-lifecycle.js`
- `node --check src/runtime/virtual-workspace.js`
- `node test/unit/virtual-workspace.test.js`
- `node test/unit/workspace-actions.test.js`

Full verification for the implementation commit:

- `npm test` — pass
- `npm run build` — pass
- `npm run dist:check` — pass (`265` markdown files)
- `npm run test:live:node-debug` — pass as a runtime baseline cell, run `2026-05-24T14-16-12-927Z`
  - `runStatus=completed`
  - `outputKind=final_response`
  - `decision=limited`
  - `candidatePath=final_candidate.md`
  - `workspaceDiagnostics.candidateLifecycle={ activePath:"final_candidate.md", lastWrittenPath:"final_candidate.md", lastReadPath:"final_candidate.md", finalizedPath:"final_candidate.md", publishedPath:"final_candidate.md", status:"published" }`
  - `workspaceDiagnostics.candidatePathMismatchSignal=null`

## HBR

This slice does not fix AGRUN-246-J long-form quality. It makes candidate identity failures visible. The model can still choose a weak report, over-read sources, leave TodoState stale, or publish limited content. The live node-debug baseline completed but quality remained poor: `candidateWords=432/3000`, `sourceMinimumPassed=false`, `userGoalSatisfied=false`, `qualityScore=32`. The next work remains AGRUN-248-B/C plus a later source/workspace-growth convergence fix.
