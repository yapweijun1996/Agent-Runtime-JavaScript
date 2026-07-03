import { cloneValue } from './utils.js';
import { readString } from './semantic-json.js';

function maybeFinalizeMaxStepsContinuation(session) {
  if (!session || !session.runState) return null;
  const todoState = session.runState.todoState;
  const activeItem = findActiveTodoItem(todoState);
  const pendingCount = countPendingItems(todoState);

  if (!activeItem && pendingCount === 0) {
    return null;
  }

  const output = createContinuationOutput({
    activeItem,
    maxSteps: session.runtimeConfig && session.runtimeConfig.maxSteps,
    pendingCount,
    todoState
  });
  session.pushStep("long-run-continuation-required", {
    activeItemId: activeItem ? activeItem.id : null,
    maxSteps: session.runtimeConfig && session.runtimeConfig.maxSteps,
    pendingCount
  });

  session.runState.status = "completed";
  session.runState.finalAnswerSource = "continuation_required";
  session.runState.terminalizedBy = "max_steps_continuation";
  session.runState.longRunContinuation = {
    activeItemId: activeItem ? activeItem.id : null,
    reason: "max_steps",
    remainingItemCount: (activeItem ? 1 : 0) + pendingCount
  };
  session.runState.evaluationState = {
    actionName: "continuation_required",
    nextState: "continue",
    outcome: "paused"
  };
  session.runState.observation = {
    kind: "continue",
    output: cloneValue(output),
    source: "max_steps_continuation"
  };
  session.pushStep("observation-recorded", {
    cycle: session.runState.cycleCount,
    kind: "continue",
    source: "max_steps_continuation"
  });

  return finalizeContinuationResult(session, output);
}

function createContinuationOutput(options) {
  const activeLabel = readString(options.activeItem && options.activeItem.label) || "the current task";
  const remaining = (options.activeItem ? 1 : 0) + options.pendingCount;
  const goal = readString(options.todoState && options.todoState.goal);
  const maxSteps = Number.isInteger(options.maxSteps) ? options.maxSteps : null;
  const text = [
    "I paused this long-running task to preserve direction and progress.",
    "",
    goal ? `Goal: ${goal}` : null,
    `Current step: ${activeLabel}`,
    `Remaining work items: ${remaining}`,
    maxSteps ? `Reason: reached this turn's ${maxSteps}-step runtime budget.` : "Reason: reached this turn's runtime budget.",
    "",
    "The task will resume automatically from the current step."
  ].filter(Boolean).join("\n");

  return {
    kind: "continuation_required",
    reason: "max_steps",
    text,
    todoState: cloneValue(options.todoState || null)
  };
}

function findActiveTodoItem(todoState) {
  if (!todoState || todoState.status !== "active" || !Array.isArray(todoState.items)) {
    return null;
  }
  return todoState.items.find((item) => (
    item && item.id === todoState.activeItemId && item.status === "active"
  )) || todoState.items.find((item) => item && item.status === "active") || null;
}

function countPendingItems(todoState) {
  if (!todoState || todoState.status !== "active" || !Array.isArray(todoState.items)) {
    return 0;
  }
  return todoState.items.filter((item) => item && item.status === "pending").length;
}

function finalizeContinuationResult(session, output) {
  const memoryEntriesAdded = Array.isArray(session.memoryEntriesAdded) ? session.memoryEntriesAdded : [];
  const runState = session.runState;
  const result = {
    failedTools: Array.isArray(runState.failedTools) ? cloneValue(runState.failedTools) : [],
    finalAnswerSource: runState.finalAnswerSource || null,
    input: session.rawInput,
    mode: runState.mode || "tool_loop",
    normalizedInput: cloneValue(session.normalizedInput),
    selectedSkill: runState.selectedSkill || null,
    output: cloneValue(output),
    runState: cloneValue(runState),
    memoryEntriesAdded: cloneValue(memoryEntriesAdded),
    steps: cloneValue(session.steps),
    error: null
  };

  if (session.runtimeState && typeof session.runtimeState === "object") {
    session.runtimeState.lastRun = {
      runId: runState.runId,
      status: runState.status,
      stepCount: runState.stepCount || 0,
      cycleCount: runState.cycleCount || 0,
      mode: runState.mode || "tool_loop",
      turnCount: runState.turnCount || runState.cycleCount || 0,
      maxSteps: runState.maxSteps || (session.runtimeConfig && session.runtimeConfig.maxSteps) || null,
      phase: runState.phase || null,
      selectedSkill: runState.selectedSkill || null,
      lastAction: cloneValue(runState.lastAction || null),
      pendingApproval: cloneValue(runState.pendingApproval || null),
      finalAnswerSource: runState.finalAnswerSource || null,
      observation: cloneValue(runState.observation || null),
      error: null,
      memoryEntriesAdded: memoryEntriesAdded.length,
      oodaeCycles: runState.oodae && Array.isArray(runState.oodae.cycles) ? runState.oodae.cycles.length : 0
    };
  }

  return result;
}

export { maybeFinalizeMaxStepsContinuation };
