import { createPendingApproval } from './approval-state.js';
import { recordObservation, startEvaluatePhase, completeEvaluatePhase, finishRun } from './finalizer.js';
import { completePhase } from './oodae.js';
import { createEvaluationState } from './task-state.js';
import { syncPromptInquiryContext } from './inquiry-context-resolution.js';
import { setTurnStateStatus } from './turn-state.js';
import { createTurnControl, TURN_SIGNALS, applyTurnControl } from './turn-signal.js';
import { cloneValue } from './utils.js';
import { reconcileCitations, appendSourcesSection, collectResearchEvidenceUrls, collectFinalResponseSources, filterSourcesByEvidence } from './final-response-sources.js';
import { normalizeFinalAnswerInternalProgress } from './final-answer-internal-progress.js';
import { normalizeFinalResponseStructure } from './final-response-quality.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { attachClaimCoverageToResearchWorkspace } from './claim-coverage.js';
import { observeTodoStateOnTerminal } from './todo-state-finalize-sync.js';
import { applyTerminalFinalContract } from './terminal-final-contract.js';
import { projectTodoRunState, projectTerminalRunState } from './run-state-projections.js';

function readScopedEvidenceUrls$1(runState, terminalProjection = projectTerminalRunState(runState)) {
  if (!runState || typeof runState !== "object") return null;
  const list = runState.scopedEvidenceUrls;
  const scopedUrls = Array.isArray(list) ? list : null;
  const researchUrls = collectResearchEvidenceUrls(terminalProjection.researchContext);

  if (scopedUrls && scopedUrls.length === 0 && !isResearchEvidenceLoopActive$1(terminalProjection)) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  if (!scopedUrls) {
    return researchUrls.length > 0 ? researchUrls : null;
  }

  return scopedUrls;
}

function collectScopedFinalResponseSources$1(runState, request, terminalProjection = projectTerminalRunState(runState)) {
  if (shouldSuppressResearchLoopSources(terminalProjection)) {
    return { citations: [], sources: [] };
  }
  const scopedUrls = readScopedEvidenceUrls$1(runState, terminalProjection);
  const sourceLimit = Array.isArray(scopedUrls) ? Math.max(3, scopedUrls.length) : undefined;
  const raw = collectFinalResponseSources(terminalProjection.researchContext, sourceLimit, {
    prompt: readFinalSourcePrompt(runState, request)
  });
  return filterSourcesByEvidence(raw, scopedUrls);
}

function shouldSuppressResearchLoopSources(terminalProjection) {
  const projection = terminalProjection && typeof terminalProjection === "object" ? terminalProjection : {};
  const loop = projection.researchReportLoop && typeof projection.researchReportLoop === "object"
    ? projection.researchReportLoop
    : null;
  if (!loop || loop.finalMode !== "final_with_limitations") return false;
  const graph = projection.researchEvidenceGraph && typeof projection.researchEvidenceGraph === "object"
    ? projection.researchEvidenceGraph
    : null;
  const observations = Array.isArray(graph && graph.observations) ? graph.observations : [];
  const sourceArtifacts = Array.isArray(graph && graph.sourceArtifacts) ? graph.sourceArtifacts : [];
  const evidenceUrls = collectResearchEvidenceUrls(projection.researchContext);
  return observations.length === 0 && sourceArtifacts.length === 0 && evidenceUrls.length === 0;
}

function isResearchEvidenceLoopActive$1(terminalProjection) {
  const projection = terminalProjection && typeof terminalProjection === "object" ? terminalProjection : {};
  const loop = projection.researchReportLoop && typeof projection.researchReportLoop === "object"
    ? projection.researchReportLoop
    : null;
  if (!loop) return false;
  const status = readString$16(loop.status);
  return loop.enabled === true || Boolean(readString$16(loop.finalMode)) || Boolean(status && status !== "idle");
}

