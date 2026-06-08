---
name: deep-research-writer
description: Iterative research-write-verify loop for fact-grounded long-form reports. Length follows evidence depth, not a fixed target.
tags: research, deep-research, report, fact-check, iteration, long-form, evidence, citations, verify, cross-reference
inputTypes: research-report, research-question, topic, deep-analysis, comparison, market-scan, profile, brief
requiresPublishReadiness: true
---
# Deep Research Writer

Use this skill whenever the user asks for a report, article, analysis,
brief, or comparison that should be grounded in public information.
Single-shot answers under-deliver on this kind of request because they
satisfice without verifying. Use this LOOP instead.

The process is a LOOP, not a sequence. Re-enter any phase at any time.
Length is not evidence, but a concrete length request is still a user
requirement. Evidence controls what you may safely say; if evidence is
rich enough, meet the requested depth instead of stopping early.

## Activation

When you select this skill, declare `mode: "long_research"` on your
first plan envelope so the runtime activates the budget gate.

If you create a todo plan, keep it synchronized with the work you have
actually completed. After finishing a phase, call `todo_advance` or
`todo_run_next` before moving on. Do not leave Phase A active while you
are already searching, reading, drafting, or finalizing.

Use the workspace as the long-answer memory. A strong run leaves a
debuggable packet:

- `questions.md`: what you decomposed.
- `evidence.json`: usable facts, successful source URLs, failed/thin
  reads, and remaining gaps.
- `outline.md`: the report index. Each section has a purpose, planned
  title, and supporting source URLs.
- `draft.md`: the full working report.
- `critique.md`: your self-review, even if the result is "no blocking
  gaps".
- `final_candidate.md`: the exact answer to publish.

Do not skip these artifacts for a concrete long report unless the user
explicitly asked for a shorter direct answer. The runtime will not
create missing artifacts or advance TodoState for you.

If the planner context exposes
`loopState.researchAcceptanceEvaluator.acceptanceConvergenceSignal`,
read it before any terminal action. When it forbids clean `ready`, do
not repeat `finalReadiness.decision="ready"`. Continue with targeted
`web_search` / `read_url` / workspace revision, or publish only
`limited` with `evidenceSatisfied: false` and concrete non-empty
`remainingGaps`.

## Process

### PHASE A — Decompose the question

- Read the user's prompt carefully. Extract every concrete sub-question
  whose answer (taken with the others) would fully answer the user's
  request.
- Write the list to `workspace_write questions.md`. One sub-question
  per line. No fixed count — some prompts need 3 questions, some need
  15.
- If the user's prompt is ambiguous on scope (which entity, which
  jurisdiction, which time window), ask via `ask_clarification` before
  proceeding.

### PHASE B — Research each sub-question

For each open sub-question:

- Run `web_search` with the most direct query you can write.
- Treat `web_search` as lead generation, not evidence. For deep
  research, do not use a `web_search`-only plan as the final synthesis
  when `read_url` is available and search results contain readable
  candidate URLs. Choose `read_url` in a later step so you can inspect
  page content before writing the final report.
- If the first pass returns thin or off-topic snippets, re-query with
  a different shape (quoted exact phrase, official-website hint,
  domain-targeted `site:` search, alternate spelling, the entity's
  native-language form).
- `read_url` on the strongest 2-3 candidates per question. Prefer:
  primary sources (official websites, registries, filings, papers,
  standards), reputable independent media, owner-controlled domains.
  Avoid: paid profiles, unsourced aggregators, advertorials.
- A failed or empty `read_url` is not evidence. If a read fails, pick
  another candidate or change the query shape before drafting from that
  claim. Do not put failed-read URLs in `evidence.md` as supporting
  sources.
- Do not stop after a single failed or thin source when search results
  still contain plausible alternatives. Try at least two different
  source types when available: official/product pages, independent
  analysis, standards/research papers, reputable news, or direct blog /
  documentation pages.
- After each search/read batch, update the workspace before doing more
  research. Write what you learned, which URLs were readable, which
  reads failed or were thin, and which concrete gaps remain. Do not run
  long chains of `web_search` / `read_url` while `evidence.json`,
  `draft.md`, and `final_candidate.md` stay empty.
