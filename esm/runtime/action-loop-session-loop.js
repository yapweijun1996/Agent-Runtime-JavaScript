import { isAbortSignalAborted, createAbortError } from './abort-signal.js';
import { maybeCompactActionHistory, projectActionHistory } from './action-history-compaction.js';
import { PUBLISH_DIRECT_ACTION } from './kernel-terminal-actions.js';
import { executeAction } from './action-loop-action.js';
import { handleInvalidPlannerDecision, finalizeActionLoopFailure } from './action-loop-failure.js';
import { maybeFinalizeMaxStepsContinuation } from './action-loop-continuation.js';
import { finishRun } from './finalizer.js';
import { completePhase, startPhase } from './oodae.js';
import { cloneValue } from './utils.js';
import { handlePolicyBlock } from './action-loop-terminal.js';
import { requestPlanner } from './action-loop-planner.js';
import { resolveBlockedPolicyDecision } from './hooks/policy-hook.js';
import { ensureSessionHookRunner } from './hooks/session-hooks.js';
import { TERMINAL_REPAIR_BLOCKED_RESPONSE_TYPE } from './hooks/terminal-repair-hook.js';
import { recordLoopTransition, LOOP_TRANSITIONS } from './loop-transition.js';
import { emitSkillPolicyStep, getPolicyManifestForSkill, evaluateSkillPolicy } from './skill-policy.js';
import { ERROR_CODES } from './errors.js';
import { callHostHookWithTimeout } from './host-hook-timeout.js';
import { exportState } from './run-state-portable.js';
import { executePlan } from './action-loop-plan.js';
import { beginActionLoopCycle } from './action-loop-session-cycle.js';
import { isDecisionActionAvailable, summarizeActionFailureSignal } from './action-loop-session-decision-utils.js';
import { isWorkspacePublishCandidateGatedForMode } from './planner-action-surface.js';
import { readActionArgs } from './action-loop-utils.js';
import { handlePlannerFinalDecision, handlePlannerFinalizeDecision, maybeHandleDirectFinalAfterSkillTool } from './action-loop-session-terminals.js';
import { fingerprintAction } from './action-fingerprint.js';
import { refreshActionPatternConvergence, shouldEmitActionPatternConvergenceRefreshed } from './action-pattern-convergence.js';
import { noteCycleCompleted, readSessionProgressMarker, recordFingerprint } from './session-budget.js';
import { maybeAutostartTodoState } from './todo-autostart.js';
import { isTodoPlanningPlaceholder } from './todo-planning-placeholder.js';
import { maybeCreateTodoPlanRequiredGuard, maybeCreateTodoInspectLoopGuard } from './todo-autopilot.js';
import { TURN_SIGNALS } from './turn-signal.js';

const InterruptedTurnControl = Object.freeze({
  ADVANCE_STEP: "advance_step",
  RERUN_TURN: "rerun_turn",
  RETURN_INTERRUPTION: "return_interruption"
});

