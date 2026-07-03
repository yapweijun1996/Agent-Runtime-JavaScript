// Kernel report-loop DATA only; the report-loop hook seam was removed.
//
// Chunk A of the kernel-seam removal deletes runtime report-loop hook wiring.
// This file keeps only the generic data plumbing that core still needs:
// the config normalizer and empty state-slot factory.

// --- Pure-data plumbing moved from research-report-loop.js (AGRUN-313 2.2):
// the config normalizer + the empty state-slot factory. Constants + readPositiveInteger
// are copied (the behavior file keeps its own copies for its 13 internal uses); these
// are generic config defaults, not research logic.
//
// AGRUN-455 (ADR-0052 micro-kernel) — CORE ships NO numeric research SOURCE-MINIMUM
// default. "How many sources are enough" is a research-domain semantic, not a kernel
// opinion, so `DEFAULT_MIN_READ_SOURCES`/`DEFAULT_MIN_RELEVANT_SOURCES` were removed
// from here. When the host supplies neither minReadSources/minRelevantSources nor the
// minEvidenceArtifacts aliases, the normalizer leaves them absent (0). A research
// skill that wants the 3/2 evidence gate supplies it via config (the old
// research-report-loop.js refreshGate algorithm was removed in AGRUN-522 — the
// judgment is the skill's job). The remaining loop-BUDGET defaults below (vetoes / search passes) are
// generic mechanism, kept in core. The resulting sourceMinimum stays a NON-BLOCKING
// observable signal — AI owns finalize-with-limitations.
const DEFAULT_MAX_RESEARCH_LOOP_VETOES = 4;
const DEFAULT_MAX_INDEPENDENT_SEARCH_ATTEMPTS = 2;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_SEARCH_PASSES = 2;

function readPositiveInteger$h(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

// Generic host-config plumbing; kept here to avoid low-value pack import churn.
function normalizeResearchReportLoopConfig(value) {
  if (value === false) {
    return {
      allowFinalWithLimitationsOnBudgetExhausted: true,
      enabled: false,
      limit: DEFAULT_SEARCH_LIMIT,
      maxIndependentSearchAttempts: DEFAULT_MAX_INDEPENDENT_SEARCH_ATTEMPTS,
      maxPasses: DEFAULT_SEARCH_PASSES,
      maxResearchLoopVetoes: DEFAULT_MAX_RESEARCH_LOOP_VETOES,
      minEvidenceArtifacts: 0,
      minRelevantEvidenceArtifacts: 0,
      minReadSources: 0,
      minRelevantSources: 0
    };
  }
  const source = value && typeof value === "object" ? value : {};
  // AGRUN-455 — no kernel fallback: absent host minimum stays 0 here; the research
  // pack overlays its 3/2 default at refreshGate. Host override still wins via either
  // the minReadSources/minRelevantSources keys or the minEvidenceArtifacts aliases.
  const minReadSources = readPositiveInteger$h(source.minReadSources) ||
    readPositiveInteger$h(source.minEvidenceArtifacts) || 0;
  const minRelevantSources = readPositiveInteger$h(source.minRelevantSources) ||
    readPositiveInteger$h(source.minRelevantEvidenceArtifacts) || 0;
  return {
    allowFinalWithLimitationsOnBudgetExhausted: source.allowFinalWithLimitationsOnBudgetExhausted !== false,
    enabled: source.enabled !== false,
    limit: readPositiveInteger$h(source.limit) || DEFAULT_SEARCH_LIMIT,
    maxIndependentSearchAttempts: readPositiveInteger$h(source.maxIndependentSearchAttempts) || DEFAULT_MAX_INDEPENDENT_SEARCH_ATTEMPTS,
    maxPasses: readPositiveInteger$h(source.maxPasses) || DEFAULT_SEARCH_PASSES,
    maxResearchLoopVetoes: readPositiveInteger$h(source.maxResearchLoopVetoes) || DEFAULT_MAX_RESEARCH_LOOP_VETOES,
    minEvidenceArtifacts: minReadSources,
    minRelevantEvidenceArtifacts: minRelevantSources,
    minReadSources,
    minRelevantSources
  };
}

function createResearchReportLoopState() {
  return {
    authorityCoverage: null,
    claimEvidence: [],
    claimGraph: [],
    cycles: [],
    enabled: false,
    finalMode: null,
    gateSignal: null,
    lastSearchAttempt: null,
    lastTopic: null,
    recentQueries: [],
    recoveryMode: null,
    evidenceMinimum: null,
    sourceMinimum: null,
    status: "idle",
    vetoCount: 0,
    version: 2
  };
}

export { createResearchReportLoopState, normalizeResearchReportLoopConfig };
