import { readString } from './semantic-json.js';

// AGRUN-248-D — planner recovery is now planner-owned. Runtime records
// invalid/empty planner output as a repair signal for the next planner
// cycle; it does not synthesize web_search or any other action.
//
// AGRUN-486 (audit H8) — the recovery budget is now LIVE again, but in a
// narrower role: it bounds how many consecutive cycles the runtime will spend
// the extra `requestPlannerEnvelopeRepair` LLM call (the "N+1" repair) before
// giving up and letting the null decision surface so the planner re-plans on
// its own. noteRecoveryAttempt ticks once per attempted-and-failed repair;
// isRecoveryBudgetExhausted gates the next repair; resetRecoveryBudget clears
// the streak the moment a valid decision is produced (so a long session is
// never starved by an early bad turn — a good turn resets it). It is NOT a
// per-cycle-reset counter anymore (that reset is what made it dead code).


const MAX_RECOVERY_RETRIES = 2;

function noteRecoveryAttempt(runState, signalKind) {
  if (!runState || typeof runState !== "object") return null;
  const recoveryState = ensureRecoveryState(runState);
  recoveryState.retries = (typeof recoveryState.retries === "number" ? recoveryState.retries : 0) + 1;
  recoveryState.lastSignal = typeof signalKind === "string" && signalKind ? signalKind : recoveryState.lastSignal;
  if (recoveryState.retries >= MAX_RECOVERY_RETRIES) {
    recoveryState.exhaustedAt = recoveryState.exhaustedAt || {
      cycle: typeof runState.cycleCount === "number" ? runState.cycleCount : null,
      retries: recoveryState.retries,
      signal: recoveryState.lastSignal,
      timestamp: new Date().toISOString()
    };
  }
  return recoveryState;
}

function isRecoveryBudgetExhausted(runState) {
  const recoveryState = runState && runState.recoveryState;
  if (!recoveryState) return false;
  return typeof recoveryState.retries === "number" && recoveryState.retries >= MAX_RECOVERY_RETRIES;
}

// AGRUN-486 (audit H8) — clear the repair-budget streak. Called the moment the
// planner produces a VALID decision so the budget only ever reflects the
// CURRENT run of back-to-back failed-repair cycles, never a lifetime tally.
function resetRecoveryBudget(runState) {
  if (!runState || typeof runState !== "object") return;
  if (!runState.recoveryState || typeof runState.recoveryState !== "object") return;
  runState.recoveryState.retries = 0;
  runState.recoveryState.lastSignal = null;
  runState.recoveryState.exhaustedAt = null;
}

function buildPlannerRepairSignal(options = {}) {
  const count = Number.isInteger(options.count) && options.count > 0
    ? options.count
    : 0;
  const reason = readString(options.reason) || "invalid_planner_output";
  const source = readString(options.source) || "planner";
  const forbiddenMoves = Array.isArray(options.forbiddenMoves)
    ? options.forbiddenMoves.map(readString).filter(Boolean)
    : [];
  if (count > 2 && !forbiddenMoves.includes("repeat_invalid_envelope")) {
    forbiddenMoves.push("repeat_invalid_envelope");
  }
  return {
    active: count > 0,
    count,
    escalation: count > 2 ? "hard_veto" : "advisory",
    forbiddenMoves: forbiddenMoves.slice(0, 8),
    lastResponsePreview: readString(options.lastResponsePreview).slice(0, 600),
    reason,
    repairMode: "planner_owned_retry",
    requiredEnvelope: "valid planner JSON envelope only",
    retryDirective: "Return one valid planner JSON envelope. The runtime will not synthesize a fallback action.",
    source
  };
}

function ensureRecoveryState(runState) {
  if (!runState.recoveryState || typeof runState.recoveryState !== "object") {
    runState.recoveryState = { retries: 0, lastSignal: null, exhaustedAt: null };
  }
  return runState.recoveryState;
}

export { MAX_RECOVERY_RETRIES, buildPlannerRepairSignal, isRecoveryBudgetExhausted, noteRecoveryAttempt, resetRecoveryBudget };
