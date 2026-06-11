# LLM Finalizer Source Window QA — 2026-05-10

## Goal

Verify the LLM Trace follow-up that compacted finalizer session context while
preserving AI-owned access to later `read_url` page text through source windows.

## Implementation Under Test

- `read_url` accepts `textStart` and `textLength`.
- `read_url` returns `textRange` and `nextTextStart`.
- Planner/native prompts instruct AI to re-read the same URL at
  `textStart=nextTextStart` when later page text may matter.
- Finalizer receives a compact session context instead of raw history/read_url
  body duplication.
- Inspector LLM Trace shows first-to-latest request comparison and JSON/CSV
  copy export.

## Real Browser QA

URL:

`http://127.0.0.1:3014/?debug_yn=y&skill_provider=public&qa_clean=y&qa_reset_settings=y&qa=llm-trace-example-read-v1-2026-05-10&qa_auto_approve_tier1=y`

Prompt:

`Read https://example.com using read_url once, then answer in under 100 words with the page title, status, source URL, and finalReadiness.decision=limited if only one source was read.`

Observed result:

- Status: Healthy Run.
- Last action: `finalize`.
- Read URL status: `ok 200`.
- Planner path: `read_url -> finalize`.
- AI declared `finalReadiness=limited` because only one source was read.
- No browser console warnings/errors were captured.

LLM Trace:

- Requests: 3.
- Responses: 3.
- Tokens: 8,950.
- Latency: 2.9s.
- Inspector rendered `compare:first->latest`.
- Inspector rendered `JSON` and `CSV` copy buttons.

Finalizer request:

- `chars=5,486`.
- `system=3,670`.
- `message=1,812`.
- `session=1,117`.
- No `large_session_context_source` signal appeared.

## HBR

The original broad-prompt automation reported a 240-second timeout:

`Search the web once for AI browser agents in 2026, read one useful source if available, then answer in under 500 words. Include finalReadiness.decision as limited or ready with a one-sentence limitation if evidence is thin.`

Follow-up QA showed the timeout evidence was weak because the automation was
waiting on a case-sensitive `LLM Trace` string while the UI renders
`LLM TRACE`. With the wait corrected to the actual idle state, the same broad
prompt completed in about 14 seconds:

- Path: `web_search -> read_url -> finalize`.
- Read source: `https://www.firecrawl.dev/blog/best-browser-agents`.
- Inspector LLM Trace showed 4 requests / 4 responses.
- Inspector Evidence showed `Read URL Windows` for both the earlier
  `example.com` source and the Firecrawl source.
- Firecrawl window: `range:0-2000/33740`, `next:2000`, `more:yes`.

Remaining HBR: the visible broad-prompt answer did not include the literal
`finalReadiness.decision` text requested by the prompt, although Inspector
showed AI-declared `finalReadiness=ready`.

## Follow-up: Inspector Payload Debug and Visible Readiness Guard

Goal:

- Make it easier for Codex/user to optimize LLM request payload and response
  shape from Inspector instead of guessing from raw JSON.
- Preserve a requested visible `finalReadiness.decision` line without letting
  runtime decide answer readiness.

Observed real Chrome/OpenAI evidence:

- `READ URL WINDOWS` rendered a windowed `example.com` read:
  `range:0-80/149`, `next:80`, `more:yes`, `ok:200`, `text:80`.
- `Copy next args` rendered for the window, allowing the next read to be
  copied as `textStart=80`.
- `LLM TRACE` rendered request/response rows with `Delta system`,
  `Delta message`, `Delta session`, `Delta schema`, and `growth:*`.
- The trace made payload optimization obvious: planner cycles grew mostly from
  message context, while finalizer request shrinkage came mostly from schema
  removal (`growth:schema -12,779` in one run).

HBR from live iterations:

- Native finalize repeatedly rewrote the user's visible readiness request into
  variants such as `decision limited` and `limited decision`, while the final
  visible answer still omitted the literal `finalReadiness.decision` line.
- The final runtime guard now covers structured readiness, exact field syntax,
  `decision limited`, and `limited decision`, but the last full live assertion
  failed before the final `limited decision` regex amendment was rerun.

Harness interpretation:

- This is not a source/length sufficiency gate.
- The guard only preserves an explicit visibility contract after AI/user
  readiness intent is already present.

## Verification Commands

- `node test/unit/read-url-window.test.js`
- `node test/concerns/bundled-skills-and-read-url-service.test.js`
- `node test/unit/session-context-projection.test.js`
- `node test/unit/final-response-prompt.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `npm --prefix examples/browser run test:smoke`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run build`
- `npm run build:lib`
- `npm run dist:check`
- `npm test`
