import { inspectWorkspacePublishProtocol, inspectWorkspaceCandidateStructure } from './virtual-workspace.js';
import { extractRequestedLengthContract, readTerminalContractText } from './terminal-final-contract.js';
import { isReadableEvidenceSource, explainReadSourceQuality } from './read-source-quality.js';

const ISSUE_BLOCKING = "blocking";
const ISSUE_ADVISORY = "advisory";

// AGRUN-297 — structure issue severity is host-configurable (policy/mechanism
// SSOT). The runtime DETECTS structure facts (a sensor) and exposes them; how
// strictly each fact gates a clean `ready` publish is a host policy, not a
// runtime opinion baked into code. Defaults: hard correctness errors stay
// blocking; cosmetic section-numbering issues default to advisory so the
// runtime no longer holds a numbering-aesthetics opinion as a publish blocker.
// Hosts override via runtimeConfig.candidateQuality.structureIssueSeverity:
//   { non_monotonic_section_numbers: "blocking", ... }
const DEFAULT_STRUCTURE_ISSUE_SEVERITY = Object.freeze({
  duplicate_headings: ISSUE_BLOCKING,
  duplicate_section_numbers: ISSUE_ADVISORY,
  non_monotonic_section_numbers: ISSUE_ADVISORY,
  gapped_section_numbers: ISSUE_ADVISORY
});

function resolveStructureIssueSeverity(runtimeConfig) {
  const merged = { ...DEFAULT_STRUCTURE_ISSUE_SEVERITY };
  const override = runtimeConfig
    && typeof runtimeConfig === "object"
    && runtimeConfig.candidateQuality
    && typeof runtimeConfig.candidateQuality === "object"
    && runtimeConfig.candidateQuality.structureIssueSeverity
    && typeof runtimeConfig.candidateQuality.structureIssueSeverity === "object"
    ? runtimeConfig.candidateQuality.structureIssueSeverity
    : null;
  if (override) {
    for (const [code, severity] of Object.entries(override)) {
      if (severity === ISSUE_BLOCKING || severity === ISSUE_ADVISORY) {
        merged[code] = severity;
      }
    }
  }
  return merged;
}

function structureIssueSeverity(code, severityMap) {
  return severityMap && severityMap[code] === ISSUE_BLOCKING ? ISSUE_BLOCKING : ISSUE_ADVISORY;
}

// Source/citation issue severity is host-configurable, same policy/mechanism
// split as structure (AGRUN-297). Default ADVISORY: the runtime OBSERVES
// evidence sufficiency and exposes it, but does NOT veto finalize on source
// minimums — restoring the verified 2026-05-09 AI-first finalize contract
// ("runtime must not veto finalize on source minimums; AI owns
// finalize-with-limitations"). A hardcoded blocking source gate here was the
// root cause of weak-model publish deadlock (deepseek looped to its deadline,
// 9 blocked publishes, 0 delivery). A host that genuinely wants a hard source
// gate opts in via runtimeConfig.candidateQuality.sourceIssueSeverity.
const DEFAULT_SOURCE_ISSUE_SEVERITY = Object.freeze({
  missing_required_cited_urls: ISSUE_ADVISORY,
  blocked_source_cited: ISSUE_ADVISORY,
  unread_cited_url: ISSUE_ADVISORY
});

function resolveSourceIssueSeverity(runtimeConfig) {
  const merged = { ...DEFAULT_SOURCE_ISSUE_SEVERITY };
  const override = runtimeConfig
    && typeof runtimeConfig === "object"
    && runtimeConfig.candidateQuality
    && typeof runtimeConfig.candidateQuality === "object"
    && runtimeConfig.candidateQuality.sourceIssueSeverity
    && typeof runtimeConfig.candidateQuality.sourceIssueSeverity === "object"
    ? runtimeConfig.candidateQuality.sourceIssueSeverity
    : null;
  if (override) {
    for (const [code, severity] of Object.entries(override)) {
      if (severity === ISSUE_BLOCKING || severity === ISSUE_ADVISORY) merged[code] = severity;
    }
  }
  return merged;
}