async function continueActionLoop(session) {
  // Opt-in whole-run wall-clock budget. When runDeadlineMs is configured we
  // record the absolute deadline once at loop entry and check it at each cycle
  // boundary. On breach the loop returns a structured RUN_DEADLINE_EXCEEDED
  // result (carrying runState.costLedger) instead of letting the host SIGKILL
  // the process — the path that wrote null usage/cost in the TNO benchmark.
  const runDeadlineMs = Number.isInteger(session.runtimeConfig.runDeadlineMs)
    ? session.runtimeConfig.runDeadlineMs
    : null;
  const runDeadlineAtMs = runDeadlineMs ? Date.now() + runDeadlineMs : null;
  // Opt-in whole-run USD budget (GAP 5). Same hard-stop class as
  // runDeadlineMs: checked at each cycle boundary against the cost ledger's
  // already-recorded totals (cost-ledger.js stays a pure recorder — policy
  // lives here at the loop boundary). Requires costPricing (enforced at
  // createRuntime); never exposed to the AI.
  const maxCostUsd = Number.isFinite(session.runtimeConfig.maxCostUsd)
    ? session.runtimeConfig.maxCostUsd
    : null;
  // Host-tunable warning threshold (fraction of the cap, normalized at
  // createRuntime). The fallback mirrors the normalizer default for loop
  // callers that bypass config normalization (tests, resume envelopes).
  const costWarnRatio = Number.isFinite(session.runtimeConfig.costWarnRatio)
    ? session.runtimeConfig.costWarnRatio
    : 0.8;
  let costBudgetWarned = false;
  while (session.runState.cycleCount < session.runtimeConfig.maxSteps) {
    const interruptedOutcome = handleInterruptedOutcome(session);
    if (interruptedOutcome === InterruptedTurnControl.RETURN_INTERRUPTION) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_APPROVAL_PAUSE);
      return finishInterruptedTurn(session);
    }
    const continuingInterruptedTurn = interruptedOutcome === InterruptedTurnControl.RERUN_TURN;
    session.continuingInterruptedTurn = false;
    session.runState.continuingInterruptedTurn = continuingInterruptedTurn;
    if (continuingInterruptedTurn) {
      normalizeContinuingInterruptedTurn(session.runState);
    }

    // AGRUN-CALLER-ABORT — Top-of-iteration check so a Stop click between
    // cycles short-circuits the loop without launching another planner
    // round. Mid-fetch abort already propagates via request.signal.
    if (isAbortSignalAborted(session.callerAbortSignal)) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_ABORT);
      throw createAbortError("Run aborted by caller during action loop.");
    }
    // Crash-recovery checkpoint (P2). Same cycle-boundary class as the
    // deadline/cost checks below: hand the host a serializable export of the
    // state at this boundary so it can persist incrementally. The host
    // resumes by feeding the saved envelope back via runOptions.resumeState.
    emitCheckpoint(session);
    // Guard on cycleCount > 0 so at least one full cycle always runs before
    // a deadline can fire (a valid cycleRecord exists). A single cycle that
    // itself overruns is the SIGKILL/heartbeat-salvage path, not this one —
    // a loop-boundary check cannot interrupt an in-flight provider call.
    if (runDeadlineAtMs && session.runState.cycleCount > 0 && Date.now() >= runDeadlineAtMs) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_RUN_DEADLINE);
      return finalizeRunDeadlineExceeded(session, runDeadlineMs);
    }
    // Cost budget mirrors the deadline check above: same cycleCount > 0
    // guard (a boundary check cannot interrupt an in-flight provider call),
    // reading totals.cost.total that recordCostEntry already accumulated.
    const spentUsd = session.runState.costLedger
      && session.runState.costLedger.totals
      && session.runState.costLedger.totals.cost
      && Number.isFinite(session.runState.costLedger.totals.cost.total)
      ? session.runState.costLedger.totals.cost.total
      : null;
    if (maxCostUsd && !costBudgetWarned && spentUsd !== null && spentUsd >= costWarnRatio * maxCostUsd) {
      costBudgetWarned = true;
      session.pushStep("cost-budget-warning", {
        maxCostUsd,
        spentUsd,
        ratio: Number((spentUsd / maxCostUsd).toFixed(3)),
        warnRatio: costWarnRatio
      });
    }
    if (maxCostUsd && session.runState.cycleCount > 0 && spentUsd !== null && spentUsd >= maxCostUsd) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_COST_BUDGET);
      return finalizeCostBudgetExceeded(session, maxCostUsd, spentUsd);
    }
    // GAP 4 — prompt-side history compaction, same cycle-boundary class as
    // the deadline/cost checks above. Mutates only session.historyCompaction
    // (the observation log + fold cursor); session.actionHistory stays full
    // for every state consumer. Observer failure degrades to a mechanical
    // omission marker inside the call — compaction never breaks the loop.
    await maybeCompactActionHistory(session);
    const cycleRecord = await beginActionLoopCycle(session, "planner", {
      continuingInterruptedTurn
    });
    // AGRUN-246-E/J — the regex-driven force-finalize bypass
    // (`maybeCreateFinalizeOnlyResearchRecoveryFinal`) was deleted here. It
    // ran BEFORE the planner, regexed the follow-up prompt for "finalize"
    // intent, refreshed research state with a finalize phase, and emitted a
    // `research-recovery-mode-armed` step to pre-arm a finalize FOR the AI —
    // push-mode forbidden by the harness contract ("runtime must not
    // auto-finalize for the AI"). The continued-research-thread FACT is now
    // surfaced read-only in the planner prompt (research phase contract); the
    // AI owns the finalize-vs-more-research choice by picking its next action.

    // Advance the no-progress counter based on the cycle that just finished
    // before checking the budget, so a stalled run is caught on the next
    // entry rather than one cycle late. Skip on the first cycle because
    // there is no prior cycle to account for.
    if (!continuingInterruptedTurn && session.runState.cycleCount > 1 && session.runState.sessionBudget) {
      noteCycleCompleted(
        session.runState.sessionBudget,
        readSessionProgressMarker(session.runState)
      );
    }

    const seededTodoState = maybeAutostartTodoState(
      session.runState,
      session.runtimeConfig && session.runtimeConfig.todoAutopilot
    );
    if (seededTodoState) {
      session.pushStep("todo-autopilot-autostarted", {
        itemCount: seededTodoState.items.length,
        source: "cycle_start"
      });
    }

    // ADR-0023 — `maybeEnforceBudgetBreach` deleted. Runtime no longer
    // force-finalizes on session budget breach. Budget signal still records
    // on `runState.sessionBudget`; AI sees it via planner-prompt loopState
    // and decides whether to finalize. If AI ignores, `maxSteps` returns
    // MAX_STEPS_EXCEEDED.

    // ADR-0028 — continuityDecision branch removed; runtime no longer
    // preempts the planner with a runtime-authored read_url / finalize
    // decision. AI owns all action choices via the planner prompt.
    //
    // 2026-05-09 — `createExecutionClassDecision` deleted. Function used
    // to short-circuit the planner call entirely when
    // `runState.executionClass === "clarification_gate"` and inject a
    // synthetic `{ type: "clarify", question, reasoning }` decision
    // straight into the loop. Runtime decided AI's clarify question
    // before AI ever saw the prompt — push-mode disguised as a
    // "guardrail". AI now reaches the planner; if AI thinks
    // clarification is needed, AI emits clarify itself.
    const plannerRequestOptions = {
      actionHistory: session.actionHistory,
      // GAP 4 — compacted view for the planner PROMPT only. actionHistory
      // above stays the full array so readDeniedActions / failure signals
      // inside requestPlanner keep seeing every entry.
      promptHistory: projectActionHistory(session, session.runtimeConfig.historyCompaction),
      agentRole: session.runtimeConfig.agentRole,
      runtimeConfig: session.runtimeConfig,
      availableActions: session.plannerActions,
      availableAgentSkills: session.runtimeConfig.agentSkills,
      activeAgentSkill: session.runState.agentSkillContext.activeSkill,
      cycleRecord,
      debug: session.debug,
      memoryEntriesAdded: session.memoryEntriesAdded,
      normalizedInput: session.normalizedInput,
      plannerMode: session.runtimeConfig.plannerMode,
      plannerDirectives: session.plannerDirectives,
      plannerDirectivesMode: session.plannerDirectivesMode,
      onInvalidPlannerOutput: session.onInvalidPlannerOutput,
      pushStep: session.pushStep,
      rawInput: session.rawInput,
      request: session.request,
      runState: session.runState,
      runtimeState: session.runtimeState,
      steps: session.steps
    };
    const preRequestOutcome = await ensureSessionHookRunner(session).runPreRequest({
      phase: "before_planner",
      pushStep: session.pushStep,
      request: session.request,
      runState: session.runState,
      session
    });
    if (Array.isArray(preRequestOutcome.diagnostics) && preRequestOutcome.diagnostics.length > 0) {
      session.pushStep("pre-request-hook-failed", { diagnostics: preRequestOutcome.diagnostics });
    }
    const plannerResult = await requestPlanner(plannerRequestOptions);
    session.runState.continuingInterruptedTurn = false;

    if (plannerResult.done) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_PLANNER);
      return plannerResult.result;
    }

    // Hook: allow caller to inspect/rewrite planner decision before execution.
    // Raced — a hung host hook degrades to "ignored", never freezes the loop.
    if (plannerResult.decision && typeof session.onPlannerDecision === "function") {
      const hook = await callHostHookWithTimeout(
        () => session.onPlannerDecision(plannerResult.decision, session.runState),
        {
          hookName: "onPlannerDecision",
          timeoutMs: session.runtimeConfig && session.runtimeConfig.hostHookTimeoutMs
        }
      );
      if (hook.ok) {
        if (hook.value && typeof hook.value === "object") {
          plannerResult.decision = hook.value;
        }
      } else {
        session.debug.log(`onPlannerDecision hook ${hook.timedOut ? "timed out" : "threw"}`, {
          error: hook.message
        });
      }
    }

    if (!plannerResult.decision) {
      session.actionHistory.push({
        kind: "planner_invalid_action",
        summary: "planner returned an invalid decision; planner repair signal queued"
      });
      recordLoopTransition(session, LOOP_TRANSITIONS.PLANNER_INVALID_REPAIR);
      continue;
    }

    // 2026-05-09 — `applyPlannerGuardrails` deleted. Function rewrote AI's
    // decision: `finalize` → `clarify` (when runtime judged task state
    // "unstable"), `clarify` → `finalize` (when runtime decided ambiguity
    // was "inferable", with hardcoded English instruction). AI's choice
    // is now used directly. If AI emits unsafe finalize or unnecessary
    // clarify, AI sees the consequences via observation/turn outcomes
    // and re-plans. Runtime no longer maps AI decisions to other
    // decisions.
    let decision = plannerResult.decision;
    let actionName = decision.type === "clarify"
      ? "ask_clarification"
      : decision.type === "finalize"
        ? "finalize"
        : decision.type === "plan"
          ? "plan"
          : decision.name || null;

    if (
      isTodoPlanningPlaceholder(session.runState.todoState) &&
      actionName !== "todo_plan" &&
      actionName !== "todo_inspect"
    ) {
      const message =
        "TodoState autopilot: planning placeholder must be replaced with todo_plan before work continues.";
      session.pushStep("todo-placeholder-plan-required", {
        actionName,
        cycle: session.runState.cycleCount
      });
      session.actionHistory.push({
        kind: "todo_plan_required",
        summary: message
      });
      session.runState.observation = {
        kind: "hint",
        message
      };
      recordLoopTransition(session, LOOP_TRANSITIONS.TODO_PLACEHOLDER_REQUIRED);
      continue;
    }

    const todoPlanRequired = maybeCreateTodoPlanRequiredGuard(
      session.runState,
      session.runtimeConfig && session.runtimeConfig.todoAutopilot,
      { actionName }
    );
    if (todoPlanRequired) {
      session.pushStep("todo-plan-required-before-tools", {
        actionName: todoPlanRequired.actionName,
        cycle: session.runState.cycleCount
      });
      session.actionHistory.push({
        kind: "todo_plan_required",
        summary: todoPlanRequired.observation
      });
      session.runState.observation = {
        kind: "hint",
        message: todoPlanRequired.observation
      };
      recordLoopTransition(session, LOOP_TRANSITIONS.TODO_PLAN_REQUIRED);
      continue;
    }

    const todoInspectLoop = maybeCreateTodoInspectLoopGuard(
      session.runState,
      session.runtimeConfig && session.runtimeConfig.todoAutopilot,
      { actionName, actionHistory: session.actionHistory }
    );
    if (todoInspectLoop) {
      session.pushStep("todo-inspect-loop-vetoed", {
        consecutiveInspects: todoInspectLoop.consecutiveInspects,
        cycle: session.runState.cycleCount
      });
      session.actionHistory.push({
        kind: "todo_inspect_loop_vetoed",
        summary: todoInspectLoop.observation
      });
      session.runState.observation = {
        kind: "hint",
        message: todoInspectLoop.observation
      };
      recordLoopTransition(session, LOOP_TRANSITIONS.TODO_INSPECT_LOOP_BLOCKED);
      continue;
    }

    session.debug.log(`cycle ${session.runState.cycleCount} | decision`, {
      type: decision.type,
      name: actionName,
      skillName: decision.skillName || null,
      toolName: decision.toolName || null
    });

    completePhase(cycleRecord, session.pushStep, "decide", {
      actionName,
      cycle: session.runState.cycleCount,
      decisionSource: "planner",
      decisionType: decision.type === "action" ? "action" : decision.type,
      outcome: "selected",
      selectedSkill: null
    });
    startPhase(session.runState, session.pushStep, "act", {
      cycle: session.runState.cycleCount,
      selectedSkill: null
    });

    const onResponseOutcome = await ensureSessionHookRunner(session).runOnResponse({
      actionName,
      response: decision,
      session
    });
    if (Array.isArray(onResponseOutcome.diagnostics) && onResponseOutcome.diagnostics.length > 0) {
      session.pushStep("on-response-hook-failed", { diagnostics: onResponseOutcome.diagnostics });
    }
    if (onResponseOutcome.response
      && onResponseOutcome.response.type === TERMINAL_REPAIR_BLOCKED_RESPONSE_TYPE) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_REPAIR_BLOCKED);
      continue;
    }

    if (decision.type === "final") {
      const outcome = await handlePlannerFinalDecision(session, cycleRecord, decision, plannerResult);
      if (outcome.action === "continue") {
        recordLoopTransition(session, LOOP_TRANSITIONS.FINAL_DECISION_REPLAN);
        continue;
      }
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_FINAL_DECISION);
      return outcome.result;
    }

    if (decision.type === "plan") {
      const planResult = await executePlan({
        cycleRecord,
        decision,
        session
      });
      if (planResult.done) {
        recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_PLAN);
        return planResult.result;
      }
      recordLoopTransition(session, LOOP_TRANSITIONS.PLAN_EXECUTED);
      continue;
    }

    if (decision.type === "finalize") {
      const outcome = await handlePlannerFinalizeDecision(session, cycleRecord, decision);
      if (outcome.action === "continue") {
        recordLoopTransition(session, LOOP_TRANSITIONS.FINALIZE_DECISION_REPLAN);
        continue;
      }
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_FINALIZE_DECISION);
      return outcome.result;
    }

    let resolvedAction = session.actionRegistry.get(actionName);
    const isActionDisabled = resolvedAction && !isDecisionActionAvailable(
      { name: actionName},
      session.availableActions
    );

    // ADR-0026 — Consecutive same-action failures are surfaced as a
    // read-only signal in `runState.actionFailureSignal`; AI sees it on
    // the next planner cycle and decides whether to switch tactics,
    // finalize, or keep retrying. The runtime does not force-finalize.
    // If AI keeps retrying, the loop hits `maxSteps`.
    if (isActionDisabled) {
      session.pushStep("action-disabled", {
        actionName,
        cycle: session.runState.cycleCount
      });
      session.actionHistory.push({
        kind: "action_disabled",
        summary: `${actionName} is disabled and cannot be executed`
      });
      recordLoopTransition(session, LOOP_TRANSITIONS.ACTION_DISABLED);
      continue;
    }

    // AGRUN-256 — runtime guard against hallucinated workspace_publish_candidate
    // emissions outside an evidence-convergence run. selectPlannerActions already hides
    // the action from the planner catalog, but envelope/native_tools planners
    // can still emit it by name. Reject here AND route through the standard
    // planner-invalid-action signal pipeline so the next planner cycle sees
    // a recoverable observation ("use finalize instead") rather than re-emitting
    // the same action until maxSteps — the 884-step loop Globe3 reproduced
    // when a host disabled the action without a paired planner directive.
    if (
      resolvedAction &&
      actionName === PUBLISH_DIRECT_ACTION &&
      isWorkspacePublishCandidateGatedForMode({
        runState: session.runState,
        runtimeConfig: session.runtimeConfig,
        terminalRepairState: session.runState && session.runState.terminalRepairState
      })
    ) {
      const gateDetail = [
        "workspace_publish_candidate is a publish-direct terminal (skips the runtime finalize LLM; usedRuntimeFinalize=false, tokens=0 audit blind spot) and is gated by default.",
        "To deliver the answer this turn, end with a finalize envelope so the runtime finalizer can produce the response.",
        "Hosts can legitimately enable publish-direct through ONE of three explicit opt-in paths: (a) set runtimeConfig.publishCandidateGate.enabled=false to allow publish-direct in any mode; (b) activate a skill that requires evidence convergence or publish-readiness on the run so the catalog exposes the action; (c) route through terminalRepairState.allowedActions during runtime recovery."
      ].join(" ");
      session.pushStep("workspace-publish-candidate-gated", {
        actionName,
        cycle: session.runState.cycleCount,
        detail: gateDetail,
        reason: "mode_gate_evidence_convergence_inactive"
      });
      const invalidResult = handleInvalidPlannerDecision({
        cycleRecord,
        memoryEntriesAdded: session.memoryEntriesAdded,
        normalizedInput: session.normalizedInput,
        plannerResult: {
          ...plannerResult,
          invalidKind: "workspace_publish_candidate_gated",
          rejectedActionName: actionName,
          repairAttempted: false,
          response: {
            ...(plannerResult && plannerResult.response),
            text: gateDetail
          }
        },
        pushStep: session.pushStep,
        rawInput: session.rawInput,
        runState: session.runState,
        runtimeState: session.runtimeState,
        steps: session.steps
      });
      if (invalidResult.done) {
        recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_INVALID_ACTION);
        return invalidResult.result;
      }
      session.actionHistory.push({
        kind: "planner_invalid_action",
        summary: `${actionName} is gated for non-evidence-convergence mode; use finalize instead`
      });
      recordLoopTransition(session, LOOP_TRANSITIONS.PUBLISH_CANDIDATE_GATED);
      continue;
    }

    if (!resolvedAction) {
      // Unknown action name: the decision was STRUCTURALLY valid (passed
      // isValidDecision) but names an action not on the current surface. This
      // is the dominant Gemini publish/repair churn the TNO benchmark flagged
      // (model keeps emitting workspace_replace/workspace_write off-surface).
      // The raw plannerResult carries no invalidKind/rejectedActionName here
      // (those exist only on the planner's own invalid path), so set them
      // explicitly — `actionName` is the offending name — mirroring the gated
      // case above, so the enriched planner-invalid-action diagnostic fires.
      const invalidResult = handleInvalidPlannerDecision({
        cycleRecord,
        memoryEntriesAdded: session.memoryEntriesAdded,
        normalizedInput: session.normalizedInput,
        plannerResult: {
          ...plannerResult,
          invalidKind: "unknown_action_name",
          rejectedActionName: actionName || null,
          repairAttempted: false
        },
        pushStep: session.pushStep,
        rawInput: session.rawInput,
        runState: session.runState,
        runtimeState: session.runtimeState,
        steps: session.steps
      });

      if (invalidResult.done) {
        recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_INVALID_ACTION);
        return invalidResult.result;
      }

      session.actionHistory.push({
        kind: "planner_invalid_action",
        summary: `unknown action: ${actionName || "unknown"}`
      });
      recordLoopTransition(session, LOOP_TRANSITIONS.UNKNOWN_ACTION);
      continue;
    }

    const repeatedWebSearchSkip = createRepeatedWebSearchSkip(session, actionName, decision, "repeat_query_history");
    if (repeatedWebSearchSkip) {
      recordLoopTransition(session, LOOP_TRANSITIONS.WEB_SEARCH_REPEAT_SKIPPED);
      continue;
    }

    const policyHookOutcome = await ensureSessionHookRunner(session).runPreToolCall({
      action: resolvedAction,
      call: { args: readActionArgs(decision), name: actionName },
      decision,
      phase: "action",
      session
    });
    const judgedPolicyDecision = resolveBlockedPolicyDecision(policyHookOutcome, resolvedAction);

    if (judgedPolicyDecision) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_APPROVAL_PAUSE, { source: "policy" });
      return handlePolicyBlock({
        actionHistory: session.actionHistory,
        actionName,
        cycleRecord,
        decision,
        memoryEntriesAdded: session.memoryEntriesAdded,
        normalizedInput: session.normalizedInput,
        policyDecision: judgedPolicyDecision,
        pushStep: session.pushStep,
        rawInput: session.rawInput,
        request: session.request,
        runState: session.runState,
        runtimeConfig: session.runtimeConfig,
        runtimeState: session.runtimeState,
        steps: session.steps
      });
    }

    const skillPolicyDecision = await evaluateSkillPolicyForStandaloneAction(session, actionName, decision);
    if (skillPolicyDecision && skillPolicyDecision.action === "ask") {
      emitSkillPolicyStep(session.pushStep, "skill-policy-approval-required", skillPolicyDecision);
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_APPROVAL_PAUSE, { source: "skill_policy" });
      return handlePolicyBlock({
        actionHistory: session.actionHistory,
        actionName,
        cycleRecord,
        decision,
        memoryEntriesAdded: session.memoryEntriesAdded,
        normalizedInput: session.normalizedInput,
        policyDecision: {
          action: "ask",
          actionName,
          skillPolicyDecision,
          tier: skillPolicyDecision.tier ?? null
        },
        pushStep: session.pushStep,
        rawInput: session.rawInput,
        request: session.request,
        runState: session.runState,
        runtimeConfig: session.runtimeConfig,
        runtimeState: session.runtimeState,
        steps: session.steps
      });
    }

    const actionFingerprint = fingerprintAction(decision);
    if (actionFingerprint && session.runState.sessionBudget) {
      const repeatCount = recordFingerprint(session.runState.sessionBudget, actionFingerprint);
      if (repeatCount > 1) {
        session.pushStep("action-fingerprint-repeat", {
          actionName,
          cycle: session.runState.cycleCount,
          fingerprint: actionFingerprint,
          repeatCount
        });
        if (actionName === "web_search" && isRepeatedWebSearchQuery(session.runState, decision)) {
          createRepeatedWebSearchSkip(session, actionName, decision, "repeat_query");
          recordLoopTransition(session, LOOP_TRANSITIONS.WEB_SEARCH_REPEAT_ESCALATED);
          continue;
        }
      }
    }

    const actionResult = await executeAction({
      actionHistory: session.actionHistory,
      actionName,
      actionRegistry: session.actionRegistry,
      agentSkillIndexProvider: session.runtimeConfig.agentSkillIndexProvider,
      agentSkills: session.runtimeConfig.agentSkills,
      cycleRecord,
      debug: session.debug,
      decision,
      memoryEntriesAdded: session.memoryEntriesAdded,
      normalizedInput: session.normalizedInput,
      onStreamEvent: session.onStreamEvent,
      onToolResult: session.onToolResult,
      pushStep: session.pushStep,
      rawInput: session.rawInput,
      request: session.request,
      runtimeConfig: session.runtimeConfig,
      runState: session.runState,
      runtimeState: session.runtimeState,
      // ADR-0037 — Forward the spawn_subagent capability so action.execute
      // can delegate to a worker action loop. Null when run-loop.js did
      // not thread runLoop (defensive — spawn_subagent action returns
      // SUBAGENT_CAPABILITY_MISSING in that case).
      spawnSubagent: session.spawnSubagent,
      steps: session.steps
    });

    if (actionResult.done) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_ACTION);
      return actionResult.result;
    }

    const directFinalResult = await maybeHandleDirectFinalAfterSkillTool(session, cycleRecord, actionName);
    if (directFinalResult) {
      recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_DIRECT_FINAL);
      return directFinalResult;
    }

    // ADR-0026 — Recompute the consecutive-failure signal after each
    // action. Emits a step + writes to runState so the next planner
    // prompt sees `loopState.actionFailureSignal`.
    updateActionFailureSignal(session);
    // AGRUN-435 — the common case: action executed, no terminal, no early
    // continue. Record the implicit fall-through to the next iteration.
    recordLoopTransition(session, LOOP_TRANSITIONS.NEXT_TURN);
  }

  const continuationResult = maybeFinalizeMaxStepsContinuation(session);
  if (continuationResult) {
    recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_MAX_STEPS_CONTINUATION);
    return continuationResult;
  }

  recordLoopTransition(session, LOOP_TRANSITIONS.TERMINAL_MAX_STEPS_EXCEEDED);
  return finalizeActionLoopFailure({
    code: ERROR_CODES.MAX_STEPS_EXCEEDED,
    cycleRecord: session.runState.oodae.cycles[session.runState.oodae.cycles.length - 1],
    memoryEntriesAdded: session.memoryEntriesAdded,
    normalizedInput: session.normalizedInput,
    output: null,
    pushStep: session.pushStep,
    rawInput: session.rawInput,
    runState: session.runState,
    runtimeState: session.runtimeState,
    steps: session.steps
  });
}

