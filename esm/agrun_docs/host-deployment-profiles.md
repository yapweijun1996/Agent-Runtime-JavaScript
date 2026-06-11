# Host Deployment Profiles

How a host application (e.g. the browser example) composes `createRuntime`
options for different deployment shapes — demo vs trusted vs read-only —
without forking agrun.js.

## Why this exists

agrun's [`createActionRegistry`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-registry.js) ships
browser-safe bundled actions (`web_search`, `read_url`, `workspace_*`,
`todo_*`, `spawn_subagent`, etc.) and built-in permission metadata. Hosts can
also append namespaced `customActions` through `createRuntime({ customActions })`
when they need domain-specific tools. Bundled web actions are a default
web-research profile, not the generic evidence contract.

Four extension paths remain open to the host:

1. **`disabledActions: string[]`** (runtime + per-run) — opt out of any
   built-in action. Documented in [feature-toggles.md](./feature-toggles.md).
2. **`agentSkills` / `agentSkillIndexProvider`** — inject skills, each of
   which may carry browser-safe `tools` reachable through the
   `execute_skill_tool` action.
3. **`customActions`** — append host-owned actions such as `orders.query` or
   `customer.lookup` to the planner catalog.
4. **`actionPolicy`** — flip per-action approval modes
   (`ask` / `allow` / `deny`).
5. **`evidencePolicy`** — tell recovery/readiness surfaces which host-owned
   evidence actions to name, instead of assuming `web_search` / `read_url`.

These knobs are enough to express every deployment shape we have
seen. The pattern below packages them into a typed helper so a host does
not duplicate the same config logic across files.

## The pattern: `buildAgrunConfig(profile, …)`

Reference implementation:
[`examples/browser/src/runtime/agrun-config.ts`](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agrun-config.ts).

```ts
const runtimeOptions = buildAgrunConfig({
  agentSkillIndexProvider,  // optional, from skill bootstrap
  autoApproveTier1: false,   // per-user toggle
  intentClassifier,          // optional LLM intent classifier
  llmSkills: [...],          // provider skills (openai/gemini/...)
  profile: 'browser-demo',   // deployment shape
  sessionStore,
});
const runtime = createRuntime(runtimeOptions);
```

### Built-in profiles (browser example)

| Profile | actionPolicy | maxSteps | selfCorrection | todoAutopilot | disabledActions |
|---|---|---|---|---|---|
| `browser-demo` | ask (or allow when autoApproveTier1) | 80 | 8 retries | 10 vetoes | — |
| `browser-trusted` | allow (always) | 120 | 10 retries | 15 vetoes | — |
| `browser-readonly` | ask | 40 | 4 retries | disabled | workspace mutate + todo + spawn_subagent |

### Per-run disable (search/read toggles)

Independent from deployment profile. Lives in the same helper:

```ts
const disabledActions = buildPerRunDisabledActions({
  readUrlEnabled,         // user setting
  searchBackend,          // user setting
});
runtime.run(input, { disabledActions });
```

## When to add a profile vs override inline

Add a new profile when the deployment shape is **reusable** — i.e. you
expect more than one entry point or test fixture to use the same shape.
Examples: read-only public demo, autonomous CI agent, embedded sandbox.

Override inline (skip the helper, pass options directly to `createRuntime`)
when the config is **one-shot** — a single experiment script or live
test you do not plan to run again.

## No-web host-data profile

For chatboxes that ground answers in host-owned actions, make the deployment shape
explicit:

```ts
createRuntime({
  customActions: [ordersQueryAction],
  actionPolicy: {
    host_data_query: "allow"
  },
  disabledActions: ["web_search", "read_url"],
  evidencePolicy: {
    profile: "host",
    recoveryActions: ["host_data_query"]
  },
  researchReportLoop: { enabled: false },
  researchCoverageGuard: { enabled: false },
  citationCoverageGuard: { enabled: false }
});
```

In this shape, structured host action results count toward
`finalReadiness.requirementsAssessment.successfulEvidenceCount`. The runtime
does not need to know what the host records mean; the host action provides
evidence, and the AI decides how to use it.

## Node server profile

The same `createRuntime` knobs compose a Node.js (>= 18) server host. The
runtime core is environment-neutral; only the storage and event-delivery
adapters differ from the browser shapes:

