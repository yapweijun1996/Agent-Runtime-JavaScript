import { hasSessionContext, buildSessionContextPromptBlock } from '../session/prompt.js';
import { analyzeCitationTargetCoverage } from './citation-source-coverage.js';
import { isReadableEvidenceSource } from './read-source-quality.js';
import { buildVirtualWorkspacePromptBlock } from './virtual-workspace.js';
import { readVerificationState } from './web-search-verification.js';

function buildFinalResponsePrompt(originalPrompt, instruction, researchContext, sessionContext, toolContext, failedTools, budgetOverrides, options = {}) {
  const normalizedInstruction = readString$p(instruction);
  const context = researchContext && typeof researchContext === "object" ? researchContext : {};
  const normalizedSearchResults = Array.isArray(context.searchResults) ? context.searchResults : [];
  const normalizedReadSources = Array.isArray(context.readSources) ? context.readSources : [];
  const visibleFinalReadinessLine = buildVisibleFinalReadinessLine(originalPrompt, options.finalReadiness);
  const verificationState = readVerificationState(context.verificationState || context.verification);
  const successfulReadSources = normalizedReadSources.filter((item) => isReadableEvidenceSource(item));
  const failedReadSources = normalizedReadSources.filter((item) => item && !isReadableEvidenceSource(item));
  const screenshotCount = successfulReadSources.filter(hasReadSourceScreenshot).length;
  const sessionBlock = hasSessionContext(sessionContext)
    ? buildSessionContextPromptBlock(sessionContext, "Session evidence to use in the final answer:")
    : "";
  const skillToolBlock = buildSkillToolBlock(toolContext, budgetOverrides);
  const failedToolsBlock = buildFailedToolsBlock(failedTools);
  const citationCoverageBlock = isCitationCoveragePromptEnabled(options.runtimeConfig)
    ? buildCitationCoverageBlock(
      analyzeCitationTargetCoverage({
        observationSummary: { prompt: originalPrompt },
        researchContext: context
      })
    )
    : "";
  const researchStateBlock = buildResearchStateBlock(context.researchState || options.researchState);
  const researchEvidenceGateBlock = buildResearchEvidenceGateBlock(
    context.researchEvidenceGraph || options.researchEvidenceGraph,
    context.researchFinalEnvelope || options.researchFinalEnvelope,
    context.researchReportLoop || options.researchReportLoop
  );
  const researchWorkspaceBlock = buildResearchWorkspaceBlock(context.researchWorkspace || options.researchWorkspace);
  const virtualWorkspaceBlock = buildVirtualWorkspacePromptBlock(context.virtualWorkspace || options.virtualWorkspace);

  if (normalizedSearchResults.length === 0 && successfulReadSources.length === 0 && !skillToolBlock && !virtualWorkspaceBlock) {
    return [
      `User request: ${originalPrompt}`,
      sessionBlock ? "" : null,
      sessionBlock || null,
      failedToolsBlock || null,
      virtualWorkspaceBlock || null,
      visibleFinalReadinessLine || null,
      normalizedInstruction || null
    ].filter(Boolean).join("\n\n");
  }

  return [
    successfulReadSources.length > 0 || normalizedSearchResults.length > 0
      ? "Use the evidence below to answer the user."
      : "Use the skill tool results below to answer the user.",
    `User request: ${originalPrompt}`,
    "If the evidence is incomplete, say so briefly.",
    verificationState === "single_source" || verificationState === "none"
      ? "If only one independent source supports the answer, say that the evidence is limited."
      : null,
    successfulReadSources.length > 0 || normalizedSearchResults.length > 0
      ? 'End the answer with a "Sources:" section using Markdown links only, e.g. "- [Title](https://example.com)". Never list a source name without a URL; if the URL is unknown, do not include that item as a source.'
      : null,
    successfulReadSources.length > 0 || normalizedSearchResults.length > 0
      ? 'Do not write generic source labels such as "Source: Web Search"; cite real publisher URLs only.'
      : null,
    successfulReadSources.some((source) => hasMoreReadSourceText(source))
      ? "Some read_url evidence is a window of a longer page. Use only the visible window; if important facts may be outside the supplied text, state the limitation instead of inventing unseen details."
      : null,
    failedReadSources.length > 0
      ? "If a page was blocked, too thin, or too weak to rely on, say that clearly and rely only on the available search summaries or usable read evidence."
      : null,
    citationCoverageBlock || null,
    researchStateBlock || null,
    researchEvidenceGateBlock || null,
    researchWorkspaceBlock || null,
    virtualWorkspaceBlock || null,
    screenshotCount > 0
      ? `One or more read sources include screenshot evidence. Use it when visual structure matters, but do not invent details that are not visible.`
      : null,
    sessionBlock ? "" : null,
    sessionBlock || null,
    skillToolBlock ? "" : null,
    skillToolBlock || null,
    failedToolsBlock ? "" : null,
    failedToolsBlock || null,
    successfulReadSources.length > 0 ? "" : null,
    successfulReadSources.length > 0 ? "Read URL evidence:" : null,
    successfulReadSources.length > 0
      ? successfulReadSources.map((item, index) => buildReadSourcePromptBlock(item, index)).join("\n\n")
      : null,
    normalizedSearchResults.length > 0 ? "" : null,
    normalizedSearchResults.length > 0 ? "Search results:" : null,
    normalizedSearchResults.map((item, index) => {
      const title = readString$p(item && item.title) || `Result ${index + 1}`;
      const url = readString$p(item && item.url);
      const snippet = readString$p(item && item.snippet) || readString$p(item && item.content);

      return [title, url, snippet].filter(Boolean).join("\n");
    }).join("\n\n"),
    visibleFinalReadinessLine || null,
    "",
    normalizedInstruction
  ].filter(Boolean).join("\n");
}