function normalizeTerminalFinalText(rawText, runState, request, options = {}) {
  const prompt = readFinalSourcePrompt(runState, request);
  const sourceText = rawText;
  const terminalProjection = projectTerminalRunState(runState);
  const evidenceSources = collectTerminalFinalSources(runState, request, terminalProjection);
  const normalizedTextBeforeContract = appendSourcesSection(
    normalizeFinalAnswerInternalProgress(
      normalizeFinalResponseStructure(sourceText, { prompt }),
      {
        prompt,
        researchEvidenceGraph: terminalProjection.researchEvidenceGraph,
        researchState: terminalProjection.researchState,
        researchWorkspace: terminalProjection.researchWorkspace,
        researchReportLoop: terminalProjection.researchReportLoop,
        virtualWorkspace: terminalProjection.virtualWorkspace,
        todoState: terminalProjection.todoState
      }
    ),
    evidenceSources.sources
  );
  const contractResult = applyTerminalFinalContract({
    finalReadiness: options.finalReadiness || null,
    pushStep: options.pushStep,
    request,
    runState,
    source: options.source,
    text: normalizedTextBeforeContract
  });
  const normalizedText = contractResult.text;
  attachClaimCoverageToResearchWorkspace(runState, normalizedText, { prompt });
  return {
    citations: evidenceSources.citations,
    compiled: null,
    prompt,
    terminalContractAudit: contractResult.audit,
    text: normalizedText
  };
}

function collectTerminalFinalSources(runState, request, terminalProjection = projectTerminalRunState(runState)) {
  if (shouldSuppressResearchLoopSources(terminalProjection)) {
    return { citations: [], sources: [] };
  }
  if (terminalProjection.researchEvidenceGraph) {
    const graphSources = createCompiledReportSourcePayload(terminalProjection.researchEvidenceGraph);
    if (graphSources.sources.length > 0) return graphSources;
  }
  return collectScopedFinalResponseSources$1(runState, request, terminalProjection);
}

function createCompiledReportSourcePayload(graph) {
  // AGRUN-313 2.2 — read the pre-computed projection off the graph slot (set by the
  // research-internal materializeEvidenceGraph) instead of importing the collector.
  const sourceArtifacts = graph && Array.isArray(graph.compiledReportSources)
    ? graph.compiledReportSources
    : [];
  const sources = [];
  const seenUrls = new Set();
  for (const source of sourceArtifacts) {
    const url = readString$16(source && source.url);
    if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    sources.push({
      kind: "research_evidence_graph",
      title: readString$16(source && source.title) || url,
      url
    });
    if (sources.length >= 8) break;
  }
  return {
    citations: sources.map((source) => source.url),
    sources
  };
}

function readString$16(value) {
  return typeof value === "string" ? value.trim() : "";
}

function handlePlannerFinal(options) {
  const {
    cycleRecord,
    decision,
    memoryEntriesAdded,
    normalizedInput,
    pushStep,
    rawInput,
    request,
    response,
    runState,
    runtimeState,
    steps
  } = options;
  const plannerCitations = Array.isArray(decision.citations) ? decision.citations : [];
  const terminalText = normalizeTerminalFinalText(decision.answer, runState, request, {
    finalReadiness: decision && decision.finalReadiness,
    pushStep,
    source: "planner_final"
  });
  const output = {
    citations: reconcileCitations(plannerCitations, terminalText.citations),
    endpoint: response.endpoint,
    failedTools: Array.isArray(runState.failedTools) && runState.failedTools.length > 0
      ? cloneValue(runState.failedTools) : [],
    finishReason: response.finishReason,
    kind: "planner_final",
    model: request.model,
    provider: request.provider,
    raw: response.raw,
    requestBody: response.requestBody,
    status: response.status,
    terminalContractAudit: terminalText.terminalContractAudit,
    text: terminalText.text,
    usage: response.usage
  };

  syncPromptInquiryContext(runState, request);
  runState.usedRuntimeFinalize = false;
  runState.terminalizedBy = "planner_final";
  if (observeTodoStateOnTerminal(runState, { source: "planner_final" })) {
    const todoProjection = projectTodoRunState(runState);
    pushStep("todo-state-terminal-observed", {
      cycle: runState.cycleCount,
      observation: todoProjection.todoTerminalObservation,
      source: "planner_final"
    });
  }
  completeTerminalAction({
    cycleRecord,
    output,
    pushStep,
    runState,
    actionName: null,
    finalAnswerSource: "planner",
    observation: {
      kind: "success",
      output: cloneValue(output),
      source: "planner"
    },
    observationStep: {
      cycle: runState.cycleCount,
      kind: "success",
      source: "planner"
    }
  });

  return finishRun({
    rawInput,
    normalizedInput,
    runState,
    output,
    memoryEntriesAdded,
    steps,
    runtimeState
  });
}