// Crash-recovery checkpoint emit (P2). Best-effort and isolated: a host
// onCheckpoint callback (or a serialization failure) must never break the run,
// exactly like onStep. No-op unless the host registered the hook.
function emitCheckpoint(session) {
  if (typeof session.onCheckpoint !== "function") return;
  try {
    const result = session.onCheckpoint(exportState(session.runState));
    // C2 (audit 2026-06-10) — onCheckpoint is best-effort/fire-and-forget. If a
    // host returns a Promise that rejects, the SYNCHRONOUS try/catch above cannot
    // catch it and the discarded Promise becomes an unhandled rejection (fatal in
    // Node 15+, silent in the browser). Unlike the action-timeout race, nothing
    // else observes this Promise, so a guard is required: absorb a late async
    // rejection so a host checkpoint handler can never break the run.
    if (result && typeof result.then === "function") {
      result.then(undefined, () => {});
    }
  } catch (_error) {
    // Host checkpoint listeners / clone failures must not break runtime.
  }
}

function handleInterruptedOutcome(session) {
  const runState = session && session.runState && typeof session.runState === "object"
    ? session.runState
    : null;
  if (!runState) return InterruptedTurnControl.ADVANCE_STEP;

  const turnControl = runState.turnControl && typeof runState.turnControl === "object"
    ? runState.turnControl
    : null;
  const pendingApproval = runState.pendingApproval && typeof runState.pendingApproval === "object"
    ? runState.pendingApproval
    : null;
  if (turnControl && turnControl.signal === TURN_SIGNALS.INTERRUPTION) {
    return pendingApproval
      ? InterruptedTurnControl.RETURN_INTERRUPTION
      : InterruptedTurnControl.RERUN_TURN;
  }

  return session && session.continuingInterruptedTurn === true
    ? InterruptedTurnControl.RERUN_TURN
    : InterruptedTurnControl.ADVANCE_STEP;
}

