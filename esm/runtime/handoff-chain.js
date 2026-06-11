const HANDOFF_CYCLE_ERROR_CODE = "HANDOFF_CYCLE_DETECTED";
const HANDOFF_CYCLE_KIND = "agent_handoff_cycle_detected";

function readSkillIdentity(skill) {
  if (typeof skill === "string") {
    return readString$_(skill);
  }
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
    return null;
  }
  return readString$_(skill.skillId) || readString$_(skill.name) || null;
}

function normalizeHandoffChain(value, currentSkill) {
  const chain = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const skill = readSkillIdentity(entry);
      if (skill) chain.push(skill);
    }
  }

  const current = readSkillIdentity(currentSkill);
  if (current && !chain.some((entry) => sameSkillIdentity(entry, current))) {
    chain.push(current);
  }
  return chain;
}

function buildNextHandoffChain(value, fromSkill, targetSkill) {
  const chain = normalizeHandoffChain(value, fromSkill);
  const target = readSkillIdentity(targetSkill);
  if (target) chain.push(target);
  return chain;
}

function detectHandoffCycle(value, fromSkill, targetSkill) {
  const chain = normalizeHandoffChain(value, fromSkill);
  const target = readSkillIdentity(targetSkill);
  if (!target) {
    return null;
  }

  const repeatedSkillIndex = chain.findIndex((entry) => sameSkillIdentity(entry, target));
  if (repeatedSkillIndex < 0) {
    return null;
  }

  return {
    cycleChain: [...chain, target],
    handoffChain: chain,
    repeatedSkill: chain[repeatedSkillIndex],
    repeatedSkillIndex,
    targetSkill: target
  };
}

function createHandoffCycleDetail({ fromSkill, requestedSkillName, targetSkill, cycle }) {
  const safeCycle = cycle && typeof cycle === "object" ? cycle : {};
  const target = readSkillIdentity(targetSkill) || readString$_(safeCycle.targetSkill) || readString$_(requestedSkillName) || null;
  return {
    cycleChain: normalizeHandoffChain(safeCycle.cycleChain, null),
    fromSkill: readString$_(fromSkill) || null,
    handoffChain: normalizeHandoffChain(safeCycle.handoffChain, null),
    reason: "handoff_cycle_detected",
    repeatedSkill: readString$_(safeCycle.repeatedSkill) || target,
    repeatedSkillIndex: Number.isInteger(safeCycle.repeatedSkillIndex)
      ? safeCycle.repeatedSkillIndex
      : null,
    requestedSkillName: readString$_(requestedSkillName) || null,
    targetSkill: target
  };
}

function sameSkillIdentity(a, b) {
  const left = readString$_(a).toLowerCase();
  const right = readString$_(b).toLowerCase();
  return !!left && left === right;
}

function readString$_(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { HANDOFF_CYCLE_ERROR_CODE, HANDOFF_CYCLE_KIND, buildNextHandoffChain, createHandoffCycleDetail, detectHandoffCycle, normalizeHandoffChain, readSkillIdentity };
