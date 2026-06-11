import { findAgentSkill, loadAgentSkillFromProvider, normalizeAgentSkill } from '../agent-skills.js';
import { STANDALONE_PLAN_ACTION } from '../action-plan-contract.js';
import { HANDOFF_CYCLE_KIND, readSkillIdentity, normalizeHandoffChain, detectHandoffCycle, createHandoffCycleDetail, HANDOFF_CYCLE_ERROR_CODE, buildNextHandoffChain } from '../handoff-chain.js';
import { cloneValue } from '../utils.js';

// ADR-0043 — handoff_to_skill action.
//
// Transfers control from the current skill to a named target skill in the
// same session loop. Distinct from spawn_subagent (which forks a child loop)
// and use_agent_skill (which loads a skill without a phase-boundary signal).
//
// The action stays pure — it does not import or mutate runState directly.
// State update (activeSkill + handoffContext + handoffChain) is handled by
// shared action-loop side-effect helpers, matching the pattern used for
// use_agent_skill.


const handoffToSkillAction = Object.freeze({
  description: "Transfer control to a named skill for the next phase of this session. Use when you are done with the current phase and the next phase requires a different skill's instructions.",
  name: "handoff_to_skill",
  plan: STANDALONE_PLAN_ACTION,
  planner: {
    aliases: ["transfer_to_skill", "switch_skill"],
    argsExample: {
      skillName: "expert-coder",
      handoffContext: "Research phase complete. 3 sources found. Now implement the fix.",
      inputFilter: {
        actionHistory: { keepLast: 3 },
        toolHistory: { keepLast: 0 }
      }
    },
    argsSchema: {
      skillName: { type: "string", required: true },
      handoffContext: { type: "string" },
      inputFilter: {
        aliases: ["input_filter"]
      }
    },
    decisionType: "action",
    guidance: "Use handoff_to_skill to pass control to a different skill when the current phase is complete and the next phase needs a different skill. Provide handoffContext to give the receiving skill a concise summary of what was accomplished and what to do next. Optionally include inputFilter as a named host filter or a declarative object such as {\"actionHistory\":{\"keepLast\":3},\"toolHistory\":{\"keepLast\":0}} to trim prior history before the receiving skill sees it. Do NOT use this for parallel sub-tasks — use spawn_subagent for those. Do NOT confuse with use_agent_skill, which only activates a skill's instructions in place WITHOUT transferring control or starting a new phase."
  },
  tier: 0,
  outputSchema: {
    kinds: ["agent_handoff", HANDOFF_CYCLE_KIND],
    controls: ["continue", "complete"]
  },
  execute: executeHandoffToSkill
});

async function executeHandoffToSkill(context, args) {
  const skillName = readString$K(args && (args.skillName || args.skill_name));
  const handoffContext = readString$K(args && (args.handoffContext || args.handoff_context));
  const inputFilter = readInputFilter(args && (args.inputFilter || args.input_filter));
  const skillContext = context && context.agentSkillContext && typeof context.agentSkillContext === "object"
    ? context.agentSkillContext
    : null;
  const fromSkill = readSkillIdentity(skillContext && skillContext.activeSkill);
  const handoffChain = normalizeHandoffChain(skillContext && skillContext.handoffChain, fromSkill);

  if (!skillName) {
    return {
      control: "continue",
      output: {
        kind: "agent_handoff",
        fromSkill,
        handoffChain,
        skill: null,
        handoffContext: handoffContext || null,
        inputFilter,
        error: {
          code: "HANDOFF_SKILL_NAME_MISSING",
          message: "handoff_to_skill requires a non-empty skillName."
        }
      },
      summary: "handoff_to_skill(?) -> HANDOFF_SKILL_NAME_MISSING"
    };
  }

  let targetSkill = null;

  if (context && context.agentSkills) {
    targetSkill = findAgentSkill(context.agentSkills, skillName);
  }

  if (!targetSkill && context && context.agentSkillIndexProvider) {
    targetSkill = await loadAgentSkillFromProvider(context.agentSkillIndexProvider, skillName);
  }

  if (!targetSkill) {
    return {
      control: "continue",
      output: {
        kind: "agent_handoff",
        fromSkill,
        handoffChain,
        skill: null,
        handoffContext: handoffContext || null,
        inputFilter,
        error: {
          code: "HANDOFF_SKILL_NOT_FOUND",
          message: `handoff_to_skill: skill "${skillName}" not found in bundled skills or provider.`
        }
      },
      summary: `handoff_to_skill(${skillName}) -> HANDOFF_SKILL_NOT_FOUND`
    };
  }

  const normalized = normalizeAgentSkill(targetSkill);
  const cycle = detectHandoffCycle(skillContext && skillContext.handoffChain, fromSkill, normalized);
  if (cycle) {
    const detail = createHandoffCycleDetail({
      cycle,
      fromSkill,
      requestedSkillName: skillName,
      targetSkill: normalized
    });
    if (context && typeof context.pushStep === "function") {
      context.pushStep(HANDOFF_CYCLE_KIND, detail);
    }
    return {
      control: "complete",
      output: {
        kind: HANDOFF_CYCLE_KIND,
        ...detail,
        skill: normalized,
        handoffContext: handoffContext || null,
        inputFilter,
        ok: false,
        status: "blocked",
        error: {
          code: HANDOFF_CYCLE_ERROR_CODE,
          message: `handoff_to_skill blocked a cycle: ${detail.cycleChain.join(" -> ")}.`
        }
      },
      summary: `handoff_to_skill(${normalized.name}) -> ${HANDOFF_CYCLE_ERROR_CODE}`
    };
  }
  const nextHandoffChain = buildNextHandoffChain(
    skillContext && skillContext.handoffChain,
    fromSkill,
    normalized
  );

  return {
    control: "continue",
    output: {
      kind: "agent_handoff",
      fromSkill,
      handoffChain: nextHandoffChain,
      skill: normalized,
      handoffContext: handoffContext || null,
      inputFilter,
      error: null
    },
    summary: `handoff_to_skill(${normalized.name})${handoffContext ? " with context" : ""}${inputFilter ? " with inputFilter" : ""}`
  };
}

function readString$K(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readInputFilter(value) {
  const name = readString$K(value);
  if (name) return name;
  return value && typeof value === "object" && !Array.isArray(value)
    ? cloneValue(value)
    : null;
}

export { executeHandoffToSkill, handoffToSkillAction };
