import { recordObservation, startEvaluatePhase, completeEvaluatePhase } from './finalizer.js';
import { completePhase } from './oodae.js';
import { createEvaluationState } from './task-state.js';
import './action-names.js';
import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';
import { handleDirectFinal } from './action-loop-terminal.js';
import { handlePlanSynthesize } from './action-loop-plan-terminal.js';
import { askBeforeFinalizeHook } from './action-loop-session-terminals.js';
import { prepareDirectFinalResult } from './direct-final-result.js';
import { validatePlan } from './action-loop-plan-validation.js';
import { runPlanActions } from './action-loop-plan-actions.js';
import { synthesizePlanPerAction } from './action-loop-plan-synthesize.js';
import { normalizeThrownError } from './errors.js';
import { maybeSeedTodoStateFromPlanDecision } from './todo-plan-progress.js';
import { refreshActionPatternConvergence, shouldEmitActionPatternConvergenceRefreshed } from './action-pattern-convergence.js';

// ADR-0023 — `executeStandaloneRecoveredAction` + `createStandaloneMutatorRecovery`
// deleted (runtime no longer auto-extracts a single mutator action from a
// malformed plan envelope; AI re-plans with fresh evidence).
//
// 2026-05-09 — standalone-mutator constants and the auto-strip retry path
// were deleted alongside `stripSynthesizePerActionIfSafe`. Runtime no longer
// silently modifies the AI's plan envelope by dropping `synthesize_per_action`.
// Validation feedback tells AI both recovery paths ("provide section.prompt for
// every action, OR omit synthesize_per_action"). AI picks; runtime never picks.

async function executePlan(options) {
  const { cycleRecord, session } = options;
  const startedAt = Date.now();

  // C3 (audit 2026-06-10) — error-boundary PARITY with the single-action path.
  // executeAction (action-loop-action.js) wraps execute + ALL side-effect
  // application (applyAgentHandoffToSession, evidence, progress, …) in a
  // try/catch that turns a throw into a recoverable observation. The plan path
  // had no such boundary: a throw from a post-execution helper here escaped
  // continueActionLoop and the non-awaited `try { return runActionLoop() }` in
  // run-loop.js (which only catches synchronous setup throws), rejecting
  // runtime.run()'s promise and leaving the session mid-mutation. Mirror the
  // single-action boundary: convert an unexpected throw into a recoverable
  // plan_execution_error observation so the planner self-corrects next cycle.
  // Aborts are re-thrown — caller cancellation must still terminate the run.
  try {
    return await runValidatedPlan(options, startedAt);
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    const message = readErrorMessage$1(error);
    session.pushStep("plan-execution-error", {
      cycle: session.runState.cycleCount,
      error: message
    });
    return continueAfterPlanObservation({
      cycleRecord,
      kind: "plan_execution_error",
      message: `Plan execution failed: ${message}`,
      output: createPlanErrorOutput("execution", message),
      session
    });
  }
}

