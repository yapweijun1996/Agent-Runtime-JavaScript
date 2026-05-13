# agrun.js Admin Workspace Skill Source

## Purpose

This document defines how `agrun.js` should support an admin-managed skill workspace in browser mode.

The goal is:

- let admins inspect which skills are available
- let admins manage runtime skill instructions without exposing that surface to end users
- keep the runtime skill source model debuggable
- preserve the existing build-time bundled skill flow

This document is a source and UI contract.
It is not a generic browser filesystem design.

For fixed runtime action I/O shapes, see `agrun_docs/admin-workspace-skill-action-contract.md`.

## Two Skill Sources

`agrun.js` should support two distinct skill sources:

```text
1. Bundled Skill Source
2. Admin Workspace Skill Source
```

### 1. Bundled Skill Source

Source:

```text
repo skills/*/SKILL.md
```

Lifecycle:

```text
developer edits local skills/
-> npm run build
-> bundled into dist/agrun.js
```

Properties:

- available in all builds that include them
- read-only at runtime
- versioned with code
- visible in admin UI

### 2. Admin Workspace Skill Source

Source:

```text
browser virtual workspace
```

Lifecycle:

```text
admin edits workspace skill
-> validates it
-> publishes or activates it
-> runtime skill catalog updates
```

Properties:

- browser-runtime managed
- admin-only
- not visible or editable by end users
- intended for runtime operations and overrides

## Permission Model

### End User

End users must not be able to:

- browse the skill workspace
- read skill files
- edit skill files
- publish or deactivate skills

End users only consume agent results.

### Admin

Admins may:

- view bundled skills
- view workspace skills
- inspect parsing and load state
- edit workspace skills
- validate workspace skills
- publish or deactivate workspace skills

### Runtime Rule

Even for admin-managed skills:

- runtime policy still wins
- action policy still wins
- skills do not bypass approval or tool restrictions

## Browser Admin UI

The browser admin UI should expose two separate sections.

### Bundled Skills

This section is read-only.

It should show:

- skill name
- description
- source = `bundled`
- source path
- load status
- whether it is overridden by workspace

Important:

- bundled skills should be visible in browser admin UI
- bundled skills must not be presented as editable workspace files

### Workspace Skills

This section is admin-managed.

It should show:

- skill name
- description
- source = `workspace`
- workspace path
- validation status
- publish status
- load status

This section may allow:

- create
- edit
- validate
- publish
- deactivate

## Combined Catalog View

The admin UI should also provide one merged “Loaded Skills” view.

That view should show:

- effective skill name
- effective source
- whether the skill is loaded
- whether the skill is invalid
- whether the workspace version overrides the bundled version
- whether the skill is active in the current run

This is the main debugging surface for administrators.

## Source Precedence

When both sources define the same skill name:

```text
workspace skill overrides bundled skill
```

Recommended display states:

- `bundled`
- `workspace`
- `overridden`
- `invalid`

Rules:

- invalid workspace skills must not silently replace valid bundled skills
- if a workspace skill is invalid, the bundled skill remains effective when present
- override state must be visible in admin UI

## Discovery Scope

The workspace source must stay narrow.

Recommended path shape:

```text
/.agrun/skills/<skill-name>/SKILL.md
```

Rules:

- only this path pattern is treated as skill content
- not every markdown file in the workspace is a skill
- no generic full-workspace skill discovery

## Runtime Skill Actions

The runtime-facing skill flow should remain explicit:

```text
list_workspace_skills
-> read_workspace_skill
-> use_workspace_skill
```

For a merged skill catalog, the runtime may also expose generic actions:

```text
list_agent_skills
read_agent_skill
use_agent_skill
```

If both exist:

- generic actions should read from the merged catalog
- admin-only actions may expose source-specific detail

## Publish Model

Workspace skill edits should not necessarily become effective immediately.

Recommended states:

```text
draft
validated
published
inactive
```

Rules:

- draft skills are not in the effective catalog
- only published skills enter the effective catalog
- deactivated skills remain inspectable but not selectable by planner

## Debug Surfaces

This design is only easy to debug if the full skill lifecycle is visible.

The admin UI or debug API should expose:

- discovered skill files
- parsed skill records
- validation errors
- effective loaded catalog
- source precedence result
- current run `catalogListed`
- current run `lastReadSkill`
- current run `activeSkill`
- planner action trace for `list/read/use`

Without these surfaces, debugging becomes guesswork.

## Development Flow

Development-time bundled skills should continue to work like this:

```text
create or edit repo skill under skills/
-> npm run build
-> bundled into dist/agrun.js
```

This flow is separate from runtime workspace editing.

The admin UI may show bundled skills in browser mode, but:

- they are read-only
- they are not the workspace editor surface
- they must be labeled as `bundled`

## Non-Goals

This design should not become:

- generic browser file manager for all users
- unrestricted workspace grep/read surface for all agent runs
- end-user editable prompt injection surface
- full platform plugin marketplace

## Summary

The intended model is:

```text
Bundled Skills (read-only, build-time)
+ Admin Workspace Skills (admin-only, runtime-managed)
= Effective Loaded Skill Catalog
```

That keeps the system:

- debuggable
- admin-operable
- browser-compatible
- aligned with a focused runtime boundary
