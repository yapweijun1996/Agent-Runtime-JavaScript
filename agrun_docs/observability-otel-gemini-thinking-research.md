# Observability, Node Live Timing, and Gemini Thinking Research

Status: Research note, 2026-05-20.

## Context

This note records the current debug/performance surface before continuing the
workspace tool weak-model work. The goal is to keep runtime changes AI-first:
the runtime exposes observable facts and optional provider controls, while the
AI still owns planning, workspace patch content, and publish readiness.

## Current agrun Support

agrun already has an internal observability contract:

- `runtime.run(..., { onStep })` receives every runtime step.
- `onPlannerDecision` captures planner decisions and selected actions.
- `onToolResult` captures action/tool outputs.
- `result.steps` is the stable trace source for UI activities and inspectors.
- Browser Inspector and Debug Packet derive from these runtime facts.

The repo currently has no native OpenTelemetry dependency or OTLP exporter. That
means agrun can debug locally today, but cannot directly send standard spans to
Jaeger, Tempo, Honeycomb, Datadog, or another OTel backend without an adapter.

## OpenTelemetry Finding

OpenTelemetry is useful for agrun as an optional bridge, not as a replacement
for the Inspector. OTel can standardize span export for production RUM and
backend correlation, while agrun's Inspector remains the AI-specific SSOT for
planner decisions, workspace diagnostics, `riskFlags`, hard-veto state, and
publish readiness.

Recommended future adapter shape:

- `agrun.run` span for one `runtime.run()`.
- `agrun.planner` span for planner request/response.
- `agrun.provider` span for LLM provider calls.
- `agrun.action` span for `web_search`, `read_url`, workspace actions, and
  skill tools.
- `agrun.workspace.patch_preview` span for `workspace_propose_patch`.
- `agrun.workspace.patch_apply` span for `workspace_apply_patch`.
- `agrun.finalize` span for finalization/publish.

Important attributes:

- `agrun.run_id`
- `agrun.thread_id`
- `agrun.cycle`
- `agrun.action.name`
- `agrun.status`
- `agrun.error.type`
- `gen_ai.provider.name`
- `gen_ai.request.model`
- `agrun.workspace.delta_words`
- `agrun.workspace.risk_flags`
- `agrun.terminal_repair.escalation`

Sensitive content should be opt-in only. Do not export full prompts, full
outputs, or full workspace content by default.

Sources:

- OpenTelemetry JavaScript docs: https://opentelemetry.io/docs/languages/js/
- OpenTelemetry browser getting started:
  https://opentelemetry.io/docs/languages/js/getting-started/browser/
- OpenTelemetry GenAI agent spans:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/

## Node Live Timing Finding

`test/node-agrun-3000-live.mjs` already outputs task duration:

- The run records `startedAt = Date.now()` before `runtime.run()`.
- The final `node_agrun_live_summary` includes `summary.durationMs`.
- Debug mode (`AGRUN_DEBUG=1` or `NODE_AGRUN_LIVE_DEBUG=1`) writes JSONL/MD
  artifacts. Each debug event has `tMs`, relative to the debug recorder start.
- The generated Markdown report renders `duration` in the Verdict table.
- Provider, planner, action, and synthesize paths also emit `durationMs` in
  runtime events or workflow packets where available.

This is enough to compare whole-run performance now. The gap is convenience:
the summary does not yet include a compact per-action timing table such as
planner p50/p95, provider p50/p95, `read_url` total time, and workspace mutation
time. That should be a debug-summary improvement, not a workspace tool blocker.

## Gemini Thinking Finding

Gemini supports controllable thinking, but the correct parameter depends on the
model generation.

Official Gemini API guidance:

- Gemini 3 and newer: use `thinkingConfig.thinkingLevel`.
- Gemini 3.1 Flash-Lite supports `minimal`, `low`, `medium`, and `high`.
  `minimal` is the default for Gemini 3.1 Flash-Lite. It is not a hard
  thinking-off guarantee.
- Gemini 2.5 models: use `thinkingConfig.thinkingBudget`.
- For Gemini 2.5 Flash-Lite, default is no thinking. Non-zero thinking budget
  enables thinking.
- Thought summaries can be requested with `includeThoughts: true`, but this is
  sensitive and should not be enabled by default in agrun debug artifacts.

Source:

- Gemini thinking docs: https://ai.google.dev/gemini-api/docs/thinking

Installed AI SDK support:

- This repo uses `@ai-sdk/google@^3.0.60`.
- Local package types include `providerOptions.google.thinkingConfig` with:
  `thinkingLevel?: "minimal" | "low" | "medium" | "high"`,
  `thinkingBudget?: number`, and `includeThoughts?: boolean`.

Current agrun support:

- `normalizeBrowserProviderRequest()` accepts a structured
  `geminiThinkingConfig` field and top-level `thinkingLevel`,
  `thinkingBudget`, and `includeThoughts` shortcuts for Gemini requests.
- `requestGeminiContent()` and `requestGeminiContentStreaming()` pass the
  validated config as `providerOptions.google.thinkingConfig`.
- The provider request trace records the sanitized provider options under
  `requestBody.payload.providerOptions`, so Inspector/debug artifacts can
  confirm which thinking knob was used without exposing prompt secrets.
- `test/node-agrun-3000-live.mjs` supports optional env knobs:
  `NODE_AGRUN_GEMINI_THINKING_LEVEL`, `NODE_AGRUN_GEMINI_THINKING_BUDGET`,
  and `NODE_AGRUN_GEMINI_INCLUDE_THOUGHTS` (also accepts the shorter
  `GEMINI_THINKING_*` names).

Usage guidance:

- Gemini 3.x: prefer `thinkingLevel`.
- Gemini 2.5: prefer `thinkingBudget`.
- Default to current behavior. Do not change model behavior silently.
- Never export thought summaries unless the host opts in.

## Workspace Priority

Keep the next implementation focus on weak-model workspace tool logic:

1. Make `workspace_propose_patch` / `workspace_apply_patch` easier for
   flash-lite to choose correctly.
2. Use Node live `durationMs` and debug `tMs` to measure performance.
3. Use Gemini thinking controls as a controlled experiment, not as the main
   solution. The harness must make weak models work; stronger thinking is a
   tuning knob, not the architecture.
