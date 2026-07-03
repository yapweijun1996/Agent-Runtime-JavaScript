import { PUBLISH_DIRECT_ACTION } from '../../action-names.js';
import { countSuccessfulEvidenceArtifacts, countSuccessfulReadUrlArtifacts } from '../../final-readiness.js';
import { formatEvidenceRecoveryActions } from '../../evidence-policy.js';
import { isResearchQualityGateRequired } from '../../convergence-activation.js';
import { inspectLimitedRecoveryReadiness } from '../../requirement-recovery-evaluator.js';
import { readString } from '../../semantic-json.js';
import { extractRequestedLengthContract, readTerminalContractText, readStatsKeyForUnit } from '../../terminal-final-contract.js';
import { isValidTerminalRepairPublishArgs } from '../../terminal-repair/publish-contract.js';
import { readNumber } from './workspace-stats.js';

// The core publish-readiness inspector, extracted from
// virtual-workspace-actions.js (AGRUN-451 slice 4 — component C of the
// publish-readiness cluster). inspectPublishReadiness is the main gate the
// publish executor runs before accepting a workspace_publish_candidate; the
// other five are its private helpers (auto-correction log, terminal-repair
// publish allowance, source-minimum read + inspector, research-gate predicate).
// The cluster is closed: every dependency is an SSOT import; the only intra-
// cluster edges are inspectPublishReadiness -> {recordPublishAutoCorrection,
// canPublishLimitedWithTerminalRepair, inspectSourceMinimumPublishReadiness,
// readPublishSourceMinimum, isResearchPublishReadinessRequired}. The publish
// executor imports inspectPublishReadiness / canPublishLimitedWithTerminalRepair
// / isResearchPublishReadinessRequired back.
//
// NOTE: readNumber here is workspace-stats's 1-arg non-finite -> 0 reader (catch
// B: NOT semantic-json's readNumber(value, fallback)); every call site passes one arg.


