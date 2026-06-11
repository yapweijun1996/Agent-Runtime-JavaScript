import { resolveBlockedPolicyDecision } from './hooks/policy-hook.js';
import { ensureSessionHookRunner } from './hooks/session-hooks.js';
import { maybeBlockActionPatternRepeat } from './action-loop-action.js';
import { PUBLISH_DIRECT_ACTION } from './kernel-terminal-actions.js';
import { emitSkillPolicyStep, evaluateSkillPolicy } from './skill-policy.js';
import { readActionArgs, readWebSearchEndpoint } from './action-loop-utils.js';
import { normalizeThrownError } from './errors.js';
import { validateActionArgs } from './action-args-validation.js';
import { readPlanActionContract } from './action-plan-contract.js';
import { selectPlannerActions, isWorkspacePublishCandidateGatedForMode } from './planner-action-surface.js';

const ACTION_POLICY_NOT_ALLOW_IN_PLAN_FEEDBACK = Object.freeze({
  code: "action_policy_not_allow_in_plan",
  detail: "Approval-gated or denied actions cannot appear inside a plan envelope. Emit the approval-gated action as a standalone action envelope first (shape: {\"type\":\"action\",\"name\":\"read_url\",\"args\":{...}}) so the host approval flow can run; use plan only for independent actions whose actionPolicy is allow."
});

