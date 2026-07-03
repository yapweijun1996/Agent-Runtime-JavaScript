import { readString } from './semantic-json.js';

const STANDALONE_PLAN_ACTION = Object.freeze({
  allowedInPlan: false,
  reason: "state_mutation"
});

function readPlanActionContract(action) {
  const plan = action && typeof action === "object" && action.plan && typeof action.plan === "object"
    ? action.plan
    : null;
  if (plan && plan.allowedInPlan === false) {
    return {
      allowedInPlan: false,
      code: readString(plan.code) || "skill_mutator_in_plan",
      detail: readString(plan.detail) || createStandaloneActionDetail(action),
      reason: readString(plan.reason) || "state_mutation"
    };
  }
  return {
    allowedInPlan: true,
    code: "",
    detail: "",
    reason: ""
  };
}

function formatStandalonePlanActionNames(actions) {
  const names = (Array.isArray(actions) ? actions : [])
    .filter((action) => readPlanActionContract(action).allowedInPlan === false)
    .map((action) => readString(action && action.name))
    .filter(Boolean);
  return names.length > 0 ? names.join(", ") : "actions marked standalone-only";
}

function createStandaloneActionDetail(action) {
  const actionName = readString(action && action.name) || "This action";
  return `${actionName} is marked standalone-only by its action metadata because it mutates planner/run state. Emit it as its own type:"action" envelope instead of placing it inside plan.actions. If you need more work after it runs, wait for the observation and choose the next action in the following OODAE cycle.`;
}

export { STANDALONE_PLAN_ACTION, formatStandalonePlanActionNames, readPlanActionContract };