function buildResearchStateBlock(value) {
  const state = value && typeof value === "object" ? value : null;
  if (!state || state.qualityGateRequired !== true) return "";
  const sourceQuality = state.sourceQuality && typeof state.sourceQuality === "object"
    ? state.sourceQuality
    : {};
  const gaps = Array.isArray(state.gaps)
    ? state.gaps.map(readString$p).filter(Boolean)
    : [];
  return [
    "Research quality state:",
    `phase=${readString$p(state.phase) || "n/a"} final_allowed=${state.finalAllowed === true ? "yes" : "no"} final_reason=${readString$p(state.finalReason) || "n/a"}`,
    `sources strong=${readNumber$2(sourceQuality.strong)} medium=${readNumber$2(sourceQuality.medium)} weak=${readNumber$2(sourceQuality.weak)} thin=${readNumber$2(sourceQuality.thin)} rejected=${readNumber$2(sourceQuality.rejected)}`,
    gaps.length > 0 ? `evidence_gaps=${gaps.join(",")}` : "evidence_gaps=none",
    state.finalAllowed === true
      ? "If the quality gate was exhausted rather than passed, state the evidence limitation clearly."
      : "Do not present unsupported claims as settled facts."
  ].join("\n");
}

function buildResearchEvidenceGateBlock(graphValue, envelopeValue, loopValue) {
  const graph = graphValue && typeof graphValue === "object" ? graphValue : null;
  if (!graph) return "";
  const envelope = envelopeValue && typeof envelopeValue === "object" ? envelopeValue : {};
  const loop = loopValue && typeof loopValue === "object" ? loopValue : {};
  const claimGraph = Array.isArray(graph.claimGraph) ? graph.claimGraph : [];
  const sourceArtifacts = Array.isArray(graph.sourceArtifacts) ? graph.sourceArtifacts : [];
  const includedClaimIds = Array.isArray(envelope.includedClaimIds)
      ? envelope.includedClaimIds.map(readString$p).filter(Boolean)
    : claimGraph
      .filter((claim) => claim && claim.decision === "include")
      .map((claim) => readString$p(claim.claimId || claim.id))
      .filter(Boolean);
  const finalSourceIds = Array.isArray(envelope.finalSourceIds)
    ? envelope.finalSourceIds.map(readString$p).filter(Boolean)
    : [];
  const finalSourceSet = new Set(finalSourceIds);
  const includedSourceUrls = sourceArtifacts
    .filter((source) => finalSourceSet.has(readString$p(source && source.id)))
    .map((source) => `${readString$p(source.id)}=${readString$p(source.title) || readString$p(source.url)} ${readString$p(source.url)}`.trim())
    .filter(Boolean)
    .slice(0, 8);
  const includedClaimSet = new Set(includedClaimIds);
  const includedClaims = claimGraph
    .filter((claim) => includedClaimSet.has(readString$p(claim && (claim.claimId || claim.id))))
    .map((claim) => {
      const ids = readClaimSourceIds(claim).join(",");
      const claimId = readString$p(claim.claimId || claim.id);
      return `${claimId} [${ids || "no_source"}] ${readString$p(claim.claim || claim.text)}`.trim();
    })
    .filter(Boolean)
    .slice(0, 12);
  const gaps = Array.isArray(envelope.evidenceGaps)
    ? envelope.evidenceGaps.map(readString$p).filter(Boolean)
    : Array.isArray(graph.evidenceGaps)
      ? graph.evidenceGaps.map(readString$p).filter(Boolean)
      : [];
  const finalMode = readString$p(envelope.finalMode) || readString$p(loop.finalMode) || "final_with_limitations";

  if (includedClaims.length === 0 && finalSourceIds.length === 0 && gaps.length === 0) return "";

  return [
    "Research evidence gate:",
    `final_mode=${finalMode}`,
    finalSourceIds.length > 0 ? `final_source_ids=${finalSourceIds.join(",")}` : "final_source_ids=none",
    includedSourceUrls.length > 0 ? `final_sources=${includedSourceUrls.join(" | ")}` : "final_sources=none",
    includedClaims.length > 0 ? `included_claims=${includedClaims.join(" | ")}` : "included_claims=none",
    gaps.length > 0 ? `evidence_gaps=${gaps.slice(0, 8).join(",")}` : "evidence_gaps=none",
    [
      "Use only included_claims as verified facts.",
      "Downgraded or omitted claims may be described only as evidence gaps or not independently verified.",
      "The final Sources section must cite only final_sources/final_source_ids.",
      "Do not cite blocked, off-topic, context-only, profile-directory, or search-result-only sources as final evidence."
    ].join(" ")
  ].join("\n");
}

