import { readString, readNumber } from '../semantic-json.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from '../workspace-candidate-lifecycle.js';
import { FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { inspectWorkspacePublishProtocol } from '../virtual-workspace.js';

// Late-budget workspace-protocol block gate, extracted from action-loop-action.js
// (AGRUN-450 slice 2). This gate fires when a workspace mutation (or patch
// preview) would not leave enough future cycles to run the required
// finalize -> read -> publish protocol before the run's step budget is spent.
//
// The cluster is self-contained except for one cross-cutting reader,
// readCurrentWorkspaceLengthStatus, which is shared by several other gates and
// stays in action-loop-action.js. Rather than re-import it (a circular edge back
// into the god file), the orchestrator INJECTS it through the options bag.


// Non-negative number reader: non-finite -> 0 (NOT semantic-json's readFiniteNumber,
// which returns null). readNumber(value, 0) is the canonical "-> 0" SSOT.
function readFiniteNumber$7(value) {
  return readNumber(value, 0);
}

const LATE_BUDGET_PATCH_PREVIEW_ACTIONS = new Set([
  "workspace_propose_patch"
]);

const LATE_BUDGET_WORKSPACE_MUTATION_ACTIONS = new Set([
  "workspace_apply_patch",
  "workspace_insert_after_section",
  "workspace_move",
  "workspace_multi_edit",
  "workspace_remove",
  "workspace_replace",
  "workspace_write"
]);

function maybeBlockLateBudgetWorkspaceProtocolWindow(options) {
  const actionName = readString(options && options.actionName);
  const isPatchPreview = LATE_BUDGET_PATCH_PREVIEW_ACTIONS.has(actionName);
  const isWorkspaceMutation = LATE_BUDGET_WORKSPACE_MUTATION_ACTIONS.has(actionName);
  if (!isPatchPreview && !isWorkspaceMutation) return null;
  const runState = options && options.runState;
  if (!isLateBudgetWorkspaceProtocolRelevant(runState, options && options.readCurrentWorkspaceLengthStatus)) return null;
  const remaining = readRemainingCyclesAfterCurrentAction(runState);
  if (remaining == null) return null;
  const requiredFutureCycles = isPatchPreview ? 4 : 3;
  if (remaining >= requiredFutureCycles) return null;

  const targetPath = readLateBudgetWorkspaceProtocolPath(runState, options && options.actionArgs);
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, targetPath);
  const requiredProtocol = isPatchPreview
    ? ["workspace_apply_patch", FINALIZE_CANDIDATE_ACTION, "workspace_read", PUBLISH_DIRECT_ACTION]
    : [FINALIZE_CANDIDATE_ACTION, "workspace_read", PUBLISH_DIRECT_ACTION];
  const allowedNextMoves = buildLateBudgetProtocolAllowedNextMoves(runState, publishProtocol);
  const todoFacts = readUnfinishedTodoFacts(runState);
  const message = [
    `Late workspace protocol budget window: ${actionName} would leave ${remaining} future cycle(s), but publishing changed workspace content requires at least ${requiredFutureCycles}.`,
    `Required sequence for that change: ${requiredProtocol.join(" -> ")}.`,
    `Current candidate protocol surface: ${allowedNextMoves.join(", ") || "none"}.`
  ].join(" ");
  const output = {
    ok: false,
    control: "continue",
    kind: "late_budget_workspace_protocol_window",
    status: "blocked",
    reason: "late_workspace_mutation_without_publish_protocol_budget",
    actionName,
    forbiddenMove: "late_workspace_mutation_without_protocol_budget",
    allowedNextMoves,
    cyclesRemainingAfterCurrentAction: remaining,
    currentCandidatePath: publishProtocol.path,
    publishProtocol,
    requiredFutureCycles,
    requiredProtocol,
    todoState: todoFacts,
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("late-budget-workspace-protocol-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      cyclesRemainingAfterCurrentAction: remaining,
      currentCandidatePath: publishProtocol.path,
      requiredFutureCycles,
      todoUnfinishedCount: todoFacts.unfinishedCount
    });
  }
  return { message, output };
}

