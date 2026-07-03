// AGRUN-568 — per-run observed provider latency (the DeepSeek slowness root
// cause, diagnosed live 2026-07-02).
//
// Why this exists:
//   The planner/finalize provider deadline was a fixed budget (60s default,
//   120s/180s autopilot — provider-timeout.js) that assumes OpenAI-class
//   latency. DeepSeek generates at ~59 tok/s and burns hidden reasoning
//   tokens on every call, so a workspace-drafting planner cycle (which emits
//   the full article content inside the JSON envelope) legitimately runs
//   30-90s+. Observed failure: an 89.3s SUCCESSFUL cycle followed by a cycle
//   that hit the fixed 120s deadline, retried on the same 120s budget, and
//   failed the whole run (exact captured gap: 120 + 0.5 backoff + 120 =
//   240.5s).
//
// Why observed latency (not a per-provider table):
//   A hardcoded "DeepSeek gets 300s" row is exactly the kind of runtime
//   opinion the no-hardcode rule forbids, and it goes stale the day the
//   provider speeds up. The run's own successful calls are ground truth:
//   if a cycle just took 89s, the next cycle's budget must be at least
//   comfortably above 89s. Fast providers never grow the budget because
//   their observed calls stay far below the default deadline.
//
// Contract:
//   - Record ONLY successful calls. A timed-out call's duration equals the
//     budget itself; recording it would ratchet the budget upward on pure
//     failure. Failure-driven growth is handled separately by the retry
//     escalation in provider.js (a timeout is evidence the call needs MORE
//     than the current budget, so the retry doubles it).
//   - The slot is per-run tuning state, deliberately NOT persisted by
//     snapshotRunState/exportState: after a crash-resume the first call
//     re-learns latency from scratch, which is correct (the resume may run
//     hours later under different provider load).
//   - Defensive reads everywhere: runState may predate this slot.

const MAX_TRACKED_SAMPLES = 50;

function recordProviderCallDuration(runState, durationMs) {
  if (!runState || typeof runState !== "object") return;
  const value = readPositiveInteger$e(durationMs);
  if (!value) return;
  const slot = runState.providerLatency && typeof runState.providerLatency === "object"
    ? runState.providerLatency
    : { count: 0, lastMs: null, maxMs: null };
  slot.count = Math.min(MAX_TRACKED_SAMPLES, (readPositiveInteger$e(slot.count) || 0) + 1);
  slot.lastMs = value;
  slot.maxMs = Math.max(readPositiveInteger$e(slot.maxMs) || 0, value);
  runState.providerLatency = slot;
}

function readMaxObservedProviderLatencyMs(runState) {
  const slot = runState && typeof runState === "object" ? runState.providerLatency : null;
  if (!slot || typeof slot !== "object") return null;
  return readPositiveInteger$e(slot.maxMs);
}

function readPositiveInteger$e(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export { readMaxObservedProviderLatencyMs, recordProviderCallDuration };
