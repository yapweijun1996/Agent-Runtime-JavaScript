# agrun.js Result Schema

## Purpose

This document defines the canonical result envelope returned by `runtime.run(input)`.

It is the shared contract for:

- Web UI hosts
- debug viewers
- adapter layers
- test fixtures

For runtime creation and public methods, see `agrun_docs/public-runtime-api.md`.
For Web UI consumption patterns, see `agrun_docs/webui-integration-contract.md`.

## Canonical Run Result

Top-level shape:

```js
{
  input,
  normalizedInput,
  selectedSkill,
  output,
  error,
  memoryEntriesAdded,
  steps,
  runState,
  finalAnswerSource,
  mode
}
```

### Top-Level Fields

| Field | Presence | Stability | Producer ownership | Consumer intent |
| --- | --- | --- | --- | --- |
| `input` | required | stable | runtime | Preserve original host input for debug and replay context. |
| `normalizedInput` | required | stable | runtime | Read normalized type/text/raw shape used inside the run. |
| `selectedSkill` | required | stable | runtime | Identify the selected executable skill when one is used. |
| `output` | required | stable | runtime | Consume terminal success or block payload. |
| `error` | required | stable | runtime | Consume structured failure data when the run fails. |
| `memoryEntriesAdded` | required | stable | runtime | Read semantic memory entries committed during the run. |
| `steps` | required | stable | runtime | Inspect runtime trace and derive UI activities. |
| `runState` | required | stable | runtime | Consume per-run execution state. |
| `finalAnswerSource` | required | stable | runtime | Attribute the terminal answer to a skill, planner, policy, or action. |
| `mode` | required today | transitional | runtime | Compatibility/debug only, not a long-term control-flow switch. |

### Output and Error Rules

- `error !== null` means the run failed.
- Failed runs currently return `output: null`.
- Blocked runs should still return structured `output`, such as `approval_required` or `approval_denied`.
- Research-style `final_response` outputs may fill `output.citations` with the URLs used for the answer, prioritizing successful `read_url` sources and verified aggregated search sources over snippet-only search results.
- `error`, `pendingApproval`, and `steps` have different responsibilities:
  - `error`: terminal failure record
  - `pendingApproval`: resumable or locked policy block
  - `steps`: detailed trace and UI derivation source

## RunState Schema

Canonical per-run state fields:

| Field | Presence | Stability | Meaning |
| --- | --- | --- | --- |
| `runId` | required | stable | Unique identifier for the run. |
| `status` | required | stable | Current terminal or active status. |
| `phase` | required | stable | Current OODAE phase or `null` before phase start. |
| `cycleCount` | required | stable | Number of completed or active cycles. |
| `stepCount` | required | stable | Number of trace steps pushed into `steps`. |
| `selectedSkill` | required | stable | Last selected skill name or `null`. |
| `lastAction` | required | stable | Last runtime action name or `null`. |
| `finalAnswerSource` | required | stable | Final source attribution for the result. |
| `pendingApproval` | required | stable | Approval contract for blocked runs or `null`. |
| `availableActions` | required | stable | Planner-visible action names for action-capable turns. |
| `availableAgentSkills` | required | stable | Planner-visible agent skill summaries for action-capable turns. For large catalogs this is the Top-K ranked candidate set, not the full provider catalog. |
| `skillCatalogRanking` | optional | stable advanced | Debug metadata for skill Top-K selection: total count, selected count, filtered count, topK, selected matches, and sanitized skill policy filter reasons when `skillPolicy` removes candidates. |
| `agentSkillContext` | required | stable | Active/read/listed bundled agent skill context. |
| `researchContext` | required | stable | Latest query, aggregated search evidence, verification state, and accumulated `read_url` evidence retained in the run. |
| `toolContext` | required | stable | Latest bundled skill tool result and per-run bundled tool history. |
| `contextSnapshot` | required | stable | Canonical structured continuity snapshot with session memory, inquiry context, and continuity resolution. Compatibility projections may still appear inside it, but they are not canonical truth. |
| `continuityResolution` | required | stable | Current run's continuity state, optional simple/legacy shortcut decision, or `null`. ADR-0012 long research treats this as state/gate context, not runtime-owned action policy. |
| `observation` | required | stable | Runtime-owned interpretation of the current outcome. |
| `error` | required | stable | Structured error mirror or `null`. |
| `oodae` | required | stable | OODAE execution snapshot. |
| `mode` | required today | transitional | Compatibility/debug mode only. |

### Common `runState.status` Values

- `running`
- `completed`
- `blocked`
- `failed`

### Common `runState.phase` Values

- `observe`
- `orient`
- `decide`
- `act`
- `evaluate`
- `null` before phase start

