import { askClarificationAction } from './actions/ask-clarification-action.js';
import { createExecuteSkillToolAction } from './actions/execute-skill-tool-action.js';
import { createListAgentSkillsAction } from './actions/list-agent-skills-action.js';
import { createReadAgentSkillAction } from './actions/read-agent-skill-action.js';
import { readUrlAction } from './actions/read-url-action.js';
import { todoPlanAction, todoAdvanceAction, todoCancelAction, todoRunNextAction, todoInspectAction } from './actions/todo-actions.js';
import { createUseAgentSkillAction } from './actions/use-agent-skill-action.js';
import { workspaceListAction, workspaceReadAction, workspaceWriteAction, workspaceReplaceAction, workspaceProposePatchAction, workspaceApplyPatchAction, workspaceInsertAfterSectionAction, workspaceRemoveAction, workspaceMoveAction, workspaceMultiEditAction, workspaceFinalizeCandidateAction, workspaceReviewCandidateAction, workspacePublishCandidateAction } from './actions/virtual-workspace-actions.js';
import { createRepoSearchAction, createRepoReadFileAction } from './actions/repo-file-actions.js';
import { handoffToSkillAction } from './actions/handoff-to-skill-action.js';
import { spawnSubagentAction } from './actions/spawn-subagent-action.js';
import { webSearchAction } from './actions/web-search-action.js';
import { assertPlannerActionArgsContract } from './action-args-validation.js';
import { assertActionOutputContract } from './action-output-contract.js';
import { normalizeActionTimeoutMs, normalizeActionTimeoutBehavior } from './tool-schema.js';

function createActionRegistry(options = {}) {
  const customActions = Array.isArray(options.customActions) ? options.customActions : [];
  const bundled = buildActions({
    agentSkillIndexProvider: options.agentSkillIndexProvider,
    agentSkills: options.agentSkills,
    repoFileTools: options.repoFileTools,
    toolCallExamples: options.toolCallExamples,
    customActionNames: customActions.map((action) => action && action.name).filter(Boolean)
  });
  const bundledNames = new Set(bundled.map((action) => action.name));
  for (const custom of customActions) {
    if (bundledNames.has(custom.name)) {
      throw new Error(
        `createActionRegistry: customActions name "${custom.name}" collides with a bundled action. Pick a host-namespaced name (e.g. "host_${custom.name}").`
      );
    }
  }
  const actions = bundled.concat(customActions).map(withActionMetadata);
  assertPlannerActionArgsContract(actions);
  assertActionOutputContract(actions);
  const index = new Map(actions.map((action) => [action.name, action]));

  return {
    get(name) {
      return index.get(name) || null;
    },

    list() {
      return actions.map(toPublicAction);
    },

    listForPlanner() {
      return actions
        .filter((action) => action.planner !== false)
        .map(toPlannerAction);
    }
  };
}

function buildActions(options) {
  const agentSkills = options && options.agentSkills;
  const agentSkillIndexProvider = options && options.agentSkillIndexProvider;
  const toolCallExamples = options && options.toolCallExamples;
  const repoFileTools = options && options.repoFileTools;
  const skillCatalogActions = [
    createListAgentSkillsAction(agentSkills, agentSkillIndexProvider),
    createReadAgentSkillAction(agentSkills, agentSkillIndexProvider),
    createUseAgentSkillAction(agentSkills, agentSkillIndexProvider)
  ].filter(Boolean);
  const runtimeActions = [
    webSearchAction,
    readUrlAction,
    handoffToSkillAction,
    spawnSubagentAction,
    todoPlanAction,
    todoAdvanceAction,
    todoCancelAction,
    todoRunNextAction,
    todoInspectAction,
    workspaceListAction,
    workspaceReadAction,
    workspaceWriteAction,
    workspaceReplaceAction,
    workspaceProposePatchAction,
    workspaceApplyPatchAction,
    workspaceInsertAfterSectionAction,
    workspaceRemoveAction,
    workspaceMoveAction,
    workspaceMultiEditAction,
    workspaceFinalizeCandidateAction,
    workspaceReviewCandidateAction,
    workspacePublishCandidateAction,
    createRepoSearchAction(repoFileTools),
    createRepoReadFileAction(repoFileTools),
    askClarificationAction
  ].filter(Boolean);
  const reservedActionNames = [
    ...skillCatalogActions,
    ...runtimeActions,
    ...(Array.isArray(options && options.customActionNames) ? options.customActionNames : [])
  ].map((action) => typeof action === "string" ? action : action && action.name).filter(Boolean);
  return [
    ...skillCatalogActions,
    createExecuteSkillToolAction(agentSkills, agentSkillIndexProvider, toolCallExamples, {
      reservedActionNames
    }),
    ...runtimeActions
  ].filter(Boolean);
}

