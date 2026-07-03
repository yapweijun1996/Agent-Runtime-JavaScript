import { createReadOnlyMemory } from '../memory/store.js';
import { mergeAbortSignals } from './abort-signal.js';
import { createActionPermissionJudge } from './action-permission-judge.js';
import { createAgentSkillSummary } from './agent-skills.js';
import { createActionRegistry } from './action-registry.js';
import { createPushStep } from './context.js';
import { normalizeInput } from './input.js';
import { normalizeToolLoopProviderRequest } from './provider.js';
import { createRunState, readSessionLineage, ensureLiveEventLedger } from './state.js';
import { createSpawnSubagentCapability } from './spawn-subagent-capability.js';
import { deriveParentRunId } from './run-identity.js';
import { attachPricingResolver } from './cost-ledger.js';
import { captureOriginalQuery } from './goal-anchor.js';
import { createDebugLogger } from './debug.js';
import { ensureVirtualWorkspace } from './virtual-workspace.js';
import { cloneValue } from './utils.js';
import { filterAvailableActions } from './action-availability.js';
import { ensureActionNamespaceContext } from './action-namespace-gate.js';
import { readContextSnapshot, createContextSnapshot } from '../session/context-snapshot-normalize.js';
import './action-names.js';
import './action-history-compaction.js';
import './tool-schema.js';
import './plan-args-fallback.js';
import './action-pattern-convergence.js';
import './action-result-envelope.js';
import './planner-prompt.js';
import './planner-action-surface.js';
import './final-response-scrubber.js';
import './loop-transition.js';
import { hydrateRunStateWithThread } from './run-state-thread.js';