function handleRuntimeFinalize(options) {
  const {
    cycleRecord,
    decision,
    memoryEntriesAdded,
    normalizedInput,
    pushStep,
    rawInput,
    request,
    response,
    runState,
    runtimeState,
    steps
  } = options;
  // ADR-0025 — distinguish AI-driven planner_finalize from runtime-forced
  // runtime_finalize. Default is "runtime_finalize" for safety; AI-driven
  // callers (handlePlannerFinalizeDecision, executePlan plan-finalize) pass
  // "planner_finalize" so telemetry can tell push from pull.
  const terminalSource = typeof options.terminalSource === "string" && options.terminalSource.length > 0
    ? options.terminalSource
    : "runtime_finalize";
  const terminalText = normalizeTerminalFinalText(response.text, runState, request, {
    finalReadiness: decision && decision.finalReadiness,
    pushStep,
    source: terminalSource
  });
  const output = {
    citations: terminalText.citations,
    endpoint: response.endpoint,
    failedTools: Array.isArray(runState.failedTools) && runState.failedTools.length > 0
      ? cloneValue(runState.failedTools) : [],
    finishReason: response.finishReason,
    kind: "final_response",
    model: request.model,
    provider: request.provider,
    raw: response.raw,
    requestBody: response.requestBody,
    status: response.status,
    terminalContractAudit: terminalText.terminalContractAudit,
    text: terminalText.text,
    usage: response.usage
  };

  syncPromptInquiryContext(runState, request);
  runState.usedRuntimeFinalize = true;
  // ADR-0028 — `summarize_limits` overlay removed. Both AI-driven
  // (planner_finalize) and runtime-pushed (runtime_finalize) sources
  // surface as their literal label without runtime override.
  runState.terminalizedBy = terminalSource;
  const beforeTodoProjection = projectTodoRunState(runState);
  const beforeTodoState = beforeTodoProjection.todoState;
  const beforeStatuses = beforeTodoState && Array.isArray(beforeTodoState.items)
    ? beforeTodoState.items.map((i) => i && i.status)
    : null;
  const beforeStatus = beforeTodoState && beforeTodoState.status;
  const observed = observeTodoStateOnTerminal(runState, { source: terminalSource });
  const afterTodoProjection = projectTodoRunState(runState);
  const afterTodoState = afterTodoProjection.todoState;
  pushStep("todo-state-terminal-observed", {
    afterStatus: afterTodoState && afterTodoState.status,
    afterItemStatuses: afterTodoState && Array.isArray(afterTodoState.items)
      ? afterTodoState.items.map((i) => i && i.status)
      : null,
    beforeItemStatuses: beforeStatuses,
    beforeStatus,
    cycle: runState.cycleCount,
    fired: observed,
    observation: afterTodoProjection.todoTerminalObservation,
    source: terminalSource,
    threadId: runState.threadId || null,
    todoStateExists: Boolean(afterTodoState)
  });
  completeTerminalAction({
    cycleRecord,
    output,
    pushStep,
    runState,
    actionName: "finalize",
    finalAnswerSource: terminalSource,
    observation: {
      instruction: decision && typeof decision.instruction === "string" ? decision.instruction : null,
      kind: "success",
      output: cloneValue(output),
      source: terminalSource
    },
    observationStep: {
      cycle: runState.cycleCount,
      kind: "success",
      source: terminalSource
    }
  });

  return finishRun({
    rawInput,
    normalizedInput,
    runState,
    output,
    memoryEntriesAdded,
    steps,
    runtimeState
  });
}

