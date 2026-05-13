# agrun.js Admin Workspace Skill Action Contract

## Purpose

This document defines the action contract for the **admin workspace skill source**.

It fixes the runtime-facing wire shapes for:

- `list_workspace_skills`
- `read_workspace_skill`
- `use_workspace_skill`
- `validate_workspace_skill`
- `publish_workspace_skill`

This document is intentionally narrower than `agrun_docs/admin-workspace-skill-source.md`.

- `agrun_docs/admin-workspace-skill-source.md` defines source boundaries, UI behavior, and lifecycle
- this document defines action names, inputs, outputs, state flow, and failure codes

## Scope

These actions apply only to the admin workspace skill source.

They do not replace the existing merged catalog actions:

- `list_agent_skills`
- `read_agent_skill`
- `use_agent_skill`

Rules:

- workspace actions are source-specific
- merged catalog actions remain source-agnostic
- default end-user planning should continue to use merged catalog actions only
- admin mode may expose workspace actions to planner or admin tooling

## Workspace Path Contract

The admin workspace source uses this path shape:

```text
/.agrun/skills/<skill-name>/SKILL.md
```

Rules:

- `skillName` is the stable identifier
- actions do not accept raw file paths from planner
- runtime derives `workspacePath` from `skillName`
- only `SKILL.md` files in this path shape are considered workspace skills

## Action Set

The action set is:

```text
list_workspace_skills
read_workspace_skill
use_workspace_skill
validate_workspace_skill
publish_workspace_skill
```

Recommended admin flow:

```text
list_workspace_skills
-> read_workspace_skill
-> validate_workspace_skill
-> publish_workspace_skill
-> use_workspace_skill
```

`use_workspace_skill` must not implicitly replace:

- `read_workspace_skill`
- `validate_workspace_skill`
- `publish_workspace_skill`

## Shared Envelope Rules

All actions still return the normal agrun action result:

```js
{
  control: "continue" | "complete",
  output: { ... },
  summary: "..."
}
```

This document fixes the shape of `output`.

Shared output rules:

- every output has `kind`
- every output has `status`
- success outputs still include `errors: []`
- `source` is always `"workspace"` for workspace skill records
- failures must not rely on bare string messages alone
- structured errors must use `errors: [{ code, message, field? }]`

## Common Record Shapes

### WorkspaceSkillSummary

```json
{
  "name": "expert-coder",
  "description": "Write and review code with a bug-first, correctness-first engineering standard.",
  "source": "workspace",
  "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
  "publishState": "draft",
  "validationState": "valid"
}
```

### WorkspaceSkillDocument

```json
{
  "name": "expert-coder",
  "description": "Write and review code with a bug-first, correctness-first engineering standard.",
  "source": "workspace",
  "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
  "content": "# Expert Coder\n...",
  "publishState": "draft",
  "validationState": "valid"
}
```

### WorkspaceSkillState

Allowed values:

- `publishState`: `draft` | `published` | `inactive`
- `validationState`: `unknown` | `valid` | `invalid`

Defaults:

- initial `publishState = "draft"`
- initial `validationState = "unknown"`

## Input Contracts

### `list_workspace_skills`

Input:

```json
{}
```

Rules:

- no arguments
- returns only workspace-source skills
- does not merge bundled skills into the result

### `read_workspace_skill`

Input:

```json
{
  "skillName": "expert-coder"
}
```

Rules:

- `skillName` is required
- runtime resolves `workspacePath`
- action reads only the target skill document

### `use_workspace_skill`

Input:

```json
{
  "skillName": "expert-coder"
}
```

Rules:

- `skillName` is required
- target skill must already be published
- target skill should already have been read in the current run

### `validate_workspace_skill`

Input:

```json
{
  "skillName": "expert-coder"
}
```

Rules:

- `skillName` is required
- validation operates on the current workspace file contents
- validation does not publish

### `publish_workspace_skill`

Input:

```json
{
  "skillName": "expert-coder"
}
```

Rules:

- `skillName` is required
- publish must depend on the latest successful validation
- publish must not silently auto-validate

## Output Contracts

### `list_workspace_skills`

Output:

```json
{
  "kind": "workspace_skill_catalog",
  "status": "ok",
  "skills": [
    {
      "name": "expert-coder",
      "description": "Write and review code with a bug-first, correctness-first engineering standard.",
      "source": "workspace",
      "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
      "publishState": "draft",
      "validationState": "valid"
    }
  ],
  "errors": []
}
```

Rules:

- `skills` is always present
- empty catalog returns `skills: []`
- bundled skills are not included

### `read_workspace_skill`

Output:

```json
{
  "kind": "workspace_skill_document",
  "status": "ok",
  "skill": {
    "name": "expert-coder",
    "description": "Write and review code with a bug-first, correctness-first engineering standard.",
    "source": "workspace",
    "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
    "content": "# Expert Coder\n...",
    "publishState": "draft",
    "validationState": "valid"
  },
  "errors": []
}
```

Rules:

