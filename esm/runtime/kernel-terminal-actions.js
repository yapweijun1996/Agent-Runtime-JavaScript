// AGRUN-313 2.1 (litmus burn-down) — single seam for terminal action NAMES that
// the generic kernel still references by string.
//
// Where the kernel has the action OBJECT in scope it routes on the action's
// declared capability (e.g. action.publishDirect -> runState.terminalActionPublishDirect,
// see action-loop-action.js + result.js). But many generic sites (convergence
// name-guards, planner-prompt allowed-action checks) only have the action
// NAME-string in scope, with no registry to resolve the capability. For those
// this module is the ONE place the literal lives, so the name is not scattered
// and a future capability-routing pass (or rename) is a single-file change.

const PUBLISH_DIRECT_ACTION = "workspace_publish_candidate";
const FINALIZE_CANDIDATE_ACTION = "workspace_finalize_candidate";

// Terminal-repair reason/status code (observable contract value), centralized
// here so the literal is not scattered across the terminal-repair + workspace
// action files. Value unchanged, so existing telemetry/tests stay identical.
const CANDIDATE_QUALITY_BLOCKED_REASON = "candidate_quality_blocked";

export { CANDIDATE_QUALITY_BLOCKED_REASON, FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION };
