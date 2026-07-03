import { readString, readNumber } from '../semantic-json.js';
import { WORKSPACE_READ_ACTION, WORKSPACE_REPLACE_ACTION } from '../action-names.js';
import { hasWorkspaceStructureDeficit, readWorkspaceLengthDeficit, readWorkspaceSourceDeficit, readWorkspaceStructureDeficit } from './workspace-deficit-reads.js';

// Workspace no-progress-loop block, extracted from action-loop-action.js
// (AGRUN-450 slice 5). After enough steps without observable progress, blocks
// repeated workspace_read / workspace_replace loops and points the model at the
// specific deficit still open (length, then source, then structure).
//
// Deficit-dependent gate: imports the shared deficit readers directly (no DI).


// Non-negative number reader: non-finite -> 0 (readNumber(value, 0) is the SSOT;
// NOT semantic-json's readFiniteNumber, which returns null).
function readFiniteNumber$5(value) {
  return readNumber(value, 0);
}

function maybeBlockWorkspaceNoProgressLoop(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== WORKSPACE_READ_ACTION && actionName !== WORKSPACE_REPLACE_ACTION) return null;
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const stepsWithoutObservableProgress = readFiniteNumber$5(convergence && convergence.stepsWithoutObservableProgress);
  const structureDeficit = hasWorkspaceStructureDeficit(options && options.runState);
  const repairActive = options &&
    options.runState &&
    options.runState.terminalRepairState &&
    options.runState.terminalRepairState.active === true;
  const threshold = repairActive && structureDeficit ? 2 : 6;
  if (stepsWithoutObservableProgress < threshold) return null;
  const deficit = readWorkspaceLengthDeficit(options && options.runState);
  if (!deficit) {
    const sourceDeficit = readWorkspaceSourceDeficit(options && options.runState);
    if (!sourceDeficit) {
      if (!structureDeficit) return null;
      const structureMessage = `Workspace structure repair is active: the candidate still has structural issues after ${stepsWithoutObservableProgress} step(s) without observable progress. More workspace_read calls cannot repair duplicate headings or section numbering. Use workspace_replace, workspace_write, or workspace_insert_after_section to produce one coherent candidate structure before publishing.`;
      const structureOutput = {
        ok: false,
        control: "continue",
        kind: "action_pattern_preflight_block",
        status: "blocked",
        reason: "workspace_no_progress_structure_deficit",
        actionName,
        forbiddenMove: "repeat_workspace_read_replace_without_structure_progress",
        allowedNextMoves: [
          "workspace_replace",
          "workspace_write",
          "workspace_insert_after_section"
        ],
        observableDeficit: readWorkspaceStructureDeficit(options && options.runState),
        stepsWithoutObservableProgress,
        message: structureMessage
      };
      if (typeof (options && options.pushStep) === "function") {
        options.pushStep("action-pattern-repeat-blocked", {
          actionName,
          forbiddenMove: structureOutput.forbiddenMove,
          reason: structureOutput.reason,
          stepsWithoutObservableProgress
        });
      }
      return { message: structureMessage, output: structureOutput };
    }
    const sourceMessage = `Workspace recovery cooldown is active: source minimum is still not satisfied after ${stepsWithoutObservableProgress} step(s) without observable progress (readSources ${sourceDeficit.readSources}/${sourceDeficit.minReadSources}, relevantSources ${sourceDeficit.relevantSources}/${sourceDeficit.minRelevantSources}). More workspace_read/workspace_replace calls cannot fix an evidence deficit. Continue evidence work with web_search/read_url, or publish only a valid limited result with evidenceSatisfied=false and concrete remainingGaps when allowed.`;
    const sourceOutput = {
      ok: false,
      control: "continue",
      kind: "action_pattern_preflight_block",
      status: "blocked",
      reason: "workspace_no_progress_source_deficit",
      actionName,
      forbiddenMove: "repeat_workspace_read_replace_without_source_progress",
      allowedNextMoves: [
        "web_search",
        "read_url",
        "workspace_publish_candidate_limited_with_remainingGaps"
      ],
      observableDeficit: sourceDeficit,
      stepsWithoutObservableProgress,
      message: sourceMessage
    };
    if (typeof (options && options.pushStep) === "function") {
      options.pushStep("action-pattern-repeat-blocked", {
        actionName,
        forbiddenMove: sourceOutput.forbiddenMove,
        reason: sourceOutput.reason,
        readSources: sourceDeficit.readSources,
        relevantSources: sourceDeficit.relevantSources,
        stepsWithoutObservableProgress
      });
    }
    return { message: sourceMessage, output: sourceOutput };
  }
  const message = `Workspace recovery cooldown is active: the candidate is still below the requested ${deficit.requested} ${deficit.unit} (observed ${deficit.observed}) after ${stepsWithoutObservableProgress} step(s) without observable progress. Do not continue workspace_read/workspace_replace loops. Add substantial user-facing content with workspace_insert_after_section or workspace_write, or publish only a valid limited result when allowed.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "workspace_no_progress_length_deficit",
    actionName,
    forbiddenMove: "repeat_workspace_read_replace_without_progress",
    allowedNextMoves: [
      "workspace_insert_after_section",
      "workspace_write",
      "valid_limited_with_remainingGaps"
    ],
    observableDeficit: deficit,
    stepsWithoutObservableProgress,
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      requested: deficit.requested,
      observed: deficit.observed,
      stepsWithoutObservableProgress
    });
  }
  return { message, output };
}

export { maybeBlockWorkspaceNoProgressLoop };
