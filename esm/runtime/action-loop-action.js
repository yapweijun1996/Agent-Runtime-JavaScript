import { readString } from './semantic-json.js';
import { PUBLISH_DIRECT_ACTION, FINALIZE_CANDIDATE_ACTION } from './kernel-terminal-actions.js';
import { ERROR_CODES, normalizeThrownError, serializeError } from './errors.js';
import { finalizeActionLoopFailure } from './action-loop-failure.js';
import { handleActionResult } from './action-loop-action-result.js';
import { cloneValue } from './utils.js';
import './tool-schema.js';
import { stampThreadProvenance } from './thread-provenance.js';
import { refreshActionGuardrail, evaluateActionGuardrailBefore, createActionGuardrailSyntheticResult } from './action-guardrail-controller.js';
import { refreshActionPatternConvergence, shouldEmitActionPatternConvergenceRefreshed } from './action-pattern-convergence.js';
import { refreshRequirementRecoveryEvaluator } from './requirement-recovery-evaluator.js';
import { refreshReadUrlRecoverySignal } from './read-url-recovery-signal.js';
import { refreshResearchState } from './research-state.js';
import { markActionProgress } from './session-budget.js';
import { refreshTerminalRepairState, buildTerminalRepairRefreshedStepDetail, shouldEmitAdvisoryPersistenceSignalStep, explainTerminalRepairPublishArgs, buildBudgetRemainingForExpansionSignal, isPublishProtocolRequiredActionForRepair } from './terminal-repair-state.js';
import { applyInvalidActionConvergenceOnSuccess } from './invalid-action-convergence.js';
import { inspectWorkspacePublishProtocol } from './virtual-workspace.js';
import './runtime-event-classifier.js';
import { readActionArgs, readWebSearchEndpoint, nextActionCallId } from './action-loop-utils.js';
import { sanitizeActionStepArgs } from './action-step-args.js';
import { validateActionArgs } from './action-args-validation.js';
import { fingerprintAction } from './action-fingerprint.js';
import { appendWebSearchOutput, appendResearchReadSource } from './search-research-context.js';
import { createRuntimeStreamEmitter } from './provider-stream-events.js';
import { isResearchQualityGateRequired } from './convergence-activation.js';
import { DEFAULT_TERMINAL_REPAIR_STRINGS } from './terminal-repair-strings.js';
import { maybeCreateTodoActionProgressDecision } from './todo-action-progress.js';
import { applyTodoRunNextToRunState } from './actions/todo-actions.js';
import { pushReadUrlRequestedStep, pushReadUrlCompletedStep, readResearchQuery, syncSearchInquiryContext, createResearchReadSource, syncReadInquiryContext, syncPendingClarification, shouldRefreshLongRunRequirementRecovery } from './action-loop-action-context.js';
import { resetAgentHandoffChainForSkill, applyAgentHandoffToSession } from './handoff-input-filter.js';
import { normalizeActionResultEnvelope, createExecuteErrorEnvelope, createProtocolErrorEnvelope, envelopeToObservation } from './action-result-envelope.js';
import { executeActionWithTimeout, ACTION_TIMEOUT_REASON, buildActionTimeoutMessage } from './action-execute-timeout.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { buildValidLimitedPublishArgsExample } from './publish-prescription.js';
import { shouldRecordStructuredToolEvidence, recordStructuredToolEvidence } from './action-evidence.js';

const LATE_BUDGET_PATCH_PREVIEW_ACTIONS = new Set([
  "workspace_propose_patch"
]);

const LATE_BUDGET_WORKSPACE_MUTATION_ACTIONS = new Set([
  "workspace_apply_patch",
  "workspace_insert_after_section",
  "workspace_move",
  "workspace_multi_edit",
  "workspace_remove",
  "workspace_replace",
  "workspace_write"
]);


