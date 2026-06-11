import { finishRun, recordObservation, startEvaluatePhase, completeEvaluatePhase } from './finalizer.js';
import { completePhase } from './oodae.js';
import { createEvaluationState } from './task-state.js';
import { syncPromptInquiryContext } from './inquiry-context-resolution.js';
import { setTurnStateStatus } from './turn-state.js';
import { cloneValue } from './utils.js';
import { normalizeFinalResponseStructure } from './final-response-quality.js';
import { appendSourcesSection, collectFinalResponseSources, filterSourcesByEvidence, collectResearchEvidenceUrls } from './final-response-sources.js';
import { normalizeFinalAnswerInternalProgress } from './final-answer-internal-progress.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { applyTerminalFinalContract } from './terminal-final-contract.js';

function handlePlanSynthesize(options) {
  const {
    cycleRecord,
    markdown,
    memoryEntriesAdded,
    normalizedInput,
    onToken,
    pushStep,
    rawInput,
    request,
    runState,
    runtimeState,
    steps
  } = options;
  const finalPrompt = readFinalSourcePrompt(runState, request);
  const sourceMarkdown = markdown;
  const responseSources = collectScopedFinalResponseSources(runState, request, finalPrompt);
  const normalizedMarkdownBeforeContract = appendSourcesSection(
    normalizeFinalAnswerInternalProgress(
      normalizeFinalResponseStructure(sourceMarkdown, { prompt: finalPrompt }),
      {
        prompt: finalPrompt,
        researchEvidenceGraph: runState.researchEvidenceGraph,
        researchState: runState.researchState,
        researchWorkspace: runState.researchWorkspace,
        researchReportLoop: runState.researchReportLoop,
        virtualWorkspace: runState.virtualWorkspace,
        todoState: runState.todoState
      }
    ),
    responseSources.sources
  );
  const terminalContract = applyTerminalFinalContract({
    finalReadiness: options.finalReadiness || null,
    pushStep,
    request,
    runState,
    source: "plan_synthesize",
    text: normalizedMarkdownBeforeContract
  });
  const output = {
    citations: responseSources.citations,
    endpoint: request.endpoint || null,
    finishReason: null,
    kind: "final_response",
    model: request.model || null,
    provider: request.provider || null,
    raw: null,
    requestBody: null,
    status: null,
    terminalContractAudit: terminalContract.audit,
    text: terminalContract.text,
    usage: null
  };

  if (typeof onToken === "function") {
    onToken(output.text);
  }

  syncPromptInquiryContext(runState, request);
  runState.usedRuntimeFinalize = false;
  runState.terminalizedBy = "plan_synthesize";
  completePlanTerminalAction({
    actionName: "plan",
    cycleRecord,
    finalAnswerSource: "plan_synthesize",
    observation: {
      kind: "success",
      output: cloneValue(output),
      source: "plan_synthesize"
    },
    observationStep: {
      cycle: runState.cycleCount,
      kind: "success",
      source: "plan_synthesize"
    },
    output,
    pushStep,
    request,
    runState
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

function collectScopedFinalResponseSources(runState, request, prompt) {
  const scopedUrls = readScopedEvidenceUrls(runState);
  const sourceLimit = Array.isArray(scopedUrls) ? Math.max(3, scopedUrls.length) : undefined;
  const raw = collectFinalResponseSources(runState && runState.researchContext, sourceLimit, {
    prompt
  });
  return filterSourcesByEvidence(raw, scopedUrls);
}

function readScopedEvidenceUrls(runState) {
  if (!runState || typeof runState !== "object") return null;
  const list = runState.scopedEvidenceUrls;
  const scopedUrls = Array.isArray(list) ? list : null;
  const researchUrls = collectResearchEvidenceUrls(runState.researchContext);

  if (!scopedUrls) {
    return researchUrls.length > 0 ? researchUrls : null;
  }

  return scopedUrls;
}

function completePlanTerminalAction(options) {
  const {
    actionName,
    cycleRecord,
    finalAnswerSource,
    observation,
    observationStep,
    output,
    pushStep,
    request,
    runState
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
  completePhase(cycleRecord, pushStep, "act", {
    actionName,
    approvalStatus: null,
    outcome: "executed",
    resultKind: "complete"
  });
  startEvaluatePhase(runState, pushStep, null);
  runState.evaluationState = createEvaluationState({
    actionName,
    nextState: "stop",
    outcome: "complete",
    plannerState: runState.plannerState,
    researchContext: runState.researchContext,
    sessionContext: request && request.sessionContext,
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

export { handlePlanSynthesize };
