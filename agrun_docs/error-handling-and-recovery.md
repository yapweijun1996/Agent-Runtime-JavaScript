# Error Handling and Recovery

## Purpose

This document describes the error handling model in agrun.js, including structured errors, planner recovery strategies, and failure outcomes.

For the full execution flow, see `agrun_docs/agentic-execution-flow.md`.
For the planner repair cascade, see `agrun_docs/planner-architecture.md`.

## Structured Error Model

All errors in agrun.js are normalized into structured error objects:

```text
StructuredError
 ├ code     — machine-readable error code
 ├ message  — human-readable description
 ├ skill    — skill name where the error originated (or null)
 └ cause    — original error object (for debugging)
```

### Error Codes

Defined in `src/runtime/errors.js`:

| Code | Meaning |
|------|---------|
| `INVALID_PROVIDER_REQUEST` | Provider request is malformed or missing required fields |
| `MAX_STEPS_EXCEEDED` | Cycle count exceeded `maxSteps` without reaching a terminal state |
| `APPROVAL_RESOLUTION_ERROR` | Approval resume failed (invalid token, non-resumable action) |
| `PROVIDER_ERROR` | Provider API call failed |
| `ACTION_EXECUTION_ERROR` | Action threw during execution |
| `SKILL_EXECUTION_ERROR` | Skill threw during execution |

### `normalizeThrownError(value)` — Internal Utility

Because action / hook / skill code may `throw` anything (Error, string, plain object, primitive), the runtime normalizes every caught value through `normalizeThrownError()` before logging or wrapping:

```js
import { normalizeThrownError } from "./errors.js";

try { ... } catch (error) {
  const { error: normalized, message } = normalizeThrownError(error);
  // normalized is always a real Error; message is always a human-readable string
  // normalized.cause preserves the original thrown value for debugging
}
```

| Thrown value | Resulting `message` |
|--------------|---------------------|
| `new Error("boom")` | `"boom"` |
| `"rate limited"` | `"rate limited"` |
| `{ code: "429", message: "rate limited" }` | `"rate limited [429]"` |
| `{ reason: "timeout" }` | `"timeout"` |
| `{ foo: 1 }` | `'{"foo":1}'` |
| Circular-ref object | `Object.prototype.toString` fallback |
| primitive (`42`, `null`, `undefined`) | `String(value)` |

Without this helper, `throw {}` used to surface as the literal string `"[object Object]"` in step traces and failure results, hiding the actual error. All `catch` sites in `runtime/` and `session/` route through this helper.

## Failure Modes

### 1. Provider Input Invalid

**When**: The raw input cannot be normalized into a valid provider request.

**Flow**:
```text
runLoop() → normalizeToolLoopProviderRequest() throws
  → createProviderInputFailureResult()
    → runState.status = "failed"
    → error recorded
    → step: "provider-input-invalid"
    → finalizeResult()
```

### 2. Max Steps Exceeded

**When**: The action loop runs for `maxSteps` cycles without reaching a terminal state.

**Flow**:
```text
continueActionLoop() → cycleCount >= maxSteps
  → finalizeActionLoopFailure()
    → code: MAX_STEPS_EXCEEDED
    → runState.status = "failed"
```

### 3. Planner Returns Invalid Decision

**When**: After the full repair cascade, the planner still returns null.

**Flow**:
```text
plannerResult.decision = null
  → actionHistory.push({ kind: "planner_invalid_action" })
  → continue to next cycle
  → (after repeated failures) → MAX_STEPS_EXCEEDED
```

The runtime does not fail immediately on a single invalid planner response. Instead, it records the failure in action history and retries on the next cycle. This allows the planner to self-correct with updated context.

### 4. Unknown Action

**When**: The planner selects an action name that doesn't exist in the action registry.

**Flow**:
```text
actionRegistry.get(actionName) returns null
  → handleInvalidPlannerDecision()
    → Increments plannerInvalidCount
    → Records in action history
    → If threshold exceeded → failure result
    → Otherwise → continue to next cycle
```

### 5. Action Execution Error

**When**: An action throws during execution.

**Flow**:
```text
executeAction() catches error
  → Records structured error
  → Records in action history
  → Records observation: { kind: "error" }
  → Continues loop (action error is non-fatal by default)
```

Action errors are treated as evidence of failure rather than terminal conditions. The planner can see the error in action history and decide to try a different approach.

### 6. Policy Block

**When**: An action's policy evaluates to `ask` or `deny`.

**Flow**:
```text
evaluateActionPolicy() → policy !== "allow"
  → handlePolicyBlock()
    → If "ask" → return pending approval (resumable)
    → If "deny" → return blocked result
```

