const NOOP_LOGGER = Object.freeze({
  log() {},
  enabled: false
});

function createDebugLogger(debug) {
  if (!debug) {
    return NOOP_LOGGER;
  }

  if (typeof debug === "function") {
    return {
      log(label, data) {
        try {
          debug({ label, ...data, timestamp: Date.now() });
        } catch { /* consumer error */ }
      },
      enabled: true
    };
  }

  return {
    log(label, data) {
      if (data && typeof data === "object") {
        console.log(`[agrun:debug] ${label}`, data);
      } else {
        console.log(`[agrun:debug] ${label}`);
      }
    },
    enabled: true
  };
}

function normalizeDebug(value) {
  if (typeof value === "function") return value;
  if (value === true || value === "verbose") return true;
  return false;
}

export { createDebugLogger, normalizeDebug };
