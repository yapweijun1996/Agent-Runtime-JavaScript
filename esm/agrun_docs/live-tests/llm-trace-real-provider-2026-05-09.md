# LLM Trace Real Provider QA — 2026-05-09

## Goal

Verify that Codex and a user can inspect real LLM request/response payload
shape, token usage, latency, and optimization signals from the browser
Inspector without exposing secrets or making runtime judge AI answer quality.

## Setup

- App URL:
  `http://127.0.0.1:3013/?debug_yn=y&skill_provider=public&qa=llm-trace-real-provider-v3-2026-05-09&qa_auto_approve_tier1=y`
- Provider/model observed: `gemini / gemini-3.1-flash-lite-preview`
- Browser: Chrome DevTools MCP against local example app.
- Host keys: seeded from `.env.local`; Gemini and OpenAI keys were present.

## Run 1

Prompt class: longer research-style web request.

Observed result:

- The run reached cycle 80 and terminalized via `max_steps_continuation`.
- LLM Trace caught a final provider response at cycle 80:
  - input tokens: 22,608
  - output tokens: 589
  - total tokens: 23,197
  - latency: 4,701 ms
  - text chars: 2,749
- The raw final JSON included `finalReadiness`, but the normalized planner
  decision lost it.

Fix from this result:

- Preserve `finalReadiness` through envelope planner repair for final,
  finalize, and plan decisions.
- Preserve `finalReadiness` through native tool parsing for `final_answer`,
  `finalize`, and `plan`.

HBR:

- Before the fix, the harness treated readiness as missing even though the AI
  had declared it, so the run continued until step budget exhaustion.
- After using Stop during the degraded run, the visible debug snapshot showed
  some stale/odd status fields. This is separate UI state cleanup work.

## Run 2

Prompt class: short web-search answer request:

`Search the web once for AI browser agents in 2026, read one useful source if
available, then answer in under 500 words. Include finalReadiness.decision as
limited or ready with a one-sentence limitation if evidence is thin.`

Observed result:

- Completed in about 11 seconds.
- Inspector status: Healthy Run.
- Planner mode: envelope.
- Planner reason: `gemini_lite_complex_native_plan_surface`.
- LLM Trace section rendered and filters worked.

LLM Trace metrics:

- Requests: 2
- Responses: 2
- Total tokens: 14,832
- Total latency: 4.6s

First request:

- estimated chars: 49,750
- messages: 1
- tools: 0
- schema count: 2
- session chars: 1,341
- images: 0
- signal: `large_payload`

First response:

- latency: 1.6s
- total tokens: 9,862
- input tokens: 9,789
- output tokens: 73
- text chars: 259
- finish reason: `stop`

Second request:

- estimated chars: 25,616
- messages: 1
- tools: 0
- schema count: 4
- session chars: 1,341

Second response:

- latency: 3.0s
- total tokens: 4,970
- input tokens: 4,474
- output tokens: 496
- text chars: 2,344
- finish reason: `stop`

## Interpretation

The LLM Trace UI achieved the intended harness outcome: the LLM boundary is now
visible enough for Codex to find optimization targets. A short request still
sent a large first payload, so the next optimization should focus on planner
envelope/session/workflow prompt size for simple tasks.

The trace remains AI-first:

- Runtime exposes observable payload/response shape, token use, and latency.
- Runtime does not decide whether the answer is good enough.
- Runtime does not force `read_url`, synthesize a better answer, or block based
  on token thresholds.

## HBR

- The browser automation duplicated the prompt text during QA, inflating the
  first request size. The payload was still useful as a stress signal.
- The short run did not use `read_url` even though the prompt asked to read one
  useful source. This is an AI/tool-selection quality issue to improve through
  planner/skill guidance or model choice, not a runtime fallback.
- The first real run found a real contract bug: `finalReadiness` was lost during
  planner repair/native final parsing. That bug is now fixed and unit-covered.

## Run 3: Payload Compacting QA

Prompt:

`Search the web once for AI browser agents in 2026, read one useful source if available, then answer in under 500 words. Include finalReadiness.decision as limited or ready with a one-sentence limitation if evidence is thin.`

Pre-fix observation from Run 2:

- First request: `estimatedChars=49,750`.
- The QA input method duplicated the prompt, so this was a stress signal rather
  than a clean baseline.

Intermediate clean run after removing the browser default role:

- URL:
  `http://127.0.0.1:3014/?debug_yn=y&skill_provider=public&qa=llm-trace-payload-compact-v2-no-role-2026-05-09&qa_auto_approve_tier1=y`
