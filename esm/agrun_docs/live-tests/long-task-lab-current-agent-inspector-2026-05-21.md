# Long Task Lab Current Agent Inspector — 2026-05-21

## Goal

Make the Long Task Lab Debug tab answer the direct engineering question: "what is the AI agent doing right now, why is it blocked, and what action is the harness allowing next?"

## Changes

- Added `Current Agent Activity` to the Debug tab.
- The panel summarizes:
  - current run status, cycle, and phase
  - latest action
  - next required action while a run is active
  - TodoState done/open counts
  - workspace candidate path, word count, and publish state
  - latest planner decision and reasoning preview
  - latest provider status/duration/error
  - terminal repair reason, deficits, and allowed actions
- Terminal runs no longer show stale "next required" or allowed-action hints after `completed`, `failed`, `blocked`, or `interrupted`.
- Records JSONL now includes sanitized `api_exchange` events for provider, web_search, and read_url calls, so exported records preserve API timing/status/body-shape evidence without secrets.
- Long Task Lab provider timeout is `300_000ms` to cover one slow gateway attempt plus SDK retry during long task experiments.
- Browser provider request normalization now preserves host `timeoutMs` and caller `AbortSignal`, so Long Task Lab deadlines actually reach OpenAI/Gemini provider calls.

## Chrome DevTools Proof

Environment:

- URL: `http://localhost:3001/`
- Browser: Chrome DevTools MCP
- Provider: Custom OpenAI-compatible endpoint `/openai-gateway`
- Model: `gpt-5.4-mini`
- Max steps: `45`
- Auto-approve tier 1: enabled

Observed custom-provider run:

- Pre-fix run failed at `6 / 45`: provider request aborted at about `120.0s`.
- Debug/Records showed the failing provider exchange with request body keys `[model,input]`, body size about `45013` bytes, and `error="signal timed out"`.
- Root cause: `normalizeBrowserProviderRequest()` dropped `timeoutMs` and `signal`, so the Long Task Lab host deadline did not reach the provider adapter.
- After preserving `timeoutMs`/`signal`, the run passed the old 120s failure threshold:
  - C1 provider/planner took `145.6s` and continued.
  - Records later showed a provider call at `125.1s` returning gateway `524`, followed by SDK retry success at `73.4s`.
- After raising the Lab deadline to `300s`, the custom-provider mission completed in `21 / 45` cycles through:
  - `workspace_finalize_candidate`
  - `workspace_read`
  - `workspace_publish_candidate`
- Debug tab showed:
  - `Current Agent Activity`
  - status `completed`
  - `C21 · evaluate`
  - latest action `workspace_publish_candidate`
  - Todo `5 done / 0 open`
  - workspace `final_candidate.md · 385 words`
  - publish state `workspace_publish_candidate`
  - latest provider call `status=200 · 4.5s`
  - LLM req/res `4/4` in the latest debug window
  - API calls `30`
  - provider calls `24`
  - blockers `0`
- Console check after the UI change: no error/warn/issue messages.

## Verification

```bash
node --experimental-strip-types examples/long-task-lab/test/lab-state.smoke.ts
node --experimental-strip-types examples/long-task-lab/test/lab-record.smoke.ts
node test/unit/provider-request.test.js
npm run test:long-task-lab
npm --prefix examples/long-task-lab run build
```

## HBR

- The successful custom-provider run still had one gateway `524` from `/openai-gateway/responses`; the 300s Lab deadline allowed the SDK retry to recover, but the gateway remains slow for heavy prompts.
- The final memo was concise at `385` words, which is acceptable for the preset's "concise memo" wording but not a deep long-form report proof.
- Codeloom hybrid search reported partial embeddings, so Codeloom semantic results may miss newer symbols until the repo embeddings are refreshed.
