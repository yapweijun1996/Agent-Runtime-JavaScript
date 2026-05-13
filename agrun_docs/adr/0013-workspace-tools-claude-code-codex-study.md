# ADR-0013 — Workspace Tools: Five Improvements from claude-code + codex Study

- **Status:** Accepted (2026-05-12)
- **Owner:** AGRUN — workspace tools ergonomics
- **Related:** ADR-0015 (free-form filenames after PR 2), ADR-0023 (harness as tool provider), ADR-0026 (zero residual push-mode), ADR-0027 (debug-only vs agent-projection)
- **Sample basis:** `sample project for study logic/claude-code-source-code-main/src/tools/FileEditTool/*` and `sample project for study logic/codex-main/codex-rs/apply-patch/*`
- **Live evidence:** [agrun_docs/live-tests/workspace-replace-ambiguous-2026-05-12.md](../live-tests/workspace-replace-ambiguous-2026-05-12.md)

## Context

The 9 virtual workspace actions (`workspace_list`, `workspace_read`, `workspace_write`, `workspace_replace`, `workspace_append`, `workspace_insert_after_section`, `workspace_remove`, `workspace_finalize_candidate`, `workspace_publish_candidate`) were AI-first by construction but had four ergonomic gaps versus the production-grade file/patch tools shipped in claude-code and codex:

1. **`workspace_replace` silently replaced every occurrence** of the find text (via `current.split(needle).join(replacement)`). When `find` matched multiple times the AI never learned about it — there was no signal it could read on the next cycle.
2. **No read-before-mutate invariant.** AI could edit existing content from a prior cycle without ever having read it. claude-code's `FileEditTool` enforces this via the `readFileState` cache and rejects edits with `behavior: 'ask'`.
3. **`workspace_insert_after_section` failures were opaque.** When the heading was missing the result was `{ changed: false, status: "not_found" }` with no hint about which headings *did* exist.
4. **`workspace_publish_candidate` output had no audit projection.** The full workspace.operations log was buried in runState and not filtered to the published candidate path, making inspector debugging harder.
5. **Naive find-text matching.** If the AI re-emitted the find string with a trailing newline or smart quotes the match failed with no fallback. codex's `apply_patch` runs a four-pass `seek_sequence()` (exact → rstrip → trim → unicode-normalize).

The audit basis (read-only comparative study, not copy-paste) extracted the *interaction contracts* from claude-code and codex, mapped them to agrun's virtual-memory model, and converted them into 5 additive improvements.

## Decision

Land five additive changes in `src/runtime/virtual-workspace.js` and `src/runtime/actions/virtual-workspace-actions.js`. All five are read-only signals or escalations — runtime never auto-decides for the AI.

### Fix #1 — `workspace_replace` ambiguous + replace_all + fuzzy fallback

- New result shape: `{ changed, status: "ok" | "ambiguous" | "not_found", matchCount, replacedAll, fuzzyMatch, fuzzyAttempted, contextSnippets, file }`.
- Single-match → `status: "ok"`, replaces; multi-match → `status: "ambiguous"`, no mutation, returns `contextSnippets` (≤ 4 entries with `{ lineNumber, offset, context }`); multi-match with `replace_all: true` → replaces all, `replacedAll: true`.
- Fuzzy ladder (in order): `exact`, `trim_trailing_whitespace`, `trim_both_whitespace`, `normalize_quotes` (curly → ASCII, en/em-dash → hyphen), `trim_and_normalize_quotes`. The first hit wins; `fuzzyMatch` reports which pass succeeded.
- Action `argsSchema` gains optional `replace_all: { type: "boolean" }`. Action `output` adds `status`, `matchCount`, `replacedAll`, `contextSnippets`, `fuzzyMatch`, `fuzzyAttempted`, and a `suggestion` string when the path is non-trivial.

### Fix #2 — read-before-mutate preflight gate

- `preflightWorkspaceMutationRequiresRead` replaces `preflightWorkspacePath` on `workspace_replace`, `workspace_append`, `workspace_insert_after_section`.
- Gate semantics: if the file has non-empty content AND `workspace.quality.lastRead.path !== args.path` (or `lastRead.observedAt < file.updatedAt`), preflight throws with a concrete instruction to call `workspace_read` first.
- New files (no existing content) and missing runState (empty context for argument-only validation) skip the gate so existing preflight unit tests stay green.
- To prevent chain mutations from failing the gate, every mutation (`writeWorkspaceFile`, `appendWorkspaceFile`, `replaceWorkspaceFile`, `insertAfterWorkspaceSection`) calls a new helper `syncWorkspaceLastReadToFile(workspace, file)` after it mutates. AI is treated as having "read" the result of its own mutation — the planner prompt also projects the post-mutation file via the workspace prompt block.

### Fix #3 — *(folded into Fix #1)*

The fuzzy fallback ladder is part of the `workspace_replace` rewrite. Not a separate decision.