function finishInterruptedTurn(session) {
  const runState = session.runState;
  const turnControl = runState.turnControl && typeof runState.turnControl === "object"
    ? runState.turnControl
    : {};
  const pendingApproval = cloneValue(runState.pendingApproval || turnControl.pendingApproval || null);
  const actionName = readString$g(
    (pendingApproval && pendingApproval.actionName) || turnControl.actionName
  ) || "action";

  runState.status = "blocked";
  runState.continuingInterruptedTurn = false;
  return finishRun({
    rawInput: session.rawInput,
    normalizedInput: session.normalizedInput,
    runState,
    output: {
      kind: "approval_required",
      pendingApproval,
      text: readString$g(turnControl.output && turnControl.output.text) ||
        `Approval required before running ${actionName}.`
    },
    memoryEntriesAdded: session.memoryEntriesAdded,
    steps: session.steps,
    runtimeState: session.runtimeState
  });
}

function normalizeContinuingInterruptedTurn(runState) {
  // AGRUN-490 (audit M5) — do NOT reset runState.recoveryState (the H8 planner
  // repair budget) here. M5 flagged "plannerRecovery not reset on resume", but
  // against the post-H8 design that reset would be a REGRESSION: (a) a fresh
  // turn already starts clean via createRunState; (b) an approval interruption
  // can only block an action a VALID planner decision produced, and that valid
  // decision already zeroed the budget (resetRecoveryBudget in
  // action-loop-planner.js) — so resume inherits retries 0; (c) a crash-recovery
  // resume mid-invalid-streak must CONTINUE the streak, else resume becomes a way
  // to bypass the budget and loop forever on failed repairs. Pinned by
  // recovery-budget-turn-boundary.test.js.
  const turnControl = runState && runState.turnControl && typeof runState.turnControl === "object"
    ? runState.turnControl
    : null;
  if (!turnControl || turnControl.signal !== TURN_SIGNALS.INTERRUPTION || runState.pendingApproval) {
    return;
  }

  runState.turnControl = {
    ...cloneValue(turnControl),
    pendingApproval: null,
    signal: TURN_SIGNALS.RUN_AGAIN
  };
}

