# Long Task Lab Gemini PushStep Fix + Records Demo — 2026-05-18

## Goal

Fix the Gemini `plan/read_url` regression from the prior PWA/provider E2E run
and add a repeatable Records demo command that proves JSONL export/import can
restore a readable final report.

## Root Cause

The previous Gemini run failed after a `read_url` plan step with:

```text
Cannot read properties of undefined (reading 'pushStep')
```

The runtime path was:

1. `read_url` completed.
2. Todo autopilot advanced the TodoState through `todo_run_next`.
3. `detectVerifierNudge(context, todoState)` assumed `context.pushStep`
   existed.
4. Some auto-progress callers invoked `applyTodoRunNextToRunState` without an
   action context, so `context` was undefined.

## Implementation

- Guarded `detectVerifierNudge` so it only calls `pushStep` when a context is
  present.
- Passed the normal action context into `applyTodoRunNextToRunState` from both
  plan-action and direct-action auto-progress paths.
- Added a regression test for `applyTodoRunNextToRunState(runState, {})`
  without context.
- Fixed the planner mock helper so OpenAI empty-output repair retries preserve
  empty-section failure semantics during `npm test`.
- Added `npm run demo:long-task-lab:records`.
- Added `examples/long-task-lab/test/live-records-demo.mjs`.
- Added a Records Checklist button that copies a Markdown demo checklist from
  the selected record state.

## Records Demo Proof

Command:

```bash
npm run demo:long-task-lab:records
```

Result:

```json
{
  "eventCount": 4,
  "reportChars": 587,
  "runRecordId": "lab-demo-record-1779082732984",
  "liveRun": false,
  "status": "completed"
}
```

The command starts Vite and a clean headless Chrome CDP profile, imports a
schema-valid JSONL fixture, exports selected `record.jsonl`, clears IndexedDB,
imports the exported JSONL through the Records UI file input, and verifies the
restored record still has events and a readable Final Report.

Live OpenAI mode is available with:

```bash
npm run demo:long-task-lab:records -- --live-run
```

HBR from live OpenAI mode during this task: real-provider runs are too
nondeterministic for a quick Records harness. Two OpenAI attempts exceeded the
script timeout or did not terminalize quickly enough, so the default command is
the deterministic Records harness and provider live runs stay as explicit E2E.

## Gemini Live E2E Proof

Chrome DevTools page:

`http://127.0.0.1:4177/?qa=gemini-live-e2e`

Configuration:

- Provider: Gemini
- Model: `gemini-3-pro-preview`
- maxSteps: 45
- auto-approve tier 1
- web_search and read_url endpoints loaded from `.env.local`

Result:

```json
{
  "status": "completed",
  "cycles": 23,
  "latestAction": "workspace_publish_candidate",
  "eventCount": 1291,
  "artifactChars": 3187,
  "hasPushStepError": false
}
```

UI proof:

```text
Final artifact ready
completed
Runtime cycles 23 / 45
Latest action workspace_publish_candidate
```

Records proof:

- Latest run provider: `gemini`
- Latest run status: `completed`
- Artifact event present with 3187 chars.
- Run end event present.
- Event ledger had 1291 events.
- Event JSON scan did not include `pushStep` or
  `Cannot read properties of undefined`.

Console proof:

- No uncaught runtime error.
- Only dev/browser warnings were present:
  - Vite debug connect messages.
  - React DevTools suggestion.
  - Browser autocomplete/password accessibility warnings.

## Verification Commands

- `node --check examples/long-task-lab/test/live-records-demo.mjs`
- `npm run demo:long-task-lab:records`
- `node test/unit/todo-actions.test.js`
- `node test/unit/todo-action-progress.test.js`
- `npm run test:long-task-lab`
- `npm --prefix examples/long-task-lab run build`
- `npm run build:lib`
- `node test/concerns/planner.test.js`
- `npm test`

Final full-project verification is recorded in the task board.

## HBR

The default Records demo intentionally uses a deterministic fixture because a
real provider mission can run longer than a practical quick-demo window. This
does not weaken the Gemini fix proof: Gemini was separately tested live through
Chrome DevTools and completed successfully with no `pushStep` error.

Codeloom `audit_diff` was attempted for the changed files but still failed with
a JSON-RPC deserialize transport error, so code-graph blast-radius proof is
unavailable for this run.
