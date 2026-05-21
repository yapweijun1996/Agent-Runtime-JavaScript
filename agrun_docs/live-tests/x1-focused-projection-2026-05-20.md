# X1 Focused Projection Live Notes — 2026-05-20

## Scope

Validate `terminal_repair_hard_veto_focused` for `gemini-3.1-flash-lite` on `test/node-agrun-3000-live.mjs`.

## Changes Under Test

- Planner prompt projects a focused terminal repair contract before `User request:` when `terminalRepairState.active=true` and `escalation=hard_veto`.
- Terminal repair valid publish examples keep `validPublishContract.requiredArgsExample` as the SSOT.
- Hard-veto terminal repair collapses ready publish protocol to `workspace_publish_candidate`.
- Terminal repair allowlist no longer bypasses destructive length+structure rewrites.

## Verification

- `npm test` passed.
- `npm run build:lib` passed with existing Rollup dependency warnings.
- Simulator:
  - `current-conflict`: did not publish, chose recovery/search.
  - `focused-hard_veto`: chose `workspace_publish_candidate` with `decision=limited`, `lengthSatisfied=false`, `requirementSatisfied=false`, and concrete length + structure `remainingGaps`.

## Live Results

### Run 1

Stopped manually after hard_veto because the model entered a repeated `workspace_replace`/`finalize` loop.

HBR:
- Focused projection prevented the old misleading `workspace_read` choice.
- It was still too weak when `allowedActions` included repair actions; the model kept choosing repair/finalize instead of valid limited publish.

Follow-up fix:
- Hard-veto terminal repair now prefers publish protocol actions, then `workspace_publish_candidate`.
- Focused block now names `primaryAction`.

### Run 2

Artifact:
- `agrun_debug_runs/2026-05-20T01-57-06-865Z.jsonl`
- `agrun_debug_runs/2026-05-20T01-57-06-865Z.md`

Result:
- Completed through `workspace_publish_candidate`.
- `decision=limited`.
- `candidateWords=434`.
- `sourceMinimumPassed=true`.
- `finalCandidateStructureOk=true`.
- `remainingGaps=["Length is still short: observed 434/3000 words."]`.

HBR:
- Valid limited publish succeeded, but result is worse than X1.5.b baseline `648 candidateWords`.
- Raw JSONL showed the next bug: a terminal-repair-allowed `workspace_write` rewrote the candidate from a longer draft down to 434 words before hard_veto. The repair allowlist bypassed the length rewrite guard.

Follow-up fix:
- Length rewrite guard now runs before terminal repair allowlist bypass and applies to length+structure deficits.

### Run 3

Artifact:
- `agrun_debug_runs/2026-05-20T02-00-13-380Z.jsonl`
- `agrun_debug_runs/2026-05-20T02-00-13-380Z.md`

Result:
- Failed live acceptance before exercising terminal repair.
- The model ran repeated `web_search` then emitted `ask_clarification`.
- `candidateWords=0`.

HBR:
- This run is not a valid focused projection proof because it never reached workspace/terminal repair.

## Decision

Do not commit as a successful X1 fix yet. The focused hard_veto projection fixes the specific `workspace_read` misdirection and produces valid limited publish in simulator and one live run, but live quality is not clearly better than the X1.5.b baseline. Next work should target early long-form cadence and destructive rewrite prevention before treating X1 as complete.
