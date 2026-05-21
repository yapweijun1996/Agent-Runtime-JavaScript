# Long Task Lab TNO 3000-Word Report Live Test 2026-05-21

## Scope

Run the Long Task Lab in a real Chrome browser through Chrome DevTools MCP and verify whether agrun can complete this user prompt:

> Create 3000 word of report to introduce the TNO System PTE LTD

This run used the local Long Task Lab dev server at `http://localhost:3001/`, OpenAI provider, model `gpt-5.4-mini`, real local API credentials from `.env.local`, web search enabled, read_url enabled, max steps `140`, and tier-1 auto-approval enabled.

## Result

- Status: `completed`
- Runtime cycles: `22 / 140`
- Latest action: `workspace_publish_candidate`
- Final terminal source: `workspace_publish_candidate`
- Final workspace candidate: `final_candidate.md`
- Inspector workspace word count: `3149 words`
- DOM-extracted final artifact word count: `3150 words`
- Final artifact size: `22170` characters
- Report headings: `17`
- Browser console: no blocking errors or warnings
- Network summary: all OpenAI provider calls returned `200`

The run completed the requested long-form output path and published from the virtual workspace rather than direct planner finalization.

## Chrome DevTools MCP Evidence

The Debug tab `Current Agent Activity` showed the agent moving through real decisions:

1. C3 searched for factual company information with `web_search`.
2. C4 tried `read_url`; the first official source path produced a retryable `502`.
3. C8 still showed source recovery with `1 usable, 3 failed`.
4. C11 entered `workspace_write` with planner reasoning that it needed to recover the length deficit and create a full-length final candidate.
5. C17 attempted finalize but was vetoed by terminal repair/source requirements.
6. C20-C22 completed the workspace terminal path: `workspace_finalize_candidate` -> `workspace_read` -> `workspace_publish_candidate`.

Final Debug values:

- Run status: `completed`
- Cycle / phase: `C22 · evaluate`
- Latest action: `workspace_publish_candidate`
- Next required: `none`
- Workspace: `final_candidate.md · 3149 words`
- Publish state: `workspace_publish_candidate`
- Latest provider call: `status=200 · 1.4s`
- LLM req/res window: `5/5`
- API calls: `34`
- Provider calls: `24`
- Blockers: `0`

## Evidence Quality

The Evidence tab showed:

- Queries: `2`
- Reads: `5`
- Usable: `2`
- Strong: `2`

Strong sources:

- `https://www.companies.sg/business/199700712E/TNO-SYSTEMS-PTE-LTD-`
- `https://sg.linkedin.com/company/tno-systems-pte-ltd`

Failed/thin sources:

- `https://www.tnosystems.com/about-us/` returned thin `502`
- `https://www.tnosystems.com/` returned thin `502`
- `https://www.sgpbusiness.com/company/Tno-Systems-Pte-Ltd` returned thin `502`

The final report honestly cited the two usable sources only.

## Final Artifact Spot Check

The final artifact started with:

> TNO Systems PTE LTD is a Singapore-based enterprise software company best known for its Globe3 ERP suite.

The final artifact ended with references to:

- TNO Systems PTE LTD company profile on LinkedIn
- TNO SYSTEMS PTE. LTD. corporate directory listing on Companies.sg

The content covered company background, Globe3 ERP, industry focus, customer profile, technology and delivery model, geographic footprint, local business relevance, in-house development, ERP value, Singapore context, enterprise software positioning, strengths, limitations, and conclusion.

## Console And Network

Console messages were non-blocking development/browser messages only:

- Vite connected debug logs
- React DevTools informational message
- PWA beforeinstallprompt info
- DOM autocomplete verbose suggestion

Network fetch/XHR:

- `24` OpenAI provider response calls, all `200`
- `2` web search calls, both `200`
- `5` read_url calls recorded as reads in Evidence
- `2` read_url browser requests showed `net::ERR_ABORTED` / 10s timeout while the run recovered and completed

## Honest Bad Result

The run completed and met the requested 3000-word length, but it did not meet the stronger default source target of at least 3 usable reads. The official TNO website paths returned `502` through read_url, leaving the report with 2 strong usable sources. This is acceptable as a completion proof for long-task runtime behavior, but it is not a perfect evidence-quality run.

The prompt said `TNO System PTE LTD`, while public sources and the final report use `TNO Systems PTE LTD`. The agent normalized to the likely company name based on source evidence.

## Verdict

DONE with HBR. Long Task Lab can complete this real 3000-word browser run through workspace publish, and the new inspector made the agent behavior understandable during the run. The main remaining improvement is quality scoring/source recovery, not basic long-task completion.
