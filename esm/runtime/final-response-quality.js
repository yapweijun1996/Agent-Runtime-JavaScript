import { extractResearchCoverageTargets } from './research-coverage-guard.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { isExternalSourceCoveragePrompt } from './external-source-intent.js';
import { isConcreteArticleSource } from './final-response-sources.js';
import { readString } from './semantic-json.js';
import { analyzeClaimCoverage } from './claim-coverage.js';

const PLACEHOLDER_PATTERNS = [
  /\bpending\s+(?:search\s+)?results?\b/i,
  /\bto\s+be\s+(?:added|completed|filled)\b/i,
  /\bdata\s+gathered\s+via\s+(?:current\s+)?web\s+search\s+results?\b/i
];

const SOURCE_HEADING_RE = /^\s*#{0,6}\s*(?:(?:verified|selected|reference|evidence)\s+)?sources?\s*:?\s*$/i;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(https?:\/\/[^)\s]+[^)]*\)/i;
const SOURCE_LABEL_RE = /^\s*(?:[-*+]\s*)?(?:[*_]{0,2})?(?:(?:verified|selected|reference|evidence)\s+)?sources?\s*:\s+(.+?)(?:[*_]{0,2})?\s*$/i;
const RESEARCH_WORKSPACE_LEAK_RE = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(research\s+workspace(?:\s+progress)?|workspace\s+progress|research\s+progress|evidence\s+notes|gap\s+check|initial\s+inquiry|data\s+collection)\s*(?:\*\*)?\s*:?\s*$/im;
const VIRTUAL_WORKSPACE_LEAK_RE = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(virtual\s+workspace|workspace\s+(?:draft|files?|operations?|quality)|draft\s+workspace|final\s+candidate|critique\s+notes?)\s*(?:\*\*)?\s*:?\s*$/im;