async function executeAction(options) {
  const {
    actionHistory,
    actionName,
    actionRegistry,
    agentSkillIndexProvider,
    agentSkills,
    cycleRecord,
    decision,
    memoryEntriesAdded,
    normalizedInput,
    onStreamEvent,
    pushStep,
    rawInput,
    request,
    runtimeConfig,
    runState,
    runtimeState,
    spawnSubagent,
    steps
  } = options;
  const debug = options.debug;
  const action = actionRegistry.get(actionName);
  const streamEmitter = createRuntimeStreamEmitter(onStreamEvent, {
    actionName,
    ledger: runState && runState.eventLedger,
    runId: runState && runState.runId
  });
  let actionArgs = readActionArgs(decision);

  if (debug && debug.enabled) {
    debug.log(`action dispatch | ${actionName}`, {
      resolved: !!action,
      args: actionArgs
    });
  }

  if (!action) {
    return {
      done: true,
      result: finalizeActionLoopFailure({
        code: ERROR_CODES.PLANNER_INVALID_ACTION,
        cycleRecord,
        memoryEntriesAdded,
        normalizedInput,
        output: null,
        pushStep,
        rawInput,
        runState,
        runtimeState,
        steps
      })
    };
  }

  const validation = validateActionArgs(action, actionArgs);
  if (validation.ok && Array.isArray(validation.aliasRewrites) && validation.aliasRewrites.length > 0) {
    pushStep("action-args-alias-rewrite", {
      actionName,
      rewrites: validation.aliasRewrites
    });
    if (validation.normalizedArgs && typeof validation.normalizedArgs === "object") {
      actionArgs = validation.normalizedArgs;
    }
  }
  if (!validation.ok) {
    pushStep("action-args-invalid", {
      actionName,
      error: validation.error,
      key: validation.key,
      reason: validation.reason
    });
    // ADR-0013 — validation errors are recoverable; helper surfaces the
    // failure as observation. No fatal terminator; maxSteps is the only
    // upper bound for action errors.
    return recordRecoverableActionError({
      stage: "validation",
      actionName,
      decision,
      errorMessage: validation.error,
      validationReason: validation.reason,
      validationKey: validation.key,
      actionHistory,
      pushStep,
      runState,
      runtimeConfig
    });
  }

  if (typeof action.preflight === "function") {
    try {
      action.preflight({
        activeAgentSkill: runState.agentSkillContext.activeSkill,
        agentSkillIndexProvider,
        agentSkills: Array.isArray(agentSkills) ? agentSkills : [],
        agentSkillContext: runState.agentSkillContext,
        debug: debug || null,
        pushStep,
        request,
        runState,
        runtimeConfig,
        searchResults: runState.researchContext.searchResults,
        webSearchEndpoint: readWebSearchEndpoint(rawInput, request)
      }, actionArgs);
    } catch (error) {
      const preflightError = normalizeThrownError(error).message;
      pushStep("action-args-invalid", {
        actionName,
        error: preflightError,
        key: null,
        reason: "preflight"
      });
      // ADR-0013 — preflight errors are recoverable; helper surfaces as observation.
      return recordRecoverableActionError({
        stage: "preflight",
        actionName,
        decision,
        errorMessage: preflightError,
        actionHistory,
        pushStep,
        runState,
        runtimeConfig
      });
    }
  }

  const actionPatternBlock = maybeBlockActionPatternRepeat({
    actionArgs,
    actionName,
    decision,
    request,
    pushStep,
    runState
  });
  if (actionPatternBlock) {
    actionHistory.push({
      actionName,
      kind: "action_pattern_blocked",
      summary: actionPatternBlock.message
    });
    runState.lastAction = actionName;
    runState.observation = {
      actionName,
      kind: "action_pattern_blocked",
      message: actionPatternBlock.message,
      output: actionPatternBlock.output
    };
    refreshActionPattern({
      actionName,
      decision,
      output: actionPatternBlock.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "action_pattern_preflight_block"
    });
    refreshTerminalRepair({
      actionName,
      decision,
      output: actionPatternBlock.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "action_pattern_preflight_block"
    });
    return { done: false };
  }

  refreshTerminalRepair({
    actionName,
    decision,
    output: null,
    pushStep,
    runState,
    runtimeConfig,
    status: "before_action"
  });

  const terminalRepairBlock = maybeBlockTerminalRepairAction({
    actionArgs,
    actionName,
    decision,
    pushStep,
    runState
  });
  if (terminalRepairBlock) {
    actionHistory.push({
      actionName,
      kind: "terminal_repair_blocked",
      summary: terminalRepairBlock.message
    });
    runState.lastAction = actionName;
    runState.observation = {
      actionName,
      kind: "terminal_repair_blocked",
      message: terminalRepairBlock.message,
      output: terminalRepairBlock.output
    };
    refreshActionPattern({
      actionName,
      decision,
      output: terminalRepairBlock.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "terminal_repair_preflight_block"
    });
    refreshTerminalRepair({
      actionName,
      decision,
      output: terminalRepairBlock.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "terminal_repair_preflight_block"
    });
    return { done: false };
  }

  const terminalCorrectionBlock = maybeBlockTerminalCorrectionRetry({
    actionArgs,
    actionName,
    decision,
    pushStep,
    runState
  });
  if (terminalCorrectionBlock) {
    actionHistory.push({
      actionName,
      kind: "terminal_correction_blocked",
      summary: terminalCorrectionBlock.message
    });
    runState.lastAction = actionName;
    runState.observation = {
      actionName,
      kind: "terminal_correction_blocked",
      message: terminalCorrectionBlock.message,
      output: terminalCorrectionBlock.output
    };
    refreshActionPattern({
      actionName,
      decision,
      output: terminalCorrectionBlock.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "terminal_correction_preflight_block"
    });
    refreshTerminalRepair({
      actionName,
      decision,
      output: terminalCorrectionBlock.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "terminal_correction_preflight_block"
    });
    return { done: false };
  }

  const guardrailBlock = maybeBlockActionGuardrail({
    action,
    actionArgs,
    actionName,
    pushStep,
    runState,
    runtimeConfig
  });
  if (guardrailBlock) {
    actionHistory.push({
      actionName,
      kind: "action_guardrail_blocked",
      summary: guardrailBlock.message
    });
    runState.lastAction = actionName;
    runState.observation = {
      actionName,
      kind: "action_guardrail_blocked",
      message: guardrailBlock.message,
      output: guardrailBlock.result.output
    };
    refreshActionPattern({
      actionName,
      decision,
      output: guardrailBlock.result.output,
      pushStep,
      runState,
      runtimeConfig,
      status: "action_guardrail_preflight_block"
    });
    return { done: false };
  }

  const callId = nextActionCallId(runState);
  const capturedSkillName = readToolSkillName$1(actionName, runState, null, decision);
  const capturedToolName = readToolName$1(actionName, null, decision);
  pushStep("action-executing", readActionStepDetail({
    actionName,
    actionArgs,
    callId,
    skillName: capturedSkillName,
    toolName: capturedToolName
  }));
  streamEmitter.emit("action-executing", {
    actionName,
    callId,
    skillName: capturedSkillName,
    toolName: capturedToolName
  });
  pushReadUrlRequestedStep(actionName, actionArgs, pushStep);

  const actionStartedAt = Date.now();
  try {
    const actionContext = {
      activeAgentSkill: runState.agentSkillContext.activeSkill,
      agentSkillIndexProvider,
      agentSkills: Array.isArray(agentSkills) ? agentSkills : [],
      agentSkillContext: runState.agentSkillContext,
      debug: debug || null,
      pushStep,
      request,
      runState,
      runtimeConfig,
      searchResults: runState.researchContext.searchResults,
      // ADR-0037 — spawn_subagent capability for the orchestrator-worker
      // pattern. Null when run-loop.js did not thread runLoop into
      // options; the spawn_subagent action handles the null case.
      spawnSubagent: typeof spawnSubagent === "function" ? spawnSubagent : null,
      webSearchEndpoint: readWebSearchEndpoint(rawInput, request)
    };
    const execution = await executeActionWithTimeout(action, actionContext, actionArgs);
    const actionDurationMs = Date.now() - actionStartedAt;
    if (execution && execution.timedOut === true) {
      const timeoutEnvelope = createActionTimeoutEnvelope({
        action,
        durationMs: actionDurationMs,
        timeoutMs: execution.timeoutMs
      });
      const actionTimeoutDetail = {
        actionName,
        callId,
        durationMs: timeoutEnvelope.metrics.durationMs,
        error: execution.message,
        cycle: runState.cycleCount,
        kind: timeoutEnvelope.body.kind,
        reason: timeoutEnvelope.reason,
        resultEnvelopeVersion: timeoutEnvelope.resultEnvelopeVersion,
        status: timeoutEnvelope.status,
        timeoutBehavior: execution.timeoutBehavior,
        timeoutMs: execution.timeoutMs
      };
      pushStep("action-timeout", actionTimeoutDetail);
      streamEmitter.emit("action-error", actionTimeoutDetail);
      pushStep("action-timeout-self-correcting", {
        actionName,
        attempt: (runState.selfCorrectionCount || 0) + 1,
        error: execution.message,
        timeoutBehavior: execution.timeoutBehavior,
        timeoutMs: execution.timeoutMs
      });
      refreshActionGuardrail({
        action,
        actionArgs,
        actionName,
        pushStep,
        result: {
          control: timeoutEnvelope.control,
          output: timeoutEnvelope.body,
          summary: timeoutEnvelope.summary,
          envelope: timeoutEnvelope
        },
        runState,
        runtimeConfig
      });
      return recordRecoverableActionError({
        stage: "execute",
        actionName,
        decision,
        envelope: timeoutEnvelope,
        errorMessage: execution.message,
        actionHistory,
        pushStep,
        runState,
        runtimeConfig
      });
    }
    const rawResult = execution.rawResult;
    const envelope = normalizeActionResultEnvelope({
      action,
      rawResult,
      durationMs: actionDurationMs
    });
    // Shim keeps the legacy `{ control, output, summary }` shape so the
    // many downstream consumers (refreshActionGuardrail, syncSearchInquiryContext,
    // recordObservation, handleActionResult, ...) keep reading body fields via
    // `.output.*`. `.envelope` carries the v1 SSOT envelope for new consumers.
    const actionResult = {
      control: envelope.control,
      output: envelope.body,
      summary: envelope.summary,
      envelope
    };
    // AGRUN-477 (audit M10) — guardrail accounting runs HERE, before the
    // onToolResult host hook below (execute_skill_tool only) can rewrite
    // output. Intentional and matched on the plan path
    // (action-loop-plan-actions.js): the guardrail counts the RAW tool result —
    // the ground truth of what executed — not the host's post-processed view.
    // The no-progress output-hash path is moot for execute_skill_tool
    // (dynamicPermission → isReadOnly:false/isConcurrencySafe:false → not
    // isNoProgressTrackable); only ok/status drive its accounting here. If a
    // skill tool is ever marked read-only, the hash WOULD run on pre-hook
    // output — revisit this ordering then. See audit M10 disposition.
    refreshActionGuardrail({
      action,
      actionArgs,
      actionName,
      pushStep,
      result: actionResult,
      runState,
      runtimeConfig
    });

    const actionExecutedDetail = {
      actionName,
      callId,
      control: envelope.control,
      durationMs: envelope.metrics.durationMs,
      kind: envelope.kind,
      resultCount: envelope.metrics.resultCount == null ? undefined : envelope.metrics.resultCount,
      resultEnvelopeVersion: envelope.resultEnvelopeVersion,
      status: envelope.status,
      skillName: capturedSkillName || readToolSkillName$1(actionName, runState, actionResult.output, decision),
      toolName: capturedToolName || readToolName$1(actionName, actionResult.output, decision)
    };
    pushStep("action-executed", actionExecutedDetail);
    streamEmitter.emit("action-executed", actionExecutedDetail);
    // ADR-0034 — clear invalid-action convergence once a real action executes.
    // SSOT shared with the plan batch path (audit H2 / AGRUN-481).
    applyInvalidActionConvergenceOnSuccess(runState, pushStep);
    pushReadUrlCompletedStep(
      actionName,
      actionResult.output,
      readResearchQuery(runState, request),
      pushStep
    );
    runState.actState = {
      actionName,
      control: envelope.control,
      outputKind: envelope.kind
    };
    runState.lastAction = actionName;
    runState.pendingApproval = null;
    // A successful action clears prior self-correction debt so a recovered
    // agent keeps full retry budget for future issues. Without this, a
    // recovered run burns through maxRetries from unrelated earlier failures.
    if (typeof runState.selfCorrectionCount === "number" && runState.selfCorrectionCount > 0) {
      runState.selfCorrectionCount = 0;
    }
    actionHistory.push({
      actionName,
      kind: "action",
      summary: actionResult.summary
    });

    if (actionName === "web_search") {
      runState.researchContext = appendWebSearchOutput(
        runState.researchContext,
        actionResult.output,
        runtimeConfig
      );
      refreshResearchState(runState, {
        phase: "searching",
        prompt: request && request.prompt
      });
      syncSearchInquiryContext(runState, actionResult.output);
      refreshReadUrlRecovery({
        actionName,
        output: actionResult.output,
        pushStep,
        runState
      });
      refreshLongRunRequirementRecovery({
        actionName,
        pushStep,
        request,
        runState,
        runtimeConfig,
        output: actionResult.output,
        status: "after_web_search"
      });
    }

    if (actionName === "read_url") {
      const readSource = stampThreadProvenance(
        cloneValue(createResearchReadSource(
          actionResult.output,
          readResearchQuery(runState, request)
        )),
        runState
      );
      appendResearchReadSource(runState, readSource, runtimeConfig);
      refreshResearchState(runState, {
        phase: "evaluating",
        prompt: request && request.prompt
      });
      syncReadInquiryContext(runState, readSource);
      refreshReadUrlRecovery({
        actionName,
        output: actionResult.output,
        pushStep,
        runState
      });
      refreshLongRunRequirementRecovery({
        actionName,
        pushStep,
        request,
        runState,
        runtimeConfig,
        output: actionResult.output,
        status: "after_read_url"
      });
    }

    const todoProgressDecision = maybeCreateTodoActionProgressDecision(
      runState,
      runtimeConfig && runtimeConfig.todoAutopilot,
      { actionName }
    );
    if (todoProgressDecision && todoProgressDecision.name === "todo_run_next") {
      const todoProgressResult = applyTodoRunNextToRunState(runState, todoProgressDecision.args, {
        pushStep,
        request,
        runState,
        runtimeConfig
      });
      pushStep("todo-autopilot-action-progress", {
        actionName,
        summary: todoProgressResult.summary,
        todoAction: todoProgressDecision.name
      });
      actionHistory.push({
        actionName: todoProgressDecision.name,
        kind: "action",
        summary: todoProgressResult.summary
      });
    }

    if (actionName === "ask_clarification") {
      syncPendingClarification(runState, actionResult.output);
    }

    if (actionName === "list_agent_skills") {
      runState.agentSkillContext.catalogListed = true;
    }

    if (actionName === "read_agent_skill") {
      const skillRecord = cloneValue(actionResult.output.skill || null);
      runState.agentSkillContext.lastReadSkill = skillRecord;
      // ADR-0013: when AI engages a skill via read_agent_skill, mark it as
      // the selected skill so Inspector telemetry, isResearchQualityGateRequired
      // and downstream consumers reflect actual skill engagement instead of
      // n/a. Active skill (set by use_agent_skill) still wins when present.
      if (skillRecord && !runState.agentSkillContext.activeSkill) {
        runState.selectedSkill = (skillRecord.name || skillRecord.skillId || null);
      }
      refreshResearchState(runState, {
        phase: "skill_loaded",
        prompt: request && request.prompt
      });
    }

    if (actionName === "use_agent_skill") {
      const selectedSkill = cloneValue(actionResult.output.skill || null);
      runState.agentSkillContext.activeSkill = selectedSkill;
      resetAgentHandoffChainForSkill(runState.agentSkillContext, selectedSkill);
      refreshResearchState(runState, {
        phase: "skill_active",
        prompt: request && request.prompt
      });
    }

    if (actionName === "handoff_to_skill") {
      await applyAgentHandoffToSession({
        actionHistory,
        pushStep,
        request,
        runState,
        runtimeConfig
      }, actionResult.output);
      refreshResearchState(runState, {
        phase: "skill_active",
        prompt: request && request.prompt
      });
    }

    if (actionName === "execute_skill_tool") {
      // Hook: allow caller to augment/replace tool result before it becomes
      // lastResult visible to the planner. Raced — a hung host hook degrades
      // to "ignored", never freezes the loop.
      if (typeof options.onToolResult === "function") {
        const hook = await callHostHookWithTimeout(
          () => options.onToolResult(actionResult.output, {
            actionName,
            decision,
            runState
          }),
          {
            hookName: "onToolResult",
            timeoutMs: runtimeConfig && runtimeConfig.hostHookTimeoutMs
          }
        );
        if (hook.ok) {
          if (hook.value !== undefined) {
            actionResult.output = hook.value;
          }
        } else if (debug && debug.enabled) {
          debug.log(`onToolResult hook ${hook.timedOut ? "timed out" : "threw"}`, {
            error: hook.message
          });
        }
      }
    }

    if (shouldRecordStructuredToolEvidence(actionName, runtimeConfig)) {
      recordStructuredToolEvidence(runState, actionResult.output, runtimeConfig);
    }

    if (actionName !== "web_search" && actionName !== "read_url") {
      refreshLongRunRequirementRecovery({
        actionName,
        pushStep,
        request,
        runState,
        runtimeConfig,
        output: actionResult.output,
        status: `after_${actionName}`
      });
    }

    markActionProgress(runState, actionName, actionResult.output);
    refreshActionPattern({
      actionName,
      decision,
      output: actionResult.output,
      pushStep,
      runState,
      runtimeConfig,
      status: `after_${actionName}`
    });
    refreshTerminalRepair({
      actionName,
      decision,
      output: actionResult.output,
      pushStep,
      runState,
      runtimeConfig,
      status: `after_${actionName}`
    });

    // AGRUN-313 2.1 (litmus burn-down) — stamp the terminal action's generic
    // publish-direct capability on runState so downstream generic code routes on
    // the flag, not the literal action name. `action` is the resolved registry
    // definition (actionRegistry.get above); the flag reflects the terminal
    // action because the loop ends once an action completes.
    runState.terminalActionPublishDirect = !!(action && action.publishDirect);

    return handleActionResult({
      actionName,
      actionResult,
      cycleRecord,
      memoryEntriesAdded,
      normalizedInput,
      output: cloneValue(actionResult.output),
      pushStep,
      rawInput,
      request,
      runState,
      runtimeState,
      steps
    });
  } catch (error) {
    const actionDurationMs = Date.now() - actionStartedAt;
    const errorEnvelope = createExecuteErrorEnvelope({
      action,
      error,
      durationMs: actionDurationMs
    });
    const { message: errorMessage } = normalizeThrownError(error);
    const serializedError = serializeError(error);

    const actionErrorDetail = {
      actionName,
      callId,
      durationMs: errorEnvelope.metrics.durationMs,
      error: errorMessage,
      errorName: serializedError.name,
      errorCode: serializedError.code || null,
      cycle: runState.cycleCount,
      kind: errorEnvelope.kind,
      resultEnvelopeVersion: errorEnvelope.resultEnvelopeVersion,
      status: errorEnvelope.status
    };
    pushStep("action-execute-error", actionErrorDetail);
    streamEmitter.emit("action-error", actionErrorDetail);

    if (debug && debug.enabled) {
      debug.log(`action error | ${actionName}`, { error: errorMessage });
    }

    pushStep("action-error-self-correcting", {
      actionName,
      attempt: (runState.selfCorrectionCount || 0) + 1,
      error: errorMessage
    });

    // ADR-0013 — action execute errors are recoverable observations.
    // The previous canSelfCorrect / fatal split has been removed; every
    // throw flows through the same observation path so the planner can
    // react. maxSteps and explicit caller abort are the only run terminators.
    // AGRUN-248-B — the error envelope is the SSOT shape; the legacy
    // synthetic `result: { control, output, summary }` is now derived from
    // the envelope so guardrail accounting and observation derivation read
    // the same fields whether the action succeeded or threw.
    refreshActionGuardrail({
      action,
      actionArgs,
      actionName,
      pushStep,
      result: {
        control: errorEnvelope.control,
        output: errorEnvelope.body,
        summary: errorEnvelope.summary,
        envelope: errorEnvelope
      },
      runState,
      runtimeConfig
    });
    return recordRecoverableActionError({
      stage: "execute",
      actionName,
      decision,
      envelope: errorEnvelope,
      errorMessage,
      actionHistory,
      pushStep,
      runState,
      runtimeConfig
    });
  }
}

