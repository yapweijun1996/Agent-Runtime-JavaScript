# AGRUN-252 Todo Publish Readiness Churn

Date: 2026-05-24

## Scope

Reduce the AGRUN-251 follow-up churn where a run had already satisfied the
observable source, length, and structure gates, but still alternated between
`workspace_publish_candidate` limited attempts and `todo_run_next` /
`todo_advance` because TodoState was unfinished.

This slice stays harness-only:

- No runtime-authored Todo completion.
- No automatic publish.
- No report prose hardcoding.
- No weakening of `workspace_finalize_candidate -> workspace_read ->
  workspace_publish_candidate`.

## Change

Todo deficits now gate terminal publish through the same constrained-budget
contract used for structure repair:

- `terminalRepairState.allowedActions` no longer includes
  `workspace_publish_candidate` for Todo-only repair while budget remains
  enough.
- `validPublishContract.todoRequirement` explains that TodoState must be
  synchronized with `todo_advance`, `todo_run_next`, or `todo_cancel` before
  publish while budget remains.
- `validPublishContract.requiredArgsExample` is withheld for Todo deficits
  until repair is budget-constrained or hard-vetoed.
- `isValidTerminalRepairPublishArgs()` reports
  `todo_deficit_must_be_synchronized_before_publish` while TodoState can still
  be synchronized.
- `workspace_publish_candidate` limited Todo bypass now requires both
  `workspace_publish_candidate` in `terminalRepairState.allowedActions` and a
  constrained terminal repair state.
- Planner prompts now state that valid limited publish is available only when
  `workspace_publish_candidate` is explicitly listed in
  `terminalRepairState.allowedActions`.

## Verification

Focused:

- `node --check src/runtime/terminal-repair-state.js`
- `node --check src/runtime/actions/virtual-workspace-actions.js`
- `node test/unit/terminal-repair-state.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/planner-prompt-terminal-repair-focused.test.js`
- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`

Full local:

- `npm test`
- `npm run build`

Live stress rerun:

```bash
AGRUN_DEBUG=1 \
NODE_AGRUN_LIVE_PROVIDER=openai \
NODE_AGRUN_LIVE_MODEL=gpt-5-mini \
NODE_AGRUN_LIVE_MAX_STEPS=60 \
NODE_AGRUN_LIVE_TIMEOUT_MS=300000 \
npm run test:live:node-3000
```

Result:

- Run artifact: `agrun_debug_runs/2026-05-24T12-51-52-751Z.*`
- Status: `completed`
- Terminal path: `workspace_finalize_candidate -> workspace_read ->
  workspace_publish_candidate`
- Cycles: `53/60`
- Candidate: `3087/3000` words
- Source minimum: passed (`10` read sources, `4` relevant)
- Structure: passed
- `qualityScore`: `100/100`
- `userGoalSatisfied`: `true`
- `workspace_publish_candidate`: `2` attempts, `maxConsecutivePublishCandidate=1`
- Todo: the run selected `todo_advance` at cycle 44 before any publish attempt;
  no Todo-limited publish churn was observed.

## HBR

The specific Todo/publish readiness churn improved: the prior successful OpenAI
run used `5` publish attempts with late Todo sync, while this run used `2`
publish attempts and synchronized Todo before publish.

The run is still too slow:

- Duration was `1381027ms`.
- It used `53/60` cycles.
- It still performed `13` workspace reads, `11` web searches, and `10` read_url
  calls.
- `workspace_insert_after_section` still logged several `not_found` operations.
- The first publish attempt happened before the post-patch finalize/read
  protocol was satisfied, then terminal repair correctly forced
  `workspace_finalize_candidate -> workspace_read -> workspace_publish_candidate`.

So AGRUN-252 reduces Todo/publish churn without runtime auto-completion, but
read-only/source/workspace-growth convergence remains the next performance
target.