async function validatePlan(session, decision) {
  if (!Array.isArray(decision.actions) || decision.actions.length === 0) {
    return { ok: false, error: "Plan requires a non-empty actions array." };
  }
  if (decision.actions.length > session.runtimeConfig.maxPlanActions) {
    return {
      ok: false,
      error: `Plan has ${decision.actions.length} actions; maxPlanActions is ${session.runtimeConfig.maxPlanActions}.`
    };
  }
  if (decision.synthesize_per_action === true) {
    const stitchValidation = validateStitch(decision.stitch);
    if (!stitchValidation.ok) {
      return stitchValidation;
    }
  }

  const actions = [];
  for (let index = 0; index < decision.actions.length; index += 1) {
    const entry = decision.actions[index];
    if (!entry || typeof entry !== "object" || entry.type !== "action") {
      return { ok: false, error: `Plan action ${index} must be a type:\"action\" envelope.` };
    }
    const actionName = readString$n(entry.name);
    const action = session.actionRegistry.get(actionName);
    if (!action) {
      return { ok: false, error: `Plan action ${index} references unknown action "${actionName || "unknown"}".` };
    }
    if (!isActionAvailable(actionName, session.availableActions)) {
      return { ok: false, error: `Plan action ${index} references disabled action "${actionName}".` };
    }
    const actionSurfaceValidation = validateRuntimeActionSurface(session, actionName, index);
    if (!actionSurfaceValidation.ok) {
      return actionSurfaceValidation;
    }
    const planContract = readPlanActionContract(action);
    if (planContract.allowedInPlan === false) {
      return createPlanValidationError(
        `Plan action ${index} "${actionName}" cannot appear inside a plan because it mutates planner state.`,
        {
          code: planContract.code,
          detail: planContract.detail
        }
      );
    }
    if (decision.synthesize_per_action === true && !readString$n(entry.section && entry.section.prompt)) {
      // AGRUN-214o P5 — tag the error with a recovery code so
      // executePlan can attempt an auto-strip retry without burning a
      // cycle on planner re-prompt. The detail is targeted feedback the
      // planner can act on if the auto-strip path is unavailable.
      return createPlanValidationError(
        `Plan action ${index} requires section.prompt when synthesize_per_action is true.`,
        {
          code: "missing_section_prompt",
          detail: "Either provide section.prompt for every plan action, or omit synthesize_per_action so each action runs as a normal tool call without per-action LLM synthesis."
        }
      );
    }
    const policyHookOutcome = await ensureSessionHookRunner(session).runPreToolCall({
      action,
      call: { args: readActionArgs(entry), name: actionName },
      phase: "plan-validation",
      session
    });
    const blockedPolicyDecision = resolveBlockedPolicyDecision(policyHookOutcome, action);
    if (blockedPolicyDecision) {
      return createPlanValidationError(
        `Plan action ${index} "${actionName}" is policy "${blockedPolicyDecision.action}", not allow.`,
        ACTION_POLICY_NOT_ALLOW_IN_PLAN_FEEDBACK
      );
    }
    let args = readActionArgs(entry);
    const argsValidation = validateActionArgs(action, args);
    if (argsValidation.ok && Array.isArray(argsValidation.aliasRewrites) && argsValidation.aliasRewrites.length > 0) {
      session.pushStep("action-args-alias-rewrite", {
        actionName,
        planIndex: index,
        rewrites: argsValidation.aliasRewrites
      });
      if (argsValidation.normalizedArgs && typeof argsValidation.normalizedArgs === "object") {
        args = argsValidation.normalizedArgs;
      }
    }
    if (!argsValidation.ok) {
      session.pushStep("action-args-invalid", {
        actionName,
        error: argsValidation.error,
        key: argsValidation.key,
        planIndex: index,
        reason: argsValidation.reason
      });
      return createPlanValidationError(
        `Plan action ${index} "${actionName}" failed validation: ${argsValidation.error}`,
        {
          code: "action_args_invalid",
          detail: argsValidation.error
        }
      );
    }
    if (typeof action.preflight === "function") {
      try {
        action.preflight(createActionContext(session), args);
      } catch (error) {
        const preflightError = normalizeThrownError(error).message;
        session.pushStep("action-args-invalid", {
          actionName,
          error: preflightError,
          key: null,
          planIndex: index,
          reason: "preflight"
        });
        return {
          ok: false,
          error: `Plan action ${index} "${actionName}" failed validation: ${preflightError}`
        };
      }
    }
    const skillPolicyDecision = evaluateSkillPolicyForPlanAction(session, actionName, args);
    if (skillPolicyDecision && skillPolicyDecision.action !== "allow") {
      emitSkillPolicyStep(
        session.pushStep,
        skillPolicyDecision.action === "ask" ? "skill-policy-approval-required" : "skill-policy-denied",
        skillPolicyDecision
      );
      return createPlanValidationError(
        `Plan action ${index} "${actionName}" is skill policy "${skillPolicyDecision.action}", not allow.`,
        {
          code: "skill_policy_blocked",
          detail: `Skill policy ${skillPolicyDecision.action}: ${skillPolicyDecision.reason}`
        }
      );
    }
    // Repeat-action preflight parity with the single path
    // (cross-cutting-dispatch-matrix-2026-06-10.md §3). maybeBlockActionPatternRepeat
    // is a READ-ONLY check against the pre-batch convergence/terminal-repair
    // snapshot — sequential here, so no parallel-mutation risk. A plan that
    // includes a known-looping action is rejected with the block's reason as
    // planner feedback (the planner re-plans, same recovery as the single
    // path's observation). Honest scope: the single path also refreshes the
    // convergence ladder on a preflight block; here the executed-action
    // convergence refresh (action-loop-plan-actions.js applyActionSuccess/
    // applyActionFailure) already advances it across cycles, so this preflight
    // only stops the action one cycle earlier without mutating state at gate time.
    const patternBlock = maybeBlockActionPatternRepeat({
      actionArgs: args,
      actionName,
      decision: entry,
      request: session.request,
      pushStep: session.pushStep,
      runState: session.runState
    });
    if (patternBlock) {
      return createPlanValidationError(
        `Plan action ${index} "${actionName}" blocked: ${patternBlock.message}`,
        {
          code: "action_pattern_blocked_in_plan",
          detail: patternBlock.message
        }
      );
    }
    actions.push({ action, args, decision: entry, index, name: actionName });
  }

  return {
    actions,
    maxParallel: Math.min(session.runtimeConfig.maxPlanParallel, actions.length),
    ok: true
  };
}

function evaluateSkillPolicyForPlanAction(session, actionName, args) {
  if (actionName !== "execute_skill_tool") return null;
  const skillName = readString$n(args && args.skillName) ||
    readString$n(session.runState.agentSkillContext && session.runState.agentSkillContext.activeSkill && (
      session.runState.agentSkillContext.activeSkill.skillId ||
      session.runState.agentSkillContext.activeSkill.name
    ));
  const toolName = readString$n(args && args.toolName);
  const manifest = findManifest(session.runtimeConfig.agentSkills, skillName);
  return evaluateSkillPolicy({
    manifest,
    operation: "execute",
    runtimeConfig: session.runtimeConfig,
    skillId: skillName,
    skillName,
    toolName
  });
}

function findManifest(manifests, skillIdOrName) {
  const target = readString$n(skillIdOrName).toLowerCase();
  if (!target) return null;
  return (Array.isArray(manifests) ? manifests : []).find((manifest) => (
    readString$n(manifest && manifest.skillId).toLowerCase() === target ||
    readString$n(manifest && manifest.name).toLowerCase() === target
  )) || null;
}

