# agrun.js Web UI Integration Contract

## Purpose

This document defines how a host Web UI should consume `agrun.js`.

It standardizes four host layers:

1. request assembly
2. result consumption
3. debug snapshot generation
4. activity derivation

For runtime creation and public methods, see `agrun_docs/public-runtime-api.md`.
For returned data shapes, see `agrun_docs/result-schema.md`.

## Host Responsibilities

A Web UI host is responsible for:

- collecting user input, provider settings, and attachment metadata
- calling `runtime.run(input)` with a host-assembled input envelope
- preserving the returned result for the current turn
- generating host debug artifacts from the result
- deriving presentational activities from `result.steps`
- handling approval resolution and retry flows

The runtime is not responsible for:

- storing UI message history
- rendering activity cards
- choosing whether attachments include metadata only or file contents
- persisting debug snapshots

## Runtime-to-UI Contract

### Request Layer

The host should assemble one of three runtime-facing turn inputs:

- normal/provider turn
- direct structured turn such as `web_search`
- `approval_resolution` turn

Direct `web_search` turns may now include optional planner controls:

- `strategy`: `auto`, `direct`, `entity_lookup`, `fresh_news`, or `general_lookup`
- `maxPasses`: positive integer, default `3`
- `siteHints`: string array of fallback domains

Provider selection for direct `web_search` is intentionally narrow:

- omit `provider`/`searchProvider`, or set it to `searxng`
- any other value should be treated as an integration error

If the host sends attachment metadata only, it should say so in the composed prompt or system prompt.

Example provider turn:

```json
{
  "provider": "openai",
  "apiKey": "sk-test",
  "model": "gpt-4.1-mini",
  "prompt": "review this javascript code for bugs",
  "systemPrompt": "Answer clearly and directly.",
  "webSearchEndpoint": "https://search.example.test"
}
```

For ERP browser clients using Gemini, prefer server-auth proxy mode:

```json
{
  "provider": "gemini",
  "authMode": "server",
  "endpoint": "/api/ai/gemini/generateContent",
  "streamEndpoint": "/api/ai/gemini/streamGenerateContent",
  "searchProvider": "gemini_grounding",
  "webSearchAuthMode": "server",
  "webSearchEndpoint": "/api/ai/gemini/grounding",
  "model": "gemini-2.5-flash",
  "prompt": "review this javascript code for bugs"
}
```

### Result Consumption Layer

The host should read:

- `result.output`
- `result.error`
- `result.runState.pendingApproval`
- `result.steps`
- `result.runState.status`

Recommended handling:

- `status === "completed"`: render final answer
- `status === "blocked"`: render approval UI from `pendingApproval`
- `status === "failed"`: render failure UI from `error`

For direct `web_search` turns, hosts should additionally prefer:

- `result.output.rankedItems` for canonical aggregated results
- `result.output.items` only as a compatibility alias
- `result.output.searchPlan` and `result.output.searchPasses` for inspector/debug rendering
- `result.output.verification` when showing evidence strength or warning badges

Do not collapse blocked and failed into the same UI path.

## UI State Machine

Recommended host-level state machine:

```text
draft
→ submitting
→ executing
→ completed | blocked | failed | interrupted
```

Recommended mapping from runtime result:

| Runtime signal | UI state |
| --- | --- |
| request in flight | `executing` |
| `runState.status === "completed"` | `completed` |
| `runState.status === "blocked"` | `blocked` |
| `runState.status === "failed"` | `failed` |
| host abort before completion | `interrupted` |

Notes:

- `interrupted` is usually a host concern, not a runtime terminal status.
- `phase` and `oodae` may enrich an inspector, but should not replace the top-level UI state machine.

## Approval Flow Contract

### Pending Approval Presentation

UI approval controls should be driven by:

- `pendingApproval.actionName`
- `pendingApproval.policy`
- `pendingApproval.reason`
- `pendingApproval.resolution`
- `pendingApproval.resumable`
- `pendingApproval.resumeToken`

The host should support any `actionName`, not only `web_search`.

### Approve

To approve a blocked action, submit a new host-managed turn:

```json
{
  "type": "approval_resolution",
  "decision": "approve",
  "resumeToken": {
    "actionName": "web_search",
    "policy": "ask",
    "request": {
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "prompt": "who is tno system pte ltd boss"
    }
  }
}
```

Host rules:

