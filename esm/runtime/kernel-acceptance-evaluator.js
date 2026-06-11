import { cloneValue } from './utils.js';

// Kernel acceptance-evaluator DATA only; the acceptance hook seam was removed.
//
// Chunk A of the kernel-seam removal deletes runtime acceptance-evaluator hook
// wiring. This file keeps only the generic data plumbing core still needs:
// the empty state-slot shape and read-only planner-prompt projection.


// --- Pure-data plumbing moved verbatim from research-acceptance-evaluator.js
// (AGRUN-313 2.2). Local coercers kept identical to the behavior file's (0-default
// readNumber) so the projection is byte-identical; the behavior file keeps its own
// copies for its own use.
function readString$1F(value) {
  return typeof value === "string" ? value.trim() : "";
}
function readNumber$h(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function readNullableNumber$5(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Empty state-slot shape. state.js initializes runState.researchAcceptanceEvaluator
// with this; the research refresh hook (when wired) populates it in place.
function createResearchAcceptanceEvaluatorState() {
  return {
    acceptanceConvergenceSignal: null,
    activeConflictDimensions: [],
    lastCandidateStats: null,
    lastConflictCodes: [],
    lastObservableDeficits: null,
    lastSourceMinimum: null,
    lastSuccessfulEvidenceCount: 0,
    lastSuccessfulReadUrlCount: 0,
    repeatedLengthReadinessConflictCount: 0,
    repeatedPublishBlockCount: 0,
    repeatedReadinessConflictCount: 0,
    repeatedSourceReadinessConflictCount: 0,
    sourceProgressSignals: [],
    status: "tracking",
    stepsWithoutNewEvidence: 0,
    workspaceProgressSignals: [],
    version: 1
  };
}

function buildNextMoveContract$1(signal) {
  const dimensions = Array.isArray(signal.activeConflictDimensions)
    ? signal.activeConflictDimensions.map(readString$1F).filter(Boolean)
    : [];
  const moves = Array.isArray(signal.allowedNextMoves)
    ? signal.allowedNextMoves.map(readString$1F).filter(Boolean)
    : [];
  const deficits = signal.observableDeficits && typeof signal.observableDeficits === "object"
    ? signal.observableDeficits
    : null;
  const deficitText = deficits
    ? [
        readNumber$h(deficits.readSourceDeficit) > 0 ? `readSourceDeficit=${readNumber$h(deficits.readSourceDeficit)}` : "",
        readNumber$h(deficits.relevantSourceDeficit) > 0 ? `relevantSourceDeficit=${readNumber$h(deficits.relevantSourceDeficit)}` : "",
        readNumber$h(deficits.lengthDeficit) > 0 ? `lengthDeficit=${readNumber$h(deficits.lengthDeficit)} ${readString$1F(deficits.lengthUnit) || ""}`.trim() : ""
      ].filter(Boolean).join(", ")
    : "";
  return [
    `acceptanceConvergenceSignal forbids clean ready for dimensions=${dimensions.join(",") || "readiness"}.`,
    deficitText ? `Observable deficits: ${deficitText}.` : "",
    `Allowed next moves: ${moves.join(", ") || "continue evidence/workspace work or limited publish"}.`,
    "If stopping, publish limited with concrete remainingGaps and flags that match the deficits."
  ].filter(Boolean).join(" ");
}

// Read-only projection of the slot for the planner prompt (null-safe).
function summarizeResearchAcceptanceEvaluator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const signal = value.acceptanceConvergenceSignal && typeof value.acceptanceConvergenceSignal === "object"
    ? value.acceptanceConvergenceSignal
    : null;
  const sourceMinimum = value.lastSourceMinimum && typeof value.lastSourceMinimum === "object"
    ? value.lastSourceMinimum
    : null;
  const candidate = value.lastCandidateStats && typeof value.lastCandidateStats === "object"
    ? value.lastCandidateStats
    : null;
  const deficits = value.lastObservableDeficits && typeof value.lastObservableDeficits === "object"
    ? value.lastObservableDeficits
    : null;
  return {
    activeConflictDimensions: Array.isArray(value.activeConflictDimensions)
      ? value.activeConflictDimensions.map(readString$1F).filter(Boolean).slice(0, 6)
      : [],
    status: readString$1F(value.status) || "tracking",
    repeatedSourceReadinessConflictCount: readNumber$h(value.repeatedSourceReadinessConflictCount),
    repeatedLengthReadinessConflictCount: readNumber$h(value.repeatedLengthReadinessConflictCount),
    repeatedReadinessConflictCount: readNumber$h(value.repeatedReadinessConflictCount),
    repeatedPublishBlockCount: readNumber$h(value.repeatedPublishBlockCount),
    stepsWithoutNewEvidence: readNumber$h(value.stepsWithoutNewEvidence),
    lastSuccessfulEvidenceCount: readNumber$h(value.lastSuccessfulEvidenceCount),
    lastSuccessfulReadUrlCount: readNumber$h(value.lastSuccessfulReadUrlCount),
    lastConflictCodes: Array.isArray(value.lastConflictCodes)
      ? value.lastConflictCodes.map(readString$1F).filter(Boolean).slice(0, 8)
      : [],
    sourceMinimum: sourceMinimum ? {
      passed: sourceMinimum.passed === true,
      reads: readNumber$h(sourceMinimum.readSources),
      minReads: readNumber$h(sourceMinimum.minReadSources),
      relevant: readNumber$h(sourceMinimum.relevantSources),
      minRelevant: readNumber$h(sourceMinimum.minRelevantSources)
    } : null,
    candidate: candidate ? {
      path: readString$1F(candidate.path) || null,
      chars: readNullableNumber$5(candidate.chars),
      cjkChars: readNullableNumber$5(candidate.cjkChars),
      words: readNullableNumber$5(candidate.words)
    } : null,
    observableDeficits: deficits ? {
      lengthDeficit: readNullableNumber$5(deficits.lengthDeficit),
      lengthObserved: readNullableNumber$5(deficits.lengthObserved),
      lengthRequested: readNullableNumber$5(deficits.lengthRequested),
      lengthUnit: readString$1F(deficits.lengthUnit) || null,
      readSourceDeficit: readNullableNumber$5(deficits.readSourceDeficit),
      relevantSourceDeficit: readNullableNumber$5(deficits.relevantSourceDeficit)
    } : null,
    sourceProgressSignals: Array.isArray(value.sourceProgressSignals)
      ? value.sourceProgressSignals.map(readString$1F).filter(Boolean).slice(0, 8)
      : [],
    workspaceProgressSignals: Array.isArray(value.workspaceProgressSignals)
      ? value.workspaceProgressSignals.map(readString$1F).filter(Boolean).slice(0, 8)
      : [],
    acceptanceConvergenceSignal: signal ? {
      kind: readString$1F(signal.kind) || "acceptance_convergence_signal",
      status: readString$1F(signal.status) || null,
      reason: readString$1F(signal.reason) || null,
      forbiddenReadiness: readString$1F(signal.forbiddenReadiness) || null,
      allowedNextMoves: Array.isArray(signal.allowedNextMoves)
        ? signal.allowedNextMoves.map(readString$1F).filter(Boolean).slice(0, 6)
        : [],
      requiredLimitedFields: Array.isArray(signal.requiredLimitedFields)
        ? signal.requiredLimitedFields.map(readString$1F).filter(Boolean).slice(0, 6)
        : [],
      requiredCorrection: signal.requiredCorrection && typeof signal.requiredCorrection === "object"
        ? cloneValue(signal.requiredCorrection)
        : null,
      observableDeficits: signal.observableDeficits && typeof signal.observableDeficits === "object"
        ? cloneValue(signal.observableDeficits)
        : null
    } : null,
    nextMoveContract: signal
      ? buildNextMoveContract$1(signal)
      : null
  };
}

export { createResearchAcceptanceEvaluatorState, summarizeResearchAcceptanceEvaluator };
