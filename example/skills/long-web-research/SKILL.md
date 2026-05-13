---
name: long-web-research
description: Run long-form topic research with iterative search, source reading, evidence tracking, and a final report.
tags: web, search, read-url, research, long-run, report, evidence, citations, topic, investigation
inputTypes: topic, research-question, search-query, url, webpage, article, documentation
---
# Long Web Research

Use this skill when the user asks for deep research, a final report, a market
scan, a literature-style review, a multi-source comparison, or an investigation
that cannot be answered well from one quick search.

This skill is a long-run research harness. Do not treat it as a single
`web_search` call.

Activation:

- When you select this skill, declare `mode: "long_research"` on your first
  plan envelope so the runtime activates the budget gate and gate-signal
  envelope. This replaces lexical-prompt detection: the runtime will not
  guess long-research mode from your prompt text.
- The runtime returns a structured gate signal back to you on each cycle,
  shaped roughly:
  `{ sourceMinimum, authorityCoverage, claimGraph, evidenceGaps,
     budgetStatus, finalMode }`. Read it before deciding the next action.
- The runtime owns mechanism (authority scoring, duplicate detection,
  loop budget) and never writes prose. You own workflow, queries, action
  choice, and the final report text.

Workspace (ADR-0015):

- The virtual workspace is your scratchpad for long-form drafting. Use
  `workspace_write`, `workspace_read`, `workspace_append`,
  `workspace_insert_after_section`, `workspace_replace`,
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

Process:

1. Restate the research topic and define the final report shape.
2. Create a short research plan with 3 to 7 questions or sections.
3. Use `web_search` to discover sources for each section.
4. Use `read_url` for the strongest sources before making source-backed claims.
5. Track evidence by source URL, title, relevance, and what claim it supports.
6. Continue searching if important sections have weak or missing evidence.
7. Prefer primary sources, official docs, papers, filings, standards, or direct
   product pages when available.
8. For handle, username, brand, or personal-profile topics, first try direct
   first-party/owned sources such as the official website, GitHub profile,
   project documentation, and professional profile pages before relying on
   social mirrors or generic directories.
9. If the first search/read pass only finds thin or weak sources, change the
   next query shape instead of repeating it. Try quoted topic, official website,
   GitHub, documentation, LinkedIn/profile, and `site:` targeted searches.
10. If a source cannot be read, say so and either use a better source or mark the
   claim as lower confidence.
11. Keep progress visible during long runs: plan, sources read, gaps, and next
   research step.
12. After `draft.md` exists, read it back and write `critique.md`.
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
    `workspace_replace` would require fragile exact-match text. If evidence is
    exhausted, publish limited only with `evidenceSatisfied: false` and
    concrete `remainingGaps`.
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
      `workspace_insert_after_section` before trying publish again.
    If `publish_attempts_blocked` reaches 3 or more, change the action
    sequence instead of repeating the same write -> finalize -> publish
    loop.
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
