import { cloneValue } from '../utils.js';
import { readString } from '../semantic-json.js';
import '../action-names.js';
import { refreshTerminalRepairState, buildBudgetRemainingForExpansionSignal, shouldEmitAdvisoryPersistenceSignalStep, summarizeTerminalRepairState } from '../terminal-repair/core.js';
import { resolveGrantedTerminalEscape } from '../terminal-repair/escape-rules.js';
import { DEFAULT_TERMINAL_REPAIR_STRINGS } from '../terminal-repair-strings.js';

// AGRUN-421: terminal repair as preRequest + onResponse hooks (depends on
// AGRUN-418/422). Logic moved VERBATIM from the two loop-body sites:
//
//   preRequest  — refreshTerminalRepairBeforePlanner (was action-loop-planner.js):
//                 refresh repair state with status "before_planner" so the
//                 planner prompt (summarizeTerminalRepairState) sees current
//                 deficits. Effect is via runState — the hook returns void;
//                 prompt assembly reads runState.terminalRepairState after.
//   onResponse  — maybeBlockDirectTerminalDuringRepair (was
//                 action-loop-session-loop.js): when the planner decision is
//                 final/finalize and repair is active, perform the block side
//                 effects (steps, actionHistory, observation incl. the F8
//                 premature-finalize gate inside refreshTerminalRepairState)
//                 and replace the response with a TERMINAL_REPAIR_BLOCKED
//                 marker the loop turns into `continue`.
//
// FAILURE POSTURE (deliberate, opposite of policy-hook): these are QUALITY
// gates, not security gates. A hook failure degrades fail-OPEN (terminal
// proceeds) with a loud *-hook-failed step — fail-closed here could trap a
// run in a never-terminating loop, which is worse than one degraded answer.
// Gate semantics decide failure direction: security gate → closed (policy),
// quality gate → open + observable (this module).
//
// The onResponse gate is single-door by nature: final/finalize decisions only
// arrive through the session loop. The plan door's terminal protection stays
// in plan validation + refreshTerminalRepairState during plan execution.


const TERMINAL_REPAIR_BLOCKED_RESPONSE_TYPE = "terminal_repair_blocked";

function createTerminalRepairPreRequestHook() {
  return function terminalRepairPreRequestHook(ctx) {
    const runState = ctx && ctx.runState;
    const pushStep = ctx && ctx.pushStep;
    const session = ctx && ctx.session;
    // AGRUN-460 — forward runtimeConfig so host-overridden terminalRepair
    // thresholds (resolveTerminalRepairThresholds) and the runtimeConfig-driven
    // allowedActions/requiredRepair are honored on THIS door, not silently
    // defaulted. The single-action path already threads it; the doors must match.
    const repair = refreshTerminalRepairState(runState, {
      runtimeConfig: session && session.runtimeConfig,
      status: "before_planner"
    });
    if (repair && repair.active === true && typeof pushStep === "function") {
      pushStep("terminal-repair-state-refreshed", {
        active: true,
        activeDeficits: Array.isArray(repair.activeDeficits) ? repair.activeDeficits.slice(0, 8) : [],
        allowedActions: Array.isArray(repair.allowedActions) ? repair.allowedActions.slice(0, 12) : [],
        budgetState: repair.budgetState || null,
        ignoredCount: repair.ignoredCount || 0,
        workspaceRepairSignal: repair.workspaceRepairSignal
          ? cloneValue(repair.workspaceRepairSignal)
          : null,
        reason: repair.reason || null,
        status: "before_planner"
      });
    }
  };
}

