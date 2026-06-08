---
name: long-web-research
description: Run long-form topic research with iterative search, source reading, evidence tracking, and a final report.
tags: web, search, read-url, research, long-run, report, evidence, citations, topic, investigation
inputTypes: topic, research-question, search-query, url, webpage, article, documentation
requiresPublishReadiness: true
---
# Long Web Research

Use this skill when the user asks for deep research, a final report, a market
scan, a literature-style review, a multi-source comparison, or an investigation
that cannot be answered well from one quick search.

This skill is a long-run research harness. Do not treat it as a single
`web_search` call.

Hard top rules (read before any action):

- Every run MUST end with `workspace_publish_candidate`. If you ever observe
  `terminalRepairState.budgetState === "exhausted"`, your single next action
  must be `workspace_publish_candidate` — `decision="ready"` only if all
  observable deficits are satisfied, otherwise `decision="limited"` with a
  non-empty `remainingGaps` array naming each deficit. Letting the run hit
  `max_steps_continuation` is always a failure even if the candidate is good.
- Treat `plan` and `web_search` as expensive. Do not call `plan` twice in
  a row without a writing / reading / publishing action in between. Do not
  call `web_search` more than 5 times before calling `read_url` and writing
  the first draft section. If your action history shows ≥3 `plan` calls and
  zero `workspace_write`, switch to drafting immediately.
- Mirror the runtime contract verbatim. `terminalRepairState.requiredRepair`
  and `validPublishContract.validTerminalException` tell you exactly what
  terminal action is valid; use them rather than inventing your own.

Activation:

- When you select this skill, declare `mode: "long_research"` on your first
  plan envelope so the runtime activates the budget gate and gate-signal
  envelope. This replaces lexical-prompt detection: the runtime will not
  guess long-research mode from your prompt text.
- The runtime returns a structured gate signal back to you on each cycle,
  shaped roughly:
  `{ sourceMinimum, authorityCoverage, claimGraph, evidenceGaps,
     budgetStatus, finalMode }`. Read it before deciding the next action.
- The runtime may also expose
  `loopState.researchAcceptanceEvaluator.acceptanceConvergenceSignal`.
  If it says `forbiddenReadiness: "ready"`, you must not emit a clean
  `finalReadiness.decision="ready"` on the next terminal attempt. Either
  continue with targeted `web_search` / `read_url` / workspace expansion,
  or publish `limited` with `evidenceSatisfied: false` and concrete
  `remainingGaps`.
- The runtime owns mechanism (authority scoring, duplicate detection,
  loop budget) and never writes prose. You own workflow, queries, action
  choice, and the final report text.

Workspace (ADR-0015):

- The virtual workspace is your scratchpad for long-form drafting. Use
  `workspace_write`, `workspace_read`, `workspace_append`,
  `workspace_insert_after_section`, `workspace_replace`,
  `workspace_propose_patch`, `workspace_apply_patch`,
  `workspace_remove`, `workspace_list`, `workspace_finalize_candidate`,
  and `workspace_publish_candidate`.
- Filenames are free-form (any safe path; no `..`, no absolute, no
  backslash). The runtime suggests these conventions when the response
  is a research report: `outline.md`, `evidence.json`, `draft.md`,
  `critique.md`, `final_candidate.md`. Use them or pick your own, but
  if you pick a custom user-facing report path such as `report.md`, you
  must pass that same path to `workspace_finalize_candidate` and
  `workspace_publish_candidate`, or copy/promote it into
  `final_candidate.md` before publishing.
- The runtime no longer back-fills empty workspace files from your
  final answer. If you don't author the artifact, it stays empty.
- Quality (`workspace.quality`) is advisory: it reports which
  conventional files are present; it does not block finalize. You
  decide when to call `workspace_finalize_candidate` and finalize.
- Long reports do not need to be generated in one model response. Build
  `evidence.json`, `draft.md`, `critique.md`, and `final_candidate.md`
  over multiple OODAE turns, then publish the selected candidate with
  `workspace_publish_candidate` so the final answer is the workspace
  artifact rather than a shorter finalizer rewrite.
