import { cloneValue } from '../utils.js';
import { FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_REVIEW_CANDIDATE_ACTION } from '../action-names.js';
import { createTerminalRepairState, readNullableNumber, readString, readRecord, isTerminalCompleted, isTerminalAttempt, readNumber, resolveTerminalRepairThresholds, hasSelectedFinalCandidateContent, observableDeficitsRecord, readCandidateStatsFromWorkspace, normalizeProgressSnapshot, normalizeValidPublishContract, normalizeObservableDeficits } from './internal-utils.js';
import { isValidTerminalRepairPublishArgs, isPublishProtocolRepairReason, isPublishProtocolRequiredActionCompleted, isPublishProtocolStillBlockedForReason, isCandidateQualityRepairReason, buildValidPublishContract, buildRequiredRepair, getPublishProtocolRequiredActionForReason, isInvalidTerminalRepairPublishBlock, isReadinessOnlyDeficits } from './publish-contract.js';
import { readSharedRepairFactReads, readRepairFacts, readSuccessfulReadUrlCount } from './facts.js';
import { buildLengthExpansionSignal, buildWorkspaceRepairSignal, buildAdvisoryPersistenceSignal, buildActionOrderingSignals } from './signals.js';
import { buildAllowedActions } from './allowed-actions.js';
import { TERMINAL_ESCAPE_RULE_DESCRIPTORS } from './escape-rules.js';
import { resetContentStructureExitEpisode, updateContentStructureExitEpisode, buildContentStructureExitSignal } from './content-structure-exit.js';

// H10 split, Step 6 (AGRUN-508) — terminal-repair core state machine.
// VERBATIM moves from terminal-repair-state.js (see
// agrun_docs/terminal-repair-split-design-2026-06-12.md). The evaluate/refresh
// state transitions, progress snapshot + diff (the ignoredCount/churn-escape
// driver — snapshot-BEFORE-diff ordering is load-bearing), clear, active-reason
// resolution, maintenance-churn/no-progress classifiers, the SSOT step-detail
// payload, the budget-expansion signal, and the advisory-persistence emit gate.
// Six functions here are PUBLIC API, re-exported through the
// terminal-repair-state.js barrel.

// AGRUN-493 (audit M13) — INVARIANT: this is a STATE-TRANSITION function, not a
// pure read. It mutates runState.terminalRepairState and ticks ignoredCount per
// the (status, actionName, output) context. It is called at up to three DISTINCT
// lifecycle phases per cycle, each with a DISTINCT context and each performing a
// DISTINCT transition:
//   1. preRequest hook    status:"before_planner"                — refresh so the
//                          planner prompt sees current deficits (no actionName).
//   2. onResponse hook     status:"terminal_repair_direct_terminal_block"
//                          — block a direct final/finalize while repair is active.
//   3. per-action post     the executed action's real result, on the single-action
//                          door (action-loop-action.js) OR the plan door
//                          (action-loop-plan-actions.js) — the two are mutually
//                          exclusive, so it is one post-execution call, not two.
// The audit framed this as "called up to 4×, cache the result." Caching/memoizing
// the RESULT across these calls is INCORRECT: it would skip the per-phase
// ignoredCount progression that drives escalation → hard_veto →
// publishLoopEscapeGranted (the AGRUN-307 churn-bound escape), re-trapping runs in
// the never-terminating publish loop AGRUN-307/309/310 fixed. The calls are phased
// transitions, not redundant reads. The only genuine redundancy is INTRA-call —
// createProgressSnapshot + readRepairFacts recompute the same acceptance-packet /
// sourceMinimum / length / structure / todo reads once each — which belongs to the
// H10 god-object split (with full coverage), NOT a result cache. Pinned by
// test/unit/terminal-repair-refresh-phase-guard.test.js.
function refreshTerminalRepairState(runState, context = {}) {
  if (!runState || typeof runState !== "object") return null;
  const previous = createTerminalRepairState(runState.terminalRepairState);
  const next = evaluateTerminalRepairState(runState, { ...context, previous });
  runState.terminalRepairState = next;
  return next;
}