function finalizeRunDeadlineExceeded(session, runDeadlineMs) {
  const cycles = session.runState.oodae && Array.isArray(session.runState.oodae.cycles)
    ? session.runState.oodae.cycles
    : [];
  session.pushStep("run-deadline-exceeded", {
    cycle: session.runState.cycleCount,
    runDeadlineMs,
    totalTokens: session.runState.costLedger
      && session.runState.costLedger.totals
      && Number.isFinite(session.runState.costLedger.totals.totalTokens)
      ? session.runState.costLedger.totals.totalTokens
      : null
  });
  return finalizeActionLoopFailure({
    code: ERROR_CODES.RUN_DEADLINE_EXCEEDED,
    cycleRecord: cycles[cycles.length - 1] || null,
    memoryEntriesAdded: session.memoryEntriesAdded,
    normalizedInput: session.normalizedInput,
    output: null,
    pushStep: session.pushStep,
    rawInput: session.rawInput,
    runState: session.runState,
    runtimeState: session.runtimeState,
    steps: session.steps
  });
}

function finalizeCostBudgetExceeded(session, maxCostUsd, spentUsd) {
  const cycles = session.runState.oodae && Array.isArray(session.runState.oodae.cycles)
    ? session.runState.oodae.cycles
    : [];
  session.pushStep("cost-budget-exceeded", {
    cycle: session.runState.cycleCount,
    maxCostUsd,
    spentUsd,
    currency: session.runState.costLedger
      && session.runState.costLedger.totals
      && session.runState.costLedger.totals.cost
      && typeof session.runState.costLedger.totals.cost.currency === "string"
      ? session.runState.costLedger.totals.cost.currency
      : null
  });
  return finalizeActionLoopFailure({
    code: ERROR_CODES.COST_BUDGET_EXCEEDED,
    cycleRecord: cycles[cycles.length - 1] || null,
    memoryEntriesAdded: session.memoryEntriesAdded,
    normalizedInput: session.normalizedInput,
    output: null,
    pushStep: session.pushStep,
    rawInput: session.rawInput,
    runState: session.runState,
    runtimeState: session.runtimeState,
    steps: session.steps
  });
}