function buildCandidateQualitySignal(options = {}) {
  const context = options.context && typeof options.context === "object" ? options.context : {};
  const runState = options.runState && typeof options.runState === "object"
    ? options.runState
    : context.runState && typeof context.runState === "object"
      ? context.runState
      : {};
  const workspace = options.workspace && typeof options.workspace === "object"
    ? options.workspace
    : runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
      ? runState.virtualWorkspace
      : {};
  const file = options.file && typeof options.file === "object" ? options.file : {};
  const path = readString$1x(file.path || options.path) || "final_candidate.md";
  const content = typeof file.content === "string" ? file.content : "";
  const finalReadiness = options.finalReadiness && typeof options.finalReadiness === "object"
    ? options.finalReadiness
    : null;
  const reviewRequired = options.reviewRequired === true;
  const issues = [];
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, path);
  const review = readCandidateReview(workspace, path);
  const requirementsChecklist = normalizeRequirementsChecklist(review && review.requirementsChecklist);
  const textStats = readTextStats(file.textStats, content);
  const requestedLength = readRequestedLength({ context, finalReadiness, options });
  const requestedCitations = readRequestedCitationContract({ options });
  const publishDecision = readString$1x(finalReadiness && finalReadiness.decision).toLowerCase();
  const structureSeverity = resolveStructureIssueSeverity(options.runtimeConfig);
  const sourceSeverity = resolveSourceIssueSeverity(options.runtimeConfig);

  if (reviewRequired) {
    const reviewFresh = Boolean(
      review &&
      review.path === path &&
      review.fileVersion === readNumber$d(file.version) &&
      publishProtocol.reviewAfterLatestContentChange === true
    );
    if (!reviewFresh) {
      issues.push(createIssue({
        code: "missing_latest_candidate_review",
        message: "Candidate must be reviewed by AI after the latest content change before publish.",
        severity: ISSUE_BLOCKING,
        status: review ? "stale" : "missing",
        path,
        expectedAction: "workspace_review_candidate"
      }));
    }
  }

  if (review && review.readyToPublish !== true) {
    issues.push(createIssue({
      code: "ai_review_not_ready",
      message: "AI self-review did not mark the candidate ready to publish.",
      severity: publishDecision === "ready" ? ISSUE_BLOCKING : ISSUE_ADVISORY,
      path,
      status: "not_ready"
    }));
  }

  for (const item of requirementsChecklist) {
    if (item.kind !== "objective") continue;
    if (item.status !== "partial" && item.status !== "unmet") continue;
    issues.push(createIssue({
      code: "objective_requirement_unmet",
      message: `AI self-review marked objective requirement as ${item.status}: ${item.requirement}`,
      requirementId: item.id,
      severity: publishDecision === "ready" ? ISSUE_BLOCKING : ISSUE_ADVISORY,
      path,
      status: item.status
    }));
  }

  const structure = inspectWorkspaceCandidateStructure(content);
  if (structure && structure.ok === false) {
    const codes = Array.isArray(structure.issueCodes) ? structure.issueCodes : [];
    for (const code of codes) {
      issues.push(createIssue({
        code,
        message: `Candidate structure issue: ${code}.`,
        severity: structureIssueSeverity(code, structureSeverity),
        path,
        samples: readStructureSamples(structure, code)
      }));
    }
  }

  const finalSectionTitle = readFinalSectionTitle({ review, options });
  const contentAfterFinalSection = finalSectionTitle
    ? inspectContentAfterFinalSection(content, finalSectionTitle)
    : null;
  if (contentAfterFinalSection && contentAfterFinalSection.hasContentAfterFinalSection) {
    issues.push(createIssue({
      code: "content_after_final_section",
      message: `Candidate has major section headings after final section "${finalSectionTitle}".`,
      severity: ISSUE_BLOCKING,
      path,
      finalSectionTitle,
      followingHeadings: contentAfterFinalSection.followingHeadings
    }));
  }

  const citationAudit = inspectCitedUrlEvidence(content, runState);
  if (
    requestedCitations &&
    requestedCitations.minUrlCount > 0 &&
    citationAudit.citedUrlCount < requestedCitations.minUrlCount
  ) {
    issues.push(createIssue({
      code: "missing_required_cited_urls",
      message: `Candidate cites ${citationAudit.citedUrlCount}/${requestedCitations.minUrlCount} requested URL(s).`,
      severity: sourceSeverity.missing_required_cited_urls,
      path,
      citedUrlCount: citationAudit.citedUrlCount,
      minUrlCount: requestedCitations.minUrlCount
    }));
  }
  for (const cited of citationAudit.citedUrls) {
    if (cited.status === "blocked") {
      issues.push(createIssue({
        code: "blocked_source_cited",
        message: `Candidate cites a blocked or unreadable URL: ${cited.url}`,
        severity: sourceSeverity.blocked_source_cited,
        path,
        qualityTier: cited.qualityTier,
        qualityReason: cited.qualityReason,
        url: cited.url
      }));
    } else if (cited.status === "unread") {
      issues.push(createIssue({
        code: "unread_cited_url",
        message: `Candidate cites a URL that is not backed by successful evidence: ${cited.url}`,
        severity: sourceSeverity.unread_cited_url,
        path,
        url: cited.url
      }));
    }
  }

  const wordCountAudit = inspectWordCountAgreement(content, textStats, requestedLength);
  if (wordCountAudit && wordCountAudit.belowRequested === true) {
    issues.push(createIssue({
      code: "external_word_count_below_target",
      message: `Candidate is below requested word count by whitespace-token count: ${wordCountAudit.externalWords}/${wordCountAudit.requestedWords}.`,
      severity: ISSUE_ADVISORY,
      path,
      externalWords: wordCountAudit.externalWords,
      requestedWords: wordCountAudit.requestedWords,
      runtimeWords: wordCountAudit.runtimeWords
    }));
  }

  const blockingIssues = issues.filter((issue) => issue.severity === ISSUE_BLOCKING);
  const advisoryIssues = issues.filter((issue) => issue.severity !== ISSUE_BLOCKING);
  return {
    advisoryIssueCodes: advisoryIssues.map((issue) => issue.code),
    blockingIssueCodes: blockingIssues.map((issue) => issue.code),
    blockingIssues,
    citationAudit,
    finalSectionTitle: finalSectionTitle || null,
    hasBlockingIssues: blockingIssues.length > 0,
    issueCodes: issues.map((issue) => issue.code),
    issues,
    kind: "candidate_quality_signal",
    ok: blockingIssues.length === 0,
    path,
    publishProtocol,
    requestedCitations,
    requestedLength,
    requirementsChecklist,
    review,
    reviewRequired,
    status: blockingIssues.length > 0 ? "blocked" : advisoryIssues.length > 0 ? "warn" : "pass",
    structure: summarizeStructure(structure),
    textStats,
    version: 1,
    wordCountAudit
  };
}

