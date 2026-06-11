import { countSuccessfulReadUrlArtifacts } from './final-readiness.js';
import { FINALIZE_CANDIDATE_ACTION, CANDIDATE_QUALITY_BLOCKED_REASON, PUBLISH_DIRECT_ACTION } from './kernel-terminal-actions.js';
import { normalizeCandidateQualitySignal } from './candidate-quality-signal.js';
import { inspectWorkspaceCandidateStructure, inspectWorkspacePublishProtocol } from './virtual-workspace.js';
import { formatEvidenceRecoveryActions, readEvidenceRecoveryActions } from './evidence-policy.js';
import { cloneValue } from './utils.js';

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

// AGRUN: thresholds are host-overridable policy, not hardcoded runtime law.
// Defaults preserve the historical behavior; a host can retune escalation via
// runtimeConfig.terminalRepair.thresholds without forking the runtime. The
// resolved values are surfaced read-only through the advisory persistence
// signal (vetoThreshold) so the planner can see the live policy.
const DEFAULT_TERMINAL_REPAIR_THRESHOLDS = Object.freeze({
  hardVeto: TERMINAL_REPAIR_HARD_VETO_THRESHOLD,
  highWaterMark: TERMINAL_REPAIR_HIGH_WATER_MARK,
  advisorySignal: TERMINAL_REPAIR_ADVISORY_SIGNAL_THRESHOLD,
  absoluteIgnoredCap: TERMINAL_REPAIR_ABSOLUTE_IGNORED_CAP
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
    absoluteIgnoredCap: readPositiveThreshold(overrides.absoluteIgnoredCap, DEFAULT_TERMINAL_REPAIR_THRESHOLDS.absoluteIgnoredCap)
  };
}

function createTerminalRepairState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const active = source.active === true;
  return {
    kind: "terminal_repair_state",
    active,
    mode: readString$1w(source.mode) || (active ? "terminal_repair" : "none"),
    reason: readString$1w(source.reason) || null,
    activeDeficits: readStringArray$6(source.activeDeficits).slice(0, 8),
    observableDeficits: normalizeObservableDeficits(source.observableDeficits),
    allowedActions: readStringArray$6(source.allowedActions).slice(0, 16),
    budgetState: readString$1w(source.budgetState) || "unknown",
    escalation: readString$1w(source.escalation) === "hard_veto" ? "hard_veto" : "advisory",
      forbiddenDecisions: readStringArray$6(source.forbiddenDecisions).slice(0, 8),
      requiredRepair: readString$1w(source.requiredRepair) || null,
      validPublishContract: normalizeValidPublishContract(source.validPublishContract),
      lengthExpansionSignal: normalizeLengthExpansionSignal(source.lengthExpansionSignal),
      workspaceRepairSignal: normalizeWorkspaceRepairSignal(source.workspaceRepairSignal),
      advisoryPersistenceSignal: normalizeAdvisoryPersistenceSignal(source.advisoryPersistenceSignal),
      actionOrderingSignals: normalizeActionOrderingSignals(source.actionOrderingSignals),
      ignoredCount: readNumber$c(source.ignoredCount),
    activatedAtCycle: readNullableNumber$2(source.activatedAtCycle),
    lastUpdatedAtCycle: readNullableNumber$2(source.lastUpdatedAtCycle),
    lastIgnoredAtCycle: readNullableNumber$2(source.lastIgnoredAtCycle),
    progressSnapshot: normalizeProgressSnapshot(source.progressSnapshot),
    clearedReason: active ? null : (readString$1w(source.clearedReason) || null),
    version: 1
  };
}

function refreshTerminalRepairState(runState, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const previous = createTerminalRepairState(runState.terminalRepairState);
  const next = evaluateTerminalRepairState(runState, { ...context, previous });
  runState.terminalRepairState = next;
  return next;
}

function evaluateTerminalRepairState(runState, context = {}) {
  const previous = createTerminalRepairState(context.previous);
  const cycle = readNullableNumber$2(runState && runState.cycleCount);
  const snapshot = createProgressSnapshot(runState);
  const progress = diffProgress(previous.progressSnapshot, snapshot);
  const actionName = readString$1w(context.actionName);
  const output = readRecord(context.output);
  const completedTerminal = isTerminalCompleted(actionName, context);

  if (completedTerminal) {
    // The run reached a real terminal — reset the run-level cumulative churn
    // counter so a fresh turn starts clean. (A transient clear for progress
    // below deliberately does NOT reset it; only genuine completion does.)
    if (runState && typeof runState === "object") {
      runState.terminalRepairCumulativeIgnored = 0;
    }
    return clearTerminalRepairState(previous, "terminal_completed", cycle, snapshot);
  }

  const facts = readRepairFacts(runState, context);
  const validLimited = isValidTerminalRepairPublishArgs(readActionArgs$1(context), {
    ...previous,
    active: true,
    activeDeficits: facts.activeDeficits
  });

  const publishProtocolActionPending = isPublishProtocolRepairReason(previous.reason) &&
    readString$1w(context && context.status) === "before_action";
  const publishProtocolRequiredActionCompleted = isPublishProtocolRequiredActionCompleted(
    previous.reason,
    actionName,
    output,
    context && context.status
  );
  const publishProtocolStillBlocked = previous.active &&
    isPublishProtocolRepairReason(previous.reason) &&
    !publishProtocolRequiredActionCompleted &&
    isPublishProtocolStillBlockedForReason(runState, previous.reason);
  const publishProtocolTransitionPending =
    readString$1w(previous.reason) === "missing_finalize_after_latest_write" &&
    actionName === FINALIZE_CANDIDATE_ACTION &&
    (readString$1w(output && output.kind) === "virtual_workspace_finalize_candidate" ||
      readString$1w(context && context.status) === "after_workspace_finalize_candidate");
  if (
    previous.active &&
    !facts.forceActive &&
    facts.activeDeficits.length === 0 &&
    !publishProtocolActionPending &&
    !publishProtocolStillBlocked &&
    !publishProtocolTransitionPending
  ) {
    return clearTerminalRepairState(
      previous,
      progress.hasProgress ? progress.reason || "observable_progress" : "observable_deficits_resolved",
      cycle,
      snapshot
    );
  }

  const shouldActivate = previous.active || facts.forceActive;
  if (!shouldActivate) {
    return {
      ...previous,
      progressSnapshot: snapshot,
      lastUpdatedAtCycle: cycle
    };
  }

  const ignoredTerminal = previous.active &&
    isTerminalAttempt(actionName, context) &&
    !completedTerminal &&
    !validLimited &&
    !progress.hasProgress;
  const ignoredRecovery = previous.active &&
    !ignoredTerminal &&
    isNoProgressRecoveryAttempt(actionName, output, facts) &&
    !progress.hasProgress;
  // AGRUN-307 — bound the candidate-maintenance churn loop. The TNO gpt-low
  // run looped ~30min on workspace_review_candidate x97: a re-review makes no
  // observable progress AND is neither a terminal attempt nor a recognized
  // no-progress recovery, so ignoredCount never climbed, hard_veto never
  // fired, and the publish-loop escape valve never opened. Count a re-review
  // while repair is active and unproductive as a no-progress attempt — UNLESS
  // the publish protocol is currently waiting for exactly that review (doing
  // the contract-required action is progress toward terminalization). This
  // reuses the existing ignoredCount -> hard_veto -> publishLoopEscapeGranted
  // machinery rather than adding a parallel counter.
  const ignoredMaintenanceChurn = previous.active &&
    !ignoredTerminal &&
    !ignoredRecovery &&
    isNoProgressMaintenanceChurn(actionName, previous) &&
    !progress.hasProgress;
  const ignoredThisCycle = ignoredTerminal || ignoredRecovery || ignoredMaintenanceChurn;
  const ignoredCount = previous.ignoredCount + (ignoredThisCycle ? 1 : 0);
  // AGRUN-307 — cumulative ignored attempts ACROSS the whole run. The per-state
  // ignoredCount above is reset by clearTerminalRepairState, so a
  // clear<->reactivate oscillation (deficits empty then return as terminal_loop)
  // keeps it below threshold forever — observed live (sawtooth 0->2->0->...).
  // This counter lives on runState and survives clear, so a genuinely stuck
  // loop still reaches the absolute cap and converges to the escape. Only
  // no-progress cycles increment it, so progress-making (healthy) runs never
  // approach the cap.
  const cumulativeIgnoredCount = (readNumber$c(runState && runState.terminalRepairCumulativeIgnored) || 0)
    + (ignoredThisCycle ? 1 : 0);
  if (runState && typeof runState === "object") {
    runState.terminalRepairCumulativeIgnored = cumulativeIgnoredCount;
  }
  const activeDeficits = facts.activeDeficits;
  const activeReason = resolveActiveRepairReason(previous, facts, actionName, context);
  // ADR-0033 Tier A.8 (X1 fix) — compute escalation BEFORE buildAllowedActions
  // so the allowed-action whitelist can open the workspace_publish_candidate
  // (limited) escape valve once hard_veto fires on a structure-stuck loop.
  // Without this, lite-tier runs get pinned: structureRepairConvergence forbids
  // publish, AI re-tries finalize, ignoredCount climbs, hard_veto fires, and the
  // only "exit" remains structure repair the model cannot do cleanly.
  const thresholds = resolveTerminalRepairThresholds(context.runtimeConfig);
  const escalation =
    (ignoredCount >= thresholds.hardVeto && facts.budgetState === "exhausted") ||
    ignoredCount >= thresholds.highWaterMark ||
    cumulativeIgnoredCount >= thresholds.absoluteIgnoredCap
      ? "hard_veto"
      : "advisory";
    const allowedActions = buildAllowedActions(activeDeficits, facts.budgetState, activeReason, facts.observableDeficits, runState, escalation, context.runtimeConfig);
    // Escape valve for an UN-RESOLVABLE source deficit. When the AI has
    // repeatedly tried to terminate (ignoredCount >= hardVeto) yet has ZERO
    // successful read sources — read_url genuinely cannot yield evidence (the
    // service is down, or every candidate page is blocked) — the source
    // deficit can never be cleared. Pinning the AI in the repair loop just
    // burns the budget and returns a useless continuation stub. Instead, open
    // `final`/`finalize` so the AI can answer with honest limitations. Narrow
    // by design: requires real terminate attempts AND zero successful reads,
    // so it never fires when evidence is merely thin-but-present.
    const sourceUnresolvable =
      activeDeficits.includes("source") &&
      !isCandidateQualityRepairReason(activeReason) &&
      facts.observableDeficits.source &&
      readNumber$c(facts.observableDeficits.source.successfulReadUrlCount) === 0 &&
      ignoredCount >= thresholds.hardVeto;
    // Escape valve for an UN-CONVERGEABLE workspace publish PROTOCOL loop
    // (sibling of the source-deficit escape above). The publish path is a strict
    // multi-step protocol — write -> finalize -> read -> review -> publish —
    // whose finalReadiness facts must EXACTLY match the observed candidate stats
    // AND clear every active deficit. A weak model that has drafted a real
    // report keeps re-emitting a publish the validator rejects
    // (terminal_repair_invalid_publish); ignoredCount climbs to hard_veto, yet
    // — unlike the zero-evidence source case — NOTHING opens an exit, so the run
    // burns the whole step budget and returns the generic "paused" continuation
    // stub instead of the report the AI already wrote. Once hard_veto has fired
    // AND a real final candidate with content exists, this flag tells the
    // publish gate (terminal-repair preflight + the publish action) to ACCEPT
    // the AI's workspace_publish_candidate as-is — publishing the full report
    // ARTIFACT (NOT finalize, which would re-summarize/compress it) with the
    // unmet protocol/readiness facts surfaced as observable limitations. Narrow
    // by design: hard_veto means the AI has already ignored the advisory past
    // the high-water mark (a genuinely convergeable publish lands in 1-2 steps,
    // far below that), and a non-empty candidate must exist, so it never fires
    // on a convergeable publish and never fabricates a report from nothing.
    const publishLoopUnresolvable =
      !sourceUnresolvable &&
      escalation === "hard_veto" &&
      !isCandidateQualityRepairReason(activeReason) &&
      hasSelectedFinalCandidateContent(runState);
    // AGRUN-309 — graceful-degradation escape for an UN-RESOLVABLE candidate-quality
    // citation loop (unread_cited_url / blocked_source_cited). When the AI has
    // churned to hard_veto (the AGRUN-307 cumulative cap proves many real attempts)
    // AND a drafted report exists, open `final`/`finalize` so the AI DELIVERS the
    // report it already wrote, stating the unverifiable citation as an honest
    // limitation — graceful degradation, not "burn the budget to a stub". Mirrors
    // sourceUnresolvable: it opens FINALIZE (an honest terminal answer routed through
    // the runtime finalizer), NOT workspace_publish_candidate — so it does NOT set
    // publishLoopEscapeGranted and NEVER force-publishes a "verified report" citing
    // an unread URL. The candidate-quality publish-escape exclusion (and the
    // integrity guard at terminal-repair-state.test.js ~1428) stays intact; this only
    // adds an honest finalize exit so a weak model is not pinned to maxSteps.
    const candidateQualityUnresolvable =
      isCandidateQualityRepairReason(activeReason) &&
      escalation === "hard_veto" &&
      hasSelectedFinalCandidateContent(runState);
    // The source-deficit escape opens `final`/`finalize` because that case has
    // NO candidate to publish — finalize is its only terminal. The publish-loop
    // escape deliberately does NOT open finalize (it would compress the report);
    // it routes through workspace_publish_candidate instead (see the publish
    // gate's publishLoopEscapeGranted handling).
    const effectiveAllowedActions = (sourceUnresolvable || candidateQualityUnresolvable)
      ? Array.from(new Set([...allowedActions, "final", "finalize"]))
      : allowedActions;
    const validPublishContract = buildValidPublishContract(activeDeficits, facts.observableDeficits, facts.budgetState, escalation);
    const lengthExpansionSignal = buildLengthExpansionSignal(runState, facts.observableDeficits);
    const workspaceRepairSignal = buildWorkspaceRepairSignal(runState, facts.observableDeficits, activeDeficits, allowedActions, activeReason, facts.budgetState, escalation);
    const advisoryPersistenceSignal = buildAdvisoryPersistenceSignal(ignoredCount, escalation, thresholds);
    if (advisoryPersistenceSignal) {
      // AGRUN-459 — emit the persistence step ONCE, on the first cycle the signal
      // is surfaced (previous cycle carried none). Presence-transition, not an
      // exact ignoredCount value, so it survives ignoredCount jumping past the
      // advisorySignal threshold and never re-fires while the signal persists.
      advisoryPersistenceSignal.advisoryThresholdFirstCrossed = previous.advisoryPersistenceSignal == null;
    }
    const actionOrderingSignals = buildActionOrderingSignals(runState, facts.observableDeficits, facts.budgetState, activeDeficits, allowedActions);

    return {
    kind: "terminal_repair_state",
    active: true,
    mode: "terminal_repair",
    reason: activeReason,
    activeDeficits,
    observableDeficits: facts.observableDeficits,
    allowedActions: effectiveAllowedActions,
    budgetState: facts.budgetState,
    escalation,
    sourceDeficitEscapeGranted: sourceUnresolvable,
    publishLoopEscapeGranted: publishLoopUnresolvable,
    candidateQualityUnresolvable,
      forbiddenDecisions: (sourceUnresolvable || candidateQualityUnresolvable)
        ? buildForbiddenDecisions(activeDeficits).filter((d) => d !== "finalize" && d !== "final_answer")
        : buildForbiddenDecisions(activeDeficits),
      requiredRepair: buildRequiredRepair(activeDeficits, facts.observableDeficits, allowedActions, facts.budgetState, activeReason, context.runtimeConfig),
      validPublishContract,
      lengthExpansionSignal,
      workspaceRepairSignal,
      advisoryPersistenceSignal,
      actionOrderingSignals,
      ignoredCount,
      cumulativeIgnoredCount,
    activatedAtCycle: previous.active && previous.activatedAtCycle != null
      ? previous.activatedAtCycle
      : cycle,
    lastUpdatedAtCycle: cycle,
    lastIgnoredAtCycle: ignoredTerminal || ignoredRecovery ? cycle : previous.lastIgnoredAtCycle,
    progressSnapshot: snapshot,
    clearedReason: null,
    version: 1
  };
}

