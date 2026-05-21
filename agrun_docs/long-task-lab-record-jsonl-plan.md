# Long Task Lab Record JSONL Plan

Last updated: 2026-05-18

## Goal

Long Task Lab keeps every long-running task as a compact, durable record ledger
for debugging, evals, and future fine-tune preprocessing.

Current scope is intentionally browser-simple:

- IndexedDB is the only canonical runtime store.
- JSONL is a portable export/import format.
- The app auto-loads latest/history from IndexedDB on mount.
- Users can download `record.jsonl`, import an older JSONL file, copy selected
  run JSONL, or clear local records.
- The app does not use File System Access, `showDirectoryPicker`, directory
  handles, a local folder mirror, or a dev bridge.

## Architecture

Database: `agrun-long-task-lab-record-store`

Stores:

- `runs`: one run summary per `runRecordId`.
- `events`: append-only event rows keyed by `runRecordId + seq`.
- `artifacts`: final artifact events, keyed by the same event merge key.

Runtime flow:

1. `run_start` is recorded when a Long Task Lab run begins.
2. Every runtime `onStep` records a `runtime_step`.
3. Each step also records a compact `state_snapshot`.
4. Terminal success/failure/interruption records `run_end`.
5. Final output records `artifact` when available. New runs store both full
   `content` and bounded `contentPreview`; older imported records may only have
   `contentPreview`.
6. The Records tab reads IndexedDB on app mount and after import/run completion.
7. Runtime-step writes are queued and flushed before artifact/run_end so
   refresh/export observes a complete terminal ledger.

## Schema

Every JSONL line is a valid JSON object with:

- `schema`
- `type`
- `runRecordId`
- `seq`
- `at`
- `agrunRunId`
- `sessionId`
- `provider`
- `model`
- `payload`
- `redactionReport`

Event types:

- `run_start`
- `runtime_step`
- `state_snapshot`
- `artifact`
- `run_end`
- `qa_note`

Merge key: `runRecordId + seq`.

Security rules:

- Do not persist API keys, bearer tokens, auth headers, passwords, credentials,
  or raw localStorage secrets.
- Redaction must handle camelCase secret field names such as `openaiApiKey`,
  `readUrlApiKey`, and `customApiKey`, not only snake_case names.
- Secret-like value checks must be stateless across repeated calls; do not use
  a global regex for boolean secret detection.
- Persist only non-secret settings: provider, model, max steps, auto-approve
  flag, read_url enabled flag, and endpoint hostnames.
- Store compact debug summaries, not full Debug Packets by default.
- Treat raw JSONL as research/debug/eval source. Fine-tune data must be curated
  from records before training.

## UI

The Records tab shows:

- status
- provider/model
- prompt preview
- duration
- cycles
- evidence counts
- latest action
- error
- selected-run final report reader
- selected-run record log

Actions:

- Export selected run JSONL
- Export all runs JSONL as `record.jsonl`
- Export eval dataset rows as `record-eval.jsonl`
- Export fine-tune candidate rows as `record-finetune-candidates.jsonl`
- Import JSONL and merge into IndexedDB
- Clear local records
- Copy selected run JSONL

Dataset review:

- The selected run shows a review panel with artifact readiness, usable
  evidence count, verdict, quality, and reviewer notes.
- Review metadata is local browser metadata keyed by `runRecordId`; it is not
  an API key or provider setting and is not written through File System Access.
- Fine-tune candidate export is blocked until candidate rows are marked
  `approved` in the review panel.
- Exported fine-tune candidate rows include the review metadata but still keep
  `includeForTraining: false`; this JSONL is candidate/eval material, not a
  direct training upload.

History reader:

- Selecting a run opens a readable `Final Report` panel from the selected
  artifact event.
- Run history can be filtered by prompt/model/action/error text, status, and
  date range so demos with many completed records remain inspectable.
- New records read full `payload.content`; legacy records fall back to
  `payload.contentPreview` and mark preview-only when the stored length is
  larger than the available text.
- `Final Report` has Markdown and Raw tabs. Markdown is rendered through a
  small React renderer without `dangerouslySetInnerHTML`; Raw keeps the exact
  stored artifact text for debugging/copy comparison.
- `Record Log` shows event-type counts, an event type filter, and the latest
  120 filtered event rows by default so large runs stay usable in the browser.
  Full fidelity remains available through selected/all JSONL export.

Clear is disabled while a run is active so the currently executing run is not
broken by a destructive local-record action.

## Timeline and Debug Demo UI

Long Task Lab now projects raw runtime steps into grouped timeline insights so
end users can see recovery/block cycles without reading every low-level event.
The projector classifies steps into progress, evidence, workspace, recovery,
blocked, and failed categories, then collapses consecutive matching events.

Debug Packet keeps the raw compact packet available, but the first view now
shows summary tiles for run status, cycles, latest action, evidence, workspace
publish state, recovery pressure, terminal repair, and convergence.

