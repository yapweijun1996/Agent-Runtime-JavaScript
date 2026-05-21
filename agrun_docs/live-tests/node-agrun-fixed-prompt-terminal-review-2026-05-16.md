# Node agrun fixed-prompt terminal review — 2026-05-16

## Prompt

```txt
Write a 3000-word deep research report on "What is Harness Engineering in AI agent systems". Use web_search and read_url to ground every section in real sources. Cite at least 3 authoritative URLs. Structure: Definition, Core Principles, Concrete Patterns, Anti-patterns, Real-World Examples, Conclusion.
```

## Result

Status: BLOCKED, not DONE.

The fixed Node command was rerun against real provider/search/read_url after runtime fixes:

```bash
npm run build && npm run dist:check && NODE_AGRUN_LIVE_MAX_STEPS=90 npm run test:live:node-3000
```

Useful progress:
- `sourceMinimumPassed=true` in later live failures.
- Successful read_url/source counts were no longer misreported as zero.
- `finalCandidateStructureOk=true` in several runs, so duplicate heading/section structure is no longer the only blocker.
- Terminal repair now models `missing_finalize_after_latest_write` and `missing_latest_workspace_read` as protocol recovery states.
- Plan validation now applies the same runtime action surface as the top-level planner, so plan child actions cannot bypass read-only planning or terminal repair filters.
- Terminal repair no longer opens broad `web_search/read_url` when source is already satisfied and the active blocker is length/todo/readiness.
- Structured TodoState/workspace search loops now use productive-only convergence even without explicit `long_research` activation.
- Length-deficit workspace churn no longer treats `workspace.version` growth as productive when candidate word count does not grow.

HBR:
- Live acceptance still failed; this task is not DONE.
- Run A after protocol fixes: `sourceMinimumPassed=true`, `finalCandidateStructureOk=true`, `candidateWords=1954`, terminalized by `max_steps_continuation`.
- Run B exposed an early `web_search/todo_plan` loop; first `read_url` did not appear until step 76, then candidate ended at `1836` words with structure issues.
- Run C after structured search-loop fix reached `successfulReadUrlCount=6`, `sourceMinimumPassed=true`, `finalCandidateStructureOk=true`, but candidate was only `1494` words after many `workspace_write/read/replace` operations and ended at `max_steps_continuation`.
- The newest root cause is length-deficit workspace churn: AI mutates the workspace many times without materially increasing candidate words, then tries publish too late.

## Next Fix Direction

2026-05-16 follow-up:
- Added generic `lengthProgress` and `mutationStats` to workspace read/write/append/insert/replace observations so the AI sees `requestedLength`, `observedLength`, and `remainingLength` instead of doing hidden arithmetic.
- Updated `long-web-research` guidance to size expansion from `lengthProgress.remainingLength`.
- Tightened terminal repair action surface: `workspace_finalize_candidate` is exposed only for the explicit `missing_finalize_after_latest_write` protocol state; plain terminal repair for source/length/structure/todo/terminal-loop must do productive recovery first.
- Tightened plain publish exposure: `workspace_publish_candidate` is no longer a default repair action while budget is enough or structure is still broken; low-budget publish remains available only when structure is not an active deficit.

Verification:
- `node test/unit/workspace-actions.test.js` passed.
- `node test/unit/action-pattern-convergence.test.js` passed.
- `node test/unit/terminal-repair-state.test.js` passed.
- `node test/unit/planner-action-surface.test.js` passed.
- `node test/unit/plan-validation-recovery.test.js` passed.
- `npm test` passed after each repair-surface change.
- `npm run build && npm run dist:check` passed.

