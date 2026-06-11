import { normalizeAgentSkill, loadAgentSkillFromProvider, findAgentSkill } from '../agent-skills.js';
import { getPolicyManifestForSkill, evaluateSkillPolicy, emitSkillPolicyStep, createSkillPolicyError } from '../skill-policy.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';

function createUseAgentSkillAction(agentSkills, agentSkillIndexProvider) {
  const firstSkill = Array.isArray(agentSkills) && agentSkills[0] ? agentSkills[0] : null;

  if (!firstSkill && !agentSkillIndexProvider) {
    return null;
  }

  return Object.freeze({
    description: "Activate the last-read bundled agent skill for this run.",
    name: "use_agent_skill",
    plan: STANDALONE_PLAN_ACTION,
    planner: {
      aliases: ["use_skill", "activate_skill"],
      argsExample: {
        skillName: firstSkill ? firstSkill.name : "skill-name"
      },
      argsSchema: {
        skillName: { type: "string", aliases: ["name"] }
      },
      decisionType: "action",
      guidance: "Use use_agent_skill only after read_agent_skill — it activates the LAST-read skill, so without a prior read there is nothing to activate. Use it when the user explicitly wants that bundled skill or when its instructions must stay active across later planner steps. This only loads instructions in place — it does NOT transfer control or start a new phase. To hand the wheel to a different skill for the next phase, use handoff_to_skill instead (which does its own skill lookup and needs no prior read)."
    },
    tier: 0,
    outputSchema: {
      kinds: ["agent_skill_activated"],
      controls: ["continue"]
    },
    execute: async (context, args) => {
      const requestedSkill = readString$O(args && (args.skillName || args.name));
      const lastReadSkill = context.agentSkillContext && context.agentSkillContext.lastReadSkill;
      const normalizedLastReadSkill = normalizeAgentSkill(lastReadSkill);
      let selectedSkill = !requestedSkill || matchesSkillName(normalizedLastReadSkill, requestedSkill)
        ? normalizedLastReadSkill
        : null;

      if (!selectedSkill && requestedSkill) {
        const manifest = await getPolicyManifestForSkill(context, requestedSkill);
        const earlyPolicyDecision = evaluateSkillPolicy({
          manifest,
          operation: "use",
          runtimeConfig: context.runtimeConfig,
          skillId: requestedSkill,
          skillName: requestedSkill
        });
        if (earlyPolicyDecision.action === "deny") {
          emitSkillPolicyStep(context.pushStep, "skill-policy-denied", earlyPolicyDecision);
          throw createSkillPolicyError(earlyPolicyDecision);
        }
      }

      if (!selectedSkill && context.agentSkillIndexProvider) {
        selectedSkill = await loadAgentSkillFromProvider(
          context.agentSkillIndexProvider,
          requestedSkill || readString$O(lastReadSkill && (lastReadSkill.skillId || lastReadSkill.name))
        );
      }

      if (!selectedSkill && requestedSkill) {
        selectedSkill = findAgentSkill(context.agentSkills, requestedSkill);
      }

      if (!selectedSkill) {
        throw new Error("No bundled agent skill is available to activate.");
      }

      const manifest = await getPolicyManifestForSkill(context, selectedSkill.skillId || selectedSkill.name);
      const policyDecision = evaluateSkillPolicy({
        manifest: manifest || selectedSkill,
        operation: "use",
        runtimeConfig: context.runtimeConfig,
        skill: selectedSkill,
        skillId: selectedSkill.skillId,
        skillName: selectedSkill.name
      });
      if (policyDecision.action === "deny") {
        emitSkillPolicyStep(context.pushStep, "skill-policy-denied", policyDecision);
        throw createSkillPolicyError(policyDecision);
      }
      if (policyDecision.action === "ask") {
        context.agentSkillContext.pendingSkillPolicy = policyDecision;
      }

      if (!lastReadSkill || lastReadSkill.name !== selectedSkill.name) {
        context.agentSkillContext.lastReadSkill = selectedSkill;
      }

      return {
        control: "continue",
        output: {
          kind: "agent_skill_activated",
          skill: selectedSkill
        },
        summary: `use_agent_skill(${selectedSkill.name})`
      };
    }
  });
}

function readString$O(value) {
  return typeof value === "string" ? value.trim() : "";
}

function matchesSkillName(skill, requestedSkill) {
  const target = readString$O(requestedSkill).toLowerCase();
  if (!skill || !target) return false;
  return readString$O(skill.name).toLowerCase() === target ||
    readString$O(skill.skillId).toLowerCase() === target;
}

export { createUseAgentSkillAction };