- Result: Healthy Run.
- First request: `chars=34,172`, `systemChars=20,236`,
  `messageChars=6,631`.
- Signals: `large_payload`, `large_system_prompt`.
- HBR: compact envelope examples were not enough; system prompt remained the
  dominant payload.

Final compact-system run:

- URL:
  `http://127.0.0.1:3014/?debug_yn=y&skill_provider=public&qa=llm-trace-payload-compact-v3-system-2026-05-09&qa_auto_approve_tier1=y`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Result: Healthy Run.
- Planner path: `web_search -> read_url -> finalize`.
- Read URL: `https://www.browserless.io/blog/state-of-ai-browser-automation-2026`
- Inspector showed no console warnings/errors.

LLM Trace metrics:

- Requests: 4
- Responses: 4
- Total tokens: 29,743
- Total latency: 6.7s

First request after optimization:

- estimated chars: 19,970
- system chars: 6,034
- message chars: 6,631
- messages: 1
- schema count: 2
- session chars: 672
- signals: none for `large_system_prompt`

Later request HBR:

- Cycle 2 request: `chars=111,808`, `systemChars=6,034`,
  `messageChars=52,550`; signals: `large_payload`, `large_message_text`.
- Cycle 3 planner request: `chars=65,136`, `systemChars=6,034`,
  `messageChars=29,214`; signals: `large_payload`, `large_message_text`.
- Runtime finalizer request: `chars=41,504`, `systemChars=4,550`,
  `messageChars=8,399`, `sessionChars=20,375`; signals: `large_payload`,
  `large_session_context`.

Interpretation:

The compact planner profile solved the dominant first-request system prompt
problem for simple tasks. The next bottleneck is not the static system prompt;
it is evidence/message projection after search/read_url and finalizer
session-context projection.

## Run 4: Payload Delta and Evidence Projection QA

Prompt:

`Search the web once for AI browser agents in 2026, read one useful source if available, then answer in under 500 words. Include finalReadiness.decision as limited or ready with a one-sentence limitation if evidence is thin.`

Implementation changes under test:

- Added per-request LLM Trace deltas for `estimatedChars`, `systemChars`,
  `messageTextChars`, and `sessionContextChars`.
- Corrected request `estimatedChars` so trace counts provider payload
  ingredients (`system + messages + tool schema`) instead of double-counting
  debug prompt/session-source text.
- Compacted planner `searchResults` and `lastObservation` projections so raw
  provider/search payloads do not enter the next planner prompt.
- Renamed `large_session_context` signal to `large_session_context_source` for
  finalizer source-context bloat, because session context is rendered into the
  system prompt and is not sent as a separate provider field.

Real QA:

- URL:
  `http://127.0.0.1:3014/?debug_yn=y&skill_provider=public&qa_clean=y&qa_reset_settings=y&qa=llm-trace-payload-delta-v5-evidence-2026-05-09&qa_auto_approve_tier1=y`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Result: completed, Inspector LLM Trace visible.
- Planner path: `web_search -> read_url -> finalize`.
- Read URL: `https://www.browserless.io/blog/state-of-ai-browser-automation-2026`

LLM Trace metrics after evidence projection:

- Requests: 4
- Responses: 4
- Total tokens: 15,984
- Total latency: 7.2s
- Cycle 1 request: `chars=12,953`, `systemChars=6,242`,
  `messageChars=6,709`.
- Cycle 2 planner request: `chars=15,472`, `systemChars=6,242`,
  `messageChars=9,228`, delta `+2,519`.
- Cycle 3 planner request: `chars=17,562`, `systemChars=6,242`,
  `messageChars=11,318`, delta `+2,090`.
- Runtime finalizer request: `chars=12,956`, `systemChars=4,766`,
  `messageChars=8,186`, delta `-4,606`, signal
  `large_session_context_source` with `sessionChars=20,591`.

Comparison to Run 3 HBR:

- Cycle 2 message text improved from `52,550` to `9,228`.
- Cycle 3 planner message text improved from `29,214` to `11,318`.
- Runtime finalizer estimated chars improved from `41,504` to `12,956`.

HBR:

- `large_session_context_source` remains after `read_url` because the source
  context still holds about `20,591` chars. This is now correctly labeled as
  source-context size, not a separately transmitted payload field.
- The final answer was evidence-constrained and single-source, which is acceptable
  for this prompt only because the AI disclosed `finalReadiness.decision:
  limited`.
