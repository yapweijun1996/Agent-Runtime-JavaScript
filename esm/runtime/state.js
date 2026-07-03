import { createOodaeState } from './oodae.js';
import { createAgentSkillSummary } from './agent-skills.js';
import { getRuntimeBuildId } from './build-info.js';
import { cloneValue } from './utils.js';
import { createRuntimeMetrics } from './runtime-events.js';
import { createActionGuardrailState } from './action-guardrail-controller.js';
import { createActionPatternConvergenceState } from './action-pattern-convergence.js';
import { createCostLedger } from './cost-ledger.js';
import { createResearchAcceptanceEvaluatorState } from './kernel-acceptance-evaluator.js';
import { createRequirementRecoveryEvaluatorState } from './requirement-recovery-evaluator.js';
import { createReadUrlRecoverySignalState } from './read-url-recovery-signal.js';
import { createEmptyResearchWorkspace } from './research-state.js';
import { createResearchReportLoopState } from './kernel-report-loop.js';
import { createSessionBudgetState } from './session-budget.js';
import { createTerminalRepairState } from './terminal-repair/internal-utils.js';
import './action-names.js';
import { createEmptyVirtualWorkspace } from './virtual-workspace.js';
import { createInvalidActionConvergenceState } from './invalid-action-convergence.js';
import { createRuntimeEventLedger } from './runtime-event-ledger.js';
import { projectMetricsRunState, createRunKernelState, projectRunKernelState, projectApprovalRunState, projectResearchRunState, projectWorkspaceRunState, projectTodoRunState } from './run-state-projections.js';

