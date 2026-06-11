import { appendWebSearchOutput, appendResearchReadSource } from './search-research-context.js';
import { pushReadUrlRequestedStep, pushReadUrlCompletedStep, readResearchQuery, syncSearchInquiryContext, createResearchReadSource, syncReadInquiryContext, syncPendingClarification, shouldRefreshLongRunRequirementRecovery } from './action-loop-action-context.js';
import { createActionContext } from './action-loop-plan-validation.js';
import { recordToolContextResult, resolveToolHistoryCap, shouldRecordStructuredToolEvidence, recordStructuredToolEvidence } from './action-evidence.js';
import { executeActionWithTimeout, createActionTimeoutError } from './action-execute-timeout.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { markActionProgress } from './session-budget.js';
import { nextActionCallId } from './action-loop-utils.js';
import { normalizeActionResultEnvelope, createExecuteErrorEnvelope } from './action-result-envelope.js';
import { refreshActionGuardrail } from './action-guardrail-controller.js';
import { applyInvalidActionConvergenceOnSuccess } from './invalid-action-convergence.js';
import { sanitizeActionStepArgs } from './action-step-args.js';
import { cloneValue } from './utils.js';
import { normalizeThrownError } from './errors.js';
import { refreshActionPatternConvergence, shouldEmitActionPatternConvergenceRefreshed } from './action-pattern-convergence.js';
import { refreshRequirementRecoveryEvaluator } from './requirement-recovery-evaluator.js';
import { refreshReadUrlRecoverySignal } from './read-url-recovery-signal.js';
import { refreshResearchState } from './research-state.js';
import { refreshTerminalRepairState, buildTerminalRepairRefreshedStepDetail, shouldEmitAdvisoryPersistenceSignalStep } from './terminal-repair-state.js';
import { stampThreadProvenance } from './thread-provenance.js';
import { resetAgentHandoffChainForSkill, applyAgentHandoffToSession } from './handoff-input-filter.js';
import { maybeCreateTodoActionProgressDecision } from './todo-action-progress.js';
import { applyTodoRunNextToRunState } from './actions/todo-actions.js';

async function runPlanActions(session, planActions, maxParallel, partialOk) {
  const settled = await runWithConcurrency$1(planActions, maxParallel, (item) => (
    executePlanAction(session, item)
  ));
  const failures = settled.filter((entry) => entry.status === "rejected");

  if (failures.length > 0 && !partialOk) {
    return {
      failures,
      outputs: [],
      settled
    };
  }

  return {
    failures,
    outputs: await applySettledPlanResults(session, planActions, settled, partialOk),
    settled
  };
}