- Before starting another search/read batch, name the exact evidence gap
  it is meant to close. If you cannot name a gap that would materially
  improve the report, move to drafting with an honest Limitations
  section instead of continuing research for its own sake.
- Once `evidence.json` contains usable facts from successful reads or
  clearly labeled search-summary evidence, your next phase is drafting.
  Write `draft.md` before doing more broad search. Use Phase E critique
  to decide whether another targeted research pass is needed; do not keep
  searching while no draft exists.
- Write evidence to `workspace_write evidence.json` (or
  `workspace_replace evidence.json` if it already exists). Use a JSON
  object with a `facts` array; each fact should include `claim`,
  `source`, and `answers`. This matches the runtime workspace quality
  convention and avoids a false "evidence missing" warning.
- If no `read_url` succeeds but search produced useful leads, still
  write `evidence.json` with `facts: []`, `candidateSources`,
  `failedReads`, and `remainingGaps`. This makes the limitation visible
  to Inspector and to your later readiness judgment.

### PHASE C — Cross-reference (fact-check)

Before writing any claim into your draft:

- Look up the claim in `evidence.json`. If 2+ independent sources back
  it, mark it "verified".
- If only 1 source: mark "reported by <source>; not independently
  verified".
- If 0 sources: do NOT write the claim. Either go back to Phase B and
  search more, or omit the claim.

### PHASE D — Draft

- Decide structure based on what your evidence supports — not a fixed
  section count. Some topics need 3 sections, some need 8, some need
  a flat narrative.
- Before long-form drafting, write `workspace_write outline.md` with the
  section index: heading, role in the report, source URLs, and any gap.
  This is your map for the draft. Do not keep broad-searching when you
  already have enough evidence to create the index.
- Start drafting as soon as you have enough usable evidence to answer
  the main request, or when further source work is not producing better
  evidence. You can revise the draft later; do not wait for perfect
  evidence while workspace remains empty.
- Write to `workspace_write draft.md` in the user's language.
- If the user gave a concrete length and `lengthProgress` says the draft
  is short, continue section-by-section from `outline.md`. Use
  `workspace_append` to add complete new sections or
  `workspace_insert_after_section` to expand a thin section. Avoid
  repeating small `workspace_write` rewrites that replace the whole draft
  without materially closing the length gap.
- If the draft is long enough but structure audit reports duplicate
  headings or duplicate section numbers, prefer `workspace_propose_patch`
  before direct replacement. Use exactly one
  `normalize_headings{headings:[{"lineNumber":42,"text":"## 4. Unique Heading"}]}`
  operation with line numbers from `duplicate_heading_context`,
  `duplicate_section_number_context`, or `section_number_repair_context`,
  set `applyIfValid:true`, and inspect `structureBefore` /
  `structureAfter`. Call `workspace_apply_patch` only when the preview is
  valid but was not already applied. Do not mix this with `replace`
  unless exact current `find` text is visible and
  heading-only repair cannot improve structure.
- Stop when each evidence line has a place. Do not pad with unsupported
  filler, but do use all supported section material when the user asked
  for a long concrete length.
- Cite inline by pointing at source titles or domain names so the
  reader can trace back; the explicit Sources list comes later.
- After writing `draft.md`, read it back with `workspace_read` and
  inspect `textStats`. If it broadly answers the prompt and is close to
  the requested depth, move to Phase E then Phase G. Do not keep doing
  broad search just because budget remains.

### PHASE E — Self-review

Read your own `draft.md`. Write `workspace_write critique.md` listing
its weak points:

- Claims without source coverage.
- Sub-questions from `questions.md` that the draft does not answer.
- Sections that feel thin compared to user expectations.
- Inconsistencies between sources.
- Logical gaps a reader would notice.

If `critique.md` is empty, proceed to Phase G. Otherwise Phase F.
If `draft.md` already exists and broadly answers the user's request,
your next step is Phase E self-review or Phase G candidate publishing,
not another broad `web_search`. Only return to research when critique
names a specific blocking evidence gap.
If `draft.md` already meets or nearly meets a concrete length/depth
requirement and critique has no blocking evidence gap, promote the draft
to `final_candidate.md` immediately. More search is lower priority than
publishing the polished workspace candidate.
If there are no blocking issues, still write `critique.md` with a short
"no blocking gaps" note plus any non-blocking limitations. This gives
Inspector a concrete checkpoint.

