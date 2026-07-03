import { buildActiveAgentSkillSystemPrompt } from './agent-skills.js';
import { buildRoleSystemPromptBlock } from './agent-roles.js';
import { recordProviderCallDuration } from './provider-latency.js';
import { finalizeActionLoopFailure } from './action-loop-failure.js';
import './tool-schema.js';
import { createProviderErrorStepDetail } from './provider-error.js';
import { createUsageDetail } from './runtime-events.js';
import './action-pattern-convergence.js';
import './action-names.js';
import './runtime-event-classifier.js';
import { normalizeFinalResponseStructure, noteFinalResponseQualityIssues } from './final-response-quality.js';
import { projectSessionContextFromSnapshot } from '../session/context-snapshot-projection.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { createProviderResponseTrace } from './llm-trace.js';
import { handleRuntimeFinalize } from './action-loop-terminal.js';
import { ERROR_CODES } from './errors.js';
import { buildFinalResponseSystemPrompt, buildFinalResponseParts, buildFinalResponsePrompt, ensureVisibleFinalReadinessDecisionLine } from './final-response-prompt.js';
import { scrubFinalResponseText, finalResponseHasLeakedActionBlock, createStreamFence } from './final-response-scrubber.js';
import { readGoalAnchorView, formatGoalAnchorBlock } from './goal-anchor.js';
import { deriveProviderTimeoutMs } from './provider-timeout.js';
import { requestProviderCompletionStreaming, requestProviderCompletion } from './provider.js';
import { projectSessionContextForFinalizer } from './session-context-projection.js';