async function executePlanAction(session, item) {
  const callId = nextActionCallId(session.runState);
  const capturedSkillName = readToolSkillName(item.name, null, item.decision);
  const capturedToolName = readToolName(item.name, null, item.decision);

  const executingDetail = {
    actionName: item.name,
    callId,
    planIndex: item.index,
    skillName: capturedSkillName,
    toolName: capturedToolName
  };
  const argsDetail = sanitizeActionStepArgs(item.name, item.args);
  if (argsDetail) {
    executingDetail.args = argsDetail;
  }
  session.pushStep("action-executing", executingDetail);
  pushReadUrlRequestedStep(item.name, item.args, session.pushStep);

  const actionStartedAt = Date.now();
  try {
    // Same single-step timeout race as the single-action path — a hung
    // execute() (including a bundled skill tool's func) must not hang the
    // whole plan batch. Both timeout behaviors funnel into the plan's one
    // failure channel (settled rejected → planned_action_error observation).
    const execution = await executeActionWithTimeout(item.action, createActionContext(session), item.args);
    if (execution && execution.timedOut === true) {
      session.pushStep("action-timeout", {
        actionName: item.name,
        callId,
        cycle: session.runState.cycleCount,
        durationMs: Date.now() - actionStartedAt,
        error: execution.message,
        planIndex: item.index,
        timeoutBehavior: execution.timeoutBehavior,
        timeoutMs: execution.timeoutMs
      });
      throw createActionTimeoutError(execution.message, execution.timeoutMs, execution.timeoutBehavior);
    }
    // Envelope SSOT parity with the single path (action-loop-action.js):
    // normalize every raw result so malformed control/kind become structured
    // protocol-error envelopes instead of flowing downstream unchecked. The
    // `{ control, output, summary }` shim keeps the existing plan consumers
    // (applyActionSuccess / applyActionSideEffects) reading the same fields.
    const envelope = normalizeActionResultEnvelope({
      action: item.action,
      rawResult: execution.rawResult,
      durationMs: Date.now() - actionStartedAt
    });
    const actionResult = {
      control: envelope.control,
      output: envelope.body,
      summary: envelope.summary,
      envelope
    };
    // AGRUN-477 (audit M10) — guardrail accounting runs HERE, before the
    // onToolResult host hook (applyActionSuccess, execute_skill_tool only) can
    // rewrite output. Intentional and matched on the single path
    // (action-loop-action.js): the guardrail counts the RAW tool result — the
    // ground truth of what executed — not the host's post-processed view. The
    // no-progress output-hash path is moot for execute_skill_tool
    // (dynamicPermission → isReadOnly:false/isConcurrencySafe:false → not
    // isNoProgressTrackable); only ok/status drive its accounting here. If a
    // skill tool is ever marked read-only, the hash WOULD run on pre-hook
    // output — revisit this ordering then. See audit M10 disposition.
    refreshActionGuardrail({
      action: item.action,
      actionArgs: item.args,
      actionName: item.name,
      pushStep: session.pushStep,
      result: actionResult,
      runState: session.runState,
      runtimeConfig: session.runtimeConfig
    });
    session.pushStep("action-executed", {
      actionName: item.name,
      callId,
      control: envelope.control,
      durationMs: envelope.metrics.durationMs,
      kind: envelope.kind,
      planIndex: item.index,
      resultEnvelopeVersion: envelope.resultEnvelopeVersion,
      status: envelope.status,
      skillName: capturedSkillName || readToolSkillName(item.name, actionResult.output, item.decision),
      toolName: capturedToolName || readToolName(item.name, actionResult.output, item.decision)
    });
    return actionResult;
  } catch (error) {
    // Failure parity: the single path ticks guardrail failure counters on
    // every error envelope; plan failures must count the same so repeated
    // failing plan actions trip exact_failure/same_action thresholds.
    const errorEnvelope = createExecuteErrorEnvelope({
      action: item.action,
      error,
      durationMs: Date.now() - actionStartedAt
    });
    refreshActionGuardrail({
      action: item.action,
      actionArgs: item.args,
      actionName: item.name,
      pushStep: session.pushStep,
      result: {
        control: errorEnvelope.control,
        output: errorEnvelope.body,
        summary: errorEnvelope.summary,
        envelope: errorEnvelope
      },
      runState: session.runState,
      runtimeConfig: session.runtimeConfig
    });
    session.pushStep("action-execute-error", {
      actionName: item.name,
      callId,
      cycle: session.runState.cycleCount,
      durationMs: Date.now() - actionStartedAt,
      error: normalizeThrownError(error).message,
      planIndex: item.index
    });
    throw error;
  }
}

async function applySettledPlanResults(session, actions, settled, partialOk) {
  const outputs = [];
  for (let index = 0; index < actions.length; index += 1) {
    const item = actions[index];
    const entry = settled[index];
    // Audit H4 (AGRUN-482) — per-item error boundary. Applying one item's
    // side effects must not tear down the whole settled batch: with maxParallel
    // > 1 a mid-loop throw in applyActionSuccess (e.g. a malformed host output
    // flowing through refreshResearchState / handoff) would otherwise skip every
    // remaining item AND lose the already-applied items' outputs, leaving runState
    // half-mutated. We isolate the failure to this item, surface it as an
    // observable `plan-side-effect-error` step (NOT silently swallowed), and keep
    // the batch consistent by pushing an aligned error output. This is a
    // plan-only mechanism: the single-action path processes one action with no
    // sibling items to protect, so there is nothing to mirror on that door.
    try {
      if (entry.status === "fulfilled") {
        const actionResult = entry.value;
        await applyActionSuccess(session, item, actionResult);
        outputs.push(cloneValue(actionResult.output || null));
        continue;
      }
      if (partialOk) {
        const output = createPlanActionErrorOutput(item, entry.reason);
        applyActionFailure(session, item, output);
        outputs.push(cloneValue(output));
      }
    } catch (error) {
      const sideEffectOutput = createPlanActionErrorOutput(item, error);
      session.pushStep("plan-side-effect-error", {
        actionName: item.name,
        cycle: session.runState.cycleCount,
        error: normalizeThrownError(error).message,
        planIndex: item.index
      });
      outputs.push(cloneValue(sideEffectOutput));
    }
  }
  return outputs;
}