### PHASE F — Iterate

For each item in `critique.md`:

- If it is a missing source: go back to Phase B for that sub-question.
- If it is an unverified claim: go back to Phase C.
- If it is a structural gap: prefer `workspace_propose_patch` /
  `workspace_apply_patch` with `normalize_headings` for duplicate heading
  or duplicate section-number repair. For heading-only repair, include
  `applyIfValid:true` in `workspace_propose_patch` and call
  `workspace_apply_patch` only if the valid preview was not already
  applied. If patch tools are unavailable or the structure problem
  requires more than heading-line repair, revise `draft.md` via
  `workspace_replace` or rewrite via `workspace_write`.
- After updating, run Phase E again.

Keep iterating until critique.md has no blocking items, OR evidence
is genuinely exhausted. Evidence is exhausted by your judgment, not by a
magic number. It means additional search/read work is no longer likely
to materially improve the answer because you already tried meaningfully
different query/source types, captured which reads failed or were thin,
and can name the remaining public-information gaps.

When evidence is exhausted with gaps, that is OK — you will declare
the gaps in Phase G and use a limited readiness decision.

### PHASE G — Finalize

Pre-finalize blocking checklist (run through every time; do not skip):

1. **`final_candidate.md` exists with the user-facing report.** If
   `final_candidate_status=missing` / `empty` / `chars=0`, you must
   `workspace_write final_candidate.md` first. Never finalize from the
   `finalize` answer body alone.
2. **`successfulReadUrlCount=0` is not "evidence exhausted" by itself.**
   If web_search returned candidate URLs and zero `read_url` succeeded,
   try `read_url` on at least 2 different unread candidates (different
   domains / source types) before declaring `limited`. A single batch of
   502/404/network errors does not count as exhaustion. Only declare
   exhaustion after meaningfully different attempts.
3. **TodoState items reflect what you actually did.** If `todo_progress`
   is `stale_after_work` (you finished work but the active item still
   shows `active` / `pending`), call `todo_run_next` or `todo_advance`
   before any terminal action. Do not let the runtime annotate
   unfinished items with `terminatedAt` because you skipped progress
   updates.
4. **Prefer `workspace_publish_candidate` over `finalize`.** When
   `final_candidate.md` is the answer, use publish; reserve `finalize`
   for the fallback path described below.

If any of #1–#3 is violated, do not finalize. Go back to the relevant
phase first.

Then make an explicit AI-owned readiness decision:

- If `readSources` has no successful `read_url` result and web search
  returned candidate pages, prefer `read_url` on the strongest unread
  candidate. If that read fails, try a different domain or source type
  before finalizing.
- If `readSources` has zero successful reads and you choose to stop,
  write a normal user-facing answer with an explicit Limitations section.
  Say that the answer is based on search summaries / failed read attempts
  only, and do not present unsupported market figures as verified facts.
- If the only sources are thin, failed, or single-source, you may still
  finalize only with `finalReadiness.decision="limited"` and a
  Limitations section that names the exact evidence limit.
- If the evidence is enough for the requested depth, finalize with
  `finalReadiness.decision="ready"`.
- If you decide not to read more, say why in the report's Limitations
  section (for example: search-result-only evidence, public source access
  limits, repeated `read_url` service failures, or time/budget tradeoff).
- If workspace files exist, use `workspace_list` or `workspace_read` when
  you need to review your own outline, evidence, draft, critique, or final
  candidate before deciding.
- If the draft is not ready, continue with `web_search`, `read_url`,
  `workspace_write`, or `workspace_replace`.
- If the draft is ready, write `final_candidate.md`, mark it ready with
  `workspace_finalize_candidate`, read it back, inspect its text stats,
  then publish it with `workspace_publish_candidate`.
