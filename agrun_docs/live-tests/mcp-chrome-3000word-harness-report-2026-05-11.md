# MCP Chrome 3000-Word Harness Report Live Test — 2026-05-11

## Goal

Use MCP Chrome DevTools to ask the browser AI agent to generate a
3000-word report about AI agent harness engineering, then verify whether the
output actually satisfies the requested length and quality gates.

## Setup

- App URL:
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-3000word-harness-report&qa_clean=y&qa_auto_approve_tier1=y`
- Browser tool: MCP Chrome DevTools
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- `BROWSER_DEV_AUTOSEED_KEYS=true`

Screenshot:

![MCP Chrome 3000-word harness report result](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/mcp-chrome-3000word-harness-report-2026-05-11.png)

## Prompt

> Generate a 3000-word report about AI agent harness engineering information.
> The report should explain what harness engineering is, why it matters for AI
> agents, architecture patterns, runtime contracts, observability, tool/action
> governance, testing, recovery loops, anti-hardcode principles, and practical
> implementation guidance. Use the long-web-research skill and virtual
> workspace if useful. The final answer must be around 3000 words, not 3000
> characters. End exactly with
> MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE.

## Observed Result

- Run completed in the browser UI.
- Final answer included the marker:
  `MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE`.
- Final answer did not expose internal `TodoState`, workspace action names, or
  `finalReadiness` JSON.
- `selectedSkill=long-web-research`.
- Terminal action: `workspace_publish_candidate`.
- Inspector candidate stats:
  `chars=8947`, `nonWhitespace=7673`, `cjk=0`, `words=1215`.
- DOM `.assistant-prose` count:
  `chars=8185`, `words=1133`.
- Completion ratio:
  - DOM count: `1133 / 3000 = 37.8%`
  - Inspector candidate count: `1215 / 3000 = 40.5%`

## Honest Bad Results

- The task failed the user requirement. The user asked for around 3000 words,
  but the final answer delivered only ~1133 to 1215 words.
- Inspector showed `Research Contract Warning`.
- `read_url` failed again in the browser due to CORS/preflight:
  `Access to fetch at 'https://readurl.yapweijun1996.com/read-url' from origin 'http://127.0.0.1:3331' has been blocked by CORS policy`.
- Network showed:
  `POST https://readurl.yapweijun1996.com/read-url [net::ERR_FAILED]`.
- Inspector showed `READ URL STATUS = error 502`.
- Research gate showed:
  `evidence_gaps:insufficient_relevant_sources,no_strong_source,weak_sources_only`.
- Runtime/AI still declared `finalReadiness=ready` even though source evidence
  was weak and the delivered word count was far below the user's requested
  3000 words.
- Todo progress was stale at terminal; runtime preserved the audit instead of
  forcing completion.
- The live run consumed many Gemini calls and still stopped at ~40% of the
  requested length, which suggests the current lite model + prompt/workspace
  loop does not reliably enforce large word-count targets.

## Verdict

Failed quality gate.

This is a real MCP Chrome live failure, not a unit-test failure. The browser
runtime completed the flow, but the agent did not satisfy the requested output
length and over-declared readiness.

## Follow-Up

1. Fix localhost/browser read_url CORS or route read_url through a same-origin
   proxy so evidence gathering works in browser live tests.
2. Tighten long-research finalReadiness instructions so `ready` is not allowed
   when the requested word count is far above observed workspace stats.
3. Add an AI-first continuation pattern for large requested outputs:
   after `workspace_read`, if `words < requestedWords`, continue expanding the
   workspace candidate instead of publishing.
