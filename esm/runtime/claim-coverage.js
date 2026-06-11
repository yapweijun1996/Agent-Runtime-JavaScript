// AGRUN-246-B (C2.6): LONG_RESEARCH_RE removed — evidenceConstrained and
// claimCoverageRequired now rely on researchReportLoop runtime state instead
// of English keyword scanning of the user prompt.
const CLAIM_COVERAGE_HEADING_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:claim\s+coverage|verified\s+facts|reported\s+but\s+not\s+independently\s+verified|what\s+is\s+directly\s+supported|not\s+verified|verification\s+limits)\b/i;
const CLAIM_LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/;

function analyzeClaimCoverage(text, context = {}) {
  const value = readString$1q(text);
  const sourceNotes = readSourceNotes(context);
  const sourceQuality = readSourceQuality(context);
  const gaps = readGaps(context);
  const relevantSources = sourceQuality.strong + sourceQuality.medium;
  const reportLoopActive = isResearchReportLoopActive$1(context);
  // AGRUN-246-B (C2.6): use reportLoopActive as the gate instead of
  // LONG_RESEARCH_RE — research loop is the AI-declared signal.
  const evidenceConstrained = Boolean(
    isFinalWithLimitations(context) ||
    (reportLoopActive && (gaps.length > 0 || relevantSources < 2))
  );
  const claimCoverageRequired = Boolean(
    evidenceConstrained || reportLoopActive
  );
  const claimCandidates = extractClaimCandidates(value);
  const hasClaimCoverageSection = CLAIM_COVERAGE_HEADING_RE.test(value);
  const issueCodes = [];
  if (evidenceConstrained) issueCodes.push("evidence_constrained");
  if (claimCoverageRequired && !hasClaimCoverageSection) issueCodes.push("missing_claim_coverage_section");
  if (evidenceConstrained && !hasClaimCoverageSection && claimCandidates.length > Math.max(2, sourceNotes.length + 1)) {
    issueCodes.push("claim_count_exceeds_source_coverage");
  }
  return {
    claimCandidates: claimCandidates.slice(0, 8),
    claimCoverageRequired,
    evidenceConstrained,
    gaps,
    hasClaimCoverageSection,
    issueCodes: Array.from(new Set(issueCodes)),
    sourceCount: sourceNotes.length,
    sourceQuality,
    status: issueCodes.some((code) => code !== "evidence_constrained") ? "warning" : "ok",
    supportedCount: evidenceConstrained ? Math.min(sourceNotes.length, claimCandidates.length) : claimCandidates.length,
    unsupportedCount: evidenceConstrained ? Math.max(0, claimCandidates.length - sourceNotes.length) : 0
  };
}

function ensureClaimCoverageSection(text, context = {}) {
  const value = readString$1q(text);
  if (!value) return "";
  const analysis = analyzeClaimCoverage(value, context);
  if (!analysis.claimCoverageRequired || analysis.hasClaimCoverageSection) return value;
  return insertBeforeSources$1(value, buildClaimCoverageSection(analysis));
}

