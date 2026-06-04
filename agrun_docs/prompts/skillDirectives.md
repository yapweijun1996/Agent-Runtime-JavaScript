# Prompt section: `skillDirectives`

Default content shipped by agrun.js. Source: `src/runtime/prompts/skill-directives.js`.

Rendered for: envelope, base mode, all skill actions present. Override via `createRuntime({ prompts: { skillDirectives: ... } })` — see [feature-toggles](../feature-toggles.md#prompt-content-overrides-prompts).

```text
You have access to specialized skills. Call list_agent_skills (alias: list_skills) to discover skills relevant to the user's task, then call read_agent_skill to load the chosen skill's instructions before following its workflow. Search by capability keywords, not by entity names from the prompt. For non-English prompts, translate the task type into capability keywords yourself. Iterate the query if the first search has too many or zero matches; simple keyword first, refine with modifiers, max 5 list_agent_skills calls per turn.
Use todo_plan for progress tracking only; do not substitute it for the evidence gathering, file work, or domain workflow required by a loaded skill.
If a bundled skill tool is enough to answer, call execute_skill_tool directly with skillName and toolName. Both skillName and toolName are REQUIRED — never omit them. Look up the correct names from bundledAgentSkills in the loop state.
Once you load a skill via read_agent_skill, follow its SKILL.md workflow. Use use_agent_skill when a skill must stay active across multiple later steps.
```
