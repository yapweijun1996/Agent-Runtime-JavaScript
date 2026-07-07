import { readNumber, readStringArray, observableDeficitsRecord, hasSelectedFinalCandidateContent, readRecord, readFinalCandidatePathFromWorkspace, readString } from './internal-utils.js';
import { WORKSPACE_APPLY_PATCH_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_WRITE_ACTION } from '../action-names.js';

// AGRUN-542 — content-level structure repair exit contract (SSOT).
//
// Live evidence (agrun_debug_runs/2026-06-17T08-05-00-854Z.*): once the
// candidate satisfied the requested length (1739/1500 words) and the read-
// source minimum, semantic duplicate sections / body-after-final-section kept
// terminal repair in an ADVISORY loop — the model burned provider calls on
// repeated blocked finalize attempts (ignoredCount 3→6) before hard_veto
// finally forced a limited publish. The repair loop had no bounded contract:
// "keep trying structure repair" was open-ended.
//
// This module is the single owner of the bounded contract:
//   - EPISODE: while terminal repair is active AND the final candidate has a
//     content-level structure issue (semantic_duplicate_headings /
//     body_after_final_section) AND length + source facts are satisfied AND a
//     real candidate exists, a content-structure exit episode is active.
//   - ONE ATTEMPT: the model gets exactly `thresholds.contentStructureRepairAttempts`
//     (default 1) content-changing repair attempts on the final candidate
//     (detected via the candidate FILE VERSION, which only advances on accepted
//     content mutations — blocked destructive shrinks and blocked heading-only
//     patch previews never bump it, so AGRUN-540/541 semantics are preserved).
//   - FORCED EXIT: once the attempt budget is used (or the model keeps
//     ignoring the repair contract — ignoredCount reaches the hardVeto
//     threshold) and the deficit still remains, the episode flips to
//     forcedPublish: buildAllowedActions collapses to
//     [workspace_publish_candidate] and the contentStructureExitForcedPublishGranted
//     escape (opensPublish, NOT opensFinalize) is granted, so every door —
//     single-action preflight, plan-batch surface filter, and the onResponse
//     finalize hook — converges on one honest limited publish. Direct
//     finalize/final_answer stay mechanically blocked throughout (no
//     finalize-opening escape can be granted while the episode is active).
//
// Everything here is issue-code / fact driven — no topic, section-name, or
// word-count hardcoding (AGRUN project rule).
//
// Import graph: leaf-adjacent by design — depends only on internal-utils, so
// allowed-actions.js, core.js, and escape-rules consumers can all import it
// without cycles.


// Content-level structure issue codes: these cannot be fixed by heading-only
// renames/renumbering (AGRUN-540) — they require merging or removing duplicate
// content blocks, or removing body content after the final section.
const CONTENT_STRUCTURE_ISSUE_CODES = Object.freeze([
  "semantic_duplicate_headings",
  "body_after_final_section"
]);

// Does the candidate currently show a content-level structure issue? Reads the
// SAME two fact sources the allowed-action builder historically read
// (observableDeficits.structure + workspace quality.finalCandidateStructure) —
// extracted here so the episode tracker and the action surface share one
// predicate instead of two drifting copies.
function hasContentLevelStructureIssue(observableDeficits, runState) {
  const issueCodes = new Set([
    ...readIssueCodes(observableDeficitsRecord(observableDeficits, "structure")),
    ...readIssueCodes(readRecord(
      runState &&
      runState.virtualWorkspace &&
      runState.virtualWorkspace.quality &&
      runState.virtualWorkspace.quality.finalCandidateStructure
    ))
  ]);
  return CONTENT_STRUCTURE_ISSUE_CODES.some((code) => issueCodes.has(code));
}

function readIssueCodes(structure) {
  return readStringArray(structure && structure.issueCodes);
}

function createContentStructureExitState() {
  return {
    kind: "content_structure_exit_state",
    active: false,
    attemptCount: 0,
    attemptLimit: 1,
    failedAttemptCount: 0,
    lastCountedCandidateVersion: 0,
    forcedPublish: false
  };
}

