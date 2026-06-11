# Terminal Retry Cooldown Live QA — 2026-05-15

## Goal

Verify the AI-first terminal retry cooldown implementation with a real Chrome MCP browser run using the 3000-word AI agent harness engineering prompt.

## Environment

- App: `examples/browser`
- URL: `http://localhost:3001/?qa=terminal-retry-cooldown-2026-05-15&debug_yn=y`
- Browser tool: Chrome DevTools MCP
- Provider/model shown by Inspector: `gemini / gemini-3.1-flash-lite-preview`
- Prompt marker: `MCP_CHROME_TERMINAL_RETRY_COOLDOWN_DONE`

## Result

Pass.

The run completed through `workspace_publish_candidate`, not direct `planner_finalize`.

Observed final runtime facts from IndexedDB debug state:

- `runStatus`: `completed`
- `terminalizedBy`: `workspace_publish_candidate`
- `finalReadiness.decision`: `limited`
- `candidateStats.words`: `3105`
- `candidateStats.chars`: `22448`
- `sourceMinimum`: `2/3` read sources, `2/2` relevant sources, `passed=false`
- `requirementsAssessment.lengthSatisfied`: `true`
- `requirementsAssessment.evidenceSatisfied`: `false`
- `requirementsAssessment.requirementSatisfied`: `false`
- `remainingGaps`: non-empty, concrete source coverage gaps
- `maxConsecutivePublishCandidate`: `2`
- `terminalRetryCooldown.blockedTerminalRetryCount`: `0`
- `terminalRetryCooldown.executedPublishCount`: `3`
- `terminalRetryCooldown.consecutiveExecutedPublishCount`: `2`
- Final answer ended with the required marker.

Read sources observed:

- `https://www.c-sharpcorner.com/article/understanding-agent-frameworks-runtimes-and-harnesses-in-modern-ai-systems/`
- `https://www.nxcode.io/resources/news/harness-engineering-complete-guide-ai-agent-codex-2026`

Console check:

- No browser console warnings or errors were found after the run.

## Acceptance Check

- Clean `ready` only when length and source minimum pass: passed. The model did not claim ready while source minimum failed.
- Source shortfall ends as valid `limited`: passed. `evidenceSatisfied=false` and `remainingGaps` was non-empty.
- No `planner_finalize` bypass: passed.
- `maxConsecutivePublishCandidate <= 2`: passed.
- Cooldown visibility: no blocked retry was needed in this run, but support bundle and Inspector smoke tests verify cooldown projection.

## Honest Bad Result

The run still needed approval clicks for `web_search` / `read_url` because the example browser action policy is `ask`. During approval pause, Inspector surfaced Todo progress stale as first signal, which is expected for a blocked long task but can look noisy during manual QA. The final run recovered after approvals and completed correctly.

