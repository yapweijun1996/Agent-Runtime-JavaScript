import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';

// AGRUN-214m — Thread-scoped research SSOT.
//
// The long-research subsystem (researchEvidenceGraph, researchReportLoop,
// researchState.topic, researchFinalEnvelope) used to live only on
// runState. Because runState is rebuilt every run, a finalize-only
// follow-up turn ("Finalize from the already collected ...") arrived
// with empty topic/graph and re-extracted the topic from the follow-up
// text, producing a malformed topic/title.
//
// This module serializes the durable subset of research state into a
// thread slice and applies it back onto a fresh runState. It is the L1
// (thread-scope) counterpart to the existing L2 (run-scope) state, and
// follows the same pattern as `goalAnchor` and `todoState` thread fields.



const SLICE_VERSION = 1;
const MAX_OBSERVATIONS = 64;
const MAX_SOURCE_ARTIFACTS = 32;
const MAX_CLAIM_GRAPH = 32;

function normalizeResearchSlice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const topic = readString(value.topic);
  const evidenceGraph = trimEvidenceGraph(value.evidenceGraph);
  const reportLoop = trimReportLoop(value.reportLoop);
  const finalEnvelope = value.finalEnvelope && typeof value.finalEnvelope === "object"
    ? cloneValue(value.finalEnvelope)
    : null;
  const hasContent = topic
    || evidenceGraph
    || reportLoop
    || finalEnvelope;
  if (!hasContent) return null;
  return {
    entityKey: readString(value.entityKey),
    evidenceGraph,
    finalEnvelope,
    lastTurnId: readString(value.lastTurnId) || null,
    reportLoop,
    topic,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : null,
    version: SLICE_VERSION
  };
}

/**
 * Build a thread-persistable slice from the current runState. Returns
 * `null` when the run did not produce any research artefacts worth
 * persisting (avoids stamping every turn with empty state).
 */
function serializeResearchSlice(runState, options) {
  if (!runState || typeof runState !== "object") return null;
  const opts = options && typeof options === "object" ? options : {};
  const topic = readString(runState.researchState && runState.researchState.topic)
    || readString(runState.researchEvidenceGraph && runState.researchEvidenceGraph.topic);
  const graph = runState.researchEvidenceGraph;
  const loop = runState.researchReportLoop;
  const envelope = runState.researchFinalEnvelope;
  const hasGraph = graph && typeof graph === "object"
    && (Array.isArray(graph.sourceArtifacts) && graph.sourceArtifacts.length > 0
      || Array.isArray(graph.observations) && graph.observations.length > 0
      || Array.isArray(graph.claimGraph) && graph.claimGraph.length > 0);
  const hasLoop = loop && typeof loop === "object"
    && (loop.enabled === true
      || (typeof loop.status === "string" && loop.status && loop.status !== "idle")
      || readString(loop.finalMode));
  const hasEnvelope = envelope && typeof envelope === "object";
  if (!topic && !hasGraph && !hasLoop && !hasEnvelope) {
    return null;
  }
  return normalizeResearchSlice({
    entityKey: readString(graph && graph.entity && graph.entity.key),
    evidenceGraph: hasGraph ? graph : null,
    finalEnvelope: hasEnvelope ? envelope : null,
    lastTurnId: readString(opts.turnId) || readString(runState.runId) || null,
    reportLoop: hasLoop ? loop : null,
    topic,
    updatedAt: typeof opts.now === "number" ? opts.now : Date.now()
  });
}

/**
 * Apply a hydrated thread slice onto a fresh runState. Mutates runState
 * in place to mirror the existing `hydrateRunStateWithThread` style.
 * Safe to call with `null` slice (no-op) so legacy threads pass through.
 */
function applyResearchSliceToRunState(runState, slice) {
  if (!runState || typeof runState !== "object") return runState;
  const normalized = normalizeResearchSlice(slice);
  if (!normalized) return runState;
  if (normalized.evidenceGraph) {
    runState.researchEvidenceGraph = cloneValue(normalized.evidenceGraph);
  }
  if (normalized.reportLoop) {
    runState.researchReportLoop = {
      ...(runState.researchReportLoop || {}),
      ...cloneValue(normalized.reportLoop)
    };
  }
  if (normalized.finalEnvelope) {
    runState.researchFinalEnvelope = cloneValue(normalized.finalEnvelope);
  }
  if (normalized.topic) {
    if (!runState.researchState || typeof runState.researchState !== "object") {
      runState.researchState = {};
    }
    if (!readString(runState.researchState.topic)) {
      runState.researchState.topic = normalized.topic;
    }
  }
  runState.researchThreadSlice = {
    entityKey: normalized.entityKey,
    lastTurnId: normalized.lastTurnId,
    topic: normalized.topic,
    updatedAt: normalized.updatedAt,
    version: SLICE_VERSION
  };
  return runState;
}

function trimEvidenceGraph(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cloned = cloneValue(value);
  if (Array.isArray(cloned.observations) && cloned.observations.length > MAX_OBSERVATIONS) {
    cloned.observations = cloned.observations.slice(-MAX_OBSERVATIONS);
  }
  if (Array.isArray(cloned.sourceArtifacts) && cloned.sourceArtifacts.length > MAX_SOURCE_ARTIFACTS) {
    cloned.sourceArtifacts = cloned.sourceArtifacts.slice(-MAX_SOURCE_ARTIFACTS);
  }
  if (Array.isArray(cloned.claimGraph) && cloned.claimGraph.length > MAX_CLAIM_GRAPH) {
    cloned.claimGraph = cloned.claimGraph.slice(-MAX_CLAIM_GRAPH);
  }
  if (Array.isArray(cloned.claimEvidence) && cloned.claimEvidence.length > MAX_CLAIM_GRAPH) {
    cloned.claimEvidence = cloned.claimEvidence.slice(-MAX_CLAIM_GRAPH);
  }
  return cloned;
}

// AGRUN-217 / ADR-0012 — thread-scope report-loop snapshot. Drops
// the deleted action-selection fields (coverageSearchAttempts,
// coverageTargets, independentSearchAttempts) and adds gateSignal +
// recentQueries to mirror the new mechanism-only loop state.
function trimReportLoop(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    authorityCoverage: value.authorityCoverage && typeof value.authorityCoverage === "object"
      ? cloneValue(value.authorityCoverage)
      : null,
    enabled: value.enabled === true,
    finalMode: readString(value.finalMode) || null,
    gateSignal: value.gateSignal && typeof value.gateSignal === "object"
      ? cloneValue(value.gateSignal)
      : null,
    lastTopic: readString(value.lastTopic) || null,
    recentQueries: Array.isArray(value.recentQueries)
      ? cloneValue(value.recentQueries).slice(-20)
      : [],
    sourceMinimum: value.sourceMinimum && typeof value.sourceMinimum === "object"
      ? cloneValue(value.sourceMinimum)
      : null,
    status: readString(value.status) || "idle",
    vetoCount: typeof value.vetoCount === "number" ? value.vetoCount : 0,
    version: typeof value.version === "number" ? value.version : 2
  };
}

export { applyResearchSliceToRunState, normalizeResearchSlice, serializeResearchSlice };
