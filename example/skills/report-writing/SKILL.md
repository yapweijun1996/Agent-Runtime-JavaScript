---
name: report-writing
description: Plan, draft, review, and publish long-form reports through TodoState and the virtual workspace without relying on a user-facing canvas.
tags: report, writing, long-form, workspace, draft, review, publish, todo, synthesis, article, memo
inputTypes: report, long-form, article, memo, brief, analysis, synthesis, essay, documentation
requiresPublishReadiness: true
---
# Report Writing

Use this skill when the user asks for a long report, article, memo, essay,
technical write-up, or synthesis that should be built across multiple turns
instead of emitted as one large response.

This skill is portable: it does not depend on browser UI canvas, real file
writes, Node.js, Python, or a specific provider. Use the runtime's TodoState,
evidence actions, and virtual workspace actions when they are available.

## Core Rule

The report content must live in the virtual workspace before it is published.
Do not use direct `finalize` as a substitute for publishing the selected
workspace candidate, because a finalizer pass can shorten or reshape the draft.

Runtime owns tools and observable facts. You own structure, writing judgment,
source judgment, revision decisions, and final report prose.

## Workflow

1. Create or update TodoState for non-trivial reports.
   Use phases like scope, evidence, outline, draft, review, final candidate,
   and publish. Keep TodoState synchronized with `todo_advance` or
   `todo_run_next`; runtime will not mark items done for you.

2. Define the report contract.
   Extract the requested language, target length, audience, required sections,
   evidence needs, and output format. If scope is materially ambiguous, ask for
   clarification before drafting.

3. Write `outline.md`.
   Include the exact section headings, each section's purpose, expected depth,
   and any source or data needed. For a concrete 3000-word request, allocate
   approximate word budgets by section. Treat this as planning guidance, not a
   hard template.

4. Gather evidence when needed.
   If the report depends on current, factual, or external claims, use available
   evidence actions such as `web_search`, `read_url`, or host data tools. Write
   `evidence.json` with usable facts, source URLs or host evidence IDs, failed
   reads, and remaining gaps. Do not invent citations.

5. Draft in `draft.md`.
   Write real user-facing prose in the user's requested language. Long reports
   may be drafted section by section. If the draft is short, expand meaningful
   sections with `workspace_append` or `workspace_insert_after_section` when
   available; otherwise use `workspace_replace` or a deliberate full rewrite.

6. Read back before judging.
   Call `workspace_read` on the current draft or candidate and inspect
   `textStats`. Compare observed length, section coverage, evidence coverage,
   and language against the user's request.

7. Self-review.
   Write `critique.md` with blocking and non-blocking issues:
   unsupported claims, missing sections, thin analysis, duplicate headings,
   conclusion placement, length deficit, source gaps, or formatting problems.
   If there are no blockers, say "no blocking gaps" and list any limitations.

8. Repair locally.
   Use targeted workspace actions for local changes. Prefer structured patch
   tools for heading repair when available. Do not keep replacing the whole
   draft when only one section is weak.

9. Promote the final candidate.
   When the report is ready, write or move the completed report to
   `final_candidate.md`, then call `workspace_finalize_candidate`, read the
   final candidate, and for long-form reports call `workspace_review_candidate`
   when available.

10. Publish from workspace.
    Use `workspace_publish_candidate` with `finalReadiness` based on the latest
    `workspace_read` stats and evidence facts. Use `decision: "ready"` only
    when observable requirements are satisfied. Use `decision: "limited"` with
    concrete `remainingGaps` when length, source, or requirement gaps remain.

## Acceptance Criteria

Before publishing a concrete long report, verify:

- TodoState has no active completed work left unsynchronized.
- `outline.md` exists and matches the requested report shape.
- `draft.md` contains real prose, not promises, placeholders, or planning notes.
- `final_candidate.md` is the exact answer intended for the user.
- The latest `workspace_read` was performed after the latest candidate mutation.
- Observed length is checked against the user request using the right unit
  (`words`, `chars`, or `cjk_chars`).
- Required sections are present with unique headings.
- Evidence-backed claims have real evidence from this run, or limitations state
  what could not be verified.
- `critique.md` or `workspace_review_candidate` records the AI's final
  self-review.
- `workspace_publish_candidate.finalReadiness.requirementsAssessment` is honest:
  no empty `remainingGaps` when observable source, length, or requirement gaps
  remain.

For a 3000-word report, "close enough" is your judgment, but it must be grounded
in `workspace_read.textStats` and the user's tolerance. If the report is still
materially short and useful material is available, expand before publishing. If
evidence or budget is exhausted, publish limited instead of pretending the
requirement was fully satisfied.

## Avoid

- Do not hardcode a universal report template.
- Do not pad with generic filler to hit a length target.
- Do not expose TodoState, workspace internals, runtime traces, or tool JSON in
  the final user-facing report.
- Do not create a user-facing Canvas requirement. The virtual workspace is the
  agent's internal working surface; the host may show it only in inspector or
  debug UI.
