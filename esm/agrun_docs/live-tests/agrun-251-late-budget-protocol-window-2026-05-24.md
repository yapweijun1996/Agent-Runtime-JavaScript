# AGRUN-251 Late-Budget Protocol Window

Date: 2026-05-24

## Scope

Fix the AGRUN-250 follow-up HBR where an OpenAI stress run reached a valid 3000-word candidate but spent the final cycles on `workspace_propose_patch` / `workspace_apply_patch` / `workspace_finalize_candidate`, then hit `MAX_STEPS_EXCEEDED` before the required latest `workspace_read` and `workspace_publish_candidate`.

This slice is harness-only:

- No runtime-authored report prose.
- No automatic `workspace_read`.
- No automatic publish.
- No source or model hardcoding.
- No bypass of `workspace_finalize_candidate -> workspace_read -> workspace_publish_candidate`.

## Change

`action-loop-action.js` now has a late-budget workspace protocol preflight guard for requested-length workspace runs.

When the current cycle budget cannot fit the remaining publish protocol:

- `workspace_propose_patch` is blocked if fewer than 4 future cycles remain, because a changed candidate still needs `workspace_apply_patch -> workspace_finalize_candidate -> workspace_read -> workspace_publish_candidate`.
- workspace mutations such as `workspace_apply_patch`, `workspace_write`, `workspace_replace`, `workspace_insert_after_section`, `workspace_multi_edit`, `workspace_move`, and `workspace_remove` are blocked if fewer than 3 future cycles remain, because changed content still needs `workspace_finalize_candidate -> workspace_read -> workspace_publish_candidate`.

The block is an AI-visible observation with `allowedNextMoves`, `requiredProtocol`, `cyclesRemainingAfterCurrentAction`, `publishProtocol`, and TodoState facts. It does not choose content or terminal readiness.

`virtual-workspace.js` also treats `apply_patch` as a content-changing operation in `inspectWorkspacePublishProtocol()`, so a patch application requires a real later `workspace_read` before publish.

## Verification

Focused:

- `node test/unit/action-pattern-convergence.test.js`
- `node test/unit/virtual-workspace.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/terminal-repair-state.test.js`
- `node --check src/runtime/action-loop-action.js`
- `node --check src/runtime/virtual-workspace.js`

Full:

- `npm test`
- `npm run build`
- `npm run dist:check`
- `node --check agrun_docs/manifest.cjs`

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

- Run artifact: `agrun_debug_runs/2026-05-24T12-17-10-989Z.*`
- Status: `completed`
- Terminal path: `workspace_finalize_candidate -> workspace_read -> workspace_publish_candidate`
- Cycles: `43/60`
- Candidate: `3164/3000` words
- Source minimum: passed (`6` read sources, `4` relevant)
- Structure: passed
- `qualityScore`: `100/100`
- `userGoalSatisfied`: `true`

## HBR

The prior max-step failure did not reproduce. The run did not spend the last cycles on a new patch that left no read/publish budget.

Remaining bad result:

- The successful OpenAI rerun still took `733329ms` and `43` cycles.
- It attempted `workspace_publish_candidate` 5 times before the final successful publish.
- It created TodoState late and spent several cycles on `todo_run_next` / `todo_advance` before finalizing.
- The workspace operation log still includes several `insert_after_section` `not_found` operations.

So AGRUN-251 fixes the late mutation/protocol budget failure, but TodoState/publish readiness churn remains a future optimization target.
