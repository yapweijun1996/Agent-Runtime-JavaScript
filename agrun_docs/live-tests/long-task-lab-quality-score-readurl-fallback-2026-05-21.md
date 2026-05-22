# Long Task Lab Quality Score And Read URL Fallback 2026-05-21

## Scope

Implement the approved follow-ups after the TNO 3000-word live run:

1. Add a visible quality scoring panel for Long Task Lab results.
2. Add a generic read_url fallback/retry strategy for Long Task Lab source recovery.

## Implementation

Quality scoring is implemented in `examples/long-task-lab/src/runtime/lab-quality-score.ts`.

The score is `0-100` and exposes five gates:

- Length target
- Workspace publish
- Evidence count
- Final source links
- Structure

The top-level verdict only returns `pass` when every gate passes. A high numeric score with a partial evidence gate stays `partial`, so the UI cannot hide source quality problems behind the total score.

The Evidence tab now renders a `Quality Score` panel above the source list. The Debug tab includes the same score in the compact inspector metrics and copies the structured `qualityScore` object inside the redacted debug packet.

read_url fallback is implemented in `src/runtime/actions/read-url-action.js`.

Behavior:

- Retry the same URL once for retryable failures, preserving the existing retry budget.
- If the host explicitly opts in with `runtimeConfig.readUrlFallback.enabled=true`, and the same URL still fails, select one alternate unread candidate from search/inquiry context.
- Emit `read-url-fallback-attempt` and `read-url-fallback-completed` runtime steps.
- Attach a structured `fallback` object to the read_url output.
- Do not run alternate fallback during `approval_resolution`; human-approved read_url resumes still execute exactly the approved URL.

Long Task Lab opts into this with `readUrlFallback: { enabled: true }`. General agrun runtime behavior remains conservative unless a host enables the fallback.

## Chrome DevTools MCP Evidence

Target: `http://localhost:3001/`

Observed:

- Evidence tab shows `Quality Score`.
- Initial score is `0/100`.
- Gates visible: `Length`, `Workspace publish`, `Evidence`, `Source links`, `Structure`.
- Debug tab shows compact metric `Quality 0/100`.
- Debug tab still shows `Current Agent Activity`.
- Console check for errors/warnings/issues returned no messages.

This browser check validates the new UI surfaces without spending another real-provider long run.

## Automated Verification

Passed:

- `node test/unit/read-url-action-fallback.test.mjs`
- `node --experimental-strip-types examples/long-task-lab/test/lab-state.smoke.ts`
- `npm run test:long-task-lab`
- `npm --prefix examples/long-task-lab run build`
- `npm run build`
- `npm test`
- `npm run dist:check`
- `git diff --check`

The first `npm test` run exposed two fallback-scope regressions:

- Approval resume expected the first approved read_url to remain failed, but fallback made it successful.
- Session topic guardrail fixtures expected two explicit read_url attempts, but fallback attempted an unmocked alternate URL.

The final implementation fixed this by making alternate fallback host opt-in and disabled during approval resumes.

## Honest Bad Result

This slice verifies the scoring UI and fallback contract, not a fresh 3000-word provider mission. The previous TNO live run remains the real long-task completion proof. Fallback source improvement still depends on search candidates being available and readable.

Existing build warnings remain from third-party packages:

- Rollup rewrites top-level `this` in OpenTelemetry dependencies.
- Rollup reports a circular dependency inside `zod`.

## Verdict

DONE with HBR. The Lab now shows quality gates directly and has a generic, opt-in alternate-source fallback for failed read_url attempts without changing default approval/runtime semantics.
