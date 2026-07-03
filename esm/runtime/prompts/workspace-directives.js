import { PUBLISH_DIRECT_ACTION } from '../action-names.js';

// ADR-0035 (AGRUN-262) — virtual-workspace planner directives.
// Extracted verbatim from planner-prompt.js buildSystemPromptLines (the
// workspace_write / patch / publish_candidate / review_candidate clusters,
// including the !compact verbose cluster). Every line is gated on the workspace
// action's presence. Host override key: `workspaceDirectives`. Default output
// is byte-identical (locked by test/unit/prompt-snapshot.test.js).

function buildLines$4({ availableActions, compactSystemPrompt } = {}) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const hasAction = (name) => actionDefinitions.some((action) => action.name === name);
  const lines = [];

  // ADR-0033 Part 4 Tier A.5 (B1 + B4 fix) — load-bearing workspace rules for ALL modes
  // including compact. The audit (2026-05-20 evening) identified four load-bearing lines
  // previously gated on `!compactSystemPrompt`:
  //   - workspace_write rule (B1)
  //   - content-length neutrality / 500-char mimicry counter (combined with B1)
  //   - canonical path handling for publish (B4 — root cause of v16 run2 split-file failure)
  //   - read-before-write inspection rule
  //   - publish structural cleanliness rule
  // Verbose lines (textStats explainer, TodoState advisory, recovery hints for rare cases)
  // remain non-compact only — those add noise without affecting lite-tier failure modes.
  if (hasAction("workspace_write")) {
    lines.push("Workspace write rule: use workspace_write ONLY for the first write to a path or a deliberate full rewrite — it REPLACES the entire file, so calling it twice on the same path erases the draft. To expand or improve an existing draft, use targeted edits: workspace_insert_after_section to deepen an existing section, workspace_replace to revise text. The `content` field accepts text of any length; write real, source-grounded prose (typically 200-2000+ characters per call). When a section is thin, web_search/read_url for material before writing — never pad to reach a word count.");
    lines.push("Before writing or appending to an existing path, inspect it once with workspace_read when workspace_read is currently allowed. If terminalRepairState/actionPatternConvergence forbids workspace_read, use visible workspace facts and the allowedActions surface instead.");
    lines.push("Workspace authoring (workspace_write, workspace_replace, workspace_insert_after_section, workspace_apply_patch, workspace_multi_edit) is for deliverables that genuinely need multi-turn work — integrating evidence you still have to gather, revising an existing draft across steps, or self-review before publishing. If you can produce the complete deliverable in ONE response — even a long, multi-section one, like a ~1500-word article from knowledge you already have — answer directly; workspace drafting only adds steps without improving that result. For a simple or direct answer (a single fact, a brief explanation, a quick lookup or search result), likewise finalize directly. Choose workspace authoring only when YOU judge the deliverable cannot be completed well in a single response.");
  }
  if (hasAction("workspace_propose_patch") && hasAction("workspace_apply_patch")) {
    lines.push("When source and length are satisfied but terminal repair still shows structure plus todo deficits, use the listed patch action for heading/section-number repair and sync TodoState with todo_advance/todo_run_next/todo_cancel before publishing. Do not append, insert, write, replace, search, or read unless current allowedActions explicitly require it.");
    lines.push("Workspace patch rule: for risky long-report repair, call workspace_propose_patch first and read status/deltaWords/riskFlags. Valid operations are {type:\"append\",content:\"...\"}, {type:\"insert_after_section\",heading:\"Existing Heading\",content:\"...\"}, {type:\"replace\",find:\"exact current text\",replace:\"new text\",replace_all?:true}, or {type:\"normalize_headings\",headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}. Use normalize_headings alone first for duplicate heading/section-number repair using duplicate_heading_context, duplicate_section_number_context, or section_number_repair_context line numbers. If length is already satisfied and duplicate heading/section-number context is the visible issue, send exactly one normalize_headings operation; do not mix it with replace unless exact current find text is visible and heading-only repair cannot improve structure. The JSON key must be \"lineNumber\" with a numeric value, not \"lineNumber:42\". Do not send {type:\"replace\",content:\"full document\"}; replace without find/replace will be blocked. Only then call workspace_apply_patch for the latest preview_ready patch. If riskFlags include no_growth, not_found, ambiguous, or structure_maybe_worse, change the patch or use workspace_insert_after_section/workspace_replace only when those actions are currently allowed; do not finalize.");
  }
  if (hasAction(PUBLISH_DIRECT_ACTION)) {
    // B4 — canonical path handling. flash-lite v16 run2 wrote 579 words to report.md
    // and 428 words to final_candidate.md (1007 total) but scored only 426 because
    // publish defaulted to final_candidate.md and ignored report.md.
    lines.push("Canonical publish rule: workspace_publish_candidate defaults to `final_candidate.md`. If you drafted in a different path (e.g. report.md), you MUST either (a) pass that same path explicitly to workspace_publish_candidate, or (b) copy/append the content into final_candidate.md before publishing. Content in unpublished paths does not count toward the final answer length.");
    // Publish structural cleanliness (LOAD-BEARING — terminalRepair flags structure deficits)
    lines.push("Before publishing, make the report structurally clean: one coherent title, unique section headings/numbers, no repeated conclusion blocks, no raw user prompt copied into the title. If the workspace shows final_candidate_structure=fail, repair with workspace_read + workspace_replace only when workspace_read is currently allowed; under terminalRepairState hard_veto, follow terminalRepairState.allowedActions and valid limited contract.");
  }
  if (hasAction("workspace_review_candidate")) {
    lines.push("For long-form or research workspace answers, after workspace_finalize_candidate and workspace_read, call workspace_review_candidate before workspace_publish_candidate. This records YOUR self-review; runtime only exposes candidateQualitySignal facts such as stale review, invalid citations, word-count facts, and structure blockers.");
  }

  if (!compactSystemPrompt && hasAction("workspace_write")) {
    lines.push("Virtual workspace tools (workspace_write, workspace_insert_after_section, workspace_read, workspace_replace, workspace_remove, workspace_list, workspace_finalize_candidate, workspace_publish_candidate) provide browser-safe draft artifacts. Filenames are free-form safe paths; the workspace is virtual and does not write real files. Follow standalone-only action metadata when choosing plan versus action envelopes.");
    lines.push("When loopState.virtualWorkspace shows existing files, inspect them with workspace_list or workspace_read before relying on them. The workspace block is read-only state; runtime will not judge draft sufficiency for you.");
    lines.push("Use textStats and workspace quality facts as inputs to YOUR readiness judgment. If a loaded skill gives a workspace workflow, follow the skill's SKILL.md rather than planner-prompt defaults.");
    lines.push("If a TodoState plan exists, keep it synchronized yourself: after completing a phase choose todo_run_next or todo_advance before moving to the next phase, and before any terminal publish/finalize mark completed phases done or honestly blocked/abandoned. Runtime will only observe stale TodoState; it will not mark items done for you.");
    if (hasAction(PUBLISH_DIRECT_ACTION)) {
      lines.push("workspace_publish_candidate publishes the selected workspace candidate directly without a finalizer LLM. Before calling it, satisfy the action contract: finalize the candidate, read back the latest candidate, sync any active TodoState, and include finalReadiness when the action or loaded skill requires it.");
      lines.push("Before publishing a workspace candidate, make the user-facing report structurally clean: one coherent title, unique section headings/numbers, no repeated conclusion blocks, and no raw user request copied into the report title. If Virtual workspace advisory state says final_candidate_structure=fail, repair with workspace_read plus workspace_write/replace/insert_after_section before publishing.");
      lines.push("If you drafted a long answer in a custom workspace path, pass that same path to workspace_finalize_candidate and workspace_publish_candidate, or copy it into final_candidate.md first. Direct finalize asks another model pass to answer from context and may shorten or omit the workspace artifact.");
      lines.push("If workspace_publish_candidate returns continue because finalReadiness conflicts with observed facts, correct finalReadiness and call workspace_publish_candidate again only when the correction is valid and loopState.actionPatternConvergence.terminalCorrectionState/terminalRetryCooldown are not active; do not switch to direct finalize to deliver the workspace report.");
    }
  }

  return lines;
}

export { buildLines$4 as buildLines };
