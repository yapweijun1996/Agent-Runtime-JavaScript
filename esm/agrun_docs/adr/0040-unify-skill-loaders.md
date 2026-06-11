# ADR-0040 — Unify Skill Loaders (RFC / audit only, no code change yet)

- Status: PROPOSED
- Date: 2026-05-26
- Ticket: AGRUN-269-UNIFY-SKILL-LOADERS
- Supersedes: partial follow-up to ADR-0023 (push-mode removal)
- Related: ADR-0035 (host-overridable defaults)

## TL;DR

agrun ships **two parallel skill systems**. Set A uses runtime-side
`canHandle()` pattern matching to dispatch one skill per request
(pre-AI-first router). Set B exposes capabilities as actions in the planner
catalog and lets the AI decide (`list_agent_skills` / `read_agent_skill` /
`use_agent_skill` / `execute_skill_tool`). This RFC proposes deleting Set A
and routing all capability through Set B, plus introducing a public
`defineSkill()` / `createRuntime({ skills })` plugin API so host engineers
can register new skills without forking the library.

This document is **audit + design only**. No source files change in the
landing commit for ADR-0040. Implementation is staged as
AGRUN-270..AGRUN-274.

## Problem

1. Two contracts for the same concept ("skill") → SSOT broken.
2. `canHandle()` is a runtime-side decision about which capability to run.
   This violates the project's "no hardcode, no hardcode, no hardcode"
   rule (CLAUDE.md) and the ADR-0023 push-mode removal direction.
3. Host engineers cannot register skills dynamically. They must fork
   `src/skills/` or add files into the library tree.
4. `src/index.js` re-exports 8 Set A skills as public API, so naive
   deletion is a breaking change for downstream hosts.

## Current state — audit

### Set A (canHandle router, to be removed)

| File | Disposition | Reason |
|---|---|---|
| `src/skills/echo-skill.js` | DELETE | Pure fallback; AI already handles trivial prompts. |
| `src/skills/fallback-skill.js` | DELETE | Same as echo. |
| `src/skills/web-search-skill.js` | DELETE | `actions/web-search-action.js` already covers it. |
| `src/skills/time-skill.js` | MIGRATE → agent-skill manifest | Real capability. |
| `src/skills/news-brief-skill.js` | MIGRATE → agent-skill manifest | Real capability. |
| `src/skills/memory-skill.js` | MIGRATE → agent-skill manifest | Real capability. |
| `src/skills/gemini-browser-skill.js` | RECLASSIFY → provider | Not a skill; LLM provider wrapper. |
| `src/skills/openai-browser-skill.js` | RECLASSIFY → provider | Same. |
| `src/skills/providers/*` | KEEP AS-IS | HTTP/SDK wrappers, not skills. |

Runtime files coupled to Set A (must be removed or rewired):

- `src/runtime/run-skill-loop.js` — Set A execution entry.
- `src/runtime/router.js` — `canHandle()` dispatcher.
- `src/runtime/skill-probe.js` — `canHandle()` probe used by router.
- `src/runtime/config.js:167-168` — validation that requires `canHandle` /
  `execute` on skills.
- `src/runtime/run-loop.js:46,62` — top-level switch between
  `runSkillLoop` (Set A) and `runActionLoop` (Set B).

Public API re-exports in `src/index.js:82-89` (8 entries) must be kept as
deprecation stubs for one minor version before deletion.

### Set B (agent-skills, to be the SSOT)

- `src/runtime/agent-skills.js` — bundled manifests + index provider.
- `src/runtime/skill-loader.js` — `loadAgentSkills`, `parseSkillMarkdown`.
- `src/runtime/skill-policy.js` — allow/ask/deny.
- `src/runtime/skill-catalog-ranking.js` — top-K ranking for the planner.
- `src/runtime/actions/list-agent-skills-action.js` /
  `read-agent-skill-action.js` / `use-agent-skill-action.js` /
  `execute-skill-tool-action.js` — AI-facing tools.

## Proposed public API

```js
import { createRuntime, defineSkill } from "agrun";

const crmLookupSkill = defineSkill({
  name: "crm-lookup",
  description: "Look up a customer record by ID.",
  argsSchema: { customerId: { type: "string" } },
  argsExample: { customerId: "C123" },
  guidance: "Use when the user mentions a specific customer ID.",
  tier: 2,
  async execute(context, args) {
    return { kind: "crm_result", output: await fetchCrm(args.customerId) };
  }
});

const runtime = createRuntime({
  skills: [crmLookupSkill],          // ← new: host-supplied skills
  providers: { openai: { apiKey } }
});
```

