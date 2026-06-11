# AGRUN-248-C Inspector eventLedger Phase 2 Audit

Date: 2026-05-25
Status: DONE with HBR

## Project Goal

`agrun.js` is a general frontend harness runtime. Inspector surfaces should read a typed runtime event stream where practical instead of repeatedly deriving production ledgers only from legacy `runtime.steps`.

## Issue

AGRUN-248-C Phase 1 introduced a live typed `eventLedger`, and the token-delta follow-up wired provider/finalizer stream events into it. Browser Inspector still received only legacy `runtime.steps`, so the 7 production `build*Ledger` projections could not consume typed events.

## Change

- Runtime final results now attach a plain cloned `runState.eventLedger[]` snapshot while `snapshotRunState()` still strips the live ledger object.
- Runtime step snapshots now include a plain cloned `eventLedger[]` for streaming Browser debug updates.
- `projectInspectorRunState()` preserves cloned plain `eventLedger[]` arrays, but still omits the live ledger object.
- Browser debug snapshots expose `runtime.eventLedger`.
- The 7 Browser Inspector ledger projections now share `collectRuntimeSteps()`, which prefers typed `runtime.eventLedger` events and falls back to legacy `runtime.steps`.
- Provider stream event types are rendered in OODAE packet, AI Workflow, Runtime Lifecycle, and Inspector Event Stream projections.
- Added `examples/browser/test/inspector-event-ledger.smoke.ts` to prove all 7 projections read from eventLedger and ignore conflicting legacy steps when the typed ledger is present.

## Verification

- `node --check src/runtime/result.js`
- `node --check src/runtime/context.js`
- `node --check src/runtime/run-state-projections.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/run-state-projections.test.js`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke`
- `npm run build`
- `npm test`
- `npm run dist:check` (275 markdown files)
- `git diff --check`
- `task.jsonl` parse (145 entries)
- Codeloom `audit_diff` over runtime result/context/projections, Browser debug/types/ledger projections, and focused tests.

## HBR

- The migration preserves legacy `runtime.steps` fallback, so old debug snapshots still work, but mixed carried-runtime-step replay remains partly legacy by design.
- This does not implement the later LangGraph-style mode subscription API; it only makes production Inspector projections consume the typed ledger when present.
