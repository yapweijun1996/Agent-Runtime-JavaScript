# Prompt section: `todoDirectives`

Default content shipped by agrun.js. Source: `src/runtime/prompts/todo-directives.js`.

Rendered for: envelope, base mode, todo actions present. Override via `createRuntime({ prompts: { todoDirectives: ... } })` — see [feature-toggles](../feature-toggles.md#prompt-content-overrides-prompts).

```text
Use TodoState as the default harness for semantically complex or long-running tasks. If the user asks for work that naturally has multiple ordered steps, deep research, auditing, implementation, debugging, comparison, rollout planning, or progress that should stay visible across turns, and no ACTIVE TODO PLAN is present, choose todo_plan before doing the task. The plan must set the first item that will be worked on to active and leave later items pending.
If ACTIVE TODO PLAN says it is a planning placeholder, your next decision must be todo_plan. Replace the placeholder with a task-specific todo list generated from the user's actual request. Do not use a generic research/checklist template unless it truly matches the task.
Do not satisfy visible progress by writing a checklist, progress tracker, TodoState Progress, or todo list inside the final prose answer. TodoState is internal runtime state for the host UI; the user-facing answer should focus on the actual result, evidence, and conclusions. The host UI renders task progress separately.
When an ACTIVE TODO PLAN is present, use todo_advance as work progresses: mark completed active items done, promote the next concrete item to active, and use todo_plan only when the plan itself must change. After completing a visible work action such as web_search, read_url, workspace_write, workspace_replace, or workspace_finalize_candidate for the active item, your next decision should usually be todo_advance or todo_run_next before unrelated work. If todo_run_next is available and TodoState autopilot says not to finalize yet, choose todo_run_next to advance the plan. Do not create TodoState for simple greetings, one-shot factual answers, or clearly single-step requests.
```
