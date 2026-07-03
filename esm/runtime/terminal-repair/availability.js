import { readString } from '../semantic-json.js';
import { normalizeVirtualWorkspace } from '../virtual-workspace.js';
import { PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { isWorkspacePublishCandidateGatedForMode } from '../planner-action-surface.js';
import { resolveGrantedTerminalEscape } from './escape-rules.js';

// AGRUN-559 — cross-file SSOT for "which terminal doors are open right now".
//
// The AGRUN-550/551/552 incident family shared one root cause: the decision
// "can this turn terminate with content" had no single owner. It was split
// across independently-evolved gates read at different lifecycle phases from
// different input bags — readEnvelopeTerminalPolicy (prompt/repair/rejection),
// isWorkspacePublishCandidateGatedForMode (publish mode gate, two dispatch
// doors), and the terminal-repair escape flags (onResponse hook + preflight
// blocks). AGRUN-551 was literally two of those gates disagreeing: the
// envelope policy closed finalize because a candidate existed, while the
// publish gate had already closed publish — both terminals shut, run thrashed
// to the deadline and returned EMPTY.
//
// resolveTerminalAvailability computes the mutually-consistent fact object
// ONCE from the same inputs those gates already use. It is a COMPOSITION /
// adapter layer, not a reimplementation:
//   - publish gating delegates to the EXISTING
//     isWorkspacePublishCandidateGatedForMode (planner-action-surface.js);
//   - terminal-repair escapes are read from the CURRENT
//     runState.terminalRepairState, which is produced by the EXISTING
//     evaluateTerminalRepairState at its phased refresh sites. This function
//     deliberately does NOT call evaluate/refresh itself: those are
//     STATE-TRANSITION functions (AGRUN-493 invariant — they tick ignoredCount
//     and the run-level cumulative counter), so re-running them from a pure
//     read would double-tick the escalation ladder.
//
// Consumers (all doors, per the Dispatch-Path Parity rule):
//   - planner-envelope-lines.js readEnvelopeTerminalPolicy (main prompt via
//     buildEnvelopeLines, repair prompt, finalize-rejection check);
//   - action-loop-session-loop.js publish-direct runtime guard (single-action
//     door);
//   - action-loop-plan-validation.js buildRuntimeActionSurfaceDetail (plan
//     door);
//   - hooks/terminal-repair-hook.js + blocks/terminal-repair.js +
//     actions/workspace/publish-sources.js consume the escape metadata through
//     resolveGrantedTerminalEscape (escape-rules.js), which this fact object
//     carries as `escapeGranted`.
//
// INVARIANT (pinned by test/unit/terminal-availability-totality.test.js): for
// every reachable combination of gate inputs, at least one of the following
// holds — finalizeOpen, publishOpen, escapeGranted, or the terminal-repair
// escalation is still below hard_veto (the counter can still advance toward an
// escape). A cell where all four fail is a livelock-to-empty-output bug of the
// AGRUN-550/551/552 class.


// Reason vocabulary. FINALIZE_CLOSED_PUBLISH_PATH_REQUIRED is the historical
// readEnvelopeTerminalPolicy reason string (pinned by
// agrun-551-finalize-available-when-publish-gated.test.js) — do not rename.
const FINALIZE_CLOSED_PUBLISH_PATH_REQUIRED = "workspace_publish_path_required";
const PUBLISH_CLOSED_CANDIDATE_GATED = "publish_candidate_gated";
const PUBLISH_CLOSED_NOT_ON_SURFACE = "publish_action_not_on_surface";

// options:
//   availableActions   — the planner action surface (array) when the caller is
//                        assembling a prompt/policy for it. OMIT at the
//                        per-action dispatch doors: there the caller has
//                        already resolved the concrete action, so publishOpen
//                        reflects the mode gate only.
//   runtimeConfig, activeAgentSkill, lastReadAgentSkill — forwarded verbatim
//                        to the publish mode gate (AGRUN-551 input bag).
//   terminalRepairState — optional explicit repair state; defaults to
//                        runState.terminalRepairState.
function resolveTerminalAvailability(runState, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const terminalRepairState =
    opts.terminalRepairState && typeof opts.terminalRepairState === "object"
      ? opts.terminalRepairState
      : runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
        ? runState.terminalRepairState
        : null;
  const repairActive = Boolean(terminalRepairState && terminalRepairState.active === true);
  const escapeGranted = resolveGrantedTerminalEscape(terminalRepairState);

  // Publish door — SSOT mode gate (AGRUN-256/305/551 conditions live there).
  const publishGateClosed = isWorkspacePublishCandidateGatedForMode({
    runState,
    runtimeConfig: opts.runtimeConfig,
    activeAgentSkill: opts.activeAgentSkill,
    lastReadAgentSkill: opts.lastReadAgentSkill,
    terminalRepairState
  });
  const surface = Array.isArray(opts.availableActions) ? opts.availableActions : null;
  const publishOnSurface = surface
    ? surface.some((action) => action && readString(action.name) === PUBLISH_DIRECT_ACTION)
    : true;
  // AGRUN-560 — the AGRUN-256 mode gate (isWorkspacePublishCandidateGatedForMode)
  // predates the AGRUN-307 terminal-repair publish-loop escape and never learned
  // about it: pre-AGRUN-559, action-loop-session-loop.js and
  // action-loop-plan-validation.js each called the mode gate directly, so a
  // granted publishLoopEscapeGranted (opensPublish:true) never reached the
  // publish action at all — the runtime guard rejected it as
  // workspace_publish_candidate_gated before the executor's own escape-aware
  // checks (blocks/terminal-repair.js, workspace-candidate-executors.js) ever
  // ran. Confirmed via test/livekit/repro-workspace-publish-loop.mjs: the
  // escape flag reached true but the run still deadlined to maxSteps because
  // every post-escape publish attempt was vetoed here, one level up. The escape
  // is an explicit, narrow, hard_veto-gated override of the mode gate by
  // design (AGRUN-307's whole point is "accept the drafted artifact once the
  // normal protocol has provably failed") — so this SSOT is the correct place
  // to fold it in once, instead of patching each door again.
  const escapeOpensPublish = Boolean(escapeGranted && escapeGranted.opensPublish);
  const publishOpen = escapeOpensPublish || (publishOnSurface && !publishGateClosed);
  const publishClosedReason = publishOpen
    ? null
    : !publishOnSurface
      ? PUBLISH_CLOSED_NOT_ON_SURFACE
      : PUBLISH_CLOSED_CANDIDATE_GATED;

  // Finalize door — AGRUN-551 rule, verbatim semantics: disable finalize to
  // force the publish path ONLY when publish-direct is actually executable
  // (on the surface AND not mode-gated) and a real workspace candidate exists.
  // When publish is gated, finalize stays available so the model always has
  // one terminal path (the runtime finalizer delivers the drafted answer).
  // Surface-aware by design: only prompt/policy callers pass availableActions,
  // so per-action doors never see finalize closed by this rule.
  const publishPathRequired = surface !== null &&
    publishOnSurface &&
    hasWorkspacePublishCandidateContent(runState);
  const finalizeOpen = !(publishPathRequired && publishOpen);

  return Object.freeze({
    finalizeOpen,
    finalizeClosedReason: finalizeOpen ? null : FINALIZE_CLOSED_PUBLISH_PATH_REQUIRED,
    publishOpen,
    publishClosedReason,
    escapeGranted,
    repairActive
  });
}

// Moved VERBATIM from planner-envelope-lines.js
// hasWorkspacePublishCandidatePathRequired (AGRUN-551), minus the
// surface-membership check which resolveTerminalAvailability owns: does the
// virtual workspace hold real candidate content worth forcing the publish
// path for?
function hasWorkspacePublishCandidateContent(runState) {
  const workspace = normalizeVirtualWorkspace(runState && runState.virtualWorkspace);
  if (!workspace || workspace.enabled !== true) return false;
  const quality = workspace.quality && typeof workspace.quality === "object" ? workspace.quality : {};
  if (quality.finalCandidateReady === true) return true;
  return Object.values(workspace.files || {}).some((file) => (
    readString(file && file.content).length > 0
  ));
}

export { FINALIZE_CLOSED_PUBLISH_PATH_REQUIRED, PUBLISH_CLOSED_CANDIDATE_GATED, PUBLISH_CLOSED_NOT_ON_SURFACE, hasWorkspacePublishCandidateContent, resolveTerminalAvailability };
