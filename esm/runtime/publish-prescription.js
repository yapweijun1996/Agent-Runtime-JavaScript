import { readString } from './semantic-json.js';
import { cloneValue } from './utils.js';

/**
 * Prescription-grade publish feedback (weak-model e2e trace walk, 2026-06-10).
 *
 * Why this exists:
 *   The gemini-3.1-flash-lite trace showed 13 rejected `decision="ready"`
 *   publishes before the model first tried `decision="limited"` — while the
 *   runtime held the prescription the whole time (the valid terminal decision
 *   and a concrete args example) behind the terminal-repair escalation
 *   ladder, whose trigger (ignoredCount) never fires for a model that keeps
 *   responding in the wrong direction. Strong models translate diagnosis →
 *   prescription themselves; weak models cannot. So every publish-blocked
 *   result now carries the prescription AT the first rejection.
 *
 * AI-first boundary:
 *   The runtime only states facts it already computed (the always-valid
 *   limited-publish shape, the observable deficits). It never authors report
 *   content, never picks sources, and never forces the limited decision —
 *   repairing to a clean "ready" publish remains the preferred path.
 */


function buildValidLimitedPublishArgsExample(runState) {
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  const repairContract = repair && repair.validPublishContract && typeof repair.validPublishContract === "object"
    ? repair.validPublishContract
    : null;
  if (repairContract && repairContract.requiredArgsExample && typeof repairContract.requiredArgsExample === "object") {
    return cloneValue(repairContract.requiredArgsExample);
  }
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : {};
  const requested = packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : {};
  const candidate = packet.candidate && typeof packet.candidate === "object"
    ? packet.candidate
    : packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
      ? packet.workspace.candidate
      : {};
  const stats = candidate.stats && typeof candidate.stats === "object"
    ? candidate.stats
    : candidate.textStats && typeof candidate.textStats === "object"
      ? candidate.textStats
      : {};
  const statsKey = readString(requested.statsKey) || "words";
  const observed = readFiniteNumber$4(stats[statsKey]);
  const requestedLength = readFiniteNumber$4(requested.value);
  const lengthSatisfied = requestedLength > 0 ? observed >= requestedLength : false;
  const evidence = packet.evidence && typeof packet.evidence === "object" ? packet.evidence : {};
  return {
    finalReadiness: {
      decision: "limited",
      evidenceMode: "read_sources",
      requirementsAssessment: {
        checkedReadinessAgainstUserRequest: true,
        checkedReadUrlEvidence: true,
        checkedWorkspaceStats: true,
        evidenceSatisfied: false,
        lengthSatisfied,
        observedLength: observed,
        observedLengthUnit: readString(requested.unit) || statsKey,
        remainingGaps: ["Source minimum / read_url evidence is still insufficient."],
        requestedLength: requestedLength || null,
        requirementSatisfied: false,
        successfulReadUrlCount: readFiniteNumber$4(evidence.successfulReadUrlCount),
        summary: "Publish limited only if evidence recovery is exhausted or cannot improve within budget."
      }
    }
  };
}

/**
 * The compact, model-facing prescription attached to EVERY publish-blocked
 * result. No escalation precondition — the whole point is that the first
 * rejection already names the exit.
 */
function buildPublishPrescription(options) {
  const opts = options && typeof options === "object" ? options : {};
  const runState = opts.runState && typeof opts.runState === "object" ? opts.runState : null;
  const recovery = runState && runState.requirementRecoveryEvaluator && typeof runState.requirementRecoveryEvaluator === "object"
    ? runState.requirementRecoveryEvaluator
    : null;
  const observableDeficits = recovery && recovery.lastObservableDeficits && typeof recovery.lastObservableDeficits === "object"
    ? cloneValue(recovery.lastObservableDeficits)
    : null;
  const citationCoverage = opts.citationCoverage && typeof opts.citationCoverage === "object"
    ? opts.citationCoverage
    : null;
  return {
    kind: "publish_prescription",
    rule: "Two valid exits from this block: (1) preferred — perform the repair named in `message`, then redo finalize -> read -> review -> publish with decision=\"ready\"; (2) always valid — if the blocker is an honest unmet requirement you cannot fix within budget, publish with decision=\"limited\" and concrete remainingGaps naming each unmet requirement (see exampleArgs). Do NOT resend the same ready publish without changing anything.",
    blockedStatus: readString(opts.status) || "blocked",
    exampleArgs: buildValidLimitedPublishArgsExample(runState),
    observableDeficits,
    // Source-gate steering: readable sources this run read but the candidate
    // does not cite inline. Citing a read source is a one-edit repair that
    // upgrades a "limited" publish toward "ready".
    citationCoverage
  };
}

function readFiniteNumber$4(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export { buildPublishPrescription, buildValidLimitedPublishArgsExample };
