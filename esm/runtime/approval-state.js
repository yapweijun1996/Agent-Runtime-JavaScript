import { cloneValue } from './utils.js';
import { projectSessionContextFromPlannerState } from './session-context-projection.js';
import { createContextSnapshot } from '../session/context-snapshot-normalize.js';
import { readString } from './semantic-json.js';
import { projectSessionContextFromSnapshot } from '../session/context-snapshot-projection.js';
import { stripSigningMeta } from './approval-signing.js';

function isApprovalResolutionRequest(rawInput) {
  return Boolean(
    rawInput &&
    typeof rawInput === "object" &&
    !Array.isArray(rawInput) &&
    rawInput.type === "approval_resolution"
  );
}

async function normalizeApprovalResolutionInput(rawInput, options) {
  if (!isApprovalResolutionRequest(rawInput)) {
    throw new Error('Expected request type "approval_resolution".');
  }

  const decision = readResolutionDecision(rawInput.decision);
  if (!decision) {
    throw new Error('Approval resolution requires decision "approve" or "deny".');
  }

  const signer = options && options.signer ? options.signer : null;
  const enforceSessionBinding = !!(options && options.enforceSessionBinding);
  const rawToken = rawInput.resumeToken;

  if (signer) {
    if (!rawToken || typeof rawToken !== "object" || Array.isArray(rawToken)) {
      throw new Error("Approval resumeToken is invalid.");
    }
    const verification = await signer.verify(rawToken);
    if (!verification.ok) {
      throw new Error(`Approval resumeToken rejected: ${verification.reason}.`);
    }
    if (enforceSessionBinding) {
      const claimedSessionId = readString(rawToken.sessionId);
      const providedSessionId = readString(rawInput.agrunSessionId);
      if (claimedSessionId && providedSessionId && claimedSessionId !== providedSessionId) {
        throw new Error("Approval resumeToken session binding mismatch.");
      }
    }
  }

  const strippedToken = signer ? stripSigningMeta(rawToken) : rawToken;
  const resumeToken = readResumeToken(strippedToken);
  if (!resumeToken) {
    throw new Error("Approval resolution requires a valid resumeToken.");
  }

  return {
    decision,
    resumeToken
  };
}

function createPendingApproval(options) {
  const {
    actionHistory,
    actionName,
    decision,
    policy,
    rawInput,
    request,
    runState
  } = options;
  const reason = `Action "${actionName}" requires approval.`;
  const resumable = policy === "ask";
  const sessionId = readString(rawInput && rawInput.agrunSessionId) || readString(request && request.agrunSessionId);
  const projectedContextSnapshot = runState && runState.contextSnapshot
    ? createContextSnapshot(runState.contextSnapshot)
    : request && request.contextSnapshot
      ? createContextSnapshot(request.contextSnapshot)
      : null;
  const projectedSessionContext = projectSessionContextFromPlannerState(
    projectedContextSnapshot
      ? projectSessionContextFromSnapshot(projectedContextSnapshot)
      : request && request.sessionContext,
    runState && runState.plannerState
  );
  const sessionContextMode = sessionId
    ? "session_store"
    : projectedSessionContext || projectedContextSnapshot
      ? "token_fallback"
      : null;

  return {
    actionName,
    policy,
    reason,
    resumable,
    resolution: "pending",
    resumeToken: {
      actionHistory: cloneValue(Array.isArray(actionHistory) ? actionHistory : []),
      actionName,
      agentSkillContext: cloneValue(runState.agentSkillContext),
      cycleCount: runState.cycleCount,
      decision: cloneValue(normalizeResumeDecision(decision, actionName)),
      plannerInvalidCount: runState.plannerInvalidCount,
      policy,
      reason,
      request: createResumeRequest(rawInput, request, projectedSessionContext, projectedContextSnapshot),
      stepCount: runState.stepCount,
      turnControl: cloneValue(runState.turnControl || null),
      turnCount: runState.turnCount,
      actionPatternConvergence: cloneValue(runState.actionPatternConvergence || null),
      terminalRepairState: cloneValue(runState.terminalRepairState || null),
      invalidActionConvergence: cloneValue(runState.invalidActionConvergence || null),
      researchContext: cloneValue(runState.researchContext),
      researchEvidenceGraph: cloneValue(runState.researchEvidenceGraph || null),
      researchAcceptanceEvaluator: cloneValue(runState.researchAcceptanceEvaluator || null),
      requirementRecoveryEvaluator: cloneValue(runState.requirementRecoveryEvaluator || null),
      researchWorkspace: cloneValue(runState.researchWorkspace || null),
      researchReportLoop: cloneValue(runState.researchReportLoop || null),
      candidatePathMismatchSignal: cloneValue(runState.candidatePathMismatchSignal || null),
      virtualWorkspace: cloneValue(runState.virtualWorkspace || null),
      sessionContextMode,
      sessionId: sessionId || null,
      todoState: cloneValue(runState.todoState || null),
      toolContext: cloneValue(runState.toolContext),
      resumable
    }
  };
}

