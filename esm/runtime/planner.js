import { requestProviderCompletion } from './provider.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { normalizeThrownError } from './errors.js';
import { buildPlannerPrompt, buildPlannerSystemPrompt } from './planner-prompt.js';
import { repairPlannerEnvelope, diagnosePlannerEnvelopeRejection, requestPlannerEnvelopeRepair, parsePlannerEnvelope } from './planner-repair.js';
import { isRecoveryBudgetExhausted } from './planner-recovery.js';
import { projectSessionContextFromPlannerState } from './session-context-projection.js';
import { readContextSnapshot } from '../session/context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot } from '../session/context-snapshot-projection.js';
import { buildGeminiTools, buildOpenAITools, summarizeToolCallsForDebug, parseToolCallDecision } from './planner-tools.js';
import { resolvePlannerMode, getPlannerProviderCapabilities, isLiteTierModel } from './provider-capabilities.js';
import { buildNativeToolsSystemPrompt } from './planner-native-system-prompt.js';
import { createPlannerRequestPacket, createPlannerResponsePacket } from './agent-workflow-packets.js';
import { isResearchQualityGateRequired } from './convergence-activation.js';

async function planNextAction(options) {
  const plannerModeSelection = resolvePlannerMode({
    actions: options && options.availableActions,
    configuredMode: readPlannerMode(options),
    model: options && options.request && options.request.model,
    provider: options && options.request && options.request.provider
  });
  if (options && options.runState && typeof options.runState === "object") {
    options.runState.plannerModeSelection = plannerModeSelection;
  }
  emitStep(options, "planner-mode-resolved", {
    configuredMode: plannerModeSelection.configuredMode,
    effectiveMode: plannerModeSelection.effectiveMode,
    model: options && options.request && options.request.model,
    provider: options && options.request && options.request.provider,
    reason: plannerModeSelection.reason
  });
  const plannerMode = plannerModeSelection.effectiveMode;

  if (plannerMode === "native_tools") {
    try {
      return await planNextActionWithNativeTools(options);
    } catch (error) {
      if (error && error.code === "CIRCUIT_OPEN") {
        return createCircuitOpenPlannerResult(error, options);
      }
      const nativeToolsError = error;
      const failurePolicy = readNativeToolsFailurePolicy(options);
      if (failurePolicy === "hard_fail") {
        emitStep(options, "planner-native-tools-failed", {
          error: normalizeThrownError(nativeToolsError).message,
          policy: failurePolicy,
          provider: options.request && options.request.provider,
          reason: "native_tools_failed"
        });
        throw nativeToolsError;
      }
      emitStep(options, "planner-native-tools-fallback", {
        error: normalizeThrownError(nativeToolsError).message,
        policy: failurePolicy,
        provider: options.request && options.request.provider,
        reason: "native_tools_failed"
      });
      try {
        return await planNextActionWithEnvelope(options);
      } catch (envelopeError) {
        if (envelopeError && envelopeError.code === "CIRCUIT_OPEN") {
          return createCircuitOpenPlannerResult(envelopeError, options);
        }
        // Preserve the original native_tools failure so debug logs and
        // error reporters can see both root causes, not just the envelope
        // fallback that also failed.
        if (envelopeError && typeof envelopeError === "object" && !envelopeError.nativeToolsCause) {
          envelopeError.nativeToolsCause = nativeToolsError;
        }
        throw envelopeError;
      }
    }
  }

  try {
    return await planNextActionWithEnvelope(options);
  } catch (error) {
    if (error && error.code === "CIRCUIT_OPEN") {
      return createCircuitOpenPlannerResult(error, options);
    }
    throw error;
  }
}

