import { readString, readNumber } from '../semantic-json.js';
import { PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { resolveGrantedTerminalEscape } from '../terminal-repair/escape-rules.js';
import { cloneValue } from '../utils.js';
import { explainTerminalRepairPublishArgs } from '../terminal-repair/publish-contract.js';
import { buildBudgetRemainingForExpansionSignal } from '../terminal-repair/core.js';
import { DEFAULT_TERMINAL_REPAIR_STRINGS } from '../terminal-repair-strings.js';
import { buildValidLimitedPublishArgsExample } from '../publish-prescription.js';

// Terminal-repair veto gates, extracted from action-loop-action.js (AGRUN-450
// slice 8 — the last gate cluster; after this the only maybeBlock left in the
// god file is the maybeBlockActionPatternRepeat orchestrator). Two gates +
// their two private hint helpers:
//   - maybeBlockTerminalRepairAction: enforces the terminal-repair allowlist /
//     valid-publish contract, with the hard_veto publish-loop escape.
//   - maybeBlockTerminalCorrectionRetry: blocks repeated clean/plain
//     workspace_publish_candidate while the terminal-correction cooldown is hot.
// Both are called directly from executeAction (not the orchestrator).


// Non-negative number reader: non-finite -> 0 (readNumber(value, 0) is the SSOT;
// NOT semantic-json's readFiniteNumber, which returns null).
function readFiniteNumber$1(value) {
  return readNumber(value, 0);
}

function maybeBlockTerminalRepairAction(options) {
  const runState = options && options.runState;
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return null;
  const actionName = readString(options && options.actionName);
  if (!actionName) return null;
  const allowedActions = Array.isArray(repair.allowedActions)
    ? repair.allowedActions.map(readString).filter(Boolean)
    : [];
  const allowed = allowedActions.includes(actionName);
  const isPublish = actionName === PUBLISH_DIRECT_ACTION;
  // AGRUN publish-loop escape: once terminal-repair grants a publish-opening
  // escape (hard_veto reached with a real drafted candidate — see the
  // publishLoopEscapeGranted grant in terminal-repair/core.js), stop vetoing
  // the AI's workspace_publish_candidate. The AI has demonstrably failed the
  // brittle multi-gate publish protocol past the high-water mark; pinning it
  // further just burns the budget and returns the "paused" stub. Let the
  // publish reach the action, which publishes the real candidate ARTIFACT with
  // the unmet facts recorded as limitations. Narrow: hard_veto + real
  // candidate only. AGRUN-559 — resolved via the shared escape-rule
  // descriptors (opensPublish) instead of hardcoding the flag name.
  const grantedEscape = resolveGrantedTerminalEscape(repair);
  if (isPublish && grantedEscape && grantedEscape.opensPublish) return null;
  const publishValidation = isPublish
    ? explainTerminalRepairPublishArgs(options.actionArgs, repair, { runState })
    : { valid: false, reasons: [] };
  const validPublish = isPublish && publishValidation.valid;
  const readinessOnlyPublishRetry = isPublish &&
    allowed &&
    isReadinessOnlyPublishRetryAllowed(repair);
  if (allowed && (!isPublish || validPublish || readinessOnlyPublishRetry)) return null;

  const ignoredCount = readFiniteNumber$1(repair.ignoredCount) + 1;
  const reason = isPublish && !validPublish
    ? "terminal_repair_invalid_publish"
    : "terminal_repair_action_not_allowed";
  const escalation = readString(repair.escalation);
    const isHardVeto = escalation === "hard_veto" && reason === "terminal_repair_action_not_allowed";
    const protocolHint = buildTerminalRepairProtocolHint(repair);
    const budgetExpansionSignal = isHardVeto
      // AGRUN-509 — host-overridden thresholds honored (see options.runtimeConfig
      // forwarding at the call site; parity with the onResponse hook door).
      ? buildBudgetRemainingForExpansionSignal(repair, ignoredCount, options && options.runtimeConfig)
      : null;
    const message = isHardVeto
    ? DEFAULT_TERMINAL_REPAIR_STRINGS.block.hardVetoActionNotAllowed({
        actionName,
        ignoredCount,
        budgetState: repair.budgetState,
        activeDeficits: repair.activeDeficits,
        allowedActions: repair.allowedActions,
        observableDeficits: repair.observableDeficits
      })
    : isPublish && !validPublish
      ? DEFAULT_TERMINAL_REPAIR_STRINGS.block.invalidPublish({ protocolHint })
      : DEFAULT_TERMINAL_REPAIR_STRINGS.block.actionNotAllowed({ actionName });
  const output = {
    ok: false,
    control: "continue",
    kind: isHardVeto ? "terminal_repair_hard_veto_block" : "terminal_repair_preflight_block",
    status: "blocked",
    reason,
    actionName,
    activeDeficits: Array.isArray(repair.activeDeficits) ? repair.activeDeficits.slice(0, 8) : [],
    allowedActions: allowedActions.slice(0, 16),
    forbiddenDecisions: Array.isArray(repair.forbiddenDecisions) ? repair.forbiddenDecisions.slice(0, 8) : [],
    escalation: escalation || "advisory",
      ignoredCount,
      invalidPublishReasons: isPublish ? publishValidation.reasons.slice(0, 8) : [],
      budgetRemainingForExpansionSignal: budgetExpansionSignal,
      terminalRepairState: {
      active: true,
      mode: repair.mode || "terminal_repair",
      reason: repair.reason || null,
      requiredRepair: repair.requiredRepair || null,
      validPublishContract: cloneValue(repair.validPublishContract || null)
    },
    requiredArgsExample: buildValidLimitedPublishArgsExample(runState),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep(isHardVeto ? "terminal-repair-hard-veto-blocked" : "terminal-repair-action-blocked", {
      actionName,
      activeDeficits: output.activeDeficits,
      escalation: output.escalation,
        ignoredCount,
        invalidPublishReasons: output.invalidPublishReasons,
        budgetRemainingForExpansionSignal: output.budgetRemainingForExpansionSignal,
        reason
      });
  }
  return { message, output };
}

function buildTerminalRepairProtocolHint(repair) {
  const reason = readString(repair && repair.reason);
  if (reason === "missing_finalize_after_latest_write") {
    return " Current publish protocol blocker requires workspace_finalize_candidate for the candidate, then workspace_read, before another publish attempt.";
  }
  if (reason === "missing_latest_workspace_read") {
    return " Current publish protocol blocker requires workspace_read of the latest candidate before another publish attempt.";
  }
  return "";
}

function isReadinessOnlyPublishRetryAllowed(repair) {
  const deficits = Array.isArray(repair && repair.activeDeficits)
    ? repair.activeDeficits.map(readString).filter(Boolean)
    : [];
  if (!deficits.includes("readiness")) return false;
  return !deficits.some((name) => [
    "length",
    "source",
    "structure",
    "terminal_loop",
    "todo"
  ].includes(name));
}

function maybeBlockTerminalCorrectionRetry(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== PUBLISH_DIRECT_ACTION) return null;
  const runState = options && options.runState;
  const convergence = runState && runState.actionPatternConvergence && typeof runState.actionPatternConvergence === "object"
    ? runState.actionPatternConvergence
    : null;
  const correction = convergence && convergence.terminalCorrectionState && typeof convergence.terminalCorrectionState === "object"
    ? convergence.terminalCorrectionState
    : null;
  const cooldown = convergence && convergence.terminalRetryCooldown && typeof convergence.terminalRetryCooldown === "object"
    ? convergence.terminalRetryCooldown
    : null;
  const ignoredCount = Math.max(
    readFiniteNumber$1(convergence && convergence.ignoredTerminalCorrectionCount),
    readFiniteNumber$1(correction && correction.ignoredTerminalCorrectionCount)
  );
  const cooldownActive = cooldown && cooldown.active === true;
  const correctionActive = correction && correction.active === true;
  if (!cooldownActive && !correctionActive) return null;
  const repairState = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : { active: true, activeDeficits: ["terminal_loop"] };
  // AGRUN publish-loop escape: once the hard_veto publish-acceptance escape is
  // granted (publishLoopEscapeGranted grant in terminal-repair/core.js), the
  // terminal-correction cooldown must NOT re-pin the publish — otherwise this
  // sibling gate would block the very workspace_publish_candidate the escape
  // exists to let through, and the run would still thrash to the maxSteps stub.
  // AGRUN-559 — resolved via the shared escape-rule descriptors (opensPublish).
  const grantedRetryEscape = resolveGrantedTerminalEscape(repairState);
  if (grantedRetryEscape && grantedRetryEscape.opensPublish) return null;
  const publishValidation = explainTerminalRepairPublishArgs(options.actionArgs, repairState, { runState });
  if (publishValidation.valid) return null;
  const blockedTerminalRetryCount = readFiniteNumber$1(cooldown && cooldown.blockedTerminalRetryCount) + 1;
  const message = "Terminal correction is escalated: do not repeat clean ready or plain workspace_publish_candidate after repeated publish/finalize no-progress. Do evidence/workspace/TodoState recovery first, or publish only a valid limited finalReadiness with non-empty remainingGaps and false flags for failed dimensions.";
  const output = {
    ok: false,
    control: "continue",
    kind: "terminal_correction_preflight_block",
    status: "blocked",
    reason: "terminal_correction_escalated",
    ignoredTerminalCorrectionCount: ignoredCount,
    forbiddenMove: "repeat_same_terminal_intent",
    allowedNextMoves: Array.isArray(correction && correction.allowedNextMoves)
      ? correction.allowedNextMoves.slice(0, 8)
      : Array.isArray(cooldown && cooldown.allowedNextMoves)
        ? cooldown.allowedNextMoves.slice(0, 8)
        : [],
    terminalRetryCooldown: {
      active: true,
      forbiddenTerminalActions: Array.isArray(cooldown && cooldown.forbiddenTerminalActions)
        ? cooldown.forbiddenTerminalActions.slice(0, 8)
        : [PUBLISH_DIRECT_ACTION, "finalize"],
      validTerminalException: readString(cooldown && cooldown.validTerminalException) ||
        "workspace_publish_candidate with decision=limited + non-empty remainingGaps + false failed-dimension flags",
      blockedTerminalRetryCount,
      executedPublishCount: readFiniteNumber$1(cooldown && cooldown.executedPublishCount),
      consecutiveExecutedPublishCount: readFiniteNumber$1(cooldown && cooldown.consecutiveExecutedPublishCount),
      reason: readString(cooldown && cooldown.reason) || "terminal_retry_cooldown_active"
    },
    invalidPublishReasons: publishValidation.reasons.slice(0, 8),
    requiredArgsExample: buildValidLimitedPublishArgsExample(runState),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("terminal-correction-action-blocked", {
      actionName,
      blockedTerminalRetryCount,
      forbiddenMove: output.forbiddenMove,
      ignoredTerminalCorrectionCount: ignoredCount,
      reason: output.reason
    });
  }
  return { message, output };
}

export { maybeBlockTerminalCorrectionRetry, maybeBlockTerminalRepairAction };
