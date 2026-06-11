import { mergeAbortSignals } from './abort-signal.js';
import { toRecord } from './utils.js';

function createRuntimeConfigLifecycle(initialOptions, normalize) {
  if (typeof normalize !== "function") {
    throw new Error("createRuntimeConfigLifecycle requires a normalize function.");
  }

  let currentOptions = toRecord(initialOptions);
  let currentConfig = normalize(currentOptions);
  let revision = 1;
  let reloadSequence = 0;
  let activeReload = null;
  let state = createState({
    status: "ready",
    revision
  });

  return {
    getConfig() {
      return currentConfig;
    },

    getState() {
      return { ...state };
    },

    async reload(nextOptionsOrLoader, reloadOptions) {
      const options = toRecord(reloadOptions);
      if (activeReload && options.abortPrevious !== false) {
        activeReload.abort();
      }

      const reloadId = ++reloadSequence;
      const controller = createAbortController();
      const signal = mergeAbortSignals([
        controller && controller.signal,
        options.signal
      ]);
      activeReload = controller;
      state = createState({
        pendingReloadId: reloadId,
        revision,
        status: "reloading"
      });

      try {
        const rawNextOptions = typeof nextOptionsOrLoader === "function"
          ? await nextOptionsOrLoader({
              currentConfig,
              currentOptions,
              revision,
              signal
            })
          : nextOptionsOrLoader;

        assertReloadStillActive(reloadId, reloadSequence, signal);
        const nextOptions = options.replace === true
          ? toRecord(rawNextOptions)
          : { ...currentOptions, ...toRecord(rawNextOptions) };
        const nextConfig = normalize(nextOptions);
        assertReloadStillActive(reloadId, reloadSequence, signal);

        currentOptions = nextOptions;
        currentConfig = nextConfig;
        revision += 1;
        if (activeReload === controller) {
          activeReload = null;
        }
        state = createState({
          revision,
          status: "ready"
        });
        return {
          applied: true,
          revision,
          state: { ...state }
        };
      } catch (error) {
        if (activeReload === controller) {
          activeReload = null;
        }
        const normalizedError = normalizeReloadError(error);
        if (reloadId === reloadSequence) {
          state = createState({
            lastError: {
              code: normalizedError.code || normalizedError.name || "CONFIG_RELOAD_FAILED",
              message: normalizedError.message
            },
            revision,
            status: "error"
          });
        }
        throw normalizedError;
      }
    }
  };
}

function createState(value) {
  return {
    lastError: value.lastError || null,
    pendingReloadId: value.pendingReloadId || null,
    revision: value.revision,
    status: value.status
  };
}

function createAbortController() {
  return typeof AbortController === "function"
    ? new AbortController()
    : null;
}

function assertReloadStillActive(reloadId, reloadSequence, signal) {
  if (signal && signal.aborted) {
    const error = new Error("Runtime config reload was aborted.");
    error.name = "AbortError";
    error.code = "CONFIG_RELOAD_ABORTED";
    throw error;
  }
  if (reloadId !== reloadSequence) {
    const error = new Error("Runtime config reload became stale.");
    error.code = "CONFIG_RELOAD_STALE";
    throw error;
  }
}

function normalizeReloadError(error) {
  if (error instanceof Error) {
    return error;
  }
  const message = typeof error === "string" && error.trim()
    ? error.trim()
    : "Runtime config reload failed.";
  return new Error(message);
}

export { createRuntimeConfigLifecycle };
