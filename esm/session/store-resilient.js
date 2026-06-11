import { createInMemorySessionStore } from './store-memory.js';

const STORE_METHODS = [
  "createSession",
  "getSession",
  "saveSession",
  "appendMessage",
  "updateMessage",
  "readMessages",
  "getSummary",
  "writeSummary",
  "listSummaries",
  "appendMemory",
  "readMemory",
  "appendGlobalMemory",
  "readAllGlobalMemory",
  "deleteGlobalMemory",
  "updateGlobalMemory",
  "clearAllGlobalMemory"
];

const FATAL_ERROR_NAMES = new Set([
  "QuotaExceededError",
  "InvalidStateError",
  "UnknownError",
  "SecurityError",
  "NotAllowedError",
  "VersionError"
]);

const FATAL_MESSAGE_PATTERN = /quota|storage|disk|not allowed|private/i;

function createResilientSessionStore(primaryStore, options) {
  const onDegraded = options && typeof options.onStorageDegraded === "function"
    ? options.onStorageDegraded
    : null;

  const fallback = createInMemorySessionStore();
  let activeStore = primaryStore;
  let degraded = false;

  function degrade(error, method) {
    if (degraded) return;
    degraded = true;
    activeStore = fallback;
    if (onDegraded) {
      try {
        onDegraded({
          reason: (error && error.name) || "unknown",
          message: (error && error.message) || "",
          method
        });
      } catch (_) {
        // Never let telemetry hook break the store.
      }
    }
  }

  function wrap(method) {
    return async (...args) => {
      if (activeStore === fallback) {
        return fallback[method](...args);
      }
      try {
        return await activeStore[method](...args);
      } catch (error) {
        if (isFatalStorageError(error)) {
          degrade(error, method);
          return fallback[method](...args);
        }
        throw error;
      }
    };
  }

  const wrapped = {};
  for (const method of STORE_METHODS) {
    wrapped[method] = wrap(method);
  }

  wrapped.isDegraded = () => degraded;

  return wrapped;
}

function isFatalStorageError(error) {
  if (!error) return false;
  const name = typeof error.name === "string" ? error.name : "";
  if (FATAL_ERROR_NAMES.has(name)) {
    return true;
  }
  const message = typeof error.message === "string" ? error.message : "";
  return FATAL_MESSAGE_PATTERN.test(message);
}

export { createResilientSessionStore, isFatalStorageError };