async function applyActionSuccess(session, item, actionResult) {
  let output = actionResult.output || null;
  if (item.name === "execute_skill_tool" && typeof session.onToolResult === "function") {
    output = await applyToolResultHook(session, item, output);
    actionResult.output = output;
  }

  pushReadUrlCompletedStep(
    item.name,
    output,
    readResearchQuery(session.runState, session.request),
    session.pushStep
  );
  await applyActionSideEffects(session, item, output);
  applyTodoActionProgress(session, item.name);
  // Session-budget parity with the single path: a successful plan action
  // ticks the same progress markers, so plan-heavy runs no longer evade the
  // no-progress counter (cross-cutting-dispatch-matrix-2026-06-10.md §3).
  markActionProgress(session.runState, item.name, output);
  // ADR-0034 / audit H2 (AGRUN-481) — dispatch-path parity: a successful plan
  // action clears the invalid-action convergence slot through the same SSOT the
  // single-action path uses. Previously the plan door never cleared it, so a
  // stale active=true signal could pollute the planner prompt for later cycles.
  applyInvalidActionConvergenceOnSuccess(session.runState, session.pushStep);
  session.runState.lastAction = item.name;
  session.runState.pendingApproval = null;
  refreshPlanActionPattern(session, item, output, `after_${item.name}`);
  session.actionHistory.push({
    actionName: item.name,
    kind: "plan_action",
    planIndex: item.index,
    summary: actionResult.summary
  });
}

function applyTodoActionProgress(session, actionName) {
  const decision = maybeCreateTodoActionProgressDecision(
    session.runState,
    session.runtimeConfig && session.runtimeConfig.todoAutopilot,
    { actionName }
  );
  if (!decision || decision.name !== "todo_run_next") return;

  const result = applyTodoRunNextToRunState(session.runState, decision.args, createActionContext(session));
  session.pushStep("todo-autopilot-action-progress", {
    actionName,
    summary: result.summary,
    todoAction: decision.name
  });
  session.actionHistory.push({
    actionName: decision.name,
    kind: "plan_action",
    summary: result.summary
  });
}

function applyActionFailure(session, item, output) {
  if (item.name === "execute_skill_tool") {
    // Audit H5 (AGRUN-483) — route through the shared capped recorder so a
    // failing skill tool cannot grow toolContext.history unbounded either.
    recordToolContextResult(session.runState, output, resolveToolHistoryCap(session.runtimeConfig));
  }
  session.actionHistory.push({
    actionName: item.name,
    error: output.error,
    kind: "action_error",
    planIndex: item.index,
    summary: `${item.name} failed in plan action ${item.index}: ${output.error}`
  });
  refreshPlanActionPattern(session, item, output, "plan_action_error");
}

function refreshPlanActionPattern(session, item, output, status) {
  const evaluator = refreshActionPatternConvergence(session.runState, {
    actionName: item && item.name,
    decision: item && item.decision,
    output,
    runtimeConfig: session && session.runtimeConfig,
    status
  });
  if (shouldEmitActionPatternConvergenceRefreshed(evaluator) && typeof session.pushStep === "function") {
    const signal = evaluator.convergenceSignal;
    session.pushStep("action-pattern-convergence-refreshed", {
      actionName: item && item.name,
      forbiddenMove: signal ? signal.forbiddenMove : null,
      patternKind: signal ? signal.patternKind : null,
      repeatedFingerprintCount: evaluator.repeatedFingerprintCount,
      repeatedSemanticFingerprintCount: evaluator.repeatedSemanticFingerprintCount,
      status: evaluator.status,
      stepsWithoutObservableProgress: evaluator.stepsWithoutObservableProgress
    });
  }
  const repair = refreshTerminalRepairState(session.runState, {
    actionName: item && item.name,
    decision: item && item.decision,
    output,
    // AGRUN-460 — forward runtimeConfig so host-overridden terminalRepair
    // thresholds + allowedActions/requiredRepair are honored on the plan door,
    // matching the single-action path instead of silently defaulting.
    runtimeConfig: session && session.runtimeConfig,
    status
  });
  if (repair && repair.active === true && typeof session.pushStep === "function") {
    const advisoryPersistenceSignal = repair.advisoryPersistenceSignal &&
      typeof repair.advisoryPersistenceSignal === "object"
      ? repair.advisoryPersistenceSignal
      : null;
    // AGRUN-480 (audit M1) — dispatch-path parity: build the step payload via the
    // shared SSOT so the plan door emits the same field set as the single path
    // (previously missing actionOrderingSignals/allowedActions/lengthExpansionSignal/status).
    session.pushStep(
      "terminal-repair-state-refreshed",
      buildTerminalRepairRefreshedStepDetail(repair, item && item.name, advisoryPersistenceSignal)
    );
    // AGRUN-459 — dispatch-path parity: emit the advisory-persistence step on the
    // plan batch path too, through the same SSOT gate the single-action and
    // onResponse paths use. Per-action mechanism, so it must land on every door.
    if (shouldEmitAdvisoryPersistenceSignalStep(advisoryPersistenceSignal)) {
      session.pushStep("terminal-repair-advisory-persistence-signal", advisoryPersistenceSignal);
    }
  }
  return evaluator;
}

