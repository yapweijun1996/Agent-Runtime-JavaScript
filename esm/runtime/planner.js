import { requestProviderCompletion, requestProviderCompletionStreaming } from './provider.js';
import { recordProviderCallDuration } from './provider-latency.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { normalizeThrownError } from './errors.js';
import { scrubSecretText } from './secret-redaction.js';
import { buildPlannerPrompt, buildPlannerSystemPrompt } from './planner-prompt.js';
import { repairPlannerEnvelope, diagnosePlannerEnvelopeRejection, requestPlannerEnvelopeRepair, parsePlannerEnvelope } from './planner-repair.js';
import { isRecoveryBudgetExhausted } from './planner-recovery.js';
import { projectSessionContextFromPlannerState } from './session-context-projection.js';
import { readContextSnapshot } from '../session/context-snapshot-normalize.js';
import { readString } from './semantic-json.js';
import { projectSessionContextFromSnapshot } from '../session/context-snapshot-projection.js';
import { buildGeminiTools, buildOpenAITools, summarizeToolCallsForDebug, parseToolCallDecision, readStandalonePlanActionNames } from './planner-tools.js';
import { resolvePlannerMode, getPlannerProviderCapabilities, isLiteTierModel } from './provider-capabilities.js';
import { buildNativeToolsSystemPrompt } from './planner-native-system-prompt.js';
import { createStreamFence } from './final-response-scrubber.js';
import { createPlannerRequestPacket, createPlannerResponsePacket } from './agent-workflow-packets.js';
import { isResearchQualityGateRequired } from './convergence-activation.js';

// AGRUN-419-followup — run the planner provider call, streaming the model's
// reasoning when the host wired onReasoning / onStreamEvent. The planner output
// is a structured envelope / native tool-call (not clean prose), so text deltas
// are intentionally NOT routed to a host onToken — only reasoning deltas and
// stream events flow, which is what fills the "Thinking" panel while a direct
// planner_final answer is being produced (no separate finalize call streams it).
// Falls back to the non-streaming call when no reasoning consumer is registered,
// keeping the default path untouched. SSOT for both planner doors (native_tools
// and envelope).
async function requestPlannerProviderResponse(options, overrides, streamOnToken) {
  const onReasoning = typeof options.onReasoning === "function" ? options.onReasoning : null;
  const onStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;
  // C3c (AGRUN-585) — the NATIVE door passes a fenced onToken so a direct
  // text answer streams at TTFT; the envelope door never does (JSON output).
  const onToken = typeof streamOnToken === "function" ? streamOnToken : null;
  // AGRUN-568 — record each SUCCESSFUL planner call's duration so
  // deriveProviderTimeoutMs can floor the next call's deadline at 2x the
  // run's observed max (slow providers like deepseek legitimately spend
  // 30-90s per cycle; a fixed 120s deadline killed runs one cycle after an
  // 89s success). Failures are deliberately not recorded — the retry
  // escalation in provider.js owns failure-driven growth.
  const startedAt = Date.now();
  const recordSuccess = (response) => {
    recordProviderCallDuration(options.runState, Date.now() - startedAt);
    return response;
  };
  if (!onReasoning && !onStreamEvent && !onToken) {
    return requestProviderCompletion(options.request, overrides).then(recordSuccess);
  }
  const streamContext = {
    ledger: options.runState && options.runState.eventLedger,
    runId: options.runState && options.runState.runId,
    source: "planner"
  };
  return requestProviderCompletionStreaming(
    options.request,
    overrides,
    onToken,
    onStreamEvent,
    streamContext,
    onReasoning
  ).then(recordSuccess);
}

