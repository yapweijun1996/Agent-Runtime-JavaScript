# Authoring host actions and skills

Add new capabilities to agrun **without forking** by passing
`defineAction(spec)` outputs into `createRuntime({ customActions })`. The
AI discovers them through the same planner catalog as bundled actions
and chooses when to call them — no `canHandle()` routing.

> Status: AGRUN-270 ships `defineAction` / `defineSkill` helpers.
> AGRUN-271 ships the `customActions` registration entry point.
> See [ADR-0040](./adr/0040-unify-skill-loaders.md) for the full
> migration plan.

## Quick example

```js
import { createRuntime, defineAction } from "agrun";

const crmLookup = defineAction({
  name: "host_crm_lookup",                       // must not collide with bundled names
  description: "Look up a customer record by ID.",
  planner: {
    argsSchema: { customerId: { type: "string", required: true } },
    argsExample: { customerId: "C123" },
    guidance: "Use when the user references a specific customer ID."
  },
  tier: 2,                                       // 1 read-only, 2 side-effects, 3 destructive
  outputSchema: { kinds: ["crm_row"], controls: ["continue"] },
  async execute(context, args) {
    const row = await myCrm.fetch(args.customerId);
    return { kind: "crm_row", output: row };     // shape matches action-result-envelope
  }
});

const runtime = createRuntime({
  skills: [...],                                  // existing skill option (legacy path)
  customActions: [crmLookup]                      // ← AGRUN-271 entry point
});
```

## `defineAction(spec)` contract

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Stable identifier. Host-namespace it (`host_…`) to avoid bundled collisions. |
| `description` | yes | One-line summary shown to the planner. |
| `planner.argsSchema` | yes | `{ field: { type, required?, aliases? } }`. Types: string, number, boolean, object, array. |
| `planner.argsExample` | yes | Concrete example object the planner can imitate. Empty `{}` is fine. |
| `planner.guidance` | yes | When to call this action. The planner reads this verbatim. |
| `tier` | yes | Integer ≥1. Drives `action-permission-judge.js` defaults (1 auto, 2 ask, 3 deny). |
| `outputSchema` | yes | `{ kinds: [...], controls: [continue\|stop\|complete] }` or `null` waiver. |
| `execute(ctx, args)` | yes | `async`. Return `{ kind, output, controls? }`. Throws become observable failure signals. |

`defineAction` validates the shape and returns a frozen object. It is
stateless — name uniqueness against the bundled set is enforced later,
inside `createActionRegistry`.

## `context` (passed to `execute`)

Read-only bag, same as bundled actions. Key fields:

- `context.runState` — frozen projection. Do **not** mutate. Emit
  changes via `context.pushStep` instead.
- `context.request` — current run prompt, options, history.
- `context.runtimeConfig` — normalized config (read-only).
- `context.onToken` — optional streaming callback if the host wired one.

Throwing from `execute` does **not** crash the loop — the runtime
converts it to a `skill_execute_failure` step and the AI can choose to
retry, pivot, or finalize.

## `defineSkill(spec)`

Same idea but for higher-level capability bundles. Reserved for the
AGRUN-272 migration; today it returns a frozen manifest stub
(`kind: "agrun-skill"`) — there is no registration entry point for skill
manifests yet. Stick to `defineAction` + `customActions` until
AGRUN-271+ skill-manifest plumbing lands.

## Trust boundary

Host actions run inside the same JS context as bundled actions but the
runtime treats them as third-party:

1. Args are validated against `argsSchema` before `execute` runs.
2. Thrown errors are caught and surfaced as read-only failure signals.
3. Non-conforming return shapes become observable signals; no silent
   coercion.
4. `context.runState` is shallow-frozen; nested traversal is allowed,
   mutation is not.

## Common mistakes

- **Forgot `outputSchema`** → `assertActionOutputContract` throws at
  `createActionRegistry`. Declare `{kinds, controls}` or explicit `null`.
- **Name collision** → use `host_` prefix or a domain-specific namespace.
- **Mutating `runState`** → silent in shallow freeze, but downstream
  invariants break. Always emit via `pushStep`.
- **Synchronous LLM-like work inside `execute`** → blocks the event loop.
  Keep `execute` thin; do heavy work via tools/providers.

## Related

- [ADR-0040](./adr/0040-unify-skill-loaders.md) — unify skill loaders RFC
- [action-contract.md](./action-contract.md) — bundled action shape
- [agent-skills.md](./agent-skills.md) — agent-skill manifest (Set B)
