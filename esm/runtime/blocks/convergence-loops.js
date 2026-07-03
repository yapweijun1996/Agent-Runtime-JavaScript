import { readString, readNumber } from '../semantic-json.js';
import '../action-names.js';
import { isPublishProtocolRequiredActionForRepair } from '../terminal-repair/publish-contract.js';
import { readStateAllowedNextMovesWithSignal } from './state-allowed-moves.js';

// Convergence-loop veto gates, extracted from action-loop-action.js (AGRUN-450
// slice 7). Three hard-veto loops that share the convergence-state shape and the
// readStateAllowedNextMovesWithSignal recovery-surface reader: read-only
// planning, structure repair, and workspace mutation growth.
//
// Direct-imports the shared Layer-0 leaf (state-allowed-moves.js) and the
// terminal-repair predicate; no DI.


// Non-negative number reader: non-finite -> 0 (readNumber(value, 0) is the SSOT;
// NOT semantic-json's readFiniteNumber, which returns null).
function readFiniteNumber$2(value) {
  return readNumber(value, 0);
}

function maybeBlockReadOnlyPlanningLoop(options) {
  const actionName = readString(options && options.actionName);
  const runState = options && options.runState;
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  const repairAllowedActions = repair && repair.active === true && Array.isArray(repair.allowedActions)
    ? repair.allowedActions.map(readString).filter(Boolean)
    : [];
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const state = convergence && convergence.readOnlyPlanningState && typeof convergence.readOnlyPlanningState === "object"
    ? convergence.readOnlyPlanningState
    : null;
  if (repairAllowedActions.includes(actionName)) {
    if (isPublishProtocolRequiredActionForRepair(repair, actionName)) return null;
    // Repair allowlist is bypassed only when readOnlyPlanningState has NOT reached hard_veto
    // for this specific action. Hard_veto means the model has repeatedly ignored the advisory
    // and the action is demonstrably causing churn — override the repair allowance.
    const isHardVetoForAction = state && state.active === true &&
      readString(state.escalation) === "hard_veto" &&
      Array.isArray(state.forbiddenActions) &&
      state.forbiddenActions.map(readString).filter(Boolean).includes(actionName);
    if (!isHardVetoForAction) return null;
  }
  if (!state || state.active !== true) return null;
  if (readString(state.escalation) !== "hard_veto") return null;
  const forbiddenActions = Array.isArray(state.forbiddenActions)
    ? state.forbiddenActions.map(readString).filter(Boolean)
    : [];
  if (!forbiddenActions.includes(actionName)) return null;
  const ignoredCount = readFiniteNumber$2(state.ignoredCount) + 1;
  const allowedMoves = readStateAllowedNextMovesWithSignal(state, 12, "readOnlyPlanningState");
  const message = `HARD VETO — read-only planning has blocked ${actionName} ${ignoredCount} time(s) without source or workspace progress. The harness will reject any further ${actionName} calls. Choose any action from allowedNextMoves when populated. If no recovery is feasible, workspace_publish_candidate with finalReadiness.decision='limited' and concrete remainingGaps is valid.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "read_only_planning_hard_veto_block",
    status: "blocked",
    reason: "read_only_planning_without_productive_progress",
    actionName,
    forbiddenMove: "repeat_read_only_planning_without_productive_progress",
    forbiddenActions,
    allowedNextMoves: allowedMoves.allowedNextMoves,
    allowedNextMovesSignal: allowedMoves.signal,
    ignoredCount,
    stepsWithoutProductiveProgress: readFiniteNumber$2(state.stepsWithoutProductiveProgress),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("read-only-planning-hard-veto-blocked", {
      actionName,
      escalation: "hard_veto",
      forbiddenMove: output.forbiddenMove,
      allowedNextMovesSignal: output.allowedNextMovesSignal,
      ignoredCount,
      reason: output.reason,
      stepsWithoutProductiveProgress: output.stepsWithoutProductiveProgress
    });
  }
  return { message, output };
}

function maybeBlockStructureRepairLoop(options) {
  const actionName = readString(options && options.actionName);
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const state = convergence && convergence.structureRepairConvergence && typeof convergence.structureRepairConvergence === "object"
    ? convergence.structureRepairConvergence
    : null;
  if (!state || state.active !== true) return null;
  const forbiddenActions = Array.isArray(state.forbiddenActions)
    ? state.forbiddenActions.map(readString).filter(Boolean)
    : [];
  if (!forbiddenActions.includes(actionName)) return null;
  const repeatedStructureNoProgressCount = readFiniteNumber$2(state.repeatedStructureNoProgressCount);
  const isHardVeto = readString(state.escalation) === "hard_veto";
  const allowedMoves = readStateAllowedNextMovesWithSignal(state, 12, "structureRepairConvergence");
  const message = isHardVeto
    ? `HARD VETO — structure repair convergence has blocked ${actionName} ${repeatedStructureNoProgressCount} time(s) without improving the structure audit. allowedNextMoves is the recovery surface when populated. A coherent repair can use workspace_write or workspace_replace to produce a deduplicated outline with unique headings and section numbers, then workspace_finalize_candidate. If recovery is not feasible, workspace_publish_candidate with finalReadiness.decision='limited' is valid when remainingGaps names every structure issue.`
    : `Structure repair convergence is active: ${actionName} will not fix the duplicate headings or section numbers. Use a targeted workspace_write/workspace_replace full-outline repair, sync TodoState, or publish only a valid limited result that names the structure gap.`;
  const output = {
    ok: false,
    control: "continue",
    kind: isHardVeto ? "structure_repair_hard_veto_block" : "structure_repair_preflight_block",
    status: "blocked",
    reason: "structure_repair_without_audit_delta",
    actionName,
    escalation: isHardVeto ? "hard_veto" : "advisory",
    forbiddenMove: "repeat_structure_repair_without_audit_delta",
    forbiddenActions,
    allowedNextMoves: allowedMoves.allowedNextMoves,
    allowedNextMovesSignal: allowedMoves.signal,
    repeatedStructureNoProgressCount,
    activeIssueCodes: Array.isArray(state.activeIssueCodes) ? state.activeIssueCodes.slice(0, 8) : [],
    repeatedHeadingSamples: Array.isArray(state.repeatedHeadingSamples) ? state.repeatedHeadingSamples.slice(0, 5) : [],
    repeatedNumberSamples: Array.isArray(state.repeatedNumberSamples) ? state.repeatedNumberSamples.slice(0, 5) : [],
    requiredCorrection: readString(state.requiredCorrection) || null,
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep(isHardVeto ? "structure-repair-hard-veto-blocked" : "structure-repair-action-blocked", {
      actionName,
      escalation: output.escalation,
      forbiddenMove: output.forbiddenMove,
      allowedNextMovesSignal: output.allowedNextMovesSignal,
      reason: output.reason,
      repeatedStructureNoProgressCount,
      activeIssueCodes: output.activeIssueCodes
    });
  }
  return { message, output };
}

function maybeBlockWorkspaceMutationGrowthLoop(options) {
  const actionName = readString(options && options.actionName);
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const state = convergence && convergence.workspaceMutationGrowthConvergence && typeof convergence.workspaceMutationGrowthConvergence === "object"
    ? convergence.workspaceMutationGrowthConvergence
    : null;
  if (!state || state.active !== true || readString(state.escalation) !== "hard_veto") return null;
  const forbiddenActions = Array.isArray(state.forbiddenActions)
    ? state.forbiddenActions.map(readString).filter(Boolean)
    : [];
  if (!forbiddenActions.includes(actionName)) return null;
  const stallCount = readFiniteNumber$2(state.stallCount);
  const allowedMoves = readStateAllowedNextMovesWithSignal(state, 8, "workspaceMutationGrowthConvergence");
  const message = `Workspace mutation hard veto: repeated ${actionName} attempts are not growing the candidate while a length deficit remains. Use an allowed non-overwrite recovery action such as workspace_insert_after_section, workspace_multi_edit, workspace_propose_patch/workspace_apply_patch, or a valid limited publish with concrete remainingGaps.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "workspace_mutation_growth_hard_veto_block",
    status: "blocked",
    reason: "workspace_write_not_accumulating",
    actionName,
    escalation: "hard_veto",
    forbiddenMove: "repeat_workspace_write_without_growth",
    forbiddenActions,
    allowedNextMoves: allowedMoves.allowedNextMoves,
    allowedNextMovesSignal: allowedMoves.signal,
    stallCount,
    requiredCorrection: readString(state.requiredCorrection) || null,
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("workspace-mutation-growth-hard-veto-blocked", {
      actionName,
      escalation: output.escalation,
      forbiddenMove: output.forbiddenMove,
      allowedNextMovesSignal: output.allowedNextMovesSignal,
      reason: output.reason,
      stallCount
    });
  }
  return { message, output };
}

export { maybeBlockReadOnlyPlanningLoop, maybeBlockStructureRepairLoop, maybeBlockWorkspaceMutationGrowthLoop };
