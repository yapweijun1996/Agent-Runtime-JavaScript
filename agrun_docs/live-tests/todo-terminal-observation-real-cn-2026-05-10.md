# Todo Terminal Observation Real Chinese Report QA — 2026-05-10

## Goal

Verify the AI-first Todo lifecycle fix with a real Chrome MCP + real Gemini run for:

> 用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告

## Setup

- URL: `http://127.0.0.1:5187/?debug_yn=y&qa=long-cn-todo-terminal-observation-mcp&qa_clean=y&qa_auto_approve_tier1=y`
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Runtime mode: `tool_loop`, planner mode `envelope`
- Auto approval: tier-1 only for `web_search` / `read_url`
- Browser tool: Chrome DevTools MCP

## Findings

The earlier runtime behavior was not AI-first: terminal success called `reconcileTodoStateOnTerminalSuccess` and marked unfinished Todo items as `done`. This hid the real problem: AI sometimes finalized while active Todo items were still unfinished.

The amended behavior records an observation instead:

- Runtime Lifecycle: `Todo/task terminal state observed`
- Debug Index first signal: `Task progress stale after work action`
- Todo Progress: `stale after workspace_write`
- `todoTerminalObservation.status`: `unfinished_at_terminal`
- Runtime cleared the live thread `todoState` so the next user turn is not steered by a stale active plan.
- Runtime did not mark active/pending/blocked Todo items as done.

## Real Run Result

- Run status: completed
- Elapsed: about 1m 30s
- Cycle budget: `21/80`
- Read URL status: `ok 200`
- Read URL attempts: 2
- Usable visible source in final answer: 1
- Research Gate: `active: research contract incomplete`
- Final readiness: `limited`
- AI requirements assessment:
  - `requirementSatisfied=false`
  - `lengthSatisfied=false`
  - `evidenceSatisfied=true`
- Readiness continuation: emitted at cycle 20
- Visible report size from DOM evaluation:
  - CJK chars: about 1214
  - text chars before Sources: about 1817

## Bad Result

The final answer is still not a good 3000-character deep report. AI correctly declared `limited`, but it still finalized with:

- only about 1214 CJK chars visible,
- one visible source link,
- unfinished Todo progress,
- incomplete research contract,
- missing workspace outline/critique artifacts.

This confirms the problem is harness/workflow observability and AI-owned task discipline, not runtime source/length hardcoding.

## Acceptance Result

Passed:

- Runtime no longer fakes Todo completion.
- Inspector clearly exposes the unfinished Todo at terminal state.
- No React console error during the real run.
- AI-first principle is preserved: runtime observes and clears stale live state, but does not decide content sufficiency and does not claim Todo items are completed.

Not passed:

- AI still did not satisfy the end-user 3000-character quality requirement.
- AI did not complete all deep-research-writer workspace artifacts before finalize.

## Verification

Commands:

```bash
node test/unit/todo-state-finalize-sync.test.js
npx tsx examples/browser/test/inspector-debug-report.smoke.ts
npm --prefix examples/browser run lint
```

Chrome MCP checks:

- `Task progress stale after work action`
- `Todo/task terminal state observed`
- `finalReadiness=limited`
- `requirementSatisfied=no`
- `length=no`
- Console contained no runtime React errors.
