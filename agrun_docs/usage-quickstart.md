# agrun.js Usage Quickstart

This page is the fastest path from "I have `agrun.js`" to "I have a working chatbot." Read it before the full Public Runtime API reference.

## What is agrun.js?

`agrun.js` is a **browser-only agent runtime**. It is not an LLM client — it is what you put **in front of** OpenAI / Gemini to turn a single LLM call into a goal-driven loop:

- it picks **what to do next** (a planner LLM call)
- it executes **skills** (your code) and **actions** (built-in primitives like `web_search`, `read_url`, `ask_clarification`)
- it remembers session history and cross-session memory
- it asks for **human approval** before risky steps when the host opts in

Bundle the LLM provider and orchestration into one ~1.7 MB UMD file (`dist/agrun.js`) that runs in the browser. No Node.js server required.

Use it when you want an agent loop, planner, tool calling, sessions, memory, and approval — without assembling those primitives yourself on top of a raw provider SDK.

## Concepts (5-Minute Glossary)

| Term | Meaning | Where defined |
|------|---------|---------------|
| **Runtime** | One agent engine instance. Owns skills, sessions, memory, last-run state. | `createRuntime(options)` |
| **Skill** | A function the agent can call. You write these. Must define `name`, `canHandle(context)`, `execute(context)`. | `options.skills` |
| **Action** | A built-in primitive the planner can choose. Seven exist: `web_search`, `read_url`, `ask_clarification`, `execute_skill_tool`, `list_agent_skills`, `read_agent_skill`, `use_agent_skill`. | runtime-owned, not user-defined |
| **Agent skill** | An instruction package (markdown ROLE.md style) the planner reads to decide what tools to call. Different from `skill`. | `options.agentSkills` |
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
  const { createRuntime, openaiBrowserSkill, fallbackSkill } = Agrun;
</script>
```

For ES module / bundler use:

```js
import { createRuntime, openaiBrowserSkill, fallbackSkill } from "./dist/agrun.js";
```

API keys: enter them at runtime via `runtime.run({ provider, apiKey, ... })`. The runtime never reads `process.env`. The host application is responsible for not leaking the key — see [agrun_docs/spec.md](./spec.md) "Production Deployment Model."

## Hello World (Custom Skill, No LLM)

The smallest possible agrun runtime. No provider, no network. Useful for testing the harness itself.

```js
const echoSkill = {
  name: "echo",
  canHandle: (ctx) => ctx.input.type === "string",
  execute: (ctx) => ({ text: ctx.input.text })
};

const runtime = createRuntime({ skills: [echoSkill] });
const result = await runtime.run("hello");
console.log(result.output.text); // "hello"
```

## Real Chatbot (OpenAI, ~25 lines)

```js
import {
  createRuntime,
  openaiBrowserSkill,
  fallbackSkill,
  createIndexedDBSessionStore
} from "./dist/agrun.js";

const runtime = createRuntime({
  skills: [openaiBrowserSkill, fallbackSkill],
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

Swap `openaiBrowserSkill` for `geminiBrowserSkill` to run against Gemini. Swap `provider: "openai"` to `provider: "gemini"` in `session.run()`. Same loop, same result envelope.

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

## Add Web Search

```js
import { webSearchSkill } from "./dist/agrun.js";

const runtime = createRuntime({
  skills: [openaiBrowserSkill, webSearchSkill, fallbackSkill]
});
```

The planner now has the `web_search` action available and will use it autonomously when the prompt requires fresh information. Search results may auto-trigger `read_url` to fetch top pages — see [agrun_docs/research-and-evidence-model.md](./research-and-evidence-model.md).

## Disable Cross-Session Memory

Stop the per-turn semantic-extraction LLM call and skip all writes to the `globalMemory` IndexedDB store:

```js
createRuntime({
  skills: [openaiBrowserSkill, fallbackSkill],
  globalMemory: { enabled: false }
});
```

Per-session memory and `helpers.appendMemory()` keep working. Existing rows in IndexedDB are not deleted; toggle back to `enabled: true` to restore recall and promotion. See [Disabling Global Memory](./public-runtime-api.md#disabling-global-memory) for the full contract.

## Add Human Approval Before Risky Actions

```js
const runtime = createRuntime({
  skills: [openaiBrowserSkill, webSearchSkill, fallbackSkill],
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
| `createRuntime requires a non-empty "skills" array` | Forgot to pass `skills`. | Add at least one skill (e.g. `[fallbackSkill]`). |
| `Skill "X" must define canHandle() and execute()` | Skill object missing required methods. | Add both functions; see Concepts. |
| `result.output.kind === "approval_required"` | An `ask` policy action wants to run. | Show approval UI; resume with `session.run(approvalDecision)`. |
| `result.error?.code === "INVALID_PROVIDER_REQUEST"` | Bad request shape (missing `provider` / `apiKey` / `model` / `prompt`). | Inspect `result.error.details`; full code list in [src/runtime/errors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/errors.js). |
| `result.error` is set after a turn that called the LLM | Provider rejected the call (wrong key, bad model id, network failure, rate limit). | Inspect `result.error.message` and `result.error.details`; consider `circuitBreaker: true` to fail-fast after repeated failures. |
| Memory is not being remembered across sessions | `globalMemory.enabled === false`, or extracted entries fell below `minConfidence: 0.7`. | Verify config; lower `minConfidence` carefully; inspect `onStep` for `global-memory-filtered` events. |
| Skills run but planner never picks them | Planner does not see them. Check `agentSkills` (instructions) vs `skills` (executable). | Add a corresponding agent skill (`agentSkills`) that documents when to call your skill. |

## Where To Go Next

- **Feature toggles (enable / disable reference)** — [agrun_docs/feature-toggles.md](./feature-toggles.md).
- **Full configuration reference** — [Public Runtime API](./public-runtime-api.md).
- **Result envelope shape** — [Result Schema](./result-schema.md).
- **Error codes** — [src/runtime/errors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/errors.js).
- **Skill writing patterns** — [agrun_docs/skill-system-architecture.md](./skill-system-architecture.md).
- **OODAE walkthrough** — [agrun_docs/agentic-execution-flow.md](./agentic-execution-flow.md).
- **Approval contract** — [agrun_docs/approval-flow.md](./approval-flow.md).
- **Memory architecture** — [agrun_docs/runtime-state-and-memory-architecture.md](./runtime-state-and-memory-architecture.md).