function evaluateTerminalRepairState(runState, context = {}) {
  const previous = createTerminalRepairState(context.previous);
  const cycle = readNullableNumber(runState && runState.cycleCount);
  // AGRUN-510 — compute the shared pure reads once; both the progress snapshot
  // and readRepairFacts consume the same bundle (intra-call dedup, M13).
  const sharedReads = readSharedRepairFactReads(runState);
  const snapshot = createProgressSnapshot$1(runState, sharedReads);
  const progress = diffProgress$1(previous.progressSnapshot, snapshot);
  const actionName = readString(context.actionName);
  const output = readRecord(context.output);
  const completedTerminal = isTerminalCompleted(actionName, context);

  if (completedTerminal) {
    // The run reached a real terminal — reset the run-level cumulative churn
    // counter so a fresh turn starts clean. (A transient clear for progress
    // below deliberately does NOT reset it; only genuine completion does.)
    if (runState && typeof runState === "object") {
      runState.terminalRepairCumulativeIgnored = 0;
    }
    // AGRUN-542 — genuine completion ends any content-structure exit episode.
    resetContentStructureExitEpisode(runState);
    return clearTerminalRepairState(previous, "terminal_completed", cycle, snapshot);
  }

  const facts = readRepairFacts(runState, context, sharedReads);
  const validLimited = isValidTerminalRepairPublishArgs(readActionArgs$1(context), {
    ...previous,
    active: true,
    activeDeficits: facts.activeDeficits
  });

  const publishProtocolActionPending = isPublishProtocolRepairReason(previous.reason) &&
    readString(context && context.status) === "before_action";
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
    readString(previous.reason) === "missing_finalize_after_latest_write" &&
    actionName === FINALIZE_CANDIDATE_ACTION &&
    (readString(output && output.kind) === "virtual_workspace_finalize_candidate" ||
      readString(context && context.status) === "after_workspace_finalize_candidate");
  if (
    previous.active &&
    !facts.forceActive &&
    facts.activeDeficits.length === 0 &&
    !publishProtocolActionPending &&
    !publishProtocolStillBlocked &&
    !publishProtocolTransitionPending
  ) {
    // AGRUN-542 — all observable deficits resolved: any content-structure exit
    // episode is over (the structure fact must have cleared for this branch to
    // be reachable — finalizedStructureBlocked would otherwise force-activate).
    resetContentStructureExitEpisode(runState);
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
  // AGRUN-550 — robust suppressed-terminal signal for the cumulative counter.
  // ignoredTerminal above gates on previous.active, but the
  // before_planner<->onResponse two-phase refresh can flip previous.active to
  // false at the EXACT cycle a direct finalize is suppressed (the before_planner
  // refresh clears, the onResponse refresh reactivates via forceActive). That
  // pins BOTH ignoredCount and the cumulative counter at 0 forever, so a weak
  // model that spams direct finalize without ever drafting a candidate never
  // escalates to hard_veto and thrashes to the run deadline with EMPTY output
  // (deepseek-v4-flash high, 2026-06-25 live: 22 identical direct-terminal
  // blocks, ignoredCount stuck at 0). We are already past the !shouldActivate
  // early return here, so shouldActivate (previous.active || forceActive) is
  // true; counting a terminal that THIS evaluation is suppressing — independent
  // of previous.active — closes the oscillation blind spot. Same conditions as
  // ignoredTerminal minus the previous.active requirement.
  const suppressedTerminalThisCycle = isTerminalAttempt(actionName, context) &&
    !completedTerminal &&
    !validLimited &&
    !progress.hasProgress;
  // AGRUN-307 — cumulative ignored attempts ACROSS the whole run. The per-state
  // ignoredCount above is reset by clearTerminalRepairState, so a
  // clear<->reactivate oscillation (deficits empty then return as terminal_loop)
  // keeps it below threshold forever — observed live (sawtooth 0->2->0->...).
  // This counter lives on runState and survives clear, so a genuinely stuck
  // loop still reaches the absolute cap and converges to the escape. Only
  // no-progress cycles increment it, so progress-making (healthy) runs never
  // approach the cap. AGRUN-550 widened the increment to suppressedTerminalThisCycle
  // so the active-oscillation cannot defeat it.
  const cumulativeIgnoredCount = (readNumber(runState && runState.terminalRepairCumulativeIgnored) || 0)
    + ((ignoredThisCycle || suppressedTerminalThisCycle) ? 1 : 0);
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
    // AGRUN-542 — content-structure exit episode (STATE-TRANSITION, mutates
    // runState.contentStructureExitState). MUST run before buildAllowedActions:
    // once forcedPublish flips true, the allowed-action surface collapses to
    // [workspace_publish_candidate] on BOTH dispatch doors (single-action
    // preflight allowlist + plan-batch planner-action-surface filter both read
    // the same allowedActions this evaluation produces). Called only inside
    // this active branch so a drafting-phase duplicate heading can never burn
    // the repair-attempt budget before terminal repair is engaged.
    const contentStructureExit = updateContentStructureExitEpisode(runState, {
      actionName,
      activeDeficits,
      observableDeficits: facts.observableDeficits,
      ignoredCount,
      output,
      thresholds
    });
    const allowedActions = buildAllowedActions(activeDeficits, facts.budgetState, activeReason, facts.observableDeficits, runState, escalation, context.runtimeConfig);
    // AGRUN-555 (Staff review 2026-07-02) — the four graceful-degradation escape
    // valves below (AGRUN-307 source, AGRUN-307 publish-loop, AGRUN-309
    // candidate-quality, AGRUN-550 terminal-thrash) used to be four separate
    // `const` booleans, each manually chaining `!previousFlag` exclusions to stay
    // mutually exclusive. That meant adding a new escape valve required editing
    // every existing condition. terminalEscapeRules is the single ordered
    // dispatcher: each rule's `granted` predicate is its ORIGINAL domain
    // condition (unchanged, still narrow-by-design per the tickets below) MINUS
    // any `!siblingFlag` term — exclusivity is supplied by evaluation order
    // (first match wins) instead of manual negation chains.
    //
    // AGRUN-559 — the rule METADATA (key, opensFinalize/opensPublish priority
    // order, observability reason) now comes from the shared
    // TERMINAL_ESCAPE_RULE_DESCRIPTORS (escape-rules.js), the same descriptor
    // list every door consumer resolves granted escapes through
    // (resolveGrantedTerminalEscape). Adding a 5th escape valve is now: append
    // one descriptor in priority position there + one grant predicate here —
    // the hook/blocks/publish doors honor it automatically instead of each
    // hardcoding flag names (the AGRUN-550 bug shape).
    const terminalEscapeGrants = {
      // AGRUN-542 — content-level structure exit: the single content-changing
      // repair attempt budget is used (or the model kept ignoring the repair
      // contract past the hardVeto threshold) while length + sources are
      // satisfied and a real candidate exists, yet the content-level structure
      // issue remains. Opens PUBLISH only — finalize would re-compress a
      // length-satisfied candidate. Grant predicate is mutually exclusive with
      // the source/candidate-quality escapes below (those require a source
      // deficit; this requires source satisfied).
      contentStructureExitForcedPublishGranted:
        contentStructureExit.active === true &&
        contentStructureExit.forcedPublish === true,
      // AGRUN-307 — zero-evidence source deficit is unresolvable: the AI has
      // repeatedly tried to terminate (ignoredCount >= hardVeto) yet has ZERO
      // successful read sources. Open final/finalize so the AI can answer with
      // honest limitations instead of burning the budget on a dead repair loop.
      sourceDeficitEscapeGranted:
        activeDeficits.includes("source") &&
        !isCandidateQualityRepairReason(activeReason) &&
        Boolean(facts.observableDeficits.source) &&
        readNumber(facts.observableDeficits.source.successfulReadUrlCount) === 0 &&
        ignoredCount >= thresholds.hardVeto,
      // AGRUN-307 — the publish protocol (write -> finalize -> read -> review ->
      // publish) can be un-convergeable for a weak model that keeps emitting a
      // publish the validator rejects. Once hard_veto fires and a real drafted
      // candidate exists, accept it as-is via the publish gate. Deliberately
      // does NOT open finalize (that would re-summarize/compress the drafted
      // report) — it routes through workspace_publish_candidate instead; see
      // the descriptor's opensPublish and the publish gate's handling.
      publishLoopEscapeGranted:
        escalation === "hard_veto" &&
        !isCandidateQualityRepairReason(activeReason) &&
        hasSelectedFinalCandidateContent(runState),
      // AGRUN-309 — graceful-degradation escape for an unresolvable candidate-
      // quality citation loop (unread_cited_url / blocked_source_cited). Opens
      // finalize (an honest terminal answer), NOT workspace_publish_candidate,
      // so it never force-publishes a "verified report" citing an unread URL.
      candidateQualityUnresolvable:
        isCandidateQualityRepairReason(activeReason) &&
        escalation === "hard_veto" &&
        hasSelectedFinalCandidateContent(runState),
      // AGRUN-550 — a weak model can spam direct finalize without ever drafting
      // a candidate; once hard_veto is reached and still no candidate content
      // exists, open finalize so the runtime finalizer delivers an honest
      // answer from the gathered evidence instead of an empty stub.
      terminalThrashEscapeGranted:
        escalation === "hard_veto" &&
        !hasSelectedFinalCandidateContent(runState)
    };
    const terminalEscapeRules = TERMINAL_ESCAPE_RULE_DESCRIPTORS.map((rule) => ({
      ...rule,
      granted: terminalEscapeGrants[rule.key] === true
    }));
    const resolvedTerminalEscape = terminalEscapeRules.find((rule) => rule.granted) || null;
    const contentStructureExitForced = resolvedTerminalEscape?.key === "contentStructureExitForcedPublishGranted";
    const sourceUnresolvable = resolvedTerminalEscape?.key === "sourceDeficitEscapeGranted";
    const publishLoopUnresolvable = resolvedTerminalEscape?.key === "publishLoopEscapeGranted";
    const candidateQualityUnresolvable = resolvedTerminalEscape?.key === "candidateQualityUnresolvable";
    const terminalThrashUnresolvable = resolvedTerminalEscape?.key === "terminalThrashEscapeGranted";
    // AGRUN-560 — mirror the opensFinalize augmentation for opensPublish. Without
    // this, a granted publishLoopEscapeGranted (opensFinalize:false,
    // opensPublish:true) never added workspace_publish_candidate to
    // allowedActions, so selectPlannerActions (planner-action-surface.js line
    // ~101 `if (allowedRepairActions) return allowedRepairActions.has(name)`)
    // filtered the action out of the PLAN-BATCH surface before the escape-aware
    // veto gate (blocks/terminal-repair.js maybeBlockTerminalRepairAction) ever
    // ran — a Dispatch-Path Parity gap: the escape worked on the single-action
    // path (that gate short-circuits on the escape flag directly, independent
    // of allowedActions) but was invisible to the plan-batch path. Confirmed via
    // test/livekit/repro-workspace-publish-loop.mjs: publishLoopEscapeGranted
    // reached true but the run still deadlined to maxSteps with
    // finalAnswerSource=continuation_required, 0 executor-level publish
    // attempts reaching workspace-candidate-executors.js.
    const effectiveAllowedActions = resolvedTerminalEscape && (resolvedTerminalEscape.opensFinalize || resolvedTerminalEscape.opensPublish)
      ? Array.from(new Set([
          ...allowedActions,
          ...(resolvedTerminalEscape.opensFinalize ? ["final", "finalize"] : []),
          ...(resolvedTerminalEscape.opensPublish ? [PUBLISH_DIRECT_ACTION] : [])
        ]))
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
    contentStructureExitForcedPublishGranted: contentStructureExitForced,
    contentStructureExitSignal: buildContentStructureExitSignal(contentStructureExit),
    sourceDeficitEscapeGranted: sourceUnresolvable,
    publishLoopEscapeGranted: publishLoopUnresolvable,
    candidateQualityUnresolvable,
    terminalThrashEscapeGranted: terminalThrashUnresolvable,
      forbiddenDecisions: (sourceUnresolvable || candidateQualityUnresolvable || terminalThrashUnresolvable)
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
  // AGRUN-542 — the exit signal is not preserved by createTerminalRepairState
  // (it is recomputed per evaluation, like the escape flags), so read it from
  // the RAW state for the planner-prompt summary.
  const rawContentStructureExitSignal = value && typeof value === "object" && !Array.isArray(value) &&
    value.contentStructureExitSignal && typeof value.contentStructureExitSignal === "object"
    ? value.contentStructureExitSignal
    : null;
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
      contentStructureExitSignal: rawContentStructureExitSignal,
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
    contentStructureExitSignal: repair.contentStructureExitSignal && typeof repair.contentStructureExitSignal === "object"
      ? cloneValue(repair.contentStructureExitSignal)
      : null,
    ignoredCount: repair.ignoredCount || 0,
    lengthExpansionSignal: repair.lengthExpansionSignal || null,
    workspaceRepairSignal: repair.workspaceRepairSignal
      ? cloneValue(repair.workspaceRepairSignal)
      : null,
    reason: repair.reason || null,
    status: repair.mode || "none"
  };
}