function readContentStructureExitState(runState) {
  const source = readRecord(runState && runState.contentStructureExitState);
  if (!source) return createContentStructureExitState();
  return {
    kind: "content_structure_exit_state",
    active: source.active === true,
    attemptCount: readNumber(source.attemptCount),
    attemptLimit: Math.max(readNumber(source.attemptLimit), 1),
    failedAttemptCount: readNumber(source.failedAttemptCount),
    lastCountedCandidateVersion: readNumber(source.lastCountedCandidateVersion),
    forcedPublish: source.forcedPublish === true
  };
}

// Workspace mutation actions whose FAILED outcomes count toward the failed-
// attempt bound below. A blocked/missed mutation makes no observable progress
// and never bumps the candidate file version, so without this bound a model
// looping on destructive-shrink-blocked or not_found replaces would never
// trigger the forced exit (observed live: 3x destructive_shrink_blocked in
// the 2026-06-17 run, 5x replace not_found in the 2026-07-06 baseline).
const CANDIDATE_MUTATION_ACTIONS = new Set([
  WORKSPACE_APPLY_PATCH_ACTION,
  WORKSPACE_INSERT_AFTER_SECTION_ACTION,
  WORKSPACE_MULTI_EDIT_ACTION,
  WORKSPACE_PROPOSE_PATCH_ACTION,
  WORKSPACE_REPLACE_ACTION,
  WORKSPACE_WRITE_ACTION
]);

const FAILED_MUTATION_STATUSES = new Set([
  "ambiguous",
  "destructive_shrink_blocked",
  "heading_not_found",
  "not_found",
  "preview_blocked",
  "repeated_find_vetoed"
]);

function isFailedCandidateMutation(actionName, output) {
  const name = readString(actionName);
  if (!CANDIDATE_MUTATION_ACTIONS.has(name)) return false;
  const result = readRecord(output);
  return FAILED_MUTATION_STATUSES.has(readString(result && result.status));
}

function resetContentStructureExitEpisode(runState) {
  if (!runState || typeof runState !== "object") return createContentStructureExitState();
  const next = createContentStructureExitState();
  runState.contentStructureExitState = next;
  return next;
}

// The episode predicate: content-level structure issue remains, length and
// source facts are satisfied, and a real drafted candidate exists. All inputs
// come from the SAME repair-facts bundle evaluateTerminalRepairState already
// computed for this cycle, so the episode can never disagree with the deficits
// the planner is shown.
function isContentStructureExitEligible({ activeDeficits, observableDeficits, runState }) {
  const deficits = readStringArray(activeDeficits);
  if (deficits.includes("source")) return false;
  if (observableDeficitsRecord(observableDeficits, "length")) return false;
  if (!hasContentLevelStructureIssue(observableDeficits, runState)) return false;
  return hasSelectedFinalCandidateContent(runState);
}

// STATE-TRANSITION (same contract as refreshTerminalRepairState): mutates
// runState.contentStructureExitState. Must be called ONLY from the active
// branch of evaluateTerminalRepairState so an episode can never start outside
// an active terminal-repair evaluation (a drafting-phase duplicate heading must
// not silently burn the repair-attempt budget before repair is even engaged).
//
// Idempotent across the phased refresh calls (before_planner / onResponse /
// post-action): attempts are detected via the final-candidate file version,
// and each observed version is counted at most once
// (lastCountedCandidateVersion high-water mark).
function updateContentStructureExitEpisode(runState, context = {}) {
  if (!runState || typeof runState !== "object") return createContentStructureExitState();
  const eligible = isContentStructureExitEligible({
    activeDeficits: context.activeDeficits,
    observableDeficits: context.observableDeficits,
    runState
  });
  if (!eligible) {
    // Deficit cleared (or length/source reopened): the episode contract no
    // longer applies. Reset so a future, genuinely new content-structure
    // deficit gets a fresh single-attempt budget.
    return resetContentStructureExitEpisode(runState);
  }
  const previous = readContentStructureExitState(runState);
  const attemptLimit = Math.max(readNumber(
    context.thresholds && context.thresholds.contentStructureRepairAttempts
  ) || 1, 1);
  const candidateVersion = readFinalCandidateVersion(runState);
  let attemptCount = previous.attemptCount;
  let failedAttemptCount = previous.failedAttemptCount;
  let lastCountedCandidateVersion = previous.lastCountedCandidateVersion;
  if (!previous.active) {
    // Episode start: baseline the candidate version; nothing counted yet.
    attemptCount = 0;
    failedAttemptCount = 0;
    lastCountedCandidateVersion = candidateVersion;
  } else if (candidateVersion > lastCountedCandidateVersion) {
    // An accepted content mutation of the final candidate happened while the
    // episode contract was in force and the deficit is STILL present — that
    // consumes one repair attempt. Blocked mutations (destructive shrink,
    // blocked patch previews) never advance the file version, so they are
    // never counted here (AGRUN-540/541 stay authoritative for what is
    // rejected) — they count toward the failed-attempt bound below instead.
    attemptCount += 1;
    lastCountedCandidateVersion = candidateVersion;
  } else if (isFailedCandidateMutation(context.actionName, context.output)) {
    // A blocked/missed repair mutation: no content progress, no version bump,
    // one full provider round-trip burned. Bounded separately so a model
    // looping on destructive-shrink-blocked or not_found finds the forced
    // exit instead of the run deadline. This branch only fires on the
    // post-action refresh (the phased before_planner refresh carries no
    // actionName), so one failed action counts exactly once.
    failedAttemptCount += 1;
  }
  const hardVetoThreshold = Math.max(readNumber(
    context.thresholds && context.thresholds.hardVeto
  ) || 3, 1);
  const forcedPublish =
    attemptCount >= attemptLimit ||
    failedAttemptCount > attemptLimit ||
    readNumber(context.ignoredCount) >= hardVetoThreshold;
  const next = {
    kind: "content_structure_exit_state",
    active: true,
    attemptCount,
    attemptLimit,
    failedAttemptCount,
    lastCountedCandidateVersion,
    forcedPublish
  };
  runState.contentStructureExitState = next;
  return next;
}

// True when the episode has consumed its repair-attempt budget (or the model
// kept ignoring the contract) and the deficit still remains: the ONLY sane
// action left is one honest limited workspace_publish_candidate. Consumed by
// buildAllowedActions (both dispatch doors read the resulting allowedActions)
// and by the escape grant in evaluateTerminalRepairState.
function isContentStructureForcedPublish(runState) {
  const state = readContentStructureExitState(runState);
  return state.active === true && state.forcedPublish === true;
}

// Prompt/step-facing signal. Null while no episode is active so the planner
// prompt and Inspector steps stay clean for unrelated runs.
function buildContentStructureExitSignal(state) {
  const episode = state && typeof state === "object" ? state : null;
  if (!episode || episode.active !== true) return null;
  return {
    kind: "content_structure_exit",
    attemptLimit: Math.max(readNumber(episode.attemptLimit), 1),
    attemptsUsed: readNumber(episode.attemptCount),
    failedAttempts: readNumber(episode.failedAttemptCount),
    forcedPublish: episode.forcedPublish === true,
    rule: episode.forcedPublish === true
      ? "The single content-structure repair attempt budget is used and the content-level structure issue remains. workspace_publish_candidate with finalReadiness.decision='limited' and the structure gap in remainingGaps is the ONLY allowed action; finalize/final_answer stay blocked."
      : "Length and sources are satisfied but a content-level structure issue remains (duplicate-purpose section blocks or body after the final section). Exactly ONE content-changing repair attempt is available: merge or remove the duplicate/late blocks in a single workspace_replace/workspace_write. If the issue remains after that attempt, the runtime forces an honest limited publish."
  };
}

function readFinalCandidateVersion(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const path = readFinalCandidatePathFromWorkspace(runState);
  const file = files && path ? readRecord(files[path]) : null;
  return readNumber(file && file.version);
}

export { CONTENT_STRUCTURE_ISSUE_CODES, buildContentStructureExitSignal, createContentStructureExitState, hasContentLevelStructureIssue, isContentStructureExitEligible, isContentStructureForcedPublish, readContentStructureExitState, resetContentStructureExitEpisode, updateContentStructureExitEpisode };
