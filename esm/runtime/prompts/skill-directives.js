// ADR-0035 (AGRUN-262) — skill-discovery planner directives.
// Extracted verbatim from planner-prompt.js buildSystemPromptLines (the
// list_agent_skills / execute_skill_tool / use_agent_skill blocks). Each line
// is gated on the action's presence, so a host that disables a skill action
// never sees a directive naming it. Host override key: `skillDirectives`.
// Default output is byte-identical (locked by test/unit/prompt-snapshot.test.js).
function buildLines$6({ availableActions, compactSystemPrompt } = {}) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const hasAction = (name) => actionDefinitions.some((action) => action.name === name);
  const lines = [];

  if (hasAction("list_agent_skills")) {
    if (compactSystemPrompt) {
      lines.push("When a specialized skill would improve quality, discover and read it before using domain tools.");
    } else {
      lines.push("You have access to specialized skills. Call list_agent_skills (alias: list_skills) to discover skills relevant to the user's task, then call read_agent_skill to load the chosen skill's instructions before following its workflow. Search by capability keywords, not by entity names from the prompt. For non-English prompts, translate the task type into capability keywords yourself. Iterate the query if the first search has too many or zero matches; simple keyword first, refine with modifiers, max 5 list_agent_skills calls per turn.");
      lines.push("Use todo_plan for progress tracking only; do not substitute it for the evidence gathering, file work, or domain workflow required by a loaded skill.");
    }
  }

  if (hasAction("execute_skill_tool")) {
    lines.push(compactSystemPrompt
      ? "If using execute_skill_tool, include both required fields: skillName and toolName."
      : "If a bundled skill tool is enough to answer, call execute_skill_tool directly with skillName and toolName. Both skillName and toolName are REQUIRED — never omit them. Look up the correct names from bundledAgentSkills in the loop state.");
  }

  if (!compactSystemPrompt && hasAction("use_agent_skill")) {
    lines.push("Once you load a skill via read_agent_skill, follow its SKILL.md workflow. Use use_agent_skill when a skill must stay active across multiple later steps.");
  }

  return lines;
}

export { buildLines$6 as buildLines };