- Direct `finalize` is not a publish substitute for long workspace
  reports. It asks another model pass to answer from context and may
  compress, shorten, or omit the workspace artifact. Use
  `workspace_publish_candidate` when the workspace file itself is the
  answer.
- Before terminal publish, read the selected candidate and compare
  `textStats` against the user's concrete requirements (length, language,
  sections, source count). Runtime reports the stats; you decide whether
  to revise, publish ready, or publish limited.
- When a workspace action returns `lengthProgress`, treat it as the
  current length contract. If `lengthProgress.status` is
  `below_requested`, calculate the remaining gap from
  `remainingLength` and expand the report with enough complete,
  source-grounded paragraphs to materially close that gap. A short note,
  placeholder, or 50-word patch is not useful when the remaining gap is
  hundreds or thousands of words.
- For long reports, use an index-first writing protocol:
  1. After the first useful reads, write `outline.md` with the exact
     section headings and the source URLs that support each section.
  2. Write `draft.md` from that outline. The first draft may cover only
     the first sections, but it must be real user-facing prose, not a
     promise to write later.
  3. Once a draft exists, do not repeat small `workspace_write` rewrites.
     Use `workspace_append` for new sections or
     `workspace_insert_after_section` for targeted expansion.
  4. Size each writing action from `lengthProgress.remainingLength`.
     If 2000+ words remain, add a full section-sized chunk, not a short
     paragraph.
  5. Keep section headings unique. A long report should grow by adding
     planned sections under the outline, not by duplicating headings.
- For risky structure repair, prefer the structured patch contract when
  available: call `workspace_propose_patch`, inspect `status`,
  `deltaWords`, `riskFlags`, `structureBefore`, and `structureAfter`.
  For heading-only `normalize_headings`, set `applyIfValid:true` so the
  validated patch can apply in the same action; call
  `workspace_apply_patch` only when the preview remains `preview_ready`
  and has no blocking risk flags. Valid operations are
  `append{content}`, `insert_after_section{heading,content}`,
  `replace{find,replace,replace_all?}`, and
  `normalize_headings{headings:[{"lineNumber":42,"text":"## 4. Unique Heading"}]}`.
  For duplicate headings or duplicate section numbers shown in
  `duplicate_heading_context`, `duplicate_section_number_context`, or
  `section_number_repair_context`, use exactly one `normalize_headings`
  operation first when length is already satisfied. Do not mix it with
  `replace` unless exact current `find` text is visible and heading-only
  repair cannot improve structure.

Process:

1. Restate the research topic and define the final report shape.
2. Create a short research plan with 3 to 7 questions or sections.
3. Use `web_search` to discover sources for each section.
4. Use `read_url` for the strongest sources before making source-backed claims.
5. Track evidence by source URL, title, relevance, and what claim it supports.
6. Write `outline.md` as a section index once at least one useful source has
   been read. Include the planned section title, target purpose, and supporting
   URLs for each section.
7. Start `draft.md` from the outline before doing more broad search. If an
   important section has weak evidence, mark that section's evidence gap in
   `outline.md` and do targeted search/read for that gap.
8. Continue searching if important sections have weak or missing evidence.
9. Prefer primary sources, official docs, papers, filings, standards, or direct
   product pages when available.
10. For handle, username, brand, or personal-profile topics, first try direct
   first-party/owned sources such as the official website, GitHub profile,
   project documentation, and professional profile pages before relying on
   social mirrors or generic directories.
11. If the first search/read pass only finds thin or weak sources, change the
   next query shape instead of repeating it. Try quoted topic, official website,
   GitHub, documentation, LinkedIn/profile, and `site:` targeted searches.
12. If a source cannot be read, say so and either use a better source or mark the
   claim as lower confidence.
13. Keep progress visible during long runs: plan, sources read, gaps, and next
   research step.