### `oodae` Shape

```js
{
  currentPhase,
  phases,
  cycles: [
    {
      cycle,
      observe,
      orient,
      decide,
      act,
      evaluate
    }
  ]
}
```

Hosts may render `oodae` in inspectors.
Mainline UI flow should not require direct branching on low-level phase records.

## Research Context Shape

`runState.researchContext` is the canonical runtime-owned research cache for search-driven turns.

```js
{
  lastQuery,
  searchResults,
  aggregatedSearchResults,
  searchPasses,
  searchPlan,
  verification,
  verificationState,
  readSources
}
```

Rules:

- `lastQuery` is the last executed search query.
- `searchResults` is the compatibility mirror for top aggregated ranked results.
- `aggregatedSearchResults` is the canonical cross-pass deduplicated and ranked candidate list.
- `searchPasses` records each executed search pass with query, request URL, raw items, and normalized items.
- `searchPlan` records the planner-owned strategy, base query, and planned passes.
- `verification` is the structured verification summary for aggregated search evidence.
- `verificationState` is the stable enum projection used by runtime continuation logic.
- `readSources` remains the canonical list of attempted and successful `read_url` page reads.

Stable `verificationState` values today:

- `none`
- `single_source`
- `corroborated`
- `official_plus_secondary`

## Direct Web Search Result Shape

Direct `type: "web_search"` turns return `output.kind === "web_search_result"` with aggregated search data, not a single provider snapshot.

```js
{
  kind: "web_search_result",
  originalQuery,
  query,
  lastExecutedQuery,
  count,
  items,
  rankedItems,
  searchPlan,
  searchPasses,
  verification
}
```

Rules:

- `originalQuery` preserves the host-supplied query before planner normalization.
- `query` is the planner base query and is the compatibility field hosts should prefer over raw pass queries.
- `lastExecutedQuery` is the last pass actually sent to the provider.
- `rankedItems` is the canonical aggregated result list across all passes.
- `items` is the compatibility alias for the top ranked subset shown to existing hosts.
- `searchPlan` describes the chosen strategy and planned passes.
- `searchPasses` is the execution record for each completed pass.
- `verification` summarizes source agreement across ranked items.

Canonical ranked item fields today:

- `title`
- `url`
- `snippet`
- `domain`
- `engine`
- `passIndex`
- `query`
- `sourceCategory`
- `sourceScore`

## Error Schema

Structured error shape:

```js
{
  code,
  message,
  skill,
  cause,
  details
}
```

| Field | Presence | Meaning |
| --- | --- | --- |
| `code` | required | Stable runtime error code. |
| `message` | required | Human-readable summary. |
| `skill` | required | Related skill name or `null`. |
| `cause` | required | Reduced cause string or `null`. |
| `details` | required | Serializable debug details or `null`. |

Common codes include:

- `SKILL_CAN_HANDLE_ERROR`
- `SKILL_ORIENT_ERROR`
- `SKILL_EXECUTE_ERROR`
- `SKILL_EVALUATE_ERROR`
- `NO_SKILL_MATCHED`
- `PLANNER_ERROR`
- `PLANNER_INVALID_ACTION`
- `ACTION_EXECUTE_ERROR`
- `APPROVAL_RESOLUTION_ERROR`
- `MAX_STEPS_EXCEEDED`

## Bundled Skill Tool Result Shape

When `execute_skill_tool` succeeds, `runState.toolContext` uses the canonical shape:

```js
{
  lastResult: {
    kind: "agent_skill_tool_result",
    skill,
    tool,
    args,
    result
  },
  history: [
    {
      kind: "agent_skill_tool_result",
      skill,
      tool,
      args,
      result
    }
  ]
}
```

## Token Usage Schema

Token usage is captured from provider API responses and normalized by `createUsageSnapshot()` in `src/session/token-budget.js`.

### Per-Run Usage Snapshot

Returned by `createUsageSnapshot(output)` and stored as `sessionRecord.lastTokenUsage`:

```js
{
  inputTokens,      // prompt tokens (number or null)
  outputTokens,     // completion tokens (number or null)
  totalTokens,      // total tokens (number or null)
  model,            // model name from provider response (string or null)
  provider,         // "openai" | "gemini" | null
  updatedAt         // timestamp (Date.now())
}
```

Rules:

- Provider field names vary across formats. `createUsageSnapshot()` (runtime) and `createDebugTokenUsage()` (browser) both normalize by checking multiple field names in priority order:
  - **AI SDK** (camelCase): `inputTokens`, `outputTokens`, `totalTokens`
  - **Raw OpenAI** (snake_case): `prompt_tokens`, `completion_tokens`, `total_tokens`
  - **Raw Gemini**: `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`