function summarizeTerminalRepairState(value) {
  const state = createTerminalRepairState(value);
  if (!state.active && state.ignoredCount === 0 && !state.clearedReason) return null;
  return {
    kind: state.kind,
    active: state.active,
    mode: state.mode,
    reason: state.reason,
    activeDeficits: state.activeDeficits,
    observableDeficits: state.observableDeficits,
    allowedActions: state.allowedActions,
    budgetState: state.budgetState,
    escalation: state.escalation,
      forbiddenDecisions: state.forbiddenDecisions,
      requiredRepair: state.requiredRepair,
      validPublishContract: state.validPublishContract,
      lengthExpansionSignal: state.lengthExpansionSignal,
      workspaceRepairSignal: state.workspaceRepairSignal,
      advisoryPersistenceSignal: state.advisoryPersistenceSignal,
      actionOrderingSignals: state.actionOrderingSignals,
      ignoredCount: state.ignoredCount,
    activatedAtCycle: state.activatedAtCycle,
    lastUpdatedAtCycle: state.lastUpdatedAtCycle,
    lastIgnoredAtCycle: state.lastIgnoredAtCycle,
    clearedReason: state.clearedReason
    };
}

// AGRUN-480 (audit M1) — SSOT for the `terminal-repair-state-refreshed` step
// payload, shared by BOTH dispatch paths (single action in action-loop-action.js,
// plan batch in action-loop-plan-actions.js). The plan copy had drifted, omitting
// actionOrderingSignals / allowedActions / lengthExpansionSignal / status, so the
// Inspector could not distinguish a plan-path terminal-repair from a single-path
// one. Mirrors the existing buildInvalidActionConvergenceStepDetail pattern; the
// caller passes the already-derived advisoryPersistenceSignal (it also needs it
// for the advisory-persistence gate) so the field set is a single edit forever.
function buildTerminalRepairRefreshedStepDetail(repair, actionName, advisoryPersistenceSignal) {
  return {
    actionName,
    active: repair.active === true,
    activeDeficits: Array.isArray(repair.activeDeficits) ? repair.activeDeficits.slice(0, 8) : [],
    actionOrderingSignals: Array.isArray(repair.actionOrderingSignals) ? repair.actionOrderingSignals.slice(0, 4) : [],
    advisoryPersistenceSignal: advisoryPersistenceSignal || null,
    allowedActions: Array.isArray(repair.allowedActions) ? repair.allowedActions.slice(0, 10) : [],
    ignoredCount: repair.ignoredCount || 0,
    lengthExpansionSignal: repair.lengthExpansionSignal || null,
    workspaceRepairSignal: repair.workspaceRepairSignal
      ? cloneValue(repair.workspaceRepairSignal)
      : null,
    reason: repair.reason || null,
    status: repair.mode || "none"
  };
}

function buildBudgetRemainingForExpansionSignal(terminalRepairState, ignoredCountOverride) {
  const state = createTerminalRepairState(terminalRepairState);
  const ignoredCount = ignoredCountOverride == null
    ? state.ignoredCount
    : readNumber$c(ignoredCountOverride);
  const length = observableDeficitsRecord(state.observableDeficits, "length");
  if (state.budgetState !== "enough") return null;
  if (ignoredCount < TERMINAL_REPAIR_ADVISORY_SIGNAL_THRESHOLD) return null;
  if (!length) return null;
  const observed = readNumber$c(length.observed);
  const requested = readNumber$c(length.requested);
  if (!requested || observed >= requested) return null;
  return {
    kind: "budget_remaining_for_expansion",
    budgetState: state.budgetState,
    ignoredCount,
    observed,
    requested,
    unit: readString$1w(length.unit) || "words",
    gap: Math.max(requested - observed, 0)
  };
}

function isValidTerminalRepairPublishArgs(args, terminalRepairState, options = {}) {
  return explainTerminalRepairPublishArgs(args, terminalRepairState, options).valid;
}

function explainTerminalRepairPublishArgs(args, terminalRepairState, options = {}) {
  const state = createTerminalRepairState(terminalRepairState);
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const readiness = source.finalReadiness && typeof source.finalReadiness === "object"
    ? source.finalReadiness
    : {};
  const reasons = [];
  const hints = [];
  if (readString$1w(readiness.decision) !== "limited") {
    reasons.push("missing_limited_decision");
  }
  const assessment = readiness.requirementsAssessment && typeof readiness.requirementsAssessment === "object"
    ? readiness.requirementsAssessment
    : {};
  if (!readiness.requirementsAssessment || typeof readiness.requirementsAssessment !== "object") {
    reasons.push("missing_requirements_assessment");
  }
  const gaps = readTerminalRepairGaps(assessment, readiness);
  if (gaps.length === 0) {
    reasons.push("missing_remaining_gaps");
  }
  const deficits = state.activeDeficits;
  const effectiveDeficits = resolvePublishValidationDeficits(deficits, source, state, options);
  const hasDeficit = effectiveDeficits.length > 0 || state.active === true;
  if (hasDeficit && assessment.requirementSatisfied !== false) {
    reasons.push("requirement_satisfied_must_be_false");
  }
  if (effectiveDeficits.includes("source") && assessment.evidenceSatisfied !== false) {
    reasons.push("evidence_satisfied_must_be_false_for_source_deficit");
  }
  if (effectiveDeficits.includes("length") && assessment.lengthSatisfied !== false) {
    reasons.push("length_satisfied_must_be_false_for_length_deficit");
  }
  if (effectiveDeficits.includes("structure")) {
    if (!isBudgetConstrainedForLimitedPublish(state)) {
      reasons.push("structure_deficit_must_be_repaired_before_publish");
      } else if (!mentionsStructureGap(gaps)) {
        // AGRUN-249-F: English keyword matching is language-biased, so missing
        // structure words in remainingGaps stays advisory. Protocol-shape
        // reasons above remain blocking.
        hints.push("gap_description_may_omit_structure_deficit");
      }
    }
    if (effectiveDeficits.includes("todo") && !isBudgetConstrainedForLimitedPublish(state)) {
      reasons.push("todo_deficit_must_be_synchronized_before_publish");
    }
    if (effectiveDeficits.includes("todo") && !mentionsGap(gaps, ["todo", "task", "progress", "plan"])) {
      // AGRUN-249-F: same Mandarin/non-English risk as structure gap text.
      // Keep the observable hint, but do not reject a valid limited contract
      // only because the model named the Todo gap without these English tokens.
      hints.push("gap_description_may_omit_todo_deficit");
    }
  return {
    activeDeficits: deficits.slice(0, 8),
    effectiveDeficits: effectiveDeficits.slice(0, 8),
    valid: reasons.length === 0,
    reasons,
    hints
  };
}

function getPublishProtocolRequiredActionForReason(reason) {
  const value = readString$1w(reason);
  if (value === "missing_finalize_after_latest_write") return FINALIZE_CANDIDATE_ACTION;
  if (value === "missing_latest_workspace_read") return "workspace_read";
  if (value === "missing_latest_candidate_review") return "workspace_review_candidate";
  return "";
}

function isPublishProtocolRequiredActionForRepair(terminalRepairState, actionName) {
  const state = terminalRepairState && typeof terminalRepairState === "object" && !Array.isArray(terminalRepairState)
    ? terminalRepairState
    : {};
  const requiredAction = getPublishProtocolRequiredActionForReason(state.reason);
  return Boolean(requiredAction && requiredAction === readString$1w(actionName));
}

function isWorkspaceRepairInspectionActionForRepair(terminalRepairState, actionName) {
  const state = terminalRepairState && typeof terminalRepairState === "object" && !Array.isArray(terminalRepairState)
    ? terminalRepairState
    : {};
  const signal = state.workspaceRepairSignal && typeof state.workspaceRepairSignal === "object"
    ? state.workspaceRepairSignal
    : null;
  return Boolean(
    state.active === true &&
    readString$1w(actionName) === "workspace_read" &&
    signal &&
    signal.mustInspectCandidate === true
  );
}

function resolvePublishProtocolActionContract(runState) {
  const publishProtocol = readCurrentPublishProtocol(runState);
  if (!publishProtocol) return null;
  if (publishProtocol.finalizedAfterLatestWrite !== true) {
    return {
      allowedActions: [FINALIZE_CANDIDATE_ACTION],
      protocol: publishProtocol,
      reason: "missing_finalize_after_latest_write",
      requiredAction: FINALIZE_CANDIDATE_ACTION,
      ready: false
    };
  }
  if (publishProtocol.readAfterLatestContentChange !== true) {
    return {
      allowedActions: ["workspace_read"],
      protocol: publishProtocol,
      reason: "missing_latest_workspace_read",
      requiredAction: "workspace_read",
      ready: false
    };
  }
  return {
    allowedActions: [PUBLISH_DIRECT_ACTION],
    protocol: publishProtocol,
    reason: "publish_protocol_ready",
    requiredAction: "",
    ready: true
  };
}

function resolvePublishValidationDeficits(deficits, actionArgs, terminalRepairState, options) {
  const sourceDeficits = Array.isArray(deficits) ? deficits : [];
  if (!sourceDeficits.includes("length")) return sourceDeficits.slice();
  const length = terminalRepairState &&
    terminalRepairState.observableDeficits &&
    terminalRepairState.observableDeficits.length &&
    typeof terminalRepairState.observableDeficits.length === "object"
    ? terminalRepairState.observableDeficits.length
    : null;
  const requested = readNumber$c(length && length.requested);
  const unit = readString$1w(length && length.unit) || "words";
  const path = readString$1w(actionArgs && actionArgs.path);
  if (!path || !requested) return sourceDeficits.slice();
  const stats = readWorkspaceFileStats(options && options.runState, path);
  const observed = readNumber$c(stats && stats[unit]);
  if (observed >= requested) {
    return sourceDeficits.filter((name) => name !== "length");
  }
  return sourceDeficits.slice();
}

function readTerminalRepairGaps(assessment, readiness) {
  const gaps = readStringArray$6(assessment && assessment.remainingGaps);
  if (gaps.length > 0) return gaps;
  const fallback = readString$1w(
    readiness && (readiness.limitations || readiness.limitation || readiness.remainingGap)
  ) || readString$1w(
    assessment && (assessment.limitations || assessment.limitation || assessment.remainingGap)
  );
  return fallback ? [fallback] : [];
}

function isBudgetConstrainedForLimitedPublish(terminalRepairState) {
  const budgetState = readString$1w(terminalRepairState && terminalRepairState.budgetState);
  // ADR-0033 Tier A.8 (X1 fix) — hard_veto means AI has hit the wall on
  // structure repair (ignoredCount past the high-water mark). Even on
  // "enough" budget the rational next move is publish_limited with structure
  // noted in remainingGaps. Treat hard_veto state as constrained for the
  // purpose of allowing a limited publish contract.
  const escalation = readString$1w(terminalRepairState && terminalRepairState.escalation);
  return budgetState === "low" || budgetState === "exhausted" || escalation === "hard_veto";
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

function readWorkspaceFileStats(runState, path) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && path ? files[path] : null;
  const stats = readRecord(file && file.textStats);
  if (stats) return stats;
  if (file && typeof file === "object" && typeof file.content === "string") {
    return summarizeTextStats$1(file.content);
  }
  return null;
}