Policy blocks are not errors. They are normal control flow that returns execution to the host.

### 7. Approval Resolution Error

**When**: The host provides an invalid approval resolution.

**Flow**:
```text
runApprovalResolution()
  → pendingApproval missing or non-resumable
  → finalizeActionLoopFailure()
    → code: APPROVAL_RESOLUTION_ERROR
```

## LLM Self-Correction

When self-correction is enabled (default), action execution errors are fed back to the planner instead of terminating the run. This allows the LLM to see the error and try a different approach.

### Configuration

```javascript
// Default: enabled with max 2 retries
createRuntime({ selfCorrection: true, ... })

// Custom retry limit
createRuntime({ selfCorrection: { enabled: true, maxRetries: 3 }, ... })

// Disabled: action errors terminate the run immediately
createRuntime({ selfCorrection: false, ... })
```

### Self-Correction Flow

```text
Action execution throws
    ↓
selfCorrectionCount < maxRetries?
    ├─── yes → record error in actionHistory
    │         → update observation: { kind: "error" }
    │         → emit step: "action-error-self-correcting"
    │         → return done: false (continue loop)
    │         → next cycle: planner sees error in history
    │         → planner chooses different action
    └─── no  → finalizeActionLoopFailure() (terminate)
```

### What the Planner Sees

When self-correction triggers, the error is recorded in `actionHistory`:

```json
{
  "kind": "action_error",
  "actionName": "read_url",
  "error": "Request timeout after 10000ms",
  "summary": "read_url failed: Request timeout after 10000ms. The planner should try a different approach."
}
```

On consecutive failures of the same action, the summary escalates:

```json
{
  "summary": "web_search failed again (2 consecutive failures): ... Do NOT retry web_search. Use finalize to answer with available information, or try a completely different action."
}
```

The planner's next cycle sees this in the action history and can:
- Try a different URL
- Use a different search query
- Fall back to a different action entirely
- Provide a partial answer based on existing evidence

### Self-Correction After Tool Errors (ADR-0026 update)

When `execute_skill_tool` returns an error (`result.ok === false` or `result.error` present), the planner sees the error in the next cycle's `toolContext.lastResult` and can self-correct. This allows the planner to read error details (e.g. "Invalid groupBy: credit_term. Allowed: creditterm_desc, ...") and retry with corrected parameters.