function createRunState(runId, maxSteps, lineage, options) {
  const eventLedgerOptions = readEventLedgerOptions(options);
  const runState = {
    ...createRunKernelState(runId, maxSteps, lineage),
    selectedSkill: null,
    lastAction: null,
    lastTransition: null,
    availableActions: [],
    availableAgentSkills: [],
    skillCatalogManifests: null,
    pendingApproval: null,
    planner: null,
    plannerState: null,
    plannerInvalidCount: 0,
    plannerInvalidSignal: null,
    semanticState: null,
    // ADR-0028 — `usedSummarizeLimits`, `autoReadAttemptCount`,
    // `autoReadStoppedReason`, `continuityResolution` deleted.
    // Replacement: `readAttemptSignal` (read-only signal exposed to AI).
    usableReadSourceCount: 0,
    strongReadSourceCount: 0,
    readAttemptSignal: null,
    readUrlRecoverySignal: createReadUrlRecoverySignalState(),
    // Mirrors `actionFailureSignal` (ADR-0026) but for workspace publish
    // soft-blocks. Each blocked publish appends to `publishBlockHistory`;
    // `publishBlockSignal` is the read-only summary surfaced to the next
    // planner cycle so AI sees how many times publish was blocked, by which
    // gate (status), and how close it is to maxSteps. Runtime never decides
    // when to stop trying — it only counts and shows the fact.
    publishBlockSignal: null,
    publishBlockHistory: [],
    inputResolution: null,
    intentState: null,
    turnState: null,
    driftSignal: null,
    // 2026-05-09 — `runtimePlannerDirectives` deleted along with
    // `notePlanValidationFailure`. Runtime no longer surfaces a per-turn
    // injectable directive bag to the planner cycle; AI consumes
    // structured rejection feedback through the observation path
    // (`validation.planner_feedback.detail` → plan_result → observation).
    originalQuery: "",
    threadGoalAnchorText: "",
    observationSummary: null,
    contextSnapshot: null,
    controlEnvelopeKind: null,
    controlEnvelopeConsumed: false,
    requestTypeAfterApproval: null,
    sessionContextMeta: null,
    sessionContextSource: null,
    sessionContextView: null,
    blockedPageEvidenceCount: 0,
    approvalResumeFallbackUsed: false,
    runtimeBuildId: getRuntimeBuildId(),
    agentSkillContext: {
      activeSkill: null,
      catalogListed: false,
      handoffChain: [],
      handoffContext: null,
      handoffCycle: null,
      handoffInputFilter: null,
      handoffInputFilterReport: null,
      lastReadSkill: null,
      // ADR-0013: 5-call budget per turn for list_agent_skills.
      // Reset by action-loop-session-cycle on each new turn.
      listSkillsCallsThisTurn: 0
    },
    // ADR-0057 Phase 1 (AGRUN-565) — deferred-action-loading open state,
    // beside its shape sibling agentSkillContext and with the SAME
    // persistence posture: per-run only (NOT carried by
    // hydrateRunStateWithThread — thread carry is explicitly Phase 3), rides
    // snapshotRunState/createLastRunSummary below sanitized to plain data.
    // `deferred` mirrors runtimeConfig.deferredNamespaces at run start
    // (seeded by createActionLoopSession via ensureActionNamespaceContext);
    // `opened` is written only by the open_action_namespace action.
    actionNamespaceContext: {
      deferred: [],
      opened: {}
    },
    // AGRUN-486 (audit H8): the LIVE planner repair budget. `retries` counts
    // the streak of consecutive failed-repair cycles; it gates the N+1
    // envelope-repair LLM call (isRecoveryBudgetExhausted) and is zeroed the
    // moment the planner produces a valid decision (resetRecoveryBudget in
    // action-loop-planner.js). Seeding 0 here is what gives every fresh turn a
    // clean budget (audit M5 / AGRUN-490). Runtime still does NOT synthesize
    // fallback actions from it — invalid/empty planner output is surfaced via
    // plannerInvalidSignal so the AI owns the next envelope.
    recoveryState: {
      retries: 0,
      lastSignal: null,
      exhaustedAt: null
    },
    researchContext: {
      aggregatedSearchResults: [],
      lastQuery: null,
      readSources: [],
      searchPasses: [],
      searchPlan: null,
      searchResults: [],
      verification: null,
      verificationState: "none"
    },
    // AGRUN-313 R2 — slot starts null instead of baking the research state SHAPE into
    // core's runState (createResearchState was domain hardcode in the kernel). The research
    // path's refreshResearchState self-creates + assigns the slot on first use; all core
    // readers null-guard (proven: smoke passes with the slot stubbed to null). Same pattern
    // as researchEvidenceGraph (2.2). A generic runtime keeps researchState null forever.
    researchState: null,
    readinessContinuationSignal: null,
    readinessConflictContinuationSignal: null,
    terminalFinalContract: null,
    terminalFinalContractAudits: [],
    // AGRUN-313 2.2 — slot starts null (no research import); the research-internal
    // builder/materialize creates + assigns the real graph. Core readers null-guard.
    researchEvidenceGraph: null,
    researchWorkspace: createEmptyResearchWorkspace(),
    // Intentional research round-trip carriers: only the research plumbing
    // (research-thread-sync.js) populates these when a research skill is engaged.
    // Pure-core runs keep them empty/inert, and core readers are null-safe.
    researchReportLoop: createResearchReportLoopState(),
    researchAcceptanceEvaluator: createResearchAcceptanceEvaluatorState(),
    requirementRecoveryEvaluator: createRequirementRecoveryEvaluatorState(),
    candidatePathMismatchSignal: null,
    virtualWorkspace: createEmptyVirtualWorkspace(),
    toolContext: {
      history: [],
      lastResult: null
    },
    todoTerminalObservation: null,
    failedTools: [],
    metrics: createRuntimeMetrics(),
    costLedger: createCostLedger(),
    actionGuardrail: createActionGuardrailState(),
    actionPatternConvergence: createActionPatternConvergenceState(),
    terminalRepairState: createTerminalRepairState(),
    invalidActionConvergence: createInvalidActionConvergenceState(),
    actionCallCounter: 0,
    selfCorrectionCount: 0,
    sessionBudget: createSessionBudgetState(),
    actState: null,
    evaluationState: null,
    observation: null,
    oodae: createOodaeState()
  };
  // AGRUN-248-C — typed event ledger is created up front so pushStep can
  // append from the very first step. ledger reads runId/cycleCount off this
  // runState by reference; the live state is always the latest value.
  runState.eventLedger = createRuntimeEventLedger({
    runState,
    onEvent: eventLedgerOptions.onEvent,
    sequenceProvider: eventLedgerOptions.sequenceProvider
  });
  return runState;
}