### Contract requirements (enforced inside `defineSkill`)

- `name` is a stable identifier; must not collide with bundled skill names.
- `argsSchema` is JSON-shape (`{ field: { type } }`), validated by
  existing `action-args-validation.js`.
- `execute` returns `{ kind, output, controls? }` matching
  `action-result-envelope.js`.
- No `canHandle`. AI decides via `list_agent_skills` + `use_agent_skill`.
- `defineSkill` freezes the returned object so plugins cannot mutate
  runtime internals.

### Trust boundary

Host-supplied skill code is third-party from agrun's point of view. The
runtime wrapper around `execute`:

1. Validates args against `argsSchema` before calling `execute`.
2. Runs `execute` inside `try/catch`; thrown errors become a read-only
   `skill_execute_failure` step + envelope, never an unhandled crash.
3. Enforces output schema; non-conforming returns become a read-only
   failure signal the AI can observe and retry or pivot away from.
4. Plugins cannot read or write `runState` directly. They get the same
   `context` bag actions get today (`context.runState` is a frozen
   projection, mutations go through pushStep).

These mirror the existing rules for bundled actions, so the burden on
agrun is one shared wrapper, not two.

## Migration plan

Staged over 5 tickets; each ticket is independently shippable.

| Ticket | Scope | Code changes |
|---|---|---|
| AGRUN-270 | Public `defineSkill(spec)` + `defineAction(spec)` helpers. SSOT shape validation. No deletion. | `src/runtime/define-skill.js`, `src/index.js` export. |
| AGRUN-271 | `createRuntime({ skills })` accepts host-supplied skills, registers them into the agent-skill catalog. | `src/runtime/runtime.js`, `src/runtime/agent-skills.js`. |
| AGRUN-272 | Migrate `time-skill` / `news-brief-skill` / `memory-skill` to agent-skill manifest. Dogfood new API. | New manifests in `skills/<name>/skill.md` + `tools.mjs`. |
| AGRUN-273 | Mark `echo`, `fallback`, `web-search-skill` (Set A) as `@deprecated`. Keep exports for one minor version. | JSDoc only. |
| AGRUN-274 | Delete `run-skill-loop.js`, `router.js`, `skill-probe.js`, `canHandle` validation, and 3 deprecated skills. Bump major version. | Removal commit. |

## Risks

- Public API break for hosts importing `echoSkill` etc. directly →
  mitigated by AGRUN-273 deprecation window.
- `run-loop.js` currently branches on whether any Set A skill matched. If
  no skill matches it falls through to action-loop. After unification the
  branch collapses; existing tests under `test/concerns/run-loop.test.js`
  need a focused re-read before AGRUN-274.
- `src/runtime/agent-skills-bundle.js` already imports
  `../../skills/worldtime_tz/tools.mjs` — confirm folder layout matches
  AGRUN-272's migration target before writing the new manifests.

## Out of scope

- Changing action contract. Actions stay as they are; `defineAction` is a
  pass-through wrapper for symmetry, not a redesign.
- Permission / approval model. `tier` and `policy.js` are unchanged.
- Provider plugins (`src/skills/providers/`). Providers are a separate
  extension point with their own lifecycle.

## Decisions (locked 2026-05-26)

1. **Name uniqueness check is at registration time.** `defineSkill` and
   `defineAction` are stateless — they only validate shape and freeze
   the spec. Collision detection lives in `createRuntime({ skills })` /
   `createActionRegistry({ actions })` where the bundled set is known.
   Rationale: keeps helpers pure and dependency-free, so they can be
   imported by host tooling (e.g. type generators) without dragging in
   runtime state.

2. **`context.runState` is shallow-frozen + write-via-pushStep only.**
   Deep freeze costs ~O(nodes) per `execute` call which is unacceptable
   on large research runs. Instead: the wrapper shallow-freezes the
   top-level `runState` object and the documented mutation rule is
   "third-party `execute` must not mutate any field; emit a step via
   `context.pushStep` if you want runtime to record state changes". The
   shallow freeze catches the common mistake (`context.runState.foo = …`)
   while leaving room for read-traversal of nested structures. Document
   in `agrun_docs/agent-skills.md`.

3. **Versioning: 0.x minor bumps for AGRUN-270..AGRUN-273, major bump
   for AGRUN-274.** No public API removal until AGRUN-274 lands, so
   270/271/272/273 are additive minors. 274 deletes 8 public exports
   and the `canHandle` field validation, which is a clear major break.

— end of RFC —
