# Docs Bundle Design

## Purpose

`dist/agrun.md` should be easy for an engineer to scan when they receive the built package next to `dist/agrun.js`.

Today it is generated as one long concatenated file. That is complete, but hard to read because onboarding, feature recipes, API reference, result schemas, and TodoState details all share one flat reading path.

This design keeps `agrun_docs/manifest.cjs` as the source of truth and changes the generated `dist/` documentation from a bundle dump into a task-oriented navigation harness.

## Reader Goals

Primary readers:

- App engineer integrating `dist/agrun.js` into a browser product.
- Runtime engineer changing agrun internals.
- QA / support engineer inspecting result shape, events, errors, or debug output.

Common questions:

- How do I create a runtime?
- How do I run one turn?
- How do I keep chat history?
- How do I enable or disable memory?
- How do I add web search or URL reading?
- How do I require approval before risky actions?
- How do I observe progress and errors?
- How do I parse `result`?
- How do I wire TodoState?

## Non-Goals

- Do not hand-edit generated `dist/agrun.md`.
- Do not duplicate full reference content by copy-paste.
- Do not make `README.md` carry every detailed API contract.
- Do not hardcode feature links inside the build plugin when the manifest can own them.

## Proposed `dist/` Shape

```text
dist/
  agrun.js
  agrun.md
  agrun_docs/
    quickstart.md
    runtime-api.md
    result-schema.md
    feature-toggles.md
    todo-state.md
    features/
      sessions.md
      memory.md
      approval.md
      web-search.md
      skills.md
      observability.md
      errors.md
```

`dist/agrun.md` becomes the index and first-read guide. `dist/agrun_docs/*.md` carries the longer material.

## `dist/agrun.md` Layout

Recommended top-level structure:

```md
# agrun.js

## Start Here

| I want to... | Read |
|---|---|
| Build first chatbot | Quickstart |
| Look up API options | Runtime API |
| Parse run output | Result Schema |
| Enable / disable features | Feature Toggles |
| Wire long tasks | TodoState |

## 10-Minute Path

1. Load `dist/agrun.js`
2. Create `runtime`
3. Register skills
4. Run one turn
5. Add session store
6. Observe `onStep`
7. Handle approval / error / result

## Engineer Task Index

- Create runtime
- Run one turn
- Use sessions
- Persist with IndexedDB
- Disable global memory
- Add web search
- Add human approval
- Inspect step events
- Parse errors
- Wire TodoState

## Feature Index

- Runtime
- Skills
- Actions
- Provider
- Session
- Memory
- Approval
- Search and URL reading
- TodoState
- Observability
- Errors

## Minimal Examples

Short examples only. Link to full docs for details.

## Full Docs

Generated links into `dist/agrun_docs/`.
```

This keeps the first file short and navigational. A reader should know where to go in under one minute.

## Manifest Model

Extend each doc entry in `agrun_docs/manifest.cjs` with optional generated-doc fields:

```js
{
  file: "agrun_docs/public-runtime-api.md",
  title: "Public Runtime API",
  category: "reference",
  summary: "`createRuntime` / `runtime.run` / options / events",
  distPath: "agrun_docs/runtime-api.md",
  bundleRole: "reference",
  features: ["runtime", "session", "observability"],
  audience: ["integrator", "runtime-engineer"]
}
```

Suggested fields:

| Field | Purpose |
|---|---|
| `distPath` | Output path under `dist/` when copied or rewritten. |
| `bundleRole` | `start`, `task`, `feature`, `reference`, `internal`, or `archive`. |
| `features` | Feature tags used to build the Feature Index. |
| `audience` | Helps build reader paths without hardcoding in plugin logic. |
| `bundle` | Keep existing meaning for backward compatibility during migration. |

The build plugin should read these fields and generate navigation from data, not string literals.

## Feature Docs

Feature docs should be short, task-oriented pages. Each page should answer the same questions:

```md
# Memory

## When To Use

## Minimal Setup

## Options

## Events

## Result Fields

## Common Errors

## See Also
```

This gives engineers predictable scanning behavior across features.

## Migration Plan

### Phase 1: Index-Only Redesign

- Keep existing canonical source docs unchanged.
- Change `dist/agrun.md` to a short generated index.
- Generate `dist/agrun_docs/*.md` from current bundled sources.
- Rewrite links so `dist/agrun.md` points to `dist/agrun_docs/`.

Acceptance:

- `npm run build` still emits `dist/agrun.js`.
- `dist/agrun.md` is under roughly 300 lines.
- All current bundled sources are still reachable from `dist/agrun.md`.
- No public API behavior changes.

### Phase 2: Feature Pages

- Add `agrun_docs/features/*.md`.
- Register them in `agrun_docs/manifest.cjs`.
- Generate `dist/agrun_docs/features/*.md`.
- Link them from the Feature Index.

Acceptance:

- Each core feature has one owner page.
- Each feature page has setup, options, events, errors, and see-also sections.
- Existing long reference docs remain available.

### Phase 3: Reference Cleanup

- Keep `public-runtime-api.md` as exact contract reference.
- Move long examples and recipes into feature docs.
- Keep schemas in `result-schema.md`.

Acceptance:

- API reference is searchable and contract-focused.
- Feature docs are task-focused.
- Quickstart stays beginner-focused.

## Build Harness Changes

Implementation should happen in `build/usage-doc-plugin.cjs`:

- Keep `composeUsageDoc()` for the new short index.
- Add `emitSourceDocs()` to write each configured source to `dist/agrun_docs/`.
- Add `buildTaskIndex()` from manifest metadata.
- Add `buildFeatureIndex()` from manifest metadata.
- Keep link rewriting centralized in one helper.

Do not put feature-specific link lists directly in `rollup.config.js`.

## Verification

Run:

```bash
npm run build
npm run docs:index
npm test
```

Manual checks:

- Open `dist/agrun.md` and confirm the first screen explains where to go.
- Search for `createRuntime`, `result`, `approval_required`, `globalMemory`, and `TodoState`; each should land on a clear path.
- Confirm links from `dist/agrun.md` to `dist/agrun_docs/*.md` work in GitHub and local Markdown viewers.
- Confirm `dist/agrun.js` behavior is unchanged except build id.

## Decision

Use a generated documentation harness:

- `agrun_docs/manifest.cjs` remains SSOT.
- `dist/agrun.md` becomes the navigation entrypoint.
- `dist/agrun_docs/*.md` carries detailed generated docs.
- Feature docs use a consistent task-oriented template.

This improves readability without weakening the current "single build command produces distributable docs" contract.
