# Long Task Lab Default TNO Rerun 2026-05-21

## Scope

Rerun the full Long Task Lab Default-provider TNO 3000-word mission after the workspace publish source-link guard was added.

Prompt:

```text
Create 3000 word of report to introduce the TNO System PTE LTD
```

Target:

```text
http://127.0.0.1:3001/?qa=tno-rerun-source-links-20260521&qa_clean=y
```

## Result

The run completed.

- Status: `Done`
- Runtime cycles: `25 / 140`
- Terminal path: `workspace_publish_candidate`
- Final artifact: `3206 words observed`
- Default gateway: `ok 200`
- Read URL auth: `ok 200`
- LLM request/response: `5/5`
- API calls: `38`
- Provider calls: `26`
- Latest provider call: `200 · 2.8s`
- Workspace: `final_candidate.md · 3206 words`
- Runtime blockers: `1` recovered `publish_block`
- Recovery pressure: `22 recovery, 27 blocked`

## Quality Score

Quality remained `75/100`, not `90+`.

Passed gates:

- Length: `25/25`, `3206 / 3000 words`
- Workspace publish: `20/20`, `workspace_publish_candidate`
- Source links: `15/15`, `5 final URL reference(s)`
- Structure: `15/15`, structure audit passed

Failed gate:

- Evidence: `0/25`, `1 usable, 0 strong sources`; target is `3 usable / 2 strong`

## Source Link Check

The source-link guard worked.

The final artifact included both a References section and a final Sources section. The final artifact contained five URL references:

- `https://www.linkedin.com/company/tno-system-pte-ltd/`
- `https://forum.lowyat.net/topic/5556445/all`
- `https://tnosystem.com.sg/`
- `https://www.tnosystem.com.sg/`
- `https://www.linkedin.com/company/tno-system-pte-ltd/about/`

This confirms the previous source-link failure was fixed. The remaining quality problem is evidence quality, not missing final links.

## Evidence Panel

Observed:

- Queries: `1`
- Reads: `6`
- Usable: `1`
- Strong: `0`

Read source statuses:

- Lowyat forum page: `weak · 200`
- LinkedIn company page: `blocked · 200`
- SGPBusiness company page: `thin · 502`
- `https://www.tnosystem.com.sg/`: `thin · 400`
- `https://tnosystem.com.sg/`: `thin · 400`
- LinkedIn about page: `usable · 200`

## Browser / Network / Secret Checks

Chrome DevTools MCP checks:

- Console had one resource error caused by read_url `400` responses. This is a real evidence-retrieval HBR, not a UI crash.
- Network fetch/XHR summary showed GPT gateway provider calls returning `200`.
- Read URL had successful `200` calls plus failed `400`/aborted source reads.
- Page text contained no `gw_` gateway key pattern.
- Page text contained no `Authorization` / `Bearer`.
- localStorage did not contain gateway/openai key values or API-key fields.

## Honest Bad Result

This rerun proves that the source-link guard is working, but it does not prove report quality is good enough. The output still scored only `75/100` because evidence quality was weak: only one usable source and zero strong sources.

The generated report was honestly cautious, but it was also less useful than the earlier Globe3/TNO Systems-style profile because this run treated the subject as sparse/uncertain and could not verify a rich company profile from strong sources.

The next improvement should target evidence recovery and search diversity, not source-link rendering. The agent repeated narrow search behavior and ended with weak/blocked/thin sources instead of finding enough authoritative company records.

## Verdict

PARTIAL PASS with HBR.

Completion path, word count, structure, and source links passed. Evidence quality failed, so the current output is not good enough for a `90+` quality target.