function isLateBudgetWorkspaceProtocolRelevant(runState, readCurrentWorkspaceLengthStatus) {
  const readLengthStatus = typeof readCurrentWorkspaceLengthStatus === "function"
    ? readCurrentWorkspaceLengthStatus
    : () => null;
  const lengthStatus = readLengthStatus(runState);
  if (!lengthStatus || lengthStatus.requested <= 0) return false;
  if (lengthStatus.observed > 0) return true;
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const path = readLateBudgetWorkspaceProtocolPath(runState, null);
  const file = workspace && workspace.files && workspace.files[path] && typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  return Boolean(readString(file && file.content));
}

function readRemainingCyclesAfterCurrentAction(runState) {
  const maxSteps = readFiniteNumber$7(runState && runState.maxSteps);
  const cycleCount = readFiniteNumber$7(runState && runState.cycleCount);
  if (maxSteps <= 0 || cycleCount <= 0) return null;
  return Math.max(maxSteps - cycleCount, 0);
}

function readLateBudgetWorkspaceProtocolPath(runState, actionArgs) {
  const args = actionArgs && typeof actionArgs === "object" && !Array.isArray(actionArgs)
    ? actionArgs
    : {};
  const pendingPatch = runState &&
    runState.virtualWorkspace &&
    runState.virtualWorkspace.pendingPatch &&
    typeof runState.virtualWorkspace.pendingPatch === "object"
    ? runState.virtualWorkspace.pendingPatch
    : null;
  const firstOperationWithPath = Array.isArray(args.operations)
    ? args.operations.find((operation) => readString(operation && operation.path))
    : null;
  const operationPath = readString(firstOperationWithPath && firstOperationWithPath.path);
  const workspaceQuality = runState &&
    runState.virtualWorkspace &&
    runState.virtualWorkspace.quality &&
    typeof runState.virtualWorkspace.quality === "object"
    ? runState.virtualWorkspace.quality
    : {};
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : {};
  const candidate = packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
    ? packet.workspace.candidate
    : packet.candidate && typeof packet.candidate === "object"
      ? packet.candidate
      : {};
  return readString(args.path) ||
    readString(args.to) ||
    readString(pendingPatch && pendingPatch.path) ||
    operationPath ||
    readString(workspaceQuality.finalCandidatePath) ||
    readString(candidate.path) ||
    DEFAULT_FINAL_CANDIDATE_PATH;
}

function buildLateBudgetProtocolAllowedNextMoves(runState, publishProtocol) {
  const protocol = publishProtocol && typeof publishProtocol === "object" ? publishProtocol : {};
  const todoFacts = readUnfinishedTodoFacts(runState);
  const moves = [];
  if (protocol.finalizedAfterLatestWrite !== true) {
    moves.push(FINALIZE_CANDIDATE_ACTION);
  } else if (protocol.readAfterLatestContentChange !== true) {
    moves.push("workspace_read");
  } else {
    if (todoFacts.unfinishedCount > 0) {
      moves.push("todo_run_next", "todo_advance", "todo_cancel");
    }
    moves.push(PUBLISH_DIRECT_ACTION);
  }
  return Array.from(new Set(moves));
}

function readUnfinishedTodoFacts(runState) {
  const todoState = runState && runState.todoState && typeof runState.todoState === "object"
    ? runState.todoState
    : null;
  if (!todoState || todoState.terminatedAt) {
    return { active: false, unfinishedCount: 0 };
  }
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  const unfinished = items.filter((item) => {
    const status = readString(item && item.status) || "pending";
    return status === "active" || status === "pending" || status === "blocked";
  });
  return {
    active: unfinished.length > 0,
    unfinishedCount: unfinished.length,
    statuses: countTodoStatusFacts(items)
  };
}

function countTodoStatusFacts(items) {
  const counts = {
    abandoned: 0,
    active: 0,
    blocked: 0,
    done: 0,
    pending: 0,
    total: Array.isArray(items) ? items.length : 0
  };
  for (const item of Array.isArray(items) ? items : []) {
    const status = readString(item && item.status) || "pending";
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

export { maybeBlockLateBudgetWorkspaceProtocolWindow };
