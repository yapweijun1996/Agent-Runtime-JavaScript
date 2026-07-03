import { readString } from '../semantic-json.js';
import { WORKSPACE_WRITE_ACTION, WORKSPACE_REPLACE_ACTION, FINALIZE_CANDIDATE_ACTION } from '../action-names.js';
import { readWorkspaceLengthDeficit, hasWorkspaceStructureDeficit } from './workspace-deficit-reads.js';
import { estimateWorkspaceReplaceLength, countTextByLengthUnit, computeMinimumEffectiveLengthDeficitGrowth } from './text-measure.js';

// Length-deficit-rewrite gate, extracted from action-loop-action.js (AGRUN-450
// slice 6). When the candidate is short of its requested length, blocks a
// workspace_write/workspace_replace that would not grow the draft enough (or
// would shrink it and erase prior expansion).
//
// Deficit-dependent gate: imports the shared deficit readers and the Layer-0
// text-measure leaf directly (no DI).


function maybeBlockLengthDeficitRewrite(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== WORKSPACE_WRITE_ACTION && actionName !== WORKSPACE_REPLACE_ACTION) return null;
  const runState = options && options.runState;
  const deficit = readWorkspaceLengthDeficit(runState);
  if (!deficit || deficit.observed <= 0) return null;
  const structureDeficit = hasWorkspaceStructureDeficit(runState);
  const args = options && options.actionArgs && typeof options.actionArgs === "object"
    ? options.actionArgs
    : {};
  const proposedText = actionName === WORKSPACE_WRITE_ACTION
    ? readString(args.content || args.text || args.markdown)
    : "";
  const proposedLength = actionName === WORKSPACE_REPLACE_ACTION
    ? estimateWorkspaceReplaceLength(runState, args, deficit)
    : proposedText
      ? countTextByLengthUnit(proposedText, deficit)
      : 0;
  const proposedGrowth = proposedLength - deficit.observed;
  const minimumEffectiveGrowth = computeMinimumEffectiveLengthDeficitGrowth(deficit);
  const materiallyGrows = proposedGrowth >= minimumEffectiveGrowth;
  if (proposedLength >= deficit.requested || (proposedLength > deficit.observed && materiallyGrows)) return null;
  const remaining = Math.max(deficit.requested - deficit.observed, 0);
  const growthHint = minimumEffectiveGrowth > 0
    ? ` A replacement under the target must grow by at least ${minimumEffectiveGrowth} ${deficit.unit} from the current observed length; this proposal grows by ${Math.max(proposedGrowth, 0)}.`
    : "";
  const message = `${structureDeficit ? "Length + structure repair" : "Length-only repair"} is active: current candidate has ${deficit.observed}/${deficit.requested} ${deficit.unit}. ${actionName} would not increase the candidate enough and can erase prior expansion.${growthHint} Use workspace_insert_after_section or workspace_replace with enough user-facing material to close the ${remaining} ${deficit.unit} gap, or rewrite with content that preserves/grows the current length before workspace_read/finalize/publish.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "length_deficit_rewrite_without_growth",
    actionName,
    forbiddenMove: "rewrite_under_length_deficit_without_growth",
    allowedNextMoves: [
      "workspace_insert_after_section",
      "workspace_read",
      FINALIZE_CANDIDATE_ACTION,
      "workspace_publish_candidate_limited_with_remainingGaps"
    ],
    observableDeficit: {
      observed: deficit.observed,
      minimumEffectiveGrowth,
      proposed: proposedLength,
      proposedGrowth,
      requested: deficit.requested,
      unit: deficit.unit
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      observed: deficit.observed,
      proposed: proposedLength,
      reason: output.reason,
      requested: deficit.requested
    });
  }
  return { message, output };
}

export { maybeBlockLengthDeficitRewrite };
