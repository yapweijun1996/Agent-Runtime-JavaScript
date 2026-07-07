import { listSkillManifests, createAgentSkillSummary } from '../agent-skills.js';
import { filterAvailableSkillManifests } from '../skill-policy.js';
import { LIST_SKILLS_MAX_RESULTS, LIST_SKILLS_BUDGET_PER_TURN, applyListSkillsQuery, createCompactSkillCatalogEntry } from './list-agent-skills-search.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';

function createListAgentSkillsAction(agentSkills, agentSkillIndexProvider) {
  const skills = Array.isArray(agentSkills) ? agentSkills : [];

  if (skills.length === 0 && !agentSkillIndexProvider) {
    return null;
  }

  return Object.freeze({
    description: `List bundled agent skills available from skills/*/SKILL.md. Optional \`query\` filters by substring match against name, description, tags, and inputTypes. Returns a compact catalog (name, description, tags, tool names) — call read_agent_skill for a skill's full instructions and tool schemas. Returns at most ${LIST_SKILLS_MAX_RESULTS} skills per call; when \`more_available\` is true, pass \`offset\` (a multiple of ${LIST_SKILLS_MAX_RESULTS}) to page through the rest, or narrow with \`query\`.`,
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
        },
        offset: {
          type: "number",
          required: false,
          description: `Skip this many matches before returning the next page of up to ${LIST_SKILLS_MAX_RESULTS}. Use when a previous call returned more_available:true.`
        }
      },
      decisionType: "action",
      guidance: `Call list_agent_skills (alias: list_skills) to discover skills relevant to the user's task. Pass a capability keyword like 'research', 'debug', or 'plan' as \`query\`. Iterate from simple to specific keywords if needed (max 5 calls per turn). Results are capped at ${LIST_SKILLS_MAX_RESULTS} per call — if more_available is true, either narrow the query or call again with offset:${LIST_SKILLS_MAX_RESULTS} to see the next page. Once you find a fit, call read_agent_skill to load its full instructions.`
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

      const { query, offset, matches, moreAvailable, totalMatches } = applyListSkillsQuery(policyFiltered.filtered, actionArgs);
      // AGRUN-623: compact catalog entries only — full tool schemas in the
      // catalog observation truncated after the first skill at 20+ skills,
      // hiding every other skill NAME from the planner. Per-skill detail
      // lives in read_agent_skill.
      const catalogEntries = matches.map(createCompactSkillCatalogEntry).filter(Boolean);

      return {
        control: "continue",
        output: {
          count: catalogEntries.length,
          kind: "agent_skill_catalog",
          query: query || null,
          offset,
          totalMatches,
          skills: catalogEntries,
          ...(moreAvailable ? { more_available: true, next_offset: offset + catalogEntries.length } : {})
        },
        summary: `list_agent_skills(${query ? `query="${query}", ` : ""}offset=${offset}) -> ${catalogEntries.length}/${totalMatches} skill(s)${moreAvailable ? " (more_available)" : ""}`
      };
    }
  });
}

export { createListAgentSkillsAction };