- pass `resumeToken` through unchanged
- re-inject fresh `apiKey` and `fetch` only for client-auth provider turns
- for Gemini `authMode: "server"` and `webSearchAuthMode: "server"`, do not place provider keys in JS, request body, storage, debug logs, or resume tokens
- keep approval UI generic across action names

### Deny

To deny a blocked action, submit the same shape with:

```json
{
  "type": "approval_resolution",
  "decision": "deny",
  "resumeToken": {
    "actionName": "web_search",
    "policy": "ask",
    "request": {
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "prompt": "who is tno system pte ltd boss"
    }
  }
}
```

Expected UI behavior:

- show blocked or denied state, not generic failure
- preserve the original user message
- offer a retry-turn action if the host supports replaying the full turn

### Retry

Retry is a host replay action, not an approval protocol action.

Recommended behavior:

- rebuild the original user-facing provider turn
- resubmit it as a new `runtime.run(input)` call
- keep the denied approval result as historical context in the UI message thread

## Debug Contract

Hosts should persist one debug snapshot per turn.

Recommended shape:

```js
{
  mode,
  request,
  response,
  runtime,
  timing,
  error
}
```

Recommended provider response shape for inspector use:

```js
{
  status,
  text,
  usage,
  tokenUsage: {
    inputTokens,
    outputTokens,
    totalTokens
  }
}
```

Rules:

- `runtime` is a deep-cloned projection of runtime-owned data.
- `request`, `response`, and `timing` are host-owned metadata.
- `runtime.steps` should mirror `result.steps`.
- `runtime.pendingApproval` should mirror `result.runState.pendingApproval`.
- `runtime.contextSnapshot` should be treated as the canonical continuity/debug view.
- hosts may preserve raw provider `response.usage` exactly as returned by the provider
- hosts may also add a normalized `response.tokenUsage` view for inspector rendering

### Context Snapshot Rules

Inspectors should prefer:

- `runtime.contextSnapshot.inquiryContext`
- `runtime.readAttemptSignal`

before falling back to compatibility aliases such as:

- `runtime.contextSnapshot.turnIntent`
- `runtime.sessionContextView`
- `runtime.sessionContextMeta`
- The host may enrich debug data, but should not rewrite runtime-owned values.

Browser example note:

- the current browser example keeps raw `response.usage` in the Raw Response tab
- it also adds normalized `response.tokenUsage` so Inspector Summary and Debug Report can show `Input`, `Output`, and `Total` token counts consistently across OpenAI and Gemini

Recommended `mode` usage:

- `provider` for provider-backed and approval-backed assistant turns
- `web_search` for direct web search turns
- `approval_resolution` if the host wants a stricter separation than the current example

## Activity Derivation Contract

Activities are a derived UI view built from `result.steps`, `result.runState`, and optional response/source metadata.

They are not canonical runtime state and must not be written back into the runtime.

### Standard Derivation Rules

| Runtime evidence | Derived activity |
| --- | --- |
| `skill-selected` for search-oriented skills | routing |
| `news-brief-requested` | planning |
| `web-search-requested` | execution in progress |
| `web-search-completed` | execution complete with sources |
| `news-brief-results-evaluated` | observation/evaluation |
| `news-brief-refined` | planning/refinement |
| `*-follow-up-prepared` | planning/synthesis |
| `skill-executed` with terminal control | final answer |
| `skill-failed` | error |
| `run-max-steps-reached` | error |
| `runState.pendingApproval != null` | blocked execution activity |
| no mapped activities | synthesize fallback terminal activity from result status |

### Phase Events

`phase-*` events should usually feed inspector or trace UIs instead of primary chat cards.

Examples:

- `phase-observe-started`
- `phase-decide-completed`
- `phase-evaluate-completed`

### Unknown Step Types

Hosts must preserve unknown step types and may choose one of these strategies:

- ignore them in primary UI
- show them in a debug inspector
- log them for future mapper updates

## Streaming Contract (Planned — AGRUN-104)

Token-level streaming delivers finalize text incrementally to the host during the final answer generation phase.

### Host Streaming Responsibilities

The host is responsible for:

- passing `onToken` callback to `runtime.run(input, { onToken })` or `session.run(input, { onToken })`
- accumulating token deltas into a streaming message display
- throttling UI updates (recommended: `requestAnimationFrame` or equivalent)
- showing a streaming indicator (e.g., blinking cursor) while tokens arrive
- handling partial output if the stream is cancelled mid-generation

The runtime is not responsible for:

- rendering typewriter effects
- managing streaming UI state
- buffering or throttling token callbacks

### Streaming Activity Derivation

