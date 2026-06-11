import { projectCostLedger } from './cost-ledger.js';
import { projectTodoTaskLifecycle } from './todo-task-lifecycle.js';
import { projectTurnControl } from './turn-signal.js';
import { cloneValue } from './utils.js';

function createRunKernelState(runId, maxSteps, lineage) {
  const sessionId = readLineageId(lineage, "sessionId");
  const parentSessionId = readLineageId(lineage, "parentSessionId");
  return {
    runId,
    status: "running",
    mode: "skill_loop",
    threadId: null,
    // AGRUN-240-followup — session lineage available throughout the run
    // (not only projected onto result.runState after the loop returns).
    // Lets pushStep/event-ledger tag every event with its owning session
    // and the spawning parent session, enabling orchestrator-worker task
    // tree rendering in the inspector.
    sessionId,
    parentSessionId,
    scopedEvidenceUrls: null,
    stepCount: 0,
    cycleCount: 0,
    turnCount: 0,
    maxSteps,
    phase: null,
    turnControl: null,
    continuingInterruptedTurn: false,
    executionClass: null,
    terminalizedBy: null,
    usedRuntimeFinalize: false,
    finalAnswerSource: null,
    lastPlannerFinalText: null,
    error: null
  };
}

function readLineageId(lineage, key) {
  if (!lineage || typeof lineage !== "object") return null;
  const value = lineage[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function projectRunKernelState(runState) {
  const source = runState && typeof runState === "object" ? runState : {};
  return {
    runId: source.runId,
    sessionId: typeof source.sessionId === "string" ? source.sessionId : null,
    parentSessionId: typeof source.parentSessionId === "string" ? source.parentSessionId : null,
    status: source.status,
    stepCount: source.stepCount,
    cycleCount: source.cycleCount,
    mode: source.mode,
    turnCount: source.turnCount,
    maxSteps: source.maxSteps,
    phase: source.phase,
    turnControl: projectTurnControl(source.turnControl),
    continuingInterruptedTurn: source.continuingInterruptedTurn === true,
    executionClass: cloneValue(source.executionClass),
    terminalizedBy: cloneValue(source.terminalizedBy),
    usedRuntimeFinalize: source.usedRuntimeFinalize === true,
    finalAnswerSource: source.finalAnswerSource,
    runtimeBuildId: source.runtimeBuildId,
    error: cloneValue(source.error)
  };
}

function projectApprovalRunState(runState) {
  const source = runState && typeof runState === "object" ? runState : {};
  return {
    pendingApproval: cloneValue(source.pendingApproval),
    controlEnvelopeKind: cloneValue(source.controlEnvelopeKind),
    controlEnvelopeConsumed: source.controlEnvelopeConsumed === true,
    requestTypeAfterApproval: cloneValue(source.requestTypeAfterApproval),
    approvalResumeFallbackUsed: source.approvalResumeFallbackUsed === true
  };
}

function projectResearchRunState(runState) {
  const source = runState && typeof runState === "object" ? runState : {};
  return {
    researchState: cloneValue(source.researchState),
    researchContext: cloneValue(source.researchContext),
    readinessContinuationSignal: cloneValue(source.readinessContinuationSignal || null),
    readinessConflictContinuationSignal: cloneValue(source.readinessConflictContinuationSignal || null),
    researchFinalizeContract: cloneValue(source.researchFinalizeContract || null),
    terminalFinalContract: cloneValue(source.terminalFinalContract || null),
    terminalFinalContractAudits: cloneValue(source.terminalFinalContractAudits || []),
    researchEvidenceGraph: cloneValue(source.researchEvidenceGraph),
    researchWorkspace: cloneValue(source.researchWorkspace),
    researchReportLoop: cloneValue(source.researchReportLoop),
    researchAcceptanceEvaluator: cloneValue(source.researchAcceptanceEvaluator || null),
    requirementRecoveryEvaluator: cloneValue(source.requirementRecoveryEvaluator || null),
    candidatePathMismatchSignal: cloneValue(source.candidatePathMismatchSignal || null)
  };
}

function projectWorkspaceRunState(runState) {
  const source = runState && typeof runState === "object" ? runState : {};
  return {
    virtualWorkspace: cloneValue(source.virtualWorkspace)
  };
}

function projectTodoRunState(runState) {
  const source = runState && typeof runState === "object" ? runState : {};
  return {
    todoState: cloneValue(source.todoState || null),
    todoTerminalObservation: cloneValue(source.todoTerminalObservation || null),
    todoTask: projectTodoTaskLifecycle(source)
  };
}

function projectTerminalRunState(runState) {
  const researchProjection = projectResearchRunState(runState);
  const workspaceProjection = projectWorkspaceRunState(runState);
  const todoProjection = projectTodoRunState(runState);
  return {
    researchContext: researchProjection.researchContext,
    researchEvidenceGraph: researchProjection.researchEvidenceGraph,
    researchReportLoop: researchProjection.researchReportLoop,
    researchState: researchProjection.researchState,
    researchWorkspace: researchProjection.researchWorkspace,
    todoState: todoProjection.todoState,
    virtualWorkspace: workspaceProjection.virtualWorkspace
  };
}

function projectMetricsRunState(runState) {
  const source = runState && typeof runState === "object" ? runState : {};
  const costLedger = source.costLedger
    && typeof source.costLedger === "object"
    && Array.isArray(source.costLedger.entries)
    ? source.costLedger
    : null;
  return {
    usableReadSourceCount: source.usableReadSourceCount,
    strongReadSourceCount: source.strongReadSourceCount,
    readAttemptSignal: cloneValue(source.readAttemptSignal || null),
    readUrlRecoverySignal: cloneValue(source.readUrlRecoverySignal || null),
    metrics: cloneValue(source.metrics),
    costLedger: projectCostLedger(costLedger),
    actionGuardrail: cloneValue(source.actionGuardrail || null),
    actionPatternConvergence: cloneValue(source.actionPatternConvergence || null),
    terminalRepairState: cloneValue(source.terminalRepairState || null),
    invalidActionConvergence: cloneValue(source.invalidActionConvergence || null)
  };
}

export { createRunKernelState, projectApprovalRunState, projectMetricsRunState, projectResearchRunState, projectRunKernelState, projectTerminalRunState, projectTodoRunState, projectWorkspaceRunState };