async function executeRuntimeFinalize(options) {
  const {
    cycleRecord,
    decision,
    memoryEntriesAdded,
    normalizedInput,
    onReasoning,
    onStreamEvent,
    onToken,
    pushStep,
    rawInput,
    request,
    runState,
    runtimeState,
    steps
  } = options;

  try {
    const terminalSource = readTerminalSource(options.terminalSource);
    const projectedSessionContext = projectSessionContextForFinalizer(
      runState && runState.contextSnapshot
        ? projectSessionContextFromSnapshot(runState.contextSnapshot)
        : request.sessionContext,
      runState && runState.plannerState
    );

    const finalizeCallId = `finalize-${runState.runId}-${runState.cycleCount}`;
    pushStep("provider-requested", {
      callId: finalizeCallId,
      model: request.model,
      provider: request.provider,
      source: terminalSource
    });

    // AGRUN-142 — finalizer reinjects the verbatim anchor block so the
    // final answer cannot drift from the user's original framing even when
    // the planner compacted earlier cycles out of working memory.
    const goalAnchorBlock = buildGoalAnchorBlockForFinalize(runState, options);
    const effectivePrompt = readFinalSourcePrompt(runState, request);

    const finalizeOverrides = {
      prompt: buildFinalResponsePrompt(
        effectivePrompt,
        readFinalizeInstruction(decision),
        runState.researchContext,
        projectedSessionContext,
        runState.toolContext,
        runState.failedTools,
        options.budgetOverrides,
        {
          researchEvidenceGraph: runState.researchEvidenceGraph,
          researchFinalEnvelope: runState.researchFinalEnvelope,
          finalReadiness: decision && typeof decision === "object" ? decision.finalReadiness : null,
          researchReportLoop: runState.researchReportLoop,
          researchState: runState.researchState,
          researchWorkspace: runState.researchWorkspace,
          runtimeConfig: options.runtimeConfig,
          virtualWorkspace: runState.virtualWorkspace
        }
      ),
      parts: buildFinalResponseParts(
        runState.researchContext,
        Array.isArray(request.parts) ? request.parts : []
      ),
      sessionContext: projectedSessionContext,
      systemPrompt: [
        buildRoleSystemPromptBlock(options.agentRole || (runState && runState.agentRole)),
        goalAnchorBlock || null,
        buildFinalResponseSystemPrompt(request.systemPrompt),
        buildActiveAgentSkillSystemPrompt(runState.agentSkillContext.activeSkill)
      ].filter(Boolean).join("\n\n"),
      // AGRUN-212a amendment 2D — Long-output finalize (e.g. autopilot
      // composing the comparison table for a 5-step research plan)
      // exceeds the 60s default. Helper returns null when no plan is
      // in play, so non-autopilot turns are unchanged.
      timeoutMs: deriveProviderTimeoutMs({
        runState,
        kind: "finalize",
        baseTimeoutMs: request && request.timeoutMs
      })
    };

    const providerStartedAt = Date.now();
    const response = await requestFinalizerProviderResponse({
      finalizeCallId,
      finalizeOverrides,
      onReasoning,
      onStreamEvent,
      onToken,
      pushStep,
      request,
      runState,
      source: terminalSource
    });
    // AGRUN-568 — successful finalize call feeds the same observed-latency
    // floor as planner calls (both doors of deriveProviderTimeoutMs).
    recordProviderCallDuration(runState, Date.now() - providerStartedAt);
    response.text = scrubFinalResponseText(response.text);
    response.text = ensureVisibleFinalReadinessDecisionLine(
      response.text,
      [
        effectivePrompt,
        runState && runState.originalQuery,
        request && request.prompt,
        readFinalizeInstruction(decision)
      ].filter(Boolean).join("\n"),
      decision && typeof decision === "object" ? decision.finalReadiness : null
    );

    // ADR-0023 — Runtime no longer re-prompts the LLM with a
    // `buildFinalResponseRepairInstruction` on quality.ok === false.
    // analyzeFinalResponseQuality runs only as a signal (recorded on
    // runState.finalResponseQuality via noteFinalResponseQualityIssues
    // earlier in the loop). The first finalizer response is the answer.
    response.text = normalizeFinalResponseStructure(response.text, { prompt: effectivePrompt });
    // GAP-B fix — the finalize path's user-facing answer is synthesized HERE,
    // not carried on decision.answer, so the earlier noteQualityIssuesAsSignal
    // call (which reads decision.answer) short-circuited and left
    // runState.finalResponseQuality undefined. Record quality on the real
    // synthesized text now so host diagnostics (result.diagnostics) populate
    // and the codes are available to the cross-turn qualityContext signal.
    noteFinalResponseQualityIssues(runState, {
      decision: { answer: response.text },
      source: terminalSource
    });
    // ADR-0015 PR 1 — runtime no longer back-fills the virtual workspace
    // when the final answer arrives. Workspace files are AI-authored via
    // workspace_write / workspace_replace; an empty workspace is the
    // correct outcome for runs where the AI never used it.

    pushStep("provider-responded", {
      callId: finalizeCallId,
      durationMs: Date.now() - providerStartedAt,
      finishReason: response.finishReason,
      model: request.model,
      provider: request.provider,
      requestPayload: response.requestBody || null,
      responsePayload: createProviderResponseTrace({
        durationMs: Date.now() - providerStartedAt,
        finishReason: response.finishReason,
        model: request.model,
        provider: request.provider,
        response: response.raw,
        status: response.status,
        text: response.text,
        toolCalls: response.toolCalls,
        usage: response.usage
      }),
      source: terminalSource,
      usage: createUsageDetail(response, {
        model: request.model,
        provider: request.provider
      })
    });

    return handleRuntimeFinalize({
      cycleRecord,
      decision,
      memoryEntriesAdded,
      normalizedInput,
      pushStep,
      rawInput,
      request,
      response,
      runState,
      runtimeState,
      steps,
      // ADR-0025 — propagate caller-supplied terminal source so the run's
      // finalAnswerSource / terminalizedBy reflect AI-driven vs runtime-pushed.
      terminalSource
    });
  } catch (error) {
    if (shouldRetryEmptyFinalizerResponse(error)) {
      const prompt = readFinalSourcePrompt(runState, request);
      const plannerFinalText = typeof (runState && runState.lastPlannerFinalText) === "string"
        ? runState.lastPlannerFinalText.trim()
        : "";
      if (plannerFinalText) {
        pushStep("runtime-finalize-empty-response-preferred-planner-final", {
          provider: request && request.provider,
          source: readTerminalSource(options.terminalSource)
        });
        return handleRuntimeFinalize({
          cycleRecord,
          decision,
          memoryEntriesAdded,
          normalizedInput,
          pushStep,
          rawInput,
          request,
          response: {
            finishReason: "planner_final_preferred",
            raw: null,
            text: normalizeFinalResponseStructure(plannerFinalText, { prompt }),
            usage: null
          },
          runState,
          runtimeState,
          steps,
          terminalSource: readTerminalSource(options.terminalSource)
        });
      }
    }
    const providerError = createProviderErrorStepDetail(error, request && request.provider);
    if (providerError) {
      pushStep("provider-error", providerError);
    }
    return finalizeActionLoopFailure({
      actionName: "finalize",
      cause: error,
      code: ERROR_CODES.ACTION_EXECUTE_ERROR,
      cycleRecord,
      memoryEntriesAdded,
      normalizedInput,
      output: null,
      pushStep,
      rawInput,
      runState,
      runtimeState,
      steps
    });
  }
}

