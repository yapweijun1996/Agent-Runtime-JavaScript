// ADR-0034 — Invalid-Action Loop Convergence as AI-Visible Observation.
//
// Tracks repeated planner-invalid-action / planner-repair-failed cycles
// driven by host disabledActions rejection, so the AI sees a structured
// signal in the planner prompt (and the host sees a step event) instead
// of looping until step budget. Runtime does NOT hard-kill the loop;
// it surfaces facts and lets the AI choose a different action.
//
// AI-first invariant (AGRUN-249, ADR-0012): runtime exposes
// `availableActions` and `availableAgentSkillIds` directly to the AI
// via the planner-prompt observation block. There is NO runtime-side
// curated subset (no "suggestedNextMoves" hardcoded category list).
// The AI sees the full set the host actually allows and picks itself.

const ESCALATION_THRESHOLD = 4;
const ACTIVE_THRESHOLD = 2;

function createInvalidActionConvergenceState() {
  return {
    kind: "invalid_action_convergence",
    active: false,
    consecutiveInvalidCount: 0,
    consecutiveRepairFailureCount: 0,
    lastInvalidActionName: null,
    lastInvalidReason: null,
    disabledActionsEncountered: [],
    availableActions: [],
    availableAgentSkillIds: [],
    firstObservedAtCycle: null,
    lastObservedAtCycle: null,
    escalation: "advisory",
    status: "tracking",
    clearedReason: null,
    version: 1
  };
}

function refreshInvalidActionConvergence(runState, options = {}) {
  if (!runState || typeof runState !== "object") return null;
  const previous = normalizeState(runState.invalidActionConvergence);
  const event = readString$1v(options.event);
  const cycle = readNullableNumber$1(runState.cycleCount);

  let next;
  if (event === "action-executed") {
    next = clearState(previous, "action-executed");
  } else if (event === "planner_invalid_action" || event === "planner_repair_failed") {
    next = applyInvalidEvent(previous, options, cycle, event);
  } else {
    next = previous;
  }

  runState.invalidActionConvergence = next;
  return next;
}

function summarizeInvalidActionConvergence(value) {
  const state = normalizeState(value);
  return {
    active: state.active === true,
    actionName: state.lastInvalidActionName,
    consecutiveInvalidCount: state.consecutiveInvalidCount,
    consecutiveRepairFailureCount: state.consecutiveRepairFailureCount,
    escalation: state.escalation,
    lastInvalidReason: state.lastInvalidReason,
    disabledActionsEncountered: state.disabledActionsEncountered.slice(),
    availableActions: state.availableActions.slice(),
    availableAgentSkillIds: state.availableAgentSkillIds.slice(),
    firstObservedAtCycle: state.firstObservedAtCycle,
    lastObservedAtCycle: state.lastObservedAtCycle,
    status: state.status,
    clearedReason: state.clearedReason
  };
}

function buildInvalidActionConvergenceStepDetail(state) {
  const normalized = normalizeState(state);
  return {
    active: normalized.active === true,
    actionName: normalized.lastInvalidActionName,
    consecutiveInvalidCount: normalized.consecutiveInvalidCount,
    consecutiveRepairFailureCount: normalized.consecutiveRepairFailureCount,
    escalation: normalized.escalation,
    lastInvalidReason: normalized.lastInvalidReason,
    disabledActionsEncounteredCount: normalized.disabledActionsEncountered.length,
    availableActionsCount: normalized.availableActions.length,
    availableAgentSkillIdsCount: normalized.availableAgentSkillIds.length,
    status: normalized.status,
    clearedReason: normalized.clearedReason,
    cycle: normalized.lastObservedAtCycle
  };
}

// ADR-0034 — clear invalid-action convergence once a real action executes.
// SHARED by BOTH dispatch paths (single-action action-loop-action.js AND the
// plan batch action-loop-plan-actions.js) so the convergence slot is cleared —
// and the refresh step emitted — identically on either door. Per the two-door
// rule this is the SSOT: the plan path previously never cleared the slot, so a
// stale active=true convergence signal could pollute the planner prompt for
// later cycles even after the run recovered (audit H2 / AGRUN-481). Only acts
// when the slot was actively tracking a loop, to avoid noise on normal cycles.
function applyInvalidActionConvergenceOnSuccess(runState, pushStep) {
  if (!runState || typeof runState !== "object") return;
  if (!(runState.invalidActionConvergence && runState.invalidActionConvergence.active === true)) {
    return;
  }
  refreshInvalidActionConvergence(runState, { event: "action-executed" });
  if (typeof pushStep === "function") {
    pushStep(
      "invalid-action-convergence-refreshed",
      buildInvalidActionConvergenceStepDetail(runState.invalidActionConvergence)
    );
  }
}

