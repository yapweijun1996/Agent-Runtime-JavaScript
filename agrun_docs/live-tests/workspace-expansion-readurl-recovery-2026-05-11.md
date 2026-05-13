# Workspace Expansion + read_url Recovery Inspector Review (2026-05-11)

## Context

The MCP Chrome 3000-word harness report run completed through
`workspace_publish_candidate`, but the final candidate was only 1215 words
against a 3000-word request. Inspector showed one failed `read_url` attempt
(`502`), no successful read sources, repeated finalize/publish attempts, and a
final AI readiness declaration that later conflicted with observed state.

## Diagnosis

This was not a single web search failure. The failure pattern had two coupled
causes:

1. `read_url` failure was too passive. The failed source stayed visible as a
   thin/error source, but the AI-facing observation did not explicitly say:
   search for alternate primary/official sources, read a different result, or
   publish with evidence limitations.
2. Workspace revision tools were too narrow for long-form expansion.
   `workspace_replace` required exact text, which is fragile after a draft has
   changed. The AI repeatedly knew the candidate was short, but the easiest
   safe action path was finalize/publish rather than append new sections or
   expand a named Markdown section.

Runtime stats were still observations, not pass/fail gates. The runtime did
not judge content quality or silently mark the run successful; the AI made the
terminal decision. The improvement is to expose better AI-owned action choices.

## Changes

- Added `workspace_append` for appending user-facing draft material without
  rewriting the full candidate.
- Added `workspace_insert_after_section` for expanding a named Markdown section
  without exact-match replacement text.
- Updated publish protocol detection so append/section-insert count as content
  changes and require a fresh `workspace_finalize_candidate` + `workspace_read`
  before publish.
- Updated publish blocker messages to suggest
  `workspace_append` / `workspace_insert_after_section` when observed length is
  below requested length and more material is available.
- Added `read_url` failure recovery hints: refine `web_search`, read an
  alternate high-quality source, retry only when appropriate, and publish with
  honest limitations if no successful reads exist.
- Updated `long-web-research` skill instructions and copied them into the
  browser example skill bundle.

## Verification

- `node test/unit/virtual-workspace.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/read-url-window.test.js`
- `npm run skills:index`
- `npm run skills:copy:browser`

## HBR

This is a unit/contract fix, not yet a real Gemini browser rerun proving the
3000-word report now reaches target length. The old run still remains a bad
result: 1215 words, one failed `read_url`, no successful read sources, and
conflicting final readiness.