function toPublicAction(action) {
  return {
    description: action.description,
    name: action.name,
    permission: clonePermission(action.permission),
    tier: action.tier,
    timeoutBehavior: action.timeoutBehavior,
    timeoutMs: action.timeoutMs
  };
}

function toPlannerAction(action) {
  const plannerAction = {
    aliases: Array.isArray(action.planner && action.planner.aliases)
      ? action.planner.aliases.slice()
      : [],
    argsExample: cloneArgsExample(action.planner && action.planner.argsExample),
    argsSchema: cloneArgsSchema(action.planner && action.planner.argsSchema),
    decisionType: action.planner && action.planner.decisionType
      ? action.planner.decisionType
      : "action",
    description: action.description,
    guidance: action.planner && action.planner.guidance
      ? action.planner.guidance
      : null,
    name: action.name,
    permission: clonePermission(action.permission),
    tier: action.tier
  };
  const planContract = clonePlanContract(action.plan);
  if (planContract) {
    plannerAction.plan = planContract;
  }

  if (Array.isArray(action.planner && action.planner.extraExamples) && action.planner.extraExamples.length > 0) {
    plannerAction.extraExamples = action.planner.extraExamples;
  }

  return plannerAction;
}

const BUILT_IN_PERMISSION_METADATA = Object.freeze({
  ask_clarification: readOnlyPermission("conversation", false),
  execute_skill_tool: dynamicPermission("skill_tool"),
  list_agent_skills: readOnlyPermission("skill_catalog", false),
  read_agent_skill: readOnlyPermission("skill_catalog", false),
  read_url: readOnlyPermission("external_network", true),
  repo_read_file: readOnlyPermission("host_repo", true),
  repo_rg: readOnlyPermission("host_repo", true),
  handoff_to_skill: virtualMutationPermission("agent_skill_selection"),
  spawn_subagent: dynamicPermission("subagent_run"),
  todo_advance: virtualMutationPermission("todo_state"),
  todo_cancel: virtualMutationPermission("todo_state"),
  todo_inspect: readOnlyPermission("todo_state", false),
  todo_plan: virtualMutationPermission("todo_state"),
  todo_run_next: virtualMutationPermission("todo_state"),
  use_agent_skill: virtualMutationPermission("agent_skill_selection"),
  web_search: readOnlyPermission("external_network", true),
  workspace_apply_patch: virtualMutationPermission("virtual_workspace"),
  workspace_finalize_candidate: virtualMutationPermission("virtual_workspace"),
  workspace_insert_after_section: virtualMutationPermission("virtual_workspace"),
  workspace_list: readOnlyPermission("virtual_workspace", false),
  workspace_move: virtualMutationPermission("virtual_workspace"),
  workspace_multi_edit: virtualMutationPermission("virtual_workspace"),
  workspace_propose_patch: readOnlyPermission("virtual_workspace", false),
  workspace_publish_candidate: virtualMutationPermission("virtual_workspace"),
  workspace_read: readOnlyPermission("virtual_workspace", false),
  workspace_remove: virtualMutationPermission("virtual_workspace"),
  workspace_replace: virtualMutationPermission("virtual_workspace"),
  workspace_review_candidate: virtualMutationPermission("virtual_workspace"),
  workspace_write: virtualMutationPermission("virtual_workspace")
});