## Verification

Automated:

- `npm run test:long-task-lab`
  - JSONL serialization produces one JSON object per line.
  - Bad JSON/scalar lines are quarantined without blocking good lines.
  - Secret-like values and camelCase secret keys are redacted.
  - Repeated secret-like checks are stable.
  - IndexedDB import is idempotent by `runRecordId + seq`.
  - latest/history reads work.
  - Fire-and-forget runtime-step writes flush before `run_end`.
  - Timeline insight grouping collapses repeated blocked/recovery rows.
  - Fine-tune candidate rows can carry local review metadata.
- `npm run build:long-task-lab`
- `npm test`

UI review performed on 2026-05-18:

1. Desktop Chrome DevTools opened `http://localhost:3001/`.
2. Records auto-loaded the existing completed IndexedDB run.
3. Fine-tune candidate export was blocked before review.
4. Setting verdict `approved`, quality `good`, and notes enabled candidate
   export with a training-still-requires-approval warning.
5. Debug Packet showed summary tiles before raw JSON.
6. Mobile viewport check showed no page-level horizontal overflow; the records
   table scrolls inside its own container and review metrics collapse to one
   column.
7. Added form `id`/`name` attributes, hidden file input label, reset
   `aria-label`, and inline favicon after live QA warnings.

History reader fix performed on 2026-05-18:

1. Reproduced that a completed run was visible in Records but lacked a direct
   final report reader.
2. Added `lab-record-view.ts` to project selected events into a final report,
   event-type counts, and event rows.
3. Updated artifact projection so future runs store full final report content.
4. Added Records UI for `Open`, `Final Report`, `Copy report`, and `Record Log`.
5. Chrome DevTools proof: selected completed run
  `lab-a288f88c-a922-47be-8a60-c7c0b0942b12` showed a 3529-character final
  report and `120 shown / 997 events` with no page-level horizontal overflow.

Record reader controls performed on 2026-05-18:

1. Added run search by prompt/model/action/error, status filter, and date
   filter to the Records history table.
2. Added Record Log event type filtering so artifact/runtime/state/run_end rows
   can be inspected separately.
3. Added Final Report Markdown/Raw tabs; Markdown renders headings, lists,
   links, and bold text as React nodes, while Raw preserves exact artifact text.
4. Chrome DevTools proof on the existing completed run:
   `matchingRows=1`, no-match search produced `No records match current
   filters`, artifact filter showed `1 shown / 1 filtered / 997 events`,
   Markdown rendered the market memo heading and source links, Raw preserved
   3529 characters, and desktop/mobile checks had no page-level horizontal
   overflow.

Review hardening performed on 2026-05-18:

1. Fixed camelCase secret-key redaction and global-regex secret check state.
2. Added projector write flushing before artifact/run_end.
3. Switched generated `LabRun.id` values to `crypto.randomUUID()` with fallback.
4. Verified with `npm run test:long-task-lab`, `npm run build:long-task-lab`,
   `npm test`, a standalone secret-regression script, and `git diff --check`.

Live E2E performed on 2026-05-18:

1. Reproduced the default Market Research preset failure as a
   terminal-repair loop where AI supplied `finalReadiness.limitations` but no
   `requirementsAssessment.remainingGaps`.
2. Scoped the tolerance to terminal-repair preflight only; Research Gate
   publish validation still requires explicit remaining gaps.
3. Reran OpenAI `gpt-5.4-mini`, maxSteps 30, auto-approve tier 1 enabled.
4. The run completed in 20 runtime cycles via `workspace_publish_candidate`.
5. IndexedDB contained 1 completed run, 997 events, and 1 artifact.
6. Records tab auto-loaded the completed run after reload.
7. Eval export reported 1 eval row.
8. Fine-tune candidate export reported 1 review-required candidate row.
9. Clear + Import restored all 997 events with 0 skipped and 0 quarantined.
10. Serialized record scan found no OpenAI/Gemini/Bearer-like secrets.

Live E2E performed on 2026-05-17:

1. Started Long Task Lab at `http://localhost:3001/`.
2. Ran an OpenAI `gpt-5.4-mini` auto-approve task.
3. IndexedDB contained 1 run, 97 events, and 1 artifact.
4. Reloaded the page; Records tab auto-loaded the latest run.
5. Export All downloaded `record.jsonl` and reported 97 exported events.
6. Cleared local records from the UI.
7. Imported a JSONL file through the Records import control.
8. Records tab restored the imported run summary and events.
9. Checked localStorage and IndexedDB for API key / bearer / auth leakage.

## HBR

The latest OpenAI default-preset live run completed with a usable memo, but the
Timeline still shows several recovery/block cycles before publish. Evidence was
honest but imperfect: 2 usable/strong reads and 1 thin failed read. This is now
demo-suitable for record/debug/export behavior, not a benchmark-quality market
research report claim.