During streaming, the host should:

- continue mapping `onStep` events to activities as before (planner, action, observation)
- treat `onToken` as a separate channel — token deltas feed the message text, not the activity panel
- when `onStep("provider-responded", ...)` fires, finalize the streaming message with the complete response text from the result envelope

### Action Activity Pairing

Each runtime action dispatch emits a `detail.callId` on all three of its lifecycle events:

- `action-executing`
- `action-executed`
- `action-execute-error`

The host should pair these events by `callId` — not by `actionName`, `toolName`, or a last-seen pointer. Parallel `execute_skill_tool` dispatches share neither the pointer nor the name when the same tool is called with different filters, so anything other than `callId` will mispair rows under concurrent execution.

Recommended pairing sketch:

```js
const pending = new Map();  // callId → activity

onStep(step) {
  const callId = step.detail?.callId;
  if (!callId) return;

  if (step.type === 'action-executing') {
    const activity = createRunningActivity(step);
    pending.set(callId, activity);
    return;
  }

  if (step.type === 'action-executed' || step.type === 'action-execute-error') {
    const activity = pending.get(callId);
    if (activity) {
      finalizeActivity(activity, step);
      pending.delete(callId);
    } else {
      appendOrphanActivity(step);  // defensive — should not fire when pairing is correct
    }
  }
}
```

For pre-callId runtimes the host may fall back to `planIndex` (only emitted on the parallel plan path), but new integrations should key exclusively on `callId`.

#### action-executing args: digest + preview

For `execute_skill_tool`, `action-executing.detail.args` carries a sanitized digest **and** a structured preview:

```js
{
  skillName: 'erp_sales',
  toolName:  'list_sales_invoices',
  argKeys:   ['filters', 'pageSize'],
  argsDigest: 'filters={date_from=2026-04-01;amount_min=100};pageSize=50',
  argsPreview: {
    filters:  { date_from: '2026-04-01', amount_min: 100 },
    pageSize: 50
  }
}
```

Choose based on consumer shape:

- **`argsDigest`** — compact string for inline UI labels: `"Aggregate sales invoices · date_from=2010-01, date_to=2010-12, func=sum"`. Cheap to render, token-efficient.
- **`argsPreview`** — structured object for inspector panels (collapsible tree), debug modals, or LLM input when generating per-row activity labels. Round-trips losslessly without parsing a delimited string.

Sanitizer guarantees apply to both fields (safe to render without PII review):

- string values truncated to 40 chars with `…` suffix
- object traversal capped at depth 1 — deeper nodes rendered as the string `"{…}"` in the preview
- maximum 6 keys per level — overflow becomes `…` in digest, silently dropped in preview
- arrays rendered as the string `"[N]"`, never their elements
- flattened arg shape auto-lifted to match the planner's existing auto-heal

`argKeys` lists **all** top-level arg names (uncapped) — compare `argKeys.length` vs `Object.keys(argsPreview).length` to detect preview truncation.

### Cancel / Abort

The host may cancel a streaming turn by aborting the underlying fetch (via `AbortController`). When cancelled:

- already-received tokens remain visible as partial output
- the result envelope resolves with partial or error status
- the host should mark the message as interrupted, not failed

### Streaming UI State Machine Extension

```text
draft
→ submitting
→ executing
→ streaming (new — finalize tokens arriving)
→ completed | blocked | failed | interrupted
```

| Runtime signal | UI state |
| --- | --- |
| `onToken` called at least once | `streaming` |
| `onStep("provider-responded")` after streaming | `completed` |
| host abort during streaming | `interrupted` |

## Integration Patterns

### 1. Assistant Chat Turn

- host assembles provider turn
- host passes `onStep` and optionally `onToken` callbacks
- if `onToken` provided: host renders tokens incrementally during finalize, then finalizes with complete result
- if `onToken` not provided: host renders final text from `result.output.text` on completion
- host applies the same final markdown post-processing pipeline to every `output.kind: "final_response"` result, including `finalAnswerSource: "runtime_finalize"`, `"direct_final"`, `"plan_synthesize"`, and `"workspace_publish_candidate"`; this includes `terminalFinalContract` auditing plus mechanical exact-suffix normalization for explicit "End exactly with ..." contracts. The terminal contract must run at the final output boundary after source/citation normalization as well as at individual terminal actions, because later host/runtime formatting can otherwise move text after an exact final suffix.
- host stores debug snapshot and derived activities

### 2. Direct Web Search Turn