function withActionMetadata(action) {
  if (!action || typeof action !== "object") return action;
  return Object.freeze({
    ...action,
    timeoutBehavior: normalizeActionTimeoutBehavior(action.timeoutBehavior),
    timeoutMs: normalizeActionTimeoutMs(action.timeoutMs),
    permission: normalizePermissionMetadata(action)
  });
}

function normalizePermissionMetadata(action) {
  const override = BUILT_IN_PERMISSION_METADATA[action.name] || {};
  const source = action.permission && typeof action.permission === "object" && !Array.isArray(action.permission)
    ? action.permission
    : {};
  const merged = { ...override, ...source };
  const tierNeedsApproval = action.tier === 1 || action.tier === 2 || action.tier === 3;
  return {
    effect: readString$G(merged.effect) || "runtime_action",
    interruptBehavior: readString$G(merged.interruptBehavior) || "abort_safe",
    isConcurrencySafe: readBoolean$1(merged.isConcurrencySafe, false),
    isDestructive: readBoolean$1(merged.isDestructive, false),
    isReadOnly: readBoolean$1(merged.isReadOnly, false),
    needsApproval: readBoolean$1(merged.needsApproval, tierNeedsApproval),
    source: readString$G(merged.source) || "built_in_metadata"
  };
}

function readOnlyPermission(effect, needsApproval) {
  return Object.freeze({
    effect,
    interruptBehavior: "abort_safe",
    isConcurrencySafe: true,
    isDestructive: false,
    isReadOnly: true,
    needsApproval,
    source: "built_in_metadata"
  });
}

function virtualMutationPermission(effect) {
  return Object.freeze({
    effect,
    interruptBehavior: "checkpoint_required",
    isConcurrencySafe: false,
    isDestructive: false,
    isReadOnly: false,
    needsApproval: false,
    source: "built_in_metadata"
  });
}

function dynamicPermission(effect) {
  return Object.freeze({
    effect,
    interruptBehavior: "checkpoint_required",
    isConcurrencySafe: false,
    isDestructive: false,
    isReadOnly: false,
    needsApproval: false,
    source: "dynamic_action_metadata"
  });
}

function clonePermission(value) {
  return value && typeof value === "object" ? { ...value } : null;
}

function readBoolean$1(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function readString$G(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clonePlanContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const contract = {};
  if (typeof value.allowedInPlan === "boolean") contract.allowedInPlan = value.allowedInPlan;
  if (typeof value.reason === "string") contract.reason = value.reason;
  if (typeof value.code === "string") contract.code = value.code;
  if (typeof value.detail === "string") contract.detail = value.detail;
  return Object.keys(contract).length > 0 ? contract : null;
}

function cloneArgsExample(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function cloneArgsSchema(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const schema = {};
  for (const [key, rule] of Object.entries(value)) {
    const entry = cloneArgsSchemaRule(rule);
    if (entry) schema[key] = entry;
  }
  return schema;
}

function cloneArgsSchemaRule(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  const entry = {};
  if (typeof rule.type === "string") entry.type = rule.type;
  if (rule.required === true) entry.required = true;
  if (typeof rule.description === "string") entry.description = rule.description;
  if (Array.isArray(rule.aliases)) {
    entry.aliases = rule.aliases.filter((alias) => typeof alias === "string");
  }
  if (Array.isArray(rule.required)) {
    entry.required = rule.required.filter((key) => typeof key === "string" && key.trim());
  }
  const properties = cloneArgsSchema(rule.properties);
  if (Object.keys(properties).length > 0) {
    entry.properties = properties;
  }
  if (rule.items && typeof rule.items === "object" && !Array.isArray(rule.items)) {
    const items = cloneArgsSchemaRule(rule.items);
    if (items) entry.items = items;
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

export { createActionRegistry };
