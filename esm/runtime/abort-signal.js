// AGRUN-CALLER-ABORT — Caller cancellation contract.
//
// SSOT for plumbing a caller-supplied AbortSignal from `session.run(input,
// { abortSignal })` down into every internal LLM call. Browser providers
// merge this signal with the per-request timeout signal so BOTH can fire.
//
// Contract:
//  - `mergeAbortSignals([a, b, ...])` returns one AbortSignal that fires
//    when ANY input fires. Falsy entries are ignored. Returns null if all
//    entries are falsy.
//  - `createAbortError(reason)` returns an Error with `name === "AbortError"`
//    so callers can distinguish user-cancellation from real failures via
//    the standard DOMException-like contract.
//  - `isAbortSignalAborted(signal)` is a null-safe `signal?.aborted` check.
//  - `wrapHookForAbort(fn, signal)` returns a wrapped callback that becomes
//    a no-op once `signal` aborts. Suppresses post-abort `onStep` / `onToken`
//    so the chat bubble stops mutating the moment the user clicks Stop.

function mergeAbortSignals$1(signals) {
  const real = (Array.isArray(signals) ? signals : []).filter(isAbortSignal$1);
  if (real.length === 0) return null;
  if (real.length === 1) return real[0];

  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    try {
      return AbortSignal.any(real);
    } catch (_ignored) {
      // Fall through to manual merge.
    }
  }

  const controller = new AbortController();
  const onAbort = (event) => {
    if (controller.signal.aborted) return;
    const reason = event && event.target && "reason" in event.target ? event.target.reason : undefined;
    try {
      controller.abort(reason);
    } catch (_ignored) {
      controller.abort();
    }
  };

  for (const sig of real) {
    if (sig.aborted) {
      onAbort({ target: sig });
      break;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

function createAbortError$1(reason) {
  const message = typeof reason === "string" && reason.length > 0
    ? reason
    : "Run aborted by caller.";
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortSignalAborted(signal) {
  return Boolean(signal && signal.aborted === true);
}

function wrapHookForAbort(fn, signal) {
  if (typeof fn !== "function") return fn;
  if (!isAbortSignal$1(signal)) return fn;
  return function abortAwareHook(...args) {
    if (signal.aborted) return undefined;
    return fn.apply(this, args);
  };
}

function isAbortSignal$1(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.aborted !== "boolean") return false;
  if (typeof value.addEventListener !== "function") return false;
  return true;
}

export { createAbortError$1 as createAbortError, isAbortSignalAborted, mergeAbortSignals$1 as mergeAbortSignals, wrapHookForAbort };