HBR after follow-up:
- Live run after `lengthProgress` improved action choice but failed at max steps: `candidateWords=1179`, `sourceMinimum.passed=false`, `finalCandidateStructureOk=false`, and repeated `workspace_finalize_candidate` showed terminal repair still exposed no-op finalize.
- Live run after hiding no-op finalize failed at max steps: `candidateWords=1633`, `sourceMinimum.passed=false`, `finalCandidateStructureOk=false`, and repeated plain `workspace_publish_candidate` showed publish itself was still a no-progress terminal loop.
- Live run after hiding plain publish failed by provider timeout (`PLANNER_ERROR: request timed out for gemini`) before acceptance evidence. It did not prove the fix; candidate summary was unusable (`candidateWords=0`, `successfulReadUrlCount=1`).

Current status remains BLOCKED, not DONE. The next run must prove the new action surface with a non-timeout live execution. If it still fails, inspect source relevance scoring and read-only planning recovery, because latest failures show `readSources=4` but `relevantSources=0-1`.

## Node Debug Harness Pivot

2026-05-16 update: the next step is to make failures cheaper and clearer before
continuing full 3000-word retries.

Added test-harness-only debug support:

```bash
NODE_AGRUN_LIVE_WORDS=1000 NODE_AGRUN_LIVE_MAX_STEPS=40 npm run test:live:node-debug
```

Debug controls:
- `NODE_AGRUN_LIVE_WORDS` changes the fixture prompt target while preserving the
  same topic/source/structure contract.
- `AGRUN_DEBUG=1` writes `agrun_debug_runs/<runId>.jsonl` and
  `agrun_debug_runs/<runId>.md`.
- The Markdown report records run config, final audit, issue hints, action
  counts, source ledger, workspace ledger, terminal repair state, convergence
  state, requirement recovery, event ledger, and raw summary.

First 1000-word / 40-step diagnostic result:
- Artifact:
  `agrun_debug_runs/2026-05-16T05-45-23-780Z.md`
- `candidateWords=1038` for `requestedWords=1000`.
- `successfulReadUrlCount=4`.
- `sourceMinimumPassed=true` with 4 strong read sources.
- `finalCandidateStructureOk=true`.
- HBR: run still failed with `MAX_STEPS_EXCEEDED`; `terminalRepairState.active=true`,
  `allowedActions=["workspace_read"]`, and
  `reason="missing_latest_workspace_read"`.

Interpretation: the 1000-word ladder shows source, length, and structure can
pass under the shorter target. The active blocker is terminal publish protocol
convergence under tight step budget: the AI reached `workspace_read` /
`workspace_publish_candidate` / `workspace_finalize_candidate` too late and
needed one more `workspace_read` after finalization.

Next diagnostic ladder:
1. Re-run 1000 words with the compacted debug report after assertion-message
   cleanup to verify the artifact stays readable.
2. If 1000/40 still lands in `missing_latest_workspace_read`, decide whether
   40 steps is too tight for this protocol or whether the publish/finalize/read
   ordering needs a generic AI-first prompt/action-surface improvement.
3. Only after 1000 passes, move to 1500/40, 2000/50, then 3000/70-90.

## Protocol Follow-Up

The first 1000/40 run exposed that terminal repair was stricter than
`workspace_publish_candidate` itself. Publish only requires `workspace_read`
after the latest content change, but terminal repair advanced from
`missing_finalize_after_latest_write` to `missing_latest_workspace_read`
unconditionally after `workspace_finalize_candidate`.

Generic fix:
- `workspace_finalize_candidate` now includes `publishProtocol` in its action
  output.
- `terminalRepairState` checks that protocol after finalize. If the latest
  content was already read and finalize did not change content, repair returns
  to the publish contract instead of forcing a duplicate read.

Verification:
- `node test/unit/terminal-repair-state.test.js` passed.
- `node test/unit/workspace-actions.test.js` passed.
- `npm test` passed.
- `npm run build` passed.
- `npm run dist:check` passed.

Second 1000-word / 40-step diagnostic result after this fix:
- Artifact:
  `agrun_debug_runs/2026-05-16T05-55-27-891Z.md`