- If a TodoState plan exists, update it before the terminal publish:
  mark completed phases done with `todo_run_next` / `todo_advance`; mark
  skipped phases blocked or abandoned only when you truly stopped because
  evidence was exhausted or the user constraint cannot be met. Do not
  publish while Phase A is still active unless Phase A is genuinely the
  only completed work.
- If `draft.md` is already the full user-facing report, use
  `workspace_write final_candidate.md` with the polished draft content
  instead of asking the finalizer to rewrite it. The publish path should
  send workspace content, not a newly compressed answer.
- Never treat the `finalize` answer body as a substitute for
  `final_candidate.md`. The final candidate must exist in the virtual
  workspace, contain the user-facing report, be marked ready, and be
  read back before publishing.

- `workspace_write final_candidate.md` with:
  - Direct answer to the user's request, in their language, structured
    by what evidence supports.
  - Inline references to sources where claims rest.
  - A "Limitations" section if any sub-question stayed unanswered or
    if any claim was single-source.
  - A "Sources" list with every URL you actually read in Phase B.
- `workspace_finalize_candidate path=final_candidate.md`.
- `workspace_read path=final_candidate.md` and check `textStats`:
  - For Chinese/Japanese/Korean `字` requests, use `cjkChars` and
    `nonWhitespaceChars`.
  - For English-style word-count requests, use `words`.
  - Compare the stats against the user's concrete requirement yourself.
    This comparison belongs to you, not runtime.
  - If the candidate is much shorter than the requested length but
    evidence supports more, revise instead of finalizing.
  - If it is shorter because evidence is thin, finalize only as
    `limited` and state the length/evidence limitation.
  - If `requirementsAssessment.requirementSatisfied` would be false and
    evidence is not exhausted, do not finalize. Continue with
    `web_search`, `read_url`, `workspace_write`, or `workspace_replace`.
  - If evidence is exhausted, finalize as `limited` and make
    `requirementsAssessment` honestly explain what is unmet.
- If the runtime returns a `readiness_continuation_signal` observation
  after you tried to finalize, treat it as a request to continue the
  OODAE loop, not as permission to repeat the same final answer:
  - Immediately `workspace_read final_candidate.md` again and inspect
    `textStats`.
  - If `declaredUnsatisfied` includes `length` or `requirement` and
    evidence supports more detail, revise/expand `final_candidate.md`
    with `workspace_append`, `workspace_insert_after_section`, or
    `workspace_replace` before any next terminal action.
  - If `declaredUnsatisfied` includes structure and the observation shows
    `duplicate_heading_context`, `duplicate_section_number_context`, or
    `section_number_repair_context`, use `workspace_propose_patch` with
    `applyIfValid:true` and one `normalize_headings` operation. Call
    `workspace_apply_patch` only for a valid preview that was not already
    applied before trying another terminal action.
  - If source and length are satisfied but the remaining deficits include
    both structure and TodoState, use the listed structure patch action
    and sync TodoState with `todo_advance` / `todo_run_next`, or
    `todo_cancel` for stale plan items. Do not append, insert, write,
    replace, search, or read unless `allowedActions` explicitly requires
    it.
  - If `declaredUnsatisfied` includes `evidence`, continue searching or
    reading unless evidence is genuinely exhausted by the Phase F rules.
  - If you still finalize as `limited`, explicitly state why no more
    useful expansion or evidence gathering is possible.
  - Do not leave `requestedLength`, `observedLength`, or
    `observedLengthUnit` null when the user gave a concrete length and
    `workspace_read` returned usable `textStats`.
  - If `final_candidate.md` is missing or empty, write it first; do not
    publish or finalize from memory or from a prose instruction field.
- Preferred terminal step: call
  `workspace_publish_candidate path=final_candidate.md`. This sends the
  selected workspace candidate directly to the user without a second
  finalizer LLM rewrite. The candidate content itself must include any
  needed Limitations and Sources sections.
- If `workspace_publish_candidate` is blocked for readiness, length, or
  TodoState sync, do not switch to direct `finalize` to escape the block.
  Treat the block as the next observation: expand the workspace candidate,
  gather the named missing evidence, correct `requirementsAssessment`, or
  call `todo_run_next` / `todo_advance` before trying publish again.