```js
const { createRuntime } = require("./dist/agrun.js");
const { createFsStorage } = require("./node/storage-fs.js");
const { createSseHandler } = require("./node/runtime-sse-adapter.js");

const runtime = createRuntime({
  storage: createFsStorage({ baseDir: "./.agrun/storage" }),
  // same profile knobs as the browser shapes:
  // actionPolicy, maxSteps, selfCorrection, todoAutopilot, disabledActions…
});
const sseHandler = createSseHandler(runtime, { heartbeatMs: 15000 });
```

Differences vs the browser profiles:

- **Storage** — filesystem (`createFsStorage`) instead of IndexedDB. Any
  custom store implementing the same contract also works.
- **Event delivery** — browser hosts subscribe in-process; a Node server
  typically forwards runtime events to clients via the opt-in SSE adapter
  ([node/README.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/node/README.md)).
- **Approval** — there is no settings panel at the server. Either surface
  `approval_required` + resume token to the client UI, or run unattended
  with `actionPolicy: "allow"` for trusted tiers (mirrors `browser-trusted`).
- **In-memory store growth (AGRUN-488)** — `createInMemorySessionStore()` (the
  default when there is no IndexedDB and no `createFsStorage`) is **unbounded by
  default**: it keeps every session's record, messages, summaries, and memory
  for the process lifetime. That is correct for the browser / single-process
  shape, but a long-lived server that creates many sessions should bound it. The
  store takes **opt-in** eviction options — pass them explicitly:

  ```js
  const { createInMemorySessionStore } = require("./dist/agrun.js");
  const runtime = createRuntime({
    storage: createInMemorySessionStore({
      maxSessions: 1000,        // LRU: evict least-recently-used past this count
      sessionTtlMs: 3600_000    // expire sessions idle longer than 1h
    })
  });
  ```

  Both are independent and optional; with neither set the store stays unbounded
  (zero behavior change). Eviction is lazy + insert-driven (no background timer)
  and drops **all** of an evicted session's per-session data; cross-session
  `globalMemory` is never evicted. Prefer `createFsStorage` (disk-backed) when
  sessions must survive a restart — eviction is a memory-bound, not persistence.

The canonical Node live e2e (`test/node-agrun-3000-live.mjs`) exercises this
shape end-to-end with `createFsStorage`.

## Anti-patterns

- **Do not** add a runtime config flag for "model tier" or
  "use long-task harness" that conditionally gates actions by model name.
  agrun's whole point is to let weak models do long tasks via harness
  scaffolding; profile gating belongs to deployment shape, not model
  capability. See `feedback_no_model_gating` in the long-term memory.
- **Do not** assume core loads domain skills by default. `agentSkills:
  [customSkill]` means exactly that one custom skill. Import opt-in packs such
  as `@agrun/skills-research` or `@agrun/skills-coder` and pass
  `agentSkills: [...researchSkills, ...coderSkills, customSkill]` only when the
  host intentionally wants those domain instructions.
- **Do not** modify [`action-registry.js`](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-registry.js)
  to add a new action just for one host. Bundle it as a skill tool and
  expose it via `execute_skill_tool` instead.

## Verification recipe

When changing a profile or the helper:

1. `npm --prefix examples/browser run lint` — TypeScript clean.
2. `npm --prefix examples/browser run test:smoke` — 14 smoke tests pass,
   including [`agrun-config.smoke.ts`](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/test/agrun-config.smoke.ts)
   which pins the 3 profile shapes.
3. `npm --prefix examples/browser run build` — Vite build clean.
4. Preview-server snapshot + console errors — no regression in UI.
5. `node test/concerns/host-evidence-policy.test.js` — no-web host-data
   publish path stays independent from `web_search` / `read_url`.

The agrun-config smoke test snapshots `actionPolicy`, `maxSteps`,
`selfCorrection`, `todoAutopilot`, and `disabledActions` for each profile
plus per-run disable, so behavior drift will surface before commit.

## History

- 2026-05-26 — Helper extracted from inline `createBrowserRuntime` config
  in the browser example. Commit `b6bc7c1d8`. Replaces three inline
  constants and merges the per-run disable logic from
  `browser-action-availability.ts` (now deleted) into a single SSOT.
