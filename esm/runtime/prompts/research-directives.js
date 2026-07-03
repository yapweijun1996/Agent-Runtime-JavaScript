// ADR-0035 (AGRUN-262) — research (web_search / read_url) planner directives.
// Extracted verbatim from planner-prompt.js buildSystemPromptLines. Both the
// base-mode and compact-mode blocks are gated on (read_url || web_search), so a
// host that disables both research actions sees NO web_search/read_url directive
// (the Globe3 leak ADR-0034 closed). Host override key: `researchDirectives`.
// Default output is byte-identical (locked by test/unit/prompt-snapshot.test.js).
function buildLines$4({ availableActions, compactSystemPrompt } = {}) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const hasAction = (name) => actionDefinitions.some((action) => action.name === name);
  const lines = [];

  if (!compactSystemPrompt && (hasAction("read_url") || hasAction("web_search"))) {
    lines.push("For source-grounded research, treat web_search results as candidate leads until a successful read_url adds the page to readSources. Cite URLs in the final Sources list only when they are in successful readSources; if you use search snippets without reading pages, explicitly label the answer as search-summary-only and explain the limitation. EXCEPTION — proportionality: for quick current-events or headline-style asks (e.g. 'today's top news', 'latest X headlines'), the search results themselves are the deliverable: answer directly from result titles and URLs, note the answer is based on search results, and do NOT spend steps reading pages unless the user asks about page content.");
    lines.push("Citation-count self-check: when the user requires N cited sources, the FINAL deliverable must cite at least N distinct successfully-read URLs inline — reading N pages is not enough if the text only cites fewer. Count your inline citations against the requirement before finalizing/publishing; if short, cite additional pages you already read or read one more.");
    lines.push("read_url supports optional textStart and textLength. If a readSource textRange shows hasAfter=true and the missing answer may be later in that same page, call read_url again with the same url and textStart=nextTextStart instead of assuming the unseen text is irrelevant.");
    lines.push("If loopState.readUrlRecoverySignal is present, use it as read-only recovery facts. For needs_alternate_source/source_blocked, do not retry the same non-retryable failed URL; use read_url on an alternate candidate, run refined web_search, or publish limited with evidenceSatisfied=false and concrete remainingGaps. Search snippets are leads only and do not count as successful read_url evidence.");
    lines.push("If the user explicitly asks the visible answer to include finalReadiness.decision, include one plain-text line with that exact field in your finalize instruction, and keep it consistent with finalReadiness.decision. Do not include readiness JSON.");
  }

  // 2026-05-25 ADR-0034 follow-up — compact-mode counterpart of the block
  // above. Previously these five lines lived in COMPACT_SYSTEM_LINES
  // unconditionally, telling lite-tier models to "use web_search" even
  // when the host put web_search in disabledActions. With both in
  // disabledActions, the lines no longer push the model toward an
  // emit-reject loop.
  if (compactSystemPrompt && (hasAction("read_url") || hasAction("web_search"))) {
    lines.push("Use web_search for current/factual lookup requests; use read_url when a URL or search result needs page content.");
    lines.push("Treat web_search results as candidate leads until read_url succeeds. If you answer from snippets only, say the evidence is search-summary-only. For headline-style current-events asks, answer directly from search result titles and URLs without reading pages.");
    lines.push("When the user requires N cited sources, the final answer must cite at least N successfully-read URLs inline; reading pages without citing them does not count.");
    lines.push("Treat web_search results as candidate leads until read_url succeeds when page content matters.");
    lines.push("When a readSource has textRange.hasAfter=true and the missing answer may be later in the page, call read_url again with the same url and textStart=nextTextStart instead of assuming the unseen text is irrelevant.");
    lines.push("If loopState.readUrlRecoverySignal tells you the last URL is blocked/non-retryable, do not loop on that same URL; use alternate candidates, refined web_search, or honest limited with concrete remainingGaps.");
  }

  return lines;
}

export { buildLines$4 as buildLines };
