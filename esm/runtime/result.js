import { createLastRunSummary, snapshotRunState } from './state.js';
import { normalizeFinalAnswerInternalProgress } from './final-answer-internal-progress.js';
import { normalizeFinalResponseStructure } from './final-response-quality.js';
import { appendSourcesSection, filterSourcesByEvidence, collectFinalResponseSources, collectResearchEvidenceUrls } from './final-response-sources.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { applyTerminalFinalContract } from './terminal-final-contract.js';
import { projectTerminalRunState } from './run-state-projections.js';
import { cloneValue } from './utils.js';

function applyFailure(runState, error, pushStep) {
  runState.status = "failed";
  runState.error = cloneValue(error);
  runState.observation = {
    kind: "error",
    code: error.code,
    message: error.message
  };
  pushStep("skill-failed", {
    skill: error.skill,
    code: error.code
  });
}

function finalizeResult(
  rawInput,
  normalizedInput,
  runState,
  output,
  memoryEntriesAdded,
  steps,
  runtimeState
) {
  normalizeTerminalMetadata(runState, output);
  normalizeTerminalOutputText(runState, output);
  const failedTools = Array.isArray(runState.failedTools) && runState.failedTools.length > 0
    ? cloneValue(runState.failedTools)
    : [];
  const result = {
    failedTools,
    finalAnswerSource: runState.finalAnswerSource || null,
    input: rawInput,
    mode: runState.mode || "skill_loop",
    normalizedInput: cloneValue(normalizedInput),
    selectedSkill: runState.selectedSkill,
    output: runState.status === "failed" ? null : cloneValue(output),
    runState: createResultRunStateSnapshot(runState),
    memoryEntriesAdded: cloneValue(memoryEntriesAdded),
    steps: cloneValue(steps),
    error: runState.error ? cloneValue(runState.error) : null,
    diagnostics: createResultDiagnostics(runState)
  };

  runtimeState.lastRun = createLastRunSummary(runState, memoryEntriesAdded);
  return result;
}

function createResultRunStateSnapshot(runState) {
  const snapshot = snapshotRunState(runState);
  const events = readEventLedgerSnapshot$1(runState);
  if (events) snapshot.eventLedger = events;
  return snapshot;
}

function readEventLedgerSnapshot$1(runState) {
  const ledger = runState && runState.eventLedger;
  if (!ledger || typeof ledger.getEvents !== "function") return null;
  try {
    return cloneValue(ledger.getEvents());
  } catch (_error) {
    return null;
  }
}

function normalizeTerminalOutputText(runState, output) {
  if (!output || typeof output !== "object" || typeof output.text !== "string") return;
  // AGRUN-313 2.1 — route on the generic publish-direct capability flag, not the
  // literal action name (stamped at executeAction from action.publishDirect).
  if (runState && runState.terminalActionPublishDirect) return;
  const kind = typeof output.kind === "string" ? output.kind : "";
  if (kind !== "final_response" && kind !== "planner_final") return;

  const prompt = readFinalSourcePrompt(runState, null);
  const sourceText = output.text;
  const terminalProjection = projectTerminalRunState(runState);
  const scopedEvidenceUrls = readScopedEvidenceUrls$2(runState, terminalProjection);
  const sourceLimit = Array.isArray(scopedEvidenceUrls) ? Math.max(3, scopedEvidenceUrls.length) : undefined;
  const sourcePayload = collectTerminalOutputSources(runState, {
    prompt,
    terminalProjection,
    scopedEvidenceUrls,
    sourceLimit
  });
  const processedText = normalizeFinalAnswerInternalProgress(
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
  );
  const sources = sourcePayload.sources;
  const normalizedText = appendSourcesSection(processedText, sources);

  const terminalContract = applyTerminalFinalContract({
    finalReadiness: readFinalReadinessForTerminalContract(runState, output),
    request: null,
    runState,
    source: runState && (runState.terminalizedBy || runState.finalAnswerSource) || "finalize_result",
    text: normalizedText
  });
  output.text = terminalContract.text;
  output.terminalContractAudit = terminalContract.audit;
  if (sources.length > 0) {
    output.citations = sources.map((source) => source.url);
  }
}

function readFinalReadinessForTerminalContract(runState, output) {
  if (output && output.finalReadiness && typeof output.finalReadiness === "object") {
    return output.finalReadiness;
  }
  const contract = runState && runState.researchFinalizeContract && typeof runState.researchFinalizeContract === "object"
    ? runState.researchFinalizeContract
    : null;
  return contract && contract.finalReadiness && typeof contract.finalReadiness === "object"
    ? contract.finalReadiness
    : null;
}

function collectTerminalOutputSources(runState, options = {}) {
  const terminalProjection = options.terminalProjection || projectTerminalRunState(runState);
  if (shouldSuppressResearchLoopSources$1(terminalProjection)) {
    return { citations: [], sources: [] };
  }
  if (terminalProjection.researchEvidenceGraph) {
    const graphSources = createCompiledReportSourcePayload$1(terminalProjection.researchEvidenceGraph);
    if (graphSources.sources.length > 0) return graphSources;
  }
  return filterSourcesByEvidence(
    collectFinalResponseSources(terminalProjection.researchContext, options.sourceLimit, {
      prompt: options.prompt
    }),
    options.scopedEvidenceUrls
  );
}

