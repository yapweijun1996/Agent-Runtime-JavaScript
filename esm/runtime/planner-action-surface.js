import { DEFAULT_FINAL_CANDIDATE_PATH } from './workspace-candidate-lifecycle.js';
import { PUBLISH_DIRECT_ACTION } from './action-names.js';
import { readStringArray, readString } from './semantic-json.js';
import { isPublishProtocolRequiredActionForRepair, isWorkspaceRepairInspectionActionForRepair } from './terminal-repair/publish-contract.js';
import { isEvidenceConvergenceRun } from './convergence-activation.js';
import { evaluateActionPolicy } from './policy.js';
import { resolveClosedNamespaceForAction } from './action-namespace-gate.js';

const SKILL_SETUP_ACTION_NAMES = new Set([
  "list_agent_skills",
  "read_agent_skill",
  "use_agent_skill"
]);
const DIRECT_TOOL_ACTION_NAME = "execute_skill_tool";
const SKILL_ACTION_NAMES = new Set([...SKILL_SETUP_ACTION_NAMES, DIRECT_TOOL_ACTION_NAME]);

// AGRUN-256 — workspace_publish_candidate is a terminal action designed for
// evidence-convergence (research) workflows. In tool_loop mode without any
// evidence-convergence skill engaged,
// envelope-mode planners (verified Gemini Flash-Lite) treat it as a generic
// "give up" escape, publishing fabricated workspace content with
// usedRuntimeFinalize=false (tokens=0, audit blind spot). Host integrators
// (Globe3 ERP 2026-05-26) shipped a runtime workaround disabling the action
// in disabledActions; that fix belongs in the runtime so every host doesn't
// independently rediscover the trap.
//
// Gate rule: hide workspace_publish_candidate from the planner action surface
// unless one of the following is true:
//   1. The run is an evidence-convergence run (a skill declaring the
//      `requiresEvidenceConvergence` capability is engaged). isEvidenceConvergenceRun()
//      is the shared signal used by the research report loop, provider timeout, and
//      planner prompt.
//   1b. The active agent skill declares `requiresPublishReadiness`; this covers
//       long-form workspace publishing skills that need direct candidate publish
//       without also activating the web-research evidence gate.
//   2. terminalRepairState.active === true AND publish is explicitly listed
//      in allowedActions. The repair surface has its own contract (publish
//      limited with concrete remainingGaps) that we must not break.
//   3. Host opts out via runtimeConfig.publishCandidateGate.enabled = false.
//      For hosts that intentionally want publish-direct in tool_loop mode.
//
// This is a structural gate, not a mode flag. It only affects the planner
// catalog and the per-decision runtime guard; the action handler itself
// (executeWorkspacePublishCandidateAction) is unchanged and remains usable
// when explicitly authorized.
const WORKSPACE_PUBLISH_CANDIDATE = PUBLISH_DIRECT_ACTION;
const WORKSPACE_REVIEW_CANDIDATE = "workspace_review_candidate";

