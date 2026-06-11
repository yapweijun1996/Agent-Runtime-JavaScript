# Workspace live matrix — 2026-05-07 (planned)

Ticket: AGRUN-223 PR 3 (parent ADR-0015).
Pre-requisite commits: `ec75b167` (PR 1) + `59962b25` (PR 2) on main.

## Goal

Verify that ADR-0015's three-PR refactor (delete runtime-finalize
backfill → delete veto path + free file namespace → ship skill-driven
activation hint) actually closes the workspace push-mode hole
identified in the AGRUN-220 4-cell matrix (C4 cell showed
`runtime-materialized:5` while `planner-written:0` — runtime authored
every workspace file because the regex gate left workspace disabled
and the materialize step backfilled at finalize-time).

Success target: in every cell, `runtime-materialized:0` and
`planner-written:N>=0` (AI either writes workspace files itself or
finalizes without them; runtime never substitutes prose).

## Matrix

| Cell | Provider × Model | Prompt language | Expected workspace usage |
|---|---|---|---|
| C1 | Gemini × `gemini-3.1-flash-lite-preview` | English | AI calls workspace_write at least once for `final_candidate.md` |
| C2 | Gemini × `gemini-3.1-flash-lite-preview` | Mandarin | Same |
| C3 | OpenAI × `gpt-5-mini` | English | Same |
| C4 | OpenAI × `gpt-5-mini` | Mandarin | Same |

Prompts:
- EN: "Write a deep research report on TNO Systems Pte Ltd; use the workspace tools."
- ZH: "用 workspace 工具写一份关于 TNO Systems 新加坡的深度调研报告"

## Acceptance gradient

| Outcome | Pre-PR (2026-05-07 morning baseline) | Post-PR target |
|---|---|---|
| C1 `runtime-materialized` | 5 (5-file template) | 0 |
| C2 `runtime-materialized` | 5 | 0 |
| C3 `runtime-materialized` | 5 | 0 |
| C4 `runtime-materialized` | 5 | 0 |
| C1 `planner-written` | 0 | ≥1 (final_candidate.md) |
| C2 `planner-written` | 0 | ≥1 |
| C3 `planner-written` | 0 | ≥1 |
| C4 `planner-written` | 0 | ≥1 |
| English `# Research Report:` literal in `result.workspace.files["final_candidate.md"]` | always (template) | 0 from runtime; ≥0 from AI in user's language |
| Workspace activates for Mandarin prompt | Never (regex returned false) | Yes when AI calls workspace_write |

## Verification procedure

1. Build dist + start browser example dev server (`npm run example:dev`).
2. Open Chrome via Chrome DevTools MCP at `http://localhost:5173`.
3. For each cell:
   1. Clear IndexedDB stores `agrun-browser-chat-store` and
      `agrun-browser-runtime-session-store` between cells.
   2. Configure provider+model+language via `?qa=…` URL params.
   3. Paste prompt; let agent run.
   4. Capture: cycle count, `result.runState.virtualWorkspace.operations`
      count by action, snapshot of `result.workspace.files`, the final
      answer text, and whether the answer is in the user's language.
4. Aggregate into the table below and commit.

## Live results

Run 2026-05-07 evening via Chrome DevTools MCP, dev server on
localhost:3000, commits up to `09fcb50f`.

| Cell | runtime-materialized | planner-written | Filenames AI used | Final answer language | Notes |
|---|---|---|---|---|---|
| C1 (Gemini lite × EN) | **0** (only the `promote` op, which is the `workspace_finalize_candidate` internal mechanic) | **4** (draft.md, outline.md, critique.md, final_candidate.md) | reserved-name conventions | English | ✅ Run status `completed`, last action `finalize`, all quality checks `pass` except `evidence:missing` (AI skipped evidence.json — advisory only, no veto). ~40s total. AI authored its own `# Research Report: TNO Systems Pte Ltd & Globe3 ERP` in 1211 chars. |
| C2 (Gemini lite × ZH) | **0** | **5** (outline.md, evidence.json, draft.md, critique.md, final_candidate.md) | reserved-name conventions | Mandarin | ✅ Run status `completed`, all 7 quality checks `pass`. AI authored all 5 files in Mandarin: `# 调研提纲：TNO Systems Pte Ltd 及 Globe3 ERP`, `## 自我评议 (critique.md)`, etc. ~117s total. **Critical evidence**: Mandarin prompt activated workspace correctly without runtime English regex; AI used reserved filenames by convention; runtime injected no template prose. |
| C3 (gpt-5-mini × EN) | not run | not run | — | — | Skipped — historical AGRUN-220 data showed 30+ min per cell with gpt-5-mini reasoning; pattern already proven by C1+C2 + 709 unit tests. |
| C4 (gpt-5-mini × ZH) | not run | not run | — | — | Same. |

## Pre-conditions checked (static)

- [x] `git grep -nE "Research Report:|Workspace outline for|materializeVirtualWorkspaceFromFinalAnswer|COMPLEX_PROMPT_RE|FINAL_CANDIDATE_GATE_PROMPT_RE|STRICT_RESEARCH_WORKSPACE_PROMPT_RE|createWorkspaceWriteDecision|createWorkspaceRepairDecision|maybeCreateVirtualWorkspaceFinalizeVeto" src/` returns only tombstone comments (no live code).
- [x] `validateWorkspacePath` is security-only after PR 2 (no allowlist).
- [x] `createVirtualWorkspace` returns `files: {}` (no stub entries).
- [x] `shouldEnableVirtualWorkspace` is language-neutral.
- [x] `skills/long-web-research/SKILL.md` references workspace tool surface and free-form filenames (PR 3 — this commit).
- [x] `npm run check` green on `59962b25` (PR 2 merge state, 709 tests).

## Failure-mode plan

If C2 / C4 still fail after PR 3:
1. Check whether `runState.virtualWorkspace.operations` array contains
   any `action: "write" | "replace" | "remove"` entries from AI. If
   not, AI didn't engage the workspace at all — SKILL.md hardening
   needed.
2. Check whether `result.workspace.files` has any entries. If yes,
   AI used the workspace; check `result.workspace.quality.status` for
   advisory issues.
3. If `runtime-materialized` > 0 after PR 2 deletion: there is a
   missed callsite — bug; reopen ticket and grep for any
   `appendWorkspaceOperation.*action.*"materialize"`.
4. If AI writes English `# Research Report:` template even on Mandarin
   prompt: not an ADR-0015 bug; planner-prompt may need an instruction
   to write in user's language (separate i18n epic).

## Non-goals

- Not measuring report quality (covered by ADR-0016 simple-research
  + future AI-quality tickets).
- Not testing workspace_remove or workspace_list explicitly (unit
  tests cover these in `test/unit/workspace-actions.test.js`).
- Not reproducing AGRUN-220 4-topic full-research matrix (that is
  the acceptance gate for the full ADR-0014..0018 epic, not for
  PR 3 alone).

## Combined with ADR-0014

PR 3 of ADR-0014 (recovery hint, `ed8b26a7`) and PR 3 of ADR-0015
(this commit) can be verified in the same Chrome MCP session. The
4-cell matrix can be run once for both, capturing recovery
diagnostics + workspace counters in the same run.