// Crash-recovery resume (run-state-export-import-design.md P2). A runState
// restored via importState carries `eventLedger` as a plain ARRAY (the
// serialized events), not the live closure object pushStep needs. Re-attach a
// fresh live ledger bound to this runState + the runtime event bus so events
// record again. Idempotent: a runState that already owns a live ledger (the
// normal createRunState path) is returned untouched. Prior events stay in the
// host's checkpoint; the resumed run starts a fresh live event stream.
function ensureLiveEventLedger(runState, options) {
  if (!runState || typeof runState !== "object") return runState;
  const existing = runState.eventLedger;
  if (existing && typeof existing.appendEvent === "function") return runState;
  if ("eventLedger" in runState) delete runState.eventLedger;
  const eventLedgerOptions = readEventLedgerOptions(options);
  runState.eventLedger = createRuntimeEventLedger({
    runState,
    onEvent: eventLedgerOptions.onEvent,
    sequenceProvider: eventLedgerOptions.sequenceProvider
  });
  return runState;
}

function readEventLedgerOptions(options) {
  const eventBus = options && typeof options === "object" ? options.runtimeEventBus : null;
  if (!eventBus || typeof eventBus !== "object") return {};
  return {
    onEvent: typeof eventBus.recordEvent === "function"
      ? (event) => eventBus.recordEvent(event)
      : null,
    sequenceProvider: typeof eventBus.nextSequence === "function"
      ? () => eventBus.nextSequence()
      : null
  };
}

function snapshotRunState(runState) {
  const snapshot = cloneValue(runState);
  snapshot.agentSkillContext = sanitizeAgentSkillContext(runState.agentSkillContext);
  // ADR-0057 Phase 1 — mirrors the agentSkillContext treatment above so the
  // crash-recovery export always carries a plain-data open-state slot.
  snapshot.actionNamespaceContext = sanitizeActionNamespaceContext(runState.actionNamespaceContext);
  snapshot.recoveryState = sanitizeRecoveryState(runState && runState.recoveryState);
  snapshot.costLedger = projectMetricsRunState(runState).costLedger;
  // AGRUN-248-C — eventLedger is a live object (closures + methods); strip
  // from the snapshot so the snapshot stays plain-data cloneable. Host reads
  // it directly via runState.eventLedger.getEvents().
  if (snapshot.eventLedger) delete snapshot.eventLedger;
  return snapshot;
}

function sanitizeRecoveryState(value) {
  const source = value && typeof value === "object" ? value : {};
  const retries = typeof source.retries === "number" && source.retries >= 0
    ? Math.floor(source.retries)
    : 0;
  const lastSignal = typeof source.lastSignal === "string" && source.lastSignal
    ? source.lastSignal
    : null;
  const exhaustedAt = source.exhaustedAt && typeof source.exhaustedAt === "object"
    ? cloneValue(source.exhaustedAt)
    : null;
  return { retries, lastSignal, exhaustedAt };
}