function createActionTimeoutEnvelope({ action, durationMs, timeoutMs }) {
  const actionName = action && action.name;
  const message = buildActionTimeoutMessage(actionName, timeoutMs);
  return createProtocolErrorEnvelope({
    actionName,
    durationMs,
    reason: ACTION_TIMEOUT_REASON,
    summary: `${actionName} failed: ${message}. The planner should try a different approach.`,
    body: {
      error: message,
      errorStage: "execute",
      kind: "action_loop_failure",
      ok: false,
      reason: ACTION_TIMEOUT_REASON,
      status: "failed",
      timeoutMs
    }
  });
}

function maybeBlockActionGuardrail(options) {
  const runtimeConfig = options && options.runtimeConfig;
  const guardrailConfig = runtimeConfig && runtimeConfig.actionGuardrail;
  const decision = evaluateActionGuardrailBefore(
    options && options.runState && options.runState.actionGuardrail,
    options && options.action,
    options && options.actionArgs,
    guardrailConfig
  );
  if (!decision || decision.action === "allow" || decision.action === "warn") return null;
  const result = createActionGuardrailSyntheticResult(decision);
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-guardrail-blocked", {
      actionName: options.actionName,
      code: decision.code,
      count: decision.count,
      guardrailAction: decision.action
    });
  }
  return { message: decision.message, result };
}

function readActionStepDetail({ actionName, actionArgs, callId, skillName, toolName }) {
  const detail = {
    actionName,
    callId,
    skillName,
    toolName
  };
  const argsDetail = sanitizeActionStepArgs(actionName, actionArgs);
  if (argsDetail) {
    detail.args = argsDetail;
  }
  return detail;
}

function readToolSkillName$1(actionName, runState, output, decision) {
  if (actionName !== "execute_skill_tool") {
    return undefined;
  }

  const explicitOutput = readString(output && output.skill);
  if (explicitOutput) {
    return explicitOutput;
  }

  const explicitDecision = readString(decision && decision.args && decision.args.skillName);
  if (explicitDecision) {
    return explicitDecision;
  }

  return readString(runState.agentSkillContext && runState.agentSkillContext.activeSkill && runState.agentSkillContext.activeSkill.name) || undefined;
}

function readToolName$1(actionName, output, decision) {
  if (actionName !== "execute_skill_tool") {
    return undefined;
  }

  return readString(output && output.tool) ||
    readString(decision && decision.args && decision.args.toolName) ||
    undefined;
}

