import { recordObservation, startEvaluatePhase, completeEvaluatePhase, finishRun } from './finalizer.js';
import { ASK_CLARIFICATION_ACTION } from './action-names.js';
import { completePhase } from './oodae.js';
import { createEvaluationState } from './task-state.js';
import { syncPromptInquiryContext } from './inquiry-context-resolution.js';
import { observeTodoStateOnTerminal } from './todo-state-finalize-sync.js';
import { cloneValue } from './utils.js';

function handleActionResult(options) {
  const {
    actionName,
    actionResult,
    cycleRecord,
    memoryEntriesAdded,
    normalizedInput,
    output,
    pushStep,
    rawInput,
    request,
    runState,
    runtimeState,
    steps
  } = options;

  recordObservation(
    runState,
    pushStep,
    {
      actionName,
      kind: actionResult.control === "continue" ? "continue" : "success",
      output: cloneValue(actionResult.output)
    },
    {
      actionName,
      cycle: runState.cycleCount,
      kind: actionResult.control === "continue" ? "continue" : "success"
    }
  );
  completePhase(
    cycleRecord,
    pushStep,
    "act",
    {
      actionName,
      approvalStatus: "allow",
      outcome: "executed",
      resultKind: actionResult.control
    }
  );
  startEvaluatePhase(runState, pushStep, null);

  if (actionResult.control === "continue") {
    runState.evaluationState = createEvaluationState({
      actionName,
      nextState: "continue",
      outcome: "continue",
      plannerState: runState.plannerState,
      researchContext: runState.researchContext,
      sessionContext: request && request.sessionContext,
      turnState: runState.turnState,
      toolContext: runState.toolContext
    });
    completeEvaluatePhase(cycleRecord, pushStep, {
      evaluationState: cloneValue(runState.evaluationState),
      nextPromptState: "continue",
      observationKind: runState.observation.kind,
      outcome: "continue"
    });
    return {
      done: false
    };
  }

  syncPromptInquiryContext(runState, request, {
    preservePendingClarification: actionName === ASK_CLARIFICATION_ACTION
  });
  runState.status = "completed";
  runState.finalAnswerSource = actionName;
  if (observeTodoStateOnTerminal(runState, { source: actionName })) {
    pushStep("todo-state-terminal-observed", {
      actionName,
      cycle: runState.cycleCount,
      observation: cloneValue(runState.todoTerminalObservation || null),
      source: actionName
    });
  }
  runState.evaluationState = createEvaluationState({
    actionName,
    nextState: "stop",
    outcome: "complete",
    plannerState: runState.plannerState,
    researchContext: runState.researchContext,
    sessionContext: request && request.sessionContext,
    turnState: runState.turnState,
    toolContext: runState.toolContext
  });
  completeEvaluatePhase(cycleRecord, pushStep, {
    evaluationState: cloneValue(runState.evaluationState),
    nextPromptState: "stop",
    observationKind: runState.observation.kind,
    outcome: "complete",
    outputKind: output.kind || "object"
  });

  return {
    done: true,
    result: finishRun({
      rawInput,
      normalizedInput,
      runState,
      output,
      memoryEntriesAdded,
      steps,
      runtimeState
    })
  };
}

export { handleActionResult };
