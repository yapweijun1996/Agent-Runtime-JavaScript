import { readEvidencePolicy, countStructuredToolEvidence } from './evidence-policy.js';
import { isSuccessfulReadUrlArtifact } from './read-source-quality.js';
import { readString, readFiniteNumber } from './semantic-json.js';

function normalizeFinalReadiness(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const decision = readString(value.decision);
  if (decision !== "ready" && decision !== "limited") {
    return null;
  }
  const requirementsAssessment = normalizeRequirementsAssessment(
    value.requirementsAssessment || value.selfAudit
  );
  const normalized = {
    decision,
    evidenceMode: readString(value.evidenceMode) || null,
    limitations: readString(value.limitations) || null
  };
  if (requirementsAssessment) {
    normalized.requirementsAssessment = requirementsAssessment;
  }
  return normalized;
}

function createFinalReadinessAssessment(options = {}) {
  const runState = options.runState && typeof options.runState === "object" ? options.runState : {};
  const finalReadiness = normalizeFinalReadiness(options.finalReadiness);
  const quality = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    && runState.virtualWorkspace.quality && typeof runState.virtualWorkspace.quality === "object"
    ? runState.virtualWorkspace.quality
    : {};
  const researchState = runState.researchState && typeof runState.researchState === "object"
    ? runState.researchState
    : {};
  const finalCandidateStats = normalizeTextStats$5(quality.finalCandidateStats);
  const successfulReadUrlCount = countSuccessfulReadUrlArtifacts(runState);
  const successfulEvidenceCount = countSuccessfulEvidenceArtifacts(runState, options.runtimeConfig);
  const observed = {
    finalCandidateReady: quality.finalCandidateReady === true,
    finalCandidateStats,
    researchFinalAllowed: researchState.finalAllowed === true,
    researchFinalReason: readString(researchState.finalReason) || null,
    researchGaps: Array.isArray(researchState.gaps)
      ? researchState.gaps.map(readString).filter(Boolean).slice(0, 12)
      : [],
    researchQualityGateRequired: researchState.qualityGateRequired === true,
    successfulEvidenceCount,
    successfulReadUrlCount
  };
  const hasAssessment = Boolean(finalReadiness && finalReadiness.requirementsAssessment);
  const result = {
    ai: hasAssessment ? finalReadiness.requirementsAssessment : null,
    observed,
    status: hasAssessment ? "declared" : "missing"
  };
  return result;
}

function countSuccessfulReadUrlArtifacts(runState) {
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  // AGRUN-491 (audit M12) — the transport-success predicate is the SSOT
  // isSuccessfulReadUrlArtifact in read-source-quality.js (co-located with the
  // content-quality isReadableEvidenceSource so the two layers stay explicit).
  return readSources.filter(isSuccessfulReadUrlArtifact).length;
}

function normalizeRequirementsAssessment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return {
    checkedReadinessAgainstUserRequest: value.checkedReadinessAgainstUserRequest === true,
    checkedEvidence: value.checkedEvidence === true,
    checkedReadUrlEvidence: value.checkedReadUrlEvidence === true,
    checkedWorkspaceStats: value.checkedWorkspaceStats === true,
    evidenceSatisfied: typeof value.evidenceSatisfied === "boolean" ? value.evidenceSatisfied : null,
    lengthSatisfied: typeof value.lengthSatisfied === "boolean" ? value.lengthSatisfied : null,
    observedLength: readFiniteNumber(value.observedLength) ?? readFiniteNumber(value.actualLength),
    observedLengthUnit: normalizeLengthUnit$1(value.observedLengthUnit || value.lengthUnit),
    remainingGaps: Array.isArray(value.remainingGaps)
      ? value.remainingGaps.map(readString).filter(Boolean).slice(0, 12)
      : [],
    requestedLength: readFiniteNumber(value.requestedLength),
    requirementSatisfied: typeof value.requirementSatisfied === "boolean" ? value.requirementSatisfied : null,
    summary: readString(value.summary) || null,
    successfulEvidenceCount: readFiniteNumber(value.successfulEvidenceCount),
    successfulReadUrlCount: readFiniteNumber(value.successfulReadUrlCount),
    userRequirementSummary: readString(value.userRequirementSummary) || null
  };
}

function countSuccessfulEvidenceArtifacts(runState, runtimeConfig) {
  const policy = readEvidencePolicy(runtimeConfig);
  if (policy.enabled === false) return 0;
  const readUrlCount = countSuccessfulReadUrlArtifacts(runState);
  const structuredToolCount = policy.structuredToolEvidence
    ? countStructuredToolEvidence(runState)
    : 0;
  return readUrlCount + structuredToolCount;
}

function normalizeTextStats$5(value) {
  const source = value && typeof value === "object" ? value : {};
  const hasAny = ["chars", "nonWhitespaceChars", "cjkChars", "words"].some((key) => Number.isFinite(source[key]));
  if (!hasAny) return null;
  return {
    chars: readNumber$l(source.chars),
    cjkChars: readNumber$l(source.cjkChars),
    nonWhitespaceChars: readNumber$l(source.nonWhitespaceChars),
    words: readNumber$l(source.words)
  };
}

function normalizeLengthUnit$1(value) {
  const text = readString(value).toLowerCase();
  if (text === "word" || text === "words") return "words";
  if (text === "token" || text === "tokens") return "tokens";
  if (text === "cjk_chars" || text.includes("\u4e2d\u6587") || text === "\u5b57" || text === "\u5b57\u6570") return "cjk_chars";
  if (text === "\u5b57\u7b26" || text === "char" || text === "chars" || text === "characters") return "chars";
  return "chars";
}

function readNumber$l(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export { countSuccessfulEvidenceArtifacts, countSuccessfulReadUrlArtifacts, createFinalReadinessAssessment, normalizeFinalReadiness };
