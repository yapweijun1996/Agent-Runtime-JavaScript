# Long Task Lab Inspector Debug Review — 2026-05-21

## Goal

Make Long Task Lab usable for testing AI agent ability, not just watching a coarse Trace list. The debug surface must expose the same class of facts that agrun browser Inspector uses: LLM request/response summaries, provider/API request-response summaries, runtime blockers, workspace state, evidence state, and redaction proof.

## Changes

- Added sanitized `apiExchanges` to Long Task Lab runs.
- Wrapped Lab fetch to record API request/response summaries for provider, web_search, and read_url service calls.
- Added Debug Packet Inspector sections:
  - Runtime blockers
  - LLM payload / response
  - API request / response
- Kept raw headers/body out of the UI. The UI stores only body size, JSON keys, model, message/tool counts, response keys, text length, tool-call count, status, content type, duration, and redacted URL.
- Fixed Long Task Lab debug redaction so useful counters like `totalTokens` are not incorrectly redacted as secrets.
- Added a Long Task Lab host timeout of 180s for real long-task provider calls.
- Fixed terminal repair hard-veto behavior for empty candidates: when the final candidate is empty or missing, repair opens workspace creation actions instead of collapsing into an impossible `workspace_publish_candidate` loop.

## Chrome DevTools Proof

Environment:

- URL: `http://localhost:3001/`
- Browser: Chrome DevTools MCP
- Provider: OpenAI
- Model: `gpt-5.4-mini`
- Prompt: short `pong` prompt, maxSteps 12, auto-approve enabled

Observed result:

- The intentionally small maxSteps run failed at `12 / 12`, latest action `finalize`.
- Debug Inspector showed:
  - LLM req/res: `5/5`
  - API calls: `18`
  - Provider calls: `12`
  - Blockers: `2`
  - Runtime blocker: `Action loop exceeded maxSteps without reaching a terminal output.`
  - Terminal repair: `reason=missing_finalize_after_latest_write | deficits=source | allowed=read_url`
- Expanded LLM request row exposed payload metrics such as estimated chars and message/tool counts.
- Expanded provider API row exposed request body summary and response summary:
  - Request body kind `json`, bytes, keys, model, input summary
  - Response status `200`, JSON keys, textChars, toolCallCount
- Console check: no error/warn/issue messages.
- Page secret scan: no `sk-*`, `AIza*`, `Bearer ...`, or raw Authorization value visible.

## Node / Build Verification

```bash
node --experimental-strip-types examples/long-task-lab/test/lab-state.smoke.ts
node --experimental-strip-types examples/long-task-lab/test/lab-trace.smoke.ts
npm run test:long-task-lab
npm --prefix examples/long-task-lab run build
node test/unit/terminal-repair-state.test.js
node test/unit/workspace-actions.test.js
```

## Node.js vs Browser Testing Answer

Node.js can verify the agrun.js runtime contracts: terminal repair, workspace actions, provider timeout derivation, redaction helpers, and Long Task Lab projection logic. It cannot fully prove browser host behavior, real provider transport, IndexedDB state, visual Inspector usability, or UI redaction. For Long Task Lab, both are needed:

- Node tests: fast regression gate for runtime/harness correctness.
- Chrome DevTools E2E: proof that the browser host can observe and debug real AI agent runs.

## HBR

- The quick Chrome run intentionally failed by maxSteps, which proves the new Inspector exposes blockers, but it is not a successful long-task mission.
- Earlier custom provider default mission remained slow and evidence-heavy; after the 180s timeout fix it no longer hit the previous 60s timeout, but it still did not complete before the user redirected the task.
- The API Inspector deliberately does not show raw provider prompt/body or Authorization headers. This is a security tradeoff: enough for debugging shape/timing/status, not enough to replay the exact provider request from the UI.