function refreshPlanLongRunRequirementRecovery(session, actionName, status, output) {
  if (!session || typeof session !== "object") return null;
  if (!shouldRefreshLongRunRequirementRecovery(actionName, status)) return null;
  const recoveryEvaluator = refreshRequirementRecoveryEvaluator(session.runState, {
    actionName,
    output,
    prompt: session.request && session.request.prompt,
    request: session.request,
    runtimeConfig: session.runtimeConfig,
    status
  });
  if (recoveryEvaluator && typeof session.pushStep === "function") {
    const convergence = recoveryEvaluator.convergence && typeof recoveryEvaluator.convergence === "object"
      ? recoveryEvaluator.convergence
      : {};
    session.pushStep("requirement-recovery-evaluator-refreshed", {
      actionName,
      budgetState: convergence.budgetState || null,
      recommendedContract: convergence.recommendedContract || null,
      recoverableDeficitCount: Array.isArray(recoveryEvaluator.recoverableDeficits)
        ? recoveryEvaluator.recoverableDeficits.length
        : 0,
      repeatedInvalidTerminalCount: convergence.repeatedInvalidTerminalCount || 0,
      status: recoveryEvaluator.status,
      validLimitedAllowed: recoveryEvaluator.validLimitedAllowed !== false
    });
  }
  return recoveryEvaluator;
}

function refreshPlanReadUrlRecoverySignal(session, actionName, output) {
  const signal = refreshReadUrlRecoverySignal(session.runState, {
    actionName,
    output
  });
  if (signal && typeof session.pushStep === "function") {
    session.pushStep("read-url-recovery-signal-refreshed", {
      actionName,
      alternateSourceCount: Array.isArray(signal.alternateSourceCandidates)
        ? signal.alternateSourceCandidates.length
        : 0,
      failedUrl: signal.failedUrl || null,
      forbiddenMove: signal.forbiddenMove || null,
      retryable: signal.retryable === true,
      sameUrlAttemptCount: signal.sameUrlAttemptCount,
      status: signal.status
    });
  }
  return signal;
}