function inspectPublishReadiness(context, workspace, file, finalReadiness) {
  const readinessRequired = isResearchPublishReadinessRequired(context);
  if (!readinessRequired && !finalReadiness) {
    return { ok: true };
  }
  if (!finalReadiness) {
    return {
      ok: false,
      message: "workspace_publish_candidate requires finalReadiness for this publish. Declare ready or limited with requirementsAssessment based on the latest workspace_read stats."
    };
  }
  const assessment = finalReadiness.requirementsAssessment;
  if (!assessment || typeof assessment !== "object") {
    return {
      ok: false,
      message: "workspace_publish_candidate requires finalReadiness.requirementsAssessment based on the latest workspace_read stats."
    };
  }
  const lastRead = workspace && workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== file.path || !lastRead.textStats) {
    return {
      ok: false,
      message: `workspace_publish_candidate requires the latest workspace_read to review ${file.path} before publish.`
    };
  }
  // AGRUN-244 Phase 3 — structure is a display-only observation, not a publish
  // block. The literal duplicate-heading check is gameable (renamed duplicates
  // evade it); the AI sees the structure facts in observations and decides.
  //
  // AGRUN-402 — runtime no longer flips the AI-declared `checkedWorkspaceStats`
  // boolean from false→true. The lastRead gate above is the runtime-observed
  // SSOT proof that this file's workspace stats were read; the AI's boolean is
  // a redundant self-attestation runtime must not rewrite, and nothing
  // downstream blocks publish on it. Whatever the AI declared stands.
  if (!readString(assessment.observedLengthUnit)) {
    const requestedLength = extractRequestedLengthContract(readTerminalContractText(context));
    const observedUnit = requestedLength ? requestedLength.unit : "chars";
    assessment.observedLengthUnit = observedUnit;
    recordPublishAutoCorrection(context && context.runState, {
      declared: null,
      field: "finalReadiness.requirementsAssessment.observedLengthUnit",
      kind: "observed_length_unit_auto_corrected",
      observed: observedUnit
    });
  }
  const statsKey = readStatsKeyForUnit(assessment.observedLengthUnit);
  const actualObserved = readNumber(lastRead.textStats[statsKey]);
  const observedLength = typeof assessment.observedLength === "number" && Number.isFinite(assessment.observedLength)
    ? assessment.observedLength
    : null;
  if (observedLength == null || observedLength !== actualObserved) {
    assessment.observedLength = actualObserved;
    recordPublishAutoCorrection(context && context.runState, {
      declared: observedLength,
      field: "finalReadiness.requirementsAssessment.observedLength",
      kind: observedLength == null
        ? "observed_length_auto_filled"
        : "observed_length_auto_corrected",
      observed: actualObserved
    });
  }
  const successfulEvidenceCount = typeof assessment.successfulEvidenceCount === "number" && Number.isFinite(assessment.successfulEvidenceCount)
    ? assessment.successfulEvidenceCount
    : null;
  const actualSuccessfulEvidenceCount = countSuccessfulEvidenceArtifacts(context && context.runState, context && context.runtimeConfig);
  const successfulReadUrlCount = typeof assessment.successfulReadUrlCount === "number" && Number.isFinite(assessment.successfulReadUrlCount)
    ? assessment.successfulReadUrlCount
    : null;
  const actualSuccessfulReadUrlCount = countSuccessfulReadUrlArtifacts(context && context.runState);
  if (successfulEvidenceCount != null && successfulEvidenceCount !== actualSuccessfulEvidenceCount) {
    assessment.successfulEvidenceCount = actualSuccessfulEvidenceCount;
    recordPublishAutoCorrection(context && context.runState, {
      declared: successfulEvidenceCount,
      field: "finalReadiness.requirementsAssessment.successfulEvidenceCount",
      kind: "successful_evidence_count_auto_corrected",
      observed: actualSuccessfulEvidenceCount
    });
  }
  if (successfulReadUrlCount != null && successfulReadUrlCount !== actualSuccessfulReadUrlCount) {
    // Fix C1 — auto-correct the AI's mis-declared count to the observed
    // value rather than blocking. Same pattern as Fix A (commit 32d4a7921):
    // when an AI-declared self-report disagrees with a runtime-observed
    // fact runtime already computes (countSuccessfulReadUrlArtifacts is
    // the SSOT), runtime overrides the declaration. Live evidence: TNO
    // session 2 burned 27/32 publish attempts on this exact mismatch
    // (declared=3 observed=2), exhausting maxSteps with finalCandidate
    // already complete. AI never figured out the correction text in the
    // prompt; the loop is deterministic-correctable.
    //
    // AI-first compliance: runtime makes NO content decision and NO
    // readiness decision (decision=ready vs limited is still AI's).
    // It only aligns one numeric field to data runtime owns. Downstream
    // sourceMinimum gate is unaffected — sourceMinimum is computed from
    // readSources/relevantSources, not successfulReadUrlCount, so a
    // smaller successfulReadUrlCount does not falsely satisfy a gate.
    assessment.successfulReadUrlCount = actualSuccessfulReadUrlCount;
    recordPublishAutoCorrection(context && context.runState, {
      declared: successfulReadUrlCount,
      field: "finalReadiness.requirementsAssessment.successfulReadUrlCount",
      kind: "successful_read_url_count_auto_corrected",
      observed: actualSuccessfulReadUrlCount
    });
    // Fall through to the remaining audits with the corrected value.
  }
  const researchState = context && context.runState && context.runState.researchState && typeof context.runState.researchState === "object"
    ? context.runState.researchState
    : null;
  const researchGateBlocked = Boolean(
    researchState &&
    researchState.qualityGateRequired === true &&
    researchState.finalAllowed === false
  );
  const sourceMinimum = readPublishSourceMinimum(context && context.runState);
  const sourceMinimumFailed = Boolean(sourceMinimum && sourceMinimum.passed === false && readinessRequired);
  // Length is never runtime-authored content. Runtime owns the mechanical
  // latest-read number, while the AI still owns ready/limited judgment below.
  if (finalReadiness.decision === "ready" && assessment.evidenceSatisfied === false) {
    const recoveryActions = formatEvidenceRecoveryActions(context && context.runtimeConfig);
    return {
      ok: false,
      message: `workspace_publish_candidate readiness is internally inconsistent: decision=ready but evidenceSatisfied is false. Continue evidence work (${recoveryActions}), or publish as limited with concrete blockers.`
    };
  }
  if (canPublishLimitedWithTerminalRepair(context, finalReadiness, file.path)) {
    return { ok: true };
  }
  const sourceReadinessIssue = inspectSourceMinimumPublishReadiness({
    assessment,
    finalReadiness,
    researchGateBlocked,
    runtimeConfig: context && context.runtimeConfig,
    researchState,
    sourceMinimumFailed
  });
  if (sourceReadinessIssue) return sourceReadinessIssue;
  const recoveryAudit = inspectLimitedRecoveryReadiness(context && context.runState, {
    finalReadiness,
    request: context && context.request,
    runtimeConfig: context && context.runtimeConfig
  });
  if (!recoveryAudit.ok) {
    return {
      ok: false,
      message: recoveryAudit.message,
      requirementRecoveryEvaluator: recoveryAudit.evaluator
    };
  }
  return { ok: true };
}

function recordPublishAutoCorrection(runState, correction) {
  if (!runState || typeof runState !== "object") return;
  if (!Array.isArray(runState.publishAutoCorrections)) {
    runState.publishAutoCorrections = [];
  }
  runState.publishAutoCorrections.push({
    cycle: Number.isInteger(runState.cycleCount) ? runState.cycleCount : 0,
    declared: correction && correction.declared,
    field: readString(correction && correction.field),
    kind: readString(correction && correction.kind) || "publish_auto_corrected",
    observed: correction && correction.observed
  });
  // Cap log at 20 entries so snapshots stay bounded.
  if (runState.publishAutoCorrections.length > 20) {
    runState.publishAutoCorrections.splice(0, runState.publishAutoCorrections.length - 20);
  }
}