function readClaimSourceIds(claim) {
  const values = [];
  const collect = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const value = readString$p(item);
      if (value && !values.includes(value)) values.push(value);
    }
  };
  collect(claim && claim.supportingSourceIds);
  collect(claim && claim.sourceIds);
  const single = readString$p(claim && claim.sourceId);
  if (single && !values.includes(single)) values.push(single);
  return values;
}

function buildResearchWorkspaceBlock(value) {
  const workspace = value && typeof value === "object" ? value : null;
  if (!workspace) return "";
  const brief = workspace.brief && typeof workspace.brief === "object" ? workspace.brief : {};
  const plan = workspace.plan && typeof workspace.plan === "object" ? workspace.plan : {};
  const finalReadiness = workspace.finalReadiness && typeof workspace.finalReadiness === "object" ? workspace.finalReadiness : {};
  const sourceNotes = Array.isArray(workspace.sourceNotes) ? workspace.sourceNotes : [];
  const questions = Array.isArray(plan.questions)
    ? plan.questions.map(readString$p).filter(Boolean).slice(0, 6)
    : [];
  const gaps = Array.isArray(finalReadiness.remainingGaps)
    ? finalReadiness.remainingGaps.map(readString$p).filter(Boolean).slice(0, 8)
    : [];
  const sources = sourceNotes
    .map((source) => {
      const title = readString$p(source && source.title) || readString$p(source && source.url);
      const quality = readString$p(source && source.quality) || "unknown";
      return title ? `${title} (${quality})` : "";
    })
    .filter(Boolean)
    .slice(0, 8);

  if (!readString$p(brief.topic) && questions.length === 0 && sources.length === 0 && gaps.length === 0) {
    return "";
  }

  return [
    "Research workspace:",
    readString$p(brief.topic) ? `topic=${readString$p(brief.topic)}` : null,
    questions.length > 0 ? `plan_questions=${questions.join(" | ")}` : null,
    sources.length > 0 ? `source_notes=${sources.join(" | ")}` : null,
    gaps.length > 0 ? `remaining_gaps=${gaps.join(",")}` : "remaining_gaps=none",
    `final_readiness=${finalReadiness.allowed === true ? "ready" : "not_ready"} reason=${readString$p(finalReadiness.reason) || "n/a"}`,
    [
      "Use this workspace as draft context only.",
      "Write only the final user-facing report.",
      "Do not include sections named Research Workspace, Research Workspace Progress, Evidence Notes, Gap Check, Initial Inquiry, or Data Collection.",
      "For long-run research reports, prefer this user-facing structure unless the user requested another format: Summary, What is supported, Source quality, Evidence gaps, Sources.",
      "Separate confirmed facts from weak/self-published evidence and evidence gaps.",
      "Do not describe a claim as confirmed unless the supplied evidence has a direct source URL that supports it."
    ].join(" ")
  ].filter(Boolean).join("\n");
}

