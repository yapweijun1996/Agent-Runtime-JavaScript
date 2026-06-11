import { FINALIZE_CANDIDATE_ACTION } from './kernel-terminal-actions.js';

// Composite session-level budget for long-running tasks. Replaces the
// per-action-name consecutive failure guard with four independent caps
// so that alternating-tool failures and invalid-decision storms can no
// longer keep the loop alive.
//
// Design doc: agrun_docs/long-running-multi-topic-tasks.md (P0, AGRUN-141).


const DEFAULT_BUDGET = Object.freeze({
  totalFailures: 5,
  invalidDecisions: 3,
  sameFingerprintRepeats: 2,
  cyclesSinceProgress: 5
});

function normalizeBudgetConfig(value) {
  if (value === false) {
    return { enabled: false, ...DEFAULT_BUDGET };
  }
  const base = { enabled: true, ...DEFAULT_BUDGET };
  if (value == null || typeof value !== "object") return base;
  return {
    enabled: value.enabled !== false,
    totalFailures: readPositiveInt(value.totalFailures, DEFAULT_BUDGET.totalFailures),
    invalidDecisions: readPositiveInt(value.invalidDecisions, DEFAULT_BUDGET.invalidDecisions),
    sameFingerprintRepeats: readPositiveInt(
      value.sameFingerprintRepeats,
      DEFAULT_BUDGET.sameFingerprintRepeats
    ),
    cyclesSinceProgress: readPositiveInt(
      value.cyclesSinceProgress,
      DEFAULT_BUDGET.cyclesSinceProgress
    )
  };
}

function readPositiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createSessionBudgetState() {
  return {
    fingerprintCounts: Object.create(null),
    cyclesSinceProgress: 0,
    lastProgressMarker: 0,
    progressMarker: 0,
    lastProgressReason: null,
    pendingFinalizeBreach: null,
    breachRecorded: null
  };
}

// Progress marking for a successfully executed action — shared by BOTH
// dispatch paths (single action + plan batch) so plan-heavy runs tick the
// same no-progress counters. Moved here from action-loop-action.js
// (cross-cutting-dispatch-matrix-2026-06-10.md §3).
function markActionProgress(runState, actionName, output) {
  if (!shouldMarkActionProgress(actionName, output)) return;
  markSessionProgress(runState, {
    actionName,
    reason: "action_success"
  });
  markSessionFingerprintProgress(runState, actionName);
}

function shouldMarkActionProgress(actionName, output) {
  switch (actionName) {
    case "web_search":
    case "read_url":
    case "execute_skill_tool":
    case "todo_plan":
    case "todo_advance":
    case "todo_cancel":
    case "todo_run_next":
    case "workspace_write":
    case FINALIZE_CANDIDATE_ACTION:
    case "read_agent_skill":
    case "use_agent_skill":
      return true;
    case "workspace_replace":
      return Boolean(output && output.changed === true);
    default:
      return false;
  }
}

function markSessionProgress(runState, detail = {}) {
  const budget = runState && runState.sessionBudget;
  if (!budget) return 0;
  const next = readPositiveInt(budget.progressMarker, 0) + 1;
  budget.progressMarker = next;
  budget.lastProgressReason = readProgressReason(detail);
  return next;
}

function readSessionProgressMarker(runState) {
  const budget = runState && runState.sessionBudget;
  if (!budget) return 0;
  return readPositiveInt(budget.progressMarker, 0);
}

function recordFingerprint(budget, fingerprint) {
  if (!budget || !fingerprint) return 0;
  const next = (budget.fingerprintCounts[fingerprint] || 0) + 1;
  budget.fingerprintCounts[fingerprint] = next;
  return next;
}

// Clears the fingerprint repeat counters when real tool progress occurs.
// Mirrors markSessionProgress: progress in one decision class should not
// keep blocking later distinct decisions via stale repeat counts.
function markSessionFingerprintProgress(runState, actionName) {
  const budget = runState && runState.sessionBudget;
  if (!budget) return false;
  const trimmed = typeof actionName === "string" ? actionName.trim() : "";
  if (!trimmed) return false;
  // Skip todo-only and inspect actions: they do not represent external progress.
  if (trimmed === "todo_run_next" || trimmed === "todo_inspect" || trimmed === "todo_advance" || trimmed === "todo_cancel") {
    return false;
  }
  const counts = budget.fingerprintCounts;
  if (!counts) return false;
  let cleared = false;
  for (const key in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      cleared = true;
      delete counts[key];
    }
  }
  return cleared;
}

// Called at the end of each cycle. `marker` is any monotonic progress
// signal. The action loop now passes the session progress marker, which
// advances for all successful long-task actions (search/read/todo/workspace
// and skill tools), not only execute_skill_tool history growth.
function noteCycleCompleted(budget, marker) {
  if (!budget) return false;
  const advanced = typeof marker === "number" && marker > budget.lastProgressMarker;
  if (advanced) {
    budget.lastProgressMarker = marker;
    budget.cyclesSinceProgress = 0;
    return true;
  }
  budget.cyclesSinceProgress += 1;
  return false;
}

function readProgressReason(detail) {
  if (!detail || typeof detail !== "object") return null;
  const reason = typeof detail.reason === "string" && detail.reason.trim()
    ? detail.reason.trim()
    : null;
  const actionName = typeof detail.actionName === "string" && detail.actionName.trim()
    ? detail.actionName.trim()
    : null;
  return reason || actionName;
}

export { createSessionBudgetState, markActionProgress, markSessionFingerprintProgress, markSessionProgress, normalizeBudgetConfig, noteCycleCompleted, readSessionProgressMarker, recordFingerprint };
