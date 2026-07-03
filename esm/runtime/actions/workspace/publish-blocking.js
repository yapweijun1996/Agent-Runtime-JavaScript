import { PUBLISH_DIRECT_ACTION } from '../../action-names.js';
import { buildPublishPrescription } from '../../publish-prescription.js';
import { buildCitationCoverageAudit } from '../../candidate-quality-signal.js';
import { readString } from '../../semantic-json.js';

// Publish-block result builder + history/signal + output-guardrails, extracted
// from virtual-workspace-actions.js (AGRUN-451 slice 5 — component B of the
// publish-readiness cluster). createWorkspacePublishBlockedResult assembles the
// virtual_workspace_publish_blocked envelope (prescription-grade message +
// running block-history signal + candidate audit trail); the other four are its
// helpers. The cluster is closed: the only intra-cluster edges are
// createWorkspacePublishBlockedResult -> {normalizeOutputGuardrailBlock,
// recordPublishBlockHistoryAndSignal, collectCandidateAuditTrail}; nothing here
// calls back into virtual-workspace-actions.js. The publish executor imports
// createWorkspacePublishBlockedResult / runOutputGuardrails /
// collectCandidateAuditTrail back.


function createWorkspacePublishBlockedResult(options) {
  const file = options.file || {};
  const status = options.status || "blocked";
  const runState = options.context && options.context.runState && typeof options.context.runState === "object"
    ? options.context.runState
    : null;
  const outputGuardrailBlock = normalizeOutputGuardrailBlock(options.outputGuardrailBlock);
  const blockSignal = recordPublishBlockHistoryAndSignal(runState, status, {
    outputGuardrailBlock,
    reason: options.message
  });
  const sameStatusCount = blockSignal ? blockSignal.statusCounts[status] || 0 : 0;
  const totalCount = blockSignal ? blockSignal.count : 0;
  const cyclesUsed = blockSignal ? blockSignal.cyclesUsed : null;
  const cyclesMax = blockSignal ? blockSignal.cyclesMax : null;
  const cyclesRemaining = blockSignal ? blockSignal.cyclesRemaining : null;
  const counterPrefix = sameStatusCount > 1
    ? `[publish blocked attempt ${sameStatusCount} of status=${status}; total publish blocks this run=${totalCount}] `
    : `[publish blocked attempt 1 of status=${status}] `;
  const budgetSuffix = cyclesUsed != null && cyclesMax != null
    ? ` (cycles_used=${cyclesUsed}/${cyclesMax}${cyclesRemaining != null ? `, cycles_remaining=${cyclesRemaining}` : ""}; if you keep retrying without progress the run will hit maxSteps and force-stop with an error).`
    : "";
  // Prescription-grade feedback (weak-model trace walk 2026-06-10): the FIRST
  // rejection already names both exits (repair → ready, or honest limited with
  // the concrete args example) instead of waiting for an escalation ladder
  // that "responsive but wrong-direction" models never trigger.
  const publishPrescription = buildPublishPrescription({
    runState,
    status,
    citationCoverage: buildCitationCoverageAudit(
      typeof file.content === "string" ? file.content : "",
      runState
    )
  });
  const annotatedMessage = `${counterPrefix}${options.message}${budgetSuffix} ${publishPrescription.rule}`;
  const workspace = runState && runState.virtualWorkspace ? runState.virtualWorkspace : null;
  const candidatePathMismatchSignal = runState && runState.candidatePathMismatchSignal
    ? runState.candidatePathMismatchSignal
    : workspace && workspace.candidatePathMismatchSignal
      ? workspace.candidatePathMismatchSignal
      : null;
  return {
    control: "continue",
    output: {
      candidateAuditTrail: collectCandidateAuditTrail(workspace, file.path),
      candidateQualitySignal: options.candidateQualitySignal || null,
      candidatePathMismatchSignal,
      finalReadiness: options.finalReadiness || null,
      kind: "virtual_workspace_publish_blocked",
      message: annotatedMessage,
      outputGuardrailBlock,
      path: file.path || null,
      publishBlockSignal: blockSignal,
      publishPrescription,
      publishProtocol: options.publishProtocol || null,
      readinessAudit: options.readinessAudit || null,
      researchPublishReadinessRequired: options.researchPublishRequired === true,
      status,
      textStats: file.textStats || null
    },
    summary: `workspace_publish_candidate blocked(status=${status}, sameStatusCount=${sameStatusCount}, totalBlocks=${totalCount}${cyclesRemaining != null ? `, cycles_remaining=${cyclesRemaining}` : ""})`
  };
}

function normalizeOutputGuardrailBlock(value) {
  if (!value || typeof value !== "object") return null;
  return {
    info: value.info != null ? value.info : null,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : null,
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : null
  };
}