- host submits `type: "web_search"`
- runtime returns aggregated search result output
- host should render from `output.rankedItems` when available
- host may show `output.searchPasses` in debug or inspector views
- host should treat `output.items` and `output.count` as compatibility fields for older integrations

### 3. Approval-Driven Turn

- host receives blocked result with `pendingApproval`
- host renders generic approval UI for `actionName`
- approve or deny submits `approval_resolution`
- retry replays the original provider turn as a new run

### 4. Inspector View

- host reads `result.runState`, `result.steps`, `result.error`, and `result.runState.oodae`
- host keeps inspector separate from the main chat output path

For search-driven turns, inspector views should prefer these research fields:

- `runState.researchContext.searchPlan`
- `runState.researchContext.searchPasses`
- `runState.researchContext.aggregatedSearchResults`
- `runState.researchContext.verification`
- `runState.researchContext.verificationState`

Hosts should treat `runState.researchContext.searchResults` as a compatibility mirror of top aggregated results, not as the canonical full search cache.

For direct page reads, inspector views should preserve and expose:

- `runState.researchContext.readSources`
- per-source `ok`, `status`, `originStatus`, `platform`, `tier`, `error`, and `reason`
- a derived read-url status summary such as `ok 200`, `error 401`, or `error`
- a derived status tone such as `ok`, `error`, or `neutral`

Browser example Debug Report emits these derived fields under `[read_urls]`:

```text
[read_urls]
status: error 401
status_tone: error
```

Browser example Support Bundle JSON also exposes the same summary for machine-readable handoff:

```json
{
  "essentials": {
    "readUrlStatus": {
      "value": "error 401",
      "tone": "error"
    }
  }
}
```

For endpoint failures where browser JavaScript cannot read a CORS-blocked error response, the UI may only know `status: error`. Use Chrome Network or host-side logs as the authority for the exact HTTP status in that case.

## Failure Handling

Recommended UI behavior:

- if `result.error` is present, show failure state and expose structured debug data
- if `runState.status === "blocked"`, show policy or approval state, not an error toast by default
- after denial, the runtime continues the action loop so the planner can pick an
  alternative; after repeated denials, the runtime emits an observability signal
  but still lets the planner choose a non-denied action or honest terminal
  answer
- if `output` is unexpectedly missing while `error` is null, treat it as an integration anomaly and surface debug information

The host should not infer success from `output.text` alone.
The primary terminal signal is `runState.status`.

## Minimal Host Adapter Example

```js
async function runProviderTurn(runtime, request) {
  const startedAt = Date.now();
  const result = await runtime.run(request);

  const debug = {
    mode: "provider",
    request: {
      provider: request.provider,
      model: request.model,
      prompt: request.prompt
    },
    runtime: {
      runId: result.runState.runId,
      status: result.runState.status,
      phase: result.runState.phase,
      selectedSkill: result.selectedSkill,
      pendingApproval: result.runState.pendingApproval,
      stepCount: result.steps.length,
      steps: JSON.parse(JSON.stringify(result.steps))
    },
    timing: {
      startedAt,
      endedAt: Date.now(),
      durationMs: Date.now() - startedAt
    },
    error: result.error || undefined
  };

  return {
    text: result.output && typeof result.output.text === "string"
      ? result.output.text
      : "",
    status: result.runState.status,
    pendingApproval: result.runState.pendingApproval,
    debug,
    steps: result.steps
  };
}
```

## Token Usage & Cost Display

### Data Sources

Token usage flows through two channels:

1. **Per-message**: `result.output.usage` — available after each `runtime.run()` or `session.run()`
2. **Per-session cumulative**: `sessionRecord.cumulativeUsage` — accumulated across all turns in a session

Both use the normalized shape from `createUsageSnapshot()`:

```js
// Per-message (from result.output.usage → createUsageSnapshot)
{ inputTokens, outputTokens, totalTokens, model, provider, updatedAt }

// Per-session (from sessionRecord.cumulativeUsage)
{ inputTokens, outputTokens, totalTokens, turnCount, updatedAt }
```

### Recommended UI Placement

```text
┌─ Header ───────────────────────────────────────────┐
│  ☰  Session Title         🔢 1,234 tokens  ⚙ ️    │  ← cumulative badge
└────────────────────────────────────────────────────┘

┌─ AssistantMessageCard ─────────────────────────────┐
│  Agent response content...                          │
│                                                     │
│  ── Activity ──  128 in / 256 out tokens  ── 📋 ── │  ← per-message
└─────────────────────────────────────────────────────┘
```

