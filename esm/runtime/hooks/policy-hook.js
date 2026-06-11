import { evaluateActionPolicy } from '../policy.js';
import { shouldUsePermissionJudge } from '../action-permission-judge.js';
import { readActionArgs } from '../action-loop-utils.js';

// AGRUN-422: tool policy as a preToolCall hook (depends on AGRUN-418).
//
// The built-in policy hook is the SSOT for "may this tool call proceed":
// it evaluates the static action policy (allow/ask/deny tiers via
// evaluateActionPolicy) and, on the single-action phase only, lets the AI
// permission judge escalate an "allow" — exactly the inline behavior this
// module replaced. Non-allow outcomes short-circuit as { error: decision }
// so callers keep receiving the same decision object they passed to
// handlePolicyBlock / plan validation before the migration.
//
// Both dispatch doors run this through the SAME session-scoped runner:
//   - single-action path: action-loop-session-loop.js (phase "action")
//   - plan batch path:    action-loop-plan-validation.js (phase "plan-validation")
// The judge stays single-action-only by phase gate — plans reject any
// non-allow policy outright, so judge escalation there would be new behavior.
//
// FAIL-CLOSED posture: the hook runner races every hook (host-hook-timeout
// posture) and degrades failures to "hook ignored" — fine for advisory hooks,
// wrong for a permission gate. resolveBlockedPolicyDecision therefore maps
// ANY preToolCall diagnostic (timeout / throw / invalid shape) to an "ask"
// decision (reason "policy_hook_failed"), matching the judge's own failure
// posture, instead of letting the call through.


function createPolicyHook() {
  return async function builtinPolicyHook(ctx) {
    const action = ctx && ctx.action;
    if (!action) {
      return {
        error: {
          action: "deny",
          actionName: (ctx && ctx.call && ctx.call.name) || null,
          permission: null,
          reason: "unknown_action",
          source: "policy_hook",
          tier: null
        }
      };
    }
    const session = ctx && ctx.session;
    const policyDecision = evaluateActionPolicy(
      session && session.runtimeConfig && session.runtimeConfig.actionPolicy,
      action
    );
    const judgedPolicyDecision = ctx && ctx.phase === "action"
      ? (await maybeEvaluateActionPermissionJudge(session, action, ctx.decision, policyDecision)) || policyDecision
      : policyDecision;
    if (judgedPolicyDecision.action !== "allow") {
      return { error: judgedPolicyDecision };
    }
  };
}

// Maps a runPreToolCall outcome to the blocking policy decision, or null
// when the call may proceed. Fail-closed: a hook failure recorded in
// diagnostics blocks with "ask" rather than silently allowing.
function resolveBlockedPolicyDecision(hookOutcome, action) {
  if (hookOutcome && hookOutcome.outcome === "error") {
    return hookOutcome.error;
  }
  const failure = hookOutcome && Array.isArray(hookOutcome.diagnostics) && hookOutcome.diagnostics.length > 0
    ? hookOutcome.diagnostics[0]
    : null;
  if (failure) {
    return {
      action: "ask",
      actionName: (action && action.name) || null,
      hookFailure: failure.message,
      permission: null,
      reason: "policy_hook_failed",
      source: "policy_hook_failsafe",
      tier: action && Number.isInteger(action.tier) ? action.tier : null
    };
  }
  return null;
}

// Moved verbatim from action-loop-session-loop.js (AGRUN-422). Judge only
// escalates explicit/tier "allow" decisions and fails closed to "ask"
// inside judge.classify; the step emission keeps the same shape.
async function maybeEvaluateActionPermissionJudge(session, action, decision, policyDecision) {
  const config = session && session.runtimeConfig && session.runtimeConfig.actionPermissionJudge;
  if (!config || config.enabled !== true) return null;
  if (!policyDecision || policyDecision.action !== "allow") return null;
  if (!shouldUsePermissionJudge(action)) return null;
  const judge = session && session.actionPermissionJudge;
  if (!judge || typeof judge.classify !== "function") return null;
  const judged = await judge.classify(action, readActionArgs(decision), {
    cycle: session.runState && session.runState.cycleCount,
    runId: session.runState && session.runState.runId
  });
  if (typeof session.pushStep === "function") {
    session.pushStep("action-permission-judge", {
      actionName: action && action.name,
      cacheHit: judged.cacheHit === true,
      decision: judged.action,
      reason: judged.reason,
      source: judged.source,
      tier: judged.tier
    });
  }
  return judged;
}

export { createPolicyHook, resolveBlockedPolicyDecision };