- `null` means the provider did not return that field.
- Usage is extracted from `output.usage` on successful runs only. Failed runs return `null`.

### Cumulative Session Usage

Stored as `sessionRecord.cumulativeUsage`, accumulated across all turns in a session:

```js
{
  inputTokens,      // sum of all turn input tokens
  outputTokens,     // sum of all turn output tokens
  totalTokens,      // sum of all turn total tokens
  turnCount,        // number of turns that contributed usage data
  updatedAt         // timestamp of last update
}
```

Rules:

- Cumulative usage is updated after each successful `session.run()` that returns non-null usage.
- Turns with `null` usage (e.g., failed runs, non-provider skills) do not increment `turnCount`.
- `cumulativeUsage` is persisted to the session store alongside `lastTokenUsage`.
- One-shot `runtime.run()` (no session) does not accumulate — use `output.usage` directly.

### Cost Calculation Convention

Token-to-cost conversion is a **browser layer concern**, not a runtime responsibility.

```
Runtime provides:   token counts (inputTokens, outputTokens, model, provider)
Browser calculates: cost = inputTokens × inputPrice + outputTokens × outputPrice
```

The runtime does not include pricing data, currency formatting, or cost aggregation. Host applications should maintain their own pricing tables, as model pricing changes frequently and varies by account tier.

Recommended browser-side approach:

- Maintain a static pricing table keyed by `{ provider, model }` → `{ inputPricePer1M, outputPricePer1M }`
- Allow user override via Settings for custom pricing
- Display token counts by default; cost display as opt-in

## Memory Entry Schema

Memory entries returned by `memoryEntriesAdded` and `runtime.getMemory().readAll()` use the canonical stored shape:

```js
{
  timestamp,
  skill,
  input,
  output,
  metadata
}
```

Rules:

- `timestamp` is generated by the runtime.
- `skill` is the selected skill name or `null`.
- `input` is the normalized or overridden input recorded for memory.
- `output` is the semantic memory payload, not the entire run result.
- `metadata` is a small serializable object.

## Step Event Schema

Each trace step uses:

```js
{
  type,
  detail,
  timestamp
}
```

Rules:

- `type` is a stable string label with extension room for new runtime events.

Continuity-specific step:

```js
{
  type: "continuity-resolved",
  detail: {
    resolutionKind,
    source,
    selectedUrl,
    confidence
  },
  timestamp
}
```
- `detail` is a serializable object or `null`.
- `timestamp` is an ISO string.
- Hosts must preserve unknown step types and ignore what they do not understand.

### Event Families

- Lifecycle events: `run-started`, `cycle-started`
- Skill/action routing events: `skill-checking`, `skill-selected`, `planner-requested`, `action-executing`
- Search/provider events: `web-search-requested`, `web-search-completed`, `provider-requested`, `provider-responded`
- Failure/block events: `skill-failed`, `planner-invalid-action`, `run-max-steps-reached`, `approval-resolved`
- Phase boundary events: `phase-observe-started`, `phase-evaluate-completed`

Hosts may derive higher-level activities from these families instead of hard-coding every individual step type.

### Action Call Correlation

`action-executing`, `action-executed`, and `action-execute-error` steps all carry a stable `callId` so consumers can deterministically pair them — required for timeline UIs that render parallel tool calls.

```js
{ type: "action-executing", detail: {
    callId,           // stable per invocation — format: "<runId>-c<cycle>-a<counter>"
    actionName,
    skillName?,       // present for execute_skill_tool — captured from decision
    toolName?,        // present for execute_skill_tool — captured from decision
    args?: {          // sanitized, PII-safe digest (execute_skill_tool only)
      skillName?,
      toolName?,
      argKeys,        // array of top-level arg names (uncapped)
      argsDigest,     // e.g. "filters={date_from=2026-04-01;amount_min=100};pageSize=50"
      argsPreview     // structured object mirror of argsDigest, e.g.
                      // { filters: { date_from: "2026-04-01", amount_min: 100 }, pageSize: 50 }
    },
    planIndex?        // present only on parallel plan path
}}

{ type: "action-executed", detail: {
    callId,           // matches the corresponding action-executing
    actionName,
    skillName?,       // same value as action-executing (captured once at invocation start)
    toolName?,        // same value as action-executing (captured once at invocation start)
    control,
    query?,
    resultCount?,
    planIndex?
}}

{ type: "action-execute-error", detail: {
    callId,
    actionName,
    error,
    cycle,
    planIndex?
}}
```