**Header badge** (always visible):
- Show cumulative `totalTokens` for the active session using `formatCompactTokenValue()` (e.g., `1.2K tokens`)
- When `showCostEstimate` is enabled, append cost: `1.2K tokens · $0.12`
- Accumulated from all messages in the current chat via `useMemo` over `messages`
- Update after each turn completes

**Per-message label** (inline with copy button):
- When both `inputTokens` and `outputTokens` are available: `128 in · 256 out`
- When only `totalTokens` is available: `3.9K tokens` (fallback)
- When `showCostEstimate` is enabled, append cost: `128 in · 256 out · $0.001`
- Source: `message.metadata.debug.response.tokenUsage`
- Only display when usage data exists (provider-backed turns)
- Non-provider skills (echo, memory) have no token data — hide label

### Cost Calculation (Browser Layer)

Cost display is opt-in via Settings. The browser reference implementation uses a built-in static pricing table in `examples/browser/src/runtime/token-pricing.ts`:

```ts
// Pricing keyed by model ID, $/1M tokens
const PRICING_TABLE: Record<string, ModelPricing> = {
  'gpt-5-mini':             { inputPerMillion: 0.15,  outputPerMillion: 0.60 },
  'gpt-5.4':                { inputPerMillion: 2.50,  outputPerMillion: 10.00 },
  'gpt-5.4-pro':            { inputPerMillion: 5.00,  outputPerMillion: 15.00 },
  'gemini-3-flash-preview': { inputPerMillion: 0.10,  outputPerMillion: 0.40 },
  'gemini-3-pro-preview':   { inputPerMillion: 1.25,  outputPerMillion: 5.00 },
  'gemini-2.5-flash':       { inputPerMillion: 0.15,  outputPerMillion: 0.60 },
  'gemini-2.5-pro':         { inputPerMillion: 1.25,  outputPerMillion: 10.00 },
};

// Returns null for unknown models
calculateTokenCost(inputTokens, outputTokens, modelId): number | null
formatCostValue(cost: number | null): string  // "$0.0012" or ""
```

Rules:

- Pricing table is a browser-side concern, not part of the runtime contract
- Keyed by model ID only (not `provider:model`), using exact match
- Default display: token counts only; cost display requires explicit opt-in via `showCostEstimate` setting
- Format cost as `$X.XXXX` (4 decimals < $0.01, 3 decimals < $1, 2 decimals otherwise)
- When model is unknown or not in pricing table, show tokens only (no cost)

### Settings Integration

Located in Settings → Personalize:

- **Show estimated cost ($)**: checkbox (default: off) — appends cost to header badge and per-message labels
- Persisted as `BrowserSettings.showCostEstimate` in localStorage

### Storage Management (Settings → Storage)

The Storage tab visualizes agrun-only IndexedDB usage and provides per-store clear controls.

**Components:**
- `StorageSettingsPanel.tsx` — UI panel
- `storage-metrics.ts` — async helpers for measuring and clearing storage

**Data shown (agrun databases only):**
- **Runtime Session Store** (5 stores): sessions, messages, summaries, memoryEntries, globalMemory
- **Chat Store** (1 store): kv (chat sessions)
- **Local Storage**: all `agrun.browser.*` keys

**Per-store display:** record count + estimated byte size (via cursor traversal + `JSON.stringify` estimation). Stacked color bar shows proportional breakdown. Largest store is tagged.

**Clear operations:** per-store Clear button + "Clear All Data" with inline confirmation (5-second timeout). Only agrun data is affected — no browser-level or third-party data is touched.

**Design decision:** `navigator.storage.estimate()` origin-level usage is intentionally excluded because it includes non-agrun data (other apps on same origin, cache storage, service workers) which would confuse end users.

### Token Usage Field Normalization

The browser `createDebugTokenUsage()` in `token-usage.ts` normalizes usage from multiple provider formats:

| Output Field | AI SDK (camelCase) | Raw OpenAI (snake_case) | Raw Gemini |
|---|---|---|---|
| `inputTokens` | `inputTokens` | `prompt_tokens` | `promptTokenCount` |
| `outputTokens` | `outputTokens` | `completion_tokens` | `candidatesTokenCount` |
| `totalTokens` | `totalTokens` | `total_tokens` | `totalTokenCount` |

When only `totalTokens` is available (input/output are null), the UI falls back to displaying `"3.9K tokens"` instead of the `"128 in · 256 out"` breakdown.