function analyzeFinalResponseQuality(text, context = {}) {
  const value = readString(text);
  const prompt = readString(context.prompt);
  const targets = extractResearchCoverageTargets(prompt);
  const issues = [];

  if (!value) {
    issues.push({
      code: "empty_final_response",
      detail: "Final response is empty."
    });
    return { ok: false, issues, score: issues.length, targets };
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(value)) {
      issues.push({
        code: "placeholder_artifact",
        detail: "Final response contains placeholder or implementation-status wording."
      });
      break;
    }
  }

  if (RESEARCH_WORKSPACE_LEAK_RE.test(value)) {
    issues.push({
      code: "research_workspace_leak",
      detail: "Final response exposes internal research workspace or progress labels."
    });
  }

  if (VIRTUAL_WORKSPACE_LEAK_RE.test(value)) {
    issues.push({
      code: "virtual_workspace_leak",
      detail: "Final response exposes internal virtual workspace draft labels."
    });
  }

  if (requiresResearchReportSections(context) && !hasResearchReportSections(value)) {
    issues.push({
      code: "missing_research_report_sections",
      detail: "Long-run research final response is missing user-facing source quality and evidence gap sections."
    });
  }

  const claimCoverage = analyzeClaimCoverage(value, {
    researchState: context.researchState,
    researchWorkspace: context.researchWorkspace
  });
  if (claimCoverage.issueCodes.includes("missing_claim_coverage_section")) {
    issues.push({
      code: "missing_claim_coverage_section",
      detail: "Constrained-evidence research final response needs a Claim coverage section.",
      sourceCount: claimCoverage.sourceCount
    });
  }
  if (claimCoverage.issueCodes.includes("claim_count_exceeds_source_coverage")) {
    issues.push({
      code: "claim_count_exceeds_source_coverage",
      detail: "Final response includes more concrete claims than the available source coverage can safely support.",
      sourceCount: claimCoverage.sourceCount
    });
  }

  const duplicateTargets = findDuplicateTargetHeadings(value, targets);
  for (const target of duplicateTargets) {
    issues.push({
      code: "duplicate_target_section",
      detail: `Final response repeats the section heading for "${target.label}".`,
      target: target.label
    });
  }

  const shouldEnforceSources = shouldEnforceSourceLinkQuality(prompt, targets);

  if (shouldEnforceSources && hasBareSourcesSection(value)) {
    issues.push({
      code: "bare_sources_section",
      detail: "Final response includes a Sources section without Markdown links."
    });
  }

  if (shouldEnforceSources && hasUnsupportedSourceLabel(value)) {
    issues.push({
      code: "unsupported_source_label",
      detail: "Final response includes inline source labels instead of Markdown source links."
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    score: issues.length,
    targets
  };
}

// ADR-0019 PR 1 — runtime no longer vetoes finalize on quality issues.
// Pull-mode replacement: record issue codes on runState so AI can read
// them via planner-prompt's qualityContext on the next turn (if any),
// and hosts can surface them via result.diagnostics.finalResponseQuality.
// Renamed to make the intent obvious; legacy export name preserved as
// a thin alias so existing imports keep compiling during the transition
// (alias removed in PR 2).
function noteFinalResponseQualityIssues(runState, context = {}) {
  const decision = context && context.decision && typeof context.decision === "object" ? context.decision : null;
  const answer = readString(decision && decision.answer);
  if (!answer) return null;

  const prompt = readPrompt$3(runState);
  const analysis = analyzeFinalResponseQuality(answer, {
    prompt,
    researchState: runState && runState.researchState,
    researchWorkspace: runState && runState.researchWorkspace,
    virtualWorkspace: runState && runState.virtualWorkspace
  });

  const state = runState && runState.finalResponseQuality && typeof runState.finalResponseQuality === "object"
    ? runState.finalResponseQuality
    : {};
  const noteCount = Number.isInteger(state.vetoCount) && state.vetoCount >= 0 ? state.vetoCount : 0;
  runState.finalResponseQuality = {
    ...state,
    lastIssues: analysis.ok ? [] : analysis.issues.map((issue) => issue.code),
    lastSource: readString(context && context.source) || null,
    vetoCount: analysis.ok ? noteCount : noteCount + 1
  };
  return null;
}

function normalizeFinalResponseStructure(text, context = {}) {
  const value = readString(text);
  if (!value) return "";
  const prompt = readString(context.prompt);
  const targets = extractResearchCoverageTargets(prompt);
  const sourceCleaned = shouldEnforceSourceLinkQuality(prompt, targets)
    ? stripTrailingSourcesBlock(stripUnsupportedSourceLabelLines(value))
    : value;
  const cleaned = stripUnsupportedEvidenceLinks(
    stripInternalArtifactLines(sourceCleaned),
    { prompt, targets }
  );
  if (!Array.isArray(targets) || targets.length < 2) {
    return cleaned;
  }

  const duplicateTargets = findDuplicateTargetHeadings(cleaned, targets);
  if (duplicateTargets.length === 0) {
    return cleaned;
  }

  const segments = collectTargetSegments(cleaned, targets);
  if (segments.size < 2) {
    return cleaned;
  }

  const output = [];
  for (const target of targets) {
    const body = readString(segments.get(target.key));
    if (!body) continue;
    output.push(`${target.label}\n${body}`);
  }

  return output.length > 0 ? output.join("\n\n").trim() : cleaned;
}


function findDuplicateTargetHeadings(text, targets) {
  if (!Array.isArray(targets) || targets.length < 2) return [];
  const lines = readString(text).split(/\r?\n/);
  return targets.filter((target) => {
    const aliases = Array.isArray(target && target.aliases) ? target.aliases : [target && target.label];
    const count = lines.filter((line) => aliases.some((alias) => isHeadingForTarget(line, alias))).length;
    return count > 1;
  });
}

function isHeadingForTarget(line, alias) {
  const heading = readString(line)
    .replace(/^#{1,6}\s*/, "")
    .replace(/[:：]\s*$/, "");
  const needle = readString(alias);
  if (!heading || !needle) return false;
  const normalizedHeading = normalizeComparableText(heading);
  const normalizedNeedle = normalizeComparableText(needle);
  return normalizedHeading === normalizedNeedle ||
    normalizedHeading === `${normalizedNeedle} news` ||
    normalizedHeading === `${normalizedNeedle} report` ||
    normalizedHeading === `${normalizedNeedle} news report` ||
    normalizedHeading === `${normalizedNeedle} briefing` ||
    normalizedHeading === `${normalizedNeedle} search` ||
    normalizedHeading === `${normalizedNeedle} news search`;
}

function hasBareSourcesSection(text) {
  const lines = readString(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!SOURCE_HEADING_RE.test(lines[index])) continue;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (!readString(line)) {
        if (body.length > 0) break;
        continue;
      }
      if (/^\s*#{1,6}\s+\S/.test(line) && body.length > 0) break;
      body.push(line);
      if (body.length >= 6) break;
    }
    const bodyText = body.join("\n");
    if (readString(bodyText) && !MARKDOWN_LINK_RE.test(bodyText)) {
      return true;
    }
  }
  return false;
}

function shouldEnforceSourceLinkQuality(prompt, targets) {
  // AGRUN-246-D follow-up: isExternalSourceCoveragePrompt now returns true for all
  // non-empty prompts (language-bias fix). Gate enforcement on non-empty coverage
  // targets so simple Q&A / direct-final prompts that yield no entities are not
  // affected — aligned with the stated AGRUN-246-D invariant.
  return Array.isArray(targets) && targets.length > 0 && isExternalSourceCoveragePrompt(prompt);
}

function hasUnsupportedSourceLabel(text) {
  return readString(text).split(/\r?\n/).some((line) => {
    const match = line.match(SOURCE_LABEL_RE);
    if (!match) return false;
    const value = readString(match[1]);
    if (!value) return false;
    return !MARKDOWN_LINK_RE.test(value);
  });
}

function stripUnsupportedSourceLabelLines(text) {
  return readString(text)
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(SOURCE_LABEL_RE);
      if (!match) return true;
      return MARKDOWN_LINK_RE.test(readString(match[1]));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTrailingSourcesBlock(text) {
  const lines = readString(text).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (SOURCE_HEADING_RE.test(lines[index])) {
      return lines.slice(0, index).join("\n").trim();
    }
  }
  return readString(text);
}

function stripInternalArtifactLines(text) {
  return readString(text)
    .split(/\r?\n/)
    .filter((line) => !isInternalArtifactLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isInternalArtifactLine(line) {
  const normalized = readString(line).replace(/^`+|`+$/g, "").trim();
  if (!normalized) return false;
  return /^\[\s*"[^"]*\b(?:search|read|analy[sz]e|todo|plan|fetch|inspect)\b[^"]*"\s*(?:,\s*"[^"]*")*\s*\]$/i.test(normalized);
}

function requiresResearchReportSections(context) {
  const workspace = context && context.researchWorkspace && typeof context.researchWorkspace === "object"
    ? context.researchWorkspace
    : null;
  const researchState = context && context.researchState && typeof context.researchState === "object"
    ? context.researchState
    : null;
  const sourceNotes = workspace && Array.isArray(workspace.sourceNotes) ? workspace.sourceNotes : [];
  const readiness = workspace && workspace.finalReadiness && typeof workspace.finalReadiness === "object"
    ? workspace.finalReadiness
    : {};
  const workspaceGaps = Array.isArray(readiness.remainingGaps)
    ? readiness.remainingGaps.map(readString).filter(Boolean)
    : [];
  const stateGaps = researchState && Array.isArray(researchState.gaps)
    ? researchState.gaps.map(readString).filter(Boolean)
    : [];
  const sourceQuality = researchState && researchState.sourceQuality && typeof researchState.sourceQuality === "object"
    ? researchState.sourceQuality
    : {};
  const weakOrRejected = readNumber$7(sourceQuality.weak) + readNumber$7(sourceQuality.thin) + readNumber$7(sourceQuality.rejected);
  const hasWorkspaceEvidence = sourceNotes.length > 0 || workspaceGaps.length > 0;
  // AGRUN-246-B (C2.5): removed promptRequestsQuality prompt regex gate — research
  // sections required when runtime state shows actual workspace evidence or research
  // gaps/weak sources, not based on English keyword scanning of the user prompt.
  return Boolean(hasWorkspaceEvidence || stateGaps.length > 0 || weakOrRejected > 0);
}

function hasResearchReportSections(text) {
  const value = readString(text);
  if (!value) return false;
  const hasSourceQuality = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:source\s+quality|source\s+assessment|evidence\s+quality|quality\s+of\s+sources)\b/i.test(value);
  const hasGaps = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:evidence\s+gaps?|limitations?|limits\s+of\s+the\s+evidence)\b/i.test(value);
  return hasSourceQuality && hasGaps;
}

function readNumber$7(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stripUnsupportedEvidenceLinks(text, context = {}) {
  const prompt = readString(context.prompt);
  if (!shouldEnforceSourceLinkQuality(prompt, context.targets)) {
    return readString(text);
  }

  return readString(text).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+[^)]*)\)/gi, (match, label, url) => {
    const cleanLabel = readString(label).replace(/^source\s*:\s*/i, "");
    return isConcreteArticleSource({ title: cleanLabel, url })
      ? `[${cleanLabel || readString(label)}](${url})`
      : cleanLabel || readString(label);
  });
}

function collectTargetSegments(text, targets) {
  const byKey = new Map();
  let activeTarget = null;
  let buffer = [];

  function flush() {
    if (!activeTarget) return;
    const body = readString(buffer.join("\n"));
    if (body) {
      byKey.set(activeTarget.key, body);
    }
  }

  for (const line of readString(text).split(/\r?\n/)) {
    const nextTarget = targets.find((target) => {
      const aliases = Array.isArray(target && target.aliases) ? target.aliases : [target && target.label];
      return aliases.some((alias) => isHeadingForTarget(line, alias));
    }) || null;
    if (nextTarget) {
      flush();
      activeTarget = nextTarget;
      buffer = [];
      continue;
    }
    if (activeTarget) {
      buffer.push(line);
    }
  }
  flush();

  return byKey;
}

function readPrompt$3(runState) {
  return readFinalSourcePrompt(runState, null);
}

function normalizeComparableText(value) {
  return readString(value)
    .toLowerCase()
    .replace(/\bu\.s\.a\.\b/g, "usa")
    .replace(/\bu\.s\.\b/g, "us")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { analyzeFinalResponseQuality, normalizeFinalResponseStructure, noteFinalResponseQualityIssues };