function createTerminalRepairOnResponseHook() {
  return function terminalRepairOnResponseHook(ctx) {
    const session = ctx && ctx.session;
    const actionName = ctx && ctx.actionName;
    const decision = ctx && ctx.response;
    const type = readString(decision && decision.type);
    if (type !== "final" && type !== "finalize") return;
    const repair = refreshTerminalRepairState(session.runState, {
      actionName,
      decision,
      // AGRUN-460 — forward runtimeConfig (host-overridden terminalRepair
      // thresholds + allowedActions/requiredRepair) so this door matches the
      // single-action path instead of silently defaulting.
      runtimeConfig: session && session.runtimeConfig,
      output: { ok: false, control: "continue", kind: "terminal_repair_required", status: "blocked",
        reason: "direct_terminal_suppressed_by_terminal_repair", actionName,
        message: DEFAULT_TERMINAL_REPAIR_STRINGS.directTerminalBlock.message },
      status: "terminal_repair_direct_terminal_block"
    });
    if (!repair || repair.active !== true) return;

    // AGRUN-550 — honor the finalize-opening terminal escapes (graceful
    // degradation). When terminal repair has opened final/finalize, do NOT
    // block: let the honest finalize through so the run terminates with a real
    // answer instead of thrashing to the deadline with EMPTY output. This door
    // previously gated purely on repair.active and silently ignored the escapes,
    // so they only ever worked on the action-preflight door — a Dispatch-Path
    // Parity gap (final/finalize decisions arrive ONLY here).
    //
    // AGRUN-559 — resolved through the shared escape-rule descriptors instead
    // of enumerating flag names (the AGRUN-550 bug was exactly this door not
    // knowing a flag existed). Any escape whose descriptor says opensFinalize
    // passes; the publishLoop escape does NOT (it opens PUBLISH, not finalize),
    // so a finalize under it is still redirected to the publish protocol.
    const grantedEscape = resolveGrantedTerminalEscape(repair);
    if (grantedEscape && grantedEscape.opensFinalize) {
      if (typeof session.pushStep === "function") {
        session.pushStep("terminal-repair-finalize-escape-granted", {
          actionName,
          escalation: repair.escalation || "advisory",
          reason: grantedEscape.escapeReason
        });
      }
      return;
    }

    const isHardVeto = readString(repair.escalation) === "hard_veto";
    const ignoredCount = repair.ignoredCount || 0;
    const budgetExpansionSignal = isHardVeto
      // AGRUN-509 — forward runtimeConfig so the expansion-signal advisory gate
      // honors host-overridden terminalRepair thresholds (same forwarding as
      // the refresh call above; keeps this door in parity with the
      // single-action door in action-loop-action.js).
      ? buildBudgetRemainingForExpansionSignal(repair, ignoredCount, session && session.runtimeConfig)
      : null;
    // AGRUN-542 — content-structure exit forced publish: the finalize decision
    // is blocked with the dedicated contract message (parity with the
    // single-action door in blocks/terminal-repair.js). The
    // contentStructureExitForcedPublishGranted escape opens PUBLISH only, so
    // it never reaches the opensFinalize pass-through above.
    const contentStructureExitSignal = repair.contentStructureExitSignal &&
      typeof repair.contentStructureExitSignal === "object"
      ? repair.contentStructureExitSignal
      : null;
    const contentStructureForced = Boolean(contentStructureExitSignal && contentStructureExitSignal.forcedPublish === true);
    const message = contentStructureForced
      ? DEFAULT_TERMINAL_REPAIR_STRINGS.block.contentStructureForcedPublish({
          actionName,
          attemptsUsed: Number(contentStructureExitSignal.attemptsUsed) || 0,
          attemptLimit: Math.max(Number(contentStructureExitSignal.attemptLimit) || 1, 1)
        })
      : isHardVeto
      ? DEFAULT_TERMINAL_REPAIR_STRINGS.block.hardVetoActionNotAllowed({
          actionName,
          ignoredCount,
          budgetState: repair.budgetState,
          activeDeficits: repair.activeDeficits,
          allowedActions: repair.allowedActions,
          observableDeficits: repair.observableDeficits
        })
      : DEFAULT_TERMINAL_REPAIR_STRINGS.directTerminalBlock.message;
    const kind = isHardVeto ? "terminal_repair_hard_veto_block" : "terminal_repair_required";
    const advisoryPersistenceSignal = repair.advisoryPersistenceSignal &&
      typeof repair.advisoryPersistenceSignal === "object"
      ? repair.advisoryPersistenceSignal
      : null;

    session.pushStep(
      isHardVeto ? "terminal-repair-hard-veto-blocked" : "terminal-repair-direct-terminal-blocked",
      {
        actionName,
        activeDeficits: Array.isArray(repair.activeDeficits) ? repair.activeDeficits.slice(0, 8) : [],
        escalation: repair.escalation || "advisory",
        ignoredCount,
        budgetRemainingForExpansionSignal: budgetExpansionSignal,
        contentStructureExitSignal: contentStructureExitSignal ? cloneValue(contentStructureExitSignal) : null,
        reason: repair.reason || "direct_terminal_suppressed_by_terminal_repair"
      }
    );
    if (shouldEmitAdvisoryPersistenceSignalStep(advisoryPersistenceSignal)) {
      session.pushStep("terminal-repair-advisory-persistence-signal", advisoryPersistenceSignal);
    }
    session.actionHistory.push({
      actionName,
      kind,
      summary: isHardVeto
        ? "terminal repair HARD VETO — direct final/finalize blocked; must use workspace_publish_candidate with decision=limited"
        : "terminal repair mode blocked direct final/finalize; use recovery action or valid limited workspace_publish_candidate"
    });
    session.runState.lastAction = actionName;
    session.runState.observation = {
      actionName,
      kind,
      message,
      output: {
        ok: false,
        control: "continue",
        kind,
        status: "blocked",
        reason: "direct_terminal_suppressed_by_terminal_repair",
        actionName,
        escalation: repair.escalation || "advisory",
        ignoredCount,
        budgetRemainingForExpansionSignal: budgetExpansionSignal,
        terminalRepairState: summarizeTerminalRepairState(repair),
        message
      }
    };
    return { response: { type: TERMINAL_REPAIR_BLOCKED_RESPONSE_TYPE, actionName } };
  };
}

export { TERMINAL_REPAIR_BLOCKED_RESPONSE_TYPE, createTerminalRepairOnResponseHook, createTerminalRepairPreRequestHook };
