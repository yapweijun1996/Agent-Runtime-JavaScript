// AGRUN-435 — Typed Transition System: explicit loop continuation reasons.
//
// The session loop (continueActionLoop) controls flow with many bare
// `continue`/`return` branches. Each one now records WHY it took that path via
// a stable, machine-readable reason. The reason is the SSOT for "what happened
// this iteration": stored on runState.lastTransition, emitted to observer JSONL
// as a `loop-transition` step (debug visibility — per-iteration trace, not user
// noise), and assertable in tests WITHOUT inspecting message contents.
//
// Single-door: the plan batch path returns a { done, result } envelope back
// into this loop rather than running its own continuation loop, so the session
// loop is the only place transitions are recorded.
//
// Purely additive: recordLoopTransition sets a field + emits a step. It NEVER
// changes control flow and NEVER throws inside the loop (an unknown reason
// degrades to "unknown" rather than crashing a live run).

const LOOP_TRANSITIONS = Object.freeze({
  // ── per-iteration continues (the "what happened" meat) ──────────────────
  PLANNER_INVALID_REPAIR: "planner_invalid_repair",
  TODO_PLACEHOLDER_REQUIRED: "todo_placeholder_required",
  TODO_PLAN_REQUIRED: "todo_plan_required",
  TODO_INSPECT_LOOP_BLOCKED: "todo_inspect_loop_blocked",
  TERMINAL_REPAIR_BLOCKED: "terminal_repair_blocked",
  FINAL_DECISION_REPLAN: "final_decision_replan",
  FINALIZE_DECISION_REPLAN: "finalize_decision_replan",
  PLAN_EXECUTED: "plan_executed",
  ACTION_DISABLED: "action_disabled",
  // ADR-0057 Phase 1 — an AI-emitted action sits behind a closed deferred
  // namespace; the loop surfaced the open_action_namespace hint and continued.
  ACTION_NAMESPACE_CLOSED: "action_namespace_closed",
  PUBLISH_CANDIDATE_GATED: "publish_candidate_gated",
  UNKNOWN_ACTION: "unknown_action",
  WEB_SEARCH_REPEAT_SKIPPED: "web_search_repeat_skipped",
  WEB_SEARCH_REPEAT_ESCALATED: "web_search_repeat_escalated",
  POLICY_DENIED_CONTINUE: "policy_denied_continue",
  // ── implicit fall-through (most common case) ────────────────────────────
  NEXT_TURN: "next_turn",
  // ── terminal returns (branch identity for the final iteration) ──────────
  TERMINAL_ABORT: "terminal_abort",
  TERMINAL_APPROVAL_PAUSE: "terminal_approval_pause",
  TERMINAL_RUN_DEADLINE: "terminal_run_deadline",
  TERMINAL_COST_BUDGET: "terminal_cost_budget",
  TERMINAL_PLANNER: "terminal_planner",
  TERMINAL_FINAL_DECISION: "terminal_final_decision",
  TERMINAL_PLAN: "terminal_plan",
  TERMINAL_FINALIZE_DECISION: "terminal_finalize_decision",
  TERMINAL_INVALID_ACTION: "terminal_invalid_action",
  TERMINAL_ACTION: "terminal_action",
  TERMINAL_DIRECT_FINAL: "terminal_direct_final",
  TERMINAL_MAX_STEPS_CONTINUATION: "terminal_max_steps_continuation",
  TERMINAL_MAX_STEPS_EXCEEDED: "terminal_max_steps_exceeded"
});

const KNOWN_REASONS = new Set(Object.values(LOOP_TRANSITIONS));

// Records the loop transition for the current iteration. `reason` should be a
// LOOP_TRANSITIONS value; an unknown reason degrades to "unknown" so a typo
// never crashes a live run. `detail` (optional, small) is merged into the
// emitted step and stored alongside the reason.
function recordLoopTransition(session, reason, detail) {
  if (!session || typeof session !== "object") return;
  const runState = session.runState;
  if (!runState || typeof runState !== "object") return;
  const normalizedReason = typeof reason === "string" && KNOWN_REASONS.has(reason)
    ? reason
    : "unknown";
  const cycle = Number.isInteger(runState.cycleCount) ? runState.cycleCount : 0;
  const extraDetail = detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail
    : null;
  runState.lastTransition = extraDetail
    ? { reason: normalizedReason, cycle, detail: extraDetail }
    : { reason: normalizedReason, cycle };
  if (typeof session.pushStep === "function") {
    session.pushStep("loop-transition", extraDetail
      ? { reason: normalizedReason, cycle, ...extraDetail }
      : { reason: normalizedReason, cycle });
  }
}

export { LOOP_TRANSITIONS, recordLoopTransition };
