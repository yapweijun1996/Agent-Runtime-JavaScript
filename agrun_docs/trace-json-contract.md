# Trace JSON Contract

Status: AGRUN-291 stable v1.

The live trace contract is the single debug shape for Node CLI and browser Inspector surfaces. It keeps a human-readable layer for fast engineering diagnosis and adds an OpenTelemetry-compatible span projection for future export.

```js
{
  meta: {},
  input: {},
  output: {},
  trace: [],
  otel: { spans: [] }
}
```

## Top-level Sections

`meta`

- `schemaVersion`: `agrun.trace.v1`.
- `runId`, `status`, `provider`, `model`, `outputKind`, `finalAnswerSource`.
- OpenAI fields: `apiVariant`, `reasoningEffort`.
- Gemini fields: `geminiThinkingConfig`, `thinkingLevel`, `thinkingBudget`.
- `startedAt`, `endedAt`, `durationMs`, `stepCount`, `usage`.
- `redaction`: always `safe_summary_no_secrets_no_image_bytes`.

`input`

- Redacted user prompt plus `promptSummary` with `chars`, `hash`, and `preview`.
- Redacted provider request summary: provider, model, API variant, reasoning effort, Gemini thinking config, endpoint origin/path, search endpoint origin/path.
- `rawShape` lists non-sensitive input keys that were present.

`output`

- `status`, `kind`, `finalAnswerSource`, redacted `text`, `textSummary`, `finishReason`, `usage`.
- Failed runs set `output.error` and keep `output.text` empty when no answer exists.

`trace[]`

Each runtime `onStep(step, snapshot)` event becomes one item:

```js
{
  index,
  timestamp,
  tPlusMs,
  phase,
  eventType,
  cycle,
  decision,
  action,
  providerRequest,
  providerResponse,
  snapshotSummary
}
```

The trace must preserve key events including `run-started`, `cycle-started`, `planner-requested`, `agent-workflow-packet`, `planner-responded`, `terminal-final-contract-audited`, and `phase-evaluate-completed`.

`otel.spans[]`

The projection uses span fields compatible with OpenTelemetry concepts: `traceId`, `spanId`, `parentSpanId`, `name`, `startTime`, `endTime`, `attributes`, `events`, and `status`. The tree is:

```text
agrun.run
  agrun.cycle.1
    agrun.observe
    agrun.orient
    agrun.decide
      llm.request
      llm.response
    agrun.act
    agrun.evaluate
```

Attributes include:

- `agrun.provider`
- `agrun.model`
- `agrun.api_variant`
- `agrun.reasoning_effort`
- `agrun.gemini_thinking_level`
- `agrun.output_kind`
- `llm.token.total`
- `llm.latency_ms`

Reference: OpenTelemetry traces model spans as timestamped units with parent/child relationships, attributes, events, and status. See [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/) and [Tracing API](https://opentelemetry.io/docs/specs/otel/trace/api/).

## Secret Redaction

The contract is safe for debug sharing but not a data-loss-prevention system. It redacts by key and value pattern before writing CLI files or browser debug snapshots.

Redacted key patterns include:

- `apiKey`, `api_key`
- `authorization`, `bearer`
- `token`
- `secret`
- `password`
- `credential`
- `cookie`
- `x-goog-api-key`

Redacted value patterns include Bearer tokens, OpenAI-style `sk-...` keys, gateway `gw_...` keys, and image data URLs. Image bytes become `[image data omitted]`.

Do not commit live trace files unless they are sanitized fixtures.

## Provider Request and Response Summaries

Provider request summaries come from existing `llm_request_trace` payloads:

- provider/model/API variant
- safe provider options
- prompt/system/message character counts
- tool count and schema size
- session context shape and character counts
- endpoint origin/path, never raw query strings

Provider response summaries come from `llm_response_trace` payloads:

- HTTP/status-like status when available
- finish reason
- latency
- text character count
- tool call count and argument shape
- token usage
- raw response shape preview after redaction

## OpenAI and Gemini Debug Fields

OpenAI Responses runs must surface:

- `meta.apiVariant`
- `meta.reasoningEffort`
- `input.providerRequest.apiVariant`
- `input.providerRequest.reasoningEffort`
- trace item `providerRequest.payload.providerOptions.openai.reasoningEffort`
- span attribute `agrun.api_variant`
- span attribute `agrun.reasoning_effort`

Gemini runs must surface:

- `meta.geminiThinkingConfig`
- `meta.thinkingLevel`
- `meta.thinkingBudget`
- `input.providerRequest.geminiThinkingConfig`
- trace item `providerRequest.payload.providerOptions.google.thinkingConfig`
- span attribute `agrun.gemini_thinking_level`

## Failed Runs

Failed runs still produce a partial trace:

- `meta.status` is `failed`.
- `meta.error` and `output.error` include redacted code/message/details.
- `trace[]` contains every event observed before failure.
- `otel.spans[0].status.code` is `ERROR`.
- Provider/API failure summaries are carried when `provider-error` or `llm_response_trace` data exists.

## Debugging Workflow

Planner debugging:

- Start with `trace[]` rows for `planner-requested`, `agent-workflow-packet`, and `planner-responded`.
- Compare provider request summaries against planner response summaries.
- Check `decision` and `phase-decide-completed` for the selected action.

Provider debugging:

- Inspect `providerRequest` for API variant, reasoning effort, Gemini thinking config, prompt/message/tool sizes, and endpoint origin.
- Inspect `providerResponse` for status, latency, token usage, finish reason, text length, and tool call shape.

Action debugging:

- Inspect `phase-act-*`, `action-*`, and action result rows.
- Use `snapshotSummary.lastAction`, `status`, and `cycleCount` to connect action choice to run state.

Finalization debugging:

- Inspect `terminal-final-contract-audited`, `phase-evaluate-completed`, `output.kind`, `output.textSummary`, and `meta.finalAnswerSource`.
- If `status=failed`, read the partial trace before the error instead of relying only on the final error object.

Browser debugging:

- The browser example projects the same contract into the Inspector, not into a separate browser-only schema.
- Inspector-only diagnostics such as partial `read_url` failures and virtual-workspace quality/structure warnings must stay in Debug UI / Inspector panels. The normal assistant chat card should show the final answer only; user-facing limitations should be authored in the answer text, not injected as debug chrome.
- The Inspector remains the place to inspect input, output, step timeline, provider request/response summaries, action summaries, OTel span tree, evidence banners, and virtual-workspace quality state.
- Inspector copy uses the presentation taxonomy `ok`, `run_failed`, `evidence_degraded`, `workspace_quality`, `provider_issue`, and `finalization_issue`. This taxonomy is UI copy only; it does not create a second trace schema.
- Diagnosis cards should use `Status`, `Impact`, `Likely Cause`, and `Next Check` so engineers can identify the first debug target without opening Raw JSON.
- Browser Live Trace adds a `Trace Health` summary over the same AGRUN-291 contract: provider requests, provider responses, tool actions, failed actions, OTel span count, and latest failed action/span.

## CLI

```bash
node scripts/live-trace.mjs \
  --provider openai \
  --model gpt-5-mini \
  --api-variant responses \
  --reasoning-effort medium \
  --prompt "..."
```

```bash
node scripts/live-trace.mjs \
  --provider gemini \
  --gemini-thinking-level high \
  --prompt "..."
```

The CLI prints a readable summary and writes full JSON under `agrun_debug_runs/` by default.