- `skill` is always present on success
- `content` is the full `SKILL.md` body plus frontmatter text if implementation keeps raw content
- source stays `"workspace"`

### `use_workspace_skill`

Output:

```json
{
  "kind": "workspace_skill_activated",
  "status": "ok",
  "skill": {
    "name": "expert-coder",
    "description": "Write and review code with a bug-first, correctness-first engineering standard.",
    "source": "workspace",
    "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
    "publishState": "published"
  },
  "errors": []
}
```

Rules:

- `use_workspace_skill` only succeeds for `publishState = "published"`
- successful activation updates run-scoped active skill state
- the action does not modify validation state

### `validate_workspace_skill`

Output:

```json
{
  "kind": "workspace_skill_validation",
  "status": "valid",
  "skill": {
    "name": "expert-coder",
    "source": "workspace",
    "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
    "validationState": "valid"
  },
  "errors": []
}
```

Invalid example:

```json
{
  "kind": "workspace_skill_validation",
  "status": "invalid",
  "skill": {
    "name": "expert-coder",
    "source": "workspace",
    "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
    "validationState": "invalid"
  },
  "errors": [
    {
      "code": "SKILL_INVALID_FRONTMATTER",
      "message": "Missing required field \"description\".",
      "field": "description"
    }
  ]
}
```

Rules:

- `status` is only `valid` or `invalid`
- successful validation sets `validationState = "valid"`
- failed validation sets `validationState = "invalid"`
- failed validation does not publish

### `publish_workspace_skill`

Output:

```json
{
  "kind": "workspace_skill_publish",
  "status": "published",
  "skill": {
    "name": "expert-coder",
    "source": "workspace",
    "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
    "publishState": "published",
    "validationState": "valid"
  },
  "errors": []
}
```

Rejected example:

```json
{
  "kind": "workspace_skill_publish",
  "status": "rejected",
  "skill": {
    "name": "expert-coder",
    "source": "workspace",
    "workspacePath": "/.agrun/skills/expert-coder/SKILL.md",
    "publishState": "draft",
    "validationState": "invalid"
  },
  "errors": [
    {
      "code": "SKILL_PUBLISH_BLOCKED",
      "message": "Skill must pass validation before publish."
    }
  ]
}
```

Rules:

- `status` is only `published` or `rejected`
- successful publish requires latest validation state to be `valid`
- rejected publish must return structured errors

## State Transition Contract

Initial state:

```text
publishState = draft
validationState = unknown
```

Transition rules:

- `validate_workspace_skill`
  - success -> `validationState = valid`
  - failure -> `validationState = invalid`
- `publish_workspace_skill`
  - allowed only when `validationState = valid`
  - success -> `publishState = published`
  - failure -> keep prior publish state
- `use_workspace_skill`
  - allowed only when `publishState = published`
  - recommended only after current run has read the same skill

`publish_workspace_skill` must not:

- skip validation
- auto-correct invalid content
- silently publish invalid skills

## Failure Codes

Minimum failure codes:

- `SKILL_NOT_FOUND`
- `SKILL_NOT_PUBLISHED`
- `SKILL_NOT_VALIDATED`
- `SKILL_INVALID_FRONTMATTER`
- `SKILL_INVALID_CONTENT`
- `SKILL_PUBLISH_BLOCKED`

Recommended use:

- `SKILL_NOT_FOUND`
  - skill name resolves to no workspace file
- `SKILL_NOT_PUBLISHED`
  - `use_workspace_skill` called before publish
- `SKILL_NOT_VALIDATED`
  - publish requested before a valid validation result exists
- `SKILL_INVALID_FRONTMATTER`
  - frontmatter missing required fields or malformed
- `SKILL_INVALID_CONTENT`
  - markdown body is missing required instruction content
- `SKILL_PUBLISH_BLOCKED`
  - publish denied because validation state is not `valid`

## Run-State Expectations

Admin UI and debug API should be able to inspect at least:

- `publishState`
- `validationState`
- `lastReadSkill`
- `activeSkill`
- `workspacePath`
- `errors`

Recommended run-scoped order checks:

- `read_workspace_skill` records `lastReadSkill`
- `use_workspace_skill` compares requested skill with `lastReadSkill`
- using a different skill than the one most recently read should fail unless explicitly allowed later by product design

## Test Cases

Minimum verification scenarios:

- `list_workspace_skills` returns only workspace-source records
- `read_workspace_skill` returns `SKILL_NOT_FOUND` for missing skill
- `validate_workspace_skill` returns `valid` for good frontmatter/content
- `validate_workspace_skill` returns `invalid` with structured errors for bad frontmatter/content
- `publish_workspace_skill` returns `rejected` when validation is missing or invalid
- `use_workspace_skill` returns `SKILL_NOT_PUBLISHED` for draft skill
- `use_workspace_skill` succeeds only for published skill
- admin UI merged catalog still shows workspace override precedence separately from these source-specific action results

## Non-Goals

This contract does not define:

- browser UI component design
- file editor interactions
- generic workspace browsing
- merged catalog action shapes

Those remain in separate documents.