- No longer blocked on `missing_latest_workspace_read`.
- HBR: still failed as `max_steps_continuation`.
- `candidateWords=933` for `requestedWords=1000`.
- `successfulReadUrlCount=2`.
- `sourceMinimumPassed=false` (`readSources=2`, `relevantSources=1`).
- `finalCandidateStructureOk=false` with `duplicate_headings` and
  `repeated_conclusion`.
- `terminalRepairState.activeDeficits=["source","length","structure","todo"]`.

Interpretation: the duplicate-read protocol bug is fixed. The remaining 1000/40
failure is a genuine tight-budget convergence problem: source acquisition,
structure repair, length completion, and TodoState sync all remain active at the
40-step boundary.

Third diagnostic run, 1000 words / 50 steps:
- Artifact:
  `agrun_debug_runs/2026-05-16T06-01-16-677Z.md`
- HBR: still failed as `max_steps_continuation`.
- Source gate passed: `successfulReadUrlCount=4`, `sourceMinimumPassed=true`,
  `readSources=4`, `relevantSources=2`.
- Candidate remained short: `candidateWords=892` for `requestedWords=1000`.
- Structure still failed with `duplicate_headings`.
- TodoState still had unfinished work (`unfinishedCount=4`).
- Terminal repair active deficits were `["length","structure","todo"]`, with
  allowed actions `["workspace_write","workspace_replace"]`.

Interpretation: 50 steps fixed neither structure nor length/Todo convergence
after source satisfaction. The next likely tuning target is not more source
logic; it is the AI-facing repair contract for structure+length together,
especially avoiding repeated `workspace_read` and ensuring one coherent
rewrite/replace that removes duplicate headings and reaches the requested word
count.

## 3000-Word Agent Workflow Trace Follow-Up

Run:

```bash
NODE_AGRUN_LIVE_MAX_STEPS=90 AGRUN_DEBUG=1 npm run test:live:node-3000
```

Artifact:

- `agrun_debug_runs/2026-05-16T10-52-56-909Z.md`

Result:

- HBR: still failed as `max_steps_continuation`.
- `candidateWords=1681` for `requestedWords=3000`.
- Source gate passed: `sourceMinimumPassed=true`, `readSources=3`,
  `relevantSources=2`, `successfulReadUrlCount=3`.
- Structure passed: `finalCandidateStructureOk=true`.
- Workspace did produce real progress: `write=17`, `append=14`,
  `replace=5`, `insert_after_section=1`.
- The final active deficits were `["length","todo","readiness","terminal_loop"]`.
- The upgraded Agent Workflow Trace Packet captured the exact final
  `workspace_publish_candidate` payloads.

Key debug finding:

- Step 89 payload was close to valid limited readiness:
  `decision=limited`, `evidenceSatisfied=true`, `lengthSatisfied=false`,
  `requirementSatisfied=false`, and concrete length gaps.
- It was still blocked by terminal repair because TodoState was an active
  deficit and `remainingGaps` did not name Todo/task/progress/plan.
- Step 90 also failed the same class of contract and additionally had
  `checkedReadinessAgainstUserRequest=null`.

Follow-up debug change:

- `terminal-repair-state.js` now exports
  `explainTerminalRepairPublishArgs()`.
- `action-loop-action.js` includes `invalidPublishReasons` in terminal repair
  and terminal correction publish blocks.
- This is debug/observability only. It does not hardcode report content,
  auto-complete TodoState, auto-finalize, or let runtime judge answer quality.

Verification after the debug change:

- `node --check src/runtime/terminal-repair-state.js` passed.
- `node --check src/runtime/action-loop-action.js` passed.
- `node test/unit/terminal-repair-state.test.js` passed.
- `node test/unit/workspace-actions.test.js` passed.
- `npm run build` passed.
- `npm run dist:check` passed.

Current interpretation:

