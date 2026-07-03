# agrun.js Usage Quickstart

This page is the fastest path from "I have `agrun.js`" to "I have a working chatbot." Read it before the full Public Runtime API reference.

## What is agrun.js?

`agrun.js` is a **browser-first agent runtime** that also runs in Node.js (>= 18). It is not an LLM client — it is what you put **in front of** OpenAI / Gemini / DeepSeek to turn a single LLM call into a goal-driven loop:

- it picks **what to do next** (a planner LLM call)
- it executes **skills** (your code) and **actions** (built-in primitives like `web_search`, `read_url`, `ask_clarification`)
- it remembers session history and cross-session memory
- it asks for **human approval** before risky steps when the host opts in

Bundle the LLM provider and orchestration into one ~1.7 MB UMD file (`dist/agrun.js`) that runs in the browser — no server is required. The same bundle also runs in Node.js (>= 18) for server-side hosts; see "Run in Node.js" below.

Use it when you want an agent loop, planner, tool calling, sessions, memory, and approval — without assembling those primitives yourself on top of a raw provider SDK.

## Concepts (5-Minute Glossary)

| Term | Meaning | Where defined |
|------|---------|---------------|
| **Runtime** | One agent engine instance. Owns provider adapters, actions, sessions, memory, last-run state. | `createRuntime(options)` |
| **Provider adapter skill** | Browser-safe wrapper that lets agrun call an LLM provider. `openaiBrowserSkill`, `geminiBrowserSkill`, and `deepseekBrowserSkill` are public exports. Deleted Set A skills are not. | `options.skills` |
| **Custom action** | A host-defined tool built with `defineAction(spec)`. Use this for app-specific executable behavior instead of legacy Set A skills. | `options.customActions` |
| **Action** | A built-in primitive the planner can choose. The registry includes web search/URL read, clarification, skill catalog/tool execution, TodoState, virtual workspace, handoff/subagent, and optional read-only repo tools when the host supplies `repoFileTools`. | runtime-owned, not user-defined |
| **Agent skill** | An instruction package (markdown SKILL.md style) the planner reads to decide what tools to call. Different from executable `skill`. Core defaults to no domain skills; opt in through `agentSkills` / `agentSkillIndexProvider` by loading your own SKILL.md agent skills (see [public-runtime-api.md → Skill Loading](./public-runtime-api.md)). | `options.agentSkills` |
| **Planner** | The LLM that decides which skill or action to run. Default `auto` lets agrun choose between `native_tools` (provider tool calling) and `envelope` (JSON parsing opt-out). | `options.plannerMode` |
| **Session** | Multi-turn conversation persisted across `runtime.run()` calls. Created via `runtime.createSession()` or `runtime.openSession(id)`. | `options.sessionStore` |
| **Memory** | Two layers: per-session `memoryEntries` (this conversation) + cross-session `globalMemory` (preferences/facts/decisions auto-promoted across sessions). | `options.globalMemory`, `options.memory` |
| **Approval** | Human confirmation gate before an action runs. Returns `output.kind === "approval_required"` with a resumable token. | `options.actionPolicy` |
| **OODAE** | The runtime loop: Observe → Orient → Decide → Act → Evaluate. You usually do not need to touch it directly. | runtime-internal |

## Install

agrun.js is a single browser-targeted UMD bundle. There is no npm publish today; consume the built file directly.

```html
<script src="dist/agrun.js"></script>
<script>
  const {
    createRuntime,
    deepseekBrowserSkill,
    geminiBrowserSkill,
    openaiBrowserSkill
  } = Agrun;
</script>
```

For ES module / bundler use:

```js
import {
  createRuntime,
  deepseekBrowserSkill,
  geminiBrowserSkill,
  openaiBrowserSkill
} from "./dist/agrun.js";
```

API keys: enter them at runtime via `runtime.run({ provider, apiKey, ... })`. The runtime never reads `process.env`. The host application is responsible for not leaking the key — see [agrun_docs/spec.md](./spec.md) "Production Deployment Model."

## Run in Node.js

The same UMD bundle is a supported Node.js (>= 18) host target — the runtime core uses no Node-only APIs, and the canonical live e2e test (`test/node-agrun-3000-live.mjs`) runs the full loop in Node.

```js
const { createRuntime, openaiBrowserSkill } = require("./dist/agrun.js");
const { createFsStorage } = require("./node/storage-fs.js");

const runtime = createRuntime({
  skills: [openaiBrowserSkill],
  storage: createFsStorage({ baseDir: "./.agrun/storage" })
});
```

Differences from the browser path:

- **Session storage**: the browser uses IndexedDB; in Node use the filesystem adapter `createFsStorage` (or any custom store) — see [node/README.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/node/README.md).
- **Event streaming to clients**: wrap the runtime with the opt-in SSE adapter `createSseHandler` from `node/runtime-sse-adapter.js`.
- **Repo file tools**: read-only repo access via `createNodeRepoFileTools` from `node/repo-file-tools.cjs` — see [public-runtime-api.md](./public-runtime-api.md) "Repo File Tools".
- Everything else (provider adapter skills, actions, sessions, memory, approval) is identical; provider skills use `fetch`, which Node >= 18 provides natively.

## Minimal Runtime Shell

The smallest possible agrun runtime. No provider, no network. Useful for checking the bundle and built-in action registry.

```js
const runtime = createRuntime();
console.log(runtime.getActionRegistry().map((action) => action.name));
```

## Real Chatbot (OpenAI, ~25 lines)

```js
import {
  createRuntime,
  openaiBrowserSkill,
  createIndexedDBSessionStore
} from "./dist/agrun.js";

const runtime = createRuntime({
  skills: [openaiBrowserSkill],
  sessionStore: createIndexedDBSessionStore({ dbName: "my-app" })
});

const session = await runtime.createSession();

async function ask(prompt) {
  const result = await session.run({
    provider: "openai",
    apiKey: window.OPENAI_KEY,            // host-supplied
    model: "gpt-4.1-mini",
    prompt
  }, {
    onStep: (step) => console.log(step.type, step.detail)
  });

  if (result.output?.kind === "approval_required") {
    return `(needs approval: ${result.output.text})`;
  }
  if (result.error) {
    return `(error: ${result.error.message})`;
  }
  return result.output.text;
}

console.log(await ask("Hi, what can you do?"));
console.log(await ask("Remember I prefer SGD.")); // promoted to globalMemory
```

That gives you: planner-driven LLM loop, IndexedDB-persisted session, auto cross-session memory, structured step events, error envelope, and approval handling — in 25 lines.

Swap `openaiBrowserSkill` for `geminiBrowserSkill` or `deepseekBrowserSkill` to run against Gemini or DeepSeek. Swap `provider: "openai"` to `provider: "gemini"` or `provider: "deepseek"` in `session.run()`. Same loop, same result envelope.

## OpenAI Responses API

`openaiBrowserSkill` uses OpenAI Chat Completions by default. If your OpenAI-compatible endpoint supports the Responses API and you want reasoning summaries, opt in per request with `apiVariant: "responses"`.

```js
const result = await session.run({
  provider: "openai",
  apiKey: window.OPENAI_KEY,                 // host-supplied
  endpoint: "https://gpt.example.com/v1",    // base URL, not /responses
  model: "gpt-5-mini",
  prompt: "Explain why smoke tests are useful.",

  apiVariant: "responses",
  reasoningEffort: "high",
  reasoningSummary: "auto"
});

console.log(result.output.text);
console.log(result.output.reasoningSummary);
```

Rules:

- Keep `endpoint` as the OpenAI-compatible base URL such as `https://gpt.example.com/v1`; agrun adds `/responses`.
- `apiVariant` defaults to `"chat"` for backward compatibility. Use `"responses"` only when the host endpoint supports `/v1/responses`.
- `reasoningSummary` accepts `"auto"`, `"concise"`, `"detailed"`, or `null`.
- `reasoningEffort` accepts `"minimal"`, `"low"`, `"medium"`, `"high"`, plus provider/model-specific values such as `"none"` or `"xhigh"` when supported.
- To force no tool calls on a Responses API request that includes tools, pass `toolChoice: "none"`.
- `reasoningSummary` is optional in the output. Some models or prompts may return normal `text` and `usage` without a summary.

## DeepSeek Native Provider

DeepSeek is a native provider path, not only an OpenAI-compatible custom endpoint fallback.

```js
import { createRuntime, deepseekBrowserSkill } from "./dist/agrun.js";

const runtime = createRuntime({
  skills: [deepseekBrowserSkill]
});
const session = await runtime.createSession();

const result = await session.run({
  provider: "deepseek",
  apiKey: window.DEEPSEEK_KEY,       // host-supplied
  model: "deepseek-v4-flash",
  prompt: "Summarize the runtime contract in one paragraph."
});

console.log(result.output.text);
```

## Bring Your Own LLM (custom provider)

Beyond the three built-ins, register any LLM endpoint with `providers`. The
entry dispatches through the same path as the built-ins — circuit breaker,
per-call timeout, cost ledger — so a self-hosted model or enterprise gateway
is a first-class provider, not a masquerade.

```js
const runtime = createRuntime({
  providers: {
    "my-llm": {
      // Required. Same result shape as the built-ins.
      async complete(options /* , fetch */) {
        const res = await fetch(options.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model: options.model, prompt: options.prompt })
        });
        const data = await res.json();
        return {
          text: data.output,
          status: res.status,
          raw: data,
          // camelCase usage keys → costPricing / maxCostUsd work for free
          usage: { inputTokens: data.in_tokens, outputTokens: data.out_tokens }
        };
      }
      // Optional: stream(options, fetch, onToken). Omit it and the runtime
      // calls complete() and emits the full text as one delta.
    }
  }
});

const result = await runtime.run({
  provider: "my-llm",
  apiKey: window.MY_LLM_KEY,
  model: "my-model-v1",
  endpoint: "https://llm.internal/v1/generate",
  prompt: "Summarize the runtime contract in one paragraph."
});
```

Built-in names (`openai`/`gemini`/`deepseek`) cannot be overridden, and a
malformed entry throws at `createRuntime`. The private per-run `transport`
seam still exists for tests/replay but is **not** the host extension point —
use `providers`. Full contract: [public-runtime-api.md](./public-runtime-api.md).

## Crash Recovery (export / resume run state)

For long runs in a crash-prone tab, persist a checkpoint each cycle and
resume after a reload. `exportState` produces a versioned, **redacted**
(no `apiKey`) plain-JSON envelope; `importState` validates it and returns a
runState you pass back via `resumeState`.

```js
import { createRuntime, exportState, importState } from "agrun";

const runtime = createRuntime({ providers: { /* ... */ } });
const request = { provider: "openai", model: "gpt-5-mini", apiKey, prompt };

// Persist a checkpoint at every cycle boundary (best-effort; never blocks).
await runtime.run(request, {
  onCheckpoint: (envelope) => localStorage.setItem("agrun:ck", JSON.stringify(envelope))
});

// After a reload / crash — re-supply the apiKey, resume from the checkpoint.
const saved = localStorage.getItem("agrun:ck");
if (saved) {
  await runtime.run(request, { resumeState: importState(JSON.parse(saved)) });
}
```

`resumeState` restores the in-flight runState (cycle counter, cost ledger,
virtual workspace, todo/research/OODAE state, pending approval) and continues
from the saved **cycleCount** — completed cycles are not re-run. It does NOT
restore the per-turn action history or conversation; for full conversational
continuity combine it with a persisted session (`runtime.openSession(id)`).
Secrets never serialize: `apiKey` is re-supplied at resume time. Details:
[run-state-export-import-design.md](./run-state-export-import-design.md).

## Host Hooks (inspect / rewrite mid-run)

Pass per-run hooks as the second argument to `run()`. The runtime awaits these
loop-scope hooks, so each is raced against a timeout budget — **a hook that
hangs is ignored (the run proceeds), never freezes the loop.** The budget
defaults to 10s; set `hostHookTimeoutMs` on `createRuntime` to change it.

```js
const runtime = createRuntime({
  providers: { /* ... */ },
  hostHookTimeoutMs: 5000   // optional; default 10000
});

await runtime.run(request, {
  // Inspect/rewrite the planner's decision before it executes. Return a new
  // decision object to replace it, or nothing to leave it unchanged.
  onPlannerDecision: (decision, runState) => decision,
  // Augment/replace a tool result before the planner sees it.
  onToolResult: (output, { actionName }) => output,
  // Veto a finalize: return { continue: true, observation } to keep working.
  onBeforeFinalize: (runState, { source }) => null,
  // Repair an unparseable planner envelope (return a corrected decision).
  onInvalidPlannerOutput: (rawText, parseError) => null
});
```

`onCheckpoint` (above) is fire-and-forget — it is not awaited and cannot block.
Code inside a custom `action.execute()` (and bundled skill tools) is covered by
the separate per-action timeout (`timeoutMs` on the action, default 30s).

## Add Web Search

```js
const runtime = createRuntime({
  skills: [openaiBrowserSkill],
  actionPolicy: { web_search: "allow", read_url: "ask" }
});

await session.run({
  provider: "openai",
  apiKey: window.OPENAI_KEY,
  model: "gpt-4.1-mini",
  prompt: "Find current release notes and summarize them.",
  webSearchEndpoint: "https://search.example.test",
  fetch
});
```

The planner has the runtime-owned `web_search` action available and will use it autonomously when the prompt requires fresh information. Hosts must provide a SearXNG endpoint or Gemini grounding proxy; agrun no longer ships a default endpoint. Search results may trigger `read_url` to fetch top pages — see [agrun_docs/research-and-evidence-model.md](./research-and-evidence-model.md).

