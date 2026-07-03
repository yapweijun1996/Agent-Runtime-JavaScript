export { FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION } from './action-names.js';

// AGRUN-313 2.1 (litmus burn-down) — seam for the TERMINAL action NAMES that the
// generic kernel references by string. AGRUN-448 generalized the action-name SSOT
// to src/runtime/action-names.js (the complete enum); this module re-exports the
// two terminal names from there so its existing importers are unaffected and there
// is exactly ONE source of truth for the literals.
//
// Where the kernel has the action OBJECT in scope it routes on the action's
// declared capability (e.g. action.publishDirect -> runState.terminalActionPublishDirect,
// see action-loop-action.js + result.js). Where only the NAME-string is in scope
// (convergence name-guards, planner-prompt allowed-action checks), it imports the
// constant so a rename is a single-file change.


// Terminal-repair reason/status code (observable contract value), centralized
// here so the literal is not scattered across the terminal-repair + workspace
// action files. Not an action name, so it stays local to this terminal seam.
const CANDIDATE_QUALITY_BLOCKED_REASON = "candidate_quality_blocked";

export { CANDIDATE_QUALITY_BLOCKED_REASON };