function shouldSuppressResearchLoopSources$1(terminalProjection) {
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

function createCompiledReportSourcePayload$1(graph) {
  // AGRUN-313 2.2 — read the pre-computed projection off the graph slot (set by the
  // research-internal materializeEvidenceGraph) instead of importing the collector.
  const sourceArtifacts = graph && Array.isArray(graph.compiledReportSources)
    ? graph.compiledReportSources
    : [];
  const sources = [];
  const seenUrls = new Set();
  for (const source of sourceArtifacts) {
    const url = readString$1g(source && source.url);
    if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    sources.push({
      kind: "research_evidence_graph",
      title: readString$1g(source && source.title) || url,
      url
    });
    if (sources.length >= 8) break;
  }
  return {
    citations: sources.map((source) => source.url),
    sources
  };
}

function readScopedEvidenceUrls$2(runState, terminalProjection = projectTerminalRunState(runState)) {
  if (!runState || typeof runState !== "object") return null;
  const scopedUrls = Array.isArray(runState.scopedEvidenceUrls) ? runState.scopedEvidenceUrls : null;
  const researchUrls = collectResearchEvidenceUrls(terminalProjection.researchContext);

  if (scopedUrls && scopedUrls.length === 0 && !isResearchEvidenceLoopActive$2(terminalProjection)) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  if (!scopedUrls) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  return scopedUrls;
}


function normalizeTerminalMetadata(runState, output) {
  const outputKind = output && typeof output.kind === "string" ? output.kind : "";
  const finalAnswerSource = typeof runState.finalAnswerSource === "string"
    ? runState.finalAnswerSource
    : "";

  if (outputKind === "planner_final" || finalAnswerSource === "planner") {
    runState.finalAnswerSource = "planner";
    runState.terminalizedBy = "planner_final";
    runState.usedRuntimeFinalize = false;
    return;
  }

  if (finalAnswerSource === "direct_tool") {
    runState.terminalizedBy = "direct_tool";
    runState.usedRuntimeFinalize = false;
    return;
  }

  if (finalAnswerSource === "direct_final") {
    runState.terminalizedBy = "direct_final";
    runState.usedRuntimeFinalize = false;
    return;
  }

  if (runState.terminalActionPublishDirect) {
    runState.terminalizedBy = finalAnswerSource;
    runState.usedRuntimeFinalize = false;
    return;
  }

  // ADR-0025 — handle both AI-driven (planner_finalize) and runtime-pushed
  // (runtime_finalize) terminal sources. Both go through the finalizer LLM
  // call (`handleRuntimeFinalize`), but the source label distinguishes who
  // initiated it.
  // ADR-0028 — `summarize_limits` overlay removed; runtime no longer authors
  // a "evidence is limited" instruction when read attempts hit a cap. AI
  // owns the disclosure of evidence gaps via the planner finalize directly.
  if (finalAnswerSource === "runtime_finalize" || finalAnswerSource === "planner_finalize") {
    runState.terminalizedBy = finalAnswerSource;
    runState.usedRuntimeFinalize = true;
    return;
  }

  if (finalAnswerSource === "ask_clarification") {
    runState.usedRuntimeFinalize = false;
    return;
  }
}

function readString$1g(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createResultDiagnostics(runState) {
  // ADR-0014 PR 2 — surface bounded recovery state for hosts that want
  // to show "AI is having trouble parsing" UX without inspecting
  // internal runState. Read-only telemetry; hosts cannot influence
  // runtime via this field.
  const recoveryState = runState && runState.recoveryState && typeof runState.recoveryState === "object"
    ? runState.recoveryState
    : null;
  const retries = recoveryState && typeof recoveryState.retries === "number"
    ? recoveryState.retries
    : 0;
  const lastSignal = recoveryState && typeof recoveryState.lastSignal === "string"
    ? recoveryState.lastSignal
    : null;
  const exhaustedAt = recoveryState && recoveryState.exhaustedAt && typeof recoveryState.exhaustedAt === "object"
    ? cloneValue(recoveryState.exhaustedAt)
    : null;
  // ADR-0019 PR 1 — surface final-response-quality issue codes for hosts
  // that want to show "answer too short / placeholders / claim coverage"
  // UX without inspecting internal runState. Read-only telemetry.
  const finalResponseQuality = runState && runState.finalResponseQuality && typeof runState.finalResponseQuality === "object"
    ? runState.finalResponseQuality
    : null;
  const fqIssues = finalResponseQuality && Array.isArray(finalResponseQuality.lastIssues)
    ? finalResponseQuality.lastIssues.slice()
    : [];
  const fqNoteCount = finalResponseQuality && typeof finalResponseQuality.vetoCount === "number"
    ? finalResponseQuality.vetoCount
    : 0;
  const fqLastSource = finalResponseQuality && typeof finalResponseQuality.lastSource === "string"
    ? finalResponseQuality.lastSource
    : null;
  return {
    recovery: {
      retries,
      lastSignal,
      exhaustedAt
    },
    finalResponseQuality: {
      issues: fqIssues,
      noteCount: fqNoteCount,
      lastSource: fqLastSource
    }
  };
}

function isResearchEvidenceLoopActive$2(terminalProjection) {
  const projection = terminalProjection && typeof terminalProjection === "object" ? terminalProjection : {};
  const loop = projection.researchReportLoop && typeof projection.researchReportLoop === "object"
    ? projection.researchReportLoop
    : null;
  if (!loop) return false;
  const status = readString$1g(loop.status);
  return loop.enabled === true || Boolean(readString$1g(loop.finalMode)) || Boolean(status && status !== "idle");
}

export { applyFailure, finalizeResult };
