import { executeAction } from './action-loop-action.js';
import { finalizeActionLoopFailure } from './action-loop-failure.js';
import { createActionLoopSession } from './action-loop-session.js';
import { normalizeApprovalResolutionInput, restoreApprovalRequest, normalizePendingApproval } from './approval-state.js';
import { ERROR_CODES } from './errors.js';
import { recordObservation, startEvaluatePhase, completeEvaluatePhase } from './finalizer.js';
import { normalizeInput } from './input.js';
import { completePhase, startPhase } from './oodae.js';
import { summarizeSessionContextMeta } from '../session/prompt.js';
import { cloneValue } from './utils.js';
import { consumeControlEnvelope, startControlEnvelope } from './control-envelope.js';
import { readContextSnapshot, createContextSnapshot } from '../session/context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot, createSessionContextViewFromSnapshot } from '../session/context-snapshot-projection.js';
import { applyTurnControl, TURN_SIGNALS } from './turn-signal.js';
import { beginActionLoopCycle } from './action-loop-session-cycle.js';
import { continueActionLoop } from './action-loop-session-loop.js';

const MAX_CONSECUTIVE_DENIALS = 2;

async function runApprovalResolution(options) {
  const { rawInput, runId, runtimeConfig, runtimeState, resolvedMemory } = options;
  const preVerified = !!(rawInput && rawInput._approvalPreVerified);
  const approvalRequest = await normalizeApprovalResolutionInput(rawInput, {
    signer: preVerified ? null : (runtimeConfig.approvalSigner || null),
    enforceSessionBinding: !preVerified && !!(runtimeConfig.approvalSigning && runtimeConfig.approvalSigning.enforceSessionBinding)
  });
  const request = {
    ...restoreApprovalRequest(approvalRequest.resumeToken, rawInput),
    type: "approval_resolution"
  };
  // ADR-0037 + AGRUN-254 follow-up — historically this call built the
  // session bag via an explicit destructure (disabledActions,
  // normalizedInput, rawInput, request, resolvedMemory, runId,
  // runtimeConfig, runtimeState). That allowlist silently dropped
  // every new option added to runLoop, which caused three live-e2e
  // bugs in a row when ADR-0037 introduced new options:
  //   1. `spawnSubagentRunLoop` missing → SUBAGENT_CAPABILITY_MISSING
  //   2. `sessionId`/`parentSessionId` missing → child lineage lost
  //   3. `skills` missing → child runLoop's findDirectSkillMatch threw
  //      "skills is not iterable" after the spawn
  //
  // Root cause: an explicit allowlist is a maintenance trap. The safe
  // default is SPREAD all options the runLoop received and only
  // OVERRIDE the fields that approval-resume genuinely needs to
  // change. This way new runLoop options propagate automatically.
  const session = createActionLoopSession({
    ...options,
    normalizedInput: options.normalizedInput || normalizeInput(rawInput),
    rawInput,
    request
  });

  hydrateApprovalSession(session, approvalRequest);

  const cycleRecord = await beginActionLoopCycle(session, "policy");
  const actionName = approvalRequest.resumeToken.actionName;
  const pendingApproval = session.runState.pendingApproval;

  completePhase(cycleRecord, session.pushStep, "decide", {
    actionName,
    cycle: session.runState.cycleCount,
    decisionSource: "policy",
    decisionType: "approval_resolution",
    outcome: "selected",
    selectedSkill: null
  });
  startPhase(session.runState, session.pushStep, "act", {
    cycle: session.runState.cycleCount,
    selectedSkill: null
  });

  if (approvalRequest.decision === "deny") {
    consumeControlEnvelope(session.runState, null);
    return handleApprovalDenied({
      cycleRecord,
      pendingApproval,
      session
    });
  }

  if (!pendingApproval || pendingApproval.policy !== "ask" || pendingApproval.resumable !== true) {
    return finalizeActionLoopFailure({
      cause: `Approval cannot resume action "${actionName}".`,
      code: ERROR_CODES.APPROVAL_RESOLUTION_ERROR,
      cycleRecord,
      memoryEntriesAdded: session.memoryEntriesAdded,
      normalizedInput: session.normalizedInput,
      output: null,
      pushStep: session.pushStep,
      rawInput: session.rawInput,
      runState: session.runState,
      runtimeState: session.runtimeState,
      steps: session.steps
    });
  }

  session.pushStep("approval-resolved", {
    actionName,
    cycle: session.runState.cycleCount,
    decision: approvalRequest.decision
  });

  const actionResult = await executeAction({
    actionHistory: session.actionHistory,
    actionName,
    actionRegistry: session.actionRegistry,
    agentSkillIndexProvider: session.runtimeConfig.agentSkillIndexProvider,
    agentSkills: session.runtimeConfig.agentSkills,
    cycleRecord,
    decision: cloneValue(approvalRequest.resumeToken.decision),
    memoryEntriesAdded: session.memoryEntriesAdded,
    normalizedInput: session.normalizedInput,
    pushStep: session.pushStep,
    rawInput: session.rawInput,
    request: session.request,
    runtimeConfig: session.runtimeConfig,
    runState: session.runState,
    runtimeState: session.runtimeState,
    // ADR-0037 — Forward the spawn_subagent capability on the approval-resume
    // path so an approved spawn_subagent action can still execute its worker.
    spawnSubagent: session.spawnSubagent,
    steps: session.steps
  });

  if (actionResult.done) {
    clearApprovalResolutionRequest(session.request);
    consumeControlEnvelope(session.runState, session.request && session.request.type);
    return actionResult.result;
  }

  clearApprovalResolutionRequest(session.request);
  consumeControlEnvelope(session.runState, session.request && session.request.type);
  applyTurnControl(session.runState, {
    actionName,
    cycle: session.runState.cycleCount,
    observation: session.runState.observation,
    signal: TURN_SIGNALS.RUN_AGAIN,
    source: "approval_resume"
  });
  markContinuingInterruptedTurn(session);
  return continueActionLoop(session);
}