async function planNextActionWithNativeTools(options) {
  const prompt = typeof options.prompt === "string" && options.prompt.trim().length > 0
    ? options.prompt
    : buildPlannerPrompt(options);
  const sessionContext = projectSessionContextFromPlannerState(
    projectSessionContextFromSnapshot(
      readContextSnapshot(options.contextSnapshot)
        || readContextSnapshot(options.request)
    ),
    options.plannerState
  );
  const provider = options.request && options.request.provider;
  const capabilities = getPlannerProviderCapabilities(provider);
  const suppressFinalAnswerTool = shouldSuppressNativeFinalAnswerTool(options);
  const suppressFinalizeTool = shouldSuppressNativeFinalizeTool(options);
  const tools = provider === "gemini"
    ? buildGeminiTools(options.availableActions, { suppressFinalAnswerTool, suppressFinalizeTool })
    : buildOpenAITools(options.availableActions, { suppressFinalAnswerTool, suppressFinalizeTool });
  const systemPrompt = buildNativeToolsSystemPrompt(
    options.agentRole,
    options.request && options.request.systemPrompt,
    capabilities,
    options.plannerDirectives,
    options.availableActions,
    options.prompts,
    options.runtimeConfig
  );
  emitStep(options, "agent-workflow-packet", createPlannerRequestPacket({
    activeAgentSkill: options.activeAgentSkill,
    availableActions: options.availableActions,
    mode: "native_tools",
    prompt,
    request: options.request,
    runState: options.runState,
    sessionContext,
    systemPrompt,
    toolChoice: "required",
    tools
  }));

  const providerStartedAt = Date.now();
  const response = await requestProviderCompletion(options.request, {
    prompt,
    sessionContext,
    systemPrompt,
    timeoutMs: options.timeoutMs || null,
    tools,
    toolChoice: "required"
  });
  const providerDurationMs = Date.now() - providerStartedAt;

  let decision = null;

  if (response.toolCalls) {
    if (options.debug && options.debug.enabled) {
      options.debug.log("planner native tool calls | raw args shape", {
        provider: options.request && options.request.provider,
        toolCalls: summarizeToolCallsForDebug(response.toolCalls)
      });
    }
    decision = parseToolCallDecision(response.toolCalls);
    emitStep(options, "planner-native-tool-call", {
      provider: options.request.provider,
      responseType: readDecisionType(decision),
      toolCallCount: response.toolCalls.length
    });
  }

  let rawRejectedNameNative = readRejectedNativeToolName(response.toolCalls);
  if (!decision && response.text) {
    const parsed = parsePlannerEnvelopeSafely(response.text);
    if (!rawRejectedNameNative) rawRejectedNameNative = readRejectedActionName(parsed.value);
    decision = repairPlannerEnvelope(parsed.value, {
      ...options,
      responseText: response.text
    });
    if (!decision) {
      decision = await requestInvalidPlannerOutputOverride(options, response.text, parsed.error);
    }
    emitStep(options, "agent-workflow-packet", createPlannerResponsePacket({
      decision,
      durationMs: providerDurationMs,
      mode: "native_tools",
      parseError: parsed.error ? normalizeThrownError(parsed.error).message : null,
      repairPath: decision ? "envelope_text_repair" : "invalid_or_hook",
      request: options.request,
      response,
      responseType: decision ? readDecisionType(decision) : "invalid",
      runState: options.runState
    }));
  } else {
    emitStep(options, "agent-workflow-packet", createPlannerResponsePacket({
      decision,
      durationMs: providerDurationMs,
      mode: "native_tools",
      repairPath: "none",
      request: options.request,
      response,
      responseType: Array.isArray(response.toolCalls) && response.toolCalls.length > 0 ? "tool_call" : readDecisionType(decision),
      runState: options.runState
    }));
  }

  return {
    decision: decision || null,
    prompt,
    repairResponse: null,
    response,
    strictRetryResponse: null,
    rejectedActionName: decision ? null : rawRejectedNameNative,
    repairAttempted: false
  };
}

function readRejectedNativeToolName(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const first = toolCalls[0];
  if (!first || typeof first !== "object") return null;
  const name = typeof first.name === "string" ? first.name.trim().toLowerCase() : "";
  return name || null;
}