function summarizeTextStats$1(value) {
  const text = readString$1w(value);
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

function readRepairFacts(runState, context) {
  const packet = readAcceptancePacket(runState);
  const sourceMinimum = readSourceMinimum(runState, packet);
  const lengthStatus = readLengthStatus(packet, runState);
  const structure = readStructureStatus(runState);
  const todo = readTodoStatus(runState);
  const actionName = readString$1w(context && context.actionName);
  const actionPattern = readRecord(runState && runState.actionPatternConvergence);
  const correction = readRecord(actionPattern && actionPattern.terminalCorrectionState);
  const cooldown = readRecord(actionPattern && actionPattern.terminalRetryCooldown);
  const readOnlyPlanning = readRecord(actionPattern && actionPattern.readOnlyPlanningState);
  const output = readRecord(context && context.output);
  const outputGuardrailBlocked = readString$1w(output && output.status) === "output_guardrail_blocked";
  const outputGuardrailBlock = readOutputGuardrailBlock(output);
  const publishBlocked = readString$1w(output && output.kind) === "virtual_workspace_publish_blocked" ||
    readString$1w(output && output.kind) === "terminal_correction_preflight_block" ||
    readString$1w(output && output.kind) === "terminal_repair_preflight_block";
  const readinessBlocked = isReadinessRepairOutput(output);
  const deficits = [];
  const observableDeficits = {
    length: null,
    readiness: null,
    source: null,
    structure: null,
    todo: null
  };
  const candidateQualityCitationDeficit = buildCandidateQualityCitationDeficit(
    readCandidateQualitySignal(runState, output),
    runState
  );

  if (sourceMinimum && sourceMinimum.passed !== true) {
    const readSourceDeficit = Math.max(readNumber$c(sourceMinimum.minReadSources) - readNumber$c(sourceMinimum.readSources), 0);
    const relevantSourceDeficit = Math.max(readNumber$c(sourceMinimum.minRelevantSources) - readNumber$c(sourceMinimum.relevantSources), 0);
    if (readSourceDeficit > 0 || relevantSourceDeficit > 0) {
      deficits.push("source");
      observableDeficits.source = {
        minReadSources: readNumber$c(sourceMinimum.minReadSources),
        minRelevantSources: readNumber$c(sourceMinimum.minRelevantSources),
        readSourceDeficit,
        readSources: readNumber$c(sourceMinimum.readSources),
        relevantSourceDeficit,
        relevantSources: readNumber$c(sourceMinimum.relevantSources),
        successfulReadUrlCount: readSuccessfulReadUrlCount(runState, packet)
      };
    }
  }
  if (candidateQualityCitationDeficit) {
    if (!deficits.includes("source")) deficits.push("source");
    observableDeficits.source = mergeSourceDeficit(observableDeficits.source, candidateQualityCitationDeficit);
  }

  // Length remains an observable fact rather than a content-authored runtime
  // rewrite. AGRUN-249 uses this signal to shape the recovery action surface
  // while the AI still writes every expansion.
  if (lengthStatus && lengthStatus.requested > 0 && lengthStatus.observed < lengthStatus.requested) {
    const alternativeCandidate = findWorkspaceLengthCandidate(
      runState,
      lengthStatus.statsKey,
      lengthStatus.requested,
      lengthStatus.observed,
      lengthStatus.path
    );
    observableDeficits.length = {
      observed: lengthStatus.observed,
      requested: lengthStatus.requested,
      unit: lengthStatus.unit,
      deficit: Math.max(lengthStatus.requested - lengthStatus.observed, 0),
      alternativeCandidate
    };
  }

  // AGRUN-244 Phase 3 — structure is likewise display-only, not a deficit. The
  // literal duplicate-heading checker is gameable (renamed duplicates evade it)
  // and Phase 2 runs fired it every cycle with zero effect. The AI sees the
  // structure observation and decides; the runtime does not force repair.
  if (structure && structure.ok === false) {
    observableDeficits.structure = {
      issueCodes: readStringArray$6(structure.issueCodes).slice(0, 8),
      reason: readString$1w(structure.reason) || readString$1w(structure.status) || "structure_not_ready",
      repeatedHeadingSamples: normalizeStructureSamples(structure.repeatedHeadingSamples, "heading"),
      repeatedNumberSamples: normalizeStructureSamples(structure.repeatedNumberSamples, "number"),
      status: readString$1w(structure.status) || "fail"
    };
  }

  if (outputGuardrailBlocked && isOutputGuardrailStructureBlock(outputGuardrailBlock)) {
    deficits.push("structure");
    observableDeficits.structure = mergeOutputGuardrailStructureDeficit(
      observableDeficits.structure,
      outputGuardrailBlock
    );
  }

  if (todo.unfinishedCount > 0) {
    deficits.push("todo");
    observableDeficits.todo = todo;
  }

  // F8 (2026-06-10) — premature-finalize bypass. The packet-based facts above
  // (sourceMinimum, lengthStatus) only exist once the research report loop has
  // engaged, so a planner `finalize` BEFORE any workspace work saw zero
  // deficits and sailed through maybeBlockDirectTerminalDuringRepair,
  // terminating a convergence task with an empty candidate (observed 2/2 on
  // deepseek-v4-flash high effort: search -> read_url -> finalize at cycle 3).
  // The requirementRecoveryEvaluator already tracks the SAME contract
  // packet-independently (prompt-extracted requested length, workspace
  // candidate stats, recovery budget) and is refreshed on both dispatch paths,
  // so on a terminal attempt we adopt its recoverable deficits as repair
  // facts. Narrow by design: only `validLimitedAllowed === false` (recovery
  // budget remains) counts — once recovery is exhausted the evaluator opens
  // honest-limited and this gate stays out of the way. Existing escalation
  // (ignoredCount -> hard_veto -> escape valves) bounds repeat offenders.
  const terminalRequirementRecovery = isTerminalAttempt(actionName, context)
    ? readTerminalRequirementRecoveryFacts(runState)
    : null;
  if (terminalRequirementRecovery) {
    for (const dimension of terminalRequirementRecovery.dimensions) {
      if (!deficits.includes(dimension)) deficits.push(dimension);
    }
    if (terminalRequirementRecovery.length && !observableDeficits.length) {
      observableDeficits.length = terminalRequirementRecovery.length;
    }
    if (terminalRequirementRecovery.source && !observableDeficits.source) {
      observableDeficits.source = terminalRequirementRecovery.source;
    }
  }

  if (readinessBlocked && !deficits.includes("readiness")) {
    deficits.push("readiness");
    observableDeficits.readiness = readReadinessDeficit(output);
  }

  if ((correction && correction.active === true) || (cooldown && cooldown.active === true)) {
    deficits.push("terminal_loop");
  }

  const finalizedStructureBlocked = structure && structure.ok === false && isFinalizedCandidateSelected(runState);
  const readOnlyPlanningActive = readOnlyPlanning && readOnlyPlanning.active === true;
  const outputRepairReason = readOutputRepairReason(output);
  const structureRepairReason = (finalizedStructureBlocked || (outputGuardrailBlocked && observableDeficits.structure)) && (
    !outputRepairReason || outputRepairReason.includes("readiness")
  )
    ? "finalized_candidate_structure_not_ready"
    : null;

  const activeDeficits = Array.from(new Set(deficits)).slice(0, 8);
  const budgetState = readBudgetState(runState, context);
  const budgetConstrained = budgetState === "low" || budgetState === "exhausted";
  const proactiveBudgetRepair = budgetConstrained &&
    activeDeficits.length > 0 &&
    shouldProactivelyActivateBudgetRepair(lengthStatus);
  const todoOnlyTerminalAttempt = isTerminalAttempt(actionName, context) &&
    activeDeficits.includes("todo") &&
    !activeDeficits.some((name) => name === "source" || name === "length" || name === "structure");
  return {
    activeDeficits,
    budgetState,
    forceActive: publishBlocked ||
      Boolean(candidateQualityCitationDeficit) ||
      Boolean(terminalRequirementRecovery) ||
      todoOnlyTerminalAttempt ||
      finalizedStructureBlocked ||
      proactiveBudgetRepair ||
      (readOnlyPlanningActive && activeDeficits.length > 0) ||
      (correction && correction.active === true) ||
      (cooldown && cooldown.active === true),
    observableDeficits,
    reason: structureRepairReason ||
      outputRepairReason ||
      (candidateQualityCitationDeficit ? CANDIDATE_QUALITY_BLOCKED_REASON : null) ||
      readString$1w(correction && correction.reason) ||
      readString$1w(cooldown && cooldown.reason) ||
      (finalizedStructureBlocked ? "finalized_candidate_structure_not_ready" : null) ||
      (proactiveBudgetRepair ? `${budgetState}_budget_with_observable_deficits` : null) ||
      (readOnlyPlanningActive && activeDeficits.length > 0 ? "read_only_planning_with_observable_deficits" : null) ||
      (terminalRequirementRecovery ? "terminal_attempt_with_recoverable_requirement_deficits" : null) ||
      (todoOnlyTerminalAttempt ? "todo_state_not_synced" : null) ||
      (activeDeficits.length > 0 ? "observable_deficits_block_terminal_ready" : null)
  };
}

function shouldProactivelyActivateBudgetRepair(lengthStatus) {
  return Boolean(lengthStatus && lengthStatus.requested > 0);
}

// F8 — adopt the requirementRecoveryEvaluator's recoverable deficits as repair
// facts for a terminal attempt. The evaluator is refreshed by both dispatch
// paths after every evidence/workspace action, so at finalize-decision time it
// is at most one action stale. Returns null unless the evaluator explicitly
// says honest-limited is NOT yet allowed (recovery budget remains), keeping
// this gate inert for chat tasks, satisfied contracts, and exhausted budgets.
function readTerminalRequirementRecoveryFacts(runState) {
  const evaluator = readRecord(runState && runState.requirementRecoveryEvaluator);
  if (!evaluator || evaluator.validLimitedAllowed !== false) return null;
  const entries = Array.isArray(evaluator.recoverableDeficits) ? evaluator.recoverableDeficits : [];
  const dimensions = Array.from(new Set(
    entries
      .map((entry) => readString$1w(entry && entry.dimension))
      .filter((dimension) => dimension === "length" || dimension === "source")
  ));
  if (dimensions.length === 0) return null;
  const observed = readRecord(evaluator.lastObservableDeficits) || {};
  const lengthRequested = readNumber$c(observed.lengthRequested);
  const lengthObserved = readNumber$c(observed.lengthObserved);
  const length = dimensions.includes("length")
    ? {
        observed: lengthObserved,
        requested: lengthRequested,
        unit: readString$1w(observed.lengthUnit) || "words",
        deficit: Math.max(lengthRequested - lengthObserved, 0),
        alternativeCandidate: null
      }
    : null;
  const sourceEntry = entries.find((entry) => readString$1w(entry && entry.dimension) === "source") || null;
  const sourceObserved = readRecord(sourceEntry && sourceEntry.observed) || {};
  const sourceTarget = readRecord(sourceEntry && sourceEntry.target) || {};
  const source = dimensions.includes("source")
    ? {
        minReadSources: readNumber$c(sourceTarget.minReadSources),
        minRelevantSources: readNumber$c(sourceTarget.minRelevantSources),
        readSourceDeficit: readNumber$c(observed.readSourceDeficit),
        readSources: readNumber$c(sourceObserved.readSources),
        relevantSourceDeficit: readNumber$c(observed.relevantSourceDeficit),
        relevantSources: readNumber$c(sourceObserved.relevantSources),
        successfulReadUrlCount: readSuccessfulReadUrlCount(runState, readAcceptancePacket(runState))
      }
    : null;
  return { dimensions, length, source };
}

function readReadinessDeficit(output) {
  const result = readRecord(output) || {};
  const audit = readRecord(result.readinessAudit);
  const issues = normalizeReadinessIssues(audit && audit.issues);
  return {
    kind: "readiness_payload_deficit",
    issues,
    message: readString$1w((audit && audit.message) || result.message) || null,
    status: readString$1w(result.status) || readString$1w(audit && audit.status) || "readiness_audit_failed"
  };
}

function readCandidateQualitySignal(runState, output) {
  const outputSignal = readRecord(output && output.candidateQualitySignal);
  if (outputSignal) return normalizeCandidateQualitySignal(outputSignal);
  const stateSignal = readRecord(runState && runState.candidateQualitySignal);
  if (stateSignal) return normalizeCandidateQualitySignal(stateSignal);
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  const workspaceSignal = readRecord(quality && quality.candidateQualitySignal);
  return workspaceSignal ? normalizeCandidateQualitySignal(workspaceSignal) : null;
}

function buildCandidateQualityCitationDeficit(signal, runState) {
  const quality = normalizeCandidateQualitySignal(signal);
  if (!quality || quality.hasBlockingIssues !== true) return null;
  const issues = Array.isArray(quality.blockingIssues) ? quality.blockingIssues : [];
  const citationIssues = issues
    .filter((issue) => {
      const code = readString$1w(issue && issue.code);
      return code === "unread_cited_url" || code === "blocked_source_cited";
    })
    .map((issue) => ({
      code: readString$1w(issue.code),
      message: readString$1w(issue.message) || null,
      path: readString$1w(issue.path) || readString$1w(quality.path) || readFinalCandidatePathFromWorkspace(runState),
      qualityReason: readString$1w(issue.qualityReason) || null,
      qualityTier: readString$1w(issue.qualityTier) || null,
      status: readString$1w(issue.status) || null,
      url: readString$1w(issue.url)
    }))
    .filter((issue) => issue.code && issue.url)
    .slice(0, 8);
  if (citationIssues.length === 0) return null;
  const context = readRecord(runState && runState.researchContext);
  const sourceMinimum = readSourceMinimum(runState, readAcceptancePacket(runState)) || {};
  return {
    issueCodes: citationIssues.map((issue) => issue.code),
    citationIssues,
    citationIssueCount: citationIssues.length,
    minReadSources: readNumber$c(sourceMinimum.minReadSources),
    minRelevantSources: readNumber$c(sourceMinimum.minRelevantSources),
    readSourceDeficit: 0,
    readSources: readNumber$c(sourceMinimum.readSources),
    relevantSourceDeficit: 0,
    relevantSources: readNumber$c(sourceMinimum.relevantSources),
    reason: CANDIDATE_QUALITY_BLOCKED_REASON,
    sourceMinimumPassed: sourceMinimum.passed === true,
    successfulReadUrlCount: countSuccessfulReadUrlArtifacts(runState),
    unreadCitedUrls: citationIssues
      .filter((issue) => issue.code === "unread_cited_url")
      .map((issue) => issue.url),
    blockedCitedUrls: citationIssues
      .filter((issue) => issue.code === "blocked_source_cited")
      .map((issue) => issue.url),
    readUrlCandidatesAvailable: hasUnreadCitationUrls(context, citationIssues)
  };
}

function mergeSourceDeficit(existing, next) {
  const base = readRecord(existing);
  const incoming = readRecord(next);
  if (!base) return incoming;
  if (!incoming) return base;
  const citationIssues = [
    ...(Array.isArray(base.citationIssues) ? base.citationIssues : []),
    ...(Array.isArray(incoming.citationIssues) ? incoming.citationIssues : [])
  ].slice(0, 8);
  const issueCodes = Array.from(new Set([
    ...readStringArray$6(base.issueCodes),
    ...readStringArray$6(incoming.issueCodes)
  ])).slice(0, 12);
  return {
    ...base,
    ...incoming,
    citationIssueCount: citationIssues.length,
    citationIssues,
    issueCodes,
    readSourceDeficit: Math.max(readNumber$c(base.readSourceDeficit), readNumber$c(incoming.readSourceDeficit)),
    relevantSourceDeficit: Math.max(readNumber$c(base.relevantSourceDeficit), readNumber$c(incoming.relevantSourceDeficit)),
    reason: readString$1w(incoming.reason) || readString$1w(base.reason) || null,
    unreadCitedUrls: Array.from(new Set([
      ...readStringArray$6(base.unreadCitedUrls),
      ...readStringArray$6(incoming.unreadCitedUrls)
    ])).slice(0, 8),
    blockedCitedUrls: Array.from(new Set([
      ...readStringArray$6(base.blockedCitedUrls),
      ...readStringArray$6(incoming.blockedCitedUrls)
    ])).slice(0, 8)
  };
}

function hasUnreadCitationUrls(context, issues) {
  if (!context || typeof context !== "object") return true;
  const readSources = Array.isArray(context.readSources) ? context.readSources : [];
  const readUrls = new Set(readSources.map((source) => normalizeUrlKey$1(readCandidateUrl(source))).filter(Boolean));
  return issues.some((issue) => (
    issue.code === "unread_cited_url" &&
    normalizeUrlKey$1(issue.url) &&
    !readUrls.has(normalizeUrlKey$1(issue.url))
  ));
}

function isReadinessRepairOutput(output) {
  const result = readRecord(output) || {};
  const status = readString$1w(result.status);
  const reason = readString$1w(result.reason);
  if (status === "readiness_audit_failed") return true;
  if (status.includes("readiness") || reason.includes("readiness")) return true;
  const audit = readRecord(result.readinessAudit);
  return Boolean(
    audit &&
    audit.ok === false &&
    Array.isArray(audit.issues) &&
    audit.issues.length > 0
  );
}

function readOutputGuardrailBlock(output) {
  const block = readRecord(output && output.outputGuardrailBlock);
  if (!block) return null;
  return {
    info: block.info == null ? null : block.info,
    name: readString$1w(block.name) || null,
    reason: readString$1w(block.reason) || null
  };
}

// AGRUN-401 — classify an output-guardrail block as "structure" ONLY from its
// own issue codes. The previous early-return (`if (existingStructure) return
// true`) short-circuited before inspecting codes, so once any structure
// observation existed, EVERY subsequent guardrail block (language bias, image
// dimension, …) was mislabelled a structure deficit and merged its unrelated
// codes into observableDeficits.structure — polluting activeDeficits and
// steering the model to repair a non-existent structure problem. A genuine
// pre-existing structure deficit is still captured independently via the
// `structure.ok === false` path in readRepairFacts, so dropping the
// short-circuit loses no real signal; existingStructure stays display-only.
function isOutputGuardrailStructureBlock(block) {
  const codes = readOutputGuardrailIssueCodes(block);
  if (codes.length === 0) return false;
  return codes.some((code) => (
    code.includes("heading") ||
    code.includes("section") ||
    code.includes("structure") ||
    code.includes("placeholder") ||
    code.includes("artifact") ||
    code.includes("reference") ||
    code.includes("source_position") ||
    code.includes("final_")
  ));
}

function mergeOutputGuardrailStructureDeficit(existingStructure, block) {
  const base = readRecord(existingStructure) || {};
  const guardrailCodes = readOutputGuardrailIssueCodes(block);
  const issueCodes = Array.from(new Set([
    ...readStringArray$6(base.issueCodes),
    ...guardrailCodes
  ])).slice(0, 8);
  return {
    issueCodes,
    reason: readString$1w(base.reason) ||
      readString$1w(block && block.reason) ||
      "output_guardrail_blocked",
    repeatedHeadingSamples: normalizeStructureSamples(base.repeatedHeadingSamples, "heading"),
    repeatedNumberSamples: normalizeStructureSamples(base.repeatedNumberSamples, "number"),
    status: "fail"
  };
}

function readOutputGuardrailIssueCodes(block) {
  const info = readRecord(block && block.info);
  const issues = Array.isArray(info && info.issues) ? info.issues : [];
  return issues
    .map((issue) => readString$1w(issue && issue.code))
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeReadinessIssues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const issue = readRecord(entry);
      if (!issue) return null;
      return {
        code: readString$1w(issue.code) || "readiness_payload_mismatch",
        correction: readString$1w(issue.correction) || null,
        declared: issue.declared != null ? issue.declared : null,
        field: readString$1w(issue.field) || null,
        observed: issue.observed != null ? issue.observed : null,
        unit: readString$1w(issue.unit) || null
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildLengthExpansionSignal(runState, observableDeficits) {
  const length = observableDeficitsRecord(observableDeficits, "length");
  if (!length) return null;
  const observed = readNumber$c(length.observed);
  const requested = readNumber$c(length.requested);
  if (!requested || observed >= requested) return null;
  const unit = readString$1w(length.unit) || "words";
  const content = readFinalCandidateContent(runState);
  const perSectionDelta = buildPerSectionLengthDeltas(content, {
    requested,
    unit
  });
  return {
    kind: "lengthExpansionSignal",
    observed,
    requested,
    unit,
    gap: Math.max(requested - observed, 0),
    perSectionDelta,
    averageSectionGap: averagePositiveGap(perSectionDelta, Math.max(requested - observed, 0)),
    iterationCount: countWorkspaceExpansionIterations(runState)
  };
}

function buildWorkspaceRepairSignal(runState, observableDeficits, activeDeficits, allowedActions, reason, budgetState, escalation) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  if (!workspace) return null;
  const path = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : null;
  const file = files && path ? files[path] : null;
  const content = readString$1w(file && file.content);
  const fileStats = readRecord(file && file.textStats) || summarizeTextStats$1(content);
  const length = observableDeficitsRecord(observableDeficits, "length");
  const source = observableDeficitsRecord(observableDeficits, "source");
  const structureFact = observableDeficitsRecord(observableDeficits, "structure");
  const inspectedStructure = content ? inspectWorkspaceCandidateStructure(content) : null;
  const structure = mergeWorkspaceStructureFacts(structureFact, inspectedStructure);
  const hasLengthGap = Boolean(length && readNumber$c(length.requested) > readNumber$c(length.observed));
  const hasCitationGap = Boolean(source && Array.isArray(source.citationIssues) && source.citationIssues.length > 0);
  const hasStructureGap = Boolean(structure && structure.status === "fail");
  const active = hasLengthGap || hasCitationGap || hasStructureGap || readString$1w(reason).includes("workspace") || readString$1w(reason).includes("structure") || readString$1w(reason) === CANDIDATE_QUALITY_BLOCKED_REASON;
  if (!active) return null;
  const forbiddenByWorkspaceMutationGrowth = workspaceMutationGrowthHardVetoForbiddenActions(runState);
  const actions = readStringArray$6(allowedActions)
    .filter((actionName) => !forbiddenByWorkspaceMutationGrowth.has(actionName));
  const protocol = readCurrentPublishProtocol(runState);
  const mustInspectCandidate = shouldRequireWorkspaceRepairInspection({
    activeDeficits,
    allowedActions: actions,
    observableDeficits,
    runState
  });
  const sourceSummary = buildWorkspaceRepairSourceSummary(runState, observableDeficits);
  const fullRewriteAllowed = Boolean(
    (actions.includes("workspace_replace") || actions.includes("workspace_write")) &&
    (hasStructureGap || (hasLengthGap && sourceSummary.successfulReadUrlCount > 0))
  );
  return {
    kind: "workspace_repair_signal",
    path,
    reason: readString$1w(reason) || "workspace_repair_required",
    budgetState: readString$1w(budgetState) || "unknown",
    escalation: readString$1w(escalation) === "hard_veto" ? "hard_veto" : "advisory",
    latestReadStatus: {
      latestWriteIndex: readNumber$c(protocol && protocol.latestWriteIndex),
      latestFinalizeIndex: readNumber$c(protocol && protocol.latestFinalizeIndex),
      latestReadIndex: readNumber$c(protocol && protocol.latestReadIndex),
      readAfterLatestContentChange: Boolean(protocol && protocol.readAfterLatestContentChange),
      readAfterFinalize: Boolean(protocol && protocol.readAfterFinalize)
    },
    mustInspectCandidate,
    destructiveMutationRequiresInspection: Boolean(
      hasSelectedFinalCandidateContent(runState) &&
      protocol &&
      protocol.readAfterLatestContentChange !== true &&
      actions.some((actionName) => (
        actionName === "workspace_replace" ||
        actionName === "workspace_write" ||
        actionName === "workspace_multi_edit" ||
        actionName === "workspace_propose_patch"
      ))
    ),
    candidate: {
      path,
      textStats: {
        chars: readNumber$c(fileStats && fileStats.chars),
        cjkChars: readNumber$c(fileStats && fileStats.cjkChars),
        words: readNumber$c(fileStats && fileStats.words)
      },
      requestedLength: length ? readNumber$c(length.requested) : null,
      requestedLengthUnit: length ? (readString$1w(length.unit) || "words") : null,
      lengthDeficit: length ? readNumber$c(length.deficit) : 0,
      headingOutline: buildHeadingOutline(content)
    },
    structure: structure ? {
      issueCodes: readStringArray$6(structure.issueCodes).slice(0, 8),
      reason: readString$1w(structure.reason) || null,
      status: readString$1w(structure.status) || "unknown",
      repeatedHeadingSamples: normalizeStructureSamples(structure.repeatedHeadingSamples, "heading"),
      repeatedNumberSamples: normalizeStructureSamples(structure.repeatedNumberSamples, "number"),
      repeatedHeadingContexts: normalizeStructureContexts(structure.repeatedHeadingContexts, "heading"),
      repeatedNumberContexts: normalizeStructureContexts(structure.repeatedNumberContexts, "number"),
      sectionNumberRepairHints: normalizeSectionNumberRepairHints(structure.sectionNumberRepairHints),
      sectionSequenceRepairHints: normalizeSectionNumberRepairHints(structure.sectionSequenceRepairHints)
    } : null,
    citation: hasCitationGap ? {
      issueCodes: readStringArray$6(source.issueCodes).slice(0, 8),
      issues: Array.isArray(source.citationIssues)
        ? source.citationIssues.map((issue) => ({
            code: readString$1w(issue.code),
            qualityReason: readString$1w(issue.qualityReason) || null,
            qualityTier: readString$1w(issue.qualityTier) || null,
            url: readString$1w(issue.url)
          })).filter((issue) => issue.code && issue.url).slice(0, 8)
        : [],
      unreadCitedUrls: readStringArray$6(source.unreadCitedUrls).slice(0, 8),
      blockedCitedUrls: readStringArray$6(source.blockedCitedUrls).slice(0, 8)
    } : null,
    sourceSummary,
    recommendedActionOrder: buildWorkspaceRepairRecommendedActions({
      allowedActions: actions,
      forbiddenActions: Array.from(forbiddenByWorkspaceMutationGrowth),
      fullRewriteAllowed,
      hasCitationGap,
      hasLengthGap,
      hasStructureGap,
      mustInspectCandidate
    })
  };
}

function mergeWorkspaceStructureFacts(primary, inspected) {
  const first = readRecord(primary);
  const second = readRecord(inspected);
  if (!first) return second;
  if (!second) return first;
  return {
    ...second,
    ...first,
    issueCodes: readStringArray$6(first.issueCodes).length > 0 ? first.issueCodes : second.issueCodes,
    repeatedHeadingContexts: Array.isArray(first.repeatedHeadingContexts) && first.repeatedHeadingContexts.length > 0
      ? first.repeatedHeadingContexts
      : second.repeatedHeadingContexts,
    repeatedHeadingSamples: Array.isArray(first.repeatedHeadingSamples) && first.repeatedHeadingSamples.length > 0
      ? first.repeatedHeadingSamples
      : second.repeatedHeadingSamples,
    repeatedNumberContexts: Array.isArray(first.repeatedNumberContexts) && first.repeatedNumberContexts.length > 0
      ? first.repeatedNumberContexts
      : second.repeatedNumberContexts,
    repeatedNumberSamples: Array.isArray(first.repeatedNumberSamples) && first.repeatedNumberSamples.length > 0
      ? first.repeatedNumberSamples
      : second.repeatedNumberSamples,
    sectionNumberRepairHints: Array.isArray(first.sectionNumberRepairHints) && first.sectionNumberRepairHints.length > 0
      ? first.sectionNumberRepairHints
      : second.sectionNumberRepairHints,
    sectionSequenceRepairHints: Array.isArray(first.sectionSequenceRepairHints) && first.sectionSequenceRepairHints.length > 0
      ? first.sectionSequenceRepairHints
      : second.sectionSequenceRepairHints
  };
}

function buildWorkspaceRepairSourceSummary(runState, observableDeficits) {
  const context = readRecord(runState && runState.researchContext);
  const readSources = Array.isArray(context && context.readSources) ? context.readSources : [];
  const source = observableDeficitsRecord(observableDeficits, "source");
  const packet = readAcceptancePacket(runState);
  const sourceMinimum = readSourceMinimum(runState, packet);
  return {
    readSources: source ? readNumber$c(source.readSources) : Math.max(readNumber$c(sourceMinimum && sourceMinimum.readSources), readSources.length),
    relevantSources: source ? readNumber$c(source.relevantSources) : readNumber$c(sourceMinimum && sourceMinimum.relevantSources),
    minReadSources: source ? readNumber$c(source.minReadSources) : readNumber$c(sourceMinimum && sourceMinimum.minReadSources),
    minRelevantSources: source ? readNumber$c(source.minRelevantSources) : readNumber$c(sourceMinimum && sourceMinimum.minRelevantSources),
    successfulReadUrlCount: source ? readNumber$c(source.successfulReadUrlCount) : countSuccessfulReadUrlArtifacts(runState),
    samples: readSources
      .map((entry) => {
        const item = readRecord(entry);
        if (!item) return null;
        const title = readString$1w(item.title) || readString$1w(item.name) || readString$1w(item.url);
        return title ? {
          title: title.slice(0, 120),
          url: readString$1w(item.url).slice(0, 200) || null
        } : null;
      })
      .filter(Boolean)
      .slice(0, 5)
  };
}

function buildWorkspaceRepairRecommendedActions(options = {}) {
  const allowed = new Set(readStringArray$6(options.allowedActions));
  const forbidden = new Set(readStringArray$6(options.forbiddenActions));
  const recommended = [];
  const add = (actionName) => {
    if (forbidden.has(actionName)) return;
    if (allowed.has(actionName) && !recommended.includes(actionName)) recommended.push(actionName);
  };
  if (options.mustInspectCandidate) add("workspace_read");
  add("workspace_review_candidate");
  if (options.hasCitationGap) {
    add("read_url");
    add("workspace_propose_patch");
    add("workspace_apply_patch");
    add("workspace_multi_edit");
    add("workspace_replace");
  }
  if (options.hasStructureGap) {
    add("workspace_propose_patch");
    add("workspace_apply_patch");
  }
  if (options.hasLengthGap) {
    add("workspace_insert_after_section");
    add("workspace_multi_edit");
  }
  if (options.fullRewriteAllowed) {
    add("workspace_replace");
    add("workspace_write");
  }
  add(FINALIZE_CANDIDATE_ACTION);
  add(PUBLISH_DIRECT_ACTION);
  return recommended.slice(0, 10);
}

function buildHeadingOutline(content) {
  const lines = readString$1w(content).split(/\r?\n/);
  const outline = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] || "";
    const match = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const text = readString$1w(match[2]);
    const numberMatch = text.match(/^(\d+(?:\.\d+)*)\b/);
    outline.push({
      level: match[1].length,
      lineNumber: index + 1,
      number: numberMatch ? numberMatch[1] : null,
      text: text.slice(0, 160)
    });
    if (outline.length >= 24) break;
  }
  return outline;
}

