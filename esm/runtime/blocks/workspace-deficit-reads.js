import { readString, readNumber } from '../semantic-json.js';

// Shared workspace-deficit readers, extracted from action-loop-action.js
// (AGRUN-450 slice 3). These pure projections read the research report-loop
// acceptance packet + the virtual workspace to answer "is the candidate short on
// length / sources / structure?". They are the Layer-1 substrate that several
// preflight gates (length-deficit, satisfied-candidate, no-progress,
// source-deficit-after-publish) all build on.
//
// Extracting them FIRST (before those gates) is deliberate: the readers depend on
// nothing in action-loop-action.js, so the remaining gates can import them
// directly in later slices without the dependency-injection dance that slices 1-2
// used while these readers still lived in the god file.


// Non-negative number reader: non-finite -> 0 (NOT semantic-json's readFiniteNumber,
// which returns null; the Math.max deficit math relies on the 0 fallback).
// readNumber(value, 0) is the canonical "-> 0" SSOT.
function readFiniteNumber$6(value) {
  return readNumber(value, 0);
}

function readWorkspaceSourceDeficit(runState) {
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : null;
  const evidence = packet && packet.evidence && typeof packet.evidence === "object"
    ? packet.evidence
    : {};
  const sourceMinimum = evidence.sourceMinimum && typeof evidence.sourceMinimum === "object"
    ? evidence.sourceMinimum
    : runState && runState.researchReportLoop && runState.researchReportLoop.sourceMinimum && typeof runState.researchReportLoop.sourceMinimum === "object"
      ? runState.researchReportLoop.sourceMinimum
      : null;
  if (!sourceMinimum || sourceMinimum.passed === true) return null;
  const minReadSources = readFiniteNumber$6(sourceMinimum.minReadSources);
  const minRelevantSources = readFiniteNumber$6(sourceMinimum.minRelevantSources);
  const readSources = readFiniteNumber$6(sourceMinimum.readSources);
  const relevantSources = readFiniteNumber$6(sourceMinimum.relevantSources);
  const readSourceDeficit = Math.max(minReadSources - readSources, 0);
  const relevantSourceDeficit = Math.max(minRelevantSources - relevantSources, 0);
  if (readSourceDeficit <= 0 && relevantSourceDeficit <= 0) return null;
  const lengthStatus = readWorkspaceRequestedLengthStatus(packet);
  return {
    lengthSatisfied: lengthStatus ? lengthStatus.satisfied : null,
    minReadSources,
    minRelevantSources,
    observedLength: lengthStatus ? lengthStatus.observed : null,
    requestedLength: lengthStatus ? lengthStatus.requested : null,
    requestedLengthUnit: lengthStatus ? lengthStatus.unit : null,
    readSourceDeficit,
    readSources,
    relevantSourceDeficit,
    relevantSources,
    successfulReadUrlCount: readFiniteNumber$6(evidence.successfulReadUrlCount)
  };
}

function readWorkspaceRequestedLengthStatus(packet) {
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const statsKey = readString(requested && requested.statsKey);
  const requestedValue = readFiniteNumber$6(requested && requested.value);
  if (!statsKey || requestedValue <= 0) return null;
  const candidate = packet && packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
    ? packet.workspace.candidate
    : packet && packet.candidate && typeof packet.candidate === "object"
      ? packet.candidate
      : null;
  const stats = candidate && candidate.stats && typeof candidate.stats === "object"
    ? candidate.stats
    : candidate && candidate.textStats && typeof candidate.textStats === "object"
      ? candidate.textStats
      : null;
  const observed = readFiniteNumber$6(stats && stats[statsKey]);
  return {
    observed,
    requested: requestedValue,
    satisfied: observed >= requestedValue,
    statsKey,
    unit: readString(requested.unit) || statsKey
  };
}

function hasWorkspaceStructureDeficit(runState) {
  const structure = readWorkspaceStructureDeficit(runState);
  return Boolean(structure && structure.ok === false);
}

function readWorkspaceStructureDeficit(runState) {
  const structure = runState &&
    runState.virtualWorkspace &&
    runState.virtualWorkspace.quality &&
    runState.virtualWorkspace.quality.finalCandidateStructure &&
    typeof runState.virtualWorkspace.quality.finalCandidateStructure === "object"
    ? runState.virtualWorkspace.quality.finalCandidateStructure
    : null;
  if (!structure || structure.ok !== false) return null;
  return {
    ok: false,
    status: readString(structure.status) || "fail",
    reason: readString(structure.reason) || "candidate structure is not publishable",
    issueCodes: Array.isArray(structure.issueCodes)
      ? structure.issueCodes.map(readString).filter(Boolean).slice(0, 8)
      : []
  };
}

function readWorkspaceLengthDeficit(runState) {
  const status = readCurrentWorkspaceLengthStatus(runState);
  if (!status || status.observed >= status.requested) return null;
  return status;
}

function readCurrentWorkspaceLengthStatus(runState) {
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : null;
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const statsKey = readString(requested && requested.statsKey);
  const requestedValue = readFiniteNumber$6(requested && requested.value);
  if (!statsKey || requestedValue <= 0) return null;
  const candidate = packet && packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
    ? packet.workspace.candidate
    : packet && packet.candidate && typeof packet.candidate === "object"
      ? packet.candidate
      : null;
  const stats = candidate && candidate.stats && typeof candidate.stats === "object"
    ? candidate.stats
    : candidate && candidate.textStats && typeof candidate.textStats === "object"
      ? candidate.textStats
      : null;
  const observed = readFiniteNumber$6(stats && stats[statsKey]);
  return {
    observed,
    requested: requestedValue,
    statsKey,
    unit: readString(requested.unit) || statsKey
  };
}

export { hasWorkspaceStructureDeficit, readCurrentWorkspaceLengthStatus, readWorkspaceLengthDeficit, readWorkspaceRequestedLengthStatus, readWorkspaceSourceDeficit, readWorkspaceStructureDeficit };