function createRepeatedWebSearchSkip(session, actionName, decision, reason) {
  if (actionName !== "web_search" || !isRepeatedWebSearchQuery(session.runState, decision)) {
    return null;
  }
  // AGRUN-217 / ADR-0012 — `research_report_backstop` synthetic search
  // bypass was deleted in PR 2 along with `synthesizeCoverageQuery` and
  // `createNextResearchAction`. Runtime no longer emits decisions with
  // `args.source === "research_report_backstop"`, so the bypass has no
  // remaining caller and is removed here. Any future planner/skill-owned
  // duplicate query is blocked by the normal guard, exactly per ADR-0012:
  // runtime detects duplicates, AI decides what to do next.
  const query = readString$g(readActionArgs(decision) && readActionArgs(decision).query);
  const skipState = recordRepeatedWebSearchSkip(session.runState, query, reason);
  const escalated = skipState.count > 1;
  const message = [
    "Research harness blocked a repeated web_search query.",
    query ? `Repeated query: ${query}.` : "",
    escalated ? "This repeated query is now treated as a stalled planner decision." : "",
    "Choose a fresh topic-specific search query, read an unread high-value source, inspect workspace, or finalize with limitations if you judge coverage is exhausted."
  ].filter(Boolean).join(" ");
  session.pushStep("web-search-repeat-blocked", {
    count: skipState.count,
    cycle: session.runState.cycleCount,
    escalated,
    query: query || null,
    reason
  });
  session.actionHistory.push({
    actionName,
    kind: escalated ? "planner_invalid_action" : "action_skipped",
    summary: message
  });
  session.runState.observation = {
    actionName,
    kind: "hint",
    message
  };
  const evaluator = refreshActionPatternConvergence(session.runState, {
    actionName,
    decision,
    output: { blocked: true, kind: "web_search_repeat_blocked", reason },
    runtimeConfig: session && session.runtimeConfig,
    status: "web_search_repeat_blocked"
  });
  if (shouldEmitActionPatternConvergenceRefreshed(evaluator)) {
    const signal = evaluator.convergenceSignal;
    session.pushStep("action-pattern-convergence-refreshed", {
      actionName,
      forbiddenMove: signal ? signal.forbiddenMove : null,
      patternKind: signal ? signal.patternKind : null,
      repeatedFingerprintCount: evaluator.repeatedFingerprintCount,
      repeatedSemanticFingerprintCount: evaluator.repeatedSemanticFingerprintCount,
      status: evaluator.status,
      stepsWithoutObservableProgress: evaluator.stepsWithoutObservableProgress
    });
  }
  return true;
}