> **ADR-0026 note**: the single-tool fast path was deleted. Pre-ADR-0026, the runtime would skip the planner cycle after a successful first `execute_skill_tool` call to save one API round-trip. That was push-mode (runtime decided AI didn't need another planner round) and is now gone. Every cycle goes through the planner; AI controls finalize. Cost: +1 LLM round-trip per single-tool run. To preserve old behavior, hosts wire `onToolResult` and call their own finalize path.

```text
execute_skill_tool returns
    ├─ result.ok !== false → planner cycle 2 (AI sees toolContext.lastResult,
    │                         emits finalize → planner_finalize source)
    └─ result.ok === false → planner cycle 2 (AI sees error, self-corrects)
```

### Consecutive Failure Signal (ADR-0026)

If the same action fails `CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD` (default: 2) times in a row, the action loop emits a **read-only signal** in `runState.actionFailureSignal` and exposes it on the next planner prompt as `loopState.actionFailureSignal`. The runtime no longer force-finalizes — AI sees the signal and decides whether to switch tactics, finalize, or keep retrying.

```text
web_search fails → self-correction → planner picks web_search again
  → web_search fails again → action-failure-signal step emitted
  → next planner cycle sees loopState.actionFailureSignal
  → AI chooses: switch to read_url / finalize / different query
  → if AI keeps retrying, the loop hits maxSteps eventually
```

Pre-ADR-0026, this site was a runtime force-finalize push (`maybeEnforceConsecutiveFailureGuard`). It was deleted to satisfy the harness-as-tool-provider contract from ADR-0023. Hosts that need the legacy behavior wire `onToolResult` and call their own finalize path; the `countConsecutiveActionFailures` utility is still exported.

### Consecutive Denial Guard

Similarly, if the user denies `MAX_CONSECUTIVE_DENIALS` (default: 2) action approvals in a row, the runtime forces a `finalize` decision. This prevents infinite denial loops where the planner keeps selecting actions that require approval.

```text
User denies web_search → planner picks read_url → User denies read_url
  → consecutive denial guard triggers
  → forced finalize with instruction to answer without approval-gated actions
```

The guard is implemented in `approval.js` and emits an `approval-denial-guard` step for debugging. Between denials, the planner sees `deniedActions` in its loop state and is instructed to avoid re-selecting them.

### Tracking

- `runState.selfCorrectionCount`: Incremented each time self-correction triggers. **Resets to `0` after any successful action execution** so a recovered agent (fail → success → fail) keeps a full retry budget for future issues. Without this reset, unrelated early failures would eat into the retry cap for later real problems.
- Step trace includes `action-error-self-correcting` events with attempt number and max retries
- Step trace includes `action-failure-signal` (ADR-0026 read-only signal — replaces deleted `action-consecutive-failure-guard`)
- Step trace includes `approval-denial-guard` when the denial guard forces finalization

## Planner Recovery

The planner recovery system is the primary defense against LLM response variability. See `agrun_docs/planner-architecture.md` for the full repair cascade.

Summary:

```text
1. Parse envelope          → valid? use it
2. Soft repair             → valid? use it
3. Envelope repair request → valid? use it (extra provider call)
4. Strict retry            → valid? use it (extra provider call)
5. Web search fallback     → applicable? use it
6. Return null             → recorded as invalid, retry next cycle
```

### Planner Invalid Count

The runtime tracks `plannerInvalidCount` across cycles. This prevents infinite loops where the planner consistently returns unparseable responses.

When `plannerInvalidCount` exceeds a threshold, `handleInvalidPlannerDecision()` may terminate the run with a failure result rather than continuing to retry.

## Convergence and Action Loop Stability

`src/runtime/action-pattern-convergence.js` detects oscillation and no-progress loops and escalates from advisory (prompt-level pressure) to hard_veto (action surface removal + preflight block).

### Convergence States

| State | Detects | Advisory threshold | Hard_veto threshold |
|-------|---------|-------------------|---------------------|
| `exactAction` | Repeated same action with same args | n/a | Immediate on detection |
| `readOnlyPlanningState` | Agent plans/reads without writing | `ignoredCount ≥ 1` | `ignoredCount ≥ 3` |
| `workspaceMutationGrowthConvergence` | workspace_write produces no growth (stall) | `stallCount ≥ 2` or `deltaWords < 0` | `stallCount ≥ 3` |
| `structureRepairConvergence` | No-progress during structure repair | Immediate on activation | n/a (surface filter only) |

### hard_veto Priority

When a convergence state reaches `escalation: "hard_veto"`:

1. `selectPlannerActions()` removes the forbidden actions from the action surface **before** any repair-mode allowlist is applied.
2. `maybeBlockReadOnlyPlanningLoop()` / `maybeBlockWorkspaceMutationGrowthLoop()` blocks the preflight check even when the action appears in `terminalRepairState.allowedActions`.

**Priority order: hard_veto > terminalRepairState.allowedActions > advisory**

Advisory-escalation signals do NOT remove actions from the surface — they inject guidance into the planner prompt only.

### AGRUN-237-GAP-04 Lessons

Three bugs were found where hard_veto was bypassed by `terminalRepairState.allowedActions`:

1. **`maybeBlockReadOnlyPlanningLoop` early return** — `repairAllowedActions.includes(actionName)` returned null unconditionally, skipping the hard_veto check. Fix: check if action is in hard_veto forbiddenActions before returning null.
2. **`selectPlannerActions` allowedRepairActions early return** — forbidden actions appeared on the LLM surface because the `allowedRepairActions` branch ran before the hard_veto filter. Fix: hard_veto filters always run first.
3. **`updateWorkspaceMutationGrowthConvergence` stallCount reset by append** — a workspace_append with positive delta cleared the stallCount, hiding write→append→write oscillation. Fix: function only tracks `workspace_write`; other mutations passthrough without resetting the counter.

## Concurrent-Turn Safety

### Compaction Summary Compare-And-Swap

Two overlapping `session.run()` calls on the same session can both decide a summary refresh is needed while each one is waiting on its own LLM compaction call. Without protection, the later of the two `writeSummary()` calls could overwrite a newer summary with an older one — making session context appear to regress in time.

`prepareProviderSessionContext()` guards this with a compare-and-swap before writing:

1. Before summarizing, it captures `startUpdatedAt = currentSummary?.updatedAt`.
2. After `summarizeSessionContext()` returns, it re-reads the stored summary.
3. If the stored `updatedAt` changed in the meantime, the current turn **adopts the stored summary** instead of writing its own; the plan stage is tagged `summary_adopted_concurrent`.
4. Otherwise it writes its proposed summary as before (stage `summary_refreshed`).

The CAS helper is exported as `resolveSummaryWrite()` for direct testing. This pattern does not require an explicit lock — it accepts that wasted work may happen (one turn's LLM summary is discarded) in exchange for keeping the summary timeline monotonically increasing per session.

### Global Memory Hook Timeouts

Host hooks (`sensitivityFilter`, `promotionValidator`) race against `hookTimeoutMs`. When the timeout wins:

- The runtime calls `abortController.abort()` on the `AbortSignal` passed through `context.signal`, so well-behaved hooks can cancel in-flight `fetch()` calls or other cancellable work.
- A silent `.then(NOOP, NOOP)` handler is attached to the still-pending hook promise so late rejections don't surface as `UnhandledPromiseRejection` warnings.
- Late resolutions are discarded; they cannot retroactively promote an entry that was already blocked fail-closed.

See `agrun_docs/public-runtime-api.md` → "Global Memory Configuration" → "Cancellation via `context.signal`" for the host integration contract.

## Observation Recording

All outcomes (success and failure) are recorded as observations:

```text
Observation
 ├ kind     — "complete" | "error" | "blocked" | "continue"
 ├ code     — error code (if error)
 ├ message  — description
 └ (additional fields per kind)
```

Observations serve dual purposes:

1. **State tracking**: The runtime uses observations to update `runState` and decide next actions
2. **Debugging**: Observations appear in the steps trace for post-run inspection

## Fetch Resilience

All external HTTP calls (provider APIs, web search, URL reading) are protected by the modular `fetch-resilience.js` module located at `src/skills/providers/fetch-resilience.js`.

### Utilities

| Utility | Purpose |
|---------|---------|
| `fetchWithTimeout(fetch, url, init, opts)` | Single fetch with `AbortController`-based timeout |
| `fetchWithRetry(fetch, url, init, opts)` | Timeout + automatic retry with exponential backoff |
| `withDeadline(ms)` | Multi-step operation deadline; returns `signal`, `expired()`, `remainingMs()`, `cleanup()` |

### Default Timeouts

| Component | Timeout | Retries | Constant |
|-----------|---------|---------|----------|
| Web search (SearXNG, Gemini grounding) | 15 s | 1 | `DEFAULT_SEARCH_TIMEOUT_MS` |
| LLM API (Gemini, OpenAI planner/finalize) | 60 s | 1 | `DEFAULT_LLM_TIMEOUT_MS` |
| URL reader | 10 s | 1 (at action level) | `DEFAULT_READ_URL_TIMEOUT_MS` |
| Web search multi-pass total deadline | 45 s | — | `DEFAULT_SEARCH_DEADLINE_MS` |

### Retry Policy

`fetchWithRetry` retries on transient failures only:

- **Timeout / abort errors**: `AbortError`, code `20`
- **Network errors**: `TypeError` with fetch/network message, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`
- **Server errors**: HTTP 429 (rate limit), 502, 503, 504

Non-transient errors (4xx client errors, parse failures) are not retried.

Backoff is exponential: `baseDelayMs * 2^attempt` (default base: 1 000 ms).

### Deadline for Multi-Pass Web Search

`web-search-action.js` wraps the multi-pass search loop with `withDeadline(45s)`:

- Each pass receives the deadline's `signal` so individual fetches abort when the deadline fires
- If a single pass times out, the loop breaks but **preserves results from prior passes**
- The deadline is cleaned up in a `finally` block

### URL Reader Retry

`read-url-action.js` retries on `timeout` or `fetch_failed` results (up to 1 retry with 1.5 s delay). The existing `isRetryableReadUrlServiceFetchError` in `read-url-service-fetch.js` marks service-level failures as retryable; the action layer now acts on that signal.

### Circuit Breaker

A per-provider circuit breaker prevents repeated calls to a consistently failing provider.

```text
CLOSED → 5 consecutive failures → OPEN (fast-fail for 60s)
OPEN   → cooldown elapsed       → HALF_OPEN (probe: 1 request)
HALF_OPEN → success → CLOSED  /  failure → OPEN (re-open)
```

**Enable:** `createRuntime({ circuitBreaker: true })` or `{ circuitBreaker: { threshold: 5, cooldownMs: 60000 } }`.

**Behavior when open:**
- `requestProviderCompletion` throws `CIRCUIT_OPEN` immediately (no timeout wait)
- Planner catches `CIRCUIT_OPEN` → emits `planner-circuit-open` step → returns `finalize` decision: "Provider temporarily unavailable"
- Each provider key (`"openai"`, `"gemini"`) is tracked independently

**What counts as a failure:** Timeout, network error, AbortError, HTTP 429/502/503/504. Client errors (400/401/403) and parse errors do not count.

**Disabled by default.** When not configured, all provider calls proceed normally with no circuit tracking overhead.

### External Signal Support

All resilience utilities accept an optional `signal` parameter (e.g., from `withDeadline`). This enables cascading abort: a deadline can cancel all in-flight fetches when it expires.

### Overriding Defaults

Each call site accepts `request.timeoutMs` to override the default timeout. Hosts can pass custom values through action args or runtime config.

### Gemini Grounding Synthetic Fallback

When Gemini's `google_search` grounding returns `webSearchQueries` but no `groundingChunks` (common since mid-2025):

1. `gemini-grounding.js` generates synthetic items from the model's text answer
2. `web-search-ranking.js` accepts items with `snippet` even without `url`
3. `hasUsableSearchEvidence()` treats snippet-only items as usable evidence
4. The consecutive failure guard does NOT trigger (search succeeded, just no URLs)

This prevents the death spiral: `web_search → 0 results → planner retries → 0 results → loop`.

## Graceful Degradation

### Research Failures

When URL reading fails (blocked pages, timeouts):

- The read source is recorded with tier `blocked`
- The failure is noted in action history
- The planner can see the blocked evidence and choose alternative URLs
- Research continues rather than failing the entire run

### Partial Evidence

When evidence is partial:

- The planner can still produce a final answer
- The `finalize` path can synthesize from available evidence
- The answer may include uncertainty notes based on evidence quality

### Provider Failures

When the provider API fails:

- The error is captured as a structured error.
- The public error code remains stable, such as `PLANNER_ERROR` for planner provider calls.
- `error.message` is user-safe and actionable, for example `Provider request failed: authentication or permission error for gemini.`
- `error.details` contains safe debug fields only: `{ provider, status, code, reason, retryable, message }`.
- `error.cause` is a short sanitized cause summary; it must not include API keys, bearer tokens, authorization headers, or raw provider payloads.
- A `provider-error` step is emitted when a provider call fails after request normalization.

Common provider failure reasons:

| reason | Retryable | Meaning |
| --- | --- | --- |
| `auth` | no | Authentication, permission, rejected API key, or forbidden provider request. |
| `rate_limit` | yes | Provider returned 429 or an equivalent rate-limit error. |
| `timeout` | yes | Provider request timed out. |
| `network` | yes | Fetch/network-level failure. |
| `upstream` | yes | Provider returned 5xx or equivalent upstream failure. |
| `circuit_open` | yes | Runtime circuit breaker blocked a known-failing provider. |
| `config` | no | Missing endpoint, missing model, unsupported auth mode, or other incomplete host config. |

## Steps Trace for Debugging

All error-related events are recorded in the steps trace:

```text
provider-input-invalid
provider-error
planner-repair-requested
planner-repair-completed / planner-repair-failed
planner-strict-retry-requested
planner-strict-retry-completed
planner-fallback-applied
action-error
approval-resolution-error
```

Each step includes relevant safe details for debugging. Provider errors intentionally expose normalized fields rather than raw response bodies or headers.

## Debug Logging

Enable with `createRuntime({ debug: true })` or pass a custom handler `(event) => {}`.

When enabled, the runtime emits `[agrun:debug]` logs at key decision points:

| Label | Location | What it shows |
|-------|----------|---------------|
| `cycle N \| decision` | action-loop-session-loop | Planner decision type, action name, skillName, toolName |
| `action dispatch \| {name}` | action-loop-action | Action resolved status, parsed args |
| `action error \| {name}` | action-loop-action | Error message on action throw |
| `execute_skill_tool \| resolve start` | execute-skill-tool-action | Provided vs missing skillName/toolName, available skills catalog |
| `execute_skill_tool \| reverse-lookup` | execute-skill-tool-action | toolName → skill owner resolution |
| `execute_skill_tool \| inference result` | execute-skill-tool-action | Candidate keys, all matching tools with scores, best match |
| `execute_skill_tool \| inference skipped` | execute-skill-tool-action | Why inference was not attempted (no candidate keys) |
| `execute_skill_tool \| resolve FAILED` | execute-skill-tool-action | Which resolution path failed and why |
| `execute_skill_tool \| calling` | execute-skill-tool-action | Final resolved skill, tool, and args before execution |
| `execute_skill_tool \| result` | execute-skill-tool-action | Result type and keys after execution |
| `execute_skill_tool \| auto-heal flattened args` | execute-skill-tool-action | Lifted keys when tool params were flattened as siblings of skillName/toolName |

Zero overhead when disabled — the logger is a no-op object.