function normalizeStructureContexts(value, key) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const source = readRecord(entry);
      const label = readString$1w(source && source[key]);
      if (!label) return null;
      return {
        count: readNumber$c(source.count),
        [key]: label.slice(0, 160),
        occurrences: Array.isArray(source.occurrences)
          ? source.occurrences.map((occurrence) => {
              const item = readRecord(occurrence);
              if (!item) return null;
              return {
                lineNumber: readNumber$c(item.lineNumber),
                raw: readString$1w(item.raw).slice(0, 180)
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
      const source = readRecord(entry);
      if (!source) return null;
      const lineNumber = readNumber$c(source.lineNumber);
      if (!lineNumber) return null;
      return {
        candidateNumber: readString$1w(source.candidateNumber) || null,
        currentNumber: readString$1w(source.currentNumber) || null,
        lineNumber,
        raw: readString$1w(source.raw).slice(0, 180)
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function buildAdvisoryPersistenceSignal(ignoredCount, escalation, thresholds = DEFAULT_TERMINAL_REPAIR_THRESHOLDS) {
  const count = readNumber$c(ignoredCount);
  if (readString$1w(escalation) !== "advisory") return null;
  if (count < thresholds.advisorySignal) return null;
  return {
    kind: "terminal_repair_advisory_persistence_signal",
    ignoredCount: count,
    vetoThreshold: thresholds.highWaterMark,
    stepsRemainingBeforeHardVeto: Math.max(thresholds.highWaterMark - count, 0),
    // Set by evaluateTerminalRepairState from the previous-cycle signal presence.
    // Defaults false; the dispatch paths only emit when it is true.
    advisoryThresholdFirstCrossed: false
  };
}

// AGRUN-459 — SSOT emit gate for the `terminal-repair-advisory-persistence-signal`
// step. Every dispatch path that refreshes terminal-repair state per action
// (single-action: action-loop-action.js; onResponse hook:
// hooks/terminal-repair-hook.js; plan batch: action-loop-plan-actions.js) imports
// this instead of comparing ignoredCount against a literal threshold (was the
// hardcoded `ignoredCount === 3`). The threshold (thresholds.advisorySignal) is
// read in ONE place — buildAdvisoryPersistenceSignal returns the signal only at/
// above it — and the "emit the step once, when first surfaced" decision lives in
// evaluateTerminalRepairState (advisoryThresholdFirstCrossed). Emitting on the
// presence TRANSITION (previous cycle had no signal) instead of an exact count
// is immune to ignoredCount jumping PAST the threshold (e.g. 2 -> 4 skipping the
// exact value 3), the latent bug the magic literal caused, and never spams once
// the signal persists.
function shouldEmitAdvisoryPersistenceSignalStep(advisoryPersistenceSignal) {
  return Boolean(
    advisoryPersistenceSignal &&
    typeof advisoryPersistenceSignal === "object" &&
    advisoryPersistenceSignal.advisoryThresholdFirstCrossed === true
  );
}

function buildForbiddenDecisions(deficits) {
  if (isReadinessOnlyDeficits(deficits)) {
    return ["finalize", "final_answer", "plain_workspace_publish_candidate"];
  }
  return ["ready", "finalize", "final_answer", "plain_workspace_publish_candidate"];
}

function isReadinessOnlyDeficits(deficits) {
  const active = Array.isArray(deficits) ? deficits.map(readString$1w).filter(Boolean) : [];
  return active.length === 1 && active[0] === "readiness";
}

function buildActionOrderingSignals(runState, observableDeficits, budgetState, activeDeficits, allowedActions) {
  const signals = [];
  if (shouldRequireWorkspaceRepairInspection({
    activeDeficits,
    allowedActions,
    observableDeficits,
    runState
  })) {
    signals.push({
      kind: "workspace_repair_inspection_nudge",
      preferredActions: ["workspace_read"],
      reason: "candidate_not_read_after_latest_content_change",
      workspaceWriteCount: countWorkspaceWriteOperations(runState)
    });
  }
  if (!shouldSurfaceMultiWriteIterationNudge({
    activeDeficits,
    budgetState,
    observableDeficits,
    runState
  })) {
    return signals;
  }
  const actions = readStringArray$6(allowedActions);
  const preferredActions = [
    "workspace_insert_after_section",
    "workspace_multi_edit",
    "workspace_write"
  ].filter((actionName) => actions.includes(actionName));
  signals.push({
    kind: "multi_write_iteration_nudge",
    preferredActions,
    reason: "length_deficit_with_budget_remaining_and_few_workspace_writes",
    workspaceWriteCount: countWorkspaceWriteOperations(runState)
  });
  return signals;
}

function buildAllowedActions(deficits, budgetState, reason, observableDeficits, runState, escalation, runtimeConfig) {
  const actions = new Set();
  // ADR-0033 Tier A.8 (X1 fix) — treat hard_veto state as a budget-constrained
  // exit condition for the structure-deficit branch, so AI can publish a
  // limited candidate (with structure in remainingGaps) instead of being
  // pinned into an unfixable repair loop.
    const hardVetoActive = readString$1w(escalation) === "hard_veto";
    const lowBudget = budgetState === "low" || budgetState === "exhausted" || hardVetoActive;
    const todoLimitedPublishAllowed = isBudgetConstrainedForLimitedPublish({
      budgetState,
      escalation
    });
    const hasSource = deficits.includes("source");
    const hasLength = deficits.includes("length");
    const hasStructure = deficits.includes("structure");
    const hasTodo = deficits.includes("todo");
    const hasReadiness = deficits.includes("readiness");
    const hasReadinessOrTerminalLoop = hasReadiness || deficits.includes("terminal_loop");
    const hasObservableLengthDeficit = Boolean(observableDeficitsRecord(observableDeficits, "length"));
    const hasObservableStructureDeficit = Boolean(observableDeficitsRecord(observableDeficits, "structure"));
    const hasStructureRepairSignal = hasStructure || hasObservableStructureDeficit;
    const hasProductDeficit = hasSource || hasLength || hasStructureRepairSignal;
  const terminalLoopOnly = deficits.includes("terminal_loop") &&
    !deficits.some((name) => name === "source" || name === "length" || name === "structure" || name === "todo");
  const publishProtocolReason = readString$1w(reason);
  const readOnlyPlanningForbiddenActions = readOnlyPlanningHardVetoForbiddenActions(runState);
  const readOnlyPlanningHardVeto = readOnlyPlanningForbiddenActions.size > 0;
  const workspaceMutationGrowthForbiddenActions = workspaceMutationGrowthHardVetoForbiddenActions(runState);
  const workspaceMutationGrowthHardVeto = workspaceMutationGrowthForbiddenActions.size > 0;
  const lengthLimitedPublishAllowed = shouldExposeLimitedPublishForBudget({
    budgetState,
    hardVetoActive,
    hasLengthDeficit: hasLength || hasObservableLengthDeficit,
    readOnlyPlanningHardVeto,
    workspaceMutationGrowthHardVeto
  });
  const workspacePatchSurface = resolveWorkspacePatchRepairSurface(runState, reason);
  const sourceHasUnreadCandidates = hasUnreadSourceCandidates(runState) ||
    hasUnreadCitedUrlDeficit(runState) ||
    hasUnreadCitationDeficit(observableDeficits);
  const publishProtocolContract = resolvePublishProtocolActionContract(runState);
  const protocolRecoveryAction = readString$1w(publishProtocolContract && publishProtocolContract.requiredAction);
  const protocolRequiredAction = isPublishProtocolRepairReason(publishProtocolReason)
    ? protocolRecoveryAction
    : "";
  const emptyFinalCandidate = hasEmptyFinalCandidateDeficit(observableDeficits, runState);

  if (publishProtocolReason === CANDIDATE_QUALITY_BLOCKED_REASON) {
    return buildCandidateQualityRepairActions({
      actions,
      budgetState,
      deficits,
      escalation,
      forbiddenActions: readOnlyPlanningForbiddenActions,
      protocolRequiredAction,
      runtimeConfig,
      runState,
      sourceHasUnreadCandidates,
      workspacePatchSurface
    }).slice(0, 16);
  }

  if (hardVetoActive && (hasProductDeficit || hasReadinessOrTerminalLoop || terminalLoopOnly)) {
    if (protocolRequiredAction) {
      return [protocolRequiredAction];
    }
    if (emptyFinalCandidate) {
      if (hasSource || (hasReadinessOrTerminalLoop && !hasLength && !hasTodo)) {
        addEvidenceRecoveryActions(actions, {
          forbiddenActions: readOnlyPlanningForbiddenActions,
          runtimeConfig,
          sourceHasUnreadCandidates
        });
      }
      actions.add("workspace_write");
      actions.add("workspace_replace");
      if (hasLength) {
        actions.add("workspace_insert_after_section");
      }
      addCandidateReviewRepairAction(actions, runState);
      if (hasTodo) {
        actions.add("todo_advance");
        actions.add("todo_run_next");
        actions.add("todo_cancel");
      }
      return filterReadOnlyPlanningChurnActions(
        Array.from(actions),
        {
          deficits,
          forbiddenActions: readOnlyPlanningForbiddenActions,
          protocolRequiredAction,
          sourceHasUnreadCandidates
        }
      ).slice(0, 16);
    }
      if (hasStructureRepairSignal && !hasSource && !hasLength && hasTodo) {
        addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        addCandidateReviewRepairAction(actions, runState);
        actions.add("todo_advance");
        actions.add("todo_run_next");
        actions.add("todo_cancel");
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
        return applyMultiWriteIterationNudge(Array.from(actions), {
          activeDeficits: deficits,
          budgetState,
          observableDeficits,
          runState
        }).slice(0, 16);
      }
      if (hasSource || hasLength || hasObservableLengthDeficit || hasTodo || (hasReadinessOrTerminalLoop && hasObservableLengthDeficit)) {
      if (hasSource) {
        addEvidenceRecoveryActions(actions, {
          forbiddenActions: readOnlyPlanningForbiddenActions,
          runtimeConfig,
          sourceHasUnreadCandidates
        });
      }
      if (hasStructureRepairSignal && !hasLength && !hasObservableLengthDeficit) {
        addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        if (workspacePatchSurface === "blocked_preview") {
          actions.add("workspace_replace");
        }
      }
      if (hasLength || hasObservableLengthDeficit) {
        if (workspaceMutationGrowthHardVeto) {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        }
        actions.add("workspace_read");
        actions.add("workspace_insert_after_section");
        actions.add("workspace_multi_edit");
        if (!workspaceMutationGrowthHardVeto) {
          actions.add("workspace_replace");
        }
        addCandidateReviewRepairAction(actions, runState);
      }
      if (hasTodo) {
        actions.add("todo_advance");
        actions.add("todo_run_next");
        actions.add("todo_cancel");
      }
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
        return filterReadOnlyPlanningChurnActions(
          applyMultiWriteIterationNudge(Array.from(actions), {
            activeDeficits: deficits,
            budgetState,
            observableDeficits,
            runState
          }),
          {
            deficits,
            forbiddenActions: readOnlyPlanningForbiddenActions,
            protocolRequiredAction,
            sourceHasUnreadCandidates
          }
        ).slice(0, 16);
      }
      return [PUBLISH_DIRECT_ACTION];
    }

    if (hasTodo && !hasProductDeficit) {
      if (lowBudget) {
        actions.add("todo_cancel");
      }
      actions.add("todo_advance");
      actions.add("todo_run_next");
      actions.add("todo_cancel");
      if (todoLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
      return applyMultiWriteIterationNudge(Array.from(actions), {
        activeDeficits: deficits,
        budgetState,
        observableDeficits,
        runState
      }).slice(0, 16);
    }

  if (!hasSource && !hasLength && !hasStructure && !hasTodo && publishProtocolReason === "missing_finalize_after_latest_write") {
    return [
      FINALIZE_CANDIDATE_ACTION
    ];
  }
  if (!hasSource && !hasLength && !hasStructure && !hasTodo && publishProtocolReason === "missing_latest_workspace_read") {
    return [
      "workspace_read"
    ];
  }
  if (!hasSource && !hasLength && !hasStructure && !hasTodo && publishProtocolReason === "missing_latest_candidate_review") {
    actions.add("workspace_review_candidate");
    if (hasObservableLengthDeficit) {
      actions.add("workspace_insert_after_section");
      actions.add("workspace_multi_edit");
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
    }
    return applyMultiWriteIterationNudge(Array.from(actions), {
      activeDeficits: deficits,
      budgetState,
      observableDeficits,
      runState
    }).slice(0, 16);
  }
  const readinessOnly = hasReadiness &&
    !hasSource &&
    !hasLength &&
    !hasObservableLengthDeficit &&
    !hasStructureRepairSignal &&
    !hasTodo &&
    !terminalLoopOnly;
  if (readinessOnly) {
    if (protocolRequiredAction || protocolRecoveryAction) {
      return [protocolRequiredAction || protocolRecoveryAction];
    }
    return [PUBLISH_DIRECT_ACTION];
  }

    if (hasSource || (hasReadinessOrTerminalLoop && !hasLength && !hasStructureRepairSignal && !hasTodo)) {
    addEvidenceRecoveryActions(actions, {
      forbiddenActions: readOnlyPlanningForbiddenActions,
      runtimeConfig,
      sourceHasUnreadCandidates
    });
    if (hasObservableLengthDeficit && isSourceReadQuotaSatisfied(observableDeficits)) {
      actions.add("workspace_insert_after_section");
      if (!lowBudget) {
        actions.add("workspace_write");
        actions.add("workspace_replace");
      }
    }
  }
    if (hasStructureRepairSignal) {
      const structureOnly = !hasSource && !hasLength && !hasObservableLengthDeficit;
      if (structureOnly) {
        addWorkspacePatchRepairActions(actions, workspacePatchSurface, {
          allowBlockedRetry: true
        });
      if (hasTodo) {
        actions.add("todo_advance");
        actions.add("todo_run_next");
        actions.add("todo_cancel");
      }
      addCandidateReviewRepairAction(actions, runState);
        if (lowBudget) {
          if (protocolRequiredAction || protocolRecoveryAction) {
            actions.add(protocolRequiredAction || protocolRecoveryAction);
          } else {
            if (lengthLimitedPublishAllowed) {
              actions.add(PUBLISH_DIRECT_ACTION);
            }
          }
        }
    } else {
      if (workspaceMutationGrowthHardVeto) {
        addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        actions.add("workspace_multi_edit");
      } else {
        if (!hasSource && workspacePatchSurface !== "blocked_preview") {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        }
        actions.add("workspace_write");
        actions.add("workspace_replace");
      }
      if (hasLength || hasObservableLengthDeficit) {
        actions.add("workspace_insert_after_section");
      }
      addCandidateReviewRepairAction(actions, runState);
      if (lowBudget) {
        if (protocolRequiredAction || protocolRecoveryAction) {
          actions.add(protocolRequiredAction || protocolRecoveryAction);
        } else {
          actions.add(PUBLISH_DIRECT_ACTION);
        }
      }
    }
  } else if (hasLength) {
    const length = observableDeficits && observableDeficits.length && typeof observableDeficits.length === "object"
      ? observableDeficits.length
      : null;
    const alternativeCandidate = length && length.alternativeCandidate && typeof length.alternativeCandidate === "object"
      ? length.alternativeCandidate
      : null;
    if (alternativeCandidate && alternativeCandidate.path) {
      actions.add(FINALIZE_CANDIDATE_ACTION);
      actions.add("workspace_read");
      actions.add(PUBLISH_DIRECT_ACTION);
    } else {
      if (lowBudget) {
        if (protocolRequiredAction || protocolRecoveryAction) {
          actions.add(protocolRequiredAction || protocolRecoveryAction);
        }
      }
      if (workspaceMutationGrowthHardVeto) {
        addWorkspacePatchRepairActions(actions, workspacePatchSurface);
      }
      actions.add("workspace_insert_after_section");
      actions.add("workspace_multi_edit");
      addCandidateReviewRepairAction(actions, runState);
      if (!lowBudget) {
        actions.add("workspace_read");
        if (!workspaceMutationGrowthHardVeto) {
          actions.add("workspace_write");
          actions.add("workspace_replace");
        }
      }
    }
  } else if (terminalLoopOnly && !lowBudget) {
    actions.add("workspace_read");
    if (workspaceMutationGrowthHardVeto) {
      addWorkspacePatchRepairActions(actions, workspacePatchSurface);
      actions.add("workspace_multi_edit");
    } else {
      actions.add("workspace_write");
      actions.add("workspace_replace");
    }
    actions.add("workspace_insert_after_section");
    addCandidateReviewRepairAction(actions, runState);
  }
    if (hasTodo && !hasSource && !hasLength && !hasStructureRepairSignal) {
    actions.add("todo_advance");
    actions.add("todo_run_next");
    actions.add("todo_cancel");
  }
    if (hasObservableLengthDeficit && hasReadinessOrTerminalLoop) {
      actions.add("workspace_insert_after_section");
      addCandidateReviewRepairAction(actions, runState);
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
    }
    if (
      !hasStructureRepairSignal &&
      lowBudget &&
      !protocolRequiredAction &&
      lengthLimitedPublishAllowed
    ) {
      actions.add(PUBLISH_DIRECT_ACTION);
    }
    return filterReadOnlyPlanningChurnActions(
      applyMultiWriteIterationNudge(Array.from(actions), {
        activeDeficits: deficits,
        budgetState,
        observableDeficits,
        runState
      }),
      {
        deficits,
      forbiddenActions: readOnlyPlanningForbiddenActions,
      protocolRequiredAction,
      sourceHasUnreadCandidates
    }
    ).slice(0, 16);
}

function addEvidenceRecoveryActions(actions, options = {}) {
  const recoveryActions = readEvidenceRecoveryActions(options.runtimeConfig);
  const forbiddenActions = options.forbiddenActions instanceof Set
    ? options.forbiddenActions
    : new Set();
  for (const actionName of recoveryActions) {
    if (!actionName || forbiddenActions.has(actionName)) continue;
    if (actionName === "web_search" && options.sourceHasUnreadCandidates) continue;
    actions.add(actionName);
  }
}

function buildCandidateQualityRepairActions(options = {}) {
  const actions = options.actions instanceof Set ? options.actions : new Set();
  const protocol = readCurrentPublishProtocol(options.runState);
  if (!protocol || protocol.readAfterLatestContentChange !== true) {
    actions.add("workspace_read");
  }
  if (!protocol || protocol.reviewAfterLatestContentChange !== true || protocol.reviewAfterRead !== true) {
    actions.add("workspace_review_candidate");
  }
  addEvidenceRecoveryActions(actions, {
    forbiddenActions: options.forbiddenActions,
    runtimeConfig: options.runtimeConfig,
    sourceHasUnreadCandidates: options.sourceHasUnreadCandidates
  });
  addWorkspacePatchRepairActions(actions, options.workspacePatchSurface, {
    allowBlockedRetry: true
  });
  actions.add("workspace_replace");
  actions.add("workspace_multi_edit");
  actions.add("workspace_insert_after_section");
  actions.add("workspace_write");
  if (Array.isArray(options.deficits) && options.deficits.includes("source") && isBudgetConstrainedForLimitedPublish({
    budgetState: options.budgetState,
    escalation: options.escalation
  })) {
    actions.add(PUBLISH_DIRECT_ACTION);
  }
  return filterReadOnlyPlanningChurnActions(Array.from(actions), {
    deficits: options.deficits,
    forbiddenActions: options.forbiddenActions,
    protocolRequiredAction: options.protocolRequiredAction,
    sourceHasUnreadCandidates: options.sourceHasUnreadCandidates
  });
}

function addCandidateReviewRepairAction(actions, runState) {
  if (!actions || typeof actions.add !== "function") return;
  if (shouldExposeCandidateReviewAction(runState)) {
    actions.add("workspace_review_candidate");
  }
}

function shouldExposeCandidateReviewAction(runState) {
  const protocol = readCurrentPublishProtocol(runState);
  if (!protocol) return true;
  return !(protocol.reviewAfterLatestContentChange === true && protocol.reviewAfterRead === true);
}

function shouldExposeLimitedPublishForBudget({
  budgetState,
  hardVetoActive,
  hasLengthDeficit,
  readOnlyPlanningHardVeto,
  workspaceMutationGrowthHardVeto
}) {
  if (budgetState === "exhausted" || hardVetoActive) return true;
  if (readOnlyPlanningHardVeto === true && hasLengthDeficit) return true;
  if (workspaceMutationGrowthHardVeto === true && hasLengthDeficit) return true;
  if (budgetState !== "low") return false;
  if (!hasLengthDeficit) return true;
  return false;
}

function hasEmptyFinalCandidateDeficit(observableDeficits, runState) {
  const structure = observableDeficitsRecord(observableDeficits, "structure");
  const issueCodes = readStringArray$6(structure && structure.issueCodes);
  if (issueCodes.some((code) => code === "candidate_empty" || code === "missing_candidate_content")) {
    return true;
  }
  const workspace = readRecord(runState && runState.virtualWorkspace);
  if (!workspace) return false;
  const quality = readRecord(workspace && workspace.quality);
  const finalCandidateStatus = readString$1w(quality && quality.finalCandidateStatus);
  if (finalCandidateStatus === "candidate_empty" || finalCandidateStatus === "missing_candidate_content") {
    return true;
  }
  const path = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && path ? files[path] : null;
  if (file && typeof file === "object") {
    const content = typeof file.content === "string" ? file.content : "";
    const stats = readRecord(file && file.textStats);
    const chars = readNumber$c(stats && stats.chars);
    const words = readNumber$c(stats && stats.words);
    return content.trim().length === 0 && chars === 0 && words === 0;
  }
  return issueCodes.includes("candidate_empty");
}

function observableDeficitsRecord(observableDeficits, key) {
  const source = readRecord(observableDeficits);
  return readRecord(source && source[key]);
}

function workspaceMutationGrowthHardVetoForbiddenActions(runState) {
  const convergence = readRecord(runState && runState.actionPatternConvergence);
  const state = readRecord(convergence && convergence.workspaceMutationGrowthConvergence);
  if (!state || state.active !== true || readString$1w(state.escalation) !== "hard_veto") return new Set();
  return new Set(readStringArray$6(state.forbiddenActions));
}

function addWorkspacePatchRepairActions(actions, surface, options = {}) {
  if (!actions || typeof actions.add !== "function") return;
  if (surface === "stale_preview") {
    actions.add("workspace_propose_patch");
    return;
  }
  if (surface === "blocked_preview") {
    if (options.allowBlockedRetry === true) {
      actions.add("workspace_propose_patch");
    }
    return;
  }
  if (surface === "apply_ready") {
    actions.add("workspace_apply_patch");
    return;
  }
  actions.add("workspace_propose_patch");
  actions.add("workspace_apply_patch");
}

function getWorkspacePatchRepairSurface(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const pendingPatch = readRecord(workspace && workspace.pendingPatch);
  if (!pendingPatch) return "fresh";
  const file = readRecord(workspace && workspace.files && workspace.files[pendingPatch.path]);
  const currentVersion = readNumber$c(file && file.version);
  const baseVersion = readNumber$c(pendingPatch && pendingPatch.baseVersion);
  if (file && currentVersion !== baseVersion) {
    return "stale_preview";
  }
  const status = readString$1w(pendingPatch.status);
  if (pendingPatch.valid === true && status === "preview_ready") {
    return "apply_ready";
  }
  if (status === "preview_blocked") {
    return "blocked_preview";
  }
  return "fresh";
}

function resolveWorkspacePatchRepairSurface(runState, reason) {
  const surface = getWorkspacePatchRepairSurface(runState);
  if (surface !== "fresh") return surface;
  return readString$1w(reason) === "preview_blocked" ? "blocked_preview" : surface;
}

function readOnlyPlanningHardVetoForbiddenActions(runState) {
  const convergence = readRecord(runState && runState.actionPatternConvergence);
  const state = readRecord(convergence && convergence.readOnlyPlanningState);
  if (!state || state.active !== true) return new Set();
  if (readString$1w(state.escalation) !== "hard_veto") return new Set();
  return new Set(readStringArray$6(state.forbiddenActions));
}

function hasUnreadSourceCandidates(runState) {
  const context = readRecord(runState && runState.researchContext);
  const readSources = Array.isArray(context && context.readSources) ? context.readSources : [];
  const readUrls = new Set(readSources.map((source) => normalizeUrlKey$1(readCandidateUrl(source))).filter(Boolean));
  const candidates = [
    ...(Array.isArray(runState && runState.readUrlRecoverySignal && runState.readUrlRecoverySignal.alternateSourceCandidates)
      ? runState.readUrlRecoverySignal.alternateSourceCandidates
      : []),
    ...(Array.isArray(context && context.aggregatedSearchResults) ? context.aggregatedSearchResults : []),
    ...(Array.isArray(context && context.searchResults) ? context.searchResults : []),
    ...readSearchPassItems(context && context.searchPasses)
  ];
  return candidates.some((candidate) => {
    const url = normalizeUrlKey$1(readCandidateUrl(candidate));
    return Boolean(url && !readUrls.has(url));
  });
}

function hasUnreadCitedUrlDeficit(runState) {
  const signal = readCandidateQualitySignal(runState, null);
  const deficit = buildCandidateQualityCitationDeficit(signal, runState);
  return Boolean(deficit && Array.isArray(deficit.unreadCitedUrls) && deficit.unreadCitedUrls.length > 0);
}

function hasUnreadCitationDeficit(observableDeficits) {
  const source = observableDeficitsRecord(observableDeficits, "source");
  return Boolean(source && Array.isArray(source.unreadCitedUrls) && source.unreadCitedUrls.length > 0);
}

function isSourceReadQuotaSatisfied(observableDeficits) {
  const source = observableDeficitsRecord(observableDeficits, "source");
  if (!source) return false;
  const minReadSources = readNumber$c(source.minReadSources);
  if (!minReadSources) return false;
  return readNumber$c(source.readSources) >= minReadSources;
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

function readCandidateUrl(candidate) {
  const source = readRecord(candidate);
  if (!source) return "";
  return readString$1w(source.url) || readString$1w(source.link) || readString$1w(source.href);
}

function normalizeUrlKey$1(value) {
  const url = readString$1w(value);
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

function filterReadOnlyPlanningChurnActions(actions, options = {}) {
  const source = Array.isArray(actions) ? actions : [];
  const forbidden = options.forbiddenActions instanceof Set ? options.forbiddenActions : new Set();
  if (forbidden.size === 0) return source;
  const deficits = Array.isArray(options.deficits) ? options.deficits : [];
  const remove = new Set();
  if (deficits.includes("source") && options.sourceHasUnreadCandidates === true) {
    remove.add("web_search");
  }
  if (deficits.includes("length") && !deficits.includes("structure")) {
    for (const actionName of ["workspace_read", "workspace_write", "workspace_replace"]) {
      remove.add(actionName);
    }
  }
  if (remove.size === 0) return source;
  const filtered = source.filter((actionName) => {
    if (!remove.has(actionName)) return true;
    if (actionName === readString$1w(options.protocolRequiredAction)) return true;
    return !forbidden.has(actionName);
  });
  return filtered.length > 0 ? filtered : source;
}

function applyMultiWriteIterationNudge(actions, options = {}) {
  const hasStructureRepairSignal = Boolean(observableDeficitsRecord(options.observableDeficits, "structure"));
  const forbiddenByWorkspaceMutationGrowth = workspaceMutationGrowthHardVetoForbiddenActions(options.runState);
  const preserveMultiEditForWorkspaceMutationGrowth = forbiddenByWorkspaceMutationGrowth.size > 0;
  const source = applyWorkspaceRepairInspectionNudge(
    readStringArray$6(actions).filter((actionName) => (
      (!hasStructureRepairSignal || preserveMultiEditForWorkspaceMutationGrowth || actionName !== "workspace_multi_edit") &&
      !forbiddenByWorkspaceMutationGrowth.has(actionName)
    )),
    options
  );
  if (!shouldSurfaceMultiWriteIterationNudge(options)) return source;
  const workspace = readRecord(options.runState && options.runState.virtualWorkspace);
  const finalPath = readFinalCandidatePathFromWorkspace(options.runState);
  const finalFile = readRecord(workspace && workspace.files && workspace.files[finalPath]);
  const hasCandidateContent = readString$1w(finalFile && finalFile.content).length > 0 ||
    readNumber$c(finalFile && finalFile.textStats && finalFile.textStats.words) > 0 ||
    readNumber$c(finalFile && finalFile.textStats && finalFile.textStats.chars) > 0;
  const preferred = hasCandidateContent
    ? (hasStructureRepairSignal
        ? ["workspace_insert_after_section", "workspace_replace", "workspace_write"]
        : ["workspace_insert_after_section", "workspace_multi_edit", "workspace_replace", "workspace_write"])
    : ["workspace_write"];
  const withPreferred = source.slice();
  for (const actionName of preferred.filter((name) => !forbiddenByWorkspaceMutationGrowth.has(name))) {
    if (!withPreferred.includes(actionName)) withPreferred.push(actionName);
  }
  const inspectedPreferred = applyWorkspaceRepairInspectionNudge(withPreferred, options);
  const preferredSet = new Set(preferred);
  return [
    ...inspectedPreferred.filter((actionName) => actionName === "workspace_read"),
    ...preferred.filter((actionName) => inspectedPreferred.includes(actionName)),
    ...inspectedPreferred.filter((actionName) => actionName !== "workspace_read" && !preferredSet.has(actionName))
  ];
}

function applyWorkspaceRepairInspectionNudge(actions, options = {}) {
  const source = readStringArray$6(actions);
  if (source.includes("workspace_read")) return source;
  if (!shouldRequireWorkspaceRepairInspection({
    activeDeficits: options.activeDeficits,
    allowedActions: source,
    observableDeficits: options.observableDeficits,
    runState: options.runState
  })) {
    return source;
  }
  return ["workspace_read", ...source];
}

function shouldRequireWorkspaceRepairInspection(options = {}) {
  const actions = readStringArray$6(options.allowedActions);
  const hasRepairMutation = actions.some((actionName) => (
    actionName === "workspace_apply_patch" ||
    actionName === "workspace_insert_after_section" ||
    actionName === "workspace_multi_edit" ||
    actionName === "workspace_propose_patch" ||
    actionName === "workspace_replace" ||
    actionName === "workspace_write"
  ));
  if (!hasRepairMutation) return false;
  const hasCandidate = hasSelectedFinalCandidateContent(options.runState);
  if (!hasCandidate) return false;
  const protocol = readCurrentPublishProtocol(options.runState);
  if (!protocol) return false;
  if (protocol.readAfterLatestContentChange === true) return false;
  const hasObservableRepairFact = Boolean(observableDeficitsRecord(options.observableDeficits, "length")) ||
    Boolean(observableDeficitsRecord(options.observableDeficits, "structure"));
  const activeDeficits = Array.isArray(options.activeDeficits) ? options.activeDeficits : [];
  return hasObservableRepairFact || activeDeficits.includes("terminal_loop") || activeDeficits.includes("readiness");
}

function hasSelectedFinalCandidateContent(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const path = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && path ? files[path] : null;
  if (!file || typeof file !== "object") return false;
  if (readString$1w(file.content)) return true;
  const stats = readRecord(file.textStats);
  return readNumber$c(stats && stats.words) > 0 ||
    readNumber$c(stats && stats.chars) > 0 ||
    readNumber$c(stats && stats.cjkChars) > 0;
}

function shouldSurfaceMultiWriteIterationNudge(options = {}) {
  const budgetState = readString$1w(options.budgetState);
  if (budgetState === "exhausted") return false;
  const activeDeficits = Array.isArray(options.activeDeficits) ? options.activeDeficits : [];
  if (activeDeficits.includes("source")) return false;
  const length = observableDeficitsRecord(options.observableDeficits, "length");
  if (!length) return false;
  const observed = readNumber$c(length.observed);
  const requested = readNumber$c(length.requested);
  if (!requested || observed >= requested) return false;
  return countWorkspaceWriteOperations(options.runState) < 3;
}

function countWorkspaceWriteOperations(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const operations = Array.isArray(workspace && workspace.operations) ? workspace.operations : [];
  return operations.filter((operation) => readString$1w(operation && operation.action) === "write").length;
}

function countWorkspaceExpansionIterations(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const operations = Array.isArray(workspace && workspace.operations) ? workspace.operations : [];
  const expansionActions = new Set([
    "apply_patch",
    "insert_after_section",
    "multi_edit",
    "replace",
    "write"
  ]);
  return operations.filter((operation) => expansionActions.has(readString$1w(operation && operation.action))).length;
}

function readFinalCandidateContent(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const finalPath = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && finalPath ? files[finalPath] : null;
  return readString$1w(file && file.content);
}

function buildPerSectionLengthDeltas(content, options = {}) {
  const text = readString$1w(content);
  if (!text) return [];
  const requested = readNumber$c(options.requested);
  if (!requested) return [];
  const unit = readString$1w(options.unit) || "words";
  const sections = splitMarkdownSections(text);
  if (sections.length === 0) return [];
  const target = Math.ceil(requested / sections.length);
  return sections.map((section) => {
    const stats = summarizeTextStats$1(section.content);
    const observed = readNumber$c(stats[unit]);
    return {
      heading: section.heading.slice(0, 120),
      observed,
      target,
      gap: Math.max(target - observed, 0)
    };
  }).slice(0, 8);
}

function splitMarkdownSections(text) {
  const lines = readString$1w(text).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        heading: headingMatch[2],
        content: ""
      };
      continue;
    }
    if (current) {
      current.content += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

function averagePositiveGap(perSectionDelta, fallbackGap) {
  const gaps = (Array.isArray(perSectionDelta) ? perSectionDelta : [])
    .map((entry) => readNumber$c(entry && entry.gap))
    .filter((gap) => gap > 0);
  if (gaps.length === 0) return readNumber$c(fallbackGap);
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
}

function resolveActiveRepairReason(previous, facts, actionName, context) {
  const previousReason = readString$1w(previous && previous.reason);
  const factReason = readString$1w(facts && facts.reason);
  const name = readString$1w(actionName);
  const status = readString$1w(context && context.status);
  const output = readRecord(context && context.output);
  if (
    previousReason === "missing_finalize_after_latest_write" &&
    name === FINALIZE_CANDIDATE_ACTION &&
    (readString$1w(output && output.kind) === "virtual_workspace_finalize_candidate" || status === "after_workspace_finalize_candidate")
  ) {
    const publishProtocol = readRecord(output && output.publishProtocol);
    if (publishProtocol && publishProtocol.readAfterLatestContentChange === true) {
      return factReason || "terminal_repair_required";
    }
    return "missing_latest_workspace_read";
  }
  if (
    previousReason === "missing_latest_workspace_read" &&
    name === "workspace_read" &&
    (readString$1w(output && output.kind) === "virtual_workspace_read" || status === "after_workspace_read")
  ) {
    return factReason || "terminal_repair_required";
  }
  if (isPublishProtocolRepairReason(previousReason)) {
    return previousReason;
  }
  if (
    isCandidateQualityRepairReason(previousReason) &&
    isInvalidTerminalRepairPublishBlock(output)
  ) {
    return previousReason;
  }
  return factReason || previousReason || "terminal_repair_required";
}

function isCandidateQualityRepairReason(value) {
  return readString$1w(value) === CANDIDATE_QUALITY_BLOCKED_REASON;
}

function isInvalidTerminalRepairPublishBlock(output) {
  const value = readRecord(output);
  if (!value) return false;
  return readString$1w(value.kind) === "terminal_repair_preflight_block" &&
    readString$1w(value.reason) === "terminal_repair_invalid_publish";
}

function isPublishProtocolRepairReason(value) {
  const reason = readString$1w(value);
  return reason === "missing_finalize_after_latest_write" ||
    reason === "missing_latest_workspace_read" ||
    reason === "missing_latest_candidate_review";
}

function isPublishProtocolStillBlockedForReason(runState, reason) {
  const protocol = readCurrentPublishProtocol(runState);
  if (!protocol) return false;
  const value = readString$1w(reason);
  if (value === "missing_finalize_after_latest_write") {
    return protocol.finalizedAfterLatestWrite !== true;
  }
  if (value === "missing_latest_workspace_read") {
    return protocol.readAfterLatestContentChange !== true;
  }
  if (value === "missing_latest_candidate_review") {
    return protocol.reviewAfterLatestContentChange !== true;
  }
  return false;
}

function isPublishProtocolRequiredActionCompleted(reason, actionName, output, status) {
  const repairReason = readString$1w(reason);
  const name = readString$1w(actionName);
  const outputKind = readString$1w(output && output.kind);
  const phase = readString$1w(status);
  if (repairReason === "missing_finalize_after_latest_write") {
    return name === FINALIZE_CANDIDATE_ACTION &&
      (outputKind === "virtual_workspace_finalize_candidate" || phase === "after_workspace_finalize_candidate");
  }
  if (repairReason === "missing_latest_workspace_read") {
    return name === "workspace_read" &&
      (outputKind === "virtual_workspace_read" || phase === "after_workspace_read");
  }
  if (repairReason === "missing_latest_candidate_review") {
    return name === "workspace_review_candidate" &&
      (outputKind === "virtual_workspace_review_candidate" || phase === "after_workspace_review_candidate");
  }
  return false;
}

function readOutputRepairReason(output) {
  const status = readString$1w(output && output.status);
  const reason = readString$1w(output && output.reason);
  for (const value of [status, reason]) {
    if (!value) continue;
    if (value === "ok" || value === "complete" || value === "completed") continue;
    if (value.startsWith("after_") || value.startsWith("before_")) continue;
    return value;
  }
  return null;
}

function normalizeStructureSamples(value, key) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const label = readString$1w(entry[key]);
      if (!label) return null;
      return {
        count: readNumber$c(entry.count),
        [key]: label.slice(0, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function buildValidPublishContract(deficits, observableDeficits, budgetState, escalation) {
  if (isReadinessOnlyDeficits(deficits)) {
    return {
      decision: "ready_or_limited_with_corrected_finalReadiness_facts",
      remainingGaps: "empty or omitted for ready; non-empty concrete blockers for limited",
      evidenceSatisfied: "match observed evidence facts",
      lengthSatisfied: "match observed candidate stats",
      requirementSatisfied: "match observed facts",
      structureRequirement: "not blocking",
      budgetState: budgetState || "unknown",
      observableDeficits: cloneValue(observableDeficits),
      requiredArgsExample: buildReadinessRetryArgsExample(observableDeficits),
      validTerminalException: "workspace_publish_candidate with corrected finalReadiness.requirementsAssessment fields matching latest workspace_read and read_url facts"
    };
  }
  const requiresEvidenceFalse = deficits.includes("source");
  // ADR-0033 Tier A.8 (X1 fix) — hard_veto state counts as constrained so the
  // contract surface stops insisting on structure repair when AI can't make
  // progress. AI must still mention structure in remainingGaps to publish.
  const hardVetoActive = readString$1w(escalation) === "hard_veto";
  const constrained = budgetState === "low" || budgetState === "exhausted" || hardVetoActive;
  const todoRequiresSyncFirst = deficits.includes("todo") && !constrained;
  return {
    decision: "limited",
    remainingGaps: "non-empty string array with concrete blockers",
    evidenceSatisfied: requiresEvidenceFalse
      ? false
      : "match observed evidence facts",
    lengthSatisfied: deficits.includes("length") ? false : "match observed candidate stats",
    requirementSatisfied: deficits.length > 0 ? false : "match observed facts",
    structureRequirement: deficits.includes("structure")
      ? (constrained
        ? "low/exhausted budget may publish limited only with concrete structure remainingGaps"
        : "must repair structure before terminal publish")
      : "not blocking",
    todoRequirement: deficits.includes("todo")
      ? (todoRequiresSyncFirst
        ? "must sync TodoState with todo_advance/todo_run_next/todo_cancel before publish while budget remains"
        : "budget-constrained terminal repair may publish limited only with concrete TodoState remainingGaps")
      : "not blocking",
    budgetState: budgetState || "unknown",
    observableDeficits: cloneValue(observableDeficits),
    requiredArgsExample: todoRequiresSyncFirst ? null : buildValidLimitedArgsExample(deficits, observableDeficits),
    validTerminalException: todoRequiresSyncFirst
      ? "not available until TodoState is synchronized or terminal repair is budget-constrained"
      : DEFAULT_VALID_PUBLISH_EXCEPTION
  };
}

function buildReadinessRetryArgsExample(observableDeficits) {
  const readiness = observableDeficits && observableDeficits.readiness && typeof observableDeficits.readiness === "object"
    ? observableDeficits.readiness
    : null;
  const issues = Array.isArray(readiness && readiness.issues) ? readiness.issues : [];
  const observedLengthIssue = issues.find((issue) => readString$1w(issue && issue.code) === "observed_length_mismatch");
  const sourceCountIssue = issues.find((issue) => readString$1w(issue && issue.code) === "successful_read_url_count_mismatch");
  return {
    finalReadiness: {
      decision: "ready",
      evidenceMode: "read_sources",
      requirementsAssessment: {
        checkedReadinessAgainstUserRequest: true,
        checkedReadUrlEvidence: true,
        checkedWorkspaceStats: true,
        evidenceSatisfied: "match observed evidence facts",
        lengthSatisfied: "match latest workspace_read stats",
        observedLength: observedLengthIssue ? observedLengthIssue.observed : "latest workspace_read textStats value",
        observedLengthUnit: observedLengthIssue ? observedLengthIssue.unit : "latest workspace_read unit",
        remainingGaps: [],
        requirementSatisfied: "match observed facts",
        successfulReadUrlCount: sourceCountIssue ? sourceCountIssue.observed : "observed successful read_url count"
      }
    }
  };
}

function buildValidLimitedArgsExample(deficits, observableDeficits) {
  const length = observableDeficits && observableDeficits.length && typeof observableDeficits.length === "object"
    ? observableDeficits.length
    : null;
  const source = observableDeficits && observableDeficits.source && typeof observableDeficits.source === "object"
    ? observableDeficits.source
    : null;
  const todo = observableDeficits && observableDeficits.todo && typeof observableDeficits.todo === "object"
    ? observableDeficits.todo
    : null;
  const structure = observableDeficits && observableDeficits.structure && typeof observableDeficits.structure === "object"
    ? observableDeficits.structure
    : null;
  const remainingGaps = [];
  if (source) {
    const citationIssues = Array.isArray(source.citationIssues) ? source.citationIssues : [];
    if (citationIssues.length > 0) {
      const unread = readStringArray$6(source.unreadCitedUrls);
      const blocked = readStringArray$6(source.blockedCitedUrls);
      remainingGaps.push([
        `Citation evidence is still blocked: ${citationIssues.length} cited URL(s) lack usable evidence.`,
        unread.length > 0 ? `unread=${unread.join(",")}` : "",
        blocked.length > 0 ? `blocked=${blocked.join(",")}` : ""
      ].filter(Boolean).join(" "));
    } else {
      remainingGaps.push(`Source evidence is still short: readSources=${source.readSources}/${source.minReadSources}, relevantSources=${source.relevantSources}/${source.minRelevantSources}.`);
    }
  }
  if (length) {
    remainingGaps.push(`Length is still short: observed ${length.observed}/${length.requested} ${length.unit}.`);
  }
  if (structure) {
    const issueCodes = Array.isArray(structure.issueCodes) && structure.issueCodes.length > 0
      ? structure.issueCodes.join(",")
      : (readString$1w(structure.reason) || "structure_not_ready");
    remainingGaps.push(`Structure is still not ready: ${issueCodes}.`);
  }
  if (todo) {
    remainingGaps.push(`TodoState is not fully synchronized: ${todo.unfinishedCount || 0} unfinished task(s) remain.`);
  }
  if (deficits.includes("readiness")) {
    remainingGaps.push("Previous publish readiness payload did not match observable runtime facts.");
  }
  if (deficits.includes("terminal_loop")) {
    remainingGaps.push("Repeated terminal attempts did not produce observable progress before budget ended.");
  }
  if (remainingGaps.length === 0) {
    remainingGaps.push("Terminal repair requires limited publish because observable facts still block clean ready.");
  }
  return {
    finalReadiness: {
      decision: "limited",
      evidenceMode: "read_sources",
      requirementsAssessment: {
        checkedReadinessAgainstUserRequest: true,
        checkedReadUrlEvidence: true,
        checkedWorkspaceStats: true,
        evidenceSatisfied: deficits.includes("source") ? false : true,
        lengthSatisfied: deficits.includes("length") ? false : true,
        observedLength: length ? length.observed : null,
        observedLengthUnit: length ? length.unit : null,
        remainingGaps,
        requestedLength: length ? length.requested : null,
        requirementSatisfied: false,
        successfulReadUrlCount: source ? source.successfulReadUrlCount : null,
        summary: "Limited publish because terminal repair facts show remaining observable deficits."
      }
    }
  };
}

function buildRequiredRepair(deficits, observableDeficits, allowedActions, budgetState, reason, runtimeConfig) {
  const parts = [];
  const readiness = observableDeficits && observableDeficits.readiness && typeof observableDeficits.readiness === "object"
    ? observableDeficits.readiness
    : null;
  const structure = observableDeficits && observableDeficits.structure && typeof observableDeficits.structure === "object"
    ? observableDeficits.structure
    : null;
  const length = observableDeficits && observableDeficits.length && typeof observableDeficits.length === "object"
    ? observableDeficits.length
    : null;
  const source = observableDeficits && observableDeficits.source && typeof observableDeficits.source === "object"
    ? observableDeficits.source
    : null;
  const todo = observableDeficits && observableDeficits.todo && typeof observableDeficits.todo === "object"
    ? observableDeficits.todo
    : null;
  const protocolReason = readString$1w(reason);
  if (protocolReason === "missing_finalize_after_latest_write") {
    parts.push("Publish protocol deficit: workspace content changed after the last finalized candidate; run workspace_finalize_candidate for the selected path before publishing.");
  } else if (protocolReason === "missing_latest_workspace_read") {
    parts.push("Publish protocol deficit: candidate content changed after the latest workspace_read; run workspace_read on the selected path before publishing.");
  }
  if (deficits.includes("source") && source) {
    const exhausted = budgetState === "exhausted";
    const recoveryActions = formatEvidenceRecoveryActions(runtimeConfig);
    const citationIssues = Array.isArray(source.citationIssues) ? source.citationIssues : [];
    if (citationIssues.length > 0) {
      const unread = readStringArray$6(source.unreadCitedUrls);
      const blocked = readStringArray$6(source.blockedCitedUrls);
      parts.push([
        `Citation evidence deficit: candidateQualitySignal found ${citationIssues.length} cited URL(s) without usable evidence.`,
        unread.length > 0 ? `Unread cited URLs: ${unread.join(", ")}. Use read_url on these exact URL(s) or remove/replace the unsupported citation with workspace patch/edit actions.` : "",
        blocked.length > 0 ? `Blocked cited URLs: ${blocked.join(", ")}. Remove or replace these citations with readable evidence before clean publish.` : "",
        exhausted ? "Budget is exhausted: if the exact URLs still cannot be verified immediately, publish only valid limited finalReadiness now with decision=limited, evidenceSatisfied=false, requirementSatisfied=false, and remainingGaps naming the citation evidence gap." : ""
      ].filter(Boolean).join(" "));
    } else {
      parts.push(`Evidence deficit: need ${source.readSourceDeficit || 0} more evidence artifact(s) and ${source.relevantSourceDeficit || 0} more relevant evidence artifact(s); use ${recoveryActions} before clean publish.${exhausted ? " Budget is exhausted: if you cannot improve evidence relevance immediately, publish only valid limited finalReadiness now with decision=limited, evidenceSatisfied=false, requirementSatisfied=false, and remainingGaps naming the evidence relevance gap." : ""}`);
    }
  }
    if ((deficits.includes("structure") || structure) && structure) {
      const constrained = budgetState === "low" || budgetState === "exhausted";
      const canPatch = Array.isArray(allowedActions) &&
        (allowedActions.includes("workspace_propose_patch") || allowedActions.includes("workspace_apply_patch"));
      const canRewrite = Array.isArray(allowedActions) &&
        (allowedActions.includes("workspace_write") || allowedActions.includes("workspace_replace"));
      const repairVerb = canPatch && !canRewrite
        ? "Structure signal: workspace_propose_patch can carry a normalize_headings operation against exact heading line numbers; inspect deltaWords/riskFlags, then use workspace_apply_patch only for a valid preview."
        : "Structure signal: repair the current candidate with AI-authored headings/section choices; avoid repeated read-only structure loops.";
    const headingSamples = Array.isArray(structure.repeatedHeadingSamples)
      ? structure.repeatedHeadingSamples.map((entry) => `${entry.heading} x${entry.count}`).join(" | ")
      : "";
    const numberSamples = Array.isArray(structure.repeatedNumberSamples)
      ? structure.repeatedNumberSamples.map((entry) => `${entry.number} x${entry.count}`).join(" | ")
      : "";
    parts.push([
      repairVerb,
      Array.isArray(structure.issueCodes) && structure.issueCodes.length > 0 ? `issueCodes=${structure.issueCodes.join(",")}.` : "",
      headingSamples ? `duplicateHeadings=${headingSamples}.` : "",
      numberSamples ? `duplicateNumbers=${numberSamples}.` : "",
      constrained ? "Budget is constrained: if one coherent rewrite cannot repair structure immediately, publish only valid limited finalReadiness now with decision=limited, requirementSatisfied=false, and remainingGaps naming the concrete structure/heading/section issue." : ""
    ].filter(Boolean).join(" "));
  }
  if (deficits.includes("length") && length) {
    const alternative = length.alternativeCandidate && typeof length.alternativeCandidate === "object"
      ? length.alternativeCandidate
      : null;
    if (alternative && alternative.path) {
      parts.push(`Length deficit: selected final candidate has ${length.observed}/${length.requested} ${length.unit}, but workspace file ${alternative.path} has ${alternative.observed}/${alternative.requested} ${alternative.unit}; use workspace_finalize_candidate with that path, then workspace_read it before publishing.`);
    } else {
      const constrained = budgetState === "low" || budgetState === "exhausted";
      parts.push(`Length deficit: observed ${length.observed}/${length.requested} ${length.unit}; the next workspace mutation must add enough user-facing material to close the ${length.deficit} ${length.unit} gap.${constrained ? " Budget is constrained: if the gap cannot be closed immediately with the allowed workspace action, publish only valid limited finalReadiness now with decision=limited, lengthSatisfied=false, requirementSatisfied=false, and remainingGaps naming the length gap." : ""}`);
    }
  }
  if (deficits.includes("todo") && todo) {
    const hasProductDeficit = deficits.some((name) => name === "source" || name === "length" || name === "structure");
    const onlyStructureProductDeficit = deficits.includes("structure") &&
      !deficits.includes("source") &&
      !deficits.includes("length");
    const todoActionsVisible = Array.isArray(allowedActions) &&
      (allowedActions.includes("todo_advance") || allowedActions.includes("todo_run_next") || allowedActions.includes("todo_cancel"));
    if (hasProductDeficit && onlyStructureProductDeficit && todoActionsVisible) {
      parts.push(`Todo deficit: ${todo.unfinishedCount || 0} unfinished item(s) remain after source/length gates are satisfied; keep structure repair AI-owned with the patch surface and sync stale TodoState with todo_advance/todo_run_next, or use todo_cancel if the remaining plan is obsolete.`);
    } else if (hasProductDeficit) {
      parts.push(`Todo deficit: ${todo.unfinishedCount || 0} unfinished item(s), but Todo actions are transitional until source/length/structure product deficits are resolved.`);
    } else {
      parts.push(`Todo deficit: ${todo.unfinishedCount || 0} unfinished item(s) remain after source/length/structure gates are resolved; sync TodoState with todo_advance/todo_run_next, or use todo_cancel if the remaining plan is stale, before a clean ready publish.`);
    }
  }
  if (deficits.includes("readiness") && readiness) {
    const issueSummary = Array.isArray(readiness.issues) && readiness.issues.length > 0
      ? readiness.issues.map((issue) => {
          const field = readString$1w(issue.field);
          const code = readString$1w(issue.code) || "readiness_payload_mismatch";
          const declared = issue.declared != null ? ` declared=${issue.declared}` : "";
          const observed = issue.observed != null ? ` observed=${issue.observed}` : "";
          return `${code}${field ? ` field=${field}` : ""}${declared}${observed}`;
        }).join(" | ")
      : readString$1w(readiness.message) || "readiness payload mismatch";
    parts.push(`Readiness payload deficit: prior finalReadiness did not match observable runtime facts (${issueSummary}). Correct only the listed finalReadiness fields and retry with the allowed actions; do not add source or workspace work unless source, length, structure, or Todo deficits are also active.`);
  }
  if (Array.isArray(allowedActions) && allowedActions.length > 0) {
    parts.push(`Allowed recovery actions now: ${allowedActions.join(", ")}.`);
  }
  return parts.join(" ");
}

function readBudgetState(runState, context) {
  const cycle = readNumber$c(runState && runState.cycleCount);
  const maxSteps = readNumber$c(runState && runState.maxSteps) ||
    readNumber$c(context && context.runtimeConfig && context.runtimeConfig.maxSteps);
  if (!maxSteps) return "unknown";
  const remaining = Math.max(maxSteps - cycle, 0);
  if (remaining === 0) return "exhausted";
  if (remaining <= 10) return "low";
  return "enough";
}

function readAcceptancePacket(runState) {
  const loop = readRecord(runState && runState.researchReportLoop);
  const signal = readRecord(loop && loop.gateSignal);
  return readRecord(signal && signal.acceptancePacket);
}

function readSourceMinimum(runState, packet) {
  const evidence = readRecord(packet && packet.evidence);
  if (readRecord(evidence && evidence.sourceMinimum)) return evidence.sourceMinimum;
  const loop = readRecord(runState && runState.researchReportLoop);
  return readRecord(loop && loop.sourceMinimum);
}

function readLengthStatus(packet, runState) {
  const requested = readRecord(packet && packet.requestedLength);
  const statsKey = readString$1w(requested && requested.statsKey) ||
    (readString$1w(requested && requested.unit) === "words" ? "words" : "chars");
  const requestedValue = readNumber$c(requested && requested.value);
  if (!requestedValue || !statsKey) return null;
  const candidate = readRecord(packet && packet.candidate) ||
    readRecord(packet && packet.workspace && packet.workspace.candidate);
  const stats = readRecord(candidate && candidate.textStats) || readRecord(candidate && candidate.stats) ||
    readCandidateStatsFromWorkspace(runState);
  return {
    observed: readNumber$c(stats && stats[statsKey]),
    path: readString$1w(candidate && candidate.path) || readFinalCandidatePathFromWorkspace(runState),
    requested: requestedValue,
    statsKey,
    unit: readString$1w(requested && requested.unit) || statsKey
  };
}

function readFinalCandidatePathFromWorkspace(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  return readString$1w(quality && quality.finalCandidatePath) || "final_candidate.md";
}

function readCurrentPublishProtocol(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  if (!workspace) return null;
  return inspectWorkspacePublishProtocol(workspace, readFinalCandidatePathFromWorkspace(runState));
}

function readCandidateStatsFromWorkspace(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const path = readFinalCandidatePathFromWorkspace(runState);
  const file = workspace && workspace.files && workspace.files[path] && typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  return readRecord(file && file.textStats);
}

function findWorkspaceLengthCandidate(runState, statsKey, requested, observed, currentPath) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  if (!files) return null;
  const selectedPath = readString$1w(currentPath) || readFinalCandidatePathFromWorkspace(runState);
  let best = null;
  for (const [path, file] of Object.entries(files)) {
    const safePath = readString$1w(path);
    if (!safePath || safePath === selectedPath) continue;
    const stats = readRecord(file && file.textStats);
    const value = readNumber$c(stats && stats[statsKey]);
    if (value < requested || value <= observed) continue;
    if (!best || value > best.observed) {
      best = {
        path: safePath,
        observed: value,
        requested,
        unit: statsKey
      };
    }
  }
  return best;
}

function readStructureStatus(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  return readRecord(quality && quality.finalCandidateStructure);
}

function isFinalizedCandidateSelected(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  const protocol = inspectWorkspacePublishProtocol(workspace, readFinalCandidatePathFromWorkspace(runState));
  return quality && (
    quality.finalCandidateReady === true ||
    readString$1w(quality.finalCandidateStatus) === "needs_structure_repair" ||
    readString$1w(quality.finalCandidateStatus) === "ready" ||
    (protocol && protocol.finalizedAfterLatestWrite === true)
  );
}

function readTodoStatus(runState) {
  const todoState = readRecord(runState && runState.todoState);
  if (!todoState || readString$1w(todoState.status) !== "active") {
    return { unfinishedCount: 0, activeItemId: null };
  }
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  const unfinished = items.filter((item) => {
    const status = readString$1w(item && item.status);
    return status === "active" || status === "pending" || status === "blocked";
  });
  return {
    activeItemId: readString$1w(todoState.activeItemId) || null,
    unfinishedCount: unfinished.length,
    pendingCount: unfinished.filter((item) => readString$1w(item.status) === "pending").length,
    blockedCount: unfinished.filter((item) => readString$1w(item.status) === "blocked").length
  };
}

function createProgressSnapshot(runState) {
  const packet = readAcceptancePacket(runState);
  const sourceMinimum = readSourceMinimum(runState, packet);
  const lengthStatus = readLengthStatus(packet, runState);
  const structure = readStructureStatus(runState);
  const todo = readTodoStatus(runState);
  const workspace = readRecord(runState && runState.virtualWorkspace);
  return {
    successfulReadUrlCount: readSuccessfulReadUrlCount(runState, packet),
    readSources: readNumber$c(sourceMinimum && sourceMinimum.readSources),
    relevantSources: readNumber$c(sourceMinimum && sourceMinimum.relevantSources),
    sourceMinimumPassed: sourceMinimum && sourceMinimum.passed === true,
    candidateWords: lengthStatus && lengthStatus.statsKey === "words" ? lengthStatus.observed : readNumber$c(readCandidateStatsFromWorkspace(runState)?.words),
    candidateChars: lengthStatus && lengthStatus.statsKey === "chars" ? lengthStatus.observed : readNumber$c(readCandidateStatsFromWorkspace(runState)?.chars),
    candidateCjkChars: lengthStatus && lengthStatus.statsKey === "cjkChars" ? lengthStatus.observed : readNumber$c(readCandidateStatsFromWorkspace(runState)?.cjkChars),
    workspaceVersion: readNumber$c(workspace && workspace.version),
    structureOk: structure ? structure.ok === true : false,
    todoUnfinishedCount: todo.unfinishedCount
  };
}

function normalizeProgressSnapshot(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    successfulReadUrlCount: readNumber$c(source.successfulReadUrlCount),
    readSources: readNumber$c(source.readSources),
    relevantSources: readNumber$c(source.relevantSources),
    sourceMinimumPassed: source.sourceMinimumPassed === true,
    candidateWords: readNumber$c(source.candidateWords),
    candidateChars: readNumber$c(source.candidateChars),
    candidateCjkChars: readNumber$c(source.candidateCjkChars),
    workspaceVersion: readNumber$c(source.workspaceVersion),
    structureOk: source.structureOk === true,
    todoUnfinishedCount: readNumber$c(source.todoUnfinishedCount)
  };
}

function readSuccessfulReadUrlCount(runState, packet) {
  const packetCount = packet && packet.evidence && Number.isFinite(Number(packet.evidence.successfulReadUrlCount))
    ? readNumber$c(packet.evidence.successfulReadUrlCount)
    : 0;
  return Math.max(packetCount, countSuccessfulReadUrlArtifacts(runState));
}

function diffProgress(previous, next) {
  const before = normalizeProgressSnapshot(previous);
  const after = normalizeProgressSnapshot(next);
  if (after.successfulReadUrlCount > before.successfulReadUrlCount ||
      after.readSources > before.readSources ||
      after.relevantSources > before.relevantSources ||
      (after.sourceMinimumPassed && !before.sourceMinimumPassed)) {
    return { hasProgress: true, reason: "source_progress" };
  }
  if (after.candidateWords > before.candidateWords ||
      after.candidateChars > before.candidateChars ||
      after.candidateCjkChars > before.candidateCjkChars ||
      after.workspaceVersion > before.workspaceVersion) {
    return { hasProgress: true, reason: "workspace_progress" };
  }
  if (after.structureOk && !before.structureOk) {
    return { hasProgress: true, reason: "structure_progress" };
  }
  if (after.todoUnfinishedCount < before.todoUnfinishedCount) {
    return { hasProgress: true, reason: "todo_progress" };
  }
  return { hasProgress: false, reason: null };
}

function clearTerminalRepairState(previous, reason, cycle, snapshot) {
  return {
    ...createTerminalRepairState(previous),
    active: false,
    mode: "none",
    reason: null,
    activeDeficits: [],
    observableDeficits: normalizeObservableDeficits(null),
    allowedActions: [],
    budgetState: "unknown",
    forbiddenDecisions: [],
    requiredRepair: null,
    validPublishContract: normalizeValidPublishContract(null),
    lengthExpansionSignal: null,
    workspaceRepairSignal: null,
    advisoryPersistenceSignal: null,
    actionOrderingSignals: [],
    ignoredCount: 0,
    lastUpdatedAtCycle: cycle,
    progressSnapshot: normalizeProgressSnapshot(snapshot),
    clearedReason: reason || "cleared"
  };
}

function isTerminalAttempt(actionName, context) {
  const name = readString$1w(actionName);
  if (name === PUBLISH_DIRECT_ACTION || name === "finalize" || name === "final") return true;
  const type = readString$1w(context && context.decision && context.decision.type);
  return type === "finalize" || type === "final";
}

function isTerminalCompleted(actionName, context) {
  if (!isTerminalAttempt(actionName, context)) return false;
  const output = readRecord(context && context.output);
  if (readString$1w(output && output.kind) === "final_response") return true;
  if (readString$1w(output && output.control) === "complete") return true;
  return readString$1w(context && context.status) === "complete";
}

// AGRUN-307 — actions that re-inspect the candidate without mutating it.
// Repeating one while terminal repair is active and unproductive is churn,
// not convergence. Kept narrow (review only) to match the observed dominant
// engine and minimise blast radius; workspace_read stays excluded because it
// is more often a legitimate stats refresh in the publish protocol.
const MAINTENANCE_CHURN_ACTIONS = new Set(["workspace_review_candidate"]);
function isNoProgressMaintenanceChurn(actionName, previous) {
  const name = readString$1w(actionName);
  if (!MAINTENANCE_CHURN_ACTIONS.has(name)) return false;
  // Doing the action the publish protocol is currently waiting for IS progress
  // toward terminalization — never penalise the contract-required review.
  if (getPublishProtocolRequiredActionForReason(previous && previous.reason) === name) {
    return false;
  }
  return true;
}

function isNoProgressRecoveryAttempt(actionName, output, facts) {
  const name = readString$1w(actionName);
  const result = readRecord(output);
  if (
    readString$1w(result && result.kind) === "terminal_repair_preflight_block" ||
    readString$1w(result && result.reason).startsWith("terminal_repair_")
  ) {
    return true;
  }
  if (name !== "workspace_propose_patch") return false;
  if (readString$1w(result && result.status) !== "preview_blocked") return false;
  const deficits = Array.isArray(facts && facts.activeDeficits) ? facts.activeDeficits : [];
  const observable = facts && facts.observableDeficits && typeof facts.observableDeficits === "object"
    ? facts.observableDeficits
    : {};
  return deficits.includes("structure") ||
    Boolean(observableDeficitsRecord(observable, "structure"));
}

function readActionArgs$1(context) {
  const decision = readRecord(context && context.decision);
  if (decision && readRecord(decision.args)) return decision.args;
  return readRecord(context && context.actionArgs) || readRecord(context && context.args) || {};
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
    decision: readString$1w(source.decision) || "limited",
    remainingGaps: readString$1w(source.remainingGaps) || "non-empty string array with concrete blockers",
    evidenceSatisfied: source.evidenceSatisfied === false ? false : readString$1w(source.evidenceSatisfied) || "match observed evidence facts",
    lengthSatisfied: source.lengthSatisfied === false ? false : readString$1w(source.lengthSatisfied) || "match observed candidate stats",
    requirementSatisfied: source.requirementSatisfied === false ? false : readString$1w(source.requirementSatisfied) || "match observed facts",
    structureRequirement: readString$1w(source.structureRequirement) || "not blocking",
    todoRequirement: readString$1w(source.todoRequirement) || "not blocking",
    budgetState: readString$1w(source.budgetState) || "unknown",
    observableDeficits: normalizeObservableDeficits(source.observableDeficits),
    requiredArgsExample: source.requiredArgsExample && typeof source.requiredArgsExample === "object" && !Array.isArray(source.requiredArgsExample)
      ? cloneValue(source.requiredArgsExample)
      : null,
    validTerminalException: readString$1w(source.validTerminalException) || DEFAULT_VALID_PUBLISH_EXCEPTION
    };
}

function normalizeLengthExpansionSignal(value) {
  const source = readRecord(value);
  if (!source) return null;
  const observed = readNumber$c(source.observed);
  const requested = readNumber$c(source.requested);
  if (!requested || observed >= requested) return null;
  return {
    kind: readString$1w(source.kind) || "lengthExpansionSignal",
    observed,
    requested,
    unit: readString$1w(source.unit) || "words",
    gap: readNumber$c(source.gap) || Math.max(requested - observed, 0),
    perSectionDelta: Array.isArray(source.perSectionDelta)
      ? source.perSectionDelta.map(normalizeSectionDelta).filter(Boolean).slice(0, 8)
      : [],
    averageSectionGap: readNumber$c(source.averageSectionGap),
    iterationCount: readNumber$c(source.iterationCount)
  };
}

function normalizeWorkspaceRepairSignal(value) {
  const source = readRecord(value);
  if (!source) return null;
  const path = readString$1w(source.path);
  if (!path) return null;
  const candidate = readRecord(source.candidate);
  const latestReadStatus = readRecord(source.latestReadStatus);
  const structure = readRecord(source.structure);
  const citation = readRecord(source.citation);
  const sourceSummary = readRecord(source.sourceSummary);
  return {
    kind: readString$1w(source.kind) || "workspace_repair_signal",
    path,
    reason: readString$1w(source.reason) || "workspace_repair_required",
    budgetState: readString$1w(source.budgetState) || "unknown",
    escalation: readString$1w(source.escalation) === "hard_veto" ? "hard_veto" : "advisory",
    latestReadStatus: latestReadStatus ? {
      latestWriteIndex: readNumber$c(latestReadStatus.latestWriteIndex),
      latestFinalizeIndex: readNumber$c(latestReadStatus.latestFinalizeIndex),
      latestReadIndex: readNumber$c(latestReadStatus.latestReadIndex),
      readAfterLatestContentChange: latestReadStatus.readAfterLatestContentChange === true,
      readAfterFinalize: latestReadStatus.readAfterFinalize === true
    } : null,
    mustInspectCandidate: source.mustInspectCandidate === true,
    destructiveMutationRequiresInspection: source.destructiveMutationRequiresInspection === true,
    candidate: candidate ? {
      path: readString$1w(candidate.path) || path,
      textStats: normalizeTextStats$1(candidate.textStats),
      requestedLength: candidate.requestedLength == null ? null : readNumber$c(candidate.requestedLength),
      requestedLengthUnit: readString$1w(candidate.requestedLengthUnit) || null,
      lengthDeficit: readNumber$c(candidate.lengthDeficit),
      headingOutline: Array.isArray(candidate.headingOutline)
        ? candidate.headingOutline.map(normalizeHeadingOutlineEntry).filter(Boolean).slice(0, 24)
        : []
    } : null,
    structure: structure ? {
      issueCodes: readStringArray$6(structure.issueCodes).slice(0, 8),
      reason: readString$1w(structure.reason) || null,
      status: readString$1w(structure.status) || "unknown",
      repeatedHeadingSamples: normalizeStructureSamples(structure.repeatedHeadingSamples, "heading"),
      repeatedNumberSamples: normalizeStructureSamples(structure.repeatedNumberSamples, "number"),
      repeatedHeadingContexts: normalizeStructureContexts(structure.repeatedHeadingContexts, "heading"),
      repeatedNumberContexts: normalizeStructureContexts(structure.repeatedNumberContexts, "number"),
      sectionNumberRepairHints: normalizeSectionNumberRepairHints(structure.sectionNumberRepairHints),
      sectionSequenceRepairHints: normalizeSectionNumberRepairHints(structure.sectionSequenceRepairHints)
    } : null,
    citation: citation ? {
      issueCodes: readStringArray$6(citation.issueCodes).slice(0, 8),
      issues: Array.isArray(citation.issues)
        ? citation.issues.map((issue) => {
            const item = readRecord(issue);
            if (!item) return null;
            const code = readString$1w(item.code);
            const url = readString$1w(item.url);
            return code && url ? {
              code,
              qualityReason: readString$1w(item.qualityReason) || null,
              qualityTier: readString$1w(item.qualityTier) || null,
              url: url.slice(0, 300)
            } : null;
          }).filter(Boolean).slice(0, 8)
        : [],
      unreadCitedUrls: readStringArray$6(citation.unreadCitedUrls).slice(0, 8),
      blockedCitedUrls: readStringArray$6(citation.blockedCitedUrls).slice(0, 8)
    } : null,
    sourceSummary: sourceSummary ? {
      readSources: readNumber$c(sourceSummary.readSources),
      relevantSources: readNumber$c(sourceSummary.relevantSources),
      minReadSources: readNumber$c(sourceSummary.minReadSources),
      minRelevantSources: readNumber$c(sourceSummary.minRelevantSources),
      successfulReadUrlCount: readNumber$c(sourceSummary.successfulReadUrlCount),
      samples: Array.isArray(sourceSummary.samples)
        ? sourceSummary.samples.map((sample) => {
            const item = readRecord(sample);
            if (!item) return null;
            const title = readString$1w(item.title);
            return title ? {
              title: title.slice(0, 120),
              url: readString$1w(item.url).slice(0, 200) || null
            } : null;
          }).filter(Boolean).slice(0, 5)
        : []
    } : null,
    recommendedActionOrder: readStringArray$6(source.recommendedActionOrder).slice(0, 10)
  };
}

function normalizeTextStats$1(value) {
  const source = readRecord(value) || {};
  return {
    chars: readNumber$c(source.chars),
    cjkChars: readNumber$c(source.cjkChars),
    words: readNumber$c(source.words)
  };
}

function normalizeHeadingOutlineEntry(value) {
  const source = readRecord(value);
  if (!source) return null;
  const lineNumber = readNumber$c(source.lineNumber);
  const text = readString$1w(source.text);
  if (!lineNumber || !text) return null;
  return {
    level: readNumber$c(source.level),
    lineNumber,
    number: readString$1w(source.number) || null,
    text: text.slice(0, 160)
  };
}

function normalizeSectionDelta(value) {
  const source = readRecord(value);
  if (!source) return null;
  return {
    heading: readString$1w(source.heading).slice(0, 120),
    observed: readNumber$c(source.observed),
    target: readNumber$c(source.target),
    gap: readNumber$c(source.gap)
  };
}

function normalizeAdvisoryPersistenceSignal(value) {
  const source = readRecord(value);
  if (!source) return null;
  const ignoredCount = readNumber$c(source.ignoredCount);
  if (ignoredCount < TERMINAL_REPAIR_ADVISORY_SIGNAL_THRESHOLD) return null;
  return {
    kind: readString$1w(source.kind) || "terminal_repair_advisory_persistence_signal",
    ignoredCount,
    vetoThreshold: readNumber$c(source.vetoThreshold) || TERMINAL_REPAIR_HIGH_WATER_MARK,
    stepsRemainingBeforeHardVeto: readNumber$c(source.stepsRemainingBeforeHardVeto),
    advisoryThresholdFirstCrossed: source.advisoryThresholdFirstCrossed === true
  };
}

function normalizeActionOrderingSignals(value) {
  return Array.isArray(value)
    ? value.map(normalizeActionOrderingSignal).filter(Boolean).slice(0, 4)
    : [];
}

function normalizeActionOrderingSignal(value) {
  const source = readRecord(value);
  if (!source) return null;
  const kind = readString$1w(source.kind);
  if (!kind) return null;
  return {
    kind,
    preferredActions: readStringArray$6(source.preferredActions).slice(0, 8),
    reason: readString$1w(source.reason) || null,
    workspaceWriteCount: readNumber$c(source.workspaceWriteCount)
  };
}

function mentionsGap(gaps, keywords) {
  const text = readStringArray$6(gaps).join(" ").toLowerCase();
  return keywords.some((keyword) => text.includes(keyword));
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readString$1w(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray$6(value) {
  return Array.isArray(value) ? value.map(readString$1w).filter(Boolean) : [];
}

function readNumber$c(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function readNullableNumber$2(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export { buildBudgetRemainingForExpansionSignal, buildTerminalRepairRefreshedStepDetail, createTerminalRepairState, evaluateTerminalRepairState, explainTerminalRepairPublishArgs, getPublishProtocolRequiredActionForReason, isBudgetConstrainedForLimitedPublish, isOutputGuardrailStructureBlock, isPublishProtocolRequiredActionForRepair, isValidTerminalRepairPublishArgs, isWorkspaceRepairInspectionActionForRepair, refreshTerminalRepairState, resolvePublishProtocolActionContract, resolveTerminalRepairThresholds, shouldEmitAdvisoryPersistenceSignalStep, summarizeTerminalRepairState };