function recordRepeatedWebSearchSkip(runState, query, reason) {
  const normalizedQuery = normalizeSearchQuery(query);
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const previous = context.repeatedSearchSkips && typeof context.repeatedSearchSkips === "object" && !Array.isArray(context.repeatedSearchSkips)
    ? context.repeatedSearchSkips
    : {};
  const key = normalizedQuery || "__missing_query__";
  const prior = previous[key] && typeof previous[key] === "object" ? previous[key] : {};
  const count = readPositiveInteger$9(prior.count) + 1;
  const nextEntry = {
    count,
    lastReason: readString$g(reason) || null,
    query: readString$g(query) || null
  };
  if (runState && typeof runState === "object") {
    runState.researchContext = {
      ...context,
      repeatedSearchSkips: {
        ...previous,
        [key]: nextEntry
      }
    };
  }
  return nextEntry;
}

function isRepeatedWebSearchQuery(runState, decision) {
  const args = readActionArgs(decision);
  const query = normalizeSearchQuery(readString$g(args && args.query));
  if (!query) return false;
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const passes = Array.isArray(context.searchPasses) ? context.searchPasses : [];
  return passes.some((pass) => normalizeSearchQuery(readString$g(pass && pass.query)) === query);
}

function normalizeSearchQuery(value) {
  return readString$g(value).toLowerCase().replace(/\s+/g, " ");
}

