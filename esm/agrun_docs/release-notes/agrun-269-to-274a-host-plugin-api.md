# Release notes — Host plugin API (AGRUN-269 → AGRUN-274a)

**Date:** 2026-05-27
**Status:** Additive only. Zero breaking change. Safe to upgrade.
**Tracking:** [ADR-0040](../adr/0040-unify-skill-loaders.md)

## What you can do now

Register your own actions into agrun without forking the library:

```js
import { createRuntime, defineAction } from "agrun";

const myAction = defineAction({
  name: "host_crm_lookup",
  description: "Look up a customer record by ID.",
  planner: {
    argsSchema: { customerId: { type: "string", required: true } },
    argsExample: { customerId: "C123" },
    guidance: "Use when the user mentions a customer ID."
  },
  tier: 2,
  outputSchema: { kinds: ["crm_row"], controls: ["continue"] },
  async execute(context, args) {
    return { kind: "crm_row", output: await myCrm.fetch(args.customerId) };
  }
});

const runtime = createRuntime({
  skills: [...yourExistingSkills],
  customActions: [myAction]    // ← new
});
```

The AI discovers `host_crm_lookup` through the same planner catalog as
bundled actions and decides when to call it. No `canHandle` routing.

See [agrun_docs/authoring-skills.md](../authoring-skills.md) for the
full contract.

## New public API

| Export | Purpose |
|---|---|
| `defineAction(spec)` | Validate + freeze an action descriptor. Stateless. |
| `defineSkill(spec)` | Validate + freeze a skill stub (reserved for AGRUN-272 manifest wiring). |
| `createRuntime({ customActions: [...] })` | Register host-supplied actions into the planner catalog. |

## Deprecated (no runtime warnings; JSDoc only)

These exports still work but will be deleted in AGRUN-274e:

- `echoSkill`, `fallbackSkill` — AI handles trivial fallback; no host migration needed.
- `memorySkill`, `newsBriefSkill`, `timeSkill` — re-author as `defineAction` entries.
- `webSearchSkill` — bundled `web_search` action already covers this.

Kept (reclassified as providers, not deprecated):
`geminiBrowserSkill`, `openaiBrowserSkill`.

## Try the demo

```bash
npm --prefix examples/browser run dev
# open http://localhost:3000
# ask: "What time is it in Singapore?"
# → AI calls host_current_time (see examples/host-plugins/current-time-action.js)
```

## Migration cheatsheet for existing hosts

| If you currently … | Now do … |
|---|---|
| Forked agrun to add a tool | Delete the fork. Author with `defineAction` + pass via `customActions`. |
| Wrote a Set A skill with `canHandle` | Same — re-author as `defineAction`. The planner replaces canHandle routing. |
| Used `echoSkill` / `fallbackSkill` as filler | Drop them. AI handles trivial cases. |
| Used `webSearchSkill` | Use the bundled `web_search` action (no host wiring needed). |

## Commits (main branch)

```
e7a116da2  AGRUN-269 + AGRUN-270 — ADR-0040 RFC + defineSkill/defineAction
749bcd40d  AGRUN-271             — customActions plugin entry point
08d08a7ba  AGRUN-272             — host-plugin demo in examples/browser
cdf6b393f  AGRUN-273             — @deprecated JSDoc on 6 Set A exports
9f589cee7  AGRUN-274a            — drop dead canHandle from provider adapters
```

## Test baseline

- Before: 1086 PASS
- After:  1103 PASS (+17 new cases covering defineAction / customActions)
- Failures: 0
- Build: PASS

## What's coming

AGRUN-274b → AGRUN-274e finish the deletion of the Set A skill router.
Tracking in [task.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/task.md). No host action needed until the
major version bump in AGRUN-274e.