function normalizeCandidateQualitySignal(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const issues = Array.isArray(source.issues) ? source.issues.map(normalizeIssue).filter(Boolean).slice(0, 24) : [];
  const blockingIssues = issues.filter((issue) => issue.severity === ISSUE_BLOCKING);
  const advisoryIssues = issues.filter((issue) => issue.severity !== ISSUE_BLOCKING);
  return {
    advisoryIssueCodes: advisoryIssues.map((issue) => issue.code),
    blockingIssueCodes: blockingIssues.map((issue) => issue.code),
    blockingIssues,
    citationAudit: source.citationAudit && typeof source.citationAudit === "object" ? source.citationAudit : null,
    finalSectionTitle: readString$1x(source.finalSectionTitle) || null,
    hasBlockingIssues: blockingIssues.length > 0,
    issueCodes: issues.map((issue) => issue.code),
    issues,
    kind: "candidate_quality_signal",
    ok: source.ok === true && blockingIssues.length === 0,
    path: readString$1x(source.path) || null,
    publishProtocol: source.publishProtocol && typeof source.publishProtocol === "object" ? source.publishProtocol : null,
    requestedCitations: source.requestedCitations && typeof source.requestedCitations === "object" ? source.requestedCitations : null,
    requestedLength: source.requestedLength && typeof source.requestedLength === "object" ? source.requestedLength : null,
    requirementsChecklist: normalizeRequirementsChecklist(source.requirementsChecklist),
    review: source.review && typeof source.review === "object" ? source.review : null,
    reviewRequired: source.reviewRequired === true,
    status: readString$1x(source.status) || (blockingIssues.length > 0 ? "blocked" : advisoryIssues.length > 0 ? "warn" : "pass"),
    structure: source.structure && typeof source.structure === "object" ? source.structure : null,
    textStats: source.textStats && typeof source.textStats === "object" ? source.textStats : null,
    version: 1,
    wordCountAudit: source.wordCountAudit && typeof source.wordCountAudit === "object" ? source.wordCountAudit : null
  };
}