- If an acceptance convergence signal says `forbiddenReadiness=ready`,
  the next terminal attempt cannot be clean `ready`. You must either do
  more evidence/workspace work, or explicitly publish `limited` with
  `evidenceSatisfied: false` and non-empty `remainingGaps`.
- For research/report publish, include `finalReadiness` on
  `workspace_publish_candidate` with `requirementsAssessment` populated
  from the latest `workspace_read final_candidate.md` stats. If the
  candidate is below the user's concrete length/depth requirement and
  evidence supports expansion, revise before publish. Do not publish a
  limited answer while also declaring `evidenceSatisfied: true` and
  `remainingGaps: []`; that means you have enough material to expand. If
  evidence is exhausted, publish only with `decision: "limited"`,
  `evidenceSatisfied: false`, concrete `remainingGaps`, and
  `lengthSatisfied: false` / `requirementSatisfied: false`.
- Do not choose `finalize` after `workspace_finalize_candidate` when
  `workspace_publish_candidate` is available and `final_candidate.md`
  already contains the exact answer. `finalize` is only the fallback path
  when publish is unavailable or the workspace candidate is not the
  answer.
- Fallback only if `workspace_publish_candidate` is unavailable: use
  `finalize` with the body of final_candidate.md as the answer and an
  explicit readiness declaration:
  - Ready: `finalReadiness: { "decision": "ready", "evidenceMode":
    "read_sources", "limitations": "", "requirementsAssessment": {
    "userRequirementSummary": "summarize the user's concrete output
    requirements", "requirementSatisfied": true, "lengthSatisfied":
    true, "evidenceSatisfied": true, "requestedLength": null,
    "observedLength": null, "observedLengthUnit": "cjk_chars|words|chars",
    "successfulReadUrlCount": 0, "summary": "why this is ready" } }`
  - Limited: `finalReadiness: { "decision": "limited", "evidenceMode":
    "search_summary_only" | "mixed" | "read_sources", "limitations":
    "Only search summaries / failed read_url attempts / one readable
    source were available; the report names these limits.",
    "requirementsAssessment": { "userRequirementSummary": "summarize
    the user's concrete output requirements", "requirementSatisfied":
    false, "lengthSatisfied": false, "evidenceSatisfied": false,
    "requestedLength": null, "observedLength": null,
    "observedLengthUnit": "cjk_chars|words|chars",
    "successfulReadUrlCount": 0, "remainingGaps": ["state the real
    gaps"], "summary": "why this is limited" } }`

## Rules

- Length follows evidence. Rich evidence → long report. Thin
  evidence → short report + disclosed limitations. If the user asked
  for a long concrete length and your evidence supports only a shorter
  report, write the shorter evidence-backed report and say so. Do not
  invent sections to hit length.
- In the readiness JSON examples above, `requestedLength` and
  `observedLength` are shown as `null` only as placeholders. Replace
  them with numbers whenever the user gave a concrete length and
  `workspace_read` gave you `textStats`.
- You, the AI, decide `requirementsAssessment`. Runtime only records and
  displays it with raw `textStats` / `read_url` counts. Do not rely on
  runtime to decide whether the answer meets length, evidence, or depth
  requirements.
- Never invent citations. Every source URL must come from a successful
  `read_url` you ran in this run.
- Search-result URLs may appear only in a clearly labeled "candidate
  sources not fully read" note. Do not list them as verified Sources
  unless `read_url` succeeded.
- Never claim a single-source fact as verified. Mark it "reported by
  <source>; not independently verified".
- Use the user's language throughout.
- The runtime no longer back-fills workspace files. If you do not
  write final_candidate.md, the user gets nothing.
- If 2+ sources contradict each other on the same fact, present both
  and disclose the contradiction; do not pick a winner without
  evidence.
- Workspace tools are filename-free-form (any safe path). Reserved
  conventions (questions.md, evidence.json, draft.md, critique.md,
  final_candidate.md) are convention-only; pick clearer names if your
  topic needs them.
- Quality (`workspace.quality`) is advisory; runtime never blocks
  finalize. Decide for yourself when the report is ready.