function normalizePendingApproval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const actionName = readString(value.actionName);
  const policy = readPolicy$1(value.policy);
  const resolution = readResolution(value.resolution) || "pending";
  const resumeToken = readResumeToken(value.resumeToken);

  if (!actionName || !policy || !resumeToken) {
    return null;
  }

  return {
    actionName,
    policy,
    reason: readString(value.reason) || `Action "${actionName}" requires approval.`,
    resumable: value.resumable === true,
    resolution,
    resumeToken
  };
}

function restoreApprovalRequest(resumeToken, overrides) {
  const source = readResumeToken(resumeToken);

  if (!source) {
    throw new Error("Approval resumeToken is invalid.");
  }

  const sourceRequest = cloneValue(source.request);
  const authMode = readOptionalAuthMode(overrides.authMode) || readAuthMode$2(sourceRequest.authMode);
  const isServerAuth = authMode === "server";

  return {
    ...sourceRequest,
    agrunSessionId: readString(overrides.agrunSessionId) || readString(source.sessionId) || null,
    // AGRUN-523 — the resume token no longer carries the provider apiKey (it is
    // redacted at handlePolicyBlock before signing), so resume now REQUIRES the
    // host to re-supply the credential via overrides. Do NOT fall back to
    // sourceRequest.apiKey: post-redaction it is the literal "[redacted]"
    // placeholder, which must never be forwarded to a provider.
    apiKey: isServerAuth ? null : readString(overrides.apiKey) || null,
    authMode,
    cachedContentMode: readCachedContentMode$1(overrides.cachedContentMode) || readCachedContentMode$1(sourceRequest.cachedContentMode) || (isServerAuth ? "disabled" : "client"),
    endpoint: readString(overrides.endpoint) || readString(sourceRequest.endpoint) || null,
    fetch: typeof overrides.fetch === "function" ? overrides.fetch : null,
    streamEndpoint: readString(overrides.streamEndpoint) || readString(sourceRequest.streamEndpoint) || null
  };
}

function createResumeRequest(rawInput, request, projectedSessionContext, contextSnapshot) {
  const webSearchEndpoint = rawInput && typeof rawInput === "object" && typeof rawInput.webSearchEndpoint === "string"
    ? rawInput.webSearchEndpoint.trim()
    : null;
  const webSearchAuthMode = rawInput && typeof rawInput === "object" && typeof rawInput.webSearchAuthMode === "string"
    ? rawInput.webSearchAuthMode.trim()
    : null;
  const agrunSessionId = readString(rawInput && rawInput.agrunSessionId) || readString(request && request.agrunSessionId);
  const authMode = readAuthMode$2(request && request.authMode);
  const isServerAuth = authMode === "server";

  return {
    apiKey: isServerAuth ? null : request.apiKey || null,
    agrunSessionId: agrunSessionId || null,
    authMode,
    cachedContentMode: readCachedContentMode$1(request && request.cachedContentMode) || (isServerAuth ? "disabled" : "client"),
    contextSnapshot: contextSnapshot ? cloneValue(contextSnapshot) : cloneSessionContext(request.contextSnapshot),
    endpoint: request.endpoint || null,
    model: request.model,
    prompt: request.prompt,
    provider: request.provider,
    sessionContext: cloneSessionContext(projectedSessionContext || request.sessionContext),
    streamEndpoint: request.streamEndpoint || null,
    systemPrompt: request.systemPrompt || null,
    searchProvider: request.searchProvider || null,
    webSearchAuthMode: webSearchAuthMode || request.webSearchAuthMode || null,
    webSearchEndpoint: webSearchEndpoint || request.webSearchEndpoint || null,
    webSearchModel: request.webSearchModel || null
  };
}