function createPlanValidationError(error, plannerFeedback) {
  return {
    code: plannerFeedback && plannerFeedback.code,
    error,
    planner_feedback: plannerFeedback,
    ok: false
  };
}

function validateRuntimeActionSurface(session, actionName, index) {
  const selectedActions = selectPlannerActions(session.availableActions, {
    activeAgentSkill: session.runState && session.runState.agentSkillContext
      ? session.runState.agentSkillContext.activeSkill
      : null,
    availableAgentSkills: session.runState && Array.isArray(session.runState.availableAgentSkills)
      ? session.runState.availableAgentSkills
      : session.runtimeConfig && Array.isArray(session.runtimeConfig.agentSkills)
        ? session.runtimeConfig.agentSkills
        : [],
    lastReadAgentSkill: session.runState && session.runState.agentSkillContext
      ? session.runState.agentSkillContext.lastReadSkill
      : null,
    prompt: session.request && session.request.prompt,
    runState: session.runState,
    runtimeConfig: session.runtimeConfig,
    terminalRepairState: session.runState && session.runState.terminalRepairState
  });
  if (isActionAvailable(actionName, selectedActions)) {
    return { ok: true };
  }
  const selectedActionNames = selectedActions.map((action) => readString$n(action && action.name)).filter(Boolean);
  const detail = buildRuntimeActionSurfaceDetail(session, selectedActionNames, actionName);
  return createPlanValidationError(
    `Plan action ${index} "${actionName}" is currently hidden by the runtime action surface.`,
    {
      code: "action_surface_blocked_in_plan",
      detail
    }
  );
}

function buildRuntimeActionSurfaceDetail(session, allowedActionNames, blockedActionName) {
  const runState = session && session.runState && typeof session.runState === "object"
    ? session.runState
    : {};
  if (
    blockedActionName === PUBLISH_DIRECT_ACTION &&
    isWorkspacePublishCandidateGatedForMode({
      activeAgentSkill: runState && runState.agentSkillContext
        ? runState.agentSkillContext.activeSkill
        : null,
      lastReadAgentSkill: runState && runState.agentSkillContext
        ? runState.agentSkillContext.lastReadSkill
        : null,
      runState,
      runtimeConfig: session && session.runtimeConfig,
      terminalRepairState: runState && runState.terminalRepairState
    })
  ) {
    // AGRUN-256 — publish-candidate mode gate. Tell the planner the
    // structural reason and the concrete next move, plus the host opt-out
    // path so an operator reading logs can disable the gate if needed.
    return [
      "workspace_publish_candidate is a publish-direct terminal (skips the runtime finalize LLM; usedRuntimeFinalize=false, tokens=0 audit blind spot) and is gated by default.",
      "To deliver the answer this turn, end with a finalize envelope so the runtime finalizer can produce the response.",
      "Hosts can legitimately enable publish-direct through ONE of three explicit opt-in paths: (a) set runtimeConfig.publishCandidateGate.enabled=false to allow publish-direct in any mode; (b) activate a skill that requires evidence convergence or publish-readiness on the run so the catalog exposes the action; (c) route through terminalRepairState.allowedActions during runtime recovery."
    ].join(" ");
  }
  const terminalRepairState = runState.terminalRepairState && typeof runState.terminalRepairState === "object"
    ? runState.terminalRepairState
    : null;
  if (terminalRepairState && terminalRepairState.active === true) {
    const repairAllowed = readStringArray$1(terminalRepairState.allowedActions);
    return [
      "The active terminalRepairState is constraining the next action surface.",
      repairAllowed.length > 0
        ? `Choose one of these allowed repair actions: ${repairAllowed.join(", ")}.`
        : "Choose a repair action currently exposed by the planner action surface.",
      readString$n(terminalRepairState.reason)
        ? `Repair reason: ${readString$n(terminalRepairState.reason)}.`
        : "",
      readString$n(terminalRepairState.requiredRepair)
        ? `Required repair: ${readString$n(terminalRepairState.requiredRepair)}.`
        : ""
    ].filter(Boolean).join(" ");
  }

  const convergence = runState.actionPatternConvergence && typeof runState.actionPatternConvergence === "object"
    ? runState.actionPatternConvergence
    : null;
  const readOnlyState = convergence &&
    convergence.readOnlyPlanningState &&
    typeof convergence.readOnlyPlanningState === "object"
    ? convergence.readOnlyPlanningState
    : null;
  if (readOnlyState && readOnlyState.active === true) {
    return [
      "The active readOnlyPlanningState is constraining the next action surface because recent actions did not create productive progress.",
      allowedActionNames.length > 0
        ? `Choose an exposed productive action instead: ${allowedActionNames.join(", ")}.`
        : "Choose an action that creates productive progress before retrying read-only planning."
    ].join(" ");
  }

  const structureState = convergence &&
    convergence.structureRepairConvergence &&
    typeof convergence.structureRepairConvergence === "object"
    ? convergence.structureRepairConvergence
    : null;
  if (structureState && structureState.active === true) {
    return [
      "The active structureRepairConvergence is constraining the next action surface.",
      allowedActionNames.length > 0
        ? `Choose an exposed structure repair action instead: ${allowedActionNames.join(", ")}.`
        : "Choose a structure repair action currently exposed by the planner action surface."
    ].join(" ");
  }

  return allowedActionNames.length > 0
    ? `Choose one of the currently exposed actions: ${allowedActionNames.join(", ")}.`
    : "No runtime-exposed plan action is currently available for that action name.";
}