function selectPlannerActions(actions, options = {}) {
  const source = Array.isArray(actions) ? actions : [];
  const terminalRepair = resolveTerminalRepairState(options);
  const actionPatternConvergence = resolveActionPatternConvergence(options);
  const allowedRepairActions = terminalRepair && terminalRepair.active === true
    ? new Set(readStringArray(terminalRepair.allowedActions))
    : null;
  const repeatedActionName = resolveRepeatedNoProgressActionName(actionPatternConvergence);
  const readOnlyPlanningForbiddenActions = resolveReadOnlyPlanningForbiddenActions(actionPatternConvergence);
  const structureRepairForbiddenActions = resolveStructureRepairForbiddenActions(actionPatternConvergence);
  const workspaceMutationGrowthForbiddenActions = resolveWorkspaceMutationGrowthForbiddenActions(actionPatternConvergence);
  const hideWorkspacePublishCandidate = shouldHideWorkspacePublishCandidateForMode(options);
  const hideFreshWorkspaceReviewCandidate = shouldHideFreshWorkspaceReviewCandidate(options);
  const readyWorkspacePublishOnly = shouldConstrainToReadyWorkspacePublish(options);

  if (readyWorkspacePublishOnly) {
    return source.filter((action) => readString(action && action.name) === WORKSPACE_PUBLISH_CANDIDATE);
  }

  return source.filter((action) => {
    const name = readString(action && action.name);
    if (!name) {
      return false;
    }

    // AGRUN-588 — statically denied actions never reach the model surface.
    // evaluateActionPolicy is args-independent (name + tier) and the
    // permission judge can only escalate "allow", never rescue a "deny" — so
    // a "deny" here is final for every possible call. Offering the tool
    // anyway invited guaranteed-rejection cycles: deepseek batched
    // [web_search, web_search] under policy deny and burned 3 cycles on
    // action_policy_denied_in_plan in the 2026-07-03 live probe. Placed above
    // the repair allowlist on purpose: no repair contract can authorize an
    // action no approval can grant. Execution-side policy checks stay — a
    // model can still hallucinate a tool name it was never offered.
    if (evaluateActionPolicy(options.runtimeConfig && options.runtimeConfig.actionPolicy, action).action === "deny") {
      return false;
    }

    // AGRUN-415 — the two resolvers ABOVE the terminal-repair allowlist
    // early-return (readOnlyPlanning, workspaceMutationGrowth) override
    // everything, INCLUDING that allowlist. To avoid clobbering the repair
    // allowlist at advisory level, they each gate on escalation === "hard_veto"
    // (so advisory signals fall through to the allowlist below). structureRepair
    // is DIFFERENT BY DESIGN: it is evaluated AFTER the allowlist early-return,
    // so it can never override the allowlist — and it intentionally forbids at
    // its no-progress ACTIVATION threshold (advisory), not only at hard_veto,
    // because forbidding the unproductive section-edit moves early is the whole
    // point of activating. See resolveStructureRepairForbiddenActions and
    // structure-repair-escalation-asymmetry.test.js. (Aligning structureRepair
    // to a hard_veto gate would regress that loop-break — verified: it breaks
    // planner-action-surface's "hides no-progress structure repair actions".)
    if (
      readOnlyPlanningForbiddenActions &&
      readOnlyPlanningForbiddenActions.has(name) &&
      !isPublishProtocolRequiredActionForRepair(terminalRepair, name) &&
      !isWorkspaceRepairInspectionActionForRepair(terminalRepair, name)
    ) return false;
    if (
      workspaceMutationGrowthForbiddenActions &&
      workspaceMutationGrowthForbiddenActions.has(name)
    ) {
      return false;
    }
    if (allowedRepairActions) {
      return allowedRepairActions.has(name);
    }

    // ADR-0057 Phase 1 — deferred-namespace subtraction: members of a closed
    // namespace leave the per-cycle planner catalog, so the "Available
    // actions" list, the args-examples envelope block, and every hasAction()
    // gate in workspace/research/todo/skill-directives shrink for free —
    // and re-appear the cycle after open_action_namespace runs. Placed BELOW
    // the terminal-repair allowlist early-return above so an active repair
    // contract keeps owning the surface (ADR-0057 §5; the gate predicate
    // itself also auto-opens for repair contracts + evidence-convergence
    // runs, keeping this filter and both dispatch doors consistent).
    // Composes with disabledActions, which subtracted unconditionally
    // upstream (action-loop-session.js) before this per-cycle filter runs.
    if (resolveClosedNamespaceForAction(options.runState, options.runtimeConfig, name)) {
      return false;
    }

    if (repeatedActionName && name === repeatedActionName) {
      return false;
    }

    if (structureRepairForbiddenActions && structureRepairForbiddenActions.has(name)) {
      return false;
    }

    if (hideWorkspacePublishCandidate && name === WORKSPACE_PUBLISH_CANDIDATE) {
      return false;
    }

    if (hideFreshWorkspaceReviewCandidate && name === WORKSPACE_REVIEW_CANDIDATE) {
      return false;
    }

    return true;
  });
}