## Disable Cross-Session Memory

Stop the per-turn semantic-extraction LLM call and skip all writes to the `globalMemory` IndexedDB store:

```js
createRuntime({
  skills: [openaiBrowserSkill],
  globalMemory: { enabled: false }
});
```

Per-session memory and `helpers.appendMemory()` keep working. Existing rows in IndexedDB are not deleted; toggle back to `enabled: true` to restore recall and promotion. See [Disabling Global Memory](./public-runtime-api.md#disabling-global-memory) for the full contract.

## Add Human Approval Before Risky Actions

```js
const runtime = createRuntime({
  skills: [openaiBrowserSkill],
  actionPolicy: { web_search: "ask", read_url: "ask" }
});
```

When the planner picks an `ask`-policy action, `runtime.run()` resolves with `output.kind === "approval_required"` and `runState.pendingApproval`. The host shows a UI; on user click, call `session.run(approvalDecision)` with the resume token. Full flow: [agrun_docs/approval-flow.md](./approval-flow.md).

## When To Use What

| You want… | Use |
|-----------|-----|
| One-shot turn, no history | `runtime.run(input)` (no session) |
| Multi-turn chat with history | `runtime.createSession()` then `session.run(input)` |
| Persistent across browser refresh | `sessionStore: createIndexedDBSessionStore({ dbName })` |
| Same LLM provider, multi-turn | reuse one session |
| Different conversation, same runtime | `runtime.createSession()` again |
| Multiple users on shared device | scope `dbName: \`agrun-${userId}\`` per user |
| Streaming output | `runOptions.onToken: (delta) => …` |
| Visibility into planner / actions | `runOptions.onStep: (step) => …` |
| Cancel cross-session memory entirely | `globalMemory: { enabled: false }` |
| Block specific actions globally | `disabledActions: ["read_url"]` |
| Custom planner persona | `role: "researcher"` (bundled) or `role: { name, instructions }` |

## Common Errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| A deleted Set A export such as `fallbackSkill` is `undefined` | The v1.0.0 public bundle removed Set A exports. | Use provider adapters, `customActions`, and `agentSkills` instead. |
| SearXNG search fails before fetch | No `webSearchEndpoint` was supplied. | Pass a host-owned endpoint or use Gemini grounding proxy fields. |
| `result.output.kind === "approval_required"` | An `ask` policy action wants to run. | Show approval UI; resume with `session.run(approvalDecision)`. |
| `result.error?.code === "INVALID_PROVIDER_REQUEST"` | Bad request shape (missing `provider` / `apiKey` / `model` / `prompt`). | Inspect `result.error.details`; full code list in [src/runtime/errors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/errors.js). |
| `result.error` is set after a turn that called the LLM | Provider rejected the call (wrong key, bad model id, network failure, rate limit). | Inspect `result.error.message` and `result.error.details`; consider `circuitBreaker: true` to fail-fast after repeated failures. |
| Memory is not being remembered across sessions | `globalMemory.enabled === false`, or extracted entries fell below `minConfidence: 0.7`. | Verify config; lower `minConfidence` carefully; inspect `onStep` for `global-memory-filtered` events. |
| Skills run but planner never picks them | Planner does not see them. Check `agentSkills` (instructions) vs `skills` (executable). | Add a corresponding agent skill (`agentSkills`) that documents when to call your skill. |
| Built-in research/coder skills are missing | Core defaults to `agentSkills: []`; no domain skill is loaded implicitly. | Provide your own SKILL.md agent skills via `agentSkills` / `agentSkillIndexProvider`. (The `@agrun/skills-*` packages were removed in AGRUN-522 — research is a portable host-supplied skill, not a package.) |

## Where To Go Next

- **Feature toggles (enable / disable reference)** — [agrun_docs/feature-toggles.md](./feature-toggles.md).
- **Full configuration reference** — [Public Runtime API](./public-runtime-api.md).
- **Result envelope shape** — [Result Schema](./result-schema.md).
- **Error codes** — [src/runtime/errors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/errors.js).
- **Skill writing patterns** — [agrun_docs/skill-system-architecture.md](./skill-system-architecture.md).
- **OODAE walkthrough** — [agrun_docs/agentic-execution-flow.md](./agentic-execution-flow.md).
- **Approval contract** — [agrun_docs/approval-flow.md](./approval-flow.md).
- **Memory architecture** — [agrun_docs/runtime-state-and-memory-architecture.md](./runtime-state-and-memory-architecture.md).