14. After `draft.md` exists, read it back and write `critique.md`.
    If critique has no blocking evidence gap, promote the draft into
    `final_candidate.md`, call `workspace_finalize_candidate`, read
    the candidate stats, and publish it with `workspace_publish_candidate`.
    If your main draft is a custom path such as `report.md`, either use
    that exact path for finalize/read/publish or copy it into
    `final_candidate.md`; do not leave the completed report in a custom
    path and then use direct `finalize`.
    Include `finalReadiness.requirementsAssessment` on publish using the
    latest `workspace_read` stats. If a concrete requested length is unmet
    and evidence can support expansion, revise the workspace candidate instead
    of publishing. Prefer `workspace_append` for new sections or
    `workspace_insert_after_section` for targeted section expansion when
    `workspace_replace` would require fragile exact-match text. Use the
    latest `lengthProgress.remainingLength` to size the expansion across
    the requested sections; distribute the missing words into real
    analysis, examples, pattern details, and caveats backed by the sources
    already read. If evidence is exhausted, publish limited only with
    `evidenceSatisfied: false` and concrete `remainingGaps`.
    Do not keep doing broad search once the draft is substantive and
    ready to be promoted.
13. If `workspace_publish_candidate` is blocked, read the returned
    `status`, `message`, and any workspace advisory facts before the
    next action:
    - `missing_finalize_after_latest_write`: call
      `workspace_finalize_candidate` on the selected candidate after the
      latest write/replace.
    - `missing_latest_workspace_read`: call `workspace_read` on the same
      candidate before writing again or publishing.
    - `readiness_audit_failed`: fix the `finalReadiness` self-audit so it
      matches latest `workspace_read` stats, or revise the candidate. If the
      audit says the candidate is shorter than a requested length and more
      user-facing material is available, continue with `workspace_append` or
      `workspace_insert_after_section` before trying publish again. The
      next workspace mutation should be sized from the observable
      remaining length, not from a generic "add more detail" note.
    - `acceptanceConvergenceSignal` / `forbiddenReadiness=ready`: your
      repeated `ready` decision conflicts with observable acceptance facts
      such as source minimum or Research Gate. Do not retry clean `ready`.
      Continue evidence work, or publish only `limited` with
      `evidenceSatisfied: false` and non-empty `remainingGaps`.
    - `todo_state_not_synced`: call `todo_run_next` or `todo_advance`
      to mark completed work before any terminal action. Do not switch to
      direct `finalize` to escape an unfinished TodoState.
    If `publish_attempts_blocked` reaches 3 or more, change the action
    sequence instead of repeating the same write -> finalize -> publish
    loop.
    If publish is blocked for readiness, length, or TodoState reasons, do
    not replace the publish path with direct `finalize`. Use the blocker
    status as the next OODAE observation: expand with `workspace_append` /
    `workspace_insert_after_section`, gather a named missing source with
    `web_search` / `read_url`, or synchronize TodoState. Only publish
    limited when the remaining blockers are concrete and recorded in
    `requirementsAssessment.remainingGaps`.
14. Use this `finalReadiness` shape for limited publish when the answer is
    short or evidence-thin. Adapt values from the latest `workspace_read`
    and read source facts; do not invent numbers:

    ```json
    {
      "decision": "limited",
      "evidenceMode": "mixed",
      "limitations": "One sentence naming the concrete blocker.",
      "requirementsAssessment": {
        "checkedReadinessAgainstUserRequest": true,
        "checkedReadUrlEvidence": true,
        "checkedWorkspaceStats": true,
        "evidenceSatisfied": false,
        "lengthSatisfied": false,
        "observedLength": 1200,
        "observedLengthUnit": "words",
        "requestedLength": 3000,
        "requirementSatisfied": false,
        "successfulReadUrlCount": 2,
        "userRequirementSummary": "One-line user request summary",
        "remainingGaps": [
          "Could not read primary source after repeated failures",
          "Need more detail for section X but no usable source was available"
        ]
      }
    }
    ```

    Use the same length unit the user requested (`words` for word-count
    requests, `chars`/`cjk_chars` for character-count requests).
    `remainingGaps` is required when `observedLength < requestedLength`
    and you publish as `limited`. If evidence is truly exhausted, set
    `evidenceSatisfied: false` and list concrete blockers. Do not set
    `evidenceSatisfied: true` while the candidate is short and
    `remainingGaps` is empty.
