# OpenWebUI Response Quality Study

Date: 2026-06-08
Source snapshot: `study-sources/open-webui` at `02dc3e6`

## Goal

Study how OpenWebUI handles request/response interception so agrun can improve final answer quality gating.

## What OpenWebUI Does

OpenWebUI has a plugin-style Function system. A Function can be a `Pipe`, `Filter`, or `Action`.

Relevant files:

- `study-sources/open-webui/backend/open_webui/utils/plugin.py`
- `study-sources/open-webui/backend/open_webui/utils/filter.py`
- `study-sources/open-webui/backend/open_webui/utils/middleware.py`
- `study-sources/open-webui/backend/open_webui/models/functions.py`
- `study-sources/open-webui/src/lib/components/admin/Functions/FunctionEditor.svelte`

The important pattern is `Filter`:

- `inlet(body, ...)`: runs before the model call. It can validate or change the request.
- `stream(event, ...)`: runs during streaming. It can modify streamed events.
- `outlet(body, ...)`: runs after model output. It can analyze or change the final assistant message.

OpenWebUI sorts active filters, runs them in order, and lets each filter mutate the payload. Filters can be global or attached to a model.

## Important Architecture Detail

OpenWebUI now runs outlet filters inline during chat completion. The old `/api/chat/completed` path is marked deprecated.

Relevant files:

- `study-sources/open-webui/backend/open_webui/main.py`
- `study-sources/open-webui/backend/open_webui/utils/middleware.py`

In `outlet_filter_handler`, OpenWebUI builds the final message list, runs pipeline outlet filters, then Function outlet filters. If the outlet result changes a message, it writes the changed content back to the chat DB and emits a `chat:outlet` event so the frontend updates.

This means final-response post-processing is part of the completion lifecycle, not a loose afterthought.

## Stream Filter Findings

Relevant files:

- `study-sources/open-webui/backend/open_webui/utils/middleware.py`
- `study-sources/open-webui/backend/open_webui/utils/filter.py`

OpenWebUI also runs `stream` filters while a response is being streamed.

In the streaming handler, each SSE `data:` line is decoded as JSON and passed through `process_filter_functions(..., filter_type="stream", ...)` before it is emitted or persisted. In `process_filter_functions`, stream filters receive `event` instead of `body`.

Two stream paths matter:

- Normal websocket-backed streaming: parsed model events go through stream filters before `chat:completion` events are emitted.
- Fallback streaming: initial events and raw generator chunks also pass through stream filters before being yielded.

After streaming completes, OpenWebUI still builds the final assistant message and calls `outlet_filter_handler`. So `stream` filters are not the final authority; they are a live event transformation layer before final outlet processing.

## Stream Filter Limits

Stream filters are useful for:

- hiding or rewriting obvious unsafe chunks before the user sees them
- emitting live status events
- normalizing stream event shape
- detecting special tags and splitting output items
- suppressing visibly invalid stream events

They are weaker for full response quality:

- Many quality checks need the full final text.
- Citation/source completeness often needs the final set of cited URLs, read sources, and claims.
- Blocking too early can create broken partial output.
- Stream filters can reduce user-visible leakage, but final acceptance still needs an outlet/final gate.

For citation/source issues, stream filters can catch obvious live violations such as a forbidden URL appearing in a chunk. They should not be the only source-minimum verifier.

## What It Does Not Guarantee

OpenWebUI does not provide a universal built-in response quality guarantee by itself. It provides extension points. Quality enforcement depends on the installed filter or pipeline.

Examples of what filters can enforce:

- block or rewrite unsafe output
- append disclaimers
- enforce turn limits
- remove sensitive text
- run custom quality checks

But the default system is not a semantic truth verifier. The guarantee comes only when a filter implements a concrete policy.

## Lesson For agrun

agrun already has richer internal evidence signals than OpenWebUI:

- `final_sources`
- `included_claims`
- `sourceMinimum`
- `finalReadiness`
- `terminal-final-contract`
- read source quality
- event ledger / Inspector trace

The current gap is not missing signals. The gap is missing one final answer acceptance SSOT.

Current failure mode from the latest `today news` traces:

- finalizer prompt knows `source minimum not met`
- planner/evaluator can still allow `limited`
- terminal contract reports `readinessOk=true`
- run finishes as ordinary `complete`

## Recommended agrun Design

Add a `finalAnswerQualityGate` after finalizer output and before `finishRun`.

Inputs should be objective runtime facts, not only model self-assessment:

- number of successful read URLs
- number of relevant read sources
- required source minimum, if active
- final cited URLs
- `final_sources` IDs available to finalizer
- claims used in final response
- finalReadiness fields
- requested length / observed length
- guardrail and terminal repair state

Output should be a small enum:

- `pass`
- `completed_with_limitations`
- `continuation_required`
- `failed_quality_gate`

Policy example:

- If source minimum is unmet but recoverable, return `continuation_required`.
- If source minimum is unmet and budget/external source recovery is exhausted, return `completed_with_limitations`.
- If final output cites URLs outside `final_sources`, return `failed_quality_gate` or re-run finalizer with a strict repair prompt.
- If `decision=limited` but `remainingGaps` is missing while objective deficits exist, return `continuation_required`.

For streaming, add a lighter `finalAnswerStreamGate` beside the existing `createStreamFence` behavior:

- Let it inspect streamed deltas/events before `onToken`.
- Buffer short windows around citation-like text and Markdown links.
- Suppress or replace clearly forbidden links not present in `final_sources`.
- Emit Inspector warnings such as `stream_source_violation_detected`.
- Do not decide final success from stream alone.

The final decision should remain with `finalAnswerQualityGate`.

## Transferable Pattern

OpenWebUI teaches the shape:

`request -> inlet filters -> model/tool work -> stream filters -> final output -> outlet filters -> persist/emit`

agrun should use:

`OODAE loop -> finalizer stream -> finalAnswerStreamGate -> finalizer output -> finalAnswerQualityGate -> continue/repair/limited/fail -> finishRun + Inspector`

This keeps runtime AI-first: runtime does not write the answer, but it does decide whether the answer may be treated as complete.