function canPublishLimitedWithTerminalRepair(context, finalReadiness, publishPath) {
  const repair = context &&
    context.runState &&
    context.runState.terminalRepairState &&
    typeof context.runState.terminalRepairState === "object"
    ? context.runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return false;
  if (!Array.isArray(repair.allowedActions) || !repair.allowedActions.includes(PUBLISH_DIRECT_ACTION)) {
    return false;
  }
  return isValidTerminalRepairPublishArgs({ finalReadiness, path: publishPath }, repair, {
    runState: context && context.runState
  });
}

function readPublishSourceMinimum(runState) {
  const packetSourceMinimum = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    runState.researchReportLoop.gateSignal.acceptancePacket.evidence &&
    runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket.evidence.sourceMinimum
    : null;
  const loopSourceMinimum = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.sourceMinimum &&
    typeof runState.researchReportLoop.sourceMinimum === "object"
    ? runState.researchReportLoop.sourceMinimum
    : null;
  const source = packetSourceMinimum || loopSourceMinimum;
  if (!source) return null;
  return {
    minReadSources: readNumber(source.minReadSources),
    minRelevantSources: readNumber(source.minRelevantSources),
    passed: source.passed === true,
    readSources: readNumber(source.readSources),
    relevantSources: readNumber(source.relevantSources)
  };
}

function inspectSourceMinimumPublishReadiness(options) {
  const assessment = options && options.assessment;
  const finalReadiness = options && options.finalReadiness;
  const researchState = options && options.researchState;
  const blocked = Boolean(options && (options.researchGateBlocked || options.sourceMinimumFailed));
  if (!blocked) return null;
  const recoveryActions = formatEvidenceRecoveryActions(options && options.runtimeConfig);
  const finalReason = readString(researchState && researchState.finalReason) || "research gate or source minimum still reports evidence gaps";
  if (
    finalReadiness &&
    finalReadiness.decision === "limited" &&
    (!Array.isArray(assessment && assessment.remainingGaps) || assessment.remainingGaps.length === 0)
  ) {
    return {
      ok: false,
      message: `workspace_publish_candidate limited publish needs concrete remainingGaps while evidence/source minimum is blocked (${finalReason}). Continue evidence gathering with ${recoveryActions}, or publish limited with evidenceSatisfied=false and non-empty requirementsAssessment.remainingGaps.`
    };
  }
  if (
    finalReadiness &&
    finalReadiness.decision === "limited" &&
    assessment &&
    assessment.evidenceSatisfied !== false
  ) {
    return {
      ok: false,
      message: `workspace_publish_candidate limited publish must declare evidenceSatisfied=false while evidence/source minimum is blocked (${finalReason}). Continue configured evidence work (${recoveryActions}), or publish limited with concrete evidence blockers in requirementsAssessment.remainingGaps.`
    };
  }
  if (
    finalReadiness &&
    finalReadiness.decision === "limited" &&
    assessment &&
    assessment.requirementSatisfied !== false
  ) {
    return {
      ok: false,
      message: `workspace_publish_candidate limited publish must declare requirementSatisfied=false while evidence/source minimum is blocked (${finalReason}). Continue evidence work, or publish limited with concrete blockers.`
    };
  }
  if (assessment && assessment.evidenceSatisfied === true) {
    return {
      ok: false,
      message: `workspace_publish_candidate readiness conflicts with evidence/source facts: evidenceSatisfied=true while source minimum or Research Gate is blocked (${finalReason}). Continue evidence gathering with ${recoveryActions}, or publish limited with evidenceSatisfied=false and concrete remainingGaps.`
    };
  }
  if (finalReadiness && finalReadiness.decision === "ready") {
    return {
      ok: false,
      message: `workspace_publish_candidate readiness conflicts with evidence/source facts: decision=ready while source minimum or Research Gate is blocked (${finalReason}). Continue evidence gathering with ${recoveryActions}, or publish limited with concrete blockers.`
    };
  }
  return null;
}

function isResearchPublishReadinessRequired(context) {
  const runState = context && context.runState;
  if (!runState || typeof runState !== "object") return false;
  if (isResearchQualityGateRequired(runState, { prompt: context.request && context.request.prompt })) return true;
  const activeSkill = runState.agentSkillContext && runState.agentSkillContext.activeSkill;
  return activeSkill != null &&
    activeSkill.capabilities != null &&
    activeSkill.capabilities.requiresPublishReadiness === true;
}

export { canPublishLimitedWithTerminalRepair, inspectPublishReadiness, inspectSourceMinimumPublishReadiness, isResearchPublishReadinessRequired, readPublishSourceMinimum, recordPublishAutoCorrection };
