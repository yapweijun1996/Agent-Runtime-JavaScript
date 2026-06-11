# Long Task Lab Default TNO Source Links 2026-05-21

## Scope

Review the latest Default-provider Long Task Lab TNO Systems 3000-word report result and close the quality gap where the run completed, but the final artifact did not expose canonical clickable source URLs.

Prompt used in the real Chrome DevTools MCP run:

```text
Create 3000 word of report to introduce the TNO System PTE LTD
```

## Chrome DevTools MCP Evidence

Target:

```text
http://127.0.0.1:3001/?qa=default-gateway-3000-live-fixed&qa_clean=y
```

Observed before the source-link fix:

- Status: `Done`
- Progress: `26 / 140`
- Terminal path: `workspace_publish_candidate`
- Final artifact: `3331 words observed`
- Default gateway: `ok 200`
- Read URL auth: `ok 200`
- LLM request/response count: `5/5`
- API calls: `45`
- Provider calls: `29`
- Quality: `75/100`
- Evidence: `2 usable`, `3 failed`
- Browser console: no error, warning, or issue messages

The Debug panel correctly exposed the completed workspace publish path, provider/read_url status, API call volume, and recovered publish blocker. The bad result was visible instead of hidden.

## Implementation

`workspace_publish_candidate` now appends a final `Sources` section when readable research evidence exists and the candidate did not already include canonical source links.

The implementation uses the existing final-response source harness:

- collect final-response sources from `researchContext`
- scope them to evidence URLs when a research evidence loop is active
- fall back to successful `read_url` sources when the final-response source collector cannot infer titles
- return the same URLs in `output.citations`

This keeps the AI responsible for the report content while the harness enforces provenance visibility at the final publication boundary.

The Long Task Lab system directives now also remind the agent to include a final `Sources` or `References` section for source-grounded reports.

## Automated Verification

Additional Chrome DevTools MCP smoke after the fix:

- Target: `http://127.0.0.1:3001/?qa=source-link-smoke&qa_clean=y`
- Page loaded with `Default` selected and model/API-key inputs hidden.
- Debug tab showed `Default gateway`, `Default GW`, `Read URL auth`, LLM/API sections, and `Quality 0/100` on the idle run.
- Evidence tab showed the `Quality Score` gates, including `Source links`.
- Console check for errors/warnings/issues returned no messages.
- Built `dist/` scan found no `gw_` gateway-key pattern.

Passed:

- `node test/unit/workspace-actions.test.js`
- `npm run test:long-task-lab`
- `npm run build:long-task-lab`
- `npm test`
- `npm run build`
- `npm run docs:index`
- `npm run dist:check`
- `git diff --check`
- `task.jsonl` parse check
- secret leak scan against local `.env.local` gateway/read-url keys
- Codeloom reindex and `audit_diff` over the touched source/test files

Focused regression:

- `workspace_publish_candidate` appends `[Globe3 ERP Overview](https://globe3.com/about-us/)` from successful `read_url` evidence when the candidate body has no source section.
- The publish result exposes `output.citations`.

## Honest Bad Result

The exact 3000-word TNO mission was not rerun after this source-link harness fix. The previous real Chrome run proves Default-provider long-task completion, and the focused unit regression proves the deterministic publish-time source append. A fresh full provider rerun would still be useful to measure whether the visible Quality score rises above `75/100` with live evidence conditions.

The previous run still had partial evidence quality: `2 usable` sources and `3 failed` reads. Source links make provenance visible, but they do not magically improve failed upstream source reads.

Root build still reports existing third-party warnings from Rollup/OpenTelemetry top-level `this` rewriting and a `zod` circular dependency. The build exits successfully.

## Verdict

DONE with HBR. The long-task completion path now has a deterministic final-publication guard for source links, so engineers and end users can inspect provenance from the final report instead of digging through Debug or Evidence panels.