function validateStitch(stitch) {
  if (stitch == null) {
    return { ok: true };
  }
  if (!stitch || typeof stitch !== "object" || Array.isArray(stitch)) {
    return { ok: false, error: "Plan stitch must be an object when provided." };
  }
  if (stitch.followups != null && !Array.isArray(stitch.followups)) {
    return { ok: false, error: "Plan stitch.followups must be a string array when provided." };
  }
  if (Array.isArray(stitch.followups) && stitch.followups.some((item) => typeof item !== "string")) {
    return { ok: false, error: "Plan stitch.followups must contain only strings." };
  }
  if (stitch.drill_hints != null && !Array.isArray(stitch.drill_hints)) {
    return { ok: false, error: "Plan stitch.drill_hints must be an array when provided." };
  }
  if (Array.isArray(stitch.drill_hints)) {
    for (let index = 0; index < stitch.drill_hints.length; index += 1) {
      const hint = stitch.drill_hints[index];
      if (!isDrillHint$1(hint)) {
        return {
          ok: false,
          error: `Plan stitch.drill_hints[${index}] requires match_header, label, and prompt strings.`
        };
      }
    }
  }
  if (stitch.result_budget != null) {
    if (typeof stitch.result_budget === "number") {
      if (!(stitch.result_budget > 0)) {
        return { ok: false, error: "Plan stitch.result_budget must be a positive number when provided." };
      }
    } else if (typeof stitch.result_budget === "object" && !Array.isArray(stitch.result_budget)) {
      const { total, per_action } = stitch.result_budget;
      if (total != null && !(typeof total === "number" && total > 0)) {
        return { ok: false, error: "Plan stitch.result_budget.total must be a positive number when provided." };
      }
      if (per_action != null && !(typeof per_action === "number" && per_action > 0)) {
        return { ok: false, error: "Plan stitch.result_budget.per_action must be a positive number when provided." };
      }
    } else {
      return { ok: false, error: "Plan stitch.result_budget must be a positive number or an object when provided." };
    }
  }
  return { ok: true };
}

function createActionContext(session) {
  return {
    activeAgentSkill: session.runState.agentSkillContext.activeSkill,
    agentSkillIndexProvider: session.runtimeConfig.agentSkillIndexProvider,
    agentSkills: Array.isArray(session.runtimeConfig.agentSkills) ? session.runtimeConfig.agentSkills : [],
    agentSkillContext: session.runState.agentSkillContext,
    debug: session.debug || null,
    request: session.request,
    runState: session.runState,
    runtimeConfig: session.runtimeConfig,
    pushStep: session.pushStep,
    searchResults: session.runState.researchContext.searchResults,
    webSearchEndpoint: readWebSearchEndpoint(session.rawInput, session.request)
  };
}

function isActionAvailable(actionName, availableActions) {
  return (Array.isArray(availableActions) ? availableActions : []).some(
    (action) => action && typeof action === "object" && readString$n(action.name) === actionName
  );
}

function readString$n(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray$1(value) {
  return Array.isArray(value) ? value.map(readString$n).filter(Boolean) : [];
}

function isDrillHint$1(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    Boolean(readString$n(value.match_header)) &&
    Boolean(readString$n(value.label)) &&
    Boolean(readString$n(value.prompt));
}

export { createActionContext, validatePlan };