async function evaluateSkillPolicyForStandaloneAction(session, actionName, decision) {
  if (actionName !== "execute_skill_tool") return null;
  const args = readActionArgs(decision);
  const activeSkill = session.runState.agentSkillContext && session.runState.agentSkillContext.activeSkill;
  const skillName = readString$g(args && args.skillName) ||
    readString$g(activeSkill && (activeSkill.skillId || activeSkill.name));
  const toolName = readString$g(args && args.toolName);
  if (!skillName && !toolName) return null;

  const manifest = await getPolicyManifestForSkill({
    agentSkillIndexProvider: session.runtimeConfig.agentSkillIndexProvider,
    agentSkills: session.runtimeConfig.agentSkills
  }, skillName);

  return evaluateSkillPolicy({
    manifest,
    operation: "execute",
    runtimeConfig: session.runtimeConfig,
    skillId: skillName,
    skillName,
    toolName
  });
}

function readString$g(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInteger$9(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

// ADR-0026 — Read-only signal replacement for `maybeEnforceConsecutiveFailureGuard`.
// After each action result is appended to `actionHistory`, recompute whether
// the same action has failed consecutively at or above
// CONSECUTIVE_FAILURE_SIGNAL_THRESHOLD. If yes, write the signal to runState
// (visible to the next planner prompt as `loopState.actionFailureSignal`)
// and emit one `action-failure-signal` step. AI decides what to do.
function updateActionFailureSignal(session) {
  const signal = summarizeActionFailureSignal(session.actionHistory);
  if (!signal) {
    if (session.runState.actionFailureSignal) {
      session.runState.actionFailureSignal = null;
    }
    return;
  }

  const previous = session.runState.actionFailureSignal;
  session.runState.actionFailureSignal = {
    actionName: signal.actionName,
    consecutiveCount: signal.consecutiveCount,
    threshold: signal.threshold
  };

  // Only emit a step when the signal newly crosses the threshold or
  // when the count increases — avoids step spam on every cycle.
  const isNew = !previous || previous.actionName !== signal.actionName;
  const hasGrown = previous
    && previous.actionName === signal.actionName
    && previous.consecutiveCount < signal.consecutiveCount;
  if (isNew || hasGrown) {
    session.pushStep("action-failure-signal", {
      actionName: signal.actionName,
      consecutiveCount: signal.consecutiveCount,
      cycle: session.runState.cycleCount,
      threshold: signal.threshold
    });
  }
}

export { InterruptedTurnControl, continueActionLoop, handleInterruptedOutcome };
