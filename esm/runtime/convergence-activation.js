// AGRUN-313 R1/H2 — generic evidence-convergence activation detector (relocated out of
// research-state.js in R1; the legacy mode flag removed in H2). GENERIC infrastructure,
// not research behavior. (The `isResearchQualityGateRequired` NAME is kept as a back-compat
// alias — the rename to `isQualityGateRequired` is deferred to a breaking bump, R-a.)
//
// AGRUN-313 H2 — evidence-convergence activation is now SOLELY capability-driven
// (name-free). The legacy `researchActivation` MODE flag was removed
// (breaking serialization/input change): the kernel no longer knows a "long research"
// mode by name. A skill that needs long-running convergence declares the generic
// `requiresEvidenceConvergence` capability (it ships in @agrun/skills-research); the
// capability rides on the engaged skill OBJECT (agentSkillContext.activeSkill /
// lastReadSkill, co-populated when the agent engages the skill via use_agent_skill /
// read_agent_skill). This is the same object-capability mechanism
// isPublishReadinessSkillActive relies on.
function isEvidenceConvergenceRun(runState, options) {
  const context = runState && typeof runState === "object" ? runState.agentSkillContext : null;
  const capabilityCarriers = [
    context && context.activeSkill,
    context && context.lastReadSkill,
    options && options.activeAgentSkill,
    options && options.lastReadAgentSkill
  ];
  return capabilityCarriers.some((skill) => readSkillCapability(skill, "requiresEvidenceConvergence"));
}

function isResearchQualityGateRequired(runState, options = {}) {
  return isEvidenceConvergenceRun(runState, options);
}

function readSkillCapability(value, capability) {
  return !!(
    value &&
    typeof value === "object" &&
    value.capabilities &&
    typeof value.capabilities === "object" &&
    value.capabilities[capability] === true
  );
}

export { isEvidenceConvergenceRun, isResearchQualityGateRequired };
