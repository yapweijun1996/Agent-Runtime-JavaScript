import { cloneValue } from './utils.js';
import { prepareRuntimeStepDetail } from './runtime-events.js';
import './tool-schema.js';
import './action-pattern-convergence.js';
import './runtime-event-classifier.js';
import { projectTodoTaskLifecycle } from './todo-task-lifecycle.js';

function createPushStep(steps, runState, onStep) {
  return (type, detail) => {
    const preparedDetail = prepareRuntimeStepDetail(type, detail, runState);
    const step = {
      type,
      detail: preparedDetail,
      timestamp: new Date().toISOString()
    };
    steps.push(step);
    runState.stepCount = steps.length;
    // AGRUN-248-C — dual-write into the typed event ledger. steps[] stays the
    // SSOT for back-compat onStep consumers; the ledger projection lets future
    // Inspector / replay code read one typed event stream.
    appendStepEventToLedger(runState, type, preparedDetail);
    notifyStep(onStep, step, runState);
  };
}

function appendStepEventToLedger(runState, type, detail) {
  const ledger = runState && runState.eventLedger;
  if (!ledger || typeof ledger.appendEvent !== "function") return;
  try {
    ledger.appendEvent({ type, detail, mode: "step" });
  } catch (_error) {
    // Ledger append must never break runtime; swallow defensively.
  }
}

function notifyStep(onStep, step, runState) {
  if (typeof onStep !== "function") {
    return;
  }

  try {
    onStep(cloneValue(step), createStepSnapshot(runState));
  } catch (error) {
    // Host step listeners must not break runtime execution.
  }
}

function createStepSnapshot(runState) {
  const state = runState && typeof runState === "object" ? runState : {};
  const todoTask = projectTodoTaskLifecycle(state);
  const todoState = state.todoState && typeof state.todoState === "object"
    ? cloneValue(state.todoState)
    : (state.todoState === null ? null : undefined);

  return {
    oodae: {
      currentPhase: state.oodae && typeof state.oodae === "object"
        ? state.oodae.currentPhase || null
        : null
    },
    phase: typeof state.phase === "string" ? state.phase : null,
    runId: typeof state.runId === "string" ? state.runId : null,
    metrics: state.metrics && typeof state.metrics === "object"
      ? cloneValue(state.metrics)
      : undefined,
    runState: createStepRunStateDebugSnapshot(state, { todoTask, todoState }),
    status: typeof state.status === "string" ? state.status : null,
    stepCount: Number.isInteger(state.stepCount) ? state.stepCount : 0,
    todoTask,
    todoState
  };
}

function createStepRunStateDebugSnapshot(state, options) {
  const snapshot = {};
  // AGRUN-266 — the convergence/terminal-repair family is part of the
  // host-facing run-state SSOT. It must ride the per-step debug snapshot
  // (read live via onStep / the browser Inspector through
  // projectInspectorRunState) using the SAME raw `cloneValue` shape the
  // result snapshot (snapshotRunState) and lastRun summary carry — so hosts
  // read `actionPatternConvergence.readOnlyPlanningState` (active / escalation
  // / ignoredCount / stepsWithoutProductiveProgress) directly instead of
  // parsing `terminalRepairState.reason` strings.
  const copyFields = [
    "actionPatternConvergence",
    "agentSkillContext",
    "approvalResumeFallbackUsed",
    "availableActions",
    "blockedPageEvidenceCount",
    "candidatePathMismatchSignal",
    "contextSnapshot",
    "controlEnvelopeConsumed",
    "controlEnvelopeKind",
    "continuingInterruptedTurn",
    "cycleCount",
    "evaluationState",
    "executionClass",
    "finalAnswerSource",
    "intentState",
    "invalidActionConvergence",
    "lastAction",
    "mode",
    "observation",
    "observationSummary",
    "oodae",
    "pendingApproval",
    "phase",
    "planner",
    "plannerModeSelection",
    "plannerState",
    "readAttemptSignal",
    "readinessContinuationSignal",
    "requestTypeAfterApproval",
    "researchContext",
    "researchEvidenceGraph",
    "researchAcceptanceEvaluator",
    "requirementRecoveryEvaluator",
    "researchFinalizeContract",
    "researchReportLoop",
    "researchState",
    "researchWorkspace",
    "runId",
    "runtimeBuildId",
    "selectedSkill",
    "sessionBudget",
    "sessionContextMeta",
    "sessionContextSource",
    "sessionContextView",
    "status",
    "stepCount",
    "strongReadSourceCount",
    "terminalRepairState",
    "terminalizedBy",
    "toolContext",
    "turnState",
    "usableReadSourceCount",
    "usedRuntimeFinalize",
    "virtualWorkspace"
  ];

  for (const field of copyFields) {
    if (Object.prototype.hasOwnProperty.call(state, field)) {
      snapshot[field] = cloneValue(state[field]);
    }
  }

  if (Object.prototype.hasOwnProperty.call(options, "todoTask")) {
    snapshot.todoTask = cloneValue(options.todoTask || null);
  }
  if (Object.prototype.hasOwnProperty.call(options, "todoState")) {
    snapshot.todoState = options.todoState === undefined ? undefined : cloneValue(options.todoState);
  }
  const events = readEventLedgerSnapshot(state);
  if (events) snapshot.eventLedger = events;

  return snapshot;
}

function readEventLedgerSnapshot(state) {
  const ledger = state && state.eventLedger;
  if (!ledger || typeof ledger.getEvents !== "function") return null;
  try {
    return cloneValue(ledger.getEvents());
  } catch (_error) {
    return null;
  }
}

export { createPushStep };
