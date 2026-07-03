import { readRunTerminalKind } from './agent-events.js';
import { serializeError } from './errors.js';
import { createAsyncEventQueue } from './async-event-queue.js';

// AGRUN-442 — AsyncGenerator agent loop (slice 1: the public streaming engine).
//
// The agent loop is internally callback-driven (onStep / onStreamEvent push every
// event into runState.eventLedger, the SSOT). AGRUN-442 introduces the durable
// PUBLIC interface for that stream: an `async function*` a host iterates at its
// own pace, yielding a small closed set of typed AgentLoopEvents, and cancels by
// calling `generator.return()` (or breaking the `for await`), which aborts the run.
//
// This module is the bridge: it drives an existing run (runtime.run / session.run)
// while draining its callback emissions into an async queue, mapping each native
// step / stream event to one of the 7 typed events. The loop internals migrate
// onto this contract in later slices WITHOUT changing what a consumer sees — the
// generator interface is the SSOT, the implementation underneath is free to evolve.
//
// Dispatch-path parity (the two-doors rule): wired on BOTH runtime.runStream
// and session.runStream via this one shared module — never copy-pasted.


// The closed set of typed events the streaming engine yields. Unlike the ~104
// open-set step types, this is a deliberately small, stable vocabulary a
// streaming UI can switch on exhaustively.
const AGENT_LOOP_EVENT_TYPES = Object.freeze([
  "phase",
  "tool_start",
  "tool_result",
  "budget_warning",
  "repair_attempt",
  "circuit_breaker_tripped",
  "completed"
]);

const PHASE_STEP_PATTERN = /^phase-(observe|orient|decide|act|evaluate)-(started|completed)$/;

// A repair step is any planner/terminal repair signal. The runtime spells these
// many ways (planner-repair-*, terminal-repair-*, planner-empty-response-repair-
// signal, the bare "repair" step), so we match the shared `repair` token plus the
// two non-"repair"-spelled invalid-output signals.
function isRepairStepType(type) {
  return type === "repair"
    || type === "planner-invalid-action"
    || type === "planner-invalid-signal-escalated"
    || type.includes("repair");
}

function readStepDetail(step) {
  return step && typeof step === "object" && step.detail && typeof step.detail === "object"
    ? step.detail
    : null;
}

// Map a native step event (onStep surface) to a typed loop event, or null when the
// step is not one of the closed-set surfaces this engine projects.
function mapStepToLoopEvent(step) {
  if (!step || typeof step !== "object" || typeof step.type !== "string") return null;
  const type = step.type;
  const phaseMatch = PHASE_STEP_PATTERN.exec(type);
  if (phaseMatch) {
    return {
      type: "phase",
      phase: phaseMatch[1],
      detail: { phase: phaseMatch[1], transition: phaseMatch[2], info: readStepDetail(step) }
    };
  }
  if (type === "cost-budget-warning") {
    return { type: "budget_warning", phase: null, detail: readStepDetail(step) };
  }
  if (type === "planner-circuit-open") {
    return { type: "circuit_breaker_tripped", phase: null, detail: readStepDetail(step) };
  }
  if (isRepairStepType(type)) {
    return { type: "repair_attempt", phase: null, detail: { stepType: type, info: readStepDetail(step) } };
  }
  return null;
}

// Map a native stream event (onStreamEvent surface) to a typed loop event, or null.
// Tool lifecycle is the only stream surface this engine projects; provider text/
// reasoning deltas stay on the raw onToken/onStreamEvent surface for the host.
function mapStreamEventToLoopEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return null;
  const type = event.type;
  const detail = event.detail && typeof event.detail === "object" ? event.detail : null;
  if (type === "action-executing") {
    return { type: "tool_start", phase: "act", detail };
  }
  if (type === "action-executed" || type === "action-error" || type === "tool-result") {
    return { type: "tool_result", phase: "act", detail };
  }
  return null;
}

function makeCompletedEvent(outcome) {
  const result = outcome && outcome.result ? outcome.result : null;
  const error = (outcome && outcome.error)
    || (result && result.error)
    || null;
  const terminalKind = error ? readRunTerminalKind({ error }) : "done";
  return {
    type: "completed",
    phase: null,
    detail: {
      terminalKind,
      result,
      error: error ? serializeError(error) : null
    }
  };
}

function readCallerAbortSignal(runOptions) {
  const signal = runOptions && typeof runOptions === "object" ? runOptions.abortSignal : null;
  return signal && typeof signal.addEventListener === "function" ? signal : null;
}

/**
 * Drive a run as a typed AgentLoopEvent stream.
 *
 *   runner(hookedOptions, abortSignal) => Promise<result>
 *     The caller's run entry point (runtime.run / session.run). It MUST forward
 *     hookedOptions.onStep / .onStreamEvent / .abortSignal into the loop — both
 *     doors do (they read these via the standard run-option readers).
 *
 *   runOptions  the host's run options. The host's own onStep / onStreamEvent are
 *               preserved (called in addition to the stream's draining hooks); the
 *               host's abortSignal is chained so an external abort also ends the stream.
 *
 * Returns an async generator that yields typed events (the last is always
 * `completed`) and returns the run result. Calling generator.return() / breaking
 * the loop aborts the underlying run.
 */
async function* createRunEventStream(runner, runOptions) {
  if (typeof runner !== "function") {
    throw new Error("createRunEventStream: runner function is required");
  }
  const options = runOptions && typeof runOptions === "object" ? runOptions : {};
  const queue = createAsyncEventQueue();
  const controller = new AbortController();

  const callerSignal = readCallerAbortSignal(options);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const hostOnStep = typeof options.onStep === "function" ? options.onStep : null;
  const hostOnStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;

  const hookedOptions = {
    ...options,
    abortSignal: controller.signal,
    onStep(step) {
      if (hostOnStep) hostOnStep(step);
      const event = mapStepToLoopEvent(step);
      if (event) queue.push(event);
    },
    onStreamEvent(event) {
      if (hostOnStreamEvent) hostOnStreamEvent(event);
      const mapped = mapStreamEventToLoopEvent(event);
      if (mapped) queue.push(mapped);
    }
  };

  let settledResult = null;
  // Start the run. Attach settle handlers BEFORE the first await so an early
  // generator.return() can never surface an unhandled rejection.
  const runPromise = Promise.resolve()
    .then(() => runner(hookedOptions, controller.signal))
    .then(
      (result) => { settledResult = result || null; queue.push(makeCompletedEvent({ result })); },
      (error) => { queue.push(makeCompletedEvent({ error })); }
    )
    .then(() => queue.close(), () => queue.close());

  try {
    while (true) {
      const next = await queue.next();
      if (next.done) break;
      yield next.value;
    }
  } finally {
    // Consumer stopped early (break / .return()) — cancel the underlying run.
    controller.abort();
    await runPromise.catch(() => {});
  }

  return settledResult;
}

export { AGENT_LOOP_EVENT_TYPES, createRunEventStream, mapStepToLoopEvent, mapStreamEventToLoopEvent };