function hydrateApprovalSession(session, approvalRequest) {
  const requestSnapshot = readContextSnapshot(session.request);
  const requestSessionContext = requestSnapshot
    ? projectSessionContextFromSnapshot(requestSnapshot)
    : readSessionContext$1(session.request);

  session.runState.mode = "tool_loop";
  if (Number.isInteger(approvalRequest.resumeToken.cycleCount) && approvalRequest.resumeToken.cycleCount > 0) {
    session.runState.cycleCount = approvalRequest.resumeToken.cycleCount;
  }
  if (Number.isInteger(approvalRequest.resumeToken.turnCount) && approvalRequest.resumeToken.turnCount > 0) {
    session.runState.turnCount = approvalRequest.resumeToken.turnCount;
  } else if (session.runState.cycleCount > 0) {
    session.runState.turnCount = session.runState.cycleCount;
  }
  session.runState.lastAction = approvalRequest.resumeToken.actionName;
  startControlEnvelope(session.runState, "approval_resolution");
  session.runState.pendingApproval = normalizePendingApproval({
    actionName: approvalRequest.resumeToken.actionName,
    policy: approvalRequest.resumeToken.policy,
    reason: approvalRequest.resumeToken.reason,
    resumable: approvalRequest.resumeToken.resumable,
    resolution: "pending",
    resumeToken: approvalRequest.resumeToken
  });
  session.runState.plannerInvalidCount = approvalRequest.resumeToken.plannerInvalidCount;
  session.runState.actionPatternConvergence = cloneValue(
    approvalRequest.resumeToken.actionPatternConvergence || session.runState.actionPatternConvergence
  );
  session.runState.terminalRepairState = cloneValue(
    approvalRequest.resumeToken.terminalRepairState || session.runState.terminalRepairState
  );
  session.runState.researchContext = cloneValue(
    approvalRequest.resumeToken.researchContext || session.runState.researchContext
  );
  session.runState.researchEvidenceGraph = cloneValue(
    approvalRequest.resumeToken.researchEvidenceGraph || session.runState.researchEvidenceGraph
  );
  session.runState.researchAcceptanceEvaluator = cloneValue(
    approvalRequest.resumeToken.researchAcceptanceEvaluator || session.runState.researchAcceptanceEvaluator
  );
  session.runState.requirementRecoveryEvaluator = cloneValue(
    approvalRequest.resumeToken.requirementRecoveryEvaluator || session.runState.requirementRecoveryEvaluator
  );
  session.runState.researchWorkspace = cloneValue(
    approvalRequest.resumeToken.researchWorkspace || session.runState.researchWorkspace
  );
  session.runState.researchReportLoop = cloneValue(
    approvalRequest.resumeToken.researchReportLoop || session.runState.researchReportLoop
  );
  session.runState.candidatePathMismatchSignal = cloneValue(
    approvalRequest.resumeToken.candidatePathMismatchSignal || session.runState.candidatePathMismatchSignal || null
  );
  session.runState.virtualWorkspace = cloneValue(
    approvalRequest.resumeToken.virtualWorkspace || session.runState.virtualWorkspace
  );
  session.runState.toolContext = cloneValue(
    approvalRequest.resumeToken.toolContext || session.runState.toolContext
  );
  session.runState.turnControl = cloneValue(
    approvalRequest.resumeToken.turnControl || session.runState.turnControl || null
  );
  session.runState.todoState = cloneValue(
    approvalRequest.resumeToken.todoState || session.runState.todoState || null
  );
  session.runState.contextSnapshot = requestSnapshot
    ? createContextSnapshot(requestSnapshot)
    : null;
  session.runState.agentSkillContext = cloneValue(
    approvalRequest.resumeToken.agentSkillContext || session.runState.agentSkillContext
  );
  session.runState.sessionContextMeta = requestSessionContext
    ? summarizeSessionContextMeta(requestSessionContext)
    : null;
  session.runState.sessionContextView = requestSessionContext
    ? requestSnapshot
      ? createSessionContextViewFromSnapshot(requestSnapshot)
      : createSessionContextView$1(requestSessionContext)
    : null;
  session.actionHistory.push(
    ...cloneValue(Array.isArray(approvalRequest.resumeToken.actionHistory)
      ? approvalRequest.resumeToken.actionHistory
      : [])
  );
}

