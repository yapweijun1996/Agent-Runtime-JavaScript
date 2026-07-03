import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';

// Kernel acceptance-evaluator DATA only; the acceptance hook seam was removed.
//
// Chunk A of the kernel-seam removal deletes runtime acceptance-evaluator hook
// wiring. This file keeps only the generic data plumbing core still needs:
// the empty state-slot shape and read-only planner-prompt projection.



// --- Pure-data plumbing moved verbatim from research-acceptance-evaluator.js
// (AGRUN-313 2.2). Local coercers kept identical to the behavior file's (0-default
// readNumber) so the projection is byte-identical; the behavior file keeps its own
// copies for its own use.

function readNumber$e(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function readNullableNumber$4(value) {
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
    ? signal.activeConflictDimensions.map(readString).filter(Boolean)
    : [];
  const moves = Array.isArray(signal.allowedNextMoves)
    ? signal.allowedNextMoves.map(readString).filter(Boolean)
    : [];
  const deficits = signal.observableDeficits && typeof signal.observableDeficits === "object"
    ? signal.observableDeficits
    : null;
  const deficitText = deficits
    ? [
        readNumber$e(deficits.readSourceDeficit) > 0 ? `readSourceDeficit=${readNumber$e(deficits.readSourceDeficit)}` : "",
        readNumber$e(deficits.relevantSourceDeficit) > 0 ? `relevantSourceDeficit=${readNumber$e(deficits.relevantSourceDeficit)}` : "",
        readNumber$e(deficits.lengthDeficit) > 0 ? `lengthDeficit=${readNumber$e(deficits.lengthDeficit)} ${readString(deficits.lengthUnit) || ""}`.trim() : ""
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
      ? value.activeConflictDimensions.map(readString).filter(Boolean).slice(0, 6)
      : [],
    status: readString(value.status) || "tracking",
    repeatedSourceReadinessConflictCount: readNumber$e(value.repeatedSourceReadinessConflictCount),
    repeatedLengthReadinessConflictCount: readNumber$e(value.repeatedLengthReadinessConflictCount),
    repeatedReadinessConflictCount: readNumber$e(value.repeatedReadinessConflictCount),
    repeatedPublishBlockCount: readNumber$e(value.repeatedPublishBlockCount),
    stepsWithoutNewEvidence: readNumber$e(value.stepsWithoutNewEvidence),
    lastSuccessfulEvidenceCount: readNumber$e(value.lastSuccessfulEvidenceCount),
    lastSuccessfulReadUrlCount: readNumber$e(value.lastSuccessfulReadUrlCount),
    lastConflictCodes: Array.isArray(value.lastConflictCodes)
      ? value.lastConflictCodes.map(readString).filter(Boolean).slice(0, 8)
      : [],
    sourceMinimum: sourceMinimum ? {
      passed: sourceMinimum.passed === true,
      reads: readNumber$e(sourceMinimum.readSources),
      minReads: readNumber$e(sourceMinimum.minReadSources),
      relevant: readNumber$e(sourceMinimum.relevantSources),
      minRelevant: readNumber$e(sourceMinimum.minRelevantSources)
    } : null,
    candidate: candidate ? {
      path: readString(candidate.path) || null,
      chars: readNullableNumber$4(candidate.chars),
      cjkChars: readNullableNumber$4(candidate.cjkChars),
      words: readNullableNumber$4(candidate.words)
    } : null,
    observableDeficits: deficits ? {
      lengthDeficit: readNullableNumber$4(deficits.lengthDeficit),
      lengthObserved: readNullableNumber$4(deficits.lengthObserved),
      lengthRequested: readNullableNumber$4(deficits.lengthRequested),
      lengthUnit: readString(deficits.lengthUnit) || null,
      readSourceDeficit: readNullableNumber$4(deficits.readSourceDeficit),
      relevantSourceDeficit: readNullableNumber$4(deficits.relevantSourceDeficit)
    } : null,
    sourceProgressSignals: Array.isArray(value.sourceProgressSignals)
      ? value.sourceProgressSignals.map(readString).filter(Boolean).slice(0, 8)
      : [],
    workspaceProgressSignals: Array.isArray(value.workspaceProgressSignals)
      ? value.workspaceProgressSignals.map(readString).filter(Boolean).slice(0, 8)
      : [],
    acceptanceConvergenceSignal: signal ? {
      kind: readString(signal.kind) || "acceptance_convergence_signal",
      status: readString(signal.status) || null,
      reason: readString(signal.reason) || null,
      forbiddenReadiness: readString(signal.forbiddenReadiness) || null,
      allowedNextMoves: Array.isArray(signal.allowedNextMoves)
        ? signal.allowedNextMoves.map(readString).filter(Boolean).slice(0, 6)
        : [],
      requiredLimitedFields: Array.isArray(signal.requiredLimitedFields)
        ? signal.requiredLimitedFields.map(readString).filter(Boolean).slice(0, 6)
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