function readNumber$2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildFinalResponseSystemPrompt(systemPrompt) {
  const suffix = [
    "Answer using the available evidence. If facts remain uncertain, say so briefly.",
    'When citing sources, use Markdown links with URLs. Never show a "Sources:" list containing only publication names or labels.',
    'Never write generic source labels such as "Source: Web Search", "Source: Search Results", or "Source: Provider".',
    "For multi-target reports, use one clear section per requested target unless the user asked for another structure.",
    "Do not include internal TodoState, Task progress, Progress Tracker, or todo-list/checklist sections in the final answer; the host UI renders task progress separately.",
    "Do not include internal research workspace/progress sections in the final answer; write a final report with confirmed facts, limitations, and sources instead.",
    "Do not include internal virtual workspace, draft workspace, workspace files, workspace operations, critique notes, or final candidate sections in the final answer.",
    "Do not print internal control metadata such as finalReadiness, requirementsAssessment, readiness JSON, planner envelopes, or tool-result JSON in the final answer; express limitations as normal prose. Exception: if the final prompt explicitly says the user requested a visible finalReadiness.decision line, include only that one plain-text line and never include readiness JSON.",
    "For research reports with weak or incomplete evidence, include a visible Source quality or Limitations section and avoid settled wording for weak/self-published claims.",
    "Do not describe the answer as a paused, resumed, or partially completed task unless the user explicitly asked for runtime status; present the user-facing result directly and put any incomplete evidence in a brief limitation statement.",
    "Do not end the final answer with a follow-up question or a next-step menu.",
    "If more work could be done, mention it as a brief limitation statement, not a question."
  ].join(" ");
  return systemPrompt ? `${systemPrompt}\n\n${suffix}` : suffix;
}

function ensureVisibleFinalReadinessDecisionLine(text, originalPrompt, finalReadiness) {
  const normalized = readString$p(text);
  const decision = readVisibleFinalReadinessDecision(finalReadiness, originalPrompt);
  if (decision !== "ready" && decision !== "limited") {
    return normalized;
  }
  if (!userRequestedVisibleFinalReadinessDecision(originalPrompt) && !hasExplicitVisibleReadinessDecision(originalPrompt)) {
    return normalized;
  }

  const requiredLine = `finalReadiness.decision: ${decision}`;
  if (!normalized) {
    return requiredLine;
  }

  const visibleLinePattern = /(^|\n)\s*finalReadiness\.decision\s*:\s*(ready|limited)\b[^\n]*(?=\n|$)/i;
  if (visibleLinePattern.test(normalized)) {
    return normalized.replace(visibleLinePattern, (_match, prefix) => `${prefix}${requiredLine}`);
  }

  return `${normalized}\n\n${requiredLine}`;
}

function buildVisibleFinalReadinessLine(originalPrompt, finalReadiness) {
  if (!userRequestedVisibleFinalReadinessDecision(originalPrompt)) {
    return "";
  }

  const decision = readVisibleFinalReadinessDecision(finalReadiness, originalPrompt);
  if (decision !== "ready" && decision !== "limited") {
    return "";
  }

  return [
    "The user explicitly requested finalReadiness.decision in the visible answer.",
    `Include exactly one plain-text line: finalReadiness.decision: ${decision}`,
    "Do not include finalReadiness JSON or requirementsAssessment JSON."
  ].join(" ");
}