function handleDirectFinal(options) {
  const {
    cycleRecord,
    directFinal,
    memoryEntriesAdded,
    normalizedInput,
    onToken,
    pushStep,
    rawInput,
    request,
    runState,
    runtimeState,
    steps,
    toolResult
  } = options;
  const terminalText = normalizeTerminalFinalText(directFinal.text, runState, request, {
    pushStep,
    source: "direct_final"
  });
  const output = {
    citations: terminalText.citations,
    endpoint: request.endpoint || null,
    failedTools: Array.isArray(runState.failedTools) && runState.failedTools.length > 0
      ? cloneValue(runState.failedTools) : [],
    finishReason: null,
    kind: "final_response",
    model: request.model || null,
    provider: request.provider || null,
    raw: null,
    requestBody: null,
    status: null,
    terminalContractAudit: terminalText.terminalContractAudit,
    text: terminalText.text,
    usage: null
  };

  if (typeof onToken === "function") {
    onToken(output.text);
  }

  pushStep("direct-final-emitted", {
    reason: "direct-emit-final",
    skill: toolResult && typeof toolResult.skill === "string" ? toolResult.skill : null,
    tool: toolResult && typeof toolResult.tool === "string" ? toolResult.tool : null
  });

  syncPromptInquiryContext(runState, request);
  runState.usedRuntimeFinalize = false;
  runState.terminalizedBy = "direct_final";
  if (observeTodoStateOnTerminal(runState, { source: "direct_final" })) {
    const todoProjection = projectTodoRunState(runState);
    pushStep("todo-state-terminal-observed", {
      cycle: runState.cycleCount,
      observation: todoProjection.todoTerminalObservation,
      source: "direct_final"
    });
  }
  completeTerminalAction({
    cycleRecord,
    output,
    pushStep,
    runState,
    actionName: "execute_skill_tool",
    finalAnswerSource: "direct_final",
    observation: {
      kind: "success",
      output: cloneValue(output),
      source: "direct_final"
    },
    observationStep: {
      cycle: runState.cycleCount,
      kind: "success",
      source: "direct_final"
    }
  });

  return finishRun({
    rawInput,
    normalizedInput,
    runState,
    output,
    memoryEntriesAdded,
    steps,
    runtimeState
  });
}

