# MCP Chrome 3000-word harness report rerun 3 — 2026-05-11

## Goal

Verify the prompt/skill guidance change from rerun 2:

- custom report paths must be finalized/read/published by the same path,
  or promoted to `final_candidate.md`;
- direct `finalize` is not a publish substitute for long workspace reports.

## Result

- Provider/model: Gemini / `gemini-3.1-flash-lite-preview`.
- Run status: completed in about 1m04s.
- Selected skill: `long-web-research`.
- Terminal path: `planner_finalize`.
- Last workspace action: `workspace_append`.
- Visible answer: 7,194 chars / 1,008 words.
- Required marker: missing from the visible assistant answer.
- Workspace file: `report.md`, version 4, 18,924 chars.
- Workspace candidate: `final_candidate.md` missing, not ready, not published.
- read_url: one browser read failed due CORS / service unavailable, surfaced as 502.
- Research gate: incomplete, with insufficient relevant sources, no strong source,
  and weak/thin evidence only.
- TodoState: stale at terminal, 1/4 done, active item still "Draft report
  structure and content in virtual workspace".

## Finding

The extra prompt/skill wording helped the model expand more (`report.md`
grew from 13,323 chars in rerun 2 to 18,924 chars here), but Gemini Lite
still ignored the publish protocol. Its final readiness declaration claimed
the workspace document was ready and observed length was 3000 words, then
chose direct `finalize`.

This proves the remaining problem is a protocol mismatch, not content
sufficiency:

- AI had a non-candidate workspace artifact (`report.md`) that it believed
  was ready.
- Runtime's existing `workspace_publish_path_required` continuation only
  detected `final_candidate.md` or `draft.md`.
- Because `report.md` was a custom path, the continuation did not fire.
- Runtime allowed direct finalize to proceed, so the finalizer compressed the
  workspace artifact into a short visible answer.

## Fix Applied After This Rerun

Updated `maybeContinueOnWorkspacePublishPath` so the same workspace publish
protocol also detects a custom user-facing draft path. It now finds a
non-empty custom workspace file from recent content operations such as
`write` / `append` / `replace` / section insert, and emits the same
continuation signal:

- use that same custom path for `workspace_finalize_candidate`,
  `workspace_read`, and `workspace_publish_candidate`; or
- copy/promote it into `final_candidate.md` first.

This keeps the harness AI-first: runtime is not deciding whether the report
is good enough or long enough. It only detects that AI chose a terminal route
that cannot publish the workspace artifact it said was ready.

## Evidence

- Screenshot: `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-rerun3-2026-05-11.png`