The source and structure gates are no longer the primary blocker in this run.
The current blocker is workflow cadence and terminal contract obedience:
the AI spends many steps rewriting/reading and reaches a valid-looking limited
publish too late, but misses TodoState in `remainingGaps`. The next improvement
should be a harness-level cadence contract for long research runs: after source
minimum passes, the planner-visible action surface should bias toward
section-level expansion with explicit length deltas and TodoState sync/limited
publish requirements, while preserving AI ownership of content.

## Path-Aware Publish + Protocol Follow-Up

Additional baseline after `invalidPublishReasons`:

```bash
npm run build && npm run dist:check && NODE_AGRUN_LIVE_MAX_STEPS=90 npm run test:live:node-3000
```

Result:

- HBR: still failed as `max_steps_continuation`.
- `candidateWords=1266/3000` on selected `final_candidate.md`.
- A stronger alternate workspace file existed:
  `harness_engineering_report.md` had approximately `3379` words.
- Source gate passed: `readSources=10`, `relevantSources=10`.
- Structure passed on selected final candidate.
- AI attempted to publish `harness_engineering_report.md`, but terminal repair
  still validated the length deficit against `final_candidate.md`.

Root cause:

- Terminal repair publish validation was path-insensitive. It treated the
  selected final candidate as the only length truth even when the AI explicitly
  passed a different workspace `path` to `workspace_publish_candidate`.

Generic fix:

- `explainTerminalRepairPublishArgs()` and
  `isValidTerminalRepairPublishArgs()` now accept `{ runState }`.
- If `workspace_publish_candidate.path` points to a workspace file whose
  observable text stats satisfy the requested length, the length deficit is
  removed from the publish validation's effective deficits.
- `workspace_publish_candidate` TodoState limited-publish audit now passes the
  publish path into terminal repair validation.
- This does not choose a file for the AI; it only validates the path the AI
  selected using observable workspace facts.

Second follow-up:

- Another fixed live run still failed as `max_steps_continuation` with
  `candidateWords=1603/3000`, source/structure passing, and final
  `workspace_publish_candidate` declaring a valid limited length gap.
- Because the final publish arrived at step 89/90, a protocol block would still
  leave no budget for finalize/read/publish recovery.

Generic fix:

- Low-budget length repair now also exposes the existing publish protocol move
  for the selected final candidate:
  `workspace_finalize_candidate` if the candidate has not been finalized after
  latest write, or `workspace_read` if it has not been read after latest
  content change.
- This reuses `inspectWorkspacePublishProtocol()` instead of adding a topic
  branch.

Verification:

- `node --check src/runtime/terminal-repair-state.js` passed.
- `node --check src/runtime/action-loop-action.js` passed.
- `node --check src/runtime/actions/virtual-workspace-actions.js` passed.
- `node test/unit/terminal-repair-state.test.js` passed.
- `node test/unit/workspace-actions.test.js` passed.
- `npm test && npm run build && npm run dist:check` passed.

Latest fixed-command live result after both fixes:

- HBR: still failed as `max_steps_continuation`.
- `candidateWords=1916/3000`.
- `finalCandidateStructureOk=true`.
- `sourceMinimumPassed=true`, `readSources=8`, `relevantSources=2`.
- `actionPatternConvergence.cooldownActive=false`.
- `repeatedSemanticFingerprintCount=1`.
- Low-budget terminal repair correctly exposed
  `["workspace_finalize_candidate","workspace_append","workspace_insert_after_section","workspace_publish_candidate"]`.
- AI ignored the exposed finalize path, continued append/write, and published
  limited at step 90 with `lengthSatisfied=false`.

Current interpretation:

The harness now exposes the right observable protocol actions and validates the
AI-selected path correctly. The remaining failing dimension is not source,
structure, or terminal protocol visibility; it is the model's inability under
90 steps to produce and preserve a 3000-word final candidate. The model
repeatedly writes summaries claiming "3000+ words" while observable workspace
stats remain around 1.6k-1.9k words. This currently looks like a Gemini Flash
length/obedience ceiling plus long-form cadence weakness, not a missing
runtime signal.
