import { createUsageSnapshot, accumulateUsage } from '../session/token-budget.js';
import { recordCostEntry, phaseFromStepType } from './cost-ledger.js';
import { cloneValue } from './utils.js';

function createRuntimeMetrics() {
  return {
    plannerCallCount: 0,
    providerCallCount: 0,
    actionDurations: [],
    usage: null
  };
}

function prepareRuntimeStepDetail(type, detail, runState) {
  const prepared = detail == null ? null : cloneValue(detail);

  if (prepared && typeof prepared === "object" && !Array.isArray(prepared)) {
    const state = runState && typeof runState === "object" ? runState : {};
    if (!prepared.runId && typeof state.runId === "string") {
      prepared.runId = state.runId;
    }
    // AGRUN-240-followup — session lineage on every step.detail so onStep
    // consumers (inspector, replay tooling) can group events by owning
    // session and render parent → worker task trees. Same auto-inject
    // pattern as runId above; explicit detail values win on conflict.
    if (!prepared.sessionId && typeof state.sessionId === "string" && state.sessionId) {
      prepared.sessionId = state.sessionId;
    }
    if (prepared.parentSessionId == null && typeof state.parentSessionId === "string" && state.parentSessionId) {
      prepared.parentSessionId = state.parentSessionId;
    }
    if (prepared.cycle == null && Number.isInteger(state.cycleCount)) {
      prepared.cycle = state.cycleCount;
    }
    if (prepared.usage && typeof prepared.usage === "object") {
      prepared.usage = sanitizeUsageDetail(prepared, runState);
    }
  }

  recordRuntimeMetrics(type, prepared, runState);
  return prepared;
}

function createUsageDetail(response, fallback = {}) {
  return sanitizeUsageDetail({
    model: fallback.model,
    provider: fallback.provider,
    usage: response && typeof response === "object" ? response.usage : null
  }, null);
}

function recordRuntimeMetrics(type, detail, runState) {
  if (!runState || typeof runState !== "object") return;
  if (!runState.metrics || typeof runState.metrics !== "object") {
    runState.metrics = createRuntimeMetrics();
  }
  const metrics = runState.metrics;

  if (type === "planner-requested") {
    metrics.plannerCallCount = (metrics.plannerCallCount || 0) + 1;
  }

  if ((type === "provider-requested" || type === "planner-requested") && detail) {
    metrics.providerCallCount = (metrics.providerCallCount || 0) + 1;
  }

  if (
    detail &&
    (type === "action-executed" || type === "action-execute-error") &&
    Number.isFinite(detail.durationMs)
  ) {
    metrics.actionDurations.push({
      actionName: typeof detail.actionName === "string" ? detail.actionName : null,
      callId: typeof detail.callId === "string" ? detail.callId : null,
      durationMs: detail.durationMs,
      planIndex: Number.isInteger(detail.planIndex) ? detail.planIndex : null,
      status: type === "action-executed" ? "completed" : "failed"
    });
  }

  if (detail && detail.usage && typeof detail.usage === "object") {
    metrics.usage = accumulateUsage(metrics.usage, detail.usage);
    recordCostLedgerEntry(type, detail, runState);
  }
}

function recordCostLedgerEntry(type, detail, runState) {
  const ledger = runState && runState.costLedger;
  if (!ledger || typeof ledger !== "object") return;
  const usage = detail.usage;
  recordCostEntry(ledger, {
    phase: phaseFromStepType(type),
    callKind: type,
    provider: typeof detail.provider === "string"
      ? detail.provider
      : (typeof usage.provider === "string" ? usage.provider : null),
    model: typeof detail.model === "string"
      ? detail.model
      : (typeof usage.model === "string" ? usage.model : null),
    inputTokens: readFiniteNumber$7(usage.inputTokens),
    outputTokens: readFiniteNumber$7(usage.outputTokens),
    totalTokens: readFiniteNumber$7(usage.totalTokens),
    latencyMs: readFiniteNumber$7(detail.durationMs)
  });
}

function readFiniteNumber$7(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeUsageDetail(detail, runState) {
  const provider = detail && typeof detail.provider === "string"
    ? detail.provider
    : (runState && typeof runState.provider === "string" ? runState.provider : null);
  const snapshot = createUsageSnapshot({
    model: detail && typeof detail.model === "string" ? detail.model : null,
    provider,
    usage: detail && detail.usage && typeof detail.usage === "object" ? detail.usage : null
  });
  return snapshot || null;
}

export { createRuntimeMetrics, createUsageDetail, prepareRuntimeStepDetail };
