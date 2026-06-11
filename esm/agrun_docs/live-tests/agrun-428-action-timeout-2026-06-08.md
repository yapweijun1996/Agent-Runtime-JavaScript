# AGRUN-428 Per-Action Timeout Enforcement

Date: 2026-06-08

## Result

AGRUN now applies a per-action timeout around the actual `action.execute(ctx, args)` call.

## Implementation

- `src/runtime/tool-schema.js` defines the action timeout SSOT:
  - `DEFAULT_ACTION_TIMEOUT_MS = 30000`
  - `timeoutBehavior = "error_as_result" | "raise_exception"`
- `src/runtime/action-registry.js` normalizes every bundled and custom action with:
  - positive integer `timeoutMs`, default `30000`
  - valid `timeoutBehavior`, default `"error_as_result"`
- `src/runtime/action-loop-action.js` wraps only `action.execute(...)` in `Promise.race`.
  Validation, preflight, approval, and guardrail checks stay outside the timeout boundary.
- `error_as_result` creates a synthetic `action_loop_failure` execute observation, then reuses `recordRecoverableActionError` so the planner can self-correct.
- `raise_exception` rejects the timeout promise and uses the existing `action-execute-error` catch path.

## Verification

Targeted tests:

- `node test/unit/action-timeout.test.js` — PASS
- `node test/unit/recoverable-action-error-observation.test.js` — PASS
- `node test/unit/action-permission-metadata.test.js` — PASS

Full check:

- `npm run check` — PASS

Environment note:

- The worktree initially had no `node_modules`, so the first `npm run check` stopped at `examples/browser` build with `sh: vite: command not found`.
- After installing root and example dependencies, `npm run check` passed.

## Acceptance Mapping

- All actions have timeout defaults: covered by registry normalization test.
- `timeoutBehavior` controls result vs exception: covered by hung action tests for both behaviors.
- Hung actions return LLM-visible error within `timeoutMs`: covered by `action_loop_failure` observation assertion.
- Existing action tests still pass: `npm run check` passed.
