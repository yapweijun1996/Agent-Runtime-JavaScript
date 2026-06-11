import { TODO_STATE_CONSTANTS } from './todo-state.js';

/**
 * Debug-time inspector for the TodoState subsystem.
 *
 * Returns a structured dump suitable for logging, host devtools, or
 * tests. This is a *read-only* projection — calling it does not mutate
 * runState. Pair with the existing `onStep` callback (which receives
 * `todo-state-mutated`, `todo-plan-required-before-tools`,
 * `todo-inspect-loop-vetoed`, `before-finalize-veto` events) to get a
 * complete picture of what TodoState did during a run.
 *
 * Shape:
 *
 *   {
 *     present:   boolean,                  // does runState have a TodoState?
 *     state:     TodoState | null,         // raw state object
 *     summary:   { itemCount, byStatus, activeItemId, status, version, goal },
 *     invariants: {
 *       singleActiveOk:   boolean,         // ≤ 1 item with status=active
 *       activeIdMatches:  boolean,         // activeItemId points to an active item
 *       allTransitionsLegal: boolean,      // every item.status is in the allowed table
 *       violations: string[]               // human-readable invariant breaks, if any
 *     },
 *     guardState: {
 *       autopilot:        runState.todoAutopilotGuard       || null,
 *       inspectLoop:      runState.todoInspectLoopGuard     || null,
 *       planRequired:     runState.todoPlanRequiredGuard    || null,
 *       citationCoverage: runState.citationCoverageGuard    || null,
 *       researchCoverage: runState.researchCoverageGuard    || null,
 *       finalQuality:     runState.finalResponseQuality     || null
 *     },
 *     recentEvents: Step[]                 // todo-related steps from runState.steps (if attached)
 *   }
 */
function inspectTodoState(runState, options = {}) {
  const state = runState && typeof runState === "object" ? runState.todoState : null;
  if (!state || typeof state !== "object") {
    return {
      present: false,
      state: null,
      summary: null,
      invariants: null,
      guardState: collectGuardState(runState),
      recentEvents: collectRecentEvents(options.steps, options.eventLimit)
    };
  }

  const items = Array.isArray(state.items) ? state.items : [];
  const byStatus = countByStatus(items);
  const invariants = checkInvariants(state, items);

  return {
    present: true,
    state,
    summary: {
      activeItemId: state.activeItemId || null,
      byStatus,
      goal: typeof state.goal === "string" ? state.goal : null,
      itemCount: items.length,
      status: state.status || null,
      version: typeof state.version === "number" ? state.version : null
    },
    invariants,
    guardState: collectGuardState(runState),
    recentEvents: collectRecentEvents(options.steps, options.eventLimit)
  };
}

function countByStatus(items) {
  const counts = {};
  for (const status of TODO_STATE_CONSTANTS.ITEM_STATUSES) counts[status] = 0;
  for (const item of items) {
    if (item && typeof item.status === "string" && counts[item.status] !== undefined) {
      counts[item.status] += 1;
    }
  }
  return counts;
}

function checkInvariants(state, items) {
  const violations = [];
  const activeItems = items.filter((item) => item && item.status === "active");
  const singleActiveOk = activeItems.length <= 1;
  if (!singleActiveOk) {
    violations.push(`expected ≤1 active item, found ${activeItems.length}`);
  }

  let activeIdMatches = true;
  if (state.activeItemId) {
    const match = items.find((item) => item && item.id === state.activeItemId);
    if (!match) {
      activeIdMatches = false;
      violations.push(`activeItemId "${state.activeItemId}" does not match any item`);
    } else if (match.status !== "active") {
      activeIdMatches = false;
      violations.push(`activeItemId "${state.activeItemId}" points to item with status "${match.status}"`);
    }
  } else if (activeItems.length > 0) {
    activeIdMatches = false;
    violations.push("activeItemId is null but an item has status=active");
  }

  const allowed = new Set(TODO_STATE_CONSTANTS.ITEM_STATUSES);
  let allTransitionsLegal = true;
  for (const item of items) {
    if (item && typeof item.status === "string" && !allowed.has(item.status)) {
      allTransitionsLegal = false;
      violations.push(`item "${item.id}" has unknown status "${item.status}"`);
    }
  }

  return { singleActiveOk, activeIdMatches, allTransitionsLegal, violations };
}

function collectGuardState(runState) {
  if (!runState || typeof runState !== "object") return {};
  return {
    autopilot: runState.todoAutopilotGuard || null,
    inspectLoop: runState.todoInspectLoopGuard || null,
    planRequired: runState.todoPlanRequiredGuard || null,
    citationCoverage: runState.citationCoverageGuard || null,
    researchCoverage: runState.researchCoverageGuard || null,
    finalQuality: runState.finalResponseQuality || null
  };
}

const TODO_EVENT_PREFIXES = ["todo-", "before-finalize-veto"];

function collectRecentEvents(steps, eventLimit) {
  if (!Array.isArray(steps)) return [];
  const limit = Number.isInteger(eventLimit) && eventLimit > 0 ? eventLimit : 20;
  const matching = steps.filter((step) => (
    step && typeof step.type === "string"
    && TODO_EVENT_PREFIXES.some((prefix) => step.type.startsWith(prefix))
  ));
  return matching.slice(-limit);
}

export { inspectTodoState };
