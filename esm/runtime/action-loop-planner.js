import { cloneValue } from './utils.js';
import { planNextAction } from './planner.js';
import { deriveProviderTimeoutMs } from './provider-timeout.js';
import { buildPlannerPrompt } from './planner-prompt.js';
import { readGoalAnchorView, formatGoalAnchorBlock } from './goal-anchor.js';
import { buildTodoStateBlockForCycle } from './todo-state-prompt.js';
import { normalizeThrownError, ERROR_CODES } from './errors.js';
import { handleInvalidPlannerDecision, finalizeActionLoopFailure } from './action-loop-failure.js';
import { readDeniedActions, isValidDecision } from './action-loop-utils.js';
import { resetRecoveryBudget } from './planner-recovery.js';
import { summarizeSessionContextMeta } from '../session/prompt.js';
import { readContextSnapshot } from '../session/context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot } from '../session/context-snapshot-projection.js';
import { requestSemanticRecall, createSemanticRecallDecision, createSessionRecallResponse } from './semantic-recall.js';
import { createPlannerState } from './task-state.js';
import { projectSessionContextFromPlannerState } from './session-context-projection.js';
import { createControlEnvelopeDetail } from './control-envelope.js';
import { selectPlannerActions } from './planner-action-surface.js';
import { maybeCreatePlannerFailureTodoState } from './todo-failure-state.js';
import { createUsageDetail } from './runtime-events.js';
import { createProviderErrorStepDetail } from './provider-error.js';
import { listSkillManifests } from './agent-skills.js';
import { filterAvailableSkillManifests } from './skill-policy.js';

