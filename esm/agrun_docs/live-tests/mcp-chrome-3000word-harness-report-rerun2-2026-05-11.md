# MCP Chrome 3000-word harness report rerun 2 — 2026-05-11

## Goal

Verify whether the browser agent can recover from the earlier 3000-word
long-research failure after adding `workspace_append`,
`workspace_insert_after_section`, and read_url recovery guidance.

Prompt used:

```text
Generate a 3000-word report about AI agent harness engineering information. The report should explain what harness engineering is, why it matters for AI agents, architecture patterns, runtime contracts, observability, tool/action governance, testing, recovery loops, anti-hardcode principles, and practical implementation guidance. Use the long-web-research skill and virtual workspace if useful. The final answer must be around 3000 words, not 3000 characters. End exactly with MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE
```

Browser URL:

```text
http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-3000word-harness-report-rerun2&qa_clean=y&qa_auto_approve_tier1=y
```

## Result

- Provider/model: Gemini / `gemini-3.1-flash-lite-preview`.
- Run status: completed in about 51s.
- Selected skill: `long-web-research`.
- Final terminal path: `planner_finalize`, not `workspace_publish_candidate`.
- Visible answer: 8,691 chars / 1,267 words.
- Required marker: missing from the visible assistant answer.
- read_url: browser CORS blocked the Mac mini read_url endpoint; Inspector surfaced `read_url error 502` and `read_url_failed:1/1`.
- Web search: succeeded against Mac mini SearXNG.
- Console: CORS preflight failure for `https://readurl.yapweijun1996.com/read-url`.
- Network: search request returned 200; read_url request failed with `net::ERR_FAILED`.

## Root Cause

The new workspace expansion tools worked. Inspector showed:

- Last action result before finalize: `workspace_append`.
- Virtual workspace file: `report.md`, version 3.
- Workspace report size: 13,323 chars.
- Latest operations: `write report.md`, then two `append report.md`.

The failure is the handoff from workspace draft to final answer:

- AI wrote and expanded `report.md`.
- AI did not call `workspace_finalize_candidate` on `report.md`.
- AI did not read the final workspace stats after append.
- AI did not call `workspace_publish_candidate`.
- AI instead used direct `finalize`, which made a finalizer LLM answer from context and compressed the workspace report down to 1,267 words.

So the core blocker is not that workspace cannot expand. The blocker is
AI path discipline: custom workspace path + direct finalize bypasses
verbatim workspace publishing.

## Secondary Issues

- `read_url` is still blocked in the browser by CORS for the configured Mac mini endpoint. The runtime reports this as 502/read_url unavailable, but Chrome shows the lower-level cause is preflight CORS.
- TodoState was stale at terminal: active item was still "Develop sections on observability, governance, and anti-hardcode principles" with only 2/5 done.
- Research gate remained incomplete: insufficient relevant sources, no strong source, weak/thin evidence only.
- AI declared final readiness as ready even though research gate and output length were not aligned with the user request.

## Fix Applied After This Rerun

No runtime content sufficiency gate was added. The fix keeps AI-first
ownership and clarifies tool mechanics:

- `planner-prompt.js`: when a long answer is drafted in a custom
  workspace path, the AI must pass that same path to
  `workspace_finalize_candidate` and `workspace_publish_candidate`, or copy
  it into `final_candidate.md`; direct finalize may shorten or omit the
  workspace artifact.
- `planner-native-system-prompt.js`: same native-tool guidance.
- `skills/long-web-research/SKILL.md`: custom filenames are still allowed,
  but custom user-facing reports must be finalized/read/published by the
  same path or promoted to `final_candidate.md`. Direct finalize is not a
  publish substitute for long workspace reports.

## Evidence

- Screenshot: `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-rerun2-2026-05-11.png`