// ADR-0051 — run host-defined output guardrails over the publish-readiness
// FACTS. Returns the first { name, reason, info } block, or null if all pass.
// A guardrail is validation-only: it returns { block, reason?, info? } and
// never authors content. A throwing host guardrail must NOT crash the run —
// it is recorded (observable) and treated as non-blocking.
async function runOutputGuardrails(context, options) {
  const guardrails = context
    && context.runtimeConfig
    && Array.isArray(context.runtimeConfig.outputGuardrails)
    ? context.runtimeConfig.outputGuardrails
    : [];
  if (guardrails.length === 0) return null;
  const file = options.file || {};
  const args = {
    candidate: typeof file.content === "string" ? file.content : "",
    candidateQualitySignal: options.candidateQualitySignal || null,
    finalReadiness: options.finalReadiness || null,
    runState: context && context.runState ? context.runState : null
  };
  for (const guardrail of guardrails) {
    let result = null;
    try {
      result = await guardrail.execute(args);
    } catch (error) {
      if (context && typeof context.pushStep === "function") {
        context.pushStep("output-guardrail-error", {
          name: guardrail.name,
          error: error && error.message ? String(error.message) : String(error)
        });
      }
      continue;
    }
    if (result && typeof result === "object" && result.block === true) {
      const reason = typeof result.reason === "string" && result.reason.trim()
        ? result.reason.trim()
        : `Output guardrail "${guardrail.name}" blocked publish.`;
      return { name: guardrail.name, reason, info: result.info != null ? result.info : null };
    }
  }
  return null;
}

// Pure read-only projection of the workspace operations log filtered
// to the candidate path. Surfaced on both the success and blocked
// envelopes of workspace_publish_candidate so inspectors (and AI
// itself on retry) can see how the candidate evolved across cycles
// without runtime keeping any extra history. Capped at the last 12
// ops to keep payload bounded.
function collectCandidateAuditTrail(workspace, path) {
  if (!workspace || typeof workspace !== "object") return [];
  if (!Array.isArray(workspace.operations)) return [];
  const filePath = readString(path);
  if (!filePath) return [];
  return workspace.operations
    .filter((operation) => operation && operation.path === filePath)
    .slice(-12)
    .map((operation) => ({
      action: readString(operation.action) || "workspace",
      cycle: Number.isInteger(operation.cycle) ? operation.cycle : 0,
      status: readString(operation.status) || "ok",
      summary: readString(operation.summary)
    }));
}

// Push one entry into runState.publishBlockHistory and refresh
// runState.publishBlockSignal so the next planner cycle sees the
// running totals + maxSteps budget. Mirrors actionFailureSignal
// (ADR-0026) — read-only signal, runtime never decides when to stop.
function recordPublishBlockHistoryAndSignal(runState, status, options = {}) {
  if (!runState || typeof runState !== "object") return null;
  const cycle = Number.isInteger(runState.cycleCount) && runState.cycleCount >= 0
    ? runState.cycleCount
    : 0;
  if (!Array.isArray(runState.publishBlockHistory)) {
    runState.publishBlockHistory = [];
  }
  const outputGuardrailBlock = options.outputGuardrailBlock && typeof options.outputGuardrailBlock === "object"
    ? options.outputGuardrailBlock
    : null;
  const reason = readString(options.reason);
  runState.publishBlockHistory.push({
    actionName: PUBLISH_DIRECT_ACTION,
    cycle,
    outputGuardrailBlock,
    reason,
    status
  });
  // Cap history at 50 entries to keep snapshot/clone bounded.
  if (runState.publishBlockHistory.length > 50) {
    runState.publishBlockHistory.splice(0, runState.publishBlockHistory.length - 50);
  }
  const statusCounts = {};
  let lastStatus = null;
  let lastCycle = null;
  for (const entry of runState.publishBlockHistory) {
    const entryStatus = entry && typeof entry.status === "string" ? entry.status : "blocked";
    statusCounts[entryStatus] = (statusCounts[entryStatus] || 0) + 1;
    lastStatus = entryStatus;
    if (Number.isInteger(entry && entry.cycle)) lastCycle = entry.cycle;
  }
  const cyclesMax = Number.isInteger(runState.maxSteps) && runState.maxSteps > 0
    ? runState.maxSteps
    : null;
  const cyclesUsed = Number.isInteger(runState.cycleCount) && runState.cycleCount >= 0
    ? runState.cycleCount
    : null;
  const cyclesRemaining = cyclesMax != null && cyclesUsed != null
    ? Math.max(0, cyclesMax - cyclesUsed)
    : null;
  const signal = {
    count: runState.publishBlockHistory.length,
    cyclesMax,
    cyclesRemaining,
    cyclesUsed,
    kind: "publish_block_signal",
    lastCycle,
    lastStatus,
    outputGuardrailBlock,
    reason,
    statusCounts
  };
  runState.publishBlockSignal = signal;
  return signal;
}

export { collectCandidateAuditTrail, createWorkspacePublishBlockedResult, normalizeOutputGuardrailBlock, recordPublishBlockHistoryAndSignal, runOutputGuardrails };