async function planNextAction(options) {
  const plannerModeSelection = resolvePlannerMode({
    configuredMode: readPlannerMode(options)
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
      // ADR-0058 — the native failure message can embed provider request
      // details (an assertion/provider error may quote the Authorization
      // header verbatim); steps and the event ledger are host-visible, so
      // scrub before emitting (AGRUN-556 SSOT).
      const nativeToolsErrorMessage = scrubSecretText(normalizeThrownError(nativeToolsError).message);
      if (failurePolicy === "hard_fail") {
        emitStep(options, "planner-native-tools-failed", {
          error: nativeToolsErrorMessage,
          policy: failurePolicy,
          provider: options.request && options.request.provider,
          reason: "native_tools_failed"
        });
        throw nativeToolsError;
      }
      emitStep(options, "planner-native-tools-fallback", {
        error: nativeToolsErrorMessage,
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
  const suppressPlanTool = shouldSuppressNativePlanTool(options);
  const tools = provider === "gemini"
    ? buildGeminiTools(options.availableActions, { suppressFinalAnswerTool, suppressFinalizeTool, suppressPlanTool })
    : buildOpenAITools(options.availableActions, { suppressFinalAnswerTool, suppressFinalizeTool, suppressPlanTool });
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
    // C3a (AGRUN-574, ROADMAP Phase C) — "auto", not "required". Forcing a
    // tool call every cycle removed the model's only way to terminate by
    // answering, which looped tool calls to maxSteps exhaustion (AGRUN-573
    // spike: lookup_order 8x, status failed). With auto, a no-tool text
    // response IS the final answer (decide-and-answer in one call — the loop
    // shape every surveyed framework uses; audits/why-other-agents-feel-fast).
    toolChoice: "auto",
    tools
  }));

  // C3c (AGRUN-585) — stream a fenced direct answer through onToken at TTFT.
  // The fence (SSOT: final-response-scrubber.js) buffers JSON/fenced-block
  // prefixes so an envelope-shaped emission or tool-call payload never leaks
  // to the host; plain prose forwards as it arrives. streamedChars lets the
  // direct-answer branch mark the decision so the planner_final terminal
  // skips its one-shot onToken (no duplicate text).
  let streamedChars = 0;
  const hostOnToken = typeof options.onToken === "function" ? options.onToken : null;
  const fence = createStreamFence(hostOnToken
    ? (token) => {
      streamedChars += String(token).length;
      hostOnToken(token);
    }
    : null);
  // First-character latch in front of the fence: the fence swallows ACTION
  // envelope blocks but forwards other JSON (e.g. a {"type":"final",...}
  // emission) as text — which must never leak raw to onToken. Buffer until
  // the first non-whitespace character: '{' or '`' latches the stream CLOSED
  // (the terminal one-shot will deliver the parsed answer instead); anything
  // else opens the stream and prose flows at TTFT.
  const latch = { state: "buffering", buffer: "" };
  const latchedOnToken = fence.wrappedOnToken
    ? (token) => {
      if (latch.state === "closed") return;
      if (latch.state === "open") {
        fence.wrappedOnToken(token);
        return;
      }
      latch.buffer += String(token);
      const firstChar = latch.buffer.trimStart().charAt(0);
      if (!firstChar) return;
      if (firstChar === "{" || firstChar === "`") {
        latch.state = "closed";
        latch.buffer = "";
        return;
      }
      latch.state = "open";
      const buffered = latch.buffer;
      latch.buffer = "";
      fence.wrappedOnToken(buffered);
    }
    : null;

  const providerStartedAt = Date.now();
  const response = await requestPlannerProviderResponse(options, {
    prompt,
    sessionContext,
    systemPrompt,
    timeoutMs: options.timeoutMs || null,
    tools,
    toolChoice: "auto"
  }, latchedOnToken);
  const providerDurationMs = Date.now() - providerStartedAt;

  let decision = null;

  if (response.toolCalls) {
    if (options.debug && options.debug.enabled) {
      options.debug.log("planner native tool calls | raw args shape", {
        provider: options.request && options.request.provider,
        toolCalls: summarizeToolCallsForDebug(response.toolCalls)
      });
    }
    // AGRUN-588 — tell the batch reader which actions are standalone-only so
    // a parallel batch that plan validation would reject (e.g. deepseek's
    // [todo_advance, todo_advance]) falls back to first-call-decides instead
    // of burning a cycle on a guaranteed skill_mutator_in_plan rejection.
    decision = parseToolCallDecision(response.toolCalls, {
      standalonePlanActionNames: readStandalonePlanActionNames(options.availableActions)
    });
    emitStep(options, "planner-native-tool-call", {
      provider: options.request.provider,
      responseType: readDecisionType(decision),
      toolCallCount: response.toolCalls.length
    });
    // C3b (AGRUN-575) — surface when multiple parallel tool calls were
    // batched into one plan decision (previously all but the first were
    // silently dropped).
    if (decision && decision.nativeParallelBatch === true) {
      emitStep(options, "planner-native-parallel-batch", {
        actionCount: decision.actions.length,
        actionNames: decision.actions.map((action) => action.name),
        provider: options.request.provider
      });
    }
  }

  let rawRejectedNameNative = readRejectedNativeToolName(response.toolCalls);
  // C3a (AGRUN-574) — with toolChoice "auto", a no-tool plain-text response
  // is the model terminating by answering (stop_reason branch). Structural
  // check only: text that looks like a JSON/fenced envelope attempt still
  // goes through the existing envelope repair path below.
  if (!decision && response.text && !looksLikeEnvelopeText(response.text)) {
    const answer = response.text.trim();
    // C3c — emit any buffered fence tail, then mark the decision so the
    // terminal knows the answer already streamed (skip the one-shot).
    fence.flush();
    decision = { type: "final", answer };
    if (streamedChars > 0) {
      decision.answerStreamed = true;
    }
    emitStep(options, "planner-native-direct-answer", {
      answerLength: answer.length,
      provider: options.request && options.request.provider,
      reason: "no_tool_calls_text_is_answer",
      streamedChars
    });
    emitStep(options, "agent-workflow-packet", createPlannerResponsePacket({
      decision,
      durationMs: providerDurationMs,
      mode: "native_tools",
      repairPath: "native_direct_answer",
      request: options.request,
      response,
      responseType: "final",
      runState: options.runState
    }));
    return {
      decision,
      prompt,
      repairResponse: null,
      response,
      strictRetryResponse: null,
      rejectedActionName: null,
      repairAttempted: false
    };
  }
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

// C3a — structural (non-semantic) check: does the no-tool text look like an
// attempted JSON envelope / fenced code block rather than a prose answer?
// String prefix inspection only — no regex over prose, no content heuristics.
function looksLikeEnvelopeText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed.startsWith("{") || trimmed.startsWith("```");
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
    if (readString(activeSkill && activeSkill.name) || readString(lastReadSkill && lastReadSkill.name)) {
      return true;
    }
  }
  if (readString(options && options.activeAgentSkill && options.activeAgentSkill.name)) {
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
  if (isNativeTerminalToolDisabledForRun(options, "finalize")) {
    return true;
  }
  return isTerminalRepairActive(runState);
}

function shouldSuppressNativePlanTool(options) {
  if (isNativeTerminalToolDisabledForRun(options, "plan")) return true;
  // C5a (AGRUN-582, wire-measured) — the plan tool is 7.1KB, 25% of the
  // native tool surface, and since C3b the model gets the same parallel
  // capability by emitting multiple tool_calls in one response (consumed as
  // a plan-door batch). The tool's unique remainder is synthesize_per_action
  // stitching plus execute_skill_tool fan-out, which only skill/research
  // flows can use — so keep it exactly when such a flow is possible: bundled
  // skills or a skill index provider are configured (the ACTION surface is
  // not a usable signal — execute_skill_tool stays listed even with zero
  // skills, and ADR-0023 pull-mode keeps the manifest catalog empty until
  // list_agent_skills), a skill is active, or a research loop is engaged.
  // State/config-gated, not model/provider-gated: nothing is hidden from
  // plain tool runs (parallelism stays available via the provider protocol).
  if (options && options.activeAgentSkill) return false;
  const runtimeConfig = options && options.runtimeConfig ? options.runtimeConfig : {};
  // Initial bundled-skill manifests (config) or the discovered catalog
  // (runState, populated by list_agent_skills for custom index providers).
  // NOTE: runtimeConfig.agentSkillIndexProvider is NOT a usable signal — the
  // default config always wraps agentSkills in an in-memory provider.
  if (Array.isArray(runtimeConfig.agentSkills) && runtimeConfig.agentSkills.length > 0) return false;
  const catalogManifests = options && options.runState && options.runState.skillCatalogManifests;
  if (Array.isArray(catalogManifests) && catalogManifests.length > 0) return false;
  const researchLoop = options && options.runState && options.runState.researchReportLoop;
  const researchActive = Boolean(
    researchLoop
    && typeof researchLoop === "object"
    && typeof researchLoop.status === "string"
    && researchLoop.status !== "idle"
  );
  return !researchActive;
}

function isNativeTerminalToolDisabledForRun(options, toolName) {
  const runtimeDisabled = options && options.runtimeConfig && Array.isArray(options.runtimeConfig.disabledActions)
    ? options.runtimeConfig.disabledActions
    : [];
  const localDisabled = options && Array.isArray(options.disabledActions)
    ? options.disabledActions
    : [];
  return [...runtimeDisabled, ...localDisabled]
    .some((name) => typeof name === "string" && name.trim().toLowerCase() === toolName);
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
      readString(rawText),
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
  const response = await requestPlannerProviderResponse(options, {
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
    invalidKind: decision ? null : readString((repairRejection || originalRejection) && (repairRejection || originalRejection).reason),
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