// Exposed so the per-decision runtime guard in the action loop can report
// the same gate reason that selectPlannerActions used to hide the action.
function isWorkspacePublishCandidateGatedForMode(options = {}) {
  return shouldHideWorkspacePublishCandidateForMode(options);
}

function shouldHideWorkspacePublishCandidateForMode(options) {
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : null;
  if (!runState) return false;
  if (isPublishCandidateGateDisabled(options && options.runtimeConfig)) return false;
  // terminalRepair owns the action surface when active: defer to its
  // allowedActions list regardless of whether publish_candidate is on
  // it. The repair-driven block (or expose) is the authoritative signal,
  // and its detail message in buildRuntimeActionSurfaceDetail is what
  // the planner should see — not the mode-gate hint.
  const terminalRepair = resolveTerminalRepairState(options);
  if (terminalRepair && terminalRepair.active === true) return false;
  if (isEvidenceConvergenceRun(runState, options)) return false;
  if (isPublishReadinessSkillActive(options, runState)) return false;
  return true;
}

function isPublishReadinessSkillActive(options, runState) {
  const source = options && typeof options === "object" ? options : {};
  const context = runState && runState.agentSkillContext && typeof runState.agentSkillContext === "object"
    ? runState.agentSkillContext
    : {};
  return [
    source.activeAgentSkill,
    source.lastReadAgentSkill,
    context.activeSkill,
    context.lastReadSkill
  ].some((skill) => (
    skill &&
    typeof skill === "object" &&
    skill.capabilities &&
    skill.capabilities.requiresPublishReadiness === true
  ));
}

function isPublishCandidateGateDisabled(runtimeConfig) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return false;
  const config = runtimeConfig.publishCandidateGate;
  if (!config || typeof config !== "object") return false;
  return config.enabled === false;
}