### Fix #4 — `workspace_insert_after_section` returns `availableHeadings`

- `insertAfterMarkdownSection` returns `{ changed, content, availableHeadings }` regardless of success. `availableHeadings` is `Array<{ level, text, lineNumber }>` in document order, produced by a new pure-observation helper `collectMarkdownHeadings`.
- `insertAfterWorkspaceSection` returns `status: "ok" | "heading_not_found"`, `availableHeadings`, `requestedHeading`, in addition to existing fields.
- Action `output` adds `status`, `availableHeadings`, `requestedHeading`, and a human-readable `suggestion`.

### Fix #5 — `workspace_publish_candidate` output adds `candidateAuditTrail`

- New helper `collectCandidateAuditTrail(workspace, path)` projects `workspace.operations` filtered to the published path, capped at the last 12 entries, returning `Array<{ action, cycle, status, summary }>`.
- Added to both the success envelope (`kind: "final_response"`) and every blocked envelope (`kind: "virtual_workspace_publish_blocked"`).
- Pure projection — no new state, no copy of full file text. Inspector and AI retry both see how the candidate evolved across cycles.

## Alternatives

1. **Keep silent-global-replace; document behavior in skill prompts.** Rejected: relies on AI reading guidance perfectly and never accidentally writing non-unique find text. Production LLMs make exactly this mistake under token pressure.
2. **Adopt codex `apply_patch` hunk format as a new `workspace_patch` action.** Considered. Deferred. Hunk + `@@ context` is strictly more expressive, but adds a tenth workspace action and a mini-DSL for the AI to learn. Revisit if `ambiguous` rate stays high in production telemetry over 6 months.
3. **Auto-retry `workspace_replace` with `replace_all: true` after one ambiguous response.** Rejected: that is exactly the runtime-as-decider anti-pattern ADR-0026 forbids. AI must own the recovery decision; runtime supplies the signal.
4. **Hard-throw on multi-match (instead of `status: "ambiguous"` + counter).** Rejected: throws erase the cycle's state and force the AI to recover from a generic error message. Block-result with status enum + counter mirrors `publishBlockSignal` and lets AI accumulate context.

## Consequences

### Pros
- AI cannot silently corrupt a draft by writing a non-unique find string.
- Mutations against unseen content are caught at preflight (instead of producing a confused diff in `final_candidate.md`).
- Heading-not-found is now diagnosable in one cycle: AI sees the actual heading list and picks one.
- Inspector debug reports gain a per-candidate operation trail without any extra state.
- Fuzzy ladder reduces the "AI emitted find text with extra whitespace" failure class to a logged-and-recovered case (`fuzzyMatch: "trim_trailing_whitespace"`).

### Cons
- Single-match `workspace_replace` still works as before, but multi-match (which previously "worked" silently) now requires an extra cycle: either widen `find` or pass `replace_all: true`. That's one extra LLM round-trip when the AI genuinely meant global replace.
- `argsSchema` for `workspace_replace` gains a `replace_all` field; planner system prompt grows ~80 tokens for the updated guidance. Bounded.

### Risks
- AI on smaller models may treat `status: "ambiguous"` as a hard failure and abandon the workflow instead of retrying with `replace_all: true`. Mitigation: the new `suggestion` field on the action output spells out both recovery paths in plain English; the planner prompt also projects `publishBlockSignal`-style counters when a publish block accumulates, but ambiguous-replace currently has no equivalent counter.
- The read-before-mutate gate could fire spuriously if some other runtime path mutates `file.updatedAt` without going through the mutation helpers. Mitigation: only the four mutation helpers in `virtual-workspace.js` touch `updatedAt`, and each one now also calls `syncWorkspaceLastReadToFile`.

## Rollback

- Revert `src/runtime/virtual-workspace.js` and `src/runtime/actions/virtual-workspace-actions.js` to the pre-2026-05-12 versions; revert the new test cases in `test/unit/virtual-workspace.test.js` and `test/unit/workspace-actions.test.js`.
- No skill manifest or planner prompt change is mandatory; the `replace_all` schema field is additive (existing AI prompts that never set it still work).
- `dist/agrun.js` and the browser bundle will be regenerated by `npm run build`.

## Live evidence

Real OpenAI single-turn (see live-test doc):

| Cycle | Action | Status | Note |
|---|---|---|---|
| 1 | write | ok | Initial draft "alpha beta alpha gamma alpha" |
| 2 | read | ok | reviewed chars=28 |
| 3 | replace | **ambiguous** | model deliberately omitted `replace_all` |
| 4 | replace | ok | **replaced 3 occurrences** — model recovered with `replace_all:true` |
| 5–7 | read / finalize / read | ok | proceeded to terminal |

Model produced final `final_response` (28 chars: `ALPHA beta ALPHA gamma ALPHA`). This is production evidence that the AI *reads and acts on* the new `status: "ambiguous"` signal — not just a unit-test artifact.
