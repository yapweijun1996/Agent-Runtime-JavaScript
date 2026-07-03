import { readString } from './semantic-json.js';
import { WEB_SEARCH_ACTION, READ_URL_ACTION, TODO_RUN_NEXT_ACTION, ASK_CLARIFICATION_ACTION, LIST_AGENT_SKILLS_ACTION, READ_AGENT_SKILL_ACTION, USE_AGENT_SKILL_ACTION, HANDOFF_TO_SKILL_ACTION, EXECUTE_SKILL_TOOL_ACTION, PUBLISH_DIRECT_ACTION } from './action-names.js';
import { maybeBlockUnnecessaryLongResearchClarification, maybeBlockLongResearchSearchWithoutRead } from './blocks/long-research.js';
import { maybeBlockLateBudgetWorkspaceProtocolWindow } from './blocks/late-budget.js';
import { readWorkspaceLengthDeficit, readCurrentWorkspaceLengthStatus } from './blocks/workspace-deficit-reads.js';
import { maybeBlockActionGuardrail } from './blocks/guardrail.js';
import { maybeBlockSatisfiedCandidateMutation } from './blocks/satisfied-candidate.js';
import { maybeBlockWorkspaceNoProgressLoop } from './blocks/no-progress.js';
import { maybeBlockLengthDeficitRewrite } from './blocks/length-deficit-rewrite.js';
import { maybeBlockWorkspaceSourceDeficitAfterPublishBlock } from './blocks/source-deficit-after-publish.js';
import { maybeBlockWorkspaceMutationGrowthLoop, maybeBlockStructureRepairLoop, maybeBlockReadOnlyPlanningLoop } from './blocks/convergence-loops.js';
import { maybeBlockTerminalRepairAction, maybeBlockTerminalCorrectionRetry } from './blocks/terminal-repair.js';
import { ERROR_CODES, normalizeThrownError, serializeError } from './errors.js';
import { finalizeActionLoopFailure } from './action-loop-failure.js';
import { handleActionResult } from './action-loop-action-result.js';
import { cloneValue } from './utils.js';
import './tool-schema.js';
import { stampThreadProvenance } from './thread-provenance.js';
import { refreshActionGuardrail } from './action-guardrail-controller.js';
import { refreshActionPatternConvergence, shouldEmitActionPatternConvergenceRefreshed } from './action-pattern-convergence.js';
import { refreshRequirementRecoveryEvaluator } from './requirement-recovery-evaluator.js';
import { refreshReadUrlRecoverySignal } from './read-url-recovery-signal.js';
import { refreshResearchState } from './research-state.js';
import { markActionProgress } from './session-budget.js';
import { refreshTerminalRepairState, buildTerminalRepairRefreshedStepDetail, shouldEmitAdvisoryPersistenceSignalStep } from './terminal-repair/core.js';
import { applyInvalidActionConvergenceOnSuccess } from './invalid-action-convergence.js';
import './runtime-event-classifier.js';
import { readActionArgs, readWebSearchEndpoint, nextActionCallId } from './action-loop-utils.js';
import { sanitizeActionStepArgs } from './action-step-args.js';
import { validateActionArgs } from './action-args-validation.js';
import { fingerprintAction } from './action-fingerprint.js';
import { appendWebSearchOutput, appendResearchReadSource } from './search-research-context.js';
import { createRuntimeStreamEmitter } from './provider-stream-events.js';
import { maybeCreateTodoActionProgressDecision } from './todo-action-progress.js';
import { applyTodoRunNextToRunState } from './actions/todo-actions.js';
import { pushReadUrlRequestedStep, pushReadUrlCompletedStep, readResearchQuery, syncSearchInquiryContext, createResearchReadSource, syncReadInquiryContext, syncPendingClarification, shouldRefreshLongRunRequirementRecovery } from './action-loop-action-context.js';
import { resetAgentHandoffChainForSkill, applyAgentHandoffToSession } from './handoff-input-filter.js';
import { normalizeActionResultEnvelope, createExecuteErrorEnvelope, createProtocolErrorEnvelope, envelopeToObservation } from './action-result-envelope.js';
import { executeActionWithTimeout, ACTION_TIMEOUT_REASON, buildActionTimeoutMessage } from './action-execute-timeout.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { shouldRecordStructuredToolEvidence, recordStructuredToolEvidence } from './action-evidence.js';

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
    runState,
    // AGRUN-509 — forward runtimeConfig so the budget-expansion advisory gate
    // honors host-overridden terminalRepair thresholds (parity with the
    // onResponse hook door).
    runtimeConfig
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

    if (actionName === WEB_SEARCH_ACTION) {
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

    if (actionName === READ_URL_ACTION) {
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
    if (todoProgressDecision && todoProgressDecision.name === TODO_RUN_NEXT_ACTION) {
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

    if (actionName === ASK_CLARIFICATION_ACTION) {
      syncPendingClarification(runState, actionResult.output);
    }

    if (actionName === LIST_AGENT_SKILLS_ACTION) {
      runState.agentSkillContext.catalogListed = true;
    }

    if (actionName === READ_AGENT_SKILL_ACTION) {
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

    if (actionName === USE_AGENT_SKILL_ACTION) {
      const selectedSkill = cloneValue(actionResult.output.skill || null);
      runState.agentSkillContext.activeSkill = selectedSkill;
      resetAgentHandoffChainForSkill(runState.agentSkillContext, selectedSkill);
      refreshResearchState(runState, {
        phase: "skill_active",
        prompt: request && request.prompt
      });
    }

    if (actionName === HANDOFF_TO_SKILL_ACTION) {
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

    if (actionName === EXECUTE_SKILL_TOOL_ACTION) {
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

    if (actionName !== WEB_SEARCH_ACTION && actionName !== READ_URL_ACTION) {
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
  if (actionName !== EXECUTE_SKILL_TOOL_ACTION) {
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
  if (actionName !== EXECUTE_SKILL_TOOL_ACTION) {
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
    runState,
    readWorkspaceLengthDeficit
  });
  if (unnecessaryClarificationBlock) return unnecessaryClarificationBlock;
  const searchWithoutReadBlock = maybeBlockLongResearchSearchWithoutRead({
    actionName,
    pushStep: options && options.pushStep,
    runState,
    readWorkspaceLengthDeficit
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
    runState,
    readCurrentWorkspaceLengthStatus
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
  const repeatCount = readFiniteNumber(signal.repeatCount) || readFiniteNumber(convergence.repeatedFingerprintCount);
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
    stepsWithoutObservableProgress: readFiniteNumber(convergence.stepsWithoutObservableProgress),
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

function readFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

export { executeAction, maybeBlockActionPatternRepeat };
