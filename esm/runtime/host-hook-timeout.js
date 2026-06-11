// Defense-in-depth timeout race for AWAITED host-supplied hooks that run at
// loop scope (outside the per-action execute race): onPlannerDecision,
// onToolResult, onInvalidPlannerOutput, onBeforeFinalize. A hung host hook
// must degrade to "hook ignored" — never freeze the run.
//
// Posture decided in cross-cutting-dispatch-matrix-2026-06-10.md §4, following
// the existing precedent in src/session/global-memory.js runHook(). Note the
// non-awaited onCheckpoint and everything inside action.execute() (including
// output guardrails run by workspace publish) are already covered: the former
// cannot block, the latter rides the per-action timeout race.
//
// Like the action race, this does not cancel the underlying work; a late
// settlement is absorbed by no-op handlers so it cannot reject unhandled or
// mutate caller state after the loop has moved on.

const DEFAULT_HOST_HOOK_TIMEOUT_MS = 10000;
const NOOP$1 = () => {};

function normalizeHostHookTimeoutMs(value) {
  return Number.isInteger(value) && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_HOST_HOOK_TIMEOUT_MS;
}

// invoke: () => Promise<any> — the hook call, closed over its arguments.
// Returns { ok: true, value } on success,
//         { ok: false, timedOut: true, message } on timeout,
//         { ok: false, timedOut: false, message } on throw.
async function callHostHookWithTimeout(invoke, options = {}) {
  const hookName = typeof options.hookName === "string" && options.hookName ? options.hookName : "host hook";
  const timeoutMs = normalizeHostHookTimeoutMs(options.timeoutMs);
  let timer = null;
  const hookCall = Promise.resolve().then(invoke);
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __hostHookTimeout: true }), timeoutMs);
    });
    const raced = await Promise.race([hookCall, timeout]);
    if (raced && raced.__hostHookTimeout === true) {
      hookCall.then(NOOP$1, NOOP$1);
      return { ok: false, timedOut: true, message: `${hookName} exceeded ${timeoutMs}ms; hook result ignored` };
    }
    return { ok: true, timedOut: false, value: raced };
  } catch (error) {
    return {
      ok: false,
      timedOut: false,
      message: error && error.message ? error.message : String(error)
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { callHostHookWithTimeout, normalizeHostHookTimeoutMs };
