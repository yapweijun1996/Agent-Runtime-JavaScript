import { readString, readNumber } from '../semantic-json.js';
import { FINALIZE_CANDIDATE_ACTION } from '../action-names.js';
import { buildValidLimitedPublishArgsExample } from '../publish-prescription.js';
import { readWorkspaceSourceDeficit, hasWorkspaceStructureDeficit } from './workspace-deficit-reads.js';

// Source-deficit-after-publish-block gate, extracted from action-loop-action.js
// (AGRUN-450 slice 5). Once publish was already blocked and the candidate meets
// its requested length but the source minimum is still short, more workspace
// editing cannot fix the evidence gap — block it and point at web_search/read_url
// or a valid limited publish.
//
// Deficit-dependent gate: imports the shared deficit readers directly (no DI).


// Non-negative number reader: non-finite -> 0 (readNumber(value, 0) is the SSOT;
// NOT semantic-json's readFiniteNumber, which returns null).
function readFiniteNumber$3(value) {
  return readNumber(value, 0);
}

function maybeBlockWorkspaceSourceDeficitAfterPublishBlock(options) {
  const actionName = readString(options && options.actionName);
  if (![
    FINALIZE_CANDIDATE_ACTION,
    "workspace_insert_after_section",
    "workspace_read",
    "workspace_replace",
    "workspace_write"
  ].includes(actionName)) {
    return null;
  }
  const runState = options && options.runState;
  if (!runState || !runState.publishBlockSignal || typeof runState.publishBlockSignal !== "object") return null;
  const sourceDeficit = readWorkspaceSourceDeficit(runState);
  if (!sourceDeficit || sourceDeficit.lengthSatisfied !== true) return null;
  if (hasWorkspaceStructureDeficit(runState)) return null;
  const message = `Workspace source-deficit cooldown is active: publish was already blocked, the candidate meets the requested length, but source minimum is still short (readSources ${sourceDeficit.readSources}/${sourceDeficit.minReadSources}, relevantSources ${sourceDeficit.relevantSources}/${sourceDeficit.minRelevantSources}). More workspace editing cannot fix source evidence. Continue web_search/read_url, or publish only a valid limited result with evidenceSatisfied=false and concrete remainingGaps.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "workspace_edit_blocked_by_source_deficit_after_publish_block",
    actionName,
    forbiddenMove: "workspace_edit_without_source_progress_after_publish_block",
    allowedNextMoves: [
      "web_search",
      "read_url",
      "workspace_publish_candidate_limited_with_remainingGaps"
    ],
    observableDeficit: sourceDeficit,
    publishBlockSignal: {
      count: readFiniteNumber$3(runState.publishBlockSignal.count),
      lastStatus: readString(runState.publishBlockSignal.lastStatus) || null
    },
    requiredArgsExample: buildValidLimitedPublishArgsExample(runState),
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      readSources: sourceDeficit.readSources,
      relevantSources: sourceDeficit.relevantSources
    });
  }
  return { message, output };
}

export { maybeBlockWorkspaceSourceDeficitAfterPublishBlock };