function shouldConstrainToReadyWorkspacePublish(options) {
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : null;
  if (!runState) return false;
  const terminalRepair = resolveTerminalRepairState(options);
  if (terminalRepair && terminalRepair.active === true) return false;
  if (hasUnfinishedTodoState(runState)) return false;
  // AGRUN-305 — do NOT gate ready-narrowing on the mode-hide. The mode-hide
  // (AGRUN-256 anti-"give-up") exists to suppress PREMATURE publish before a
  // candidate is ready; but every gate below already proves the candidate was
  // finalized, read, and reviewed (in order) with review.readyToPublish=true,
  // zero issues, a clean quality signal, no unfinished todo, and source minimum
  // passed — it has objectively earned publish. In run-3 a genuinely-ready
  // report (3014 words, userGoalSatisfied=true) was never published because the
  // report-writing skill's requiresPublishReadiness capability did not reach the
  // surface, so the mode-hide hid publish and disabled this narrowing, leaving
  // the model to churn finalize/review to MAX_STEPS. Promotion here is honest
  // regardless of mode/skill detection; not-yet-ready candidates still fail a
  // gate below and the normal-path mode-hide keeps publish hidden for them.
  if (sourceMinimumIsBlocked(runState)) return false;
  const workspace = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const quality = workspace && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : null;
  if (!quality || quality.finalCandidateReady !== true) return false;
  const path = readString(quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const protocol = readPublishProtocol(workspace, path);
  if (!protocol || protocol.finalizedAfterLatestWrite !== true || protocol.readAfterLatestContentChange !== true) {
    return false;
  }
  if (protocol.reviewAfterLatestContentChange !== true || protocol.reviewAfterRead !== true) {
    return false;
  }
  const lastRead = quality.lastRead && typeof quality.lastRead === "object" ? quality.lastRead : null;
  if (!lastRead || readString(lastRead.path) !== path) return false;
  const review = quality.candidateReview && typeof quality.candidateReview === "object"
    ? quality.candidateReview
    : null;
  if (!review || readString(review.path) !== path || review.readyToPublish !== true) return false;
  if (readNumber$5(review.issueCount) > 0) return false;
  const signal = quality.candidateQualitySignal && typeof quality.candidateQualitySignal === "object"
    ? quality.candidateQualitySignal
    : runState.candidateQualitySignal && typeof runState.candidateQualitySignal === "object"
      ? runState.candidateQualitySignal
      : null;
  if (signal) {
    if (signal.hasBlockingIssues === true) return false;
    if (readStringArray(signal.blockingIssueCodes).length > 0) return false;
    const status = readString(signal.status);
    if (signal.ok !== true && status !== "pass") return false;
  }
  return true;
}

function shouldHideFreshWorkspaceReviewCandidate(options) {
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : null;
  if (!runState) return false;
  const terminalRepair = resolveTerminalRepairState(options);
  if (terminalRepair && terminalRepair.active === true) return false;
  const workspace = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const quality = workspace && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : null;
  if (!workspace || !quality) return false;
  const path = readString(quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const files = workspace.files && typeof workspace.files === "object" && !Array.isArray(workspace.files)
    ? workspace.files
    : {};
  const file = files[path] && typeof files[path] === "object" ? files[path] : null;
  const review = quality.candidateReview && typeof quality.candidateReview === "object"
    ? quality.candidateReview
    : null;
  if (!file || !review || readString(review.path) !== path) return false;
  const fileVersion = readNumber$5(file.version);
  if (fileVersion <= 0 || readNumber$5(review.fileVersion) !== fileVersion) return false;
  const protocol = readPublishProtocol(workspace, path);
  return Boolean(
    protocol &&
    protocol.reviewAfterLatestContentChange === true &&
    protocol.reviewAfterRead === true
  );
}

function readPublishProtocol(workspace, path) {
  const operations = Array.isArray(workspace && workspace.operations) ? workspace.operations : [];
  let latestWriteIndex = -1;
  let latestFinalizeIndex = -1;
  let latestReadIndex = -1;
  let latestReviewIndex = -1;
  operations.forEach((operation, index) => {
    if (!operation || typeof operation !== "object") return;
    if (readString(operation.path) !== path) return;
    const action = readString(operation.action);
    if (
      action === "write" ||
      action === "append" ||
      action === "insert_after_section" ||
      action === "replace" ||
      action === "multi_edit" ||
      action === "move" ||
      action === "apply_patch"
    ) {
      latestWriteIndex = index;
    }
    if (action === "finalize_candidate") latestFinalizeIndex = index;
    if (action === "read") latestReadIndex = index;
    if (action === "review_candidate") latestReviewIndex = index;
  });
  return {
    finalizedAfterLatestWrite: latestFinalizeIndex > -1 && latestFinalizeIndex > latestWriteIndex,
    readAfterLatestContentChange: latestReadIndex > -1 && latestReadIndex > latestWriteIndex,
    reviewAfterLatestContentChange: latestReviewIndex > -1 && latestReviewIndex > latestWriteIndex,
    reviewAfterRead: latestReviewIndex > -1 && latestReviewIndex > latestReadIndex
  };
}

function sourceMinimumIsBlocked(runState) {
  const loop = runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  const packet = loop && loop.gateSignal && loop.gateSignal.acceptancePacket && typeof loop.gateSignal.acceptancePacket === "object"
    ? loop.gateSignal.acceptancePacket
    : null;
  const packetMinimum = packet && packet.evidence && typeof packet.evidence === "object"
    ? packet.evidence.sourceMinimum
    : null;
  const minimum = packetMinimum && typeof packetMinimum === "object"
    ? packetMinimum
    : loop && loop.sourceMinimum && typeof loop.sourceMinimum === "object"
      ? loop.sourceMinimum
      : null;
  return Boolean(minimum && minimum.passed === false);
}

function hasUnfinishedTodoState(runState) {
  const todo = runState.todoState && typeof runState.todoState === "object"
    ? runState.todoState
    : null;
  if (!todo) return false;
  const counts = todo.counts && typeof todo.counts === "object" ? todo.counts : null;
  if (counts) {
    return ["active", "pending", "blocked"].some((key) => readNumber$5(counts[key]) > 0);
  }
  const items = Array.isArray(todo.items) ? todo.items : [];
  return items.some((item) => {
    const status = readString(item && item.status);
    return status && status !== "done" && status !== "completed" && status !== "abandoned" && status !== "cancelled";
  });
}

function shouldShowSkillSurface(actions) {
  return (Array.isArray(actions) ? actions : []).some((action) => {
    const name = readString(action && action.name);
    return SKILL_ACTION_NAMES.has(name);
  });
}

function resolveTerminalRepairState(options) {
  if (options && options.terminalRepairState && typeof options.terminalRepairState === "object") {
    return options.terminalRepairState;
  }
  if (
    options &&
    options.runState &&
    options.runState.terminalRepairState &&
    typeof options.runState.terminalRepairState === "object"
  ) {
    return options.runState.terminalRepairState;
  }
  return null;
}

function resolveActionPatternConvergence(options) {
  if (options && options.actionPatternConvergence && typeof options.actionPatternConvergence === "object") {
    return options.actionPatternConvergence;
  }
  if (
    options &&
    options.runState &&
    options.runState.actionPatternConvergence &&
    typeof options.runState.actionPatternConvergence === "object"
  ) {
    return options.runState.actionPatternConvergence;
  }
  return null;
}

function resolveRepeatedNoProgressActionName(value) {
  const signal = value && value.convergenceSignal && typeof value.convergenceSignal === "object"
    ? value.convergenceSignal
    : null;
  if (!signal) return "";
  if (readString(signal.patternKind) !== "exact_action") return "";
  if (readString(signal.forbiddenMove) !== "repeat_same_action_args") return "";
  return readString(signal.actionName);
}

function resolveReadOnlyPlanningForbiddenActions(value) {
  const state = value && value.readOnlyPlanningState && typeof value.readOnlyPlanningState === "object"
    ? value.readOnlyPlanningState
    : null;
  if (!state || state.active !== true) return null;
  if (readString(state.escalation) !== "hard_veto") return null;
  const forbiddenActions = readStringArray(state.forbiddenActions);
  return forbiddenActions.length > 0 ? new Set(forbiddenActions) : null;
}

// AGRUN-415 — DELIBERATELY no `escalation === "hard_veto"` gate, unlike the two
// sibling resolvers. Those two sit ABOVE the terminal-repair allowlist
// early-return in selectPlannerActions and would clobber it at advisory level,
// so they gate on hard_veto. This resolver is consumed BELOW that early-return,
// so it can never override the allowlist regardless of escalation — and the
// structure-repair convergence intentionally populates forbiddenActions at its
// no-progress ACTIVATION threshold (advisory, default 2), escalating the
// `escalation` label to hard_veto only at the higher threshold (default 3).
// Forbidding the unproductive section-edit moves starting at activation is the
// purpose of activating; gating here on hard_veto would make the activation
// threshold a no-op for the action surface. Pinned by
// structure-repair-escalation-asymmetry.test.js + the long-standing
// planner-action-surface "hides no-progress structure repair actions" case.
function resolveStructureRepairForbiddenActions(value) {
  const state = value && value.structureRepairConvergence && typeof value.structureRepairConvergence === "object"
    ? value.structureRepairConvergence
    : null;
  if (!state || state.active !== true) return null;
  const forbiddenActions = readStringArray(state.forbiddenActions);
  return forbiddenActions.length > 0 ? new Set(forbiddenActions) : null;
}

function resolveWorkspaceMutationGrowthForbiddenActions(value) {
  const state = value && value.workspaceMutationGrowthConvergence && typeof value.workspaceMutationGrowthConvergence === "object"
    ? value.workspaceMutationGrowthConvergence
    : null;
  if (!state || state.active !== true) return null;
  if (readString(state.escalation) !== "hard_veto") return null;
  const forbiddenActions = readStringArray(state.forbiddenActions);
  return forbiddenActions.length > 0 ? new Set(forbiddenActions) : null;
}

function readNumber$5(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export { isWorkspacePublishCandidateGatedForMode, selectPlannerActions, shouldShowSkillSurface };