function createActionLoopSession(options) {
  const request = options.request
    || normalizeToolLoopProviderRequest(options.rawInput, options.runtimeConfig.providerRegistry);
  // Attach circuit breaker to request so provider.js can use it.
  if (options.runtimeConfig.circuitBreaker && request && !request.circuitBreaker) {
    request.circuitBreaker = options.runtimeConfig.circuitBreaker;
  }
  // F1 — attach the transient-error retry policy the same way, so every
  // downstream requestProviderCompletion(session.request, …) sees it.
  if (options.runtimeConfig.providerRetry && request && !request.providerRetry) {
    request.providerRetry = options.runtimeConfig.providerRetry;
  }
  // Attach the resolved provider registry (built-ins + host entries) so
  // dispatch resolves custom providers. Mirrors the circuitBreaker pattern;
  // request may already carry it from run-loop's normalize step.
  if (options.runtimeConfig.providerRegistry && request && !request.providerRegistry) {
    request.providerRegistry = options.runtimeConfig.providerRegistry;
  }
  // AGRUN-CALLER-ABORT — Attach caller's AbortSignal once at the request
  // SSOT. Every downstream `requestProviderCompletion(session.request, ...)`
  // call spreads `...request` in `createRequestOptions`, so the signal
  // reaches every provider call without per-callsite plumbing. Browser
  // providers merge it with their per-request timeout signal so caller
  // cancellation AND timeout both fire. The original signal is also
  // exposed on `session.callerAbortSignal` so the cycle loop can do a
  // top-of-iteration short-circuit even when no LLM call is in flight.
  const callerAbortSignal = options.callerAbortSignal || null;
  if (request && callerAbortSignal) {
    request.signal = mergeAbortSignals([request.signal, callerAbortSignal]);
  }
  const normalizedInput = options.normalizedInput || normalizeInput(options.rawInput);
  const runState = options.runState || createRunState(
    options.runId,
    options.runtimeConfig.maxSteps,
    readSessionLineage(options),
    { runtimeEventBus: options.runtimeEventBus }
  );
  if (!options.runState) {
    hydrateRunStateWithThread(runState, options.threadHydration);
  } else {
    // Crash-recovery resume (P2): an injected runState came from importState
    // with `eventLedger` as a plain array. Re-attach a live ledger so pushStep
    // records again. No-op for any runState that already owns a live ledger.
    ensureLiveEventLedger(runState, { runtimeEventBus: options.runtimeEventBus });
  }
  attachCostPricingToRunState(runState, options.runtimeConfig);
  const steps = options.steps || [];
  const memoryEntriesAdded = options.memoryEntriesAdded || [];
  const memoryFacade = options.memoryFacade || createReadOnlyMemory(options.resolvedMemory);
  const actionRegistry = options.actionRegistry || createActionRegistry({
    agentSkills: options.runtimeConfig.agentSkills,
    agentSkillIndexProvider: options.runtimeConfig.agentSkillIndexProvider,
    customActions: options.runtimeConfig.customActions,
    // ADR-0057 Phase 1 — registers open_action_namespace only when the host
    // deferred at least one namespace (default [] registers nothing new).
    deferredNamespaces: options.runtimeConfig.deferredNamespaces,
    repoFileTools: options.runtimeConfig.repoFileTools,
    toolCallExamples: options.runtimeConfig.toolCallExamples
  });
  const actionPermissionJudge = options.actionPermissionJudge || createActionPermissionJudge(options.runtimeConfig.actionPermissionJudge);
  const mergedDisabledActions = mergeDisabledActions$1(
    options.runtimeConfig.disabledActions,
    options.disabledActions
  );
  const availableActions = options.availableActions || filterAvailableActions(actionRegistry.list(), mergedDisabledActions);
  const plannerActions = options.plannerActions || filterAvailableActions(actionRegistry.listForPlanner(), mergedDisabledActions);
  // ADR-0037 — spawn_subagent capability. Built once per parent action
  // loop, exposed on the session bag so action-loop-session-loop.js can
  // forward it into executeAction's context. Requires `runLoop` to be
  // threaded via options by run-loop.js — otherwise the capability
  // cannot recurse and the spawn_subagent action will report a
  // SUBAGENT_CAPABILITY_MISSING error.
  const spawnSubagent = typeof options.spawnSubagentRunLoop === "function"
    ? createSpawnSubagentCapability({
        runLoop: options.spawnSubagentRunLoop,
        parentOptions: options,
        actionRegistryActions: actionRegistry.list()
      })
    : null;
  const actionHistory = options.actionHistory || [];
  // GAP 4 — running observation-log state for prompt-side history
  // compaction. `observations` is the observer-authored log text;
  // `compactedThrough` is the actionHistory index (exclusive) already folded
  // into it. The full history above stays untouched — compaction only
  // changes the projection handed to the planner prompt.
  const historyCompaction = options.historyCompaction || { compactedThrough: 0, observations: "" };
  const pushStep = options.pushStep || createPushStep(steps, runState, options.onStep);
  const onToken = typeof options.onToken === "function" ? options.onToken : null;
  const onReasoning = typeof options.onReasoning === "function" ? options.onReasoning : null;
  const onStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;
  const onInvalidPlannerOutput = typeof options.onInvalidPlannerOutput === "function" ? options.onInvalidPlannerOutput : null;
  const onPlannerDecision = typeof options.onPlannerDecision === "function" ? options.onPlannerDecision : null;
  const onToolResult = typeof options.onToolResult === "function" ? options.onToolResult : null;
  const onBeforeFinalize = typeof options.onBeforeFinalize === "function" ? options.onBeforeFinalize : null;
  const debug = createDebugLogger(options.runtimeConfig.debug);
  const requestContextSnapshot = readContextSnapshot(request);
  const turnIntent = options.turnIntent && typeof options.turnIntent === "object"
    ? cloneValue(options.turnIntent)
    : null;

  runState.mode = "tool_loop";
  runState.contextSnapshot = runState.contextSnapshot
    ? createContextSnapshot(runState.contextSnapshot)
    : requestContextSnapshot
      ? createContextSnapshot(requestContextSnapshot)
      : null;
  runState.availableActions = cloneValue(availableActions.map((action) => action.name));
  runState.availableAgentSkills = cloneValue(
    (options.runtimeConfig.agentSkills || [])
      .map(createAgentSkillSummary)
      .filter(Boolean)
  );
  ensureVirtualWorkspace(runState, {
    config: options.runtimeConfig.virtualWorkspace,
    prompt: request && request.prompt
  });
  // ADR-0057 Phase 1 — seed the per-run namespace open-state beside the
  // virtual-workspace seeding above. Also repairs the slot on resumed
  // runStates from pre-Phase-1 checkpoints; an existing `opened` map from a
  // crash-recovery import is preserved (ensure is idempotent).
  ensureActionNamespaceContext(runState, options.runtimeConfig);

  // AGRUN-142 — seed runState.originalQuery once per run from the verbatim
  // rawInput. Immutable afterwards (captureOriginalQuery refuses to rewrite).
  // Gated by runtimeConfig.goalAnchor.enabled; when disabled we still seed so
  // the value is available for auditing, but format/inject sites skip it.
  captureOriginalQuery(runState, {
    inputText: normalizedInput && normalizedInput.text,
    requestPrompt: request && request.prompt
  });

  // Skip the run-started re-seed when resuming a checkpointed runState (P2):
  // the run already started in the prior process; a resumed invocation
  // continues from the saved cycleCount rather than announcing a new run.
  if (options.skipRunStarted !== true && !options.runState) {
    pushStep("run-started", {
      inputType: normalizedInput.type,
      maxSteps: options.runtimeConfig.maxSteps,
      mode: runState.mode,
      parentRunId: deriveParentRunId(options.runId)
    });
  }

  return {
    actionHistory,
    historyCompaction,
    actionPermissionJudge,
    actionRegistry,
    availableActions,
    callerAbortSignal,
    debug,
    memoryEntriesAdded,
    memoryFacade,
    normalizedInput,
    onInvalidPlannerOutput,
    onReasoning,
    onStreamEvent,
    onToken,
    onPlannerDecision,
    onToolResult,
    onBeforeFinalize,
    onCheckpoint: typeof options.onCheckpoint === "function" ? options.onCheckpoint : null,
    plannerDirectives: Array.isArray(options.plannerDirectives) ? options.plannerDirectives.slice() : [],
    plannerDirectivesMode: options.plannerDirectivesMode === "replace" ? "replace" : "append",
    plannerActions,
    pushStep,
    rawInput: options.rawInput,
    request,
    resolvedMemory: options.resolvedMemory,
    runState,
    runtimeConfig: options.runtimeConfig,
    runtimeState: options.runtimeState,
    spawnSubagent,
    turnIntent,
    steps
  };
}

function attachCostPricingToRunState(runState, runtimeConfig) {
  if (!runState || !runState.costLedger) return;
  if (runState.costLedger.pricingResolver) return;
  const pricing = runtimeConfig && runtimeConfig.costPricing
    ? runtimeConfig.costPricing
    : null;
  if (!pricing) return;
  attachPricingResolver(runState.costLedger, pricing);
}

function mergeDisabledActions$1(runtimeLevel, runLevel) {
  const runtime = Array.isArray(runtimeLevel) ? runtimeLevel : [];
  const run = Array.isArray(runLevel) ? runLevel : [];
  if (runtime.length === 0) return run;
  if (run.length === 0) return runtime;
  return [...new Set([...runtime, ...run])];
}

export { createActionLoopSession };