function createLastRunSummary(runState, memoryEntriesAdded) {
  const kernelState = projectRunKernelState(runState);
  const approvalState = projectApprovalRunState(runState);
  const researchState = projectResearchRunState(runState);
  const workspaceState = projectWorkspaceRunState(runState);
  const todoState = projectTodoRunState(runState);
  const metricsState = projectMetricsRunState(runState);

  return {
    runId: kernelState.runId,
    status: kernelState.status,
    stepCount: kernelState.stepCount,
    cycleCount: kernelState.cycleCount,
    mode: kernelState.mode,
    turnCount: kernelState.turnCount,
    maxSteps: kernelState.maxSteps,
    phase: kernelState.phase,
    turnControl: kernelState.turnControl,
    selectedSkill: runState.selectedSkill,
    lastAction: cloneValue(runState.lastAction),
    availableActions: cloneValue(runState.availableActions),
    availableAgentSkills: cloneValue(runState.availableAgentSkills),
    skillCatalogManifests: cloneValue(runState.skillCatalogManifests),
    pendingApproval: approvalState.pendingApproval,
    planner: cloneValue(runState.planner),
    plannerState: cloneValue(runState.plannerState),
    plannerInvalidSignal: cloneValue(runState.plannerInvalidSignal || null),
    semanticState: cloneValue(runState.semanticState),
    failedTools: cloneValue(runState.failedTools),
    metrics: metricsState.metrics,
    costLedger: metricsState.costLedger,
    actionGuardrail: metricsState.actionGuardrail,
    actionPatternConvergence: metricsState.actionPatternConvergence,
    terminalRepairState: metricsState.terminalRepairState,
    invalidActionConvergence: cloneValue(runState.invalidActionConvergence || null),
    executionClass: kernelState.executionClass,
    terminalizedBy: kernelState.terminalizedBy,
    usedRuntimeFinalize: kernelState.usedRuntimeFinalize,
    // ADR-0028 — `usedSummarizeLimits`, `autoReadAttemptCount`,
    // `autoReadStoppedReason` removed from snapshot. Hosts that depended
    // on these for telemetry must read `readAttemptSignal.attemptCount`
    // and infer terminal sources from `terminalizedBy === "planner_finalize"`.
    usableReadSourceCount: metricsState.usableReadSourceCount,
    strongReadSourceCount: metricsState.strongReadSourceCount,
    readAttemptSignal: metricsState.readAttemptSignal,
    readUrlRecoverySignal: metricsState.readUrlRecoverySignal,
    inputResolution: cloneValue(runState.inputResolution),
    intentState: cloneValue(runState.intentState),
    turnState: cloneValue(runState.turnState),
    originalQuery: typeof runState.originalQuery === "string" ? runState.originalQuery : "",
    threadGoalAnchorText: typeof runState.threadGoalAnchorText === "string" ? runState.threadGoalAnchorText : "",
    observationSummary: cloneValue(runState.observationSummary),
    contextSnapshot: cloneValue(runState.contextSnapshot),
    // ADR-0028 — `continuityResolution` removed from snapshot.
    controlEnvelopeKind: approvalState.controlEnvelopeKind,
    controlEnvelopeConsumed: approvalState.controlEnvelopeConsumed,
    requestTypeAfterApproval: approvalState.requestTypeAfterApproval,
    sessionContextMeta: cloneValue(runState.sessionContextMeta),
    sessionContextSource: cloneValue(runState.sessionContextSource),
    sessionContextView: cloneValue(runState.sessionContextView),
    blockedPageEvidenceCount: runState.blockedPageEvidenceCount,
    approvalResumeFallbackUsed: approvalState.approvalResumeFallbackUsed,
    finalAnswerSource: kernelState.finalAnswerSource,
    runtimeBuildId: kernelState.runtimeBuildId,
    agentSkillContext: sanitizeAgentSkillContext(runState.agentSkillContext),
    // ADR-0057 Phase 1 — same summary treatment as its sibling agentSkillContext.
    actionNamespaceContext: sanitizeActionNamespaceContext(runState.actionNamespaceContext),
    recoveryState: sanitizeRecoveryState(runState.recoveryState),
    researchState: researchState.researchState,
    readinessContinuationSignal: researchState.readinessContinuationSignal,
    readinessConflictContinuationSignal: researchState.readinessConflictContinuationSignal,
    terminalFinalContract: researchState.terminalFinalContract,
    terminalFinalContractAudits: researchState.terminalFinalContractAudits,
    researchEvidenceGraph: researchState.researchEvidenceGraph,
    researchWorkspace: researchState.researchWorkspace,
    researchReportLoop: researchState.researchReportLoop,
    researchAcceptanceEvaluator: researchState.researchAcceptanceEvaluator,
    requirementRecoveryEvaluator: researchState.requirementRecoveryEvaluator,
    candidatePathMismatchSignal: researchState.candidatePathMismatchSignal,
    virtualWorkspace: workspaceState.virtualWorkspace,
    toolContext: cloneValue(runState.toolContext),
    todoTerminalObservation: todoState.todoTerminalObservation,
    todoTask: todoState.todoTask,
    actState: cloneValue(runState.actState),
    evaluationState: cloneValue(runState.evaluationState),
    observation: cloneValue(runState.observation),
    error: kernelState.error,
    memoryEntriesAdded: memoryEntriesAdded.length,
    oodaeCycles: runState.oodae.cycles.length
  };
}