function shouldSuppressNativeFinalAnswerTool(options) {
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : {};
  if (isTerminalRepairActive(runState)) {
    return true;
  }
  if (isResearchQualityGateRequired(runState, {
    prompt: options && options.request && options.request.prompt
  })) {
    return true;
  }
  if (runState.virtualWorkspace && typeof runState.virtualWorkspace === "object" && runState.virtualWorkspace.enabled === true) {
    return true;
  }
  if (runState.agentSkillContext && typeof runState.agentSkillContext === "object") {
    const activeSkill = runState.agentSkillContext.activeSkill;
    const lastReadSkill = runState.agentSkillContext.lastReadSkill;
    if (readString$r(activeSkill && activeSkill.name) || readString$r(lastReadSkill && lastReadSkill.name)) {
      return true;
    }
  }
  if (readString$r(options && options.activeAgentSkill && options.activeAgentSkill.name)) {
    return true;
  }
  const readSources = runState.researchContext && Array.isArray(runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  return readSources.length > 0;
}

function shouldSuppressNativeFinalizeTool(options) {
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : {};
  return isTerminalRepairActive(runState);
}

function isTerminalRepairActive(runState) {
  if (runState && runState.terminalRepairState && runState.terminalRepairState.active === true) {
    return true;
  }
  const convergence = runState && runState.actionPatternConvergence && typeof runState.actionPatternConvergence === "object"
    ? runState.actionPatternConvergence
    : null;
  const correction = convergence && convergence.terminalCorrectionState && typeof convergence.terminalCorrectionState === "object"
    ? convergence.terminalCorrectionState
    : null;
  const cooldown = convergence && convergence.terminalRetryCooldown && typeof convergence.terminalRetryCooldown === "object"
    ? convergence.terminalRetryCooldown
    : null;
  return Boolean((correction && correction.active === true) || (cooldown && cooldown.active === true));
}

function readPlannerMode(options) {
  if (options && typeof options.plannerMode === "string") {
    return options.plannerMode;
  }
  if (options && options.request && typeof options.request.plannerMode === "string") {
    return options.request.plannerMode;
  }
  return "auto";
}

function readNativeToolsFailurePolicy(options) {
  if (options && options.nativeToolsFailurePolicy === "hard_fail") {
    return "hard_fail";
  }
  if (
    options &&
    options.request &&
    options.request.nativeToolsFailurePolicy === "hard_fail"
  ) {
    return "hard_fail";
  }
  return "fallback_to_envelope";
}

function readString$r(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePlannerEnvelopeSafely(text) {
  try {
    return {
      error: null,
      value: parsePlannerEnvelope(text)
    };
  } catch (error) {
    return {
      error,
      value: null
    };
  }
}

async function requestInvalidPlannerOutputOverride(options, rawText, parseError) {
  if (typeof options.onInvalidPlannerOutput !== "function") {
    return null;
  }

  emitStep(options, "planner-invalid-output-hook-requested", {
    error: parseError ? normalizeThrownError(parseError).message : null,
    provider: options.request && options.request.provider
  });

  // Raced — a hung host hook degrades to "ignored", never blocks the
  // planner's error-recovery path.
  const hook = await callHostHookWithTimeout(
    () => options.onInvalidPlannerOutput(
      readString$r(rawText),
      parseError || null,
      options.runState || null
    ),
    {
      hookName: "onInvalidPlannerOutput",
      timeoutMs: options.runtimeConfig && options.runtimeConfig.hostHookTimeoutMs
    }
  );
  if (!hook.ok) {
    if (options.debug && options.debug.enabled) {
      options.debug.log(`onInvalidPlannerOutput hook ${hook.timedOut ? "timed out" : "threw"}`, {
        error: hook.message
      });
    }
    emitStep(options, "planner-invalid-output-hook-failed", {
      error: hook.message,
      provider: options.request && options.request.provider
    });
    return null;
  }
  const decision = repairPlannerEnvelope(hook.value, {
    ...options,
    responseText: rawText
  });
  emitStep(options, decision ? "planner-invalid-output-hook-completed" : "planner-invalid-output-hook-ignored", {
    provider: options.request && options.request.provider,
    responseType: readDecisionType(decision)
  });
  return decision;
}

async function planNextActionWithEnvelope(options) {
  const prompt = typeof options.prompt === "string" && options.prompt.trim().length > 0
    ? options.prompt
    : buildPlannerPrompt(options);
  const sessionContext = projectSessionContextFromPlannerState(
    projectSessionContextFromSnapshot(
      readContextSnapshot(options.contextSnapshot)
        || readContextSnapshot(options.request)
    ),
    options.plannerState
  );
  const systemPromptProfile = selectPlannerSystemPromptProfile(options);
  const plannerSystemPrompt = buildPlannerSystemPrompt(options.availableActions, {
    agentRole: options.agentRole,
    compactSystemPrompt: systemPromptProfile.compact,
    systemPrompt: options.request && options.request.systemPrompt,
    plannerDirectives: options.plannerDirectives,
    plannerMode: options.plannerMode,
    effectivePlannerMode: options.runState && options.runState.plannerModeSelection && options.runState.plannerModeSelection.effectiveMode,
    request: options.request,
    runState: options.runState,
    todoState: options.runState && options.runState.todoState,
    preferFinalizeOnLastResult: options.preferFinalizeOnLastResult,
    goalAnchorBlock: options.goalAnchorBlock,
    prompts: options.prompts,
    runtimeConfig: options.runtimeConfig
  });
  emitStep(options, "planner-system-prompt-profile", systemPromptProfile);
  emitStep(options, "agent-workflow-packet", createPlannerRequestPacket({
    activeAgentSkill: options.activeAgentSkill,
    availableActions: options.availableActions,
    mode: "envelope",
    prompt,
    request: options.request,
    runState: options.runState,
    sessionContext,
    systemPrompt: plannerSystemPrompt,
    tools: []
  }));
  const providerStartedAt = Date.now();
  const response = await requestProviderCompletion(options.request, {
    prompt,
    sessionContext,
    systemPrompt: plannerSystemPrompt,
    timeoutMs: options.timeoutMs || null
  });
  const providerDurationMs = Date.now() - providerStartedAt;
  const parsed = parsePlannerEnvelopeSafely(response.text);
  // ADR-0034 — capture the raw rejected action name from the envelope's
  // structural `name` / `action` / `tool` / `toolName` field so the
  // invalid-action convergence slot can key on it. Reads JSON structure
  // only — no regex or prose detection.
  const rawRejectedName = readRejectedActionName(parsed.value);
  const originalRejection = parsed.error
    ? {
        reason: "parse_error",
        message: normalizeThrownError(parsed.error).message,
        type: null
      }
    : diagnosePlannerEnvelopeRejection(parsed.value, options);
  let decision = repairPlannerEnvelope(parsed.value, {
    ...options,
    responseText: response.text
  });
  let repairResponse = null;
  let repairRejection = null;
  let repairPath = decision ? "none" : "invalid";

  if (!decision) {
    decision = await requestInvalidPlannerOutputOverride(options, response.text, parsed.error);
    if (decision) repairPath = "invalid_output_hook";
  }

  // AGRUN-486 (audit H8) — gate the N+1 repair LLM call on the recovery
  // budget. After MAX_RECOVERY_RETRIES consecutive cycles where repair was
  // attempted and still failed, stop paying for the repair shim: surface the
  // null decision so the planner re-plans next cycle on its own and the run's
  // terminal-repair / invalid-action-convergence machinery owns recovery. The
  // budget ticks in handleInvalidPlannerDecision (per failed repair) and clears
  // via resetRecoveryBudget the moment a valid decision is produced.
  if (!decision && isRecoveryBudgetExhausted(options.runState)) {
    const recoveryState = options.runState && options.runState.recoveryState;
    emitStep(options, "planner-repair-budget-exhausted", {
      provider: options.request.provider,
      retries: recoveryState && typeof recoveryState.retries === "number" ? recoveryState.retries : null
    });
    repairPath = "repair_budget_exhausted";
  }

  if (!decision && repairPath !== "repair_budget_exhausted") {
    const repairStartedAt = Date.now();
    emitStep(options, "planner-repair-requested", {
      attempt: 1,
      provider: options.request.provider
    });
    const repaired = await requestPlannerEnvelopeRepair({
      availableActions: options.availableActions,
      effectivePlannerMode: options.runState && options.runState.plannerModeSelection && options.runState.plannerModeSelection.effectiveMode,
      plannerMode: options.plannerMode,
      plannerPrompt: prompt,
      request: options.request,
      runState: options.runState,
      responseText: response.text,
      systemPrompt: plannerSystemPrompt,
      todoState: options.runState && options.runState.todoState
    });
    decision = repaired.decision;
    repairResponse = repaired.response;
    repairRejection = repaired.rejection || null;
    repairPath = decision ? "repair" : "repair_failed";
    emitStep(options, decision ? "planner-repair-completed" : "planner-repair-failed", {
      attempt: 1,
      durationMs: Date.now() - repairStartedAt,
      originalReason: originalRejection && originalRejection.reason,
      provider: options.request.provider,
      rejectedActionName: (repairRejection && repairRejection.rejectedActionName)
        || (originalRejection && originalRejection.rejectedActionName)
        || rawRejectedName
        || null,
      rejection: repairRejection || originalRejection,
      responseType: readDecisionType(decision),
      text: repaired.text
    });
  }

  // ADR-0023 — Strict retry (3rd API call) deleted. When envelope repair
  // returns null, the original null decision surfaces — AI re-plans next
  // cycle on its own. Pure JSON-envelope repair (`requestPlannerEnvelopeRepair`
  // above) remains because it is a JSON-fix shim, not a runtime decision.
  // The deleted strict retry was push-mode: runtime authored a hardcoded
  // "stricter" prompt asking the LLM to retry with extra constraints.

  emitStep(options, "agent-workflow-packet", createPlannerResponsePacket({
    decision,
    durationMs: repairResponse && typeof repairResponse.durationMs === "number" ? repairResponse.durationMs : providerDurationMs,
    mode: "envelope",
    parseError: parsed.error ? normalizeThrownError(parsed.error).message : null,
    repairPath,
    request: options.request,
    rejection: repairRejection || (!decision ? originalRejection : null),
    response: repairResponse || response,
    responseType: decision ? readDecisionType(decision) : "invalid",
    runState: options.runState
  }));

  return {
    decision: decision || null,
    prompt,
    repairResponse,
    response: repairResponse || response,
    strictRetryResponse: null,
    rejectedActionName: decision ? null : rawRejectedName,
    invalidKind: decision ? null : readString$r((repairRejection || originalRejection) && (repairRejection || originalRejection).reason),
    invalidReason: decision ? null : (repairRejection || originalRejection),
    repairAttempted: repairPath === "repair" || repairPath === "repair_failed"
  };
}

function readRejectedActionName(parsedValue) {
  if (!parsedValue || typeof parsedValue !== "object") return null;
  const candidates = [parsedValue.name, parsedValue.action, parsedValue.tool, parsedValue.toolName];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim().toLowerCase();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function emitStep(options, type, detail) {
  if (options && typeof options.pushStep === "function") {
    options.pushStep(type, detail);
  }
}

function readDecisionType(decision) {
  return decision && typeof decision === "object" && typeof decision.type === "string"
    ? decision.type
    : "invalid";
}

function createCircuitOpenPlannerResult(error, options) {
  const provider = error.providerKey || (options.request && options.request.provider) || "unknown";
  emitStep(options, "planner-circuit-open", {
    provider,
    failures: error.circuitState && error.circuitState.failures,
    remainingMs: error.circuitState && error.circuitState.remainingMs
  });
  return {
    decision: {
      instruction: `The ${provider} provider is temporarily unavailable (circuit breaker open after ${error.circuitState ? error.circuitState.failures : "multiple"} consecutive failures). Answer using whatever information is currently available, or explain that the service is temporarily unreachable.`,
      reasoning: `Circuit breaker open for ${provider}.`,
      type: "finalize"
    },
    prompt: null,
    repairResponse: null,
    response: null,
    strictRetryResponse: null
  };
}

function selectPlannerSystemPromptProfile(options) {
  const request = options && options.request && typeof options.request === "object"
    ? options.request
    : {};
  if (request.compactPlannerSystemPrompt === false) {
    return { compact: false, reason: "request_disabled" };
  }
  // ADR-0033 Tier A — lite-tier models always run compact, even with rich
  // state (active skill / todo / workspace). Capable models keep the
  // state-based decision below. Host can pass `request.modelTier: "lite"`
  // or `"capable"` to override the name-string heuristic.
  if (isLiteTierModel(request.model, { modelTier: request.modelTier })) {
    return { compact: true, reason: "lite_tier_model_compact" };
  }
  if (hasSkillContext(options && options.activeAgentSkill)) {
    return { compact: false, reason: "active_agent_skill" };
  }
  if (hasSkillContext(options && options.lastReadAgentSkill)) {
    return { compact: false, reason: "last_read_agent_skill" };
  }

  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : {};
  const agentSkillContext = runState.agentSkillContext && typeof runState.agentSkillContext === "object"
    ? runState.agentSkillContext
    : {};
  if (hasSkillContext(agentSkillContext.activeSkill)) {
    return { compact: false, reason: "run_state_active_agent_skill" };
  }
  if (hasSkillContext(agentSkillContext.lastReadSkill)) {
    return { compact: false, reason: "run_state_last_read_agent_skill" };
  }
  if (hasActiveTodoState(runState.todoState)) {
    return { compact: false, reason: "active_todo_state" };
  }
  if (typeof (options && options.todoStateBlock) === "string" && options.todoStateBlock.trim()) {
    return { compact: false, reason: "todo_state_block" };
  }
  if (hasVirtualWorkspaceContent(runState.virtualWorkspace)) {
    return { compact: false, reason: "virtual_workspace_content" };
  }
  return { compact: true, reason: "simple_state" };
}

function hasSkillContext(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.name === "string" &&
    value.name.trim()
  );
}

function hasActiveTodoState(todoState) {
  if (!todoState || typeof todoState !== "object" || !Array.isArray(todoState.items)) return false;
  if (todoState.status === "completed" || todoState.status === "abandoned") return false;
  return todoState.items.some((item) => (
    item &&
    typeof item === "object" &&
    (item.status === "active" || item.status === "pending" || item.status === "blocked")
  ));
}

function hasVirtualWorkspaceContent(virtualWorkspace) {
  if (!virtualWorkspace || typeof virtualWorkspace !== "object" || Array.isArray(virtualWorkspace)) return false;
  const files = virtualWorkspace.files && typeof virtualWorkspace.files === "object" && !Array.isArray(virtualWorkspace.files)
    ? virtualWorkspace.files
    : {};
  const hasFiles = Object.values(files).some((file) => {
    if (!file || typeof file !== "object") return true;
    return typeof file.content === "string" ? file.content.trim().length > 0 : true;
  });
  if (hasFiles) return true;
  return Array.isArray(virtualWorkspace.operations) && virtualWorkspace.operations.length > 0;
}

export { parsePlannerEnvelope, planNextAction, selectPlannerSystemPromptProfile };
