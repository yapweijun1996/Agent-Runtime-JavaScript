# Runtime Config + Permission Lifecycle Audit — 2026-05-24

## Goal

Convert KB roadmap items 1-3 into a concrete agrun implementation ticket and
ship the first safe foundation slice:

- config lifecycle foundation
- permission metadata foundation
- optional dynamic permission judge foundation
- action repeated-failure/no-progress guardrail foundation
- provider/action stream-event normalization foundation

KB sources:

- `sample.synthesis.adoption-roadmap`
- `sample.compare.permissions`
- `sample.compare.config`

## Current Runtime Audit

`src/runtime/config.js` normalized runtime options once during `createRuntime()`.
Future `runtime.run()` calls reused that fixed object. There was no reload
state, revision, abortable config loader, or stale reload rejection.

`src/runtime/action-registry.js` exposed only `name`, `description`, and `tier`
through public and planner action surfaces. `src/runtime/policy.js` supported
only string policies (`allow`, `ask`, `deny`) and returned no reason/source or
permission snapshot.

`src/runtime/action-availability.js` supports disabled-action filtering, but
this is availability, not a permission metadata contract.

Before this slice, provider token callbacks were available through `onToken`,
but there was no typed stream-event contract for host inspectors and no action
execution stream events. Provider streaming, finalizer streaming, and action
execution all needed a normalized event shape that would not affect planner
decisions.

## Implementation Slice

Implemented:

- `src/runtime/runtime-config-lifecycle.js`
  - ready/reloading/error state
  - monotonic `revision`
  - partial reload preserving prior options
  - async loader support with `signal`
  - abort/stale reload rejection
- `src/runtime/runtime.js`
  - `getRuntimeConfigState()`
  - `reloadRuntimeConfig(optionsOrLoader, options?)`
  - future runs read the latest config snapshot
- `src/runtime/action-registry.js`
  - normalized `permission` object on public and planner action views
  - deterministic built-in metadata for read-only, virtual mutation, external
    network, host repo, and dynamic skill-tool actions
- `src/runtime/policy.js`
  - reasoned policy object support
  - policy decisions now include `source`, `reason`, and `permission`
- `src/runtime/action-permission-judge.js`
  - optional host-supplied classifier for dynamic/untrusted actions
  - fail-closed `ask` decision when disabled, uncertain, or failed
  - deterministic cache for repeated action/argument classifications
- `src/runtime/action-guardrail-controller.js`
  - pure state transition helper for repeated exact failures
  - read-only/concurrency-safe no-progress repeat detection
  - synthetic block result for enabled preflight blocks
- `src/runtime/provider-stream-events.js`
  - normalized `provider_*` and `action_*` event records
  - `onStreamEvent` run hook plumbing through runtime, sessions, actions, and
    finalizer/provider streaming

## Acceptance

- Default behavior remains unchanged for hosts that never call
  `reloadRuntimeConfig()`.
- Stale/aborted reloads cannot overwrite newer config.
- Permission metadata is available without adding an LLM classifier or hidden
  runtime decision path.
- Explicit action policy can carry a reason for Inspector/audit surfaces.
- Optional dynamic permission classification is available only for untrusted
  dynamic actions and fails closed to approval on missing/failed classifiers.
- Action guardrail state surfaces repeated failure/no-progress as observable
  loop facts; it does not author content or choose the recovery path.
- Provider and action execution paths can emit normalized `onStreamEvent`
  records for host inspectors without changing planner decisions.

## Verification

Passed:

- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/action-permission-metadata.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/runtime-config-lifecycle.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/action-permission-judge.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/action-guardrail-controller.test.js`
- `node --import ./test/helpers/virtual-stubs-loader.mjs test/unit/provider-stream-events.test.js`
- `node test/unit/mock-provider-plan-loop.test.js`
- `node test/concerns/runtime-basic.test.js`
- `node test/concerns/session.test.js`
- `npm test`

Fix found during verification:

- The first full `npm test` after adding `onStreamEvent` exposed a finalizer
  regression: `requestFinalizerProviderResponse()` passed `onStreamEvent` but
  did not destructure it, so finalizer turns could fall into error handling.
  The function now carries `onStreamEvent` through to
  `requestFinalizerProviderOnce()`, and the session concern plus full suite
  pass.

## HBR

This is still a foundation slice, not a full productized Inspector. The
dynamic permission classifier is host-supplied and not an internal LLM call;
action guardrails are mechanical repeat signals and can still block a repeated
failing action when enabled; `onStreamEvent` is an API surface but the browser
Inspector does not yet render every event type. Provider token deltas are
normalized, but Vercel AI SDK-style tool-input delta normalization is still a
later phase. Existing session handles keep their current handle state;
create/open a new handle when validating reload-sensitive session behavior.