function handleApprovalDenied(options) {
  const { cycleRecord, pendingApproval, session } = options;
  const actionName = pendingApproval ? pendingApproval.actionName : "action";

  session.pushStep("approval-resolved", {
    actionName,
    cycle: session.runState.cycleCount,
    decision: "deny"
  });

  // Record denied entry in actionHistory so the planner sees it via deniedActions.
  session.actionHistory.push({
    actionName,
    kind: "denied",
    summary: `User denied approval for ${actionName}.`
  });

  session.runState.pendingApproval = null;
  const rejectionObservation = {
    actionName,
    kind: "tool_rejection",
    message: `User denied approval for ${actionName}.`,
    policy: pendingApproval ? pendingApproval.policy : "ask",
    resolution: "denied"
  };
  recordObservation(
    session.runState,
    session.pushStep,
    rejectionObservation,
    {
      actionName,
      cycle: session.runState.cycleCount,
      kind: "tool_rejection"
    }
  );
  applyTurnControl(session.runState, {
    actionName,
    cycle: session.runState.cycleCount,
    observation: rejectionObservation,
    signal: TURN_SIGNALS.RUN_AGAIN,
    source: "approval_resume"
  });
  completePhase(cycleRecord, session.pushStep, "act", {
    actionName,
    approvalStatus: pendingApproval ? pendingApproval.policy : "ask",
    outcome: "denied",
    resultKind: "denied"
  });
  startEvaluatePhase(session.runState, session.pushStep, null);
  completeEvaluatePhase(cycleRecord, session.pushStep, {
    nextPromptState: "continue",
    observationKind: session.runState.observation.kind,
    outcome: "denied_continue"
  });

  // AGRUN-294I — AI-owned denial handling. The runtime previously
  // force-finalized after MAX_CONSECUTIVE_DENIALS consecutive denials. That was
  // push-mode: the runtime decided to END the run for the AI. It is also
  // redundant — the denied action is already recorded in deniedActions, and the
  // planner-prompt deniedActions contract already instructs the AI that, once
  // deniedActions is non-empty, its ONLY valid moves are a non-denied action,
  // `finalize`, or an honest `final` explaining the limitation. So the runtime
  // no longer finalizes here. It records an observability-only streak signal
  // (so the Inspector/debug can see repeated denials) and lets the planner
  // decide next cycle. The run-level step budget remains the liveness backstop.
  const consecutiveDenials = countConsecutiveDenials(session.actionHistory);
  if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
    session.pushStep("approval-denial-streak", {
      consecutiveDenials,
      cycle: session.runState.cycleCount,
      note: "AI-owned: planner sees deniedActions and decides (finalize honestly or choose a non-approval action). Runtime no longer force-finalizes."
    });
  }

  // Continue the action loop — the planner sees deniedActions and decides.
  markContinuingInterruptedTurn(session);
  return continueActionLoop(session);
}

function markContinuingInterruptedTurn(session) {
  session.continuingInterruptedTurn = true;
  if (session.runState && typeof session.runState === "object") {
    session.runState.continuingInterruptedTurn = true;
  }
}

function countConsecutiveDenials(actionHistory) {
  let count = 0;

  for (let index = actionHistory.length - 1; index >= 0; index -= 1) {
    const entry = actionHistory[index];
    if (!entry || typeof entry !== "object") break;
    if (entry.kind === "denied") {
      count += 1;
      continue;
    }
    if (entry.kind === "planner_invalid_action") continue;
    break;
  }

  return count;
}

function readSessionContext$1(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return null;
  }

  return request.sessionContext && typeof request.sessionContext === "object" && !Array.isArray(request.sessionContext)
    ? request.sessionContext
    : null;
}

function createSessionContextView$1(sessionContext) {
  return {
    clarificationStatus: readString$f(sessionContext.clarificationStatus),
    currentGoal: readString$f(sessionContext.currentGoal),
    currentTopic: readString$f(sessionContext.currentTopic),
    lastResolution: cloneStructuredValue(sessionContext.lastResolution),
    openAmbiguity: readString$f(sessionContext.openAmbiguity)
  };
}

function readString$f(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cloneStructuredValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : null;
}

function clearApprovalResolutionRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return;
  }

  if (request.type === "approval_resolution") {
    request.type = null;
  }
}

export { runApprovalResolution };
