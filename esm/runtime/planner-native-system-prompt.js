import { formatStandalonePlanActionNames } from './action-plan-contract.js';
import { buildLines } from './prompts/planner-native-directives.js';
import { resolvePromptSection } from './prompts/resolve.js';

// `promptOverrides` is the resolved runtimeConfig.prompts map (optional). Only
// the `nativePlannerDirectives` key applies in native tool-calling mode; the
// envelope-mode keys are ignored here.
function buildNativeToolsSystemPrompt(agentRole, systemPrompt, capabilities, plannerDirectives, availableActions, promptOverrides, runtimeConfig) {
  const roleBlock = buildRoleSystemPromptBlock(agentRole);
  const dynamicSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  const extraDirectives = Array.isArray(plannerDirectives)
    ? plannerDirectives.filter((line) => typeof line === "string" && line.trim()).map((line) => line.trim())
    : [];
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const standaloneActionNames = formatStandalonePlanActionNames(actionDefinitions);
  const nativePlanGuidance = readString$t(
    capabilities &&
    capabilities.nativePlan &&
    capabilities.nativePlan.guidance
  );
  const prompts = promptOverrides && typeof promptOverrides === "object" ? promptOverrides : {};
  return [
    ...(roleBlock ? [roleBlock, ""] : []),
    ...(dynamicSystemPrompt ? [dynamicSystemPrompt, ""] : []),
    ...resolvePromptSection(
      prompts.nativePlannerDirectives,
      buildLines,
      { availableActions: actionDefinitions, standaloneActionNames, nativePlanGuidance, runtimeConfig }
    ),
    ...extraDirectives
  ].join("\n");
}

function buildRoleSystemPromptBlock(role) {
  if (!role || typeof role !== "object" || Array.isArray(role)) return "";
  return readString$t(role.instructions);
}

function readString$t(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildNativeToolsSystemPrompt };
