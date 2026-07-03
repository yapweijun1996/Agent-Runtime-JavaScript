import { createLastRunSummary, snapshotRunState } from './state.js';
import { ASK_CLARIFICATION_ACTION } from './action-names.js';
import { normalizeFinalAnswerInternalProgress } from './final-answer-internal-progress.js';
import { normalizeFinalResponseStructure } from './final-response-quality.js';
import { appendSourcesSection, filterSourcesByEvidence, collectFinalResponseSources, collectResearchEvidenceUrls } from './final-response-sources.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { isResearchQualityGateRequired } from './convergence-activation.js';
import { applyTerminalFinalContract } from './terminal-final-contract.js';
import { projectTerminalRunState } from './run-state-projections.js';
import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';
import { projectWorkingMemory } from './working-memory.js';
import { redactSecretFields } from './secret-redaction.js';

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
    // AGRUN-515 — echo the host input back WITHOUT its provider secrets. The
    // result object is routinely logged / persisted / shown in an inspector;
    // every other surface (steps, runState, errors) already scrubs the apiKey,
    // and result.input was the one hole that re-exposed it.
    input: redactSecretFields(rawInput),
    mode: runState.mode || "skill_loop",
    // normalizedInput.raw is the original input, so it carries the same secrets
    // as `input` above — redact it too (redactSecretFields deep-clones).
    normalizedInput: redactSecretFields(normalizedInput),
    selectedSkill: runState.selectedSkill,
    output: runState.status === "failed" ? null : cloneValue(output),
    runState: createResultRunStateSnapshot(runState),
    memoryEntriesAdded: cloneValue(memoryEntriesAdded),
    steps: cloneValue(steps),
    error: runState.error ? cloneValue(runState.error) : null,
    diagnostics: createResultDiagnostics(runState, steps, memoryEntriesAdded)
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
      prompt: options.prompt,
      requireReadEvidence: isResearchQualityGateRequired(runState)
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

  if (finalAnswerSource === ASK_CLARIFICATION_ACTION) {
    runState.usedRuntimeFinalize = false;
    return;
  }
}

// AGRUN-439 — consolidate every permission denial into one host-facing array
// for UX ("show what was denied and why") and analytics. Pure read-only
// projection from the existing SSOTs — it adds NO new emission site and does
// not change loop behavior. Two denial kinds today:
//  - "approval": user/host denied an approval-gated action; recorded in
//    actionHistory as { actionName, kind:"denied", summary } (approval.js).
//  - "skill_policy": a skill/tool was policy-denied; emitted as a
//    "skill-policy-denied" step whose detail carries reason + skillName/toolName
//    (skill-policy.js sanitizeDecision).
function readPermissionDenials(runState, steps) {
  const denials = [];
  const history = runState && Array.isArray(runState.actionHistory) ? runState.actionHistory : [];
  for (const entry of history) {
    if (entry && entry.kind === "denied" && typeof entry.actionName === "string") {
      denials.push({
        actionName: entry.actionName,
        kind: "approval",
        reason: readString(entry.summary) || null
      });
    }
  }
  const stepList = Array.isArray(steps) ? steps : [];
  for (const step of stepList) {
    if (step && step.type === "skill-policy-denied") {
      const detail = step.detail && typeof step.detail === "object" ? step.detail : {};
      denials.push({
        actionName: readString(detail.skillName) || readString(detail.toolName) || "execute_skill_tool",
        kind: "skill_policy",
        reason: readString(detail.reason) || null
      });
    }
  }
  return denials;
}

// AGRUN-438 — turn-scoped error digest. A browser-first runtime has no
// process-wide error stream (each tab/run is its own scope), so instead of a
// Claude-Code-style process ring buffer this is a read-only projection of the
// errors THIS run already recorded: the structured failure entries in
// actionHistory (the SSOT the planner itself sees) plus the terminal
// runState.error. Bounded to the most recent RUN_ERROR_DIGEST_LIMIT (ring-buffer
// watermark semantics) with a total count, so a host can show "what went wrong"
// without scraping the open-ended step ledger. Denials are excluded — they are
// surfaced separately as permissionDenials.
const RUN_ERROR_HISTORY_KINDS = new Set([
  "action_error",
  "action_execute_error",
  "action_loop_failure",
  "action_envelope_protocol_error",
  "plan_execution_error",
  "plan_validation_error",
  "planned_action_error",
  "error"
]);

function readRunErrors(runState) {
  const errors = [];
  const terminal = runState && runState.error;
  if (terminal) {
    errors.push({
      source: "run",
      kind: "run_error",
      actionName: null,
      message: readErrorText(terminal)
    });
  }
  const history = runState && Array.isArray(runState.actionHistory) ? runState.actionHistory : [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    if (!RUN_ERROR_HISTORY_KINDS.has(entry.kind)) continue;
    errors.push({
      source: "action",
      kind: readString(entry.kind),
      actionName: readString(entry.actionName) || null,
      message: readString(entry.body && entry.body.error)
        || readString(entry.summary)
        || readString(entry.reason)
        || null
    });
  }
  return { count: errors.length, items: errors.slice(-20) };
}

function readErrorText(error) {
  if (typeof error === "string") return error || null;
  if (error && typeof error.message === "string") return error.message || null;
  return null;
}

function createResultDiagnostics(runState, steps, memoryEntriesAdded) {
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
    },
    permissionDenials: readPermissionDenials(runState, steps),
    // AGRUN-426 — read-only JSON consolidation of the durable memory the AI
    // extracted THIS run (facts/preferences/decisions keyed by slot). A host
    // accumulating entries across turns can call projectWorkingMemory on its
    // own list for a cross-turn working memory.
    workingMemory: projectWorkingMemory(memoryEntriesAdded),
    // AGRUN-438 — turn-scoped, bounded error digest ({ count, items }) from this
    // run's actionHistory failures + terminal error. Read-only telemetry.
    errors: readRunErrors(runState)
  };
}

function isResearchEvidenceLoopActive$2(terminalProjection) {
  const projection = terminalProjection && typeof terminalProjection === "object" ? terminalProjection : {};
  const loop = projection.researchReportLoop && typeof projection.researchReportLoop === "object"
    ? projection.researchReportLoop
    : null;
  if (!loop) return false;
  const status = readString(loop.status);
  return loop.enabled === true || Boolean(readString(loop.finalMode)) || Boolean(status && status !== "idle");
}

export { applyFailure, finalizeResult, readPermissionDenials, readRunErrors };
