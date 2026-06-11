import { listSkillManifests, createAgentSkillSummary } from '../agent-skills.js';
import { filterAvailableSkillManifests } from '../skill-policy.js';
import { LIST_SKILLS_BUDGET_PER_TURN, applyListSkillsQuery } from './list-agent-skills-search.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';

function createListAgentSkillsAction(agentSkills, agentSkillIndexProvider) {
  const skills = Array.isArray(agentSkills) ? agentSkills : [];

  if (skills.length === 0 && !agentSkillIndexProvider) {
    return null;
  }

  return Object.freeze({
    description: "List bundled agent skills available from skills/*/SKILL.md. Optional `query` filters by substring match against name, description, and tags.",
    name: "list_agent_skills",
    plan: STANDALONE_PLAN_ACTION,
    planner: {
      aliases: ["list_skills", "skill_catalog"],
      argsExample: { query: "research" },
      argsSchema: {
        query: {
          type: "string",
          required: false,
          description: "Optional capability keyword to filter the skill catalog (substring match)."
        }
      },
      decisionType: "action",
      guidance: "Call list_agent_skills (alias: list_skills) to discover skills relevant to the user's task. Pass a capability keyword like 'research', 'debug', or 'plan' as `query`. Iterate from simple to specific keywords if needed (max 5 calls per turn). Once you find a fit, call read_agent_skill to load its full instructions."
    },
    tier: 0,
    outputSchema: {
      kinds: ["agent_skill_catalog"],
      controls: ["continue"],
      metrics: { resultCount: "count" }
    },
    execute: async (context, actionArgs) => {
      // ADR-0013: 5-turn budget guard prevents infinite skill-discovery loops.
      // Counter lives on agentSkillContext (mechanism, not policy).
      const skillContext = context.agentSkillContext || {};
      const callsThisTurn = (skillContext.listSkillsCallsThisTurn || 0) + 1;
      if (context.agentSkillContext) {
        context.agentSkillContext.listSkillsCallsThisTurn = callsThisTurn;
      }
      if (callsThisTurn > LIST_SKILLS_BUDGET_PER_TURN) {
        return {
          control: "continue",
          output: {
            count: 0,
            kind: "agent_skill_catalog",
            skills: [],
            error: "skill_search_budget_exceeded",
            error_detail: `list_agent_skills called ${callsThisTurn} times this turn; max is ${LIST_SKILLS_BUDGET_PER_TURN}. Proceed with general tools or call read_agent_skill on a previously-listed skill.`
          },
          summary: `list_agent_skills -> budget exceeded (${callsThisTurn}/${LIST_SKILLS_BUDGET_PER_TURN})`
        };
      }

      const manifests = context.agentSkillIndexProvider
        ? await listSkillManifests(context.agentSkillIndexProvider)
        : skills.map(createAgentSkillSummary).filter(Boolean);
      const policyFiltered = filterAvailableSkillManifests(manifests, context.runtimeConfig, { operation: "list" });
      if (policyFiltered.filteredCount > 0 && typeof context.pushStep === "function") {
        context.pushStep("skill-policy-filtered", {
          filteredCount: policyFiltered.filteredCount,
          reasons: policyFiltered.reasons
        });
      }

      const { query, matches, moreAvailable } = applyListSkillsQuery(policyFiltered.filtered, actionArgs);

      return {
        control: "continue",
        output: {
          count: matches.length,
          kind: "agent_skill_catalog",
          query: query || null,
          skills: matches,
          ...(moreAvailable ? { more_available: true } : {})
        },
        summary: query
          ? `list_agent_skills(query="${query}") -> ${matches.length} skill(s)${moreAvailable ? " (truncated)" : ""}`
          : `list_agent_skills -> ${matches.length} skill(s)`
      };
    }
  });
}

export { createListAgentSkillsAction };