function refreshLongRunRequirementRecovery(options) {
  if (!options || typeof options !== "object") return null;
  const actionName = readString(options && options.actionName);
  const status = readString(options && options.status);
  if (!shouldRefreshLongRunRequirementRecovery(actionName, status)) return null;
  const recoveryEvaluator = refreshRequirementRecoveryEvaluator(options.runState, {
    actionName,
    output: options.output,
    prompt: options.request && options.request.prompt,
    request: options.request,
    runtimeConfig: options.runtimeConfig,
    status
  });
  if (recoveryEvaluator && typeof options.pushStep === "function") {
    const convergence = recoveryEvaluator.convergence && typeof recoveryEvaluator.convergence === "object"
      ? recoveryEvaluator.convergence
      : {};
    options.pushStep("requirement-recovery-evaluator-refreshed", {
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

function refreshReadUrlRecovery(options) {
  if (!options || typeof options !== "object") return null;
  const signal = refreshReadUrlRecoverySignal(options.runState, {
    actionName: options.actionName,
    output: options.output
  });
  if (signal && typeof options.pushStep === "function") {
    options.pushStep("read-url-recovery-signal-refreshed", {
      actionName: options.actionName,
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

function refreshActionPattern(options) {
  if (!options || typeof options !== "object") return null;
  const evaluator = refreshActionPatternConvergence(options.runState, {
    actionName: options.actionName,
    decision: options.decision,
    output: options.output,
    runtimeConfig: options.runtimeConfig,
    status: options.status
  });
  if (shouldEmitActionPatternConvergenceRefreshed(evaluator) && typeof options.pushStep === "function") {
    const signal = evaluator.convergenceSignal;
    options.pushStep("action-pattern-convergence-refreshed", {
      actionName: options.actionName,
      forbiddenMove: signal ? signal.forbiddenMove : null,
      patternKind: signal ? signal.patternKind : null,
      repeatedFingerprintCount: evaluator.repeatedFingerprintCount,
      repeatedSemanticFingerprintCount: evaluator.repeatedSemanticFingerprintCount,
      terminalRetryCooldownActive: evaluator.terminalRetryCooldown
        ? evaluator.terminalRetryCooldown.active === true
        : false,
      blockedTerminalRetryCount: evaluator.terminalRetryCooldown
        ? evaluator.terminalRetryCooldown.blockedTerminalRetryCount
        : 0,
      executedPublishCount: evaluator.terminalRetryCooldown
        ? evaluator.terminalRetryCooldown.executedPublishCount
        : 0,
      consecutiveExecutedPublishCount: evaluator.terminalRetryCooldown
        ? evaluator.terminalRetryCooldown.consecutiveExecutedPublishCount
        : 0,
      structureRepairActive: evaluator.structureRepairConvergence
        ? evaluator.structureRepairConvergence.active === true
        : false,
      repeatedStructureNoProgressCount: evaluator.structureRepairConvergence
        ? evaluator.structureRepairConvergence.repeatedStructureNoProgressCount
        : 0,
      workspaceMutationGrowthActive: evaluator.workspaceMutationGrowthConvergence
        ? evaluator.workspaceMutationGrowthConvergence.active === true
        : false,
      workspaceMutationGrowthStallCount: evaluator.workspaceMutationGrowthConvergence
        ? evaluator.workspaceMutationGrowthConvergence.stallCount
        : 0,
      status: evaluator.status,
      stepsWithoutObservableProgress: evaluator.stepsWithoutObservableProgress
    });
  }
  return evaluator;
}

function refreshTerminalRepair(options) {
  if (!options || typeof options !== "object") return null;
  const repair = refreshTerminalRepairState(options.runState, {
    actionName: options.actionName,
    decision: options.decision,
    output: options.output,
    runtimeConfig: options.runtimeConfig,
    status: options.status
  });
    if (repair && repair.active === true && typeof options.pushStep === "function") {
      const advisoryPersistenceSignal = repair.advisoryPersistenceSignal &&
        typeof repair.advisoryPersistenceSignal === "object"
        ? repair.advisoryPersistenceSignal
        : null;
      options.pushStep(
        "terminal-repair-state-refreshed",
        buildTerminalRepairRefreshedStepDetail(repair, options.actionName, advisoryPersistenceSignal)
      );
      if (shouldEmitAdvisoryPersistenceSignalStep(advisoryPersistenceSignal)) {
        options.pushStep("terminal-repair-advisory-persistence-signal", advisoryPersistenceSignal);
      }
    }
  return repair;
}

function maybeBlockTerminalRepairAction(options) {
  const runState = options && options.runState;
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  if (!repair || repair.active !== true) return null;
  const actionName = readString(options && options.actionName);
  if (!actionName) return null;
  const allowedActions = Array.isArray(repair.allowedActions)
    ? repair.allowedActions.map(readString).filter(Boolean)
    : [];
  const allowed = allowedActions.includes(actionName);
  const isPublish = actionName === PUBLISH_DIRECT_ACTION;
  // AGRUN publish-loop escape: once terminal-repair grants the publish-loop
  // escape (hard_veto reached with a real drafted candidate — see
  // terminal-repair-state.js publishLoopEscapeGranted), stop vetoing the AI's
  // workspace_publish_candidate. The AI has demonstrably failed the brittle
  // multi-gate publish protocol past the high-water mark; pinning it further
  // just burns the budget and returns the "paused" stub. Let the publish reach
  // the action, which publishes the real candidate ARTIFACT with the unmet
  // facts recorded as limitations. Narrow: hard_veto + real candidate only.
  if (isPublish && repair.publishLoopEscapeGranted === true) return null;
  const publishValidation = isPublish
    ? explainTerminalRepairPublishArgs(options.actionArgs, repair, { runState })
    : { valid: false, reasons: [] };
  const validPublish = isPublish && publishValidation.valid;
  const readinessOnlyPublishRetry = isPublish &&
    allowed &&
    isReadinessOnlyPublishRetryAllowed(repair);
  if (allowed && (!isPublish || validPublish || readinessOnlyPublishRetry)) return null;

  const ignoredCount = readFiniteNumber$2(repair.ignoredCount) + 1;
  const reason = isPublish && !validPublish
    ? "terminal_repair_invalid_publish"
    : "terminal_repair_action_not_allowed";
  const escalation = readString(repair.escalation);
    const isHardVeto = escalation === "hard_veto" && reason === "terminal_repair_action_not_allowed";
    const protocolHint = buildTerminalRepairProtocolHint(repair);
    const budgetExpansionSignal = isHardVeto
      ? buildBudgetRemainingForExpansionSignal(repair, ignoredCount)
      : null;
    const message = isHardVeto
    ? DEFAULT_TERMINAL_REPAIR_STRINGS.block.hardVetoActionNotAllowed({
        actionName,
        ignoredCount,
        budgetState: repair.budgetState,
        activeDeficits: repair.activeDeficits,
        allowedActions: repair.allowedActions,
        observableDeficits: repair.observableDeficits
      })
    : isPublish && !validPublish
      ? DEFAULT_TERMINAL_REPAIR_STRINGS.block.invalidPublish({ protocolHint })
      : DEFAULT_TERMINAL_REPAIR_STRINGS.block.actionNotAllowed({ actionName });
  const output = {
    ok: false,
    control: "continue",
    kind: isHardVeto ? "terminal_repair_hard_veto_block" : "terminal_repair_preflight_block",
    status: "blocked",
    reason,
    actionName,
    activeDeficits: Array.isArray(repair.activeDeficits) ? repair.activeDeficits.slice(0, 8) : [],
    allowedActions: allowedActions.slice(0, 16),
    forbiddenDecisions: Array.isArray(repair.forbiddenDecisions) ? repair.forbiddenDecisions.slice(0, 8) : [],
    escalation: escalation || "advisory",
      ignoredCount,
      invalidPublishReasons: isPublish ? publishValidation.reasons.slice(0, 8) : [],
      budgetRemainingForExpansionSignal: budgetExpansionSignal,
      terminalRepairState: {
      active: true,
      mode: repair.mode || "terminal_repair",
      reason: repair.reason || null,
      requiredRepair: repair.requiredRepair || null,
      validPublishContract: cloneValue(repair.validPublishContract || null)
    },
    requiredArgsExample: buildValidLimitedPublishArgsExample(runState),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep(isHardVeto ? "terminal-repair-hard-veto-blocked" : "terminal-repair-action-blocked", {
      actionName,
      activeDeficits: output.activeDeficits,
      escalation: output.escalation,
        ignoredCount,
        invalidPublishReasons: output.invalidPublishReasons,
        budgetRemainingForExpansionSignal: output.budgetRemainingForExpansionSignal,
        reason
      });
  }
  return { message, output };
}

function buildTerminalRepairProtocolHint(repair) {
  const reason = readString(repair && repair.reason);
  if (reason === "missing_finalize_after_latest_write") {
    return " Current publish protocol blocker requires workspace_finalize_candidate for the candidate, then workspace_read, before another publish attempt.";
  }
  if (reason === "missing_latest_workspace_read") {
    return " Current publish protocol blocker requires workspace_read of the latest candidate before another publish attempt.";
  }
  return "";
}

function isReadinessOnlyPublishRetryAllowed(repair) {
  const deficits = Array.isArray(repair && repair.activeDeficits)
    ? repair.activeDeficits.map(readString).filter(Boolean)
    : [];
  if (!deficits.includes("readiness")) return false;
  return !deficits.some((name) => [
    "length",
    "source",
    "structure",
    "terminal_loop",
    "todo"
  ].includes(name));
}

function maybeBlockTerminalCorrectionRetry(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== PUBLISH_DIRECT_ACTION) return null;
  const runState = options && options.runState;
  const convergence = runState && runState.actionPatternConvergence && typeof runState.actionPatternConvergence === "object"
    ? runState.actionPatternConvergence
    : null;
  const correction = convergence && convergence.terminalCorrectionState && typeof convergence.terminalCorrectionState === "object"
    ? convergence.terminalCorrectionState
    : null;
  const cooldown = convergence && convergence.terminalRetryCooldown && typeof convergence.terminalRetryCooldown === "object"
    ? convergence.terminalRetryCooldown
    : null;
  const ignoredCount = Math.max(
    readFiniteNumber$2(convergence && convergence.ignoredTerminalCorrectionCount),
    readFiniteNumber$2(correction && correction.ignoredTerminalCorrectionCount)
  );
  const cooldownActive = cooldown && cooldown.active === true;
  const correctionActive = correction && correction.active === true;
  if (!cooldownActive && !correctionActive) return null;
  const repairState = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : { active: true, activeDeficits: ["terminal_loop"] };
  // AGRUN publish-loop escape: once the hard_veto publish-acceptance escape is
  // granted (terminal-repair-state.js publishLoopEscapeGranted), the
  // terminal-correction cooldown must NOT re-pin the publish — otherwise this
  // sibling gate would block the very workspace_publish_candidate the escape
  // exists to let through, and the run would still thrash to the maxSteps stub.
  if (repairState.publishLoopEscapeGranted === true) return null;
  const publishValidation = explainTerminalRepairPublishArgs(options.actionArgs, repairState, { runState });
  if (publishValidation.valid) return null;
  const blockedTerminalRetryCount = readFiniteNumber$2(cooldown && cooldown.blockedTerminalRetryCount) + 1;
  const message = "Terminal correction is escalated: do not repeat clean ready or plain workspace_publish_candidate after repeated publish/finalize no-progress. Do evidence/workspace/TodoState recovery first, or publish only a valid limited finalReadiness with non-empty remainingGaps and false flags for failed dimensions.";
  const output = {
    ok: false,
    control: "continue",
    kind: "terminal_correction_preflight_block",
    status: "blocked",
    reason: "terminal_correction_escalated",
    ignoredTerminalCorrectionCount: ignoredCount,
    forbiddenMove: "repeat_same_terminal_intent",
    allowedNextMoves: Array.isArray(correction && correction.allowedNextMoves)
      ? correction.allowedNextMoves.slice(0, 8)
      : Array.isArray(cooldown && cooldown.allowedNextMoves)
        ? cooldown.allowedNextMoves.slice(0, 8)
        : [],
    terminalRetryCooldown: {
      active: true,
      forbiddenTerminalActions: Array.isArray(cooldown && cooldown.forbiddenTerminalActions)
        ? cooldown.forbiddenTerminalActions.slice(0, 8)
        : [PUBLISH_DIRECT_ACTION, "finalize"],
      validTerminalException: readString(cooldown && cooldown.validTerminalException) ||
        "workspace_publish_candidate with decision=limited + non-empty remainingGaps + false failed-dimension flags",
      blockedTerminalRetryCount,
      executedPublishCount: readFiniteNumber$2(cooldown && cooldown.executedPublishCount),
      consecutiveExecutedPublishCount: readFiniteNumber$2(cooldown && cooldown.consecutiveExecutedPublishCount),
      reason: readString(cooldown && cooldown.reason) || "terminal_retry_cooldown_active"
    },
    invalidPublishReasons: publishValidation.reasons.slice(0, 8),
    requiredArgsExample: buildValidLimitedPublishArgsExample(runState),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("terminal-correction-action-blocked", {
      actionName,
      blockedTerminalRetryCount,
      forbiddenMove: output.forbiddenMove,
      ignoredTerminalCorrectionCount: ignoredCount,
      reason: output.reason
    });
  }
  return { message, output };
}

function maybeBlockActionPatternRepeat(options) {
  const actionName = readString(options && options.actionName);
  if (!actionName || actionName === PUBLISH_DIRECT_ACTION || actionName === "finalize") return null;
  const runState = options && options.runState;
  const convergence = runState && runState.actionPatternConvergence && typeof runState.actionPatternConvergence === "object"
    ? runState.actionPatternConvergence
    : null;
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  const repairAllowedActions = repair && repair.active === true && Array.isArray(repair.allowedActions)
    ? repair.allowedActions.map(readString).filter(Boolean)
    : [];
  const unnecessaryClarificationBlock = maybeBlockUnnecessaryLongResearchClarification({
    actionName,
    pushStep: options && options.pushStep,
    request: options && options.request,
    runState
  });
  if (unnecessaryClarificationBlock) return unnecessaryClarificationBlock;
  const searchWithoutReadBlock = maybeBlockLongResearchSearchWithoutRead({
    actionName,
    pushStep: options && options.pushStep,
    runState
  });
  if (searchWithoutReadBlock) return searchWithoutReadBlock;
  // workspaceMutationGrowthConvergence hard_veto is not overridable by terminal
  // repair — write-overwrite oscillation indicates AI confusion that repair cannot
  // resolve. Check this BEFORE the repairAllowedActions bypass.
  const earlyMutationGrowthBlock = maybeBlockWorkspaceMutationGrowthLoop({
    actionName,
    convergence,
    pushStep: options && options.pushStep
  });
  if (earlyMutationGrowthBlock && readString(earlyMutationGrowthBlock.output && earlyMutationGrowthBlock.output.escalation) === "hard_veto") {
    return earlyMutationGrowthBlock;
  }
  const lengthRewriteBlock = maybeBlockLengthDeficitRewrite({
    actionArgs: options && options.actionArgs,
    actionName,
    pushStep: options && options.pushStep,
    runState
  });
  if (lengthRewriteBlock) return lengthRewriteBlock;
  const lateBudgetProtocolBlock = maybeBlockLateBudgetWorkspaceProtocolWindow({
    actionArgs: options && options.actionArgs,
    actionName,
    pushStep: options && options.pushStep,
    runState
  });
  if (lateBudgetProtocolBlock) return lateBudgetProtocolBlock;
  if (repairAllowedActions.includes(actionName)) return null;
  const satisfiedMutationBlock = maybeBlockSatisfiedCandidateMutation({
    actionName,
    pushStep: options && options.pushStep,
    runState
  });
  if (satisfiedMutationBlock) return satisfiedMutationBlock;
  const sourceDeficitAfterPublishBlock = maybeBlockWorkspaceSourceDeficitAfterPublishBlock({
    actionName,
    pushStep: options && options.pushStep,
    runState
  });
  if (sourceDeficitAfterPublishBlock) return sourceDeficitAfterPublishBlock;
  const workspaceNoProgressBlock = maybeBlockWorkspaceNoProgressLoop({
    actionName,
    convergence,
    pushStep: options && options.pushStep,
    runState
  });
  if (workspaceNoProgressBlock) return workspaceNoProgressBlock;
  const structureRepairBlock = maybeBlockStructureRepairLoop({
    actionName,
    convergence,
    pushStep: options && options.pushStep
  });
  if (structureRepairBlock) return structureRepairBlock;
  const mutationGrowthBlock = maybeBlockWorkspaceMutationGrowthLoop({
    actionName,
    convergence,
    pushStep: options && options.pushStep
  });
  if (mutationGrowthBlock) return mutationGrowthBlock;
  const readOnlyPlanningBlock = maybeBlockReadOnlyPlanningLoop({
    actionName,
    convergence,
    pushStep: options && options.pushStep,
    runState
  });
  if (readOnlyPlanningBlock) return readOnlyPlanningBlock;
  const signal = convergence && convergence.convergenceSignal && typeof convergence.convergenceSignal === "object"
    ? convergence.convergenceSignal
    : null;
  if (!signal) return null;
  if (readString(signal.patternKind) !== "exact_action") return null;
  if (readString(signal.forbiddenMove) !== "repeat_same_action_args") return null;
  const currentFingerprint = fingerprintAction(options.decision);
  if (!currentFingerprint || currentFingerprint !== readString(signal.fingerprint)) return null;
  const repeatCount = readFiniteNumber$2(signal.repeatCount) || readFiniteNumber$2(convergence.repeatedFingerprintCount);
  const message = `Action pattern convergence is active: do not repeat ${actionName} with the same arguments after ${repeatCount} no-progress attempt(s). Change arguments, choose a different recovery action, mutate the workspace meaningfully, gather evidence, or publish only a valid limited result when allowed.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "same_action_fingerprint_without_observable_progress",
    actionName,
    fingerprint: currentFingerprint,
    forbiddenMove: "repeat_same_action_args",
    allowedNextMoves: Array.isArray(signal.allowedNextMoves)
      ? signal.allowedNextMoves.slice(0, 8)
      : ["change_arguments", "choose_different_action", "valid_limited_with_remainingGaps"],
    repeatCount,
    stepsWithoutObservableProgress: readFiniteNumber$2(convergence.stepsWithoutObservableProgress),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      repeatCount,
      stepsWithoutObservableProgress: output.stepsWithoutObservableProgress
    });
  }
  return { message, output };
}

function maybeBlockUnnecessaryLongResearchClarification(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== "ask_clarification") return null;
  const runState = options && options.runState;
  if (!isLongResearchHarnessActive(runState, {
    prompt: readString(options && options.request && options.request.prompt)
  })) {
    return null;
  }
  if (hasOpenClarificationNeed(runState)) return null;
  if (!hasResearchProgressSignal(runState)) return null;
  const sourceFacts = readResearchSourceFacts(runState);
  const candidateCount = countResearchCandidateUrls(runState);
  const message = [
    "Long research clarification guard: no open ambiguity is recorded for this run.",
    "Missing terminology coverage, thin search results, or weak source confidence are research limitations, not user ambiguity.",
    "Continue with read_url on an unread candidate, write/update the workspace with visible limitations, or publish limited only with concrete remainingGaps if evidence is exhausted."
  ].join(" ");
  const output = {
    ok: false,
    control: "continue",
    kind: "evidence_convergence_clarification_preflight_block",
    status: "blocked",
    reason: "clarification_without_open_ambiguity",
    actionName,
    forbiddenMove: "ask_clarification_without_open_ambiguity",
    allowedNextMoves: buildLongResearchAllowedNextMoves(runState, {
      preferReadUrl: candidateCount > 0 && sourceFacts.successfulReadUrlCount === 0
    }),
    researchFacts: {
      candidateUrlCount: candidateCount,
      searchPassCount: countSearchPasses(runState),
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount,
      sourceMinimum: sourceFacts.sourceMinimum
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("long-research-clarification-blocked", {
      candidateUrlCount: candidateCount,
      reason: output.reason,
      searchPassCount: output.researchFacts.searchPassCount,
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount
    });
  }
  return { message, output };
}

function maybeBlockLongResearchSearchWithoutRead(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== "web_search") return null;
  const runState = options && options.runState;
  if (!isLongResearchHarnessActive(runState, {
    prompt: readString(options && options.request && options.request.prompt)
  })) return null;
  const searchPassCount = countSearchPasses(runState);
  if (searchPassCount < 2) return null;
  const sourceFacts = readResearchSourceFacts(runState);
  const candidateCount = countResearchCandidateUrls(runState);
  if (candidateCount === 0) return null;
  const sourceMinimum = sourceFacts.sourceMinimum;
  const readSources = readFiniteNumber$2(sourceMinimum && sourceMinimum.readSources);
  const minReadSources = readFiniteNumber$2(sourceMinimum && sourceMinimum.minReadSources);
  const relevantSources = readFiniteNumber$2(sourceMinimum && sourceMinimum.relevantSources);
  const minRelevantSources = readFiniteNumber$2(sourceMinimum && sourceMinimum.minRelevantSources);
  const sourceMinimumUnmet = Boolean(
    sourceMinimum &&
    sourceMinimum.passed !== true &&
    (
      (minReadSources > 0 && readSources < minReadSources) ||
      (minRelevantSources > 0 && relevantSources < minRelevantSources)
    )
  );
  const unreadCandidatesAvailable = candidateCount > sourceFacts.successfulReadUrlCount;
  if (sourceFacts.successfulReadUrlCount > 0 && (!sourceMinimumUnmet || !unreadCandidatesAvailable)) {
    return null;
  }
  const hasNoSuccessfulRead = sourceFacts.successfulReadUrlCount === 0;
  const message = [
    hasNoSuccessfulRead
      ? `Long research evidence handoff is active: ${searchPassCount} search pass(es) already produced ${candidateCount} candidate URL(s), but no successful read_url evidence exists.`
      : `Long research source minimum is still unmet: ${readSources}/${minReadSources} read source(s), ${relevantSources}/${minRelevantSources} relevant source(s), and ${candidateCount} candidate URL(s) are available.`,
    "More broad web_search calls are lower-value than reading an unread candidate or documenting a concrete source blocker.",
    "Use read_url on an unread candidate, or publish limited only if the remaining source blockers are concrete."
  ].join(" ");
  const output = {
    ok: false,
    control: "continue",
    kind: "evidence_convergence_search_read_handoff_block",
    status: "blocked",
    reason: hasNoSuccessfulRead
      ? "search_candidates_exist_without_read_url"
      : "source_minimum_unmet_with_unread_candidates",
    actionName,
    forbiddenMove: hasNoSuccessfulRead
      ? "repeat_web_search_before_reading_candidates"
      : "repeat_web_search_before_meeting_source_minimum",
    allowedNextMoves: buildLongResearchAllowedNextMoves(runState, { preferReadUrl: true }),
    researchFacts: {
      candidateUrlCount: candidateCount,
      searchPassCount,
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount,
      sourceMinimum: sourceFacts.sourceMinimum
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("long-research-search-read-handoff-blocked", {
      candidateUrlCount: candidateCount,
      reason: output.reason,
      searchPassCount,
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount
    });
  }
  return { message, output };
}

function isLongResearchHarnessActive(runState, options = {}) {
  if (isResearchQualityGateRequired(runState, options)) return true;
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  if (!loop) return false;
  if (loop.enabled === true) return true;
  const status = readString(loop.status);
  if (status && status !== "idle" && status !== "none") return true;
  return Boolean(
    loop.gateSignal &&
    loop.gateSignal.acceptancePacket &&
    typeof loop.gateSignal.acceptancePacket === "object"
  );
}

function hasOpenClarificationNeed(runState) {
  const plannerState = runState && runState.plannerState && typeof runState.plannerState === "object"
    ? runState.plannerState
    : {};
  const inquiryContext = runState && runState.inquiryContext && typeof runState.inquiryContext === "object"
    ? runState.inquiryContext
    : {};
  if (plannerState.hasOpenAmbiguity === true) return true;
  if (readString(plannerState.openAmbiguity)) return true;
  if (plannerState.pendingClarification && typeof plannerState.pendingClarification === "object") return true;
  if (inquiryContext.pendingClarification && typeof inquiryContext.pendingClarification === "object") return true;
  if (readString(inquiryContext.openAmbiguity)) return true;
  return false;
}

function hasResearchProgressSignal(runState) {
  if (!runState || typeof runState !== "object") return false;
  if (countSearchPasses(runState) > 0) return true;
  if (countResearchCandidateUrls(runState) > 0) return true;
  const facts = readResearchSourceFacts(runState);
  if (facts.successfulReadUrlCount > 0) return true;
  const workspace = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  if (!workspace) return false;
  const files = workspace.files && typeof workspace.files === "object" && !Array.isArray(workspace.files)
    ? workspace.files
    : {};
  return Object.values(files).some((file) => readString(file && file.content));
}

function countSearchPasses(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  return Array.isArray(context.searchPasses) ? context.searchPasses.length : 0;
}

function countResearchCandidateUrls(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const candidates = [];
  for (const key of ["aggregatedSearchResults", "searchResults"]) {
    const items = Array.isArray(context[key]) ? context[key] : [];
    candidates.push(...items);
  }
  const passes = Array.isArray(context.searchPasses) ? context.searchPasses : [];
  for (const pass of passes) {
    if (!pass || typeof pass !== "object") continue;
    const items = Array.isArray(pass.items)
      ? pass.items
      : Array.isArray(pass.results)
        ? pass.results
        : Array.isArray(pass.rankedItems)
          ? pass.rankedItems
          : [];
    candidates.push(...items);
  }
  const urls = new Set();
  for (const item of candidates) {
    const url = readString(item && item.url);
    if (url) urls.add(url);
  }
  return urls.size;
}

function readResearchSourceFacts(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const readSources = Array.isArray(context.readSources) ? context.readSources : [];
  const successfulReadUrlCount = readSources.filter((source) => source && source.ok !== false).length;
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  const packet = loop.gateSignal &&
    loop.gateSignal.acceptancePacket &&
    typeof loop.gateSignal.acceptancePacket === "object"
    ? loop.gateSignal.acceptancePacket
    : {};
  const sourceMinimum = packet.evidence &&
    packet.evidence.sourceMinimum &&
    typeof packet.evidence.sourceMinimum === "object"
    ? packet.evidence.sourceMinimum
    : loop.sourceMinimum && typeof loop.sourceMinimum === "object"
      ? loop.sourceMinimum
      : null;
  const packetSuccessful = readFiniteNumber$2(packet.evidence && packet.evidence.successfulReadUrlCount);
  return {
    successfulReadUrlCount: Math.max(successfulReadUrlCount, packetSuccessful),
    sourceMinimum: sourceMinimum ? {
      minReadSources: readFiniteNumber$2(sourceMinimum.minReadSources) || readFiniteNumber$2(sourceMinimum.minReads),
      minRelevantSources: readFiniteNumber$2(sourceMinimum.minRelevantSources) || readFiniteNumber$2(sourceMinimum.minRelevant),
      passed: sourceMinimum.passed === true,
      readSources: readFiniteNumber$2(sourceMinimum.readSources) || readFiniteNumber$2(sourceMinimum.reads),
      relevantSources: readFiniteNumber$2(sourceMinimum.relevantSources) || readFiniteNumber$2(sourceMinimum.relevant)
    } : null
  };
}

function buildLongResearchAllowedNextMoves(runState, options = {}) {
  const moves = [];
  if (options.preferReadUrl === true) moves.push("read_url");
  const workspaceDeficit = readWorkspaceLengthDeficit(runState);
  if (workspaceDeficit) {
    moves.push("workspace_insert_after_section");
  } else {
    moves.push("workspace_write", "workspace_insert_after_section");
  }
  moves.push("workspace_publish_candidate_limited_with_remainingGaps");
  return Array.from(new Set(moves));
}

function maybeBlockReadOnlyPlanningLoop(options) {
  const actionName = readString(options && options.actionName);
  const runState = options && options.runState;
  const repair = runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  const repairAllowedActions = repair && repair.active === true && Array.isArray(repair.allowedActions)
    ? repair.allowedActions.map(readString).filter(Boolean)
    : [];
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const state = convergence && convergence.readOnlyPlanningState && typeof convergence.readOnlyPlanningState === "object"
    ? convergence.readOnlyPlanningState
    : null;
  if (repairAllowedActions.includes(actionName)) {
    if (isPublishProtocolRequiredActionForRepair(repair, actionName)) return null;
    // Repair allowlist is bypassed only when readOnlyPlanningState has NOT reached hard_veto
    // for this specific action. Hard_veto means the model has repeatedly ignored the advisory
    // and the action is demonstrably causing churn — override the repair allowance.
    const isHardVetoForAction = state && state.active === true &&
      readString(state.escalation) === "hard_veto" &&
      Array.isArray(state.forbiddenActions) &&
      state.forbiddenActions.map(readString).filter(Boolean).includes(actionName);
    if (!isHardVetoForAction) return null;
  }
  if (!state || state.active !== true) return null;
  if (readString(state.escalation) !== "hard_veto") return null;
  const forbiddenActions = Array.isArray(state.forbiddenActions)
    ? state.forbiddenActions.map(readString).filter(Boolean)
    : [];
  if (!forbiddenActions.includes(actionName)) return null;
  const ignoredCount = readFiniteNumber$2(state.ignoredCount) + 1;
  const allowedMoves = readStateAllowedNextMovesWithSignal(state, 12, "readOnlyPlanningState");
  const message = `HARD VETO — read-only planning has blocked ${actionName} ${ignoredCount} time(s) without source or workspace progress. The harness will reject any further ${actionName} calls. Choose any action from allowedNextMoves when populated. If no recovery is feasible, workspace_publish_candidate with finalReadiness.decision='limited' and concrete remainingGaps is valid.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "read_only_planning_hard_veto_block",
    status: "blocked",
    reason: "read_only_planning_without_productive_progress",
    actionName,
    forbiddenMove: "repeat_read_only_planning_without_productive_progress",
    forbiddenActions,
    allowedNextMoves: allowedMoves.allowedNextMoves,
    allowedNextMovesSignal: allowedMoves.signal,
    ignoredCount,
    stepsWithoutProductiveProgress: readFiniteNumber$2(state.stepsWithoutProductiveProgress),
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("read-only-planning-hard-veto-blocked", {
      actionName,
      escalation: "hard_veto",
      forbiddenMove: output.forbiddenMove,
      allowedNextMovesSignal: output.allowedNextMovesSignal,
      ignoredCount,
      reason: output.reason,
      stepsWithoutProductiveProgress: output.stepsWithoutProductiveProgress
    });
  }
  return { message, output };
}

function readStateAllowedNextMovesWithSignal(state, limit, source) {
  const allowedNextMoves = Array.isArray(state && state.allowedNextMoves)
    ? state.allowedNextMoves.map(readString).filter(Boolean).slice(0, limit)
    : [];
  return {
    allowedNextMoves,
    signal: allowedNextMoves.length > 0
      ? null
      : {
          kind: "allowed_next_moves_not_populated",
          source,
          reason: "state_allowedNextMoves_missing_or_empty"
        }
  };
}

function maybeBlockWorkspaceNoProgressLoop(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== "workspace_read" && actionName !== "workspace_replace") return null;
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const stepsWithoutObservableProgress = readFiniteNumber$2(convergence && convergence.stepsWithoutObservableProgress);
  const structureDeficit = hasWorkspaceStructureDeficit(options && options.runState);
  const repairActive = options &&
    options.runState &&
    options.runState.terminalRepairState &&
    options.runState.terminalRepairState.active === true;
  const threshold = repairActive && structureDeficit ? 2 : 6;
  if (stepsWithoutObservableProgress < threshold) return null;
  const deficit = readWorkspaceLengthDeficit(options && options.runState);
  if (!deficit) {
    const sourceDeficit = readWorkspaceSourceDeficit(options && options.runState);
    if (!sourceDeficit) {
      if (!structureDeficit) return null;
      const structureMessage = `Workspace structure repair is active: the candidate still has structural issues after ${stepsWithoutObservableProgress} step(s) without observable progress. More workspace_read calls cannot repair duplicate headings or section numbering. Use workspace_replace, workspace_write, or workspace_insert_after_section to produce one coherent candidate structure before publishing.`;
      const structureOutput = {
        ok: false,
        control: "continue",
        kind: "action_pattern_preflight_block",
        status: "blocked",
        reason: "workspace_no_progress_structure_deficit",
        actionName,
        forbiddenMove: "repeat_workspace_read_replace_without_structure_progress",
        allowedNextMoves: [
          "workspace_replace",
          "workspace_write",
          "workspace_insert_after_section"
        ],
        observableDeficit: readWorkspaceStructureDeficit(options && options.runState),
        stepsWithoutObservableProgress,
        message: structureMessage
      };
      if (typeof (options && options.pushStep) === "function") {
        options.pushStep("action-pattern-repeat-blocked", {
          actionName,
          forbiddenMove: structureOutput.forbiddenMove,
          reason: structureOutput.reason,
          stepsWithoutObservableProgress
        });
      }
      return { message: structureMessage, output: structureOutput };
    }
    const sourceMessage = `Workspace recovery cooldown is active: source minimum is still not satisfied after ${stepsWithoutObservableProgress} step(s) without observable progress (readSources ${sourceDeficit.readSources}/${sourceDeficit.minReadSources}, relevantSources ${sourceDeficit.relevantSources}/${sourceDeficit.minRelevantSources}). More workspace_read/workspace_replace calls cannot fix an evidence deficit. Continue evidence work with web_search/read_url, or publish only a valid limited result with evidenceSatisfied=false and concrete remainingGaps when allowed.`;
    const sourceOutput = {
      ok: false,
      control: "continue",
      kind: "action_pattern_preflight_block",
      status: "blocked",
      reason: "workspace_no_progress_source_deficit",
      actionName,
      forbiddenMove: "repeat_workspace_read_replace_without_source_progress",
      allowedNextMoves: [
        "web_search",
        "read_url",
        "workspace_publish_candidate_limited_with_remainingGaps"
      ],
      observableDeficit: sourceDeficit,
      stepsWithoutObservableProgress,
      message: sourceMessage
    };
    if (typeof (options && options.pushStep) === "function") {
      options.pushStep("action-pattern-repeat-blocked", {
        actionName,
        forbiddenMove: sourceOutput.forbiddenMove,
        reason: sourceOutput.reason,
        readSources: sourceDeficit.readSources,
        relevantSources: sourceDeficit.relevantSources,
        stepsWithoutObservableProgress
      });
    }
    return { message: sourceMessage, output: sourceOutput };
  }
  const message = `Workspace recovery cooldown is active: the candidate is still below the requested ${deficit.requested} ${deficit.unit} (observed ${deficit.observed}) after ${stepsWithoutObservableProgress} step(s) without observable progress. Do not continue workspace_read/workspace_replace loops. Add substantial user-facing content with workspace_insert_after_section or workspace_write, or publish only a valid limited result when allowed.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "workspace_no_progress_length_deficit",
    actionName,
    forbiddenMove: "repeat_workspace_read_replace_without_progress",
    allowedNextMoves: [
      "workspace_insert_after_section",
      "workspace_write",
      "valid_limited_with_remainingGaps"
    ],
    observableDeficit: deficit,
    stepsWithoutObservableProgress,
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      requested: deficit.requested,
      observed: deficit.observed,
      stepsWithoutObservableProgress
    });
  }
  return { message, output };
}

function maybeBlockSatisfiedCandidateMutation(options) {
  const actionName = readString(options && options.actionName);
  if (![
    "workspace_write",
    "workspace_insert_after_section",
    "workspace_replace"
  ].includes(actionName)) {
    return null;
  }
  const runState = options && options.runState;
  if (readWorkspaceSourceDeficit(runState) || hasWorkspaceStructureDeficit(runState) || readWorkspaceLengthDeficit(runState)) {
    return null;
  }
  const lengthStatus = readCurrentWorkspaceLengthStatus(runState);
  if (!lengthStatus || lengthStatus.requested <= 0 || lengthStatus.observed < lengthStatus.requested) return null;
  const message = `Workspace candidate already satisfies observable source, length, and structure gates (${lengthStatus.observed}/${lengthStatus.requested} ${lengthStatus.unit}). More workspace mutation can introduce duplicate headings or regressions. Use workspace_read, workspace_finalize_candidate, TodoState sync, or workspace_publish_candidate instead.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "satisfied_candidate_mutation",
    actionName,
    forbiddenMove: "mutate_after_observable_gates_satisfied",
    allowedNextMoves: [
      "workspace_read",
      FINALIZE_CANDIDATE_ACTION,
      "todo_advance",
      "todo_run_next",
      PUBLISH_DIRECT_ACTION
    ],
    observableFacts: {
      observed: lengthStatus.observed,
      requested: lengthStatus.requested,
      unit: lengthStatus.unit
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      observed: lengthStatus.observed,
      reason: output.reason,
      requested: lengthStatus.requested
    });
  }
  return { message, output };
}

function maybeBlockLengthDeficitRewrite(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== "workspace_write" && actionName !== "workspace_replace") return null;
  const runState = options && options.runState;
  const deficit = readWorkspaceLengthDeficit(runState);
  if (!deficit || deficit.observed <= 0) return null;
  const structureDeficit = hasWorkspaceStructureDeficit(runState);
  const args = options && options.actionArgs && typeof options.actionArgs === "object"
    ? options.actionArgs
    : {};
  const proposedText = actionName === "workspace_write"
    ? readString(args.content || args.text || args.markdown)
    : "";
  const proposedLength = actionName === "workspace_replace"
    ? estimateWorkspaceReplaceLength(runState, args, deficit)
    : proposedText
      ? countTextByLengthUnit(proposedText, deficit)
      : 0;
  const proposedGrowth = proposedLength - deficit.observed;
  const minimumEffectiveGrowth = computeMinimumEffectiveLengthDeficitGrowth(deficit);
  const materiallyGrows = proposedGrowth >= minimumEffectiveGrowth;
  if (proposedLength >= deficit.requested || (proposedLength > deficit.observed && materiallyGrows)) return null;
  const remaining = Math.max(deficit.requested - deficit.observed, 0);
  const growthHint = minimumEffectiveGrowth > 0
    ? ` A replacement under the target must grow by at least ${minimumEffectiveGrowth} ${deficit.unit} from the current observed length; this proposal grows by ${Math.max(proposedGrowth, 0)}.`
    : "";
  const message = `${structureDeficit ? "Length + structure repair" : "Length-only repair"} is active: current candidate has ${deficit.observed}/${deficit.requested} ${deficit.unit}. ${actionName} would not increase the candidate enough and can erase prior expansion.${growthHint} Use workspace_insert_after_section or workspace_replace with enough user-facing material to close the ${remaining} ${deficit.unit} gap, or rewrite with content that preserves/grows the current length before workspace_read/finalize/publish.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "length_deficit_rewrite_without_growth",
    actionName,
    forbiddenMove: "rewrite_under_length_deficit_without_growth",
    allowedNextMoves: [
      "workspace_insert_after_section",
      "workspace_read",
      FINALIZE_CANDIDATE_ACTION,
      "workspace_publish_candidate_limited_with_remainingGaps"
    ],
    observableDeficit: {
      observed: deficit.observed,
      minimumEffectiveGrowth,
      proposed: proposedLength,
      proposedGrowth,
      requested: deficit.requested,
      unit: deficit.unit
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      observed: deficit.observed,
      proposed: proposedLength,
      reason: output.reason,
      requested: deficit.requested
    });
  }
  return { message, output };
}

function maybeBlockLateBudgetWorkspaceProtocolWindow(options) {
  const actionName = readString(options && options.actionName);
  const isPatchPreview = LATE_BUDGET_PATCH_PREVIEW_ACTIONS.has(actionName);
  const isWorkspaceMutation = LATE_BUDGET_WORKSPACE_MUTATION_ACTIONS.has(actionName);
  if (!isPatchPreview && !isWorkspaceMutation) return null;
  const runState = options && options.runState;
  if (!isLateBudgetWorkspaceProtocolRelevant(runState)) return null;
  const remaining = readRemainingCyclesAfterCurrentAction(runState);
  if (remaining == null) return null;
  const requiredFutureCycles = isPatchPreview ? 4 : 3;
  if (remaining >= requiredFutureCycles) return null;

  const targetPath = readLateBudgetWorkspaceProtocolPath(runState, options && options.actionArgs);
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, targetPath);
  const requiredProtocol = isPatchPreview
    ? ["workspace_apply_patch", FINALIZE_CANDIDATE_ACTION, "workspace_read", PUBLISH_DIRECT_ACTION]
    : [FINALIZE_CANDIDATE_ACTION, "workspace_read", PUBLISH_DIRECT_ACTION];
  const allowedNextMoves = buildLateBudgetProtocolAllowedNextMoves(runState, publishProtocol);
  const todoFacts = readUnfinishedTodoFacts(runState);
  const message = [
    `Late workspace protocol budget window: ${actionName} would leave ${remaining} future cycle(s), but publishing changed workspace content requires at least ${requiredFutureCycles}.`,
    `Required sequence for that change: ${requiredProtocol.join(" -> ")}.`,
    `Current candidate protocol surface: ${allowedNextMoves.join(", ") || "none"}.`
  ].join(" ");
  const output = {
    ok: false,
    control: "continue",
    kind: "late_budget_workspace_protocol_window",
    status: "blocked",
    reason: "late_workspace_mutation_without_publish_protocol_budget",
    actionName,
    forbiddenMove: "late_workspace_mutation_without_protocol_budget",
    allowedNextMoves,
    cyclesRemainingAfterCurrentAction: remaining,
    currentCandidatePath: publishProtocol.path,
    publishProtocol,
    requiredFutureCycles,
    requiredProtocol,
    todoState: todoFacts,
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("late-budget-workspace-protocol-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      cyclesRemainingAfterCurrentAction: remaining,
      currentCandidatePath: publishProtocol.path,
      requiredFutureCycles,
      todoUnfinishedCount: todoFacts.unfinishedCount
    });
  }
  return { message, output };
}

function isLateBudgetWorkspaceProtocolRelevant(runState) {
  const lengthStatus = readCurrentWorkspaceLengthStatus(runState);
  if (!lengthStatus || lengthStatus.requested <= 0) return false;
  if (lengthStatus.observed > 0) return true;
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const path = readLateBudgetWorkspaceProtocolPath(runState, null);
  const file = workspace && workspace.files && workspace.files[path] && typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  return Boolean(readString(file && file.content));
}

function readRemainingCyclesAfterCurrentAction(runState) {
  const maxSteps = readFiniteNumber$2(runState && runState.maxSteps);
  const cycleCount = readFiniteNumber$2(runState && runState.cycleCount);
  if (maxSteps <= 0 || cycleCount <= 0) return null;
  return Math.max(maxSteps - cycleCount, 0);
}

function readLateBudgetWorkspaceProtocolPath(runState, actionArgs) {
  const args = actionArgs && typeof actionArgs === "object" && !Array.isArray(actionArgs)
    ? actionArgs
    : {};
  const pendingPatch = runState &&
    runState.virtualWorkspace &&
    runState.virtualWorkspace.pendingPatch &&
    typeof runState.virtualWorkspace.pendingPatch === "object"
    ? runState.virtualWorkspace.pendingPatch
    : null;
  const firstOperationWithPath = Array.isArray(args.operations)
    ? args.operations.find((operation) => readString(operation && operation.path))
    : null;
  const operationPath = readString(firstOperationWithPath && firstOperationWithPath.path);
  const workspaceQuality = runState &&
    runState.virtualWorkspace &&
    runState.virtualWorkspace.quality &&
    typeof runState.virtualWorkspace.quality === "object"
    ? runState.virtualWorkspace.quality
    : {};
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : {};
  const candidate = packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
    ? packet.workspace.candidate
    : packet.candidate && typeof packet.candidate === "object"
      ? packet.candidate
      : {};
  return readString(args.path) ||
    readString(args.to) ||
    readString(pendingPatch && pendingPatch.path) ||
    operationPath ||
    readString(workspaceQuality.finalCandidatePath) ||
    readString(candidate.path) ||
    "final_candidate.md";
}

function buildLateBudgetProtocolAllowedNextMoves(runState, publishProtocol) {
  const protocol = publishProtocol && typeof publishProtocol === "object" ? publishProtocol : {};
  const todoFacts = readUnfinishedTodoFacts(runState);
  const moves = [];
  if (protocol.finalizedAfterLatestWrite !== true) {
    moves.push(FINALIZE_CANDIDATE_ACTION);
  } else if (protocol.readAfterLatestContentChange !== true) {
    moves.push("workspace_read");
  } else {
    if (todoFacts.unfinishedCount > 0) {
      moves.push("todo_run_next", "todo_advance", "todo_cancel");
    }
    moves.push(PUBLISH_DIRECT_ACTION);
  }
  return Array.from(new Set(moves));
}

function readUnfinishedTodoFacts(runState) {
  const todoState = runState && runState.todoState && typeof runState.todoState === "object"
    ? runState.todoState
    : null;
  if (!todoState || todoState.terminatedAt) {
    return { active: false, unfinishedCount: 0 };
  }
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  const unfinished = items.filter((item) => {
    const status = readString(item && item.status) || "pending";
    return status === "active" || status === "pending" || status === "blocked";
  });
  return {
    active: unfinished.length > 0,
    unfinishedCount: unfinished.length,
    statuses: countTodoStatusFacts(items)
  };
}

function countTodoStatusFacts(items) {
  const counts = {
    abandoned: 0,
    active: 0,
    blocked: 0,
    done: 0,
    pending: 0,
    total: Array.isArray(items) ? items.length : 0
  };
  for (const item of Array.isArray(items) ? items : []) {
    const status = readString(item && item.status) || "pending";
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

function maybeBlockStructureRepairLoop(options) {
  const actionName = readString(options && options.actionName);
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const state = convergence && convergence.structureRepairConvergence && typeof convergence.structureRepairConvergence === "object"
    ? convergence.structureRepairConvergence
    : null;
  if (!state || state.active !== true) return null;
  const forbiddenActions = Array.isArray(state.forbiddenActions)
    ? state.forbiddenActions.map(readString).filter(Boolean)
    : [];
  if (!forbiddenActions.includes(actionName)) return null;
  const repeatedStructureNoProgressCount = readFiniteNumber$2(state.repeatedStructureNoProgressCount);
  const isHardVeto = readString(state.escalation) === "hard_veto";
  const allowedMoves = readStateAllowedNextMovesWithSignal(state, 12, "structureRepairConvergence");
  const message = isHardVeto
    ? `HARD VETO — structure repair convergence has blocked ${actionName} ${repeatedStructureNoProgressCount} time(s) without improving the structure audit. allowedNextMoves is the recovery surface when populated. A coherent repair can use workspace_write or workspace_replace to produce a deduplicated outline with unique headings and section numbers, then workspace_finalize_candidate. If recovery is not feasible, workspace_publish_candidate with finalReadiness.decision='limited' is valid when remainingGaps names every structure issue.`
    : `Structure repair convergence is active: ${actionName} will not fix the duplicate headings or section numbers. Use a targeted workspace_write/workspace_replace full-outline repair, sync TodoState, or publish only a valid limited result that names the structure gap.`;
  const output = {
    ok: false,
    control: "continue",
    kind: isHardVeto ? "structure_repair_hard_veto_block" : "structure_repair_preflight_block",
    status: "blocked",
    reason: "structure_repair_without_audit_delta",
    actionName,
    escalation: isHardVeto ? "hard_veto" : "advisory",
    forbiddenMove: "repeat_structure_repair_without_audit_delta",
    forbiddenActions,
    allowedNextMoves: allowedMoves.allowedNextMoves,
    allowedNextMovesSignal: allowedMoves.signal,
    repeatedStructureNoProgressCount,
    activeIssueCodes: Array.isArray(state.activeIssueCodes) ? state.activeIssueCodes.slice(0, 8) : [],
    repeatedHeadingSamples: Array.isArray(state.repeatedHeadingSamples) ? state.repeatedHeadingSamples.slice(0, 5) : [],
    repeatedNumberSamples: Array.isArray(state.repeatedNumberSamples) ? state.repeatedNumberSamples.slice(0, 5) : [],
    requiredCorrection: readString(state.requiredCorrection) || null,
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep(isHardVeto ? "structure-repair-hard-veto-blocked" : "structure-repair-action-blocked", {
      actionName,
      escalation: output.escalation,
      forbiddenMove: output.forbiddenMove,
      allowedNextMovesSignal: output.allowedNextMovesSignal,
      reason: output.reason,
      repeatedStructureNoProgressCount,
      activeIssueCodes: output.activeIssueCodes
    });
  }
  return { message, output };
}

function maybeBlockWorkspaceMutationGrowthLoop(options) {
  const actionName = readString(options && options.actionName);
  const convergence = options && options.convergence && typeof options.convergence === "object"
    ? options.convergence
    : null;
  const state = convergence && convergence.workspaceMutationGrowthConvergence && typeof convergence.workspaceMutationGrowthConvergence === "object"
    ? convergence.workspaceMutationGrowthConvergence
    : null;
  if (!state || state.active !== true || readString(state.escalation) !== "hard_veto") return null;
  const forbiddenActions = Array.isArray(state.forbiddenActions)
    ? state.forbiddenActions.map(readString).filter(Boolean)
    : [];
  if (!forbiddenActions.includes(actionName)) return null;
  const stallCount = readFiniteNumber$2(state.stallCount);
  const allowedMoves = readStateAllowedNextMovesWithSignal(state, 8, "workspaceMutationGrowthConvergence");
  const message = `Workspace mutation hard veto: repeated ${actionName} attempts are not growing the candidate while a length deficit remains. Use an allowed non-overwrite recovery action such as workspace_insert_after_section, workspace_multi_edit, workspace_propose_patch/workspace_apply_patch, or a valid limited publish with concrete remainingGaps.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "workspace_mutation_growth_hard_veto_block",
    status: "blocked",
    reason: "workspace_write_not_accumulating",
    actionName,
    escalation: "hard_veto",
    forbiddenMove: "repeat_workspace_write_without_growth",
    forbiddenActions,
    allowedNextMoves: allowedMoves.allowedNextMoves,
    allowedNextMovesSignal: allowedMoves.signal,
    stallCount,
    requiredCorrection: readString(state.requiredCorrection) || null,
    message
  };
  if (typeof options.pushStep === "function") {
    options.pushStep("workspace-mutation-growth-hard-veto-blocked", {
      actionName,
      escalation: output.escalation,
      forbiddenMove: output.forbiddenMove,
      allowedNextMovesSignal: output.allowedNextMovesSignal,
      reason: output.reason,
      stallCount
    });
  }
  return { message, output };
}

function maybeBlockWorkspaceSourceDeficitAfterPublishBlock(options) {
  const actionName = readString(options && options.actionName);
  if (![
    FINALIZE_CANDIDATE_ACTION,
    "workspace_insert_after_section",
    "workspace_read",
    "workspace_replace",
    "workspace_write"
  ].includes(actionName)) {
    return null;
  }
  const runState = options && options.runState;
  if (!runState || !runState.publishBlockSignal || typeof runState.publishBlockSignal !== "object") return null;
  const sourceDeficit = readWorkspaceSourceDeficit(runState);
  if (!sourceDeficit || sourceDeficit.lengthSatisfied !== true) return null;
  if (hasWorkspaceStructureDeficit(runState)) return null;
  const message = `Workspace source-deficit cooldown is active: publish was already blocked, the candidate meets the requested length, but source minimum is still short (readSources ${sourceDeficit.readSources}/${sourceDeficit.minReadSources}, relevantSources ${sourceDeficit.relevantSources}/${sourceDeficit.minRelevantSources}). More workspace editing cannot fix source evidence. Continue web_search/read_url, or publish only a valid limited result with evidenceSatisfied=false and concrete remainingGaps.`;
  const output = {
    ok: false,
    control: "continue",
    kind: "action_pattern_preflight_block",
    status: "blocked",
    reason: "workspace_edit_blocked_by_source_deficit_after_publish_block",
    actionName,
    forbiddenMove: "workspace_edit_without_source_progress_after_publish_block",
    allowedNextMoves: [
      "web_search",
      "read_url",
      "workspace_publish_candidate_limited_with_remainingGaps"
    ],
    observableDeficit: sourceDeficit,
    publishBlockSignal: {
      count: readFiniteNumber$2(runState.publishBlockSignal.count),
      lastStatus: readString(runState.publishBlockSignal.lastStatus) || null
    },
    requiredArgsExample: buildValidLimitedPublishArgsExample(runState),
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("action-pattern-repeat-blocked", {
      actionName,
      forbiddenMove: output.forbiddenMove,
      reason: output.reason,
      readSources: sourceDeficit.readSources,
      relevantSources: sourceDeficit.relevantSources
    });
  }
  return { message, output };
}


function readWorkspaceSourceDeficit(runState) {
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : null;
  const evidence = packet && packet.evidence && typeof packet.evidence === "object"
    ? packet.evidence
    : {};
  const sourceMinimum = evidence.sourceMinimum && typeof evidence.sourceMinimum === "object"
    ? evidence.sourceMinimum
    : runState && runState.researchReportLoop && runState.researchReportLoop.sourceMinimum && typeof runState.researchReportLoop.sourceMinimum === "object"
      ? runState.researchReportLoop.sourceMinimum
      : null;
  if (!sourceMinimum || sourceMinimum.passed === true) return null;
  const minReadSources = readFiniteNumber$2(sourceMinimum.minReadSources);
  const minRelevantSources = readFiniteNumber$2(sourceMinimum.minRelevantSources);
  const readSources = readFiniteNumber$2(sourceMinimum.readSources);
  const relevantSources = readFiniteNumber$2(sourceMinimum.relevantSources);
  const readSourceDeficit = Math.max(minReadSources - readSources, 0);
  const relevantSourceDeficit = Math.max(minRelevantSources - relevantSources, 0);
  if (readSourceDeficit <= 0 && relevantSourceDeficit <= 0) return null;
  const lengthStatus = readWorkspaceRequestedLengthStatus(packet);
  return {
    lengthSatisfied: lengthStatus ? lengthStatus.satisfied : null,
    minReadSources,
    minRelevantSources,
    observedLength: lengthStatus ? lengthStatus.observed : null,
    requestedLength: lengthStatus ? lengthStatus.requested : null,
    requestedLengthUnit: lengthStatus ? lengthStatus.unit : null,
    readSourceDeficit,
    readSources,
    relevantSourceDeficit,
    relevantSources,
    successfulReadUrlCount: readFiniteNumber$2(evidence.successfulReadUrlCount)
  };
}

function readWorkspaceRequestedLengthStatus(packet) {
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const statsKey = readString(requested && requested.statsKey);
  const requestedValue = readFiniteNumber$2(requested && requested.value);
  if (!statsKey || requestedValue <= 0) return null;
  const candidate = packet && packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
    ? packet.workspace.candidate
    : packet && packet.candidate && typeof packet.candidate === "object"
      ? packet.candidate
      : null;
  const stats = candidate && candidate.stats && typeof candidate.stats === "object"
    ? candidate.stats
    : candidate && candidate.textStats && typeof candidate.textStats === "object"
      ? candidate.textStats
      : null;
  const observed = readFiniteNumber$2(stats && stats[statsKey]);
  return {
    observed,
    requested: requestedValue,
    satisfied: observed >= requestedValue,
    statsKey,
    unit: readString(requested.unit) || statsKey
  };
}

function hasWorkspaceStructureDeficit(runState) {
  const structure = readWorkspaceStructureDeficit(runState);
  return Boolean(structure && structure.ok === false);
}

function readWorkspaceStructureDeficit(runState) {
  const structure = runState &&
    runState.virtualWorkspace &&
    runState.virtualWorkspace.quality &&
    runState.virtualWorkspace.quality.finalCandidateStructure &&
    typeof runState.virtualWorkspace.quality.finalCandidateStructure === "object"
    ? runState.virtualWorkspace.quality.finalCandidateStructure
    : null;
  if (!structure || structure.ok !== false) return null;
  return {
    ok: false,
    status: readString(structure.status) || "fail",
    reason: readString(structure.reason) || "candidate structure is not publishable",
    issueCodes: Array.isArray(structure.issueCodes)
      ? structure.issueCodes.map(readString).filter(Boolean).slice(0, 8)
      : []
  };
}

function readWorkspaceLengthDeficit(runState) {
  const status = readCurrentWorkspaceLengthStatus(runState);
  if (!status || status.observed >= status.requested) return null;
  return status;
}

function estimateWorkspaceReplaceLength(runState, args, deficit) {
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const path = readString(source.path);
  const find = typeof source.find === "string" ? source.find : "";
  const replace = typeof source.replace === "string"
    ? source.replace
    : typeof source.replacement === "string"
      ? source.replacement
      : typeof source.newText === "string"
        ? source.newText
        : typeof source.text === "string"
          ? source.text
          : "";
  if (!path || !find.trim()) return 0;
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && files[path] && typeof files[path] === "object" ? files[path] : null;
  const current = typeof (file && file.content) === "string" ? file.content : "";
  if (!current || !current.includes(find)) return 0;
  const next = source.replace_all === true
    ? current.split(find).join(replace)
    : current.replace(find, replace);
  return countTextByLengthUnit(next, deficit);
}

function computeMinimumEffectiveLengthDeficitGrowth(deficit) {
  // AGRUN-244 Phase 3 — fixed anti-noop / anti-shrink floor, NOT a word-count
  // target proportion. A workspace_write/replace with genuine positive growth
  // is never a "no-growth rewrite" merely because it is small relative to a
  // requested length; only a write that shrinks or barely changes the draft is.
  const source = deficit && typeof deficit === "object" ? deficit : {};
  const statsKey = readString(source.statsKey);
  const unit = readString(source.unit);
  if (statsKey !== "words" && unit !== "words") return 1;
  return 30;
}

function readCurrentWorkspaceLengthStatus(runState) {
  const packet = runState &&
    runState.researchReportLoop &&
    runState.researchReportLoop.gateSignal &&
    runState.researchReportLoop.gateSignal.acceptancePacket &&
    typeof runState.researchReportLoop.gateSignal.acceptancePacket === "object"
    ? runState.researchReportLoop.gateSignal.acceptancePacket
    : null;
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const statsKey = readString(requested && requested.statsKey);
  const requestedValue = readFiniteNumber$2(requested && requested.value);
  if (!statsKey || requestedValue <= 0) return null;
  const candidate = packet && packet.workspace && packet.workspace.candidate && typeof packet.workspace.candidate === "object"
    ? packet.workspace.candidate
    : packet && packet.candidate && typeof packet.candidate === "object"
      ? packet.candidate
      : null;
  const stats = candidate && candidate.stats && typeof candidate.stats === "object"
    ? candidate.stats
    : candidate && candidate.textStats && typeof candidate.textStats === "object"
      ? candidate.textStats
      : null;
  const observed = readFiniteNumber$2(stats && stats[statsKey]);
  return {
    observed,
    requested: requestedValue,
    statsKey,
    unit: readString(requested.unit) || statsKey
  };
}

function readFiniteNumber$2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function countLatinWords(value) {
  const text = readString(value);
  if (!text) return 0;
  const words = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g);
  return Array.isArray(words) ? words.length : 0;
}