async function applyActionSideEffects(session, item, output) {
  const actionName = item && item.name;
  const runState = session.runState;
  if (actionName === "web_search") {
    runState.researchContext = appendWebSearchOutput(runState.researchContext, output, session.runtimeConfig);
    refreshResearchState(runState, {
      phase: "searching",
      prompt: session.request && session.request.prompt
    });
    syncSearchInquiryContext(runState, output);
    refreshPlanReadUrlRecoverySignal(session, actionName, output);
    refreshPlanLongRunRequirementRecovery(session, actionName, "after_web_search", output);
  }

  if (actionName === "read_url") {
    const readSource = stampThreadProvenance(
      cloneValue(createResearchReadSource(
        output,
        readResearchQuery(runState, session.request)
      )),
      runState
    );
    appendResearchReadSource(runState, readSource, session.runtimeConfig);
    refreshResearchState(runState, {
      phase: "evaluating",
      prompt: session.request && session.request.prompt
    });
    syncReadInquiryContext(runState, readSource);
    refreshPlanReadUrlRecoverySignal(session, actionName, output);
    refreshPlanLongRunRequirementRecovery(session, actionName, "after_read_url", output);
  }

  if (actionName === "ask_clarification") {
    syncPendingClarification(runState, output);
  }

  if (actionName === "list_agent_skills") {
    runState.agentSkillContext.catalogListed = true;
  }

  if (actionName === "read_agent_skill") {
    const skillRecord = cloneValue(output && output.skill || null);
    runState.agentSkillContext.lastReadSkill = skillRecord;
    // AGRUN-479 (audit M3) — dispatch-path parity with the single path
    // (action-loop-action.js read_agent_skill): per ADR-0013, mark the read
    // skill as selected so Inspector telemetry / isResearchQualityGateRequired
    // reflect actual skill engagement instead of n/a. Active skill
    // (use_agent_skill) still wins when present.
    if (skillRecord && !runState.agentSkillContext.activeSkill) {
      runState.selectedSkill = (skillRecord.name || skillRecord.skillId || null);
    }
    // AGRUN-479 (audit M2) — refresh the research phase on the plan path too;
    // the single path advances it for every skill action and the planner prompt
    // reads research phase, so a plan-batch skill action must not leave it stale.
    refreshResearchState(runState, {
      phase: "skill_loaded",
      prompt: session.request && session.request.prompt
    });
  }

  if (actionName === "use_agent_skill") {
    const selectedSkill = cloneValue(output && output.skill || null);
    runState.agentSkillContext.activeSkill = selectedSkill;
    resetAgentHandoffChainForSkill(runState.agentSkillContext, selectedSkill);
    // AGRUN-479 (audit M2) — research-phase parity with the single path.
    refreshResearchState(runState, {
      phase: "skill_active",
      prompt: session.request && session.request.prompt
    });
  }

  if (actionName === "handoff_to_skill") {
    await applyAgentHandoffToSession(session, output);
    // AGRUN-479 (audit M2) — research-phase parity with the single path.
    refreshResearchState(runState, {
      phase: "skill_active",
      prompt: session.request && session.request.prompt
    });
  }

  // Evidence parity with the single path: record structured tool evidence
  // for execute_skill_tool AND host custom evidence actions (gated by
  // evidencePolicy), not just execute_skill_tool
  // (cross-cutting-dispatch-matrix-2026-06-10.md §3).
  if (shouldRecordStructuredToolEvidence(actionName, session.runtimeConfig)) {
    recordStructuredToolEvidence(runState, output, session.runtimeConfig);
  }

  if (actionName !== "web_search" && actionName !== "read_url") {
    refreshPlanLongRunRequirementRecovery(session, actionName, `after_${actionName}`, output);
  }
}

async function applyToolResultHook(session, item, output) {
  // Raced — a hung host hook degrades to "ignored", never freezes the loop.
  const hook = await callHostHookWithTimeout(
    () => session.onToolResult(output, {
      actionName: item.name,
      decision: item.decision,
      runState: session.runState
    }),
    {
      hookName: "onToolResult",
      timeoutMs: session.runtimeConfig && session.runtimeConfig.hostHookTimeoutMs
    }
  );
  if (hook.ok) {
    return hook.value !== undefined ? hook.value : output;
  }
  session.debug.log(`onToolResult hook ${hook.timedOut ? "timed out" : "threw"}`, {
    error: hook.message,
    planIndex: item.index
  });
  return output;
}

async function runWithConcurrency$1(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit || 1), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index])
        };
      } catch (error) {
        results[index] = {
          reason: error,
          status: "rejected"
        };
      }
    }
  }));

  return results;
}

function createPlanActionErrorOutput(item, error) {
  return {
    actionName: item.name,
    error: normalizeThrownError(error).message,
    kind: "planned_action_error",
    ok: false,
    planIndex: item.index
  };
}

function readToolSkillName(actionName, output, decision) {
  if (actionName !== "execute_skill_tool") return undefined;
  return readString$m(output && output.skill) ||
    readString$m(decision && decision.args && decision.args.skillName) ||
    undefined;
}

function readToolName(actionName, output, decision) {
  if (actionName !== "execute_skill_tool") return undefined;
  return readString$m(output && output.tool) ||
    readString$m(decision && decision.args && decision.args.toolName) ||
    undefined;
}

function readString$m(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { runPlanActions };