async function requestPlanner(options) {
  const {
      actionHistory,
      promptHistory,
      availableActions,
      availableAgentSkills,
      activeAgentSkill,
      cycleRecord,
    memoryEntriesAdded,
    normalizedInput,
    pushStep,
    rawInput,
    request,
    runState,
    runtimeState,
    steps
  } = options;

  // GAP 4 — prompt-side history view. The session loop hands in the
  // compacted projection separately so the prompt shrinks while the full
  // actionHistory keeps feeding readDeniedActions and the failure signals.
  const plannerPromptHistory = Array.isArray(promptHistory) ? promptHistory : actionHistory;

  try {
    const basePlannerState = createPlannerState(
      request,
      runState.observationSummary,
      runState.inputResolution
    );
    const turnState = runState.turnState && typeof runState.turnState === "object"
      ? runState.turnState
      : null;
    const plannerState = {
      ...basePlannerState,
      shouldUseRecall: basePlannerState.shouldUseRecall === true
    };
    // ADR-0020: runtime no longer auto-ranks user prompt against skill manifests.
    // resolvePlannerSkillCatalog returns the policy-filtered full catalog as-is;
    // AI does discovery via list_agent_skills(query) tool with English keywords.
    const skillCatalogSelection = await resolvePlannerSkillCatalog({
      availableAgentSkills,
      pushStep,
      runState,
      runtimeConfig: options.runtimeConfig
    });
    const plannerAgentSkills = skillCatalogSelection.skills;
    runState.availableAgentSkills = cloneValue(plannerAgentSkills);
    // AGRUN-421 — the before_planner repair refresh now runs as the
    // session-scoped preRequest hook (hooks/terminal-repair-hook.js),
    // dispatched by the session loop before requestPlanner is called.
    const plannerTerminalRepairState = runState.terminalRepairState;
    const plannerActions = selectPlannerActions(availableActions, {
      activeAgentSkill,
      availableAgentSkills: plannerAgentSkills,
      lastReadAgentSkill: runState.agentSkillContext.lastReadSkill,
      prompt: request.prompt,
      runState,
      runtimeConfig: options.runtimeConfig,
      terminalRepairState: plannerTerminalRepairState || runState.terminalRepairState
    });
    const plannerPrompt = buildPlannerPrompt({
      activeAgentSkill,
      // ADR-0026 — read-only signal exposed to the AI when the same
      // action has failed `CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD` times
      // in a row. Runtime no longer force-finalizes; AI decides.
      actionFailureSignal: runState.actionFailureSignal || null,
      // ADR-0028 — read-only signal exposed to the AI when read_url
      // attempts >= threshold. Replaces deleted resolveResearchContinuation.
      readAttemptSignal: runState.readAttemptSignal || null,
      availableActions: plannerActions,
      availableAgentSkills: plannerAgentSkills,
      catalogListed: runState.agentSkillContext.catalogListed === true,
      deniedActions: readDeniedActions(actionHistory),
      // GAP 4 — the PROMPT receives the compacted projection; deniedActions
      // above (and every other state consumer) keeps the full actionHistory.
      history: plannerPromptHistory,
      invalidActionCount: runState.plannerInvalidCount,
      plannerInvalidSignal: runState.plannerInvalidSignal || null,
      lastObservation: runState.observation,
      lastReadAgentSkill: runState.agentSkillContext.lastReadSkill,
      readSources: runState.researchContext.readSources,
      contextSnapshot: runState.contextSnapshot,
      request,
      runState,
      plannerState,
      researchContext: runState.researchContext,
      researchEvidenceGraph: runState.researchEvidenceGraph,
      researchReportLoop: runState.researchReportLoop,
      actionPatternConvergence: runState.actionPatternConvergence,
      researchAcceptanceEvaluator: runState.researchAcceptanceEvaluator,
      requirementRecoveryEvaluator: runState.requirementRecoveryEvaluator,
      readUrlRecoverySignal: runState.readUrlRecoverySignal,
      terminalRepairState: plannerTerminalRepairState || runState.terminalRepairState,
      invalidActionConvergence: runState.invalidActionConvergence,
      searchResults: runState.researchContext.searchResults,
      toolContext: runState.toolContext,
      turnCount: runState.turnCount,
      virtualWorkspace: runState.virtualWorkspace
    });
    const plannerEvidence = createPlannerEvidence(request, plannerPrompt, plannerState);

    runState.planner = cloneValue(plannerEvidence);
    runState.plannerState = cloneValue({
      activeQuery: plannerEvidence.activeQuery,
      activeTask: plannerEvidence.activeTask,
      ambiguityState: plannerEvidence.ambiguityState,
      clarificationStatus: plannerEvidence.clarificationStatus,
      currentGoal: plannerEvidence.currentGoal,
      currentTopic: plannerEvidence.currentTopic,
      evidenceState: plannerEvidence.evidenceState,
      goalQuality: plannerEvidence.goalQuality,
      hasEvidenceSignal: plannerEvidence.hasEvidenceSignal,
      hasUserClarification: plannerEvidence.hasUserClarification,
      inquiryContext: cloneValue(plannerState.inquiryContext),
      lastResolution: cloneValue(plannerEvidence.lastResolution),
      openAmbiguity: plannerEvidence.openAmbiguity,
      pendingClarification: cloneValue(plannerEvidence.pendingClarification),
      promptSignal: plannerEvidence.promptSignal,
      shouldUseRecall: plannerEvidence.shouldUseRecall === true,
      unresolvedDetail: plannerEvidence.unresolvedDetail
    });
    pushStep("planner-requested", {
      activeTask: plannerEvidence.activeTask,
      activeQuery: plannerEvidence.activeQuery,
      ambiguityState: plannerEvidence.ambiguityState,
      availableActions: cloneValue(plannerActions.map((action) => action.name)),
      availableAgentSkills: cloneValue(runState.availableAgentSkills || []),
      clarificationStatus: plannerEvidence.clarificationStatus,
      currentGoal: plannerEvidence.currentGoal,
      currentTopic: plannerEvidence.currentTopic,
      evidenceState: plannerEvidence.evidenceState,
      executionClass: runState.executionClass || null,
      goalEqualsTopic: plannerEvidence.goalEqualsTopic,
      goalLooksLikeQuestion: plannerEvidence.goalLooksLikeQuestion,
      goalQuality: plannerEvidence.goalQuality,
      hasEvidenceSignal: plannerEvidence.hasEvidenceSignal,
      observationSummary: cloneValue(runState.observationSummary),
      openAmbiguity: plannerEvidence.openAmbiguity,
      hasCurrentGoal: plannerEvidence.hasCurrentGoal,
      hasCurrentTopic: plannerEvidence.hasCurrentTopic,
      hasOpenAmbiguity: plannerEvidence.hasOpenAmbiguity,
      hasUserClarification: plannerEvidence.hasUserClarification,
      lastResolution: cloneValue(plannerEvidence.lastResolution),
      pendingClarification: cloneValue(plannerEvidence.pendingClarification),
      hasSessionEvidenceBlock: plannerEvidence.hasSessionEvidenceBlock,
      plannerPromptPreview: plannerEvidence.promptPreview,
      prompt: plannerEvidence.promptStats,
      promptSignal: plannerEvidence.promptSignal,
      provider: request.provider,
      ...createControlEnvelopeDetail(runState),
      sessionContextMeta: cloneValue(plannerEvidence.sessionContextMeta),
      turnState: cloneValue(turnState),
      unresolvedDetail: plannerEvidence.unresolvedDetail
    });
    const shouldUseRecall = plannerState.shouldUseRecall === true;

    if (shouldUseRecall) {
      pushStep("semantic-recall-requested", {
        provider: request.provider
      });

      try {
        const recallJudge = await requestSemanticRecall(request);
        const recallDecision = createSemanticRecallDecision(recallJudge.value);
        runState.semanticState = {
          ...(runState.semanticState && typeof runState.semanticState === "object"
            ? runState.semanticState
            : {}),
          recall: cloneValue(recallJudge.value)
        };
        pushStep("semantic-recall-completed", {
          answerFromMemory: recallJudge.value.answerFromMemory === true,
          shouldContinueToPlanner: recallJudge.value.shouldContinueToPlanner === true,
          supportingItemCount: Array.isArray(recallJudge.value.supportingItems)
            ? recallJudge.value.supportingItems.length
            : 0
        });

        if (recallDecision) {
          pushStep("planner-responded", {
            provider: request.provider,
            responseType: recallDecision.type,
            source: "session_memory"
          });

          runState.plannerInvalidCount = 0;
          runState.plannerInvalidSignal = null;
          resetRecoveryBudget(runState);
          return {
            decision: recallDecision,
            done: false,
            response: createSessionRecallResponse()
          };
        }
      } catch (error) {
        pushStep("semantic-recall-failed", {
          message: normalizeThrownError(error).message
        });
      }
    }

    // Skip the expensive strict-retry cascade on subsequent planner cycles
    // (when action history is non-empty). The model has prior action context
    // and should produce valid envelopes; the strict retry adds a full API
    // round-trip that rarely succeeds when the repair already failed.
    const hasActionHistory = Array.isArray(actionHistory) && actionHistory.length > 0;

    const plannerDirectivesForCycle = mergeDriftReminderIntoDirectives(
      mergeRunPlannerDirectives(
        options.runtimeConfig && options.runtimeConfig.plannerDirectives,
        options.plannerDirectives,
        options.plannerDirectivesMode
      ),
      runState.driftSignal
    );
    // AGRUN-146 — drift reminder is per-cycle. Clear after building the
    // directives so the next cycle re-derives from a fresh detectDrift call.
    if (runState.driftSignal) runState.driftSignal = null;
    // 2026-05-09 — `mergeRuntimeDirectivesIntoCycle` + runtime-injected
    // directive plumbing deleted. Runtime no longer prescribes AI's
    // recovery strategy via planner-prompt directives; AI receives
    // structured `validation.planner_feedback.detail` through the
    // observation path and decides on its own.

    // AGRUN-142 — assemble verbatim anchor block (ORIGINAL USER QUERY +
    // GOAL ANCHOR) from runState.originalQuery + activeThread.goalAnchor.
    // Skipped silently when config is disabled or no anchor text exists.
    const goalAnchorBlock = buildGoalAnchorBlockForCycle(runState, options);

    // AGRUN-212a Phase E — windowed TodoState block (active ±2 items).
    // Empty string when runState.todoState is null, which is the
    // common case for short turns. Token budget bounded by the
    // summary window, NOT by plan length.
    const todoStateBlock = buildTodoStateBlockForCycle(runState, {
      requestPrompt: request && request.prompt,
      promptStrings:
        options.runtimeConfig
        && options.runtimeConfig.todoAutopilot
        && options.runtimeConfig.todoAutopilot.promptStrings
    });

    const plannerStartedAt = Date.now();
    const plannerResult = await planNextAction({
      activeAgentSkill,
      agentRole: options.agentRole,
      plannerDirectives: plannerDirectivesForCycle,
      goalAnchorBlock,
      todoStateBlock,
      debug: options.debug,
      // AGRUN-212a amendment 2D — autopilot in flight ⇒ planner cycles
      // see longer evidence stacks; bump per-call timeout. Helper
      // returns null when no plan is in play, so non-autopilot turns
      // remain on the provider default (60s).
      timeoutMs: deriveProviderTimeoutMs({
        runState,
        kind: "planner",
        baseTimeoutMs: request && request.timeoutMs
      }),
      preferFinalizeOnLastResult: options.runtimeConfig && options.runtimeConfig.preferFinalizeOnLastResult,
      // ADR-0035 (AGRUN-262) — host prompt-section overrides (runtimeConfig.prompts).
      prompts: options.runtimeConfig && options.runtimeConfig.prompts,
      runtimeConfig: options.runtimeConfig,
      availableActions: plannerActions,
      availableAgentSkills: plannerAgentSkills,
      catalogListed: runState.agentSkillContext.catalogListed === true,
      deniedActions: readDeniedActions(actionHistory),
      history: plannerPromptHistory,
      invalidActionCount: runState.plannerInvalidCount,
      lastReadAgentSkill: runState.agentSkillContext.lastReadSkill,
      lastObservation: runState.observation,
      nativeToolsFailurePolicy: options.runtimeConfig && options.runtimeConfig.nativeToolsFailurePolicy,
      plannerMode: options.plannerMode,
      plannerState,
      runState,
      onReasoning: options.onReasoning,
      // C3c (AGRUN-585) — forwarded for the native door's fenced TTFT streaming.
      onToken: options.onToken,
      onStreamEvent: options.onStreamEvent,
      onInvalidPlannerOutput: options.onInvalidPlannerOutput,
      readSources: runState.researchContext.readSources,
      researchContext: runState.researchContext,
      request,
      pushStep,
      searchResults: runState.researchContext.searchResults,
      skipStrictRetry: hasActionHistory,
      toolContext: runState.toolContext,
      turnCount: runState.turnCount,
      virtualWorkspace: runState.virtualWorkspace,
      prompt: plannerPrompt
    });
    pushStep("planner-responded", {
      durationMs: Date.now() - plannerStartedAt,
      provider: request.provider,
      // F1 — surfaced for the Inspector: >0 means transient provider errors
      // were absorbed by the bounded retry instead of killing the run.
      providerRetries: plannerResult.response && Number.isInteger(plannerResult.response.providerRetries)
        ? plannerResult.response.providerRetries
        : 0,
      responseType: plannerResult.decision ? plannerResult.decision.type : "invalid",
      // AGRUN-419-followup — surface the AI's OWN stated reasoning for this
      // decision (the planner envelope's `reasoning` field) so the host can show
      // the agent's actual thought, not just a generic phase label. Model-
      // agnostic: every planner decision carries it, no provider CoT needed.
      reasoning: plannerResult.decision && typeof plannerResult.decision.reasoning === "string"
        ? plannerResult.decision.reasoning.trim().slice(0, 800)
        : null,
      responseText: summarizePlannerResponseText(plannerResult.response),
      usage: createUsageDetail(plannerResult.response, {
        model: request.model,
        provider: request.provider
      })
    });

    if (!isValidDecision(plannerResult.decision)) {
      return handleInvalidPlannerDecision({
        cycleRecord,
        memoryEntriesAdded,
        normalizedInput,
        plannerResult,
        pushStep,
        rawInput,
        runState,
        runtimeState,
        steps
      });
    }

    runState.plannerInvalidCount = 0;
    runState.plannerInvalidSignal = null;
    resetRecoveryBudget(runState);
    return {
      decision: plannerResult.decision,
      done: false,
      response: plannerResult.response
    };
  } catch (error) {
    if (isRecoverableEmptyPlannerResponseError(error)) {
      pushStep("planner-empty-response-repair-signal", {
        cycle: runState.cycleCount,
        error: normalizeThrownError(error).message,
        reason: "planner_provider_empty_response"
      });
      return handleInvalidPlannerDecision({
        cycleRecord,
        memoryEntriesAdded,
        normalizedInput,
        plannerResult: {
          decision: null,
          invalidKind: "empty_planner_response",
          response: {
            raw: null,
            status: null,
            text: "",
            usage: null
          },
          rejectedActionName: null,
          repairAttempted: false
        },
        pushStep,
        rawInput,
        runState,
        runtimeState,
        steps
      });
    }
    const providerError = createProviderErrorStepDetail(error, request && request.provider);
    if (providerError) {
      pushStep("provider-error", providerError);
    }
    const failedTodoState = maybeCreatePlannerFailureTodoState(
      runState,
      options.runtimeConfig && options.runtimeConfig.todoAutopilot,
      error
    );
    if (failedTodoState) {
      pushStep("todo-plan-blocked-by-planner-error", {
        itemCount: Array.isArray(failedTodoState.items) ? failedTodoState.items.length : 0,
        message: normalizeThrownError(error).message
      });
    }
    return {
      done: true,
      result: finalizeActionLoopFailure({
        cause: error,
        code: ERROR_CODES.PLANNER_ERROR,
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
}

function isRecoverableEmptyPlannerResponseError(error) {
  const message = normalizeThrownError(error).message.toLowerCase();
  return /did not include (assistant )?(text|text output)|empty response|response was empty|no text|no function calls?/.test(message);
}

function createPlannerEvidence(request, prompt, plannerState) {
  const promptText = typeof prompt === "string" ? prompt : "";
  const requestSessionContext = projectSessionContextFromSnapshot(
    readContextSnapshot(request)
  ) || (request && typeof request === "object" ? request.sessionContext : null);

  return {
    activeQuery: plannerState.activeQuery,
    activeTask: plannerState.activeTask,
    ambiguityState: plannerState.ambiguityState,
    clarificationStatus: plannerState.clarificationStatus,
    currentGoal: plannerState.currentGoal,
    currentTopic: plannerState.currentTopic,
    evidenceState: plannerState.evidenceState,
    goalEqualsTopic: plannerState.goalEqualsTopic,
    goalLooksLikeQuestion: plannerState.goalLooksLikeQuestion,
    goalQuality: plannerState.goalQuality,
    hasEvidenceSignal: plannerState.hasEvidenceSignal,
    hasOpenAmbiguity: plannerState.hasOpenAmbiguity,
    hasCurrentGoal: plannerState.currentGoal.length > 0,
    hasCurrentTopic: plannerState.currentTopic.length > 0,
    hasSessionEvidenceBlock: promptText.includes("Session evidence to use before deciding:"),
    hasUserClarification: plannerState.hasUserClarification,
    lastResolution: plannerState.lastResolution,
    openAmbiguity: plannerState.openAmbiguity,
    pendingClarification: plannerState.pendingClarification,
    promptPreview: truncateText(promptText, 1200),
    promptStats: measurePlannerPromptSections(promptText),
    promptSignal: plannerState.promptSignal,
    shouldUseRecall: plannerState.shouldUseRecall === true,
    sessionContextMeta: summarizeSessionContextMeta(projectSessionContextFromPlannerState(
      requestSessionContext,
      plannerState
    )),
    unresolvedDetail: plannerState.unresolvedDetail
  };
}

// ADR-0023 — Harness-as-tool-provider. Runtime no longer pre-loads the
// skill catalog into the planner prompt. AI must call list_agent_skills(query)
// to discover skills. Returning an empty array keeps the planner-prompt
// catalog block empty so the AI sees `bundledAgentSkillCount: 0` and
// follows the system-prompt instruction to call list_agent_skills first.
//
// We still load + cache manifests on runState (so list_agent_skills tool
// can search them without a fresh provider call), and still apply skill
// policy filtering (so disabled skills never reach AI even via tool).
// What changed: we don't return the catalog summary array to the planner
// prompt anymore. ADR-0020 left this dump in place; ADR-0023 removes it.
async function resolvePlannerSkillCatalog(options) {
  const runtimeConfig = options && options.runtimeConfig ? options.runtimeConfig : {};
  const fallbackManifests = Array.isArray(options && options.availableAgentSkills)
    ? options.availableAgentSkills
    : [];
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : null;
  let manifests = Array.isArray(runState && runState.skillCatalogManifests)
    ? runState.skillCatalogManifests
    : fallbackManifests;

  if (runtimeConfig.agentSkillIndexProvider && !Array.isArray(runState && runState.skillCatalogManifests)) {
    try {
      manifests = await listSkillManifests(runtimeConfig.agentSkillIndexProvider);
      if (runState) {
        runState.skillCatalogManifests = cloneValue(manifests);
      }
    } catch (error) {
      if (typeof options.pushStep === "function") {
        options.pushStep("skill-catalog-load-failed", {
          error: normalizeThrownError(error).message
        });
      }
      manifests = fallbackManifests;
    }
  }

  // Apply policy filter so disabled skills never reach the AI (even via
  // list_agent_skills tool), but DO NOT return the catalog to the planner
  // prompt. AI calls list_agent_skills(query) to populate.
  const policyFiltered = filterAvailableSkillManifests(manifests, runtimeConfig, { operation: "plan" });
  if (policyFiltered.filteredCount > 0 && typeof options.pushStep === "function") {
    options.pushStep("skill-policy-filtered", {
      filteredCount: policyFiltered.filteredCount,
      reasons: policyFiltered.reasons
    });
  }

  // ADR-0023: Return empty array. AI must call list_agent_skills to discover.
  return { skills: [] };
}

// AGRUN-142 — Build the verbatim goal-anchor block injected into the
// planner system prompt every cycle. Honors `runtimeConfig.goalAnchor`
// (disabled → empty string) and pulls both layers straight off runState:
//   • runState.originalQuery — seeded on cycle 1 from rawInput (run scope)
//   • runState.threadGoalAnchorText — mirrored from the active thread on
//     hydration (thread scope, stable across runs within the thread)
// Neither side is required; both missing → empty block.
function buildGoalAnchorBlockForCycle(runState, options) {
  const config = options && options.runtimeConfig && options.runtimeConfig.goalAnchor;
  if (!config || config.enabled === false) return "";
  const activeThread = runState && typeof runState.threadGoalAnchorText === "string"
    ? { goalAnchor: { text: runState.threadGoalAnchorText } }
    : null;
  const view = readGoalAnchorView({ runState, activeThread, config });
  return formatGoalAnchorBlock(view, config);
}

// AGRUN-146 — Merge a drift reminder line onto the host's plannerDirectives
// array for exactly this planner call. Caller clears driftSignal after so
// we do not amplify the reminder on subsequent cycles.
function mergeDriftReminderIntoDirectives(hostDirectives, driftSignal) {
  const base = Array.isArray(hostDirectives) ? hostDirectives.slice() : [];
  if (!driftSignal || typeof driftSignal !== "object") return base;
  const reminder = typeof driftSignal.reminder === "string" ? driftSignal.reminder.trim() : "";
  if (!reminder) return base;
  base.push(reminder);
  return base;
}

function mergeRunPlannerDirectives(runtimeDirectives, runDirectives, mode) {
  const runtime = normalizeDirectiveLines(runtimeDirectives);
  const run = normalizeDirectiveLines(runDirectives);
  if (mode === "replace") {
    return run;
  }
  return [...runtime, ...run];
}

function normalizeDirectiveLines(value) {
  return (Array.isArray(value) ? value : [])
    .filter((line) => typeof line === "string" && line.trim())
    .map((line) => line.trim());
}

function truncateText(value, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizePlannerResponseText(response) {
  if (!response || typeof response !== "object") return "";
  const text = typeof response.text === "string" ? response.text.trim() : "";
  if (text) return truncateText(text, 1600);
  if (Array.isArray(response.toolCalls) && response.toolCalls.length > 0) {
    return truncateText(JSON.stringify(response.toolCalls), 1600);
  }
  return "";
}

// Measures the char contribution of each known section in the planner user prompt.
// Sections are identified by their fixed header markers. Used for payload pressure analysis.
function measurePlannerPromptSections(promptText) {
  if (!promptText) return { chars: 0 };
  const total = promptText.length;
  const marker = (label) => {
    const idx = promptText.indexOf(label);
    return idx >= 0 ? idx : -1;
  };
  const slice = (start, end) => (start >= 0 ? (end >= 0 ? end - start : total - start) : 0);
  const loopStart = marker("Loop state:\n");
  const historyStart = marker("Action history:\n");
  const workspaceStart = marker("Virtual workspace draft artifacts:");
  const actionsStart = marker("Available actions:\n");
  const planStart = marker("Plan state:\n");
  const loopStateChars = slice(loopStart, historyStart >= 0 ? historyStart : -1);
  const loopFieldBreakdown = measureLoopStateFields(promptText, loopStart);
  return {
    chars: total,
    actionsChars: slice(actionsStart, loopStart >= 0 ? loopStart : historyStart),
    historyChars: slice(historyStart, workspaceStart >= 0 ? workspaceStart : -1),
    loopStateChars,
    planChars: slice(planStart, historyStart >= 0 ? historyStart : -1),
    workspaceChars: slice(workspaceStart, -1),
    loopFields: loopFieldBreakdown
  };
}

function measureLoopStateFields(promptText, loopStart) {
  if (loopStart < 0) return null;
  const jsonStart = loopStart + "Loop state:\n".length;
  // Compact JSON is a single line — stop at the first newline after jsonStart
  const lineEnd = promptText.indexOf("\n", jsonStart);
  const jsonText = (lineEnd >= 0 ? promptText.slice(jsonStart, lineEnd) : promptText.slice(jsonStart)).trim();
  try {
    const obj = JSON.parse(jsonText);
    const breakdown = {};
    for (const key of Object.keys(obj)) {
      breakdown[key] = JSON.stringify(obj[key]).length;
    }
    return breakdown;
  } catch {
    return null;
  }
}

export { requestPlanner };