async function requestFinalizerProviderResponse(options) {
  const {
    finalizeCallId,
    finalizeOverrides,
    onReasoning,
    onStreamEvent,
    onToken,
    pushStep,
    request,
    runState,
    source
  } = options;

  const streamContext = {
    callId: finalizeCallId,
    ledger: runState && runState.eventLedger,
    runId: runState && runState.runId,
    source: readTerminalSource(source)
  };

  try {
    const response = await requestFinalizerProviderOnce(request, finalizeOverrides, onToken, onStreamEvent, streamContext, onReasoning);
    // The finalizer call exposes no tools (tools.count = 0) and asks for a
    // user-facing answer, but a weak model can still leak a planner-action /
    // tool-call envelope (e.g. a fenced {"action":"list_agent_skills"}) as its
    // "answer" when the host system prompt still says "call list_agent_skills
    // first". scrubFinalResponseText strips the JSON but can leave non-answer
    // filler, so re-prompt ONCE for prose — this is what rescues the real
    // answer (often already in the finalize prompt's session-evidence block).
    // One-shot, mirroring the empty-response retry below.
    if (finalResponseHasLeakedActionBlock(response.text)) {
      pushStep("runtime-finalize-leaked-action-retry", {
        callId: finalizeCallId,
        provider: request.provider,
        source: readTerminalSource(source)
      });
      return requestFinalizerProviderOnce(
        request,
        buildProseOnlyFinalizeRetryOverrides(finalizeOverrides, { leakedAction: true }),
        onToken,
        onStreamEvent,
        streamContext,
        onReasoning
      );
    }
    return response;
  } catch (error) {
    if (!shouldRetryEmptyFinalizerResponse(error)) {
      throw error;
    }
    pushStep("runtime-finalize-empty-response-retry", {
      callId: finalizeCallId,
      provider: request.provider,
      source: readTerminalSource(source)
    });
    return requestFinalizerProviderOnce(
      request,
      buildProseOnlyFinalizeRetryOverrides(finalizeOverrides, { }),
      onToken,
      onStreamEvent,
      streamContext,
      onReasoning
    );
  }
}

// Shared "answer in prose, no tools" reinforcement for both finalizer retry
// paths (empty response and leaked-action response). The system-prompt line is
// identical across both so the proven "Do not call tools" wording is the SSOT;
// only the prompt-level reason differs.
function buildProseOnlyFinalizeRetryOverrides(finalizeOverrides, options = {}) {
  const reason = options.leakedAction
    ? "The previous finalizer response was a tool/action request, not an answer. The gathering phase is over — write the final answer for the user in plain prose now, using the evidence already provided above. Do not emit any action, tool call, or JSON envelope."
    : "The previous finalizer response was empty. Return a non-empty final answer now. Do not return an empty response.";
  return {
    ...finalizeOverrides,
    prompt: [finalizeOverrides.prompt, reason].filter(Boolean).join("\n\n"),
    systemPrompt: [
      finalizeOverrides.systemPrompt,
      "Finalizer retry: return non-empty plain text only. Do not call tools and do not return an empty response."
    ].filter(Boolean).join("\n\n")
  };
}

function readTerminalSource(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "runtime_finalize";
}

async function requestFinalizerProviderOnce(request, finalizeOverrides, onToken, onStreamEvent, streamContext, onReasoning) {
  if (onToken || onStreamEvent || onReasoning) {
    const fence = createStreamFence(onToken);
    const response = await requestProviderCompletionStreaming(
      request,
      finalizeOverrides,
      fence.wrappedOnToken,
      onStreamEvent,
      streamContext,
      onReasoning
    );
    fence.flush();
    return response;
  }
  return requestProviderCompletion(request, finalizeOverrides);
}

function shouldRetryEmptyFinalizerResponse(error) {
  const message = [
    error && typeof error.message === "string" ? error.message : "",
    error && typeof error.cause === "string" ? error.cause : "",
    error && error.debug && error.debug.response && typeof error.debug.response.body === "string"
      ? error.debug.response.body
      : ""
  ].join(" ").toLowerCase();
  return /did not include (assistant )?(text|text output)|empty response|response was empty|no text|no function calls?/.test(message);
}

function readFinalizeInstruction(decision) {
  return decision && typeof decision === "object" && typeof decision.instruction === "string"
    ? decision.instruction.trim()
    : "";
}

// AGRUN-142 — same shape as planner-side helper; pulls both anchor layers
// (run-scope + thread-scope) from runState fields seeded on cycle 1 and
// thread hydration. Empty when the config flag is off.
function buildGoalAnchorBlockForFinalize(runState, options) {
  const config = options && options.runtimeConfig && options.runtimeConfig.goalAnchor;
  if (!config || config.enabled === false) return "";
  const activeThread = runState && typeof runState.threadGoalAnchorText === "string"
    ? { goalAnchor: { text: runState.threadGoalAnchorText } }
    : null;
  const view = readGoalAnchorView({ runState, activeThread, config });
  return formatGoalAnchorBlock(view, config);
}

export { executeRuntimeFinalize };