function readCandidateReview(workspace, path) {
  const quality = workspace && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : {};
  const review = quality.candidateReview && typeof quality.candidateReview === "object"
    ? quality.candidateReview
    : null;
  if (!review || readString$1x(review.path) !== path) return null;
  return review;
}

function readRequestedLength({ context, finalReadiness, options }) {
  const assessment = finalReadiness && finalReadiness.requirementsAssessment && typeof finalReadiness.requirementsAssessment === "object"
    ? finalReadiness.requirementsAssessment
    : {};
  const requestedFromReadiness = readFiniteNumber$4(assessment.requestedLength);
  const unitFromReadiness = normalizeLengthUnit(assessment.observedLengthUnit);
  if (requestedFromReadiness != null && requestedFromReadiness > 0) {
    return {
      statsKey: unitToStatsKey(unitFromReadiness),
      unit: unitFromReadiness,
      value: requestedFromReadiness
    };
  }
  const explicit = options.requestedLength && typeof options.requestedLength === "object"
    ? options.requestedLength
    : null;
  if (explicit && readFiniteNumber$4(explicit.value) > 0) {
    const unit = normalizeLengthUnit(explicit.unit);
    return {
      statsKey: readString$1x(explicit.statsKey) || unitToStatsKey(unit),
      unit,
      value: readFiniteNumber$4(explicit.value)
    };
  }
  return extractRequestedLengthContract(readTerminalContractText(context)) || null;
}

// AI-first: the runtime never invents a citation requirement by lexical-parsing
// the user prompt. A minimum cited-URL count is honored only when the host
// declares it via options (an explicit numeric contract). The AI-declared case
// is owned by requirementsChecklist and surfaces through objective_requirement_unmet.
function readRequestedCitationContract({ options }) {
  // The host declares the contract via options.requestedCitations, or via the
  // runtime config / per-run request (both host-owned, AI-first: NOT parsed from
  // the user prompt). First explicit numeric contract found wins.
  const runtimeConfig = options.runtimeConfig && typeof options.runtimeConfig === "object" ? options.runtimeConfig : null;
  const request = options.context && options.context.request && typeof options.context.request === "object"
    ? options.context.request
    : null;
  const runState = options.runState && typeof options.runState === "object" ? options.runState : null;
  const candidates = [
    [options.requestedCitations, "options"],
    [runtimeConfig && runtimeConfig.requestedCitations, "runtimeConfig"],
    [request && request.requestedCitations, "request"],
    [runState && runState.requestedCitations, "runState"]
  ];
  for (const [explicit, source] of candidates) {
    if (!explicit || typeof explicit !== "object") continue;
    const explicitMin = readFiniteNumber$4(explicit.minUrlCount || explicit.minUrls || explicit.minSources);
    if (explicitMin && explicitMin > 0) {
      return { minUrlCount: Math.floor(explicitMin), source };
    }
  }
  return null;
}

