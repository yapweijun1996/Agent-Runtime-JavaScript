# MCP Chrome Long Research Live Test — 2026-05-11

## Goal

Use MCP Chrome DevTools, not a headless script, to run the browser example
against a real provider and inspect the long-research / virtual-workspace /
publish path after AGRUN-217.

## Setup

- App URL:
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-long-research&qa_clean=y&qa_auto_approve_tier1=y`
- Browser tool: MCP Chrome DevTools
- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- `BROWSER_DEV_AUTOSEED_KEYS=true`
- `read_url`, web search, Gemini, and OpenAI keys were present in
  browser settings.

Screenshot:

![MCP Chrome long research result](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/mcp-chrome-long-research-2026-05-11.png)

## Prompt

The prompt asked the agent to use `long-web-research`, research current
developer guidance for OpenAI Responses API and Agents SDK, use web/search
read evidence, write and publish a virtual workspace candidate, recover if
`workspace_publish_candidate` was blocked, and end with
`MCP_CHROME_LONG_RESEARCH_OK`.

Note: due to a manual MCP Chrome input issue, the prompt text was submitted
twice in the same message. This is test noise, but the runtime still completed
the requested long-research workflow.

## Observed Passes

- Run completed in the browser UI.
- `selectedSkill=long-web-research`.
- Final answer source was `workspace_publish_candidate`.
- Final answer included the required marker `MCP_CHROME_LONG_RESEARCH_OK`.
- Final answer was 2833 chars, above the requested 1200 chars.
- Final answer included source URLs and did not expose internal
  `TodoState`, virtual workspace action names, or `finalReadiness` JSON.
- Actions executed:
  `list_agent_skills`, `read_agent_skill`, `todo_plan`, `web_search`,
  `read_url`, `web_search`, `workspace_write`,
  `workspace_finalize_candidate`, `workspace_read`,
  `workspace_publish_candidate`.
- Virtual workspace had `final_candidate.md`, `candidate:ready`,
  `quality.status=ready`, and text stats:
  `chars=2833`, `words=357`.
- Publish protocol passed:
  `finalizedAfterLatestWrite=true`, `readAfterLatestContentChange=true`,
  `readAfterFinalize=true`.
- `publishBlockHistory=[]`: no publish block happened in this run, so
  recovery was not exercised. The model satisfied the publish protocol before
  terminal publish.
- No provider error step and no `action-args-invalid` step were recorded.

## Honest Bad Results

- MCP Chrome console showed:
  `Access to fetch at 'https://readurl.yapweijun1996.com/read-url' from origin 'http://127.0.0.1:3331' has been blocked by CORS policy`
  and `net::ERR_FAILED`.
- Network panel showed the `read-url` POST failed:
  `POST https://readurl.yapweijun1996.com/read-url [net::ERR_FAILED]`.
- Inspector summarized read_url as `error 502`; debug read source showed
  `ok=false`, `status=502`, `textLength=0`.
- Research gate warned:
  `evidence_gaps:insufficient_relevant_sources,no_strong_source,weak_sources_only`.
- `researchFinalizeContract.finalReadiness.decision=ready` even though
  runtime observed `successfulReadUrlCount=0` and research final allowed was
  false. This is an AI self-audit mismatch; runtime recorded it as a research
  contract warning instead of overriding the AI.
- Todo progress was stale at terminal:
  2/3 items were done, item 3 `Finalize and publish candidate` remained
  active, and runtime preserved `todoTerminalObservation` with
  `status=unfinished_at_terminal`.
- Planner initially made two recoverable envelope mistakes:
  it put `read_agent_skill` and later `todo_plan` inside `plan.actions`.
  Runtime rejected both with `skill_mutator_in_plan`, and the model recovered
  by emitting standalone action envelopes later.

## Result

Partial pass.

The MCP Chrome live test proves the browser example can complete the
long-web-research + virtual-workspace + workspace publish path with a real
provider after AGRUN-217. It did not prove publish-block recovery because no
publish block occurred. It exposed three follow-up issues:

1. Fix browser `read_url` CORS/proxy behavior for localhost.
2. Tighten long-research finalReadiness self-audit so `ready` is not declared
   when read_url evidence failed and research gates report weak/thin evidence.
3. Require TodoState completion/sync before terminal
   `workspace_publish_candidate`, or make the terminal warning more visible
   as a failed quality gate.
