// Layer-0 patch/replace next-step suggestion strings, extracted from
// virtual-workspace-actions.js (AGRUN-451 slice 2). Pure functions: each maps a
// replace/patch result shape to the human-readable "what to do next" hint the
// workspace_replace / workspace_propose_patch executors return. Zero imports —
// the whole cluster is closed (no callback into virtual-workspace-actions.js),
// so the two executors import these four back from here.

function buildReplaceVetoedSuggestion(missHints, repeatedFindCount) {
  const base = `This find string has failed ${repeatedFindCount} times in this run — workspace_replace will keep returning not_found. Stop retrying workspace_replace with the same or similar find. `;
  if (missHints && Array.isArray(missHints.anchorMatches) && missHints.anchorMatches.length > 0) {
    return base + "Either re-issue workspace_replace with verbatim text copied from missHints.anchorMatches[*].surroundingText, or switch to workspace_propose_patch with a {type:'replace',find:'<text from surroundingText>',replace:'...'} operation.";
  }
  return base + "Switch to workspace_propose_patch with a {type:'replace',find:'<verbatim text from missHints>',replace:'...'} operation, or use workspace_insert_after_section to add new content under an existing heading.";
}

function buildReplaceNotFoundSuggestion(missHints) {
  if (missHints && Array.isArray(missHints.anchorMatches) && missHints.anchorMatches.length > 0) {
    return "Your find string was not found. Compare it against missHints.anchorMatches[*].surroundingText (verbatim file excerpts) and re-issue workspace_replace with text copied from there.";
  }
  if (missHints && Array.isArray(missHints.bracketLandmarks) && missHints.bracketLandmarks.length > 0) {
    return "Your find string contains bracket text that does not exist in the file. missHints.bracketLandmarks lists the real bracket/heading patterns — pick one and re-issue workspace_replace, or switch to workspace_propose_patch.";
  }
  if (missHints && missHints.documentOutline) {
    return "Your find string was not found and no anchor lines matched. missHints.documentOutline shows the file's real headings and first 240 chars — use them to compose a verbatim find, or call workspace_read for the full file.";
  }
  return "Run workspace_read to refresh your view of the file, then retry workspace_replace with text that appears verbatim in the latest content.";
}

function canAutoApplyWorkspacePatch(result) {
  const operations = Array.isArray(result && result.operations) ? result.operations : [];
  return operations.length > 0 && operations.every((operation) => operation && operation.type === "normalize_headings");
}

function suggestWorkspacePatchNextStep(result, options = {}) {
  if (options.applied && options.applied.changed === true) {
    return "Heading-only patch was validated and applied in this action. Continue from the updated workspace content; do not call workspace_apply_patch for this patchId.";
  }
  if (options.autoApply === true && options.autoApplyEligible !== true) {
    return "applyIfValid only auto-applies heading-only normalize_headings patches. This preview was not auto-applied; inspect the preview and call workspace_apply_patch only if appropriate.";
  }
  const status = result && result.status;
  const operations = Array.isArray(result && result.operations) ? result.operations : [];
  const riskFlags = Array.isArray(result && result.riskFlags) ? result.riskFlags : [];
  const hasInvalidReplaceShape = operations.some((operation) => (
    operation &&
    operation.type === "replace" &&
    (operation.findChars || 0) === 0
  ));
  if (hasInvalidReplaceShape) {
    return "Patch replace operations require non-empty find and replace fields. Do not use replace+content for full rewrites; use append/insert_after_section, or quote exact current text in find and new text in replace.";
  }
  if (riskFlags.includes("ambiguous")) {
    return "A replace or heading match is ambiguous. Use a longer exact find string, pass replace_all:true only when every match should change, or use append/insert_after_section.";
  }
  if (riskFlags.includes("not_found")) {
    return "Patch target was not found. Use text visible in the latest workspace projection/read, or switch to append/insert_after_section.";
  }
  if (riskFlags.includes("content_structure_not_repaired")) {
    return "Heading-only normalization did not repair the content-level structure issue. Merge or remove the duplicate-purpose/body-after-final block with workspace_replace, workspace_write, or workspace_multi_edit before review/publish.";
  }
  if (riskFlags.includes("no_growth")) {
    return "Patch did not grow the candidate or improve structure. Add substantial user-facing content with append/insert_after_section when allowed, or use normalize_headings with lineNumber entries from duplicate_heading_context to repair duplicate headings.";
  }
  if (riskFlags.includes("structure_maybe_worse")) {
    return "Patch may worsen structure. Avoid duplicate headings/section numbers; use append/insert under an existing unique heading or publish limited with concrete structure gaps.";
  }
  if (status === "preview_ready") {
    return "Preview is valid: call workspace_apply_patch with this patchId before finalizing or publishing.";
  }
  return "Revise the patch using valid operation shapes, or use workspace_insert_after_section/workspace_replace when exact replacement is fragile.";
}

export { buildReplaceNotFoundSuggestion, buildReplaceVetoedSuggestion, canAutoApplyWorkspacePatch, suggestWorkspacePatchNextStep };
