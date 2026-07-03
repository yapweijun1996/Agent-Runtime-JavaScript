import { createPendingApproval } from './approval-state.js';
import { readString } from './semantic-json.js';
import { redactSecretFields } from './secret-redaction.js';
import { recordObservation, startEvaluatePhase, completeEvaluatePhase, finishRun } from './finalizer.js';
import { completePhase } from './oodae.js';
import { createEvaluationState } from './task-state.js';
import { syncPromptInquiryContext } from './inquiry-context-resolution.js';
import { setTurnStateStatus } from './turn-state.js';
import { createTurnControl, TURN_SIGNALS, applyTurnControl } from './turn-signal.js';
import { cloneValue } from './utils.js';
import { ERROR_CODES } from './errors.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from './workspace-candidate-lifecycle.js';
import { isResearchQualityGateRequired } from './convergence-activation.js';
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
    prompt: readFinalSourcePrompt(runState, request),
    requireReadEvidence: isResearchQualityGateRequired(runState)
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
  const status = readString(loop.status);
  return loop.enabled === true || Boolean(readString(loop.finalMode)) || Boolean(status && status !== "idle");
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
    const url = readString(source && source.url);
    if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    sources.push({
      kind: "research_evidence_graph",
      title: readString(source && source.title) || url,
      url
    });
    if (sources.length >= 8) break;
  }
  return {
    citations: sources.map((source) => source.url),
    sources
  };
}

function handlePlannerFinal(options) {
  const {
    cycleRecord,
    decision,
    memoryEntriesAdded,
    normalizedInput,
    onToken,
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

  // Dispatch-path parity: direct_final (below) and the plan-path terminal
  // (action-loop-plan-terminal.js) both surface the terminal text through
  // onToken; planner_final — the most common simple-turn terminal — must too,
  // or streaming hosts render nothing until the run resolves.
  // C3c (AGRUN-585): when the native door already streamed the answer
  // token-by-token (decision.answerStreamed), skip the one-shot — emitting
  // it again would duplicate the text on streaming hosts.
  if (typeof onToken === "function" && !(decision && decision.answerStreamed === true)) {
    onToken(output.text);
  }

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

  // AGRUN-562 — "deny" is not "ask". Per agrun_docs/approval-flow.md, "ask"
  // returns a pending approval to the host (human-in-the-loop pause) while
  // "deny" returns a policy block the OODAE loop recovers from on its own —
  // two different contracts. A denied action can never be granted, so
  // pausing the run with an approval_required output (the code below,
  // shared with "ask") implies a grantable approval that will never come.
  if (policyDecision.action === "deny") {
    return handlePolicyDenied({ actionHistory, actionName, cycleRecord, policyDecision, pushStep, runState });
  }

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

  // AGRUN-523 — the resume token snapshots the live provider `request` (and, via
  // turnControl, a nested copy of itself), so its apiKey would otherwise ride
  // back to the host on output.pendingApproval AND runState.pendingApproval — the
  // two surfaces of EVERY approval_required turn. Redact every secret-keyed field
  // (reusing the result.input SSOT, llm-trace.redactSecretFields) BEFORE the
  // signer runs, so the signature covers the redacted token and sign->verify
  // still validates the exact bytes the host carries back. Live in-memory state
  // (session.request) is untouched — createResumeRequest already took a clone.
  // Resume re-supplies credentials via overrides (restoreApprovalRequest now
  // REQUIRES the host to re-supply, examples/browser approval-controller does).
  if (pendingApproval && pendingApproval.resumeToken) {
    pendingApproval.resumeToken = redactSecretFields(pendingApproval.resumeToken);
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

// AGRUN-562 — graceful "deny" continuation, mirroring approval.js's
// handleApprovalDenied (the "deny" resolution for a pending "ask" approval):
// record the denial in actionHistory (feeds loopState.deniedActions and the
// planner-prompt "never re-select a denied action" directive), record a
// tool_rejection observation, signal RUN_AGAIN, and close out the act/evaluate
// OODAE phases as a recoverable continuation — never runState.status =
// "blocked", never a pendingApproval, never finishRun(). The { done: false }
// sentinel tells the caller (action-loop-session-loop.js) to `continue` the
// loop instead of returning a terminal RunResult; a real finishRun() result
// has no `done` property, so callers can tell the two apart unambiguously.
function handlePolicyDenied(options) {
  const {
    actionHistory,
    actionName,
    cycleRecord,
    policyDecision,
    pushStep,
    runState
  } = options;

  pushStep("policy-denied", {
    actionName,
    policy: policyDecision.action,
    reason: policyDecision.reason || null,
    tier: policyDecision.tier
  });

  actionHistory.push({
    actionName,
    kind: "denied",
    summary: `Policy denied "${actionName}".`
  });

  runState.pendingApproval = null;
  const rejectionObservation = {
    actionName,
    kind: "tool_rejection",
    message: `Action "${actionName}" is denied by policy and can never be used this session. Choose a different action, or give an honest final answer explaining the limitation.`,
    policy: policyDecision.action,
    resolution: "denied"
  };
  recordObservation(
    runState,
    pushStep,
    rejectionObservation,
    {
      actionName,
      cycle: runState.cycleCount,
      kind: "tool_rejection"
    }
  );
  applyTurnControl(runState, {
    actionName,
    cycle: runState.cycleCount,
    observation: rejectionObservation,
    signal: TURN_SIGNALS.RUN_AGAIN,
    source: "policy"
  });
  completePhase(cycleRecord, pushStep, "act", {
    actionName,
    approvalStatus: policyDecision.action,
    outcome: "denied",
    resultKind: "denied"
  });
  startEvaluatePhase(runState, pushStep, null);
  completeEvaluatePhase(cycleRecord, pushStep, {
    nextPromptState: "continue",
    observationKind: runState.observation.kind,
    outcome: "denied_continue"
  });

  return { done: false };
}

// AGRUN-553 — never-return-empty backstop. The OODAE loop has three budget-
// exhaustion exits (maxSteps, run deadline, cost budget) that otherwise return a
// failure with output:null. When the model has already drafted a usable workspace
// candidate but a terminal-handshake livelock (AGRUN-550/551/552 family) or a slow
// run ate the budget before a clean publish/finalize, throwing that work away and
// returning EMPTY is the worst outcome — especially for providers with no low-
// effort tier (deepseek only supports high/max, so its high-variance terminal
// thrash cannot be dodged by config). This delivers the drafted candidate as a
// COMPLETED result instead, marked finalAnswerSource="budget_exhaustion_salvage"
// (+ output.salvagedFrom / finishReason) so hosts can still tell the run was
// truncated. Fires ONLY on the exhaustion codes AND only when a non-empty
// candidate exists; a genuinely empty run (no candidate) still returns the
// structured error, so the RUN_DEADLINE_EXCEEDED contract is unchanged there.
const BUDGET_EXHAUSTION_SALVAGE_CODES = new Set([
  ERROR_CODES.MAX_STEPS_EXCEEDED,
  ERROR_CODES.RUN_DEADLINE_EXCEEDED,
  ERROR_CODES.COST_BUDGET_EXCEEDED
]);
const BUDGET_EXHAUSTION_SALVAGE_LABELS = Object.freeze({
  [ERROR_CODES.MAX_STEPS_EXCEEDED]: "step budget",
  [ERROR_CODES.RUN_DEADLINE_EXCEEDED]: "time budget",
  [ERROR_CODES.COST_BUDGET_EXCEEDED]: "cost budget"
});

function readSalvageableCandidate(runState) {
  const workspace = runState && runState.virtualWorkspace;
  if (!workspace || workspace.enabled !== true || !workspace.files || typeof workspace.files !== "object") {
    return null;
  }
  const quality = workspace.quality && typeof workspace.quality === "object" ? workspace.quality : {};
  const path = readString(quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const file = workspace.files[path];
  const text = file && typeof file.content === "string" ? file.content.trim() : "";
  return text ? { path, text } : null;
}

function maybeSalvageBudgetExhaustedCandidate(session, code) {
  if (!session || !session.runState) return null;
  if (!BUDGET_EXHAUSTION_SALVAGE_CODES.has(code)) return null;
  const candidate = readSalvageableCandidate(session.runState);
  if (!candidate) return null;

  const runState = session.runState;
  const budgetLabel = BUDGET_EXHAUSTION_SALVAGE_LABELS[code] || "runtime budget";
  const output = {
    citations: [],
    endpoint: null,
    failedTools: Array.isArray(runState.failedTools) && runState.failedTools.length > 0
      ? cloneValue(runState.failedTools) : [],
    finishReason: "budget_exhaustion_salvage",
    kind: "final_response",
    limitations: `Delivered the drafted workspace candidate after the run reached its ${budgetLabel} before a clean publish/finalize completed.`,
    model: null,
    provider: null,
    raw: null,
    requestBody: null,
    salvagedFrom: code,
    status: null,
    text: candidate.text,
    usage: null
  };

  session.pushStep("budget-exhaustion-candidate-salvaged", {
    candidateChars: candidate.text.length,
    candidatePath: candidate.path,
    code
  });
  // Mirror the max-steps continuation terminal (action-loop-continuation.js): set
  // the completed terminal state directly, NOT via completeTerminalAction — we are
  // past the OODAE act/evaluate phases at the budget-exhaustion exits, so the heavy
  // phase machinery would have no valid cycleRecord to complete.
  runState.status = "completed";
  runState.usedRuntimeFinalize = false;
  runState.finalAnswerSource = "budget_exhaustion_salvage";
  runState.terminalizedBy = "budget_exhaustion_salvage";
  runState.lastAction = "budget_exhaustion_salvage";
  runState.evaluationState = {
    actionName: "budget_exhaustion_salvage",
    nextState: "stop",
    outcome: "complete"
  };
  runState.observation = {
    kind: "success",
    output: cloneValue(output),
    source: "budget_exhaustion_salvage"
  };
  session.pushStep("observation-recorded", {
    cycle: runState.cycleCount,
    kind: "success",
    source: "budget_exhaustion_salvage"
  });

  return finishRun({
    rawInput: session.rawInput,
    normalizedInput: session.normalizedInput,
    runState,
    output,
    memoryEntriesAdded: session.memoryEntriesAdded,
    steps: session.steps,
    runtimeState: session.runtimeState
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

export { handleDirectFinal, handlePlannerFinal, handlePolicyBlock, handleRuntimeFinalize, maybeSalvageBudgetExhaustedCandidate };