function applyInvalidEvent(previous, options, cycle, event) {
  const actionName = readActionName$2(options.actionName);
  const reason = readString$1v(options.reason) || null;
  const sameName = actionName && actionName === previous.lastInvalidActionName;

  const consecutiveInvalidCount = event === "planner_invalid_action"
    ? (sameName ? previous.consecutiveInvalidCount + 1 : (actionName ? 1 : previous.consecutiveInvalidCount))
    : previous.consecutiveInvalidCount;
  const consecutiveRepairFailureCount = event === "planner_repair_failed"
    ? (sameName ? previous.consecutiveRepairFailureCount + 1 : (actionName ? 1 : previous.consecutiveRepairFailureCount))
    : previous.consecutiveRepairFailureCount;

  const lastInvalidActionName = actionName || (sameName ? previous.lastInvalidActionName : (actionName ? actionName : previous.lastInvalidActionName));
  const driver = Math.max(consecutiveInvalidCount, consecutiveRepairFailureCount);
  const active = driver >= ACTIVE_THRESHOLD && Boolean(lastInvalidActionName);
  const escalation = driver >= ESCALATION_THRESHOLD ? "hard_signal" : "advisory";

  const availableActions = readStringArray$5(options.availableActions).slice(0, 24);
  const availableAgentSkillIds = readStringArray$5(options.availableAgentSkillIds).slice(0, 32);

  const disabledActionsEncountered = mergeDisabledActions$2(
    previous.disabledActionsEncountered,
    actionName,
    options
  );

  return {
    kind: "invalid_action_convergence",
    active,
    consecutiveInvalidCount,
    consecutiveRepairFailureCount,
    lastInvalidActionName,
    lastInvalidReason: reason || previous.lastInvalidReason,
    disabledActionsEncountered,
    availableActions,
    availableAgentSkillIds,
    firstObservedAtCycle: active && previous.firstObservedAtCycle == null
      ? (cycle != null ? cycle : previous.firstObservedAtCycle)
      : previous.firstObservedAtCycle,
    lastObservedAtCycle: cycle != null ? cycle : previous.lastObservedAtCycle,
    escalation,
    status: active ? "active" : "tracking",
    clearedReason: null,
    version: 1
  };
}

function clearState(previous, reason) {
  return {
    ...createInvalidActionConvergenceState(),
    clearedReason: previous.active === true ? (reason || "cleared") : previous.clearedReason
  };
}

function mergeDisabledActions$2(previousList, actionName, options) {
  const previous = Array.isArray(previousList) ? previousList.slice() : [];
  const next = new Set(previous);
  if (actionName && isLikelyDisabled(actionName, options)) {
    next.add(actionName);
  }
  return Array.from(next).slice(0, 12);
}

function isLikelyDisabled(actionName, options) {
  const available = readStringArray$5(options.availableActions);
  // If the planner emitted an action name that is NOT in the
  // post-filter availableActions surface, the host has disabled it.
  return available.length > 0 && !available.includes(actionName);
}

function normalizeState(value) {
  const initial = createInvalidActionConvergenceState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return initial;
  return {
    ...initial,
    ...value,
    active: value.active === true,
    consecutiveInvalidCount: readNonNegativeInteger$4(value.consecutiveInvalidCount),
    consecutiveRepairFailureCount: readNonNegativeInteger$4(value.consecutiveRepairFailureCount),
    lastInvalidActionName: readActionName$2(value.lastInvalidActionName) || null,
    lastInvalidReason: readString$1v(value.lastInvalidReason) || null,
    disabledActionsEncountered: readStringArray$5(value.disabledActionsEncountered).slice(0, 12),
    availableActions: readStringArray$5(value.availableActions).slice(0, 24),
    availableAgentSkillIds: readStringArray$5(value.availableAgentSkillIds).slice(0, 32),
    firstObservedAtCycle: readNullableNumber$1(value.firstObservedAtCycle),
    lastObservedAtCycle: readNullableNumber$1(value.lastObservedAtCycle),
    escalation: value.escalation === "hard_signal" ? "hard_signal" : "advisory",
    status: readString$1v(value.status) || "tracking",
    clearedReason: readString$1v(value.clearedReason) || null,
    version: 1
  };
}

function readString$1v(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readActionName$2(value) {
  const text = readString$1v(value).toLowerCase();
  return text || null;
}

function readStringArray$5(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const s = typeof item === "string" ? item.trim() : (item && typeof item === "object" && typeof item.name === "string" ? item.name.trim() : "");
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function readNonNegativeInteger$4(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function readNullableNumber$1(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export { applyInvalidActionConvergenceOnSuccess, buildInvalidActionConvergenceStepDetail, createInvalidActionConvergenceState, refreshInvalidActionConvergence, summarizeInvalidActionConvergence };