function normalizeConstrainedEvidenceClaims(text, context = {}) {
  const value = readString$1q(text);
  if (!value) return "";
  if (looksLikeCompiledEvidenceReport(value)) return value;
  const analysis = analyzeClaimCoverage(value, context);
  const shouldNormalizeHighRiskClaims = analysis.evidenceConstrained || isResearchReportLoopActive$1(context);
  if (!shouldNormalizeHighRiskClaims) return value;

  const lines = value.split(/\r?\n/);
  const normalized = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const title = normalizeConstrainedEvidenceTitle(line, context);
    if (title !== line) {
      normalized.push(title);
      continue;
    }
    if (/^(?:#{1,6}\s*)?Sources\s*:?\s*$/i.test(trimmed)) {
      normalized.push(line);
      continue;
    }
    if (/^(?:#{1,6}\s*)?Claim\s+coverage\b/i.test(trimmed)) {
      normalized.push(line);
      continue;
    }
    normalized.push(line);
  }

  return normalizeBlankLines$1(normalized.join("\n"));
}

function attachClaimCoverageToResearchWorkspace(runState, text, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const workspace = runState.researchWorkspace && typeof runState.researchWorkspace === "object"
    ? runState.researchWorkspace
    : null;
  if (!workspace) return null;
  const analysisContext = {
    ...context,
    researchState: runState.researchState,
    researchWorkspace: workspace,
    researchReportLoop: runState.researchReportLoop
  };
  const displayText = ensureClaimCoverageSection(
    normalizeConstrainedEvidenceClaims(text, analysisContext),
    analysisContext
  );
  const analysis = analyzeClaimCoverage(displayText, analysisContext);
  const claimEvidence = Array.isArray(runState.researchReportLoop && runState.researchReportLoop.claimEvidence)
    ? runState.researchReportLoop.claimEvidence
    : [];
  const directClaimEvidenceCount = claimEvidence.filter((claim) => claim && claim.supportStatus === "direct").length;
  const unsupportedClaimEvidenceCount = claimEvidence.filter((claim) => {
    if (!claim || typeof claim !== "object") return false;
    return claim.supportStatus && claim.supportStatus !== "direct";
  }).length;
  const issueCodes = Array.from(new Set(
    analysis.issueCodes.concat(unsupportedClaimEvidenceCount > 0 ? ["claim_evidence_unverified"] : [])
  ));
  workspace.claimCoverage = {
    claimCandidates: analysis.claimCandidates,
    evidenceConstrained: analysis.evidenceConstrained,
    gaps: analysis.gaps,
    issueCodes,
    sourceCount: analysis.sourceCount,
    status: unsupportedClaimEvidenceCount > 0 ? "warning" : analysis.status,
    supportedCount: claimEvidence.length > 0 ? directClaimEvidenceCount : analysis.supportedCount,
    unsupportedCount: claimEvidence.length > 0 ? unsupportedClaimEvidenceCount : analysis.unsupportedCount
  };
  return workspace.claimCoverage;
}

function buildClaimCoverageSection(analysis) {
  const gaps = Array.isArray(analysis.gaps) && analysis.gaps.length > 0
    ? analysis.gaps.map((gap) => gap.replace(/_/g, " ")).join(", ")
    : analysis.evidenceConstrained ? "constrained source coverage" : "no runtime evidence gap recorded";
  const scopeLine = analysis.evidenceConstrained
    ? `This is a source-constrained summary based on ${analysis.sourceCount} directly read source(s).`
    : `This source-backed report is based on ${analysis.sourceCount} directly read source(s).`;
  const riskLine = analysis.evidenceConstrained
    ? "Not fully verified in this run: employment, education, detailed project descriptions, dates, metrics, or other biography claims unless they are explicitly visible in the listed source(s)."
    : "High-risk claims such as employment, education, dates, metrics, and detailed project claims should still be read against the linked source(s).";
  return [
    "#### Claim coverage",
    scopeLine,
    `Directly supported claims should be read only against the linked source(s); remaining gaps: ${gaps}.`,
    riskLine
  ].join("\n");
}


function looksLikeCompiledEvidenceReport(value) {
  return (
    /(?:^|\n)#### Claim coverage\b/i.test(value) &&
    (/(?:^|\n)#### Source map\b/i.test(value) ||
      /(?:^|\n)## Directly supported findings\b/i.test(value) ||
      /(?:^|\n)## Evidence-backed synthesis\b/i.test(value))
  ) || (
    /(?:^|\n)## Verified facts\b/i.test(value) &&
    /(?:^|\n)## Source assessment\b/i.test(value)
  );
}

function normalizeConstrainedEvidenceTitle(line, context) {
  if (!isFinalWithLimitations(context)) return line;
  const heading = line.match(/^(#{1,6}\s*)([^\n]+?)(\s*:\s*[^\n]+)?\s*$/);
  if (!heading) return line;
  const hashes = heading[1] || "";
  const head = heading[2] || "";
  const suffix = heading[3] || "";
  // 2026-05-27 audit (companion to commit de5e1127f scaffold fix). Original
  // matchers used `\bprofile\b` / `\breport\b` which clobbered any
  // AI-authored descriptive title that happened to contain those words —
  // e.g. "Marketing Report: TNO Systems" → "Research Report: TNO Systems",
  // "Company Profile of X" → "Research Report". Same hardcode-clobber-AI
  // anti-pattern Fix 1 removed from ensureAnalystReportScaffold. Anchor
  // to bare single-word titles so only truly ambiguous "# Profile" /
  // "# Report" headings get the limited-publish normalization. Multi-word
  // descriptive AI titles win.
  if (
    /^Research\s+Report$/i.test(head) ||
    /^Profile$/i.test(head) ||
    /^Report$/i.test(head)
  ) {
    return `${hashes}Research Report${suffix}`;
  }
  return line;
}

function isFinalWithLimitations(context) {
  const loop = context && context.researchReportLoop && typeof context.researchReportLoop === "object"
    ? context.researchReportLoop
    : null;
  if (!loop) return false;
  if (loop.finalMode === "final_with_limitations") return true;
  const sourceMinimum = loop.sourceMinimum && typeof loop.sourceMinimum === "object" ? loop.sourceMinimum : null;
  return Boolean(sourceMinimum && sourceMinimum.passed === false && loop.status === "final_with_limitations");
}

function isResearchReportLoopActive$1(context) {
  const loop = context && context.researchReportLoop && typeof context.researchReportLoop === "object"
    ? context.researchReportLoop
    : null;
  const status = loop ? readString$1q(loop.status) : "";
  return Boolean(
    loop &&
    (loop.enabled === true || readString$1q(loop.finalMode) || (status && status !== "idle"))
  );
}



function extractClaimCandidates(text) {
  const lines = readString$1q(text).split(/\r?\n/);
  const claims = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^sources?:?$/i.test(trimmed)) continue;
    const listMatch = CLAIM_LINE_RE.exec(trimmed);
    if (listMatch) {
      const claim = cleanupClaim(listMatch[1]);
      if (claim) claims.push(claim);
      continue;
    }
    if (claims.length < 3 && /(?:\bis\b|\bare\b|\bmaintains\b|\bemployed\b|\bspeciali[sz]es\b|\bfocus(?:es)?\b)/i.test(trimmed)) {
      const claim = cleanupClaim(trimmed);
      if (claim) claims.push(claim);
    }
  }
  return Array.from(new Set(claims));
}

function cleanupClaim(value) {
  return readString$1q(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 220)
    .trim();
}

function readSourceNotes(context) {
  const workspace = context && context.researchWorkspace && typeof context.researchWorkspace === "object"
    ? context.researchWorkspace
    : {};
  return Array.isArray(workspace.sourceNotes) ? workspace.sourceNotes : [];
}

function readSourceQuality(context) {
  const state = context && context.researchState && typeof context.researchState === "object"
    ? context.researchState
    : {};
  const quality = state.sourceQuality && typeof state.sourceQuality === "object" ? state.sourceQuality : {};
  return {
    medium: readNumber$a(quality.medium),
    strong: readNumber$a(quality.strong),
    weak: readNumber$a(quality.weak),
    thin: readNumber$a(quality.thin),
    rejected: readNumber$a(quality.rejected)
  };
}

function readGaps(context) {
  const state = context && context.researchState && typeof context.researchState === "object" ? context.researchState : {};
  const workspace = context && context.researchWorkspace && typeof context.researchWorkspace === "object" ? context.researchWorkspace : {};
  const readiness = workspace.finalReadiness && typeof workspace.finalReadiness === "object" ? workspace.finalReadiness : {};
  return Array.from(new Set(
    []
      .concat(Array.isArray(state.gaps) ? state.gaps : [])
      .concat(Array.isArray(readiness.remainingGaps) ? readiness.remainingGaps : [])
      .map(readString$1q)
      .filter(Boolean)
  ));
}

function insertBeforeSources$1(text, section) {
  const value = readString$1q(text);
  const marker = /\n(?:#{1,6}\s*)?Sources\s*:?\s*\n/i.exec(value);
  if (!marker) return [value, section].filter(Boolean).join("\n\n");
  const sourceStart = marker.index + 1;
  const before = value.slice(0, sourceStart).trim();
  const sources = value.slice(sourceStart).trim();
  return [before, section, sources].filter(Boolean).join("\n\n");
}

function readString$1q(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber$a(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizeBlankLines$1(text) {
  return readString$1q(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export { analyzeClaimCoverage, attachClaimCoverageToResearchWorkspace, ensureClaimCoverageSection, normalizeConstrainedEvidenceClaims };