// AGRUN-509 — the advisory gate reads the HOST-RESOLVED threshold
// (runtimeConfig.terminalRepair.thresholds.advisorySignal) instead of the
// default constant, so a host that retunes the advisory threshold gets a
// consistent policy across the persistence signal AND this expansion signal.
// Omitting runtimeConfig preserves the historical default (3).
function buildBudgetRemainingForExpansionSignal(terminalRepairState, ignoredCountOverride, runtimeConfig) {
  const state = createTerminalRepairState(terminalRepairState);
  const ignoredCount = ignoredCountOverride == null
    ? state.ignoredCount
    : readNumber(ignoredCountOverride);
  const length = observableDeficitsRecord(state.observableDeficits, "length");
  if (state.budgetState !== "enough") return null;
  if (ignoredCount < resolveTerminalRepairThresholds(runtimeConfig).advisorySignal) return null;
  if (!length) return null;
  const observed = readNumber(length.observed);
  const requested = readNumber(length.requested);
  if (!requested || observed >= requested) return null;
  return {
    kind: "budget_remaining_for_expansion",
    budgetState: state.budgetState,
    ignoredCount,
    observed,
    requested,
    unit: readString(length.unit) || "words",
    gap: Math.max(requested - observed, 0)
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

// AGRUN-510 (audit M13 follow-up) — accepts the optional precomputed shared
// reads bundle so evaluateTerminalRepairState derives the five packet/minimum/
// length/structure/todo reads ONCE per call instead of here AND in
// readRepairFacts. Omitting the bundle preserves standalone behavior.
function createProgressSnapshot$1(runState, sharedReads) {
  const reads = sharedReads || readSharedRepairFactReads(runState);
  const packet = reads.packet;
  const sourceMinimum = reads.sourceMinimum;
  const lengthStatus = reads.lengthStatus;
  const structure = reads.structure;
  const todo = reads.todo;
  const workspace = readRecord(runState && runState.virtualWorkspace);
  return {
    successfulReadUrlCount: readSuccessfulReadUrlCount(runState, packet),
    readSources: readNumber(sourceMinimum && sourceMinimum.readSources),
    relevantSources: readNumber(sourceMinimum && sourceMinimum.relevantSources),
    sourceMinimumPassed: sourceMinimum && sourceMinimum.passed === true,
    candidateWords: lengthStatus && lengthStatus.statsKey === "words" ? lengthStatus.observed : readNumber(readCandidateStatsFromWorkspace(runState)?.words),
    candidateChars: lengthStatus && lengthStatus.statsKey === "chars" ? lengthStatus.observed : readNumber(readCandidateStatsFromWorkspace(runState)?.chars),
    candidateCjkChars: lengthStatus && lengthStatus.statsKey === "cjkChars" ? lengthStatus.observed : readNumber(readCandidateStatsFromWorkspace(runState)?.cjkChars),
    workspaceVersion: readNumber(workspace && workspace.version),
    structureOk: structure ? structure.ok === true : false,
    todoUnfinishedCount: todo.unfinishedCount
  };
}

function diffProgress$1(previous, next) {
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

function resolveActiveRepairReason(previous, facts, actionName, context) {
  const previousReason = readString(previous && previous.reason);
  const factReason = readString(facts && facts.reason);
  const name = readString(actionName);
  const status = readString(context && context.status);
  const output = readRecord(context && context.output);
  if (
    previousReason === "missing_finalize_after_latest_write" &&
    name === FINALIZE_CANDIDATE_ACTION &&
    (readString(output && output.kind) === "virtual_workspace_finalize_candidate" || status === "after_workspace_finalize_candidate")
  ) {
    const publishProtocol = readRecord(output && output.publishProtocol);
    if (publishProtocol && publishProtocol.readAfterLatestContentChange === true) {
      return factReason || "terminal_repair_required";
    }
    return "missing_latest_workspace_read";
  }
  if (
    previousReason === "missing_latest_workspace_read" &&
    name === WORKSPACE_READ_ACTION &&
    (readString(output && output.kind) === "virtual_workspace_read" || status === "after_workspace_read")
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

// AGRUN-307 — actions that re-inspect the candidate without mutating it.
// Repeating one while terminal repair is active and unproductive is churn,
// not convergence. Kept narrow (review only) to match the observed dominant
// engine and minimise blast radius; workspace_read stays excluded because it
// is more often a legitimate stats refresh in the publish protocol.
const MAINTENANCE_CHURN_ACTIONS = new Set([WORKSPACE_REVIEW_CANDIDATE_ACTION]);

function isNoProgressMaintenanceChurn(actionName, previous) {
  const name = readString(actionName);
  if (!MAINTENANCE_CHURN_ACTIONS.has(name)) return false;
  // Doing the action the publish protocol is currently waiting for IS progress
  // toward terminalization — never penalise the contract-required review.
  if (getPublishProtocolRequiredActionForReason(previous && previous.reason) === name) {
    return false;
  }
  return true;
}

function isNoProgressRecoveryAttempt(actionName, output, facts) {
  const name = readString(actionName);
  const result = readRecord(output);
  if (
    readString(result && result.kind) === "terminal_repair_preflight_block" ||
    readString(result && result.reason).startsWith("terminal_repair_")
  ) {
    return true;
  }
  if (name !== WORKSPACE_PROPOSE_PATCH_ACTION) return false;
  if (readString(result && result.status) !== "preview_blocked") return false;
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

export { MAINTENANCE_CHURN_ACTIONS, buildBudgetRemainingForExpansionSignal, buildForbiddenDecisions, buildTerminalRepairRefreshedStepDetail, clearTerminalRepairState, createProgressSnapshot$1 as createProgressSnapshot, diffProgress$1 as diffProgress, evaluateTerminalRepairState, isNoProgressMaintenanceChurn, isNoProgressRecoveryAttempt, readActionArgs$1 as readActionArgs, refreshTerminalRepairState, resolveActiveRepairReason, shouldEmitAdvisoryPersistenceSignalStep, summarizeTerminalRepairState };
