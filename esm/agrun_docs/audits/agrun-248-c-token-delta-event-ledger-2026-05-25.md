# AGRUN-248-C Token Delta Event Ledger Follow-Up — 2026-05-25

## Status

DONE with HBR.

## Project Goal

Finish the known AGRUN-248-C Phase 1 gap by wiring provider/finalizer streaming
token deltas into the typed runtime `eventLedger` without changing existing
`onToken` or `onStreamEvent` host behavior.

## Implementation

- Extended `requestProviderCompletionStreaming()` with an optional
  `streamContext` parameter.
- `provider.js` now forwards that context into `createProviderStreamEmitter()`
  while preserving provider/model normalization from the actual request.
- `runtime-finalize.js` now passes finalizer `callId`, terminal source, run id,
  and `runState.eventLedger` into the provider streaming path for both first
  attempt and empty-response retry.
- `provider-stream-events.js` now preserves `source` on normalized stream
  events, so ledger payloads can distinguish `planner_finalize`,
  `runtime_finalize`, and test/future host sources.
- Added unit coverage proving provider streaming writes
  `provider_stream_start`, `provider_text_delta`, and
  `provider_stream_finish` into `eventLedger` with `mode:"stream"`, ordered
  sequence, call id, source, delta, and live cycle stamping.

## Verification

- `node --check src/runtime/provider.js`
- `node --check src/runtime/runtime-finalize.js`
- `node --check src/runtime/provider-stream-events.js`
- `node --check test/unit/mock-provider-plan-loop.test.js`
- `node --check test/unit/provider-stream-events.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/provider-stream-events.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/mock-provider-plan-loop.test.js`
- `npm run build`
- `npm test`

All listed checks passed. Build warnings were the existing Rollup
OpenTelemetry `this` rewrite, Zod circular dependency, and Browser example
chunk-size warning.

## HBR

This wires provider/finalizer stream events into the ledger for runtimes that
have a live `runState.eventLedger`. The public terminal result snapshot still
strips the live ledger object by design; consumers that need replay must read
the ledger before snapshotting or through a future explicit projection API.
Production Inspector still renders from the older ledgers; migrating the 7
production Inspector projections to `eventLedger` remains a later AGRUN-248-C
Phase 2 task.

## Harness Logic

The runtime now records token deltas as observable events while leaving token
delivery and final answer ownership unchanged. The provider stream remains the
source of deltas; the ledger is a typed replay surface, not an answer-quality
judge or hidden planner.
