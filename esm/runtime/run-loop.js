import { isAbortSignalAborted, createAbortError } from './abort-signal.js';
import { runApprovalResolution } from './approval.js';
import { isApprovalResolutionRequest } from './approval-state.js';
import { createPushStep } from './context.js';
import { createStructuredError, normalizeThrownError, ERROR_CODES } from './errors.js';
import { normalizeInput } from './input.js';
import { isToolLoopProviderRequest, normalizeToolLoopProviderRequest } from './provider.js';
import { attachProviderError, createProviderErrorStepDetail } from './provider-error.js';
import { finalizeResult } from './result.js';
import { runActionLoop } from './action-loop.js';
import { createRunState, readSessionLineage } from './state.js';

// ADR-0037 — Self-reference key. action-loop-session.js reads
// `options.spawnSubagentRunLoop` to construct the spawn_subagent
// capability without importing this module (avoids a cycle).
const SPAWN_SUBAGENT_RUNLOOP_KEY = "spawnSubagentRunLoop";

async function runLoop(options) {
  // AGRUN-CALLER-ABORT — Fail fast before doing any work if the caller
  // already aborted. Symmetric counterpart to context.signal (runtime →
  // hook timeout) — this is caller → runtime cancellation.
  if (isAbortSignalAborted(options.callerAbortSignal)) {
    throw createAbortError("Run aborted by caller before runLoop started.");
  }

  // ADR-0037 — Thread a self-reference of runLoop down so the
  // spawn_subagent capability constructor can recursively invoke us
  // for the child run. Set once at the top; downstream callers pass
  // it through unchanged.
  const enrichedOptions = options[SPAWN_SUBAGENT_RUNLOOP_KEY]
    ? options
    : { ...options, [SPAWN_SUBAGENT_RUNLOOP_KEY]: runLoop };

  const normalizedInput = enrichedOptions.normalizedInput || normalizeInput(enrichedOptions.rawInput);

  if (isApprovalResolutionRequest(enrichedOptions.rawInput)) {
    return runApprovalResolution({
      ...enrichedOptions,
      normalizedInput
    });
  }

  // AGRUN-274d-4 — Legacy skill-loop branch deleted. The `runSkillLoop`
  // / `router.js` / `skill-probe.js` infrastructure is gone, along with
  // the `legacySkillLoop` config option. Non-tool-loop input is now
  // rejected unconditionally with INVALID_RUN_INPUT. Hosts that
  // previously routed `string` or `{type:"web_search",…}` inputs
  // through the canHandle router must either pass a tool-loop provider
  // request (`{prompt, provider, apiKey, model, …}`) so the
  // action-loop drives the planner, or register their capability as a
  // `customAction` via `defineAction`.
  const providerRegistry = enrichedOptions.runtimeConfig
    && enrichedOptions.runtimeConfig.providerRegistry;
  if (!isToolLoopProviderRequest(enrichedOptions.rawInput, providerRegistry)) {
    return createInvalidRunInputResult(enrichedOptions, normalizedInput);
  }

  try {
    return runActionLoop({
      ...enrichedOptions,
      normalizedInput,
      request: normalizeToolLoopProviderRequest(enrichedOptions.rawInput, providerRegistry)
    });
  } catch (error) {
    return createProviderInputFailureResult(enrichedOptions, normalizedInput, error);
  }
}

function createProviderInputFailureResult(options, normalizedInput, cause) {
  const runState = createRunState(
    options.runId,
    options.runtimeConfig.maxSteps,
    readSessionLineage(options),
    { runtimeEventBus: options.runtimeEventBus }
  );
  const steps = [];
  const pushStep = createPushStep(steps, runState, options.onStep);
  attachProviderError(cause, readInputProvider(options.rawInput));
  const error = createStructuredError(
    readProviderErrorCode(cause),
    normalizeThrownError(cause).message,
    null,
    cause
  );
  const providerError = createProviderErrorStepDetail(cause, readInputProvider(options.rawInput));

  runState.mode = "tool_loop";
  runState.phase = "evaluate";
  pushStep("run-started", {
    inputType: normalizedInput.type,
    maxSteps: options.runtimeConfig.maxSteps,
    mode: "tool_loop"
  });
  pushStep("provider-input-invalid", {
    code: error.code,
    details: providerError,
    message: error.message
  });
  runState.status = "failed";
  runState.error = error;
  runState.observation = {
    code: error.code,
    kind: "error",
    message: error.message
  };

  return finalizeResult(
    options.rawInput,
    normalizedInput,
    runState,
    null,
    [],
    steps,
    options.runtimeState
  );
}

function readInputProvider(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.provider === "string" && value.provider.trim()) return value.provider.trim();
  if (typeof value.providerId === "string" && value.providerId.trim()) return value.providerId.trim();
  return null;
}

function readProviderErrorCode(cause) {
  if (cause && typeof cause === "object" && typeof cause.code === "string" && cause.code.length > 0) {
    return cause.code;
  }

  return ERROR_CODES.INVALID_PROVIDER_REQUEST;
}

function createInvalidRunInputResult(options, normalizedInput) {
  const runState = createRunState(
    options.runId,
    options.runtimeConfig.maxSteps,
    readSessionLineage(options),
    { runtimeEventBus: options.runtimeEventBus }
  );
  const steps = [];
  const pushStep = createPushStep(steps, runState, options.onStep);
  const error = createStructuredError(
    ERROR_CODES.INVALID_RUN_INPUT,
    "runtime.run() requires a tool-loop provider request (prompt + provider + apiKey + model) or an approval resolution. The legacy skill-loop router was removed in AGRUN-274d.",
    null,
    null
  );

  runState.mode = "tool_loop";
  runState.phase = "evaluate";
  pushStep("run-started", {
    inputType: normalizedInput.type,
    maxSteps: options.runtimeConfig.maxSteps,
    mode: "tool_loop"
  });
  pushStep("invalid-run-input", {
    code: error.code,
    message: error.message
  });
  runState.status = "failed";
  runState.error = error;
  runState.observation = {
    code: error.code,
    kind: "error",
    message: error.message
  };

  return finalizeResult(
    options.rawInput,
    normalizedInput,
    runState,
    null,
    [],
    steps,
    options.runtimeState
  );
}

export { runLoop };
