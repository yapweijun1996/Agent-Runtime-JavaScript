import { readString } from '../semantic-json.js';
import { FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { readWorkspaceSourceDeficit, hasWorkspaceStructureDeficit, readWorkspaceLengthDeficit, readCurrentWorkspaceLengthStatus } from './workspace-deficit-reads.js';

// Satisfied-candidate mutation block, extracted from action-loop-action.js
// (AGRUN-450 slice 4). Blocks further workspace mutation once the candidate
// already clears every observable source / length / structure gate — more
// editing risks duplicate headings or regressions.
//
// This is the first deficit-dependent gate moved out of the god file: it imports
// the shared deficit readers DIRECTLY from ./workspace-deficit-reads.js (slice 3),
// with no dependency injection — the pattern that the slice-3 extraction unlocked.


function maybeBlockSatisfiedCandidateMutation(options) {
  const actionName = readString(options && options.actionName);
  if (![
    "workspace_write",
    "workspace_insert_after_section",
    "workspace_replace"
  ].includes(actionName)) {
    return null;
  }
  const runState = options && options.runState;
  if (readWorkspaceSourceDeficit(runState) || hasWorkspaceStructureDeficit(runState) || readWorkspaceLengthDeficit(runState)) {
    return null;
  }
  const lengthStatus = readCurrentWorkspaceLengthStatus(runState);
  if (!lengthStatus || lengthStatus.requested <= 0 || lengthStatus.observed < lengthStatus.requested) return null;
  const message = `Workspace candidate already satisfies observable source, length, and structure gates (${lengthStatus.observed}/${lengthStatus.requested} ${lengthStatus.unit}). More workspace mutation can introduce duplicate headings or regressions. Use workspace_read, workspace_finalize_candidate, TodoState sync, or workspace_publish_candidate instead.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "satisfied_candidate_mutation",
    actionName,
    forbiddenMove: "mutate_after_observable_gates_satisfied",
    allowedNextMoves: [
      "workspace_read",
      FINALIZE_CANDIDATE_ACTION,
      "todo_advance",
      "todo_run_next",
      PUBLISH_DIRECT_ACTION
    ],
    observableFacts: {
      observed: lengthStatus.observed,
      requested: lengthStatus.requested,
      unit: lengthStatus.unit
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      observed: lengthStatus.observed,
      reason: output.reason,
      requested: lengthStatus.requested
    });
  }
  return { message, output };
}

export { maybeBlockSatisfiedCandidateMutation };
