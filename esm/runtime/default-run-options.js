import { mergeAbortSignals } from './abort-signal.js';

const HOOK_KEYS = [
  "onBeforeFinalize",
  "onCheckpoint",
  "onInvalidPlannerOutput",
  "onPlannerDecision",
  "onReasoning",
  "onStep",
  "onStreamEvent",
  "onToken",
  "onToolResult"
];

function normalizeDefaultRunOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return pickRunOptions(value);
}

function mergeRunOptions(defaultOptions, runOptions) {
  const defaults = normalizeDefaultRunOptions(defaultOptions);
  const local = runOptions && typeof runOptions === "object" && !Array.isArray(runOptions)
    ? pickRunOptions(runOptions)
    : {};
  const merged = { ...defaults, ...local };

  for (const key of HOOK_KEYS) {
    merged[key] = mergeHook(defaults[key], local[key], key);
    if (typeof merged[key] !== "function") {
      delete merged[key];
    }
  }

  const disabledActions = mergeDisabledActions(defaults.disabledActions, local.disabledActions);
  if (disabledActions.length > 0) {
    merged.disabledActions = disabledActions;
  } else {
    delete merged.disabledActions;
  }

  const plannerDirectives = mergePlannerDirectives(defaults, local);
  if (plannerDirectives.length > 0) {
    merged.plannerDirectives = plannerDirectives;
  } else {
    delete merged.plannerDirectives;
  }
  if (local.plannerDirectivesMode === "replace") {
    merged.plannerDirectivesMode = "replace";
  } else if (defaults.plannerDirectivesMode === "replace" && !Array.isArray(local.plannerDirectives)) {
    merged.plannerDirectivesMode = "replace";
  } else {
    delete merged.plannerDirectivesMode;
  }

  const abortSignal = mergeAbortSignals([defaults.abortSignal, local.abortSignal]);
  if (abortSignal) {
    merged.abortSignal = abortSignal;
  } else {
    delete merged.abortSignal;
  }

  return merged;
}

function pickRunOptions(value) {
  const output = {};
  for (const key of HOOK_KEYS) {
    if (typeof value[key] === "function") {
      output[key] = value[key];
    }
  }
  if (Array.isArray(value.disabledActions)) {
    output.disabledActions = value.disabledActions.slice();
  }
  if (Array.isArray(value.plannerDirectives)) {
    output.plannerDirectives = normalizePlannerDirectives$1(value.plannerDirectives);
  }
  if (value.plannerDirectivesMode === "append" || value.plannerDirectivesMode === "replace") {
    output.plannerDirectivesMode = value.plannerDirectivesMode;
  }
  if (isAbortSignal(value.abortSignal)) {
    output.abortSignal = value.abortSignal;
  }
  // Crash-recovery resume (P2): the output of importState. Per-call only
  // (local overrides any default via the {...defaults, ...local} merge).
  if (value.resumeState && typeof value.resumeState === "object" && !Array.isArray(value.resumeState)) {
    output.resumeState = value.resumeState;
  }
  return output;
}

function mergeHook(defaultHook, localHook, key) {
  if (typeof defaultHook !== "function") return localHook;
  if (typeof localHook !== "function") return defaultHook;
  if (key === "onStep" || key === "onToken" || key === "onReasoning" || key === "onStreamEvent" || key === "onCheckpoint") {
    return (...args) => {
      // C2 (audit 2026-06-10) — defaultHook's return value is discarded here (the
      // merged hook returns only localHook's result). If a host registered an
      // ASYNC default hook that rejects, that Promise would be unhandled. Absorb a
      // late async rejection. localHook's result is returned for the emit site to
      // handle (emitCheckpoint applies the same guard).
      const defaultResult = defaultHook(...args);
      if (defaultResult && typeof defaultResult.then === "function") {
        defaultResult.then(undefined, () => {});
      }
      return localHook(...args);
    };
  }
  if (key === "onBeforeFinalize") {
    return async (...args) => {
      const defaultResult = await defaultHook(...args);
      if (defaultResult && typeof defaultResult === "object" && defaultResult.continue === true) {
        return defaultResult;
      }
      const localResult = await localHook(...args);
      return localResult && typeof localResult === "object" ? localResult : defaultResult;
    };
  }
  if (key === "onInvalidPlannerOutput") {
    return async (...args) => {
      const defaultResult = await defaultHook(...args);
      if (defaultResult && typeof defaultResult === "object") {
        return defaultResult;
      }
      const localResult = await localHook(...args);
      return localResult && typeof localResult === "object" ? localResult : defaultResult;
    };
  }
  return async (value, ...args) => {
    const defaultResult = await defaultHook(value, ...args);
    const nextValue = defaultResult && typeof defaultResult === "object" ? defaultResult : value;
    const localResult = await localHook(nextValue, ...args);
    return localResult && typeof localResult === "object" ? localResult : defaultResult;
  };
}

function mergeDisabledActions(defaultActions, localActions) {
  return Array.from(new Set([
    ...(Array.isArray(defaultActions) ? defaultActions : []),
    ...(Array.isArray(localActions) ? localActions : [])
  ].filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())));
}

function mergePlannerDirectives(defaultOptions, localOptions) {
  const defaults = normalizePlannerDirectives$1(defaultOptions && defaultOptions.plannerDirectives);
  const local = normalizePlannerDirectives$1(localOptions && localOptions.plannerDirectives);
  if (localOptions && localOptions.plannerDirectivesMode === "replace") {
    return local;
  }
  if (
    defaultOptions &&
    defaultOptions.plannerDirectivesMode === "replace" &&
    (!localOptions || !Array.isArray(localOptions.plannerDirectives))
  ) {
    return defaults;
  }
  return [...defaults, ...local];
}

function normalizePlannerDirectives$1(value) {
  return (Array.isArray(value) ? value : [])
    .filter((line) => typeof line === "string" && line.trim())
    .map((line) => line.trim());
}

function isAbortSignal(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.aborted !== "boolean") return false;
  if (typeof value.addEventListener !== "function") return false;
  return true;
}

export { mergeRunOptions, normalizeDefaultRunOptions };
