# Long Task Lab Record Reader Live Test — 2026-05-18

## Scope

Fix and verify the completed-run history reader gap:

- completed runs must be selectable one by one;
- selected run must show the AI-generated final report;
- selected run must show a readable record/event log;
- large event logs must not freeze the UI.

## Root Cause

Records stored run summaries and artifact events, but the Records UI only
rendered the run table, summary facts, and dataset review controls. There was
no selected-run final report reader or record log viewer. New artifact events
also stored only `contentPreview`, so future records should store full
`content` as well.

## Fix

- Added `examples/long-task-lab/src/runtime/lab-record-view.ts`.
- `recordArtifact()` now stores full `payload.content` plus
  `payload.contentPreview`.
- Records table has an `Open` action per run.
- Selected run now renders:
  - `Final Report`
  - `Copy report`
  - artifact metadata
  - `Record Log`
  - event-type counts
  - latest 120 event rows out of the full event count
- Legacy records fall back to `contentPreview`; they are marked preview-only
  only when stored `length` is larger than available text.

## MCP Chrome Proof

URL: `http://localhost:3001/`

Existing completed run:

- `runRecordId`: `lab-a288f88c-a922-47be-8a60-c7c0b0942b12`
- status: `completed`
- cycles: `20`
- events: `997`
- artifact chars: `3529`
- latest action: `workspace_publish_candidate`

Chrome DevTools script result:

```json
{
  "hasFinalReport": true,
  "reportChars": 3529,
  "renderedEventRows": 120,
  "logHeading": "120 shown / 997 events",
  "overflowX": false,
  "fieldProblems": 0
}
```

Mobile viewport check:

```json
{
  "overflowX": false,
  "reportHeight": 360,
  "reportScroll": { "client": 358, "scroll": 1951 },
  "eventRows": 120,
  "eventScroll": { "client": 320, "scroll": 8884 },
  "logHeading": "120 shown / 997 events"
}
```

## Verification Commands

```bash
npm run test:long-task-lab
npm --prefix examples/long-task-lab run build
```

## HBR

Chrome still reports one generic form-label issue, but direct DOM audit found
zero current `input/select/textarea` controls without label/id/name. The
completed run used for proof is an existing IndexedDB record; future runs will
store full `payload.content`, while older records can only show what was
previously saved.
