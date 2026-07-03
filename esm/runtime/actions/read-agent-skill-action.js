import { loadAgentSkillFromProvider, findAgentSkill, createAgentSkillSummary } from '../agent-skills.js';
import { getPolicyManifestForSkill, evaluateSkillPolicy, emitSkillPolicyStep, createSkillPolicyError } from '../skill-policy.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';
import { readString } from '../semantic-json.js';

function createReadAgentSkillAction(agentSkills, agentSkillIndexProvider) {
  const firstSkill = Array.isArray(agentSkills) && agentSkills[0] ? agentSkills[0] : null;

  if (!firstSkill && !agentSkillIndexProvider) {
    return null;
  }

  return Object.freeze({
    description: "Read one bundled agent skill document before using it.",
    name: "read_agent_skill",
    plan: STANDALONE_PLAN_ACTION,
    planner: {
      aliases: ["read_skill", "inspect_skill"],
      argsExample: {
        skillName: firstSkill ? firstSkill.name : "skill-name"
      },
      argsSchema: {
        skillName: { type: "string", required: true, aliases: ["name"] }
      },
      decisionType: "action",
      guidance: "Use read_agent_skill when the user explicitly asks for a bundled skill or when the skill instructions are needed before answering."
    },
    tier: 0,
    outputSchema: {
      kinds: ["agent_skill_document"],
      controls: ["continue"]
    },
    execute: async (context, args) => {
      const requestedSkill = readString(args && (args.skillName || args.name));
      const manifest = await getPolicyManifestForSkill(context, requestedSkill);
      const policyDecision = evaluateSkillPolicy({
        manifest,
        operation: "read",
        runtimeConfig: context.runtimeConfig,
        skillId: requestedSkill,
        skillName: requestedSkill
      });
      if (policyDecision.action === "deny") {
        emitSkillPolicyStep(context.pushStep, "skill-policy-denied", policyDecision);
        throw createSkillPolicyError(policyDecision);
      }
      const skill = context.agentSkillIndexProvider
        ? await loadAgentSkillFromProvider(context.agentSkillIndexProvider, requestedSkill)
        : findAgentSkill(context.agentSkills, requestedSkill);

      if (!skill) {
        throw new Error(`Unknown bundled agent skill "${requestedSkill || "unknown"}".`);
      }

      return {
        control: "continue",
        output: {
          kind: "agent_skill_document",
          skill,
          summary: createAgentSkillSummary(skill)
        },
        summary: `read_agent_skill(${skill.name})`
      };
    }
  });
}

export { createReadAgentSkillAction };