async function handlePolicyBlock(options) {
  const {
    actionName,
    actionHistory,
    cycleRecord,
    decision,
    memoryEntriesAdded,
    normalizedInput,
    policyDecision,
    pushStep,
    rawInput,
    request,
    runState,
    runtimeConfig,
    runtimeState,
    steps
  } = options;
  const pendingApproval = createPendingApproval({
    actionHistory,
    actionName,
    decision,
    policy: policyDecision.action,
    rawInput,
    request,
    runState
  });
  const interruptionTurnControl = createTurnControl({
    actionName,
    cycle: runState.cycleCount,
    observation: {
      actionName,
      kind: "blocked",
      policy: policyDecision.action
    },
    pendingApproval,
    signal: TURN_SIGNALS.INTERRUPTION,
    source: "policy"
  });
  if (pendingApproval && pendingApproval.resumeToken) {
    pendingApproval.resumeToken.turnControl = cloneValue(interruptionTurnControl);
  }

  const signer = runtimeConfig && runtimeConfig.approvalSigner;
  if (signer && pendingApproval && pendingApproval.resumeToken) {
    pendingApproval.resumeToken = await signer.sign(pendingApproval.resumeToken);
  }

  const output = {
    kind: "approval_required",
    pendingApproval,
    text: `Approval required before running ${actionName}.`
  };

  runState.status = "blocked";
  setTurnStateStatus(runState.turnState, "blocked_on_approval");
  runState.pendingApproval = cloneValue(output.pendingApproval);
  runState.lastAction = actionName;
  runState.finalAnswerSource = "policy";
  runState.actState = {
    actionName,
    control: "blocked",
    outputKind: "approval_required"
  };
  pushStep("policy-blocked", {
    actionName,
    policy: policyDecision.action,
    resumable: pendingApproval ? pendingApproval.resumable === true : false,
    tier: policyDecision.tier
  });
  pushStep("next_step_interruption", {
    actionName,
    cycle: runState.cycleCount,
    pendingApproval: cloneValue(interruptionTurnControl && interruptionTurnControl.pendingApproval),
    signal: TURN_SIGNALS.INTERRUPTION,
    source: "policy"
  });
  recordObservation(
    runState,
    pushStep,
    {
      actionName,
      kind: "blocked",
      policy: policyDecision.action
    },
    {
      actionName,
      cycle: runState.cycleCount,
      kind: "blocked"
    }
  );
  applyTurnControl(runState, {
    ...interruptionTurnControl,
    output: {
      kind: output.kind,
      text: output.text
    }
  });
  completePhase(
    cycleRecord,
    pushStep,
    "act",
    {
      actionName,
      approvalStatus: policyDecision.action,
      outcome: "blocked",
      resultKind: "blocked"
    }
  );
  startEvaluatePhase(runState, pushStep, null);
  runState.evaluationState = createEvaluationState({
    actionName,
    nextState: "await_approval",
    outcome: "blocked",
    plannerState: runState.plannerState,
    sessionContext: request && request.sessionContext,
    turnState: runState.turnState,
    toolContext: runState.toolContext
  });
  completeEvaluatePhase(cycleRecord, pushStep, {
    blockedByPolicy: policyDecision.action,
    evaluationState: cloneValue(runState.evaluationState),
    nextPromptState: "await_approval",
    observationKind: runState.observation.kind,
    outcome: "blocked"
  });

  return finishRun({
    rawInput,
    normalizedInput,
    runState,
    output,
    memoryEntriesAdded,
    steps,
    runtimeState
  });
}

function completeTerminalAction(options) {
  const {
    cycleRecord,
    output,
    pushStep,
    runState,
    actionName,
    finalAnswerSource,
    observation,
    observationStep
  } = options;

  runState.status = "completed";
  if (!runState.turnState || runState.turnState.status !== "ready_to_answer") {
    setTurnStateStatus(runState.turnState, "done");
  }
  runState.finalAnswerSource = finalAnswerSource;
  runState.lastAction = actionName;
  runState.actState = {
    actionName,
    control: "complete",
    outputKind: output.kind || "object"
  };
  recordObservation(runState, pushStep, observation, observationStep);
  completePhase(
    cycleRecord,
    pushStep,
    "act",
    {
      actionName,
      approvalStatus: null,
      outcome: "executed",
      resultKind: "complete"
    }
  );
  startEvaluatePhase(runState, pushStep, null);
  runState.evaluationState = createEvaluationState({
    actionName: actionName || finalAnswerSource,
    nextState: "stop",
    outcome: "complete",
    plannerState: runState.plannerState,
    sessionContext: options.request && options.request.sessionContext,
    turnState: runState.turnState,
    toolContext: runState.toolContext
  });
  completeEvaluatePhase(cycleRecord, pushStep, {
    evaluationState: cloneValue(runState.evaluationState),
    nextPromptState: "stop",
    observationKind: runState.observation.kind,
    outcome: "complete",
    outputKind: output.kind
  });
}

export { handleDirectFinal, handlePlannerFinal, handlePolicyBlock, handleRuntimeFinalize };
