# Inspector LLM Trace Window Live Check - 2026-05-10

## Goal

Verify the browser Inspector can show LLM request/response windows and copyable
next-window args after the `windowed_trace_capsule` implementation.

## Setup

- App: `examples/browser`
- Dev server: `http://localhost:3001/?debug_yn=y`
- Test data: synthetic local IndexedDB session with a debug snapshot containing:
  - one `llm_request_trace` with `messageTextChars=6400`;
  - one tool schema summary with `toolSchemaChars=2100`;
  - one `llm_response_trace` with a tool call response;
  - one `research-finalize-contract-readiness-continuation` runtime step.

## Result

Inspector rendered:

- `LLM TRACE`
- `WINDOWS=3`
- `HINTS=1`
- `window:messages[0]`
- `range:0-1800/6400`
- `available:1439`
- `next:1800`
- `hash:qa-message-hash`
- `copy_next_args`
- `window:tools.schema`
- `range:0-1800/2100`
- `window:toolCalls`

Chrome DevTools console check found no warnings/errors.

Screenshot evidence:

- `tmp/inspector-llm-trace-window-live.png`

## HBR

The live fixture proved Inspector visibility and UI wiring, but it used a
synthetic debug snapshot rather than a new paid provider call. This was
intentional because the change is an Inspector projection over existing safe
trace summaries, not a provider behavior change.