// ADR-0057 Phase 1 — plain-data projection of the namespace open state
// ({ deferred: string[], opened: { name: { openedAtCycle } } }). Defensive
// like sanitizeAgentSkillContext below: a malformed/absent slot sanitizes to
// the empty shape rather than throwing during snapshot/export.
function sanitizeActionNamespaceContext(context) {
  const source = context && typeof context === "object" && !Array.isArray(context) ? context : {};
  const deferred = Array.isArray(source.deferred)
    ? source.deferred
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : [];
  const opened = {};
  const openedSource = source.opened && typeof source.opened === "object" && !Array.isArray(source.opened)
    ? source.opened
    : {};
  for (const [name, record] of Object.entries(openedSource)) {
    if (!record) continue;
    opened[name] = {
      openedAtCycle: record && typeof record === "object" && Number.isInteger(record.openedAtCycle)
        ? record.openedAtCycle
        : 0
    };
  }
  return { deferred, opened };
}

function sanitizeAgentSkillContext(context) {
  const source = context && typeof context === "object" ? context : {};

  return {
    activeSkill: createAgentSkillSummary(source.activeSkill),
    catalogListed: source.catalogListed === true,
    handoffChain: sanitizeHandoffChain(source.handoffChain),
    handoffContext: typeof source.handoffContext === "string" && source.handoffContext.trim()
      ? source.handoffContext.trim()
      : null,
    handoffCycle: sanitizeHandoffCycle(source.handoffCycle),
    handoffInputFilter: sanitizeHandoffInputFilter(source.handoffInputFilter),
    handoffInputFilterReport: sanitizeHandoffInputFilterReport(source.handoffInputFilterReport),
    lastReadSkill: createAgentSkillSummary(source.lastReadSkill),
    listSkillsCallsThisTurn: typeof source.listSkillsCallsThisTurn === "number" && source.listSkillsCallsThisTurn >= 0
      ? source.listSkillsCallsThisTurn
      : 0
  };
}

function sanitizeHandoffInputFilter(value) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

function sanitizeHandoffChain(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean);
}

function sanitizeHandoffCycle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    cycleChain: sanitizeHandoffChain(value.cycleChain),
    fromSkill: typeof value.fromSkill === "string" && value.fromSkill.trim()
      ? value.fromSkill.trim()
      : null,
    handoffChain: sanitizeHandoffChain(value.handoffChain),
    reason: typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : null,
    repeatedSkill: typeof value.repeatedSkill === "string" && value.repeatedSkill.trim()
      ? value.repeatedSkill.trim()
      : null,
    repeatedSkillIndex: Number.isInteger(value.repeatedSkillIndex)
      ? value.repeatedSkillIndex
      : null,
    requestedSkillName: typeof value.requestedSkillName === "string" && value.requestedSkillName.trim()
      ? value.requestedSkillName.trim()
      : null,
    targetSkill: typeof value.targetSkill === "string" && value.targetSkill.trim()
      ? value.targetSkill.trim()
      : null
  };
}

function sanitizeHandoffInputFilterReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    after: cloneValue(value.after || null),
    applied: value.applied === true,
    before: cloneValue(value.before || null),
    filterName: typeof value.filterName === "string" && value.filterName.trim()
      ? value.filterName.trim()
      : null,
    reason: typeof value.reason === "string" && value.reason.trim()
      ? value.reason.trim()
      : null
  };
}

// AGRUN-240-followup — single helper for callers to derive a lineage
// object from their runLoop/options bag before calling createRunState.
// Centralized so every createRunState call site treats the lineage shape
// identically.
function readSessionLineage(source) {
  if (!source || typeof source !== "object") return null;
  const sessionId = typeof source.sessionId === "string" && source.sessionId.trim()
    ? source.sessionId.trim()
    : null;
  const parentSessionId = typeof source.parentSessionId === "string" && source.parentSessionId.trim()
    ? source.parentSessionId.trim()
    : null;
  return sessionId || parentSessionId ? { sessionId, parentSessionId } : null;
}

export { createLastRunSummary, createRunState, ensureLiveEventLedger, readSessionLineage, sanitizeRecoveryState, snapshotRunState };