async function runValidatedPlan(options, startedAt) {
  const { cycleRecord, decision, session } = options;

  session.pushStep("plan-validating", {
    actionCount: Array.isArray(decision.actions) ? decision.actions.length : 0,
    cycle: session.runState.cycleCount,
    partialOk: decision.partial_ok === true
  });

  const validation = await validatePlan(session, decision);
  const effectiveDecision = decision;
  if (!validation.ok) {
    // ADR-0023 — standalone-mutator-recovery deleted. Plan validation
    // failure now surfaces directly as observation. AI re-plans next
    // cycle without runtime extracting a single mutator and running it.
    //
    // 2026-05-09 — `notePlanValidationFailure` deleted. Runtime no longer
    // counts repeat failures or injects "you must use single action"
    // directives into AI's planner prompt. That was push-mode disguised
    // as a loop-breaker (runtime prescribing AI's recovery strategy).
    // The structured `validation.planner_feedback.detail` already reaches
    // AI via `createPlanErrorOutput` → observation; AI decides recovery
    // (single action, ask_clarification, different plan structure, etc.).
    // If lite-tier models loop, that's a model capability limit; hosts
    // should circuit-break via `maxSteps` / `maxTokens` / model selection.
    session.pushStep("plan-validation-failed", {
      code: validation.code || null,
      cycle: session.runState.cycleCount,
      error: validation.error
    });
    if (validation.code) {
      session.pushStep("plan-validation-rejected", {
        code: validation.code,
        cycle: session.runState.cycleCount,
        detail: validation.planner_feedback && validation.planner_feedback.detail
          ? validation.planner_feedback.detail
          : validation.error
      });
    }
    // AGRUN-590 — a rejected plan is a burned cycle with zero progress, but
    // this path never fed the convergence evaluator, so N consecutive
    // rejections looked like nothing to the read-only-planning guard (the
    // deepseek probe burned 4 in a row invisibly). Mirror the session-loop
    // web_search_repeat_blocked precedent: refresh with a blocked outcome so
    // stepsWithoutObservableProgress accumulates and the guard's normal
    // advisory -> hard_veto ladder can engage.
    const rejectedActionName = readString(
      Array.isArray(decision.actions) && decision.actions[0] && decision.actions[0].name
    ) || "plan";
    const evaluator = refreshActionPatternConvergence(session.runState, {
      actionName: rejectedActionName,
      decision,
      output: { blocked: true, kind: "plan_validation_rejected", reason: validation.code || "plan_validation" },
      runtimeConfig: session.runtimeConfig,
      status: "plan_validation_rejected"
    });
    if (shouldEmitActionPatternConvergenceRefreshed(evaluator)) {
      const signal = evaluator.convergenceSignal;
      session.pushStep("action-pattern-convergence-refreshed", {
        actionName: rejectedActionName,
        forbiddenMove: signal ? signal.forbiddenMove : null,
        patternKind: signal ? signal.patternKind : null,
        repeatedFingerprintCount: evaluator.repeatedFingerprintCount,
        repeatedSemanticFingerprintCount: evaluator.repeatedSemanticFingerprintCount,
        status: evaluator.status,
        stepsWithoutObservableProgress: evaluator.stepsWithoutObservableProgress
      });
    }
    return continueAfterPlanObservation({
      cycleRecord,
      kind: "plan_validation_error",
      message: validation.error,
      output: createPlanErrorOutput("validation", validation.error, validation.planner_feedback),
      session
    });
  }

  const partialOk = effectiveDecision.partial_ok === true;
  const seededTodoState = maybeSeedTodoStateFromPlanDecision(
    session.runState,
    session.runtimeConfig && session.runtimeConfig.todoAutopilot,
    effectiveDecision,
    validation.actions
  );
  if (seededTodoState) {
    session.pushStep("todo-autopilot-plan-seeded", {
      itemCount: seededTodoState.items.length,
      source: "plan"
    });
  }
  session.pushStep("plan-executing", {
    actionCount: validation.actions.length,
    cycle: session.runState.cycleCount,
    maxParallel: validation.maxParallel,
    partialOk
  });

  const execution = await runPlanActions(
    session,
    validation.actions,
    validation.maxParallel,
    partialOk
  );
  const failureCount = execution.failures.length;
  session.pushStep("plan-executed", {
    actionCount: validation.actions.length,
    allOk: failureCount === 0,
    durationMs: Date.now() - startedAt,
    failureCount,
    partialOk,
    successCount: execution.settled.length - failureCount
  });

  if (failureCount > 0 && !partialOk) {
    const error = readErrorMessage$1(execution.failures[0].reason);
    return continueAfterPlanObservation({
      cycleRecord,
      kind: "plan_execution_error",
      message: `Plan action failed: ${error}`,
      output: createPlanErrorOutput("execution", error),
      session
    });
  }

  const finalizeDecision = {
    finalReadiness: decision.finalReadiness || null,
    instruction: readString(decision.synthesize_instruction) ||
      "Synthesize the planned tool results into a clear, helpful answer for the user.",
    reasoning: readString(decision.reasoning) || "Plan executed successfully."};

  if (effectiveDecision.synthesize_per_action === true) {
    // AGRUN-457 — `plan_finalize` source: consult the host hook BEFORE the
    // per-action synthesis spends LLM calls. A veto routes through
    // continueAfterPlanObservation so the act phase closes correctly.
    const planVeto = await askBeforeFinalizeHook(session, "plan_finalize");
    if (planVeto) {
      return continueAfterPlanObservation({
        cycleRecord,
        kind: "finalize_vetoed_by_host",
        message: planVeto,
        output: { kind: "finalize_vetoed_by_host", observation: planVeto },
        session
      });
    }
    const synthesized = await synthesizePlanPerAction({
      actions: validation.actions,
      decision: effectiveDecision,
      outputs: execution.outputs,
      session
    });
    return {
      done: true,
      result: handlePlanSynthesize({
        cycleRecord,
        finalReadiness: finalizeDecision.finalReadiness,
        markdown: synthesized.markdown,
        memoryEntriesAdded: session.memoryEntriesAdded,
        normalizedInput: session.normalizedInput,
        onToken: session.onToken,
        pushStep: session.pushStep,
        rawInput: session.rawInput,
        request: session.request,
        runState: session.runState,
        runtimeState: session.runtimeState,
        steps: session.steps
      })
    };
  }

  const directFinal = findPlanDirectFinal(session, execution.outputs);
  if (directFinal) {
    // AGRUN-457 — plan-path `direct_final` source (a plan action's tool
    // returned resultKind:"final"). Same veto routing as plan_finalize.
    const directVeto = await askBeforeFinalizeHook(session, "direct_final");
    if (directVeto) {
      return continueAfterPlanObservation({
        cycleRecord,
        kind: "finalize_vetoed_by_host",
        message: directVeto,
        output: { kind: "finalize_vetoed_by_host", observation: directVeto },
        session
      });
    }
    return {
      done: true,
      result: handleDirectFinal({
        cycleRecord,
        directFinal: directFinal.directFinal,
        memoryEntriesAdded: session.memoryEntriesAdded,
        normalizedInput: session.normalizedInput,
        onToken: session.onToken,
        pushStep: session.pushStep,
        rawInput: session.rawInput,
        request: session.request,
        runState: session.runState,
        runtimeState: session.runtimeState,
        steps: session.steps,
        toolResult: directFinal.toolResult
      })
    };
  }

  if (readString(decision.synthesize_instruction) === "direct") {
    return continueAfterPlanObservation({
      cycleRecord,
      kind: "plan_executed",
      message: "Plan executed; synthesize_instruction requested direct continuation.",
      output: createPlanResultOutput(execution.outputs),
      session
    });
  }

  return continueAfterPlanObservation({
    cycleRecord,
    kind: "plan_executed",
    message: "Plan executed; AI owns the next decision.",
    output: createPlanResultOutput(execution.outputs),
    session
  });
}