15. End with a structured report you author yourself, in the user's
    language: executive summary, findings, evidence table, risks or
    caveats, and recommended next steps. The runtime no longer compiles
    a fallback report; if you do not write one, the user gets nothing.
    Use the gate signal's `finalMode` to decide depth:
    `full_report` means produce the full report;
    `final_with_limitations` means produce the best answer possible and
    clearly disclose evidence limits; `needs_more` means continue
    researching unless budget is exhausted.

Budget-exhaustion exit (mandatory):

- Every workspace mutation observation includes
  `terminalRepairState.budgetState`. When that value becomes `low` or
  `exhausted`, treat the next OODAE cycle as your last productive turn.
- When `terminalRepairState.budgetState === "exhausted"`, do NOT continue
  `plan` / `workspace_read` loops and do NOT keep rewriting the same
  candidate. Issue exactly one terminal action that matches the observable
  deficits:
  - If `activeDeficits` contains only `length` (or `length` + `todo` /
    `readiness`) and source + structure are satisfied, issue
    `workspace_publish_candidate` with
    `finalReadiness.decision="limited"`, `lengthSatisfied: false`,
    `requirementSatisfied: false`, and a non-empty
    `remainingGaps=["length deficit: observed X / requested Y words"]`.
    A short-but-honest limited publish is the correct exit, not silent
    timeout.
  - If `activeDeficits` contains `structure`, do ONE coherent
    `workspace_propose_patch` with `applyIfValid:true` and
    `normalize_headings` using the exact line numbers in
    `duplicate_heading_context`,
    `duplicate_section_number_context`, or
    `section_number_repair_context`. Call `workspace_apply_patch` only if
    the preview is valid but was not already applied. If patch tools are
    unavailable, do one coherent `workspace_write` or
    `workspace_replace` that rewrites the candidate with explicit unique
    heading text and unique section numbers. Do not append more sections,
    do not run more searches, and do not loop on `workspace_read`. Treat
    this as your single repair attempt; if the structure audit still
    fails after one repair, publish limited with
    `remainingGaps=["structure audit failed: <issueCodes>"]` instead of
    burning more cycles on another rewrite.
  - If source and length are already satisfied and the remaining deficits
    are structure plus TodoState, use only the listed structure patch
    action and TodoState sync actions. Do not append, insert, rewrite,
    replace, search, or read unless `allowedActions` explicitly requires
    it. Use `todo_advance` / `todo_run_next`, or `todo_cancel` for stale
    plan items, before the publish attempt.
  - If `activeDeficits` contains only `source`, the run already exhausted
    budget without enough sources; publish limited with
    `evidenceSatisfied: false` and `remainingGaps=["source minimum unmet:
    readSources=X, relevantSources=Y"]`.
- Use `terminalRepairState.requiredRepair` and
  `validPublishContract.validTerminalException` verbatim as the
  contract for your terminal action. The runtime already lists what
  terminal action is valid; mirror it instead of inventing one.
- A `terminalizedBy: max_steps_continuation` outcome is always a harness
  failure. If you ever see `budgetState === "exhausted"` and you still
  hold a publish slot, publish limited rather than letting the run hit
  max steps.

Rules:

- Use runtime actions such as `web_search`, `read_url`, and TodoState progress
  actions when available. Do not hardcode external HTTP calls inside the skill.
- Do not invent citations. Every source-backed claim needs a source URL that was
  discovered or read during the run.
- Do not expose API keys, provider payloads, raw tool arguments, or private
  runtime traces in the report.
- If the task needs current information, include the research date in the final
  report.
- If the user asks for a short answer, use `web-research` instead of this skill.