function inspectWordCountAgreement(content, textStats, requestedLength) {
  if (!requestedLength || requestedLength.unit !== "words") return null;
  const requestedWords = readFiniteNumber$4(requestedLength.value);
  if (!requestedWords || requestedWords <= 0) return null;
  const externalWords = countWhitespaceWords(content);
  const runtimeWords = readNumber$d(textStats && textStats.words);
  return {
    belowRequested: externalWords < requestedWords,
    externalWords,
    requestedWords,
    runtimeWords,
    delta: runtimeWords - externalWords
  };
}

// Source-gate steering (weak-model e2e audit 2026-06-10) — the INVERSE of
// inspectCitedUrlEvidence: which readable sources the run already read are
// NOT cited inline in the candidate. All three weak models read 3-4 strong
// sources yet failed the cited>=3 acceptance gate because nothing ever told
// them the diff. Facts only: the model decides which sources it actually
// used and where to cite them.
function buildCitationCoverageAudit(content, runState) {
  const text = typeof content === "string" ? content : "";
  const evidence = collectReadSourceEvidence(runState);
  const cited = new Set(extractUrls(text).map((url) => normalizeUrl(url)));
  const uncitedReadUrls = [];
  let citedReadableCount = 0;
  for (const [normalized, source] of evidence.byUrl) {
    if (!isReadableEvidenceSource(source)) continue;
    if (cited.has(normalized)) {
      citedReadableCount += 1;
      continue;
    }
    uncitedReadUrls.push({
      title: readString$1x(source.title) || null,
      url: readString$1x(source.url)
    });
  }
  const audit = {
    kind: "citation_coverage_audit",
    citedUrlCount: cited.size,
    citedReadableCount,
    readableReadCount: evidence.readableCount,
    uncitedReadUrls: uncitedReadUrls.slice(0, 8),
    message: null
  };
  if (uncitedReadUrls.length > 0) {
    const listed = audit.uncitedReadUrls.map((entry) => entry.url).join(", ");
    audit.message = `Citation coverage: the candidate cites ${citedReadableCount} of the ${evidence.readableCount} readable source(s) this run actually read. Read but NOT cited inline: ${listed}. If the user asked for cited sources, add inline citations for the sources you used BEFORE publishing — citing a source you read is always better than publishing with an uncited claim.`;
  }
  return audit;
}

function inspectCitedUrlEvidence(content, runState) {
  const urls = extractUrls(content);
  const evidence = collectReadSourceEvidence(runState);
  return {
    citedUrls: urls.map((url) => {
      const source = evidence.byUrl.get(normalizeUrl(url));
      if (!source) {
        return { status: "unread", url };
      }
      const detail = explainReadSourceQuality(source);
      return {
        ok: isReadableEvidenceSource(source),
        qualityReason: detail.reason,
        qualityTier: detail.tier,
        status: isReadableEvidenceSource(source) ? "readable" : "blocked",
        url
      };
    }).slice(0, 24),
    citedUrlCount: urls.length,
    readableEvidenceUrlCount: evidence.readableCount,
    readSourceUrlCount: evidence.totalCount
  };
}

function collectReadSourceEvidence(runState) {
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  const byUrl = new Map();
  let readableCount = 0;
  for (const source of readSources) {
    const url = readString$1x(source && source.url);
    if (!url) continue;
    byUrl.set(normalizeUrl(url), source);
    if (isReadableEvidenceSource(source)) readableCount += 1;
  }
  return {
    byUrl,
    readableCount,
    totalCount: readSources.filter((source) => readString$1x(source && source.url)).length
  };
}