function readVisibleFinalReadinessDecision(finalReadiness, promptIntent) {
  const structured = readString$p(finalReadiness && finalReadiness.decision);
  if (structured === "ready" || structured === "limited") {
    return structured;
  }

  const text = readString$p(promptIntent);
  const explicitField = text.match(/finalReadiness\.decision\s*(?::|=|\bas\b|\bto\b)\s*(ready|limited)\b/i);
  if (explicitField) {
    return explicitField[1].toLowerCase();
  }

  const explicitDecision = text.match(/\bdecision\s*(?::|=|\bis\b|\bas\b|\bto\b)?\s*(ready|limited)\b/i);
  if (explicitDecision) {
    return explicitDecision[1].toLowerCase();
  }

  const adjectiveDecision = text.match(/\b(ready|limited)\s+decision\b/i);
  return adjectiveDecision ? adjectiveDecision[1].toLowerCase() : "";
}

function userRequestedVisibleFinalReadinessDecision(value) {
  return /finalReadiness\.decision|final\s*readiness\s*decision/i.test(readString$p(value));
}

function hasExplicitVisibleReadinessDecision(value) {
  const text = readString$p(value);
  return /\bdecision\s*(?::|=|\bis\b|\bas\b|\bto\b)?\s*(ready|limited)\b/i.test(text) ||
    /\b(ready|limited)\s+decision\b/i.test(text);
}

function readString$p(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildSkillToolBlock(toolContext, budgetOverrides) {
  const source = toolContext && typeof toolContext === "object" ? toolContext : {};
  const history = Array.isArray(source.history) ? source.history : [];

  if (!source.lastResult && history.length === 0) {
    return "";
  }

  const overrides = budgetOverrides && typeof budgetOverrides === "object" ? budgetOverrides : {};
  const deduplicated = history.length <= 1;
  const lastResultBudget = typeof overrides.lastResultBudget === "number"
    ? overrides.lastResultBudget
    : (deduplicated ? 3000 : 8000);
  const historyEntryBudget = typeof overrides.historyEntryBudget === "number"
    ? overrides.historyEntryBudget
    : (deduplicated ? 600 : 6000);

  return [
    "Skill tool results:",
    source.lastResult ? `Last result:\n${serializePromptValue$1(source.lastResult, lastResultBudget)}` : null,
    !deduplicated && history.length > 0
      ? `Recent history:\n${history.slice(-3).map((entry) => serializePromptValue$1(entry, historyEntryBudget)).join("\n\n")}`
      : null
  ].filter(Boolean).join("\n\n");
}

function buildReadSourcePromptBlock(item, index) {
  const title = readString$p(item && item.url) || `Read source ${index + 1}`;
  const status = typeof item.status === "number" ? String(item.status) : "n/a";
  const contentType = readString$p(item && item.contentType) || "unknown";
  const mode = readString$p(item && item.mode) || "auto";
  const text = serializePromptValue$1(readString$p(item && item.text), 1800);
  const visualEvidence = hasReadSourceScreenshot(item) ? "yes" : "no";
  const textRange = formatReadSourceTextRange(item && item.textRange);

  return [
    title,
    `status=${status} content_type=${contentType} mode=${mode} truncated=${item && item.truncated === true ? "yes" : "no"} screenshot=${visualEvidence}`,
    textRange ? `text_range=${textRange}` : null,
    readString$p(item && item.title) ? `page_title=${readString$p(item.title)}` : null,
    text
  ].filter(Boolean).join("\n");
}

function hasMoreReadSourceText(item) {
  return Boolean(item && item.textRange && typeof item.textRange === "object" && item.textRange.hasAfter === true);
}

function formatReadSourceTextRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const start = readRangeNumber(value.start);
  const end = readRangeNumber(value.end);
  const total = readRangeNumber(value.totalChars);
  const next = readRangeNumber(value.nextTextStart);
  return [
    `start=${start == null ? "n/a" : start}`,
    `end=${end == null ? "n/a" : end}`,
    `total=${total == null ? "n/a" : total}`,
    `has_after=${value.hasAfter === true ? "yes" : "no"}`,
    next == null ? null : `next_text_start=${next}`
  ].filter(Boolean).join(" ");
}

function readRangeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildCitationCoverageBlock(coverage) {
  if (!coverage || coverage.required !== true) return "";
  const missing = Array.isArray(coverage.missingTargets)
    ? coverage.missingTargets.map((target) => readString$p(target && target.label)).filter(Boolean)
    : [];
  const covered = Array.isArray(coverage.coveredTargets)
    ? coverage.coveredTargets.map((target) => readString$p(target && target.label)).filter(Boolean)
    : [];
  if (missing.length === 0) {
    return covered.length > 0
      ? `Citation coverage: direct source URLs are available for ${covered.join(", ")}.`
      : "";
  }
  return [
    `Citation coverage warning: no direct, user-verifiable source URL is available for ${missing.join(", ")}.`,
    "For any target listed in this warning, do not write a concrete news claim in the final answer; say evidence is insufficient for that target.",
    "Do not cite provider redirect URLs as sources."
  ].join(" ");
}

function isCitationCoveragePromptEnabled(runtimeConfig) {
  const config = runtimeConfig && typeof runtimeConfig === "object"
    ? runtimeConfig.citationCoverageGuard
    : undefined;
  if (config === false) return false;
  if (config && typeof config === "object" && config.enabled === false) return false;
  return true;
}

function buildFinalResponseParts(researchContext, currentParts) {
  const parts = Array.isArray(currentParts) ? currentParts.slice() : [];
  const readSources = Array.isArray(researchContext && researchContext.readSources)
    ? researchContext.readSources
    : [];
  let attachedScreenshots = 0;

  for (const source of readSources) {
    if (!isReadableEvidenceSource(source) || !hasReadSourceScreenshot(source)) {
      continue;
    }

    const screenshotDataUrl = readString$p(source.screenshotDataUrl);
    const screenshotMimeType = readString$p(source.screenshotMimeType) || "image/jpeg";
    if (!screenshotDataUrl) {
      continue;
    }

    parts.push({
      text: buildReadSourceScreenshotCaption(source),
      type: "text"
    });
    parts.push({
      mimeType: screenshotMimeType,
      type: "image",
      url: screenshotDataUrl,
      filename: createScreenshotFilename(source)
    });
    attachedScreenshots += 1;

    if (attachedScreenshots >= 1) {
      break;
    }
  }

  return parts;
}

function buildReadSourceScreenshotCaption(source) {
  const url = readString$p(source && source.url) || "read source";
  const title = readString$p(source && source.title);
  return title
    ? `Screenshot evidence for ${url}. Page title: ${title}.`
    : `Screenshot evidence for ${url}.`;
}

function createScreenshotFilename(source) {
  const title = readString$p(source && source.title);
  if (title) {
    return `${title.slice(0, 48)}.jpg`;
  }

  return "read-url-screenshot.jpg";
}

function hasReadSourceScreenshot(item) {
  return readString$p(item && item.screenshotDataUrl).startsWith("data:image/");
}

function buildFailedToolsBlock(failedTools) {
  const tools = Array.isArray(failedTools) ? failedTools.filter(Boolean) : [];
  if (tools.length === 0) return "";

  const lines = tools.map((entry) => {
    const tool = readString$p(entry.tool) || "unknown";
    const reason = readString$p(entry.reason) || "unknown error";
    return `- ${tool}: ${reason}`;
  });

  return [
    "FAILED TOOL CALLS (data unavailable — do NOT fabricate figures for these sections, state that the data could not be retrieved):",
    ...lines
  ].join("\n");
}

function serializePromptValue$1(value, maxChars) {
  let text = "";

  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = String(value);
  }

  if (text.length <= maxChars) {
    return text;
  }

  const rowCount = Array.isArray(value) ? value.length : 0;
  const truncatedText = text.slice(0, maxChars - 3) + "...";

  if (rowCount > 0) {
    return `${truncatedText}\n(truncated: ${rowCount} items returned, output trimmed to fit budget)`;
  }

  return truncatedText;
}

export { buildFinalResponseParts, buildFinalResponsePrompt, buildFinalResponseSystemPrompt, ensureVisibleFinalReadinessDecisionLine };