function normalizeResumeDecision(decision, actionName) {
  if (decision && typeof decision === "object" && !Array.isArray(decision)) {
    if (decision.type === "clarify" && readString(decision.question)) {
      return {
        question: decision.question.trim(),
        type: "clarify"
      };
    }

    if (decision.type === "action") {
      return {
        args: decision.args && typeof decision.args === "object" && !Array.isArray(decision.args)
          ? cloneValue(decision.args)
          : {},
        name: readString(decision.name) || actionName,
        type: "action"
      };
    }
  }

  return {
    args: {},
    name: actionName,
    type: "action"
  };
}

function readResumeToken(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const actionName = readString(value.actionName);
  const policy = readPolicy$1(value.policy);
  const request = value.request && typeof value.request === "object" && !Array.isArray(value.request)
    ? cloneValue(value.request)
    : null;

  if (!actionName || !policy || !request) {
    return null;
  }

  return {
    actionHistory: Array.isArray(value.actionHistory) ? cloneValue(value.actionHistory) : [],
    actionName,
    agentSkillContext: value.agentSkillContext && typeof value.agentSkillContext === "object" && !Array.isArray(value.agentSkillContext)
      ? cloneValue(value.agentSkillContext)
      : null,
    cycleCount: typeof value.cycleCount === "number" ? value.cycleCount : 0,
    decision: value.decision && typeof value.decision === "object" && !Array.isArray(value.decision)
      ? cloneValue(value.decision)
      : null,
    plannerInvalidCount: typeof value.plannerInvalidCount === "number" ? value.plannerInvalidCount : 0,
    policy,
    reason: readString(value.reason),
    request,
    stepCount: typeof value.stepCount === "number" ? value.stepCount : 0,
    turnControl: cloneRecordOrNull$1(value.turnControl),
    turnCount: typeof value.turnCount === "number" ? value.turnCount : 0,
    actionPatternConvergence: cloneRecordOrNull$1(value.actionPatternConvergence),
    terminalRepairState: cloneRecordOrNull$1(value.terminalRepairState),
    invalidActionConvergence: cloneRecordOrNull$1(value.invalidActionConvergence),
    researchContext: value.researchContext && typeof value.researchContext === "object" && !Array.isArray(value.researchContext)
      ? cloneValue(value.researchContext)
      : null,
    researchEvidenceGraph: cloneRecordOrNull$1(value.researchEvidenceGraph),
    researchAcceptanceEvaluator: cloneRecordOrNull$1(value.researchAcceptanceEvaluator),
    requirementRecoveryEvaluator: cloneRecordOrNull$1(value.requirementRecoveryEvaluator),
    researchWorkspace: cloneRecordOrNull$1(value.researchWorkspace),
    researchReportLoop: cloneRecordOrNull$1(value.researchReportLoop),
    candidatePathMismatchSignal: cloneRecordOrNull$1(value.candidatePathMismatchSignal),
    virtualWorkspace: cloneRecordOrNull$1(value.virtualWorkspace),
    sessionContextMode: readSessionContextMode(value.sessionContextMode),
    sessionId: readString(value.sessionId) || null,
    todoState: value.todoState && typeof value.todoState === "object" && !Array.isArray(value.todoState)
      ? cloneValue(value.todoState)
      : null,
    toolContext: value.toolContext && typeof value.toolContext === "object" && !Array.isArray(value.toolContext)
      ? cloneValue(value.toolContext)
      : null,
    resumable: value.resumable === true
  };
}

function cloneRecordOrNull$1(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function readPolicy$1(value) {
  return value === "allow" || value === "ask" || value === "deny"
    ? value
    : "";
}

function readResolution(value) {
  return value === "approved" || value === "denied" || value === "pending"
    ? value
    : "";
}

function cloneSessionContext(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function readSessionContextMode(value) {
  return value === "session_store" || value === "token_fallback"
    ? value
    : null;
}

function readResolutionDecision(value) {
  return value === "approve" || value === "deny"
    ? value
    : "";
}

function readAuthMode$2(value) {
  return value === "server" ? "server" : "client";
}

function readOptionalAuthMode(value) {
  return value === "server" || value === "client" ? value : "";
}

function readCachedContentMode$1(value) {
  return value === "disabled" || value === "client" || value === "server"
    ? value
    : "";
}

export { createPendingApproval, isApprovalResolutionRequest, normalizeApprovalResolutionInput, normalizePendingApproval, restoreApprovalRequest };