function inspectContentAfterFinalSection(content, finalSectionTitle) {
  const target = normalizeHeadingLabel(finalSectionTitle);
  if (!target) return null;
  const headings = collectHeadingLines(content);
  const finalIndex = headings.findIndex((heading) => normalizeHeadingLabel(heading.text) === target);
  if (finalIndex < 0) return {
    finalSectionFound: false,
    followingHeadings: [],
    hasContentAfterFinalSection: false
  };
  const finalHeading = headings[finalIndex];
  const followingHeadings = headings
    .slice(finalIndex + 1)
    .filter((heading) => heading.level <= finalHeading.level)
    .map((heading) => ({
      level: heading.level,
      lineNumber: heading.lineNumber,
      text: heading.text
    }))
    .slice(0, 8);
  return {
    finalSectionFound: true,
    followingHeadings,
    hasContentAfterFinalSection: followingHeadings.length > 0
  };
}

function readFinalSectionTitle({ review, options }) {
  const reviewTitle = readString$1x(review && review.finalSectionTitle);
  if (reviewTitle) return reviewTitle;
  const optionTitle = readString$1x(options && options.finalSectionTitle);
  if (optionTitle) return optionTitle;
  return "";
}

function collectHeadingLines(content) {
  const value = typeof content === "string" ? content : "";
  if (!value.trim()) return [];
  const lines = value.split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = readString$1x(lines[index]);
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!match) continue;
    headings.push({
      level: match[1].length,
      lineNumber: index + 1,
      text: readString$1x(match[2])
    });
  }
  return headings;
}

function extractUrls(content) {
  const sourceContent = typeof content === "string" ? content : "";
  const seen = new Set();
  const urls = [];
  const re = /https?:\/\/[^\s<>)\]}"]+/gi;
  let match;
  while ((match = re.exec(sourceContent)) !== null) {
    const url = cleanupUrl(match[0]);
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls.slice(0, 48);
}

function cleanupUrl(value) {
  return readString$1x(value).replace(/[.,;:!?]+$/g, "");
}

function normalizeUrl(value) {
  try {
    const url = new URL(cleanupUrl(value));
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/g, "");
    return url.toString();
  } catch {
    return cleanupUrl(value).toLowerCase();
  }
}

function readStructureSamples(structure, code) {
  if (code === "duplicate_headings") {
    return Array.isArray(structure.repeatedHeadingSamples) ? structure.repeatedHeadingSamples.slice(0, 5) : [];
  }
  if (code === "duplicate_section_numbers") {
    return Array.isArray(structure.repeatedNumberSamples) ? structure.repeatedNumberSamples.slice(0, 5) : [];
  }
  return [];
}

function summarizeStructure(structure) {
  const source = structure && typeof structure === "object" ? structure : {};
  return {
    duplicateHeadingCount: readNumber$d(source.duplicateHeadingCount),
    duplicateNumberCount: readNumber$d(source.duplicateNumberCount),
    headingCount: readNumber$d(source.headingCount),
    issueCodes: Array.isArray(source.issueCodes) ? source.issueCodes.map(readString$1x).filter(Boolean).slice(0, 12) : [],
    ok: source.ok === true,
    reason: readString$1x(source.reason) || null,
    status: readString$1x(source.status) || "unknown"
  };
}

function createIssue(value) {
  return normalizeIssue(value);
}

