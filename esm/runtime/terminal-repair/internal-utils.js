import { cloneValue } from '../utils.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from '../workspace-candidate-lifecycle.js';
import { PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { inspectWorkspacePublishProtocol } from '../virtual-workspace.js';

// H10 split, Step 1 (AGRUN-503) — terminal-repair internal utilities.
// VERBATIM moves from terminal-repair-state.js (see
// agrun_docs/terminal-repair-split-design-2026-06-12.md). This module is the
// dependency LEAF of the terminal-repair split: state-shape constructor +
// threshold policy + read/normalize coercion helpers + the small shared
// workspace/protocol readers used by every other terminal-repair module.
// Two functions here are PUBLIC API, re-exported through the
// terminal-repair-state.js barrel: createTerminalRepairState,
// resolveTerminalRepairThresholds. (The design doc placed them in core; they
// live here because publish-contract.js needs createTerminalRepairState and
// the import graph must stay acyclic — documented amendment.)

const DEFAULT_VALID_PUBLISH_EXCEPTION =
  "workspace_publish_candidate with finalReadiness.decision=limited, non-empty remainingGaps, and false flags for failed dimensions";

// ADR-0013 / AGRUN-237 PR 2: escalate to hard_veto after this many ignored terminal
// attempts when budget is exhausted — mirrors READ_ONLY_PLANNING_HARD_VETO_THRESHOLD.
const TERMINAL_REPAIR_HARD_VETO_THRESHOLD = 3;

// AGRUN-237-GAP-01: high-water-mark fires hard_veto regardless of budget when the model
// ignores too many advisory blocks — prevents 87-cycle wasted loops on weak models.
// Value 6 fires at ~cycle 65 in a 90-step run (25 cycles remaining), based on v8/v9b data.
const TERMINAL_REPAIR_HIGH_WATER_MARK = 6;

const TERMINAL_REPAIR_ADVISORY_SIGNAL_THRESHOLD = 3;

// AGRUN-307 — absolute cumulative cap on no-progress terminal/maintenance
// attempts ACROSS the whole run. The per-state ignoredCount/highWaterMark
// above lives on terminalRepairState and is RESET by clearTerminalRepairState;
// a clear<->reactivate oscillation (deficits transiently empty then return as
// terminal_loop) therefore keeps resetting it below the threshold — observed
// live in the gpt-low rerun (ignoredCount sawtoothed 0->2->0->...->2, never
// reaching 6, so the escape never fired and the run burned to the deadline).
// This cumulative counter lives on runState and SURVIVES clear, so a genuinely
// stuck run still converges to the escape. Higher than highWaterMark so the
// per-state path fires first on non-oscillating loops; only sustained churn
// across clears reaches it. Healthy runs make progress (cycles are not ignored)
// so they never approach it.
const TERMINAL_REPAIR_ABSOLUTE_IGNORED_CAP = 8;

// AGRUN-542 — content-level structure repair attempt budget. Once length and
// read sources are satisfied but semantic_duplicate_headings /
// body_after_final_section remain on the final candidate, the model gets
// exactly this many content-changing repair attempts (candidate file-version
// advances) before the runtime forces the honest limited-publish exit. See
// terminal-repair/content-structure-exit.js.
const TERMINAL_REPAIR_CONTENT_STRUCTURE_REPAIR_ATTEMPTS = 1;

// AGRUN: thresholds are host-overridable policy, not hardcoded runtime law.
// Defaults preserve the historical behavior; a host can retune escalation via
// runtimeConfig.terminalRepair.thresholds without forking the runtime. The
// resolved values are surfaced read-only through the advisory persistence
// signal (vetoThreshold) so the planner can see the live policy.
const DEFAULT_TERMINAL_REPAIR_THRESHOLDS = Object.freeze({
  hardVeto: TERMINAL_REPAIR_HARD_VETO_THRESHOLD,
  highWaterMark: TERMINAL_REPAIR_HIGH_WATER_MARK,
  advisorySignal: TERMINAL_REPAIR_ADVISORY_SIGNAL_THRESHOLD,
  absoluteIgnoredCap: TERMINAL_REPAIR_ABSOLUTE_IGNORED_CAP,
  contentStructureRepairAttempts: TERMINAL_REPAIR_CONTENT_STRUCTURE_REPAIR_ATTEMPTS
});

function readPositiveThreshold(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function resolveTerminalRepairThresholds(runtimeConfig) {
  const cfg = runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
    ? runtimeConfig
    : {};
  const repair = cfg.terminalRepair && typeof cfg.terminalRepair === "object" && !Array.isArray(cfg.terminalRepair)
    ? cfg.terminalRepair
    : {};
  const overrides = repair.thresholds && typeof repair.thresholds === "object" && !Array.isArray(repair.thresholds)
    ? repair.thresholds
    : {};
  return {
    hardVeto: readPositiveThreshold(overrides.hardVeto, DEFAULT_TERMINAL_REPAIR_THRESHOLDS.hardVeto),
    highWaterMark: readPositiveThreshold(overrides.highWaterMark, DEFAULT_TERMINAL_REPAIR_THRESHOLDS.highWaterMark),
    advisorySignal: readPositiveThreshold(overrides.advisorySignal, DEFAULT_TERMINAL_REPAIR_THRESHOLDS.advisorySignal),
    absoluteIgnoredCap: readPositiveThreshold(overrides.absoluteIgnoredCap, DEFAULT_TERMINAL_REPAIR_THRESHOLDS.absoluteIgnoredCap),
    contentStructureRepairAttempts: readPositiveThreshold(
      overrides.contentStructureRepairAttempts,
      DEFAULT_TERMINAL_REPAIR_THRESHOLDS.contentStructureRepairAttempts
    )
  };
}

function createTerminalRepairState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  return {
    kind: "terminal_repair_state",
    active,
    mode: readString$4(source.mode) || (active ? "terminal_repair" : "none"),
    reason: readString$4(source.reason) || null,
    activeDeficits: readStringArray$4(source.activeDeficits).slice(0, 8),
    observableDeficits: normalizeObservableDeficits(source.observableDeficits),
    allowedActions: readStringArray$4(source.allowedActions).slice(0, 16),
    budgetState: readString$4(source.budgetState) || "unknown",
    escalation: readString$4(source.escalation) === "hard_veto" ? "hard_veto" : "advisory",
      forbiddenDecisions: readStringArray$4(source.forbiddenDecisions).slice(0, 8),
      requiredRepair: readString$4(source.requiredRepair) || null,
      validPublishContract: normalizeValidPublishContract(source.validPublishContract),
      lengthExpansionSignal: normalizeLengthExpansionSignal(source.lengthExpansionSignal),
      workspaceRepairSignal: normalizeWorkspaceRepairSignal(source.workspaceRepairSignal),
      advisoryPersistenceSignal: normalizeAdvisoryPersistenceSignal(source.advisoryPersistenceSignal),
      actionOrderingSignals: normalizeActionOrderingSignals(source.actionOrderingSignals),
      ignoredCount: readNumber$j(source.ignoredCount),
    activatedAtCycle: readNullableNumber$7(source.activatedAtCycle),
    lastUpdatedAtCycle: readNullableNumber$7(source.lastUpdatedAtCycle),
    lastIgnoredAtCycle: readNullableNumber$7(source.lastIgnoredAtCycle),
    progressSnapshot: normalizeProgressSnapshot$1(source.progressSnapshot),
    clearedReason: active ? null : (readString$4(source.clearedReason) || null),
    version: 1
  };
}

function readRecord$1(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readString$4(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray$4(value) {
  return Array.isArray(value) ? value.map(readString$4).filter(Boolean) : [];
}

function readNumber$j(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function readNullableNumber$7(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function mentionsGap(gaps, keywords) {
  const text = readStringArray$4(gaps).join(" ").toLowerCase();
  return keywords.some((keyword) => text.includes(keyword));
}

function mentionsStructureGap(gaps) {
  return mentionsGap(gaps, [
    "structure",
    "heading",
    "headings",
    "section",
    "sections",
    "duplicate",
    "number",
    "numbering",
    "outline"
  ]);
}

function normalizeUrlKey$2(value) {
  const url = readString$4(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function readCandidateUrl(candidate) {
  const source = readRecord$1(candidate);
  if (!source) return "";
  return readString$4(source.url) || readString$4(source.link) || readString$4(source.href);
}

function readSearchPassItems(searchPasses) {
  if (!Array.isArray(searchPasses)) return [];
  const items = [];
  for (const pass of searchPasses) {
    if (Array.isArray(pass && pass.items)) items.push(...pass.items);
    if (Array.isArray(pass && pass.rankedItems)) items.push(...pass.rankedItems);
  }
  return items;
}

function summarizeTextStats$1(value) {
  const text = readString$4(value);
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

function readWorkspaceFileStats(runState, path) {
  const workspace = readRecord$1(runState && runState.virtualWorkspace);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && path ? files[path] : null;
  const stats = readRecord$1(file && file.textStats);
  if (stats) return stats;
  if (file && typeof file === "object" && typeof file.content === "string") {
    return summarizeTextStats$1(file.content);
  }
  return null;
}

function observableDeficitsRecord(observableDeficits, key) {
  const source = readRecord$1(observableDeficits);
  return readRecord$1(source && source[key]);
}

function readFinalCandidatePathFromWorkspace(runState) {
  const workspace = readRecord$1(runState && runState.virtualWorkspace);
  const quality = readRecord$1(workspace && workspace.quality);
  return readString$4(quality && quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
}

function readCurrentPublishProtocol(runState) {
  const workspace = readRecord$1(runState && runState.virtualWorkspace);
  if (!workspace) return null;
  return inspectWorkspacePublishProtocol(workspace, readFinalCandidatePathFromWorkspace(runState));
}

function readCandidateStatsFromWorkspace(runState) {
  const workspace = readRecord$1(runState && runState.virtualWorkspace);
  const path = readFinalCandidatePathFromWorkspace(runState);
  const file = workspace && workspace.files && workspace.files[path] && typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  return readRecord$1(file && file.textStats);
}

function hasSelectedFinalCandidateContent(runState) {
  const workspace = readRecord$1(runState && runState.virtualWorkspace);
  const path = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && path ? files[path] : null;
  if (!file || typeof file !== "object") return false;
  if (readString$4(file.content)) return true;
  const stats = readRecord$1(file.textStats);
  return readNumber$j(stats && stats.words) > 0 ||
    readNumber$j(stats && stats.chars) > 0 ||
    readNumber$j(stats && stats.cjkChars) > 0;
}

function readOnlyPlanningHardVetoForbiddenActions(runState) {
  const convergence = readRecord$1(runState && runState.actionPatternConvergence);
  const state = readRecord$1(convergence && convergence.readOnlyPlanningState);
  if (!state || state.active !== true) return new Set();
  if (readString$4(state.escalation) !== "hard_veto") return new Set();
  return new Set(readStringArray$4(state.forbiddenActions));
}

function workspaceMutationGrowthHardVetoForbiddenActions(runState) {
  const convergence = readRecord$1(runState && runState.actionPatternConvergence);
  const state = readRecord$1(convergence && convergence.workspaceMutationGrowthConvergence);
  if (!state || state.active !== true || readString$4(state.escalation) !== "hard_veto") return new Set();
  return new Set(readStringArray$4(state.forbiddenActions));
}

function isTerminalAttempt(actionName, context) {
  const name = readString$4(actionName);
  if (name === PUBLISH_DIRECT_ACTION || name === "finalize" || name === "final") return true;
  const type = readString$4(context && context.decision && context.decision.type);
  return type === "finalize" || type === "final";
}

function isTerminalCompleted$1(actionName, context) {
  if (!isTerminalAttempt(actionName, context)) return false;
  const output = readRecord$1(context && context.output);
  if (readString$4(output && output.kind) === "final_response") return true;
  if (readString$4(output && output.control) === "complete") return true;
  return readString$4(context && context.status) === "complete";
}

function normalizeReadinessIssues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const issue = readRecord$1(entry);
      if (!issue) return null;
      return {
        code: readString$4(issue.code) || "readiness_payload_mismatch",
        correction: readString$4(issue.correction) || null,
        declared: issue.declared != null ? issue.declared : null,
        field: readString$4(issue.field) || null,
        observed: issue.observed != null ? issue.observed : null,
        unit: readString$4(issue.unit) || null
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeStructureSamples$1(value, key) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const label = readString$4(entry[key]);
      if (!label) return null;
      return {
        count: readNumber$j(entry.count),
        [key]: label.slice(0, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeStructureContexts(value, key) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const source = readRecord$1(entry);
      const label = readString$4(source && source[key]);
      if (!label) return null;
      return {
        count: readNumber$j(source.count),
        [key]: label.slice(0, 160),
        occurrences: Array.isArray(source.occurrences)
          ? source.occurrences.map((occurrence) => {
              const item = readRecord$1(occurrence);
              if (!item) return null;
              return {
                lineNumber: readNumber$j(item.lineNumber),
                raw: readString$4(item.raw).slice(0, 180)
              };
            }).filter((item) => item && item.lineNumber > 0 && item.raw).slice(0, 8)
          : []
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeSectionNumberRepairHints(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const source = readRecord$1(entry);
      if (!source) return null;
      const lineNumber = readNumber$j(source.lineNumber);
      if (!lineNumber) return null;
      return {
        candidateNumber: readString$4(source.candidateNumber) || null,
        currentNumber: readString$4(source.currentNumber) || null,
        lineNumber,
        raw: readString$4(source.raw).slice(0, 180)
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeTextStats$2(value) {
  const source = readRecord$1(value) || {};
  return {
    chars: readNumber$j(source.chars),
    cjkChars: readNumber$j(source.cjkChars),
    words: readNumber$j(source.words)
  };
}

function normalizeHeadingOutlineEntry(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  const lineNumber = readNumber$j(source.lineNumber);
  const text = readString$4(source.text);
  if (!lineNumber || !text) return null;
  return {
    level: readNumber$j(source.level),
    lineNumber,
    number: readString$4(source.number) || null,
    text: text.slice(0, 160)
  };
}

function normalizeSectionDelta(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  return {
    heading: readString$4(source.heading).slice(0, 120),
    observed: readNumber$j(source.observed),
    target: readNumber$j(source.target),
    gap: readNumber$j(source.gap)
  };
}

function normalizeObservableDeficits(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    length: source.length && typeof source.length === "object" ? cloneValue(source.length) : null,
    readiness: source.readiness && typeof source.readiness === "object" ? cloneValue(source.readiness) : null,
    source: source.source && typeof source.source === "object" ? cloneValue(source.source) : null,
    structure: source.structure && typeof source.structure === "object" ? cloneValue(source.structure) : null,
    todo: source.todo && typeof source.todo === "object" ? cloneValue(source.todo) : null
  };
}

function normalizeValidPublishContract(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    decision: readString$4(source.decision) || "limited",
    remainingGaps: readString$4(source.remainingGaps) || "non-empty string array with concrete blockers",
    evidenceSatisfied: source.evidenceSatisfied === false ? false : readString$4(source.evidenceSatisfied) || "match observed evidence facts",
    lengthSatisfied: source.lengthSatisfied === false ? false : readString$4(source.lengthSatisfied) || "match observed candidate stats",
    requirementSatisfied: source.requirementSatisfied === false ? false : readString$4(source.requirementSatisfied) || "match observed facts",
    structureRequirement: readString$4(source.structureRequirement) || "not blocking",
    todoRequirement: readString$4(source.todoRequirement) || "not blocking",
    budgetState: readString$4(source.budgetState) || "unknown",
    observableDeficits: normalizeObservableDeficits(source.observableDeficits),
    requiredArgsExample: source.requiredArgsExample && typeof source.requiredArgsExample === "object" && !Array.isArray(source.requiredArgsExample)
      ? cloneValue(source.requiredArgsExample)
      : null,
    validTerminalException: readString$4(source.validTerminalException) || DEFAULT_VALID_PUBLISH_EXCEPTION
    };
}

function normalizeLengthExpansionSignal(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  const observed = readNumber$j(source.observed);
  const requested = readNumber$j(source.requested);
  if (!requested || observed >= requested) return null;
  return {
    kind: readString$4(source.kind) || "lengthExpansionSignal",
    observed,
    requested,
    unit: readString$4(source.unit) || "words",
    gap: readNumber$j(source.gap) || Math.max(requested - observed, 0),
    perSectionDelta: Array.isArray(source.perSectionDelta)
      ? source.perSectionDelta.map(normalizeSectionDelta).filter(Boolean).slice(0, 8)
      : [],
    averageSectionGap: readNumber$j(source.averageSectionGap),
    iterationCount: readNumber$j(source.iterationCount)
  };
}

function normalizeWorkspaceRepairSignal(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  const path = readString$4(source.path);
  if (!path) return null;
  const candidate = readRecord$1(source.candidate);
  const latestReadStatus = readRecord$1(source.latestReadStatus);
  const structure = readRecord$1(source.structure);
  const citation = readRecord$1(source.citation);
  const sourceSummary = readRecord$1(source.sourceSummary);
  const sectionPurposeSignal = readRecord$1(source.sectionPurposeSignal);
  return {
    kind: readString$4(source.kind) || "workspace_repair_signal",
    path,
    reason: readString$4(source.reason) || "workspace_repair_required",
    budgetState: readString$4(source.budgetState) || "unknown",
    escalation: readString$4(source.escalation) === "hard_veto" ? "hard_veto" : "advisory",
    latestReadStatus: latestReadStatus ? {
      latestWriteIndex: readNumber$j(latestReadStatus.latestWriteIndex),
      latestFinalizeIndex: readNumber$j(latestReadStatus.latestFinalizeIndex),
      latestReadIndex: readNumber$j(latestReadStatus.latestReadIndex),
      readAfterLatestContentChange: latestReadStatus.readAfterLatestContentChange === true,
      readAfterFinalize: latestReadStatus.readAfterFinalize === true
    } : null,
    mustInspectCandidate: source.mustInspectCandidate === true,
    destructiveMutationRequiresInspection: source.destructiveMutationRequiresInspection === true,
    candidate: candidate ? {
      path: readString$4(candidate.path) || path,
      textStats: normalizeTextStats$2(candidate.textStats),
      requestedLength: candidate.requestedLength == null ? null : readNumber$j(candidate.requestedLength),
      requestedLengthUnit: readString$4(candidate.requestedLengthUnit) || null,
      lengthDeficit: readNumber$j(candidate.lengthDeficit),
      headingOutline: Array.isArray(candidate.headingOutline)
        ? candidate.headingOutline.map(normalizeHeadingOutlineEntry).filter(Boolean).slice(0, 24)
        : []
    } : null,
    sectionPurposeSignal: sectionPurposeSignal ? {
      kind: readString$4(sectionPurposeSignal.kind) || "section_purpose_signal",
      status: readString$4(sectionPurposeSignal.status) || "unknown",
      nearDuplicateHeadingPairs: Array.isArray(sectionPurposeSignal.nearDuplicateHeadingPairs)
        ? sectionPurposeSignal.nearDuplicateHeadingPairs.map(normalizeNearDuplicateHeadingPair).filter(Boolean).slice(0, 6)
        : [],
      guidance: readString$4(sectionPurposeSignal.guidance).slice(0, 300) || null
    } : null,
    structure: structure ? {
      issueCodes: readStringArray$4(structure.issueCodes).slice(0, 8),
      reason: readString$4(structure.reason) || null,
      status: readString$4(structure.status) || "unknown",
      repeatedHeadingSamples: normalizeStructureSamples$1(structure.repeatedHeadingSamples, "heading"),
      repeatedNumberSamples: normalizeStructureSamples$1(structure.repeatedNumberSamples, "number"),
      repeatedHeadingContexts: normalizeStructureContexts(structure.repeatedHeadingContexts, "heading"),
      repeatedNumberContexts: normalizeStructureContexts(structure.repeatedNumberContexts, "number"),
      semanticDuplicateHeadingContexts: normalizeSemanticDuplicateHeadingContexts$2(structure.semanticDuplicateHeadingContexts),
      bodyAfterFinalSectionContexts: normalizeBodyAfterFinalSectionContexts$2(structure.bodyAfterFinalSectionContexts),
      sectionNumberRepairHints: normalizeSectionNumberRepairHints(structure.sectionNumberRepairHints),
      sectionSequenceRepairHints: normalizeSectionNumberRepairHints(structure.sectionSequenceRepairHints)
    } : null,
    citation: citation ? {
      issueCodes: readStringArray$4(citation.issueCodes).slice(0, 8),
      issues: Array.isArray(citation.issues)
        ? citation.issues.map((issue) => {
            const item = readRecord$1(issue);
            if (!item) return null;
            const code = readString$4(item.code);
            const url = readString$4(item.url);
            return code && url ? {
              code,
              qualityReason: readString$4(item.qualityReason) || null,
              qualityTier: readString$4(item.qualityTier) || null,
              url: url.slice(0, 300)
            } : null;
          }).filter(Boolean).slice(0, 8)
        : [],
      unreadCitedUrls: readStringArray$4(citation.unreadCitedUrls).slice(0, 8),
      blockedCitedUrls: readStringArray$4(citation.blockedCitedUrls).slice(0, 8)
    } : null,
    sourceSummary: sourceSummary ? {
      readSources: readNumber$j(sourceSummary.readSources),
      relevantSources: readNumber$j(sourceSummary.relevantSources),
      minReadSources: readNumber$j(sourceSummary.minReadSources),
      minRelevantSources: readNumber$j(sourceSummary.minRelevantSources),
      successfulReadUrlCount: readNumber$j(sourceSummary.successfulReadUrlCount),
      samples: Array.isArray(sourceSummary.samples)
        ? sourceSummary.samples.map((sample) => {
            const item = readRecord$1(sample);
            if (!item) return null;
            const title = readString$4(item.title);
            return title ? {
              title: title.slice(0, 120),
              url: readString$4(item.url).slice(0, 200) || null
            } : null;
          }).filter(Boolean).slice(0, 5)
        : []
    } : null,
    recommendedActionOrder: readStringArray$4(source.recommendedActionOrder).slice(0, 10)
  };
}

// AGRUN-509 — normalization validates SHAPE only; it must NOT re-gate the
// stored signal against the DEFAULT advisory threshold. The policy gate lives
// in buildAdvisoryPersistenceSignal (signals.js), which reads the HOST-RESOLVED
// thresholds. The old default-const re-gate here silently DROPPED a stored
// signal whenever a host lowered thresholds.advisorySignal below the default
// (e.g. 2 < 3): `previous.advisoryPersistenceSignal` then looked null every
// cycle, so evaluateTerminalRepairState re-set advisoryThresholdFirstCrossed
// each cycle and the "fire once" persistence step re-emitted every cycle.
function normalizeAdvisoryPersistenceSignal(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  const ignoredCount = readNumber$j(source.ignoredCount);
  return {
    kind: readString$4(source.kind) || "terminal_repair_advisory_persistence_signal",
    ignoredCount,
    vetoThreshold: readNumber$j(source.vetoThreshold) || TERMINAL_REPAIR_HIGH_WATER_MARK,
    stepsRemainingBeforeHardVeto: readNumber$j(source.stepsRemainingBeforeHardVeto),
    advisoryThresholdFirstCrossed: source.advisoryThresholdFirstCrossed === true
  };
}

function normalizeActionOrderingSignals(value) {
  return Array.isArray(value)
    ? value.map(normalizeActionOrderingSignal).filter(Boolean).slice(0, 4)
    : [];
}

function normalizeActionOrderingSignal(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  const kind = readString$4(source.kind);
  if (!kind) return null;
  return {
    kind,
    preferredActions: readStringArray$4(source.preferredActions).slice(0, 8),
    reason: readString$4(source.reason) || null,
    workspaceWriteCount: readNumber$j(source.workspaceWriteCount)
  };
}

function normalizeNearDuplicateHeadingPair(value) {
  const source = readRecord$1(value);
  if (!source) return null;
  const first = readRecord$1(source.first);
  const second = readRecord$1(source.second);
  const firstText = readString$4(first && first.text);
  const secondText = readString$4(second && second.text);
  if (!firstText || !secondText) return null;
  return {
    first: {
      lineNumber: readNumber$j(first && first.lineNumber),
      text: firstText.slice(0, 160)
    },
    second: {
      lineNumber: readNumber$j(second && second.lineNumber),
      text: secondText.slice(0, 160)
    },
    similarity: readNumber$j(source.similarity)
  };
}

function normalizeSemanticDuplicateHeadingContexts$2(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = readRecord$1(entry);
      const first = readRecord$1(source && source.first);
      const second = readRecord$1(source && source.second);
      const firstRaw = readString$4(first && first.raw);
      const secondRaw = readString$4(second && second.raw);
      if (!firstRaw || !secondRaw) return null;
      return {
        first: {
          lineNumber: readNumber$j(first && first.lineNumber),
          raw: firstRaw.slice(0, 160)
        },
        relation: readString$4(source && source.relation) || "similar",
        second: {
          lineNumber: readNumber$j(second && second.lineNumber),
          raw: secondRaw.slice(0, 160)
        }
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeBodyAfterFinalSectionContexts$2(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = readRecord$1(entry);
      const raw = readString$4(source && source.raw);
      if (!raw) return null;
      return {
        lineNumber: readNumber$j(source && source.lineNumber),
        raw: raw.slice(0, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeProgressSnapshot$1(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    successfulReadUrlCount: readNumber$j(source.successfulReadUrlCount),
    readSources: readNumber$j(source.readSources),
    relevantSources: readNumber$j(source.relevantSources),
    sourceMinimumPassed: source.sourceMinimumPassed === true,
    candidateWords: readNumber$j(source.candidateWords),
    candidateChars: readNumber$j(source.candidateChars),
    candidateCjkChars: readNumber$j(source.candidateCjkChars),
    workspaceVersion: readNumber$j(source.workspaceVersion),
    structureOk: source.structureOk === true,
    todoUnfinishedCount: readNumber$j(source.todoUnfinishedCount)
  };
}

export { DEFAULT_TERMINAL_REPAIR_THRESHOLDS, DEFAULT_VALID_PUBLISH_EXCEPTION, TERMINAL_REPAIR_ABSOLUTE_IGNORED_CAP, TERMINAL_REPAIR_ADVISORY_SIGNAL_THRESHOLD, TERMINAL_REPAIR_CONTENT_STRUCTURE_REPAIR_ATTEMPTS, TERMINAL_REPAIR_HARD_VETO_THRESHOLD, TERMINAL_REPAIR_HIGH_WATER_MARK, createTerminalRepairState, hasSelectedFinalCandidateContent, isTerminalAttempt, isTerminalCompleted$1 as isTerminalCompleted, mentionsGap, mentionsStructureGap, normalizeActionOrderingSignal, normalizeActionOrderingSignals, normalizeAdvisoryPersistenceSignal, normalizeBodyAfterFinalSectionContexts$2 as normalizeBodyAfterFinalSectionContexts, normalizeHeadingOutlineEntry, normalizeLengthExpansionSignal, normalizeNearDuplicateHeadingPair, normalizeObservableDeficits, normalizeProgressSnapshot$1 as normalizeProgressSnapshot, normalizeReadinessIssues, normalizeSectionDelta, normalizeSectionNumberRepairHints, normalizeSemanticDuplicateHeadingContexts$2 as normalizeSemanticDuplicateHeadingContexts, normalizeStructureContexts, normalizeStructureSamples$1 as normalizeStructureSamples, normalizeTextStats$2 as normalizeTextStats, normalizeUrlKey$2 as normalizeUrlKey, normalizeValidPublishContract, normalizeWorkspaceRepairSignal, observableDeficitsRecord, readCandidateStatsFromWorkspace, readCandidateUrl, readCurrentPublishProtocol, readFinalCandidatePathFromWorkspace, readNullableNumber$7 as readNullableNumber, readNumber$j as readNumber, readOnlyPlanningHardVetoForbiddenActions, readPositiveThreshold, readRecord$1 as readRecord, readSearchPassItems, readString$4 as readString, readStringArray$4 as readStringArray, readWorkspaceFileStats, resolveTerminalRepairThresholds, summarizeTextStats$1 as summarizeTextStats, workspaceMutationGrowthHardVetoForbiddenActions };