- `callId` is guaranteed unique within a single `runtime.run()` and monotonic.
- `toolName` is captured once at `action-executing` and echoed unchanged on `action-executed` — consumers must not rely on recomputation from output.
- `args.argsDigest` is a compact semicolon-delimited string for inline UI labels (e.g. "Aggregate sales invoices · date_from=2010-01").
- `args.argsPreview` is the structured sibling of `argsDigest` — use it for inspector panels, collapsible trees, or as LLM input for generated activity labels. Both share the same PII-safety bounds.
- PII-safety bounds (apply to both digest and preview): string values truncated to 40 chars (`…` suffix), object traversal capped at depth 1 (deeper nodes become `"{…}"`), max 6 keys per level (overflow silently dropped in preview; `…` suffix in digest), arrays rendered as `"[N]"` — never their contents.
- `argKeys` is NOT capped at 6 — it lists all top-level arg names so consumers can detect preview truncation via `argKeys.length > Object.keys(argsPreview).length`.
- Pair events by `callId`. Fall back to `planIndex` only for older runtimes.

## Approval Schema

`runState.pendingApproval` and blocked outputs use:

```js
{
  actionName,
  policy,
  reason,
  resumable,
  resolution,
  resumeToken
}
```

| Field | Presence | Stability | Meaning |
| --- | --- | --- | --- |
| `actionName` | required | stable | Blocked action identifier. |
| `policy` | required | stable | `allow`, `ask`, or `deny`. |
| `reason` | required | stable | Human-readable block reason. |
| `resumable` | required | stable | Whether the blocked action can be resumed. |
| `resolution` | required | stable | `pending`, `approved`, or `denied`. |
| `resumeToken` | required | stable host-managed | Replay token for approval resolution requests. |

Host rule:

- Treat `resumeToken` as an opaque replay token unless building a custom approval inspector.
- Pass it back unchanged when submitting `approval_resolution`.

## Debug Snapshot Schema

Debug snapshot is a host-derived standard artifact, not a runtime-owned canonical object.

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

### Debug Snapshot Rules

- `runtime.steps` should be a deep-cloned mirror of `result.steps`.
- `runtime.pendingApproval` should mirror `result.runState.pendingApproval`.
- `request`, `response`, and `timing` are host-owned extensions.
- `mode` is a host-facing view label.
  - Recommended values: `provider`, `web_search`, `approval_resolution`
  - Current example may reuse `provider` for approval resolution; hosts may normalize this if needed.

Recommended `runtime` block:

```js
{
  runId,
  status,
  mode,
  phase,
  selectedSkill,
  lastAction,
  finalAnswerSource,
  availableActions,
  pendingApproval,
  researchContext,
  oodae,
  stepCount,
  steps
}
```

## Compatibility Notes

- `mode` and `runState.mode` are transitional compatibility fields.
- Current values may include `tool_loop` and `skill_loop`.
- `mode` is a compatibility/debug field and is not the recommended primary feature switch for rendering or control flow.

## JSON Examples

### Completed Run

```json
{
  "finalAnswerSource": "provider_answer",
  "input": {
    "provider": "openai",
    "prompt": "Say hello."
  },
  "mode": "tool_loop",
  "normalizedInput": {
    "raw": {
      "provider": "openai",
      "prompt": "Say hello."
    },
    "text": null,
    "type": "object"
  },
  "selectedSkill": null,
  "output": {
    "kind": "provider_answer",
    "provider": "openai",
    "text": "Hello from OpenAI."
  },
  "error": null,
  "memoryEntriesAdded": [],
  "steps": [],
  "runState": {
    "runId": "run-3",
    "status": "completed",
    "phase": "evaluate",
    "cycleCount": 1,
    "stepCount": 12,
    "selectedSkill": null,
    "lastAction": "provider_answer",
    "finalAnswerSource": "provider_answer",
    "pendingApproval": null,
    "availableActions": [
      "web_search",
      "provider_answer"
    ],
    "availableAgentSkills": [],
    "agentSkillContext": {
      "activeSkill": null,
      "catalogListed": false,
      "lastReadSkill": null
    },
    "researchContext": {
      "lastQuery": null,
      "searchResults": []
    },
    "observation": {
      "kind": "success"
    },
    "error": null,
    "oodae": {
      "currentPhase": "evaluate",
      "cycles": []
    },
    "mode": "tool_loop"
  }
}
```

### Blocked Run

```json
{
  "finalAnswerSource": "policy",
  "mode": "tool_loop",
  "selectedSkill": null,
  "output": {
    "kind": "approval_required",
    "text": "Approval required before running web_search.",
    "pendingApproval": {
      "actionName": "web_search",
      "policy": "ask",
      "reason": "Action \"web_search\" requires approval.",
      "resumable": true,
      "resolution": "pending",
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
  },
  "error": null
}
```