function normalizeIssue(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const code = readString$1x(source.code);
  if (!code) return null;
  return {
    code,
    expectedAction: readString$1x(source.expectedAction) || null,
    field: readString$1x(source.field) || null,
    finalSectionTitle: readString$1x(source.finalSectionTitle) || null,
    followingHeadings: Array.isArray(source.followingHeadings) ? source.followingHeadings.slice(0, 8) : [],
    message: readString$1x(source.message) || code,
    path: readString$1x(source.path) || null,
    qualityReason: readString$1x(source.qualityReason) || null,
    qualityTier: readString$1x(source.qualityTier) || null,
    requirementId: readString$1x(source.requirementId) || null,
    samples: Array.isArray(source.samples) ? source.samples.slice(0, 8) : [],
    severity: readString$1x(source.severity) === ISSUE_ADVISORY ? ISSUE_ADVISORY : ISSUE_BLOCKING,
    status: readString$1x(source.status) || null,
    url: readString$1x(source.url) || null,
    citedUrlCount: readFiniteNumber$4(source.citedUrlCount),
    externalWords: readFiniteNumber$4(source.externalWords),
    minUrlCount: readFiniteNumber$4(source.minUrlCount),
    requestedWords: readFiniteNumber$4(source.requestedWords),
    runtimeWords: readFiniteNumber$4(source.runtimeWords)
  };
}

function normalizeRequirementsChecklist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeRequirement(entry, index))
    .filter(Boolean)
    .slice(0, 24);
}

function normalizeRequirement(value, index) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const requirement = readString$1x(source.requirement || source.summary || source.text);
  if (!requirement) return null;
  const id = readString$1x(source.id) || `requirement_${index + 1}`;
  return {
    evidence: readString$1x(source.evidence).slice(0, 360) || null,
    id: id.slice(0, 80),
    kind: normalizeRequirementKind(source.kind || source.type),
    remainingGap: readString$1x(source.remainingGap || source.gap).slice(0, 360) || null,
    repairAction: readString$1x(source.repairAction || source.repairPlan).slice(0, 360) || null,
    requirement: requirement.slice(0, 360),
    status: normalizeRequirementStatus(source.status || source.result)
  };
}

function normalizeRequirementKind(value) {
  const text = readString$1x(value).toLowerCase();
  if (text === "objective" || text === "fact" || text === "measurable") return "objective";
  if (text === "subjective" || text === "editorial" || text === "quality") return "subjective";
  return "unknown";
}

function normalizeRequirementStatus(value) {
  const text = readString$1x(value).toLowerCase();
  if (text === "met" || text === "pass" || text === "passed" || text === "done") return "met";
  if (text === "partial" || text === "partially_met" || text === "partly_met") return "partial";
  if (text === "unmet" || text === "fail" || text === "failed" || text === "missing") return "unmet";
  return "unknown";
}

function readTextStats(stats, content) {
  const source = stats && typeof stats === "object" ? stats : {};
  const text = readString$1x(content);
  const words = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: readNumber$d(source.chars) || text.length,
    cjkChars: readNumber$d(source.cjkChars) || cjkChars.length,
    nonWhitespaceChars: readNumber$d(source.nonWhitespaceChars) || text.replace(/\s/g, "").length,
    words: readNumber$d(source.words) || words.length
  };
}

function countWhitespaceWords(value) {
  const text = readString$1x(value);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function normalizeHeadingLabel(value) {
  return readString$1x(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .replace(/^\d{1,3}(?:\.\d{1,3})*\.?\s+/, "")
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeLengthUnit(value) {
  const text = readString$1x(value).toLowerCase();
  if (text === "words" || text === "word") return "words";
  if (text === "cjk_chars" || text === "cjkchars" || text === "\u5b57" || text === "\u5b57\u6570") return "cjk_chars";
  if (text === "chars" || text === "char" || text === "characters") return "chars";
  return "chars";
}

function unitToStatsKey(unit) {
  if (unit === "words") return "words";
  if (unit === "cjk_chars") return "cjkChars";
  return "chars";
}

function readFiniteNumber$4(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumber$d(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString$1x(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildCandidateQualitySignal, buildCitationCoverageAudit, normalizeCandidateQualitySignal };