function countTextByLengthUnit(value, deficit) {
  const statsKey = readString(deficit && deficit.statsKey);
  const unit = readString(deficit && deficit.unit);
  if (statsKey === "cjkChars" || unit === "cjk_chars" || unit === "cjkChars" || unit === "cjk") {
    return countCjkChars(value);
  }
  if (statsKey === "chars" || unit === "chars" || unit === "characters") {
    return readString(value).length;
  }
  return countLatinWords(value);
}

function countCjkChars(value) {
  const text = readString(value);
  if (!text) return 0;
  const chars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
  return Array.isArray(chars) ? chars.length : 0;
}

function countRecentActionErrors(actionHistory, actionName) {
  let count = 0;
  for (let index = actionHistory.length - 1; index >= 0; index -= 1) {
    const entry = actionHistory[index];
    if (entry && entry.kind === "action_error" && entry.actionName === actionName) {
      count += 1;
    } else if (entry && entry.kind !== "planner_invalid_action") {
      break;
    }
  }
  return count;
}

// ADR-0013 — Recoverable action errors must surface as AI-observable
// observations, not as fatal `runState.status = "failed"` exits. This
// helper consolidates the three action error sites (validation,
// preflight, execute) that previously each had their own
// canSelfCorrect / fatal split. All three now always produce an
// observation; the planner gets the error in its next prompt and
// chooses what to do (different args, different action, valid limited
// publish, etc). maxSteps is the only terminal bound for action errors
// from here forward.
function recordRecoverableActionError({
  stage,
  actionName,
  decision,
  envelope,
  errorMessage,
  validationReason,
  validationKey,
  actionHistory,
  pushStep,
  runState,
  runtimeConfig
}) {
  runState.selfCorrectionCount = (runState.selfCorrectionCount || 0) + 1;

  const summary = stage === "execute"
    ? (countRecentActionErrors(actionHistory, actionName) > 0
        ? `${actionName} failed again (${countRecentActionErrors(actionHistory, actionName) + 1} consecutive failures): ${errorMessage}. Do NOT retry the exact same ${actionName} call. Choose a different action, different arguments, or finalize with available information if you judge that is best.`
        : `${actionName} failed: ${errorMessage}. The planner should try a different approach.`)
    : stage === "validation"
      ? `${actionName} rejected before execution: ${errorMessage}. Planner must supply correct args (${validationReason || "invalid_args"}${validationKey ? ` on "${validationKey}"` : ""}).`
      : `${actionName} rejected before execution: ${errorMessage}. Planner must supply correct args (preflight).`;

  actionHistory.push({
    actionName,
    error: errorMessage,
    kind: "action_error",
    summary
  });

  if (stage === "execute") {
    runState.lastAction = actionName;
  }

  const resultEnvelope = envelope && typeof envelope === "object"
    ? { ...envelope, summary: summary || envelope.summary }
    : createProtocolErrorEnvelope({
        actionName,
        durationMs: 0,
        reason: stage === "validation"
          ? validationReason || "validation_error"
          : stage === "preflight"
            ? "preflight_error"
            : "action_error",
        summary,
        body: {
          error: errorMessage,
          errorStage: stage,
          ok: false,
          status: "failed",
          validationKey: validationKey || null,
          validationReason: validationReason || null
        }
      });
  runState.observation = envelopeToObservation(resultEnvelope);

  const refreshStatus = stage === "validation"
    ? "validation_error_self_correct"
    : stage === "preflight"
      ? "preflight_error_self_correct"
      : "action_error_self_correct";

  refreshActionPattern({
    actionName,
    decision,
    output: { error: errorMessage, ok: false, errorStage: stage },
    pushStep,
    runState,
    runtimeConfig,
    status: refreshStatus
  });

  // terminal repair only refreshes from execute path historically; keep
  // that scope (validation/preflight never reached the repair refresh).
  if (stage === "execute") {
    refreshTerminalRepair({
      actionName,
      decision,
      output: { error: errorMessage, ok: false, errorStage: stage },
      pushStep,
      runState,
      runtimeConfig,
      status: refreshStatus
    });
  }

  if (Array.isArray(runState.failedTools)) {
    runState.failedTools.push({
      tool: actionName,
      status: "failed",
      reason: errorMessage,
      stage,
      cycle: runState.cycleCount
    });
  }

  return { done: false };
}

export { buildValidLimitedPublishArgsExample, executeAction, maybeBlockActionPatternRepeat };