function findPlanDirectFinal(session, outputs) {
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    const directFinal = prepareDirectFinalResult(output);
    if (directFinal.kind === "ready") {
      return {
        directFinal,
        toolResult: output
      };
    }
    if (directFinal.kind === "invalid") {
      session.pushStep("direct-final-skipped", {
        actionName: "plan",
        cycle: session.runState.cycleCount,
        planIndex: index,
        reason: directFinal.reason
      });
    }
  }
  return null;
}

function continueAfterPlanObservation(options) {
  const { cycleRecord, kind, message, output, session } = options;
  const summary = readString(message) || kind;

  session.actionHistory.push({ actionName: "plan", kind, summary });
  if (kind === "plan_validation_error") {
    session.actionHistory.push({
      actionName: "plan",
      kind: "planner_invalid_action",
      summary
    });
  }
  session.runState.lastAction = "plan";
  session.runState.actState = {
    actionName: "plan",
    control: "continue",
    outputKind: output.kind || "object"
  };
  recordObservation(
    session.runState,
    session.pushStep,
    {
      actionName: "plan",
      kind: kind.includes("error") ? "error" : "continue",
      message: summary,
      output: cloneValue(output)
    },
    {
      actionName: "plan",
      cycle: session.runState.cycleCount,
      kind: kind.includes("error") ? "error" : "continue"
    }
  );
  completePhase(cycleRecord, session.pushStep, "act", {
    actionName: "plan",
    approvalStatus: "allow",
    outcome: "executed",
    resultKind: "continue"
  });
  startEvaluatePhase(session.runState, session.pushStep, null);
  session.runState.evaluationState = createEvaluationState({
    actionName: "plan",
    nextState: "continue",
    outcome: "continue",
    plannerState: session.runState.plannerState,
    researchContext: session.runState.researchContext,
    sessionContext: session.request && session.request.sessionContext,
    turnState: session.runState.turnState,
    toolContext: session.runState.toolContext
  });
  completeEvaluatePhase(cycleRecord, session.pushStep, {
    evaluationState: cloneValue(session.runState.evaluationState),
    nextPromptState: "continue",
    observationKind: session.runState.observation.kind,
    outcome: "continue"
  });

  return { done: false };
}

function createPlanErrorOutput(stage, error, plannerFeedback) {
  const output = {
    error,
    kind: "plan_result",
    ok: false,
    stage
  };
  if (plannerFeedback && typeof plannerFeedback === "object") {
    output.planner_feedback = cloneValue(plannerFeedback);
  }
  return output;
}

function createPlanResultOutput(results) {
  return {
    kind: "plan_result",
    ok: true,
    results: cloneValue(results)
  };
}

function readErrorMessage$1(error) {
  return normalizeThrownError(error).message;
}

// 2026-05-09 — `stripSynthesizePerActionIfSafe` deleted (was AGRUN-214o P5
// auto-strip recovery). Function silently dropped the AI's
// `synthesize_per_action: true` flag from validation-failed plans whose
// actions were all simple non-mutator tool calls, so the plan would pass
// re-validation. This was push-mode: runtime making the recovery choice
// for AI between the two valid paths the validation `detail` already
// listed ("provide section.prompt OR omit synthesize_per_action"). AI
// now picks; runtime never picks for AI.

// 2026-05-09 — `notePlanValidationFailure` deleted (was AGRUN-214o P5
// "loop-breaker"). Runtime no longer counts plan-validation failures
// per-code or injects directives prescribing AI recovery strategy.
// That logic was push-mode disguised as a defensive helper:
//   - Magic threshold (`>= 2`) was runtime deciding when AI is "stuck".
//   - Hardcoded English directive ("must not use plan envelope; emit
//     single action envelope") was runtime telling AI what to do next.
//   - Implicit assumption that single-action is always the right
//     recovery — runtime prescribing a specific recovery path.
//
// AI-first replacement: `validation.planner_feedback.detail` already
// reaches AI via `createPlanErrorOutput` → plan_result observation.
// AI sees the structured rejection reason and decides recovery
// (single action / ask_clarification / different plan / etc.). If
// lite-tier models loop on the same invalid plan, that's a model
// capability constraint hosts must address via `maxSteps`, `maxTokens`,
// or model selection — not by runtime injecting "you must do X".

export { executePlan };
