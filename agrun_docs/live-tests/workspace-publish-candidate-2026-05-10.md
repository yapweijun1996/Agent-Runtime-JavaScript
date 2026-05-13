# Workspace Publish Candidate Direct Answer

Date: 2026-05-10

## Issue

User expectation is simple: AI drafts the answer in virtual workspace, reviews the
candidate, then sends that candidate content to the end user. The previous
workflow could still route through `finalize`, which calls the finalizer LLM and
can rewrite, shorten, or otherwise drift from the workspace draft.

This made debugging confusing:

- Inspector could show workspace content and stats, but the final answer might
  come from a different finalizer pass.
- A long-form draft could satisfy the AI's intended answer, then be compressed by
  finalization.
- The runtime had no direct terminal action for "publish this workspace candidate
  exactly".

## Change

Added `workspace_publish_candidate` as a terminal virtual workspace action.

Behavior:

- Reads the selected workspace candidate path, defaulting to the current
  `quality.finalCandidatePath`.
- Emits `control: "complete"` and `kind: "final_response"`.
- Returns the candidate text exactly as the final response.
- Marks `finalAnswerSource` / `terminalizedBy` as
  `workspace_publish_candidate`.
- Skips finalizer LLM rewriting and final-response normalization for this source.
- Preserves candidate path, size, text stats, version, and updatedAt in terminal
  output metadata.

The selected candidate remains AI-owned. Runtime does not decide that the answer
is good enough; it only publishes the candidate AI selected.

## Prompt And Skill Contract

Planner prompts now explain the intended long-form workflow:

1. `workspace_write` / `workspace_replace` drafts and revises.
2. `workspace_read` / `workspace_list` reviews candidate content and text stats.
3. `workspace_finalize_candidate` marks the chosen candidate path.
4. `workspace_publish_candidate` publishes the selected candidate directly when
   it is the exact user-facing answer.

`deep-research-writer` was updated to prefer
`workspace_publish_candidate path=final_candidate.md` after the candidate is
ready. `finalize` remains a fallback only when direct workspace publish is not
available or when the AI intentionally wants finalizer synthesis.

## Inspector

Support Debug Index now includes a visible `Candidate` row:

- selected final candidate path
- candidate readiness
- whether the published final answer came from `workspace_publish_candidate`
- candidate text stats: chars, nonWhitespaceChars, CJK chars, words

This lets debugging answer the key question quickly: "Did the end-user answer
come from the workspace candidate, or did another finalizer step rewrite it?"

## Verification

Passed:

- `node test/unit/workspace-actions.test.js`
- `node test/unit/virtual-workspace.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `npx tsx examples/browser/test/inspector-debug-report.smoke.ts`
- `node test/concerns/planner.test.js`
- `node test/unit/planner-tools-schema.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `npm test`

Final distribution checks were rerun after documentation updates:

- `npm run build`
- `npm run dist:check`
- `git diff --check`

## HBR

This fixes the workspace-to-user publishing path and Inspector visibility. It
does not guarantee the AI will draft enough words, read enough sources, or make a
correct readiness decision. Those remain AI/skill workflow quality issues, not
runtime-owned hardcoded sufficiency gates.
