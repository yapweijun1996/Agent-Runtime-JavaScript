# AG2B + Vercel AI SDK — Learning Notes for agrun

Date: 2026-06-07
Source: https://github.com/ag2b/ag2b (MIT), https://sdk.vercel.ai (Apache 2.0)
Sample code at: `sample-projects/ag2b/`

## Executive Summary

AG2B is the closest peer project to agrun — a browser-first TypeScript agent runtime that runs the agent loop in the client. Vercel AI SDK is the gold standard for JS AI streaming + tool use. Together they validate agrun's direction AND reveal concrete improvements in hooks, scoping, streaming granularity, and error handling.

**Verdict**: AG2B's hook system is the single most actionable pattern. Vercel AI SDK's `fullStream` typed parts are the reference for streaming architecture.

---

## Part 1: AG2B — Browser-First Agent Runtime

### 1.1 Architecture Overview

```
Agent
├── Provider (AbstractProvider) — LLM abstraction
├── History — append-only message log
├── ScopeRegistry — scoped tool + context groups
│   └── Scope[] — each = { name, tools[], context(), injection, enabled() }
├── HookRunner — 11 lifecycle hooks (6 observers + 5 interceptors)
└── Plugin system — agent.use(plugin) installs hook bundles
```

**Agent loop** (the core — `agent.ts:205-233`):
```
while (true):
    runIteration() → provider call + hooks
    if no tool calls → return content (DONE)
    for each tool call:
        executeTool() → find tool → preToolCall hook → handler → resolve/reject
    if ++iteration >= maxIterations → throw
```

Key design: the loop is **remarkably simple** — 30 lines. All complexity (guardrails, caching, retry) lives in **hooks**, not the loop body.

### 1.2 Hook System — The Most Valuable Pattern

AG2B has 11 typed lifecycle hooks, split into two categories:

**Observers** (fire-and-forget, no return value modification):
| Hook | When | agrun equivalent |
|------|------|------------------|
| `onChatStart` | Before user message appended | Begin action loop cycle |
| `onChatDone` | After final response | Note cycle completed |
| `onChatAbort` | Abort signal received | (missing in agrun) |
| `onChatError` | Non-abort error | (ad-hoc error handling) |
| `onMessage` | Each message pushed to history | `pushStep()` in result |
| `onScopeRegister` / `onScopeUnregister` | Scope changes | (no equivalent) |

**Interceptors** (can modify or short-circuit the operation):
| Hook | What it can do | agrun equivalent |
|------|---------------|------------------|
| `preRequest` | Modify request OR skip provider with synthetic response | `requestPlanner()` is monolithic |
| `onResponse` | Replace LLM response before history | `handleInvalidPlannerDecision()` scattered |
| `preToolCall` | Modify args OR skip handler (cache/error) | `policy.js` approve/deny |
| `onToolCallResult` | Transform tool result before history | `normalizeActionResultEnvelope()` |
| `onToolCallError` | Rewrite/classify error before history | (ad-hoc) |

**Return type pattern** (the clever part):
```typescript
// preRequest return type — THREE outcomes from ONE type
type PreRequestReturn =
  | void                                    // continue normally
  | { request: ProviderRequest }            // modify request
  | { response: ProviderResponse }          // skip provider entirely (cache hit)
```

This **discriminated union return** means the hook runner can resolve intent without ambiguity:
- `void` → proceed
- `{ request }` → use modified request
- `{ response }` → short-circuit (no provider call)

Same pattern for `preToolCall`: `void | { call } | { result } | { error }`.

### 1.3 What agrun Can Adopt: Hook-Driven Architecture

**Current agrun problem**: The OODAE loop has terminal repair, output guardrails, stuck detection, and policy enforcement **interleaved** in the loop body. Adding a new concern means touching 4+ files.

**AG2B-inspired solution**: Extract these as hooks:

```javascript
// Proposed: agrun hook system (inspired by AG2B)
const agent = createAgent({
  provider,
  hooks: {
    preRequest: [terminalRepairHook, cacheHook],
    onResponse: [outputGuardrailHook, stuckDetectionHook],
    preToolCall: [policyHook, rateLimitHook],
    onToolCallResult: [citationVerificationHook],
  }
});
```

**Benefit**: Each concern becomes a single-file hook module. The agent loop shrinks to 30 lines. New concerns (model routing, cost tracking) become hooks without touching core loop.

**Implementation note**: This is the SAME extraction pattern used for `observer.mjs` (was inline in `live-observe.mjs`, now standalone). Hooks are the next `observer.mjs` — extract interleaved concerns into pluggable modules.

### 1.4 Scope System — Grouped Tools + Live Context

AG2B's `Scope` groups tools with their context:

```typescript
const appearanceScope = new Scope({
  name: 'appearance',
  tools: [setBackground, setFont, setTheme],
  context: () => ({ currentTheme: uiState.theme, colors: uiState.colors }),
  injection: 'system',  // injected into system prompt every turn
  enabled: () => user.hasPermission('appearance'),
});
```

**Injection strategies**:
- `'system'` — appended to system prompt (cache-friendly, compose)
- `'user'` — appended to user message (volatile data, won't bust cache)

**agrun implication**: agrun's flat `runState` has 80+ fields. Grouping by domain scopes would provide:
1. Clear tool → domain mapping
2. Per-domain context injection (instead of dumping everything)
3. Dynamic enable/disable per scope
4. Cleaner prompt assembly (only active scope context)

### 1.5 Typed Event System

AG2B defines 12 typed events as a discriminated union:

```typescript
type AgentEvent =
  | AgentChatStart       // { type: 'agent_chat_start', message }
  | AgentChatDone        // { type: 'agent_chat_done', response }
  | AgentChatAbort       // { type: 'agent_chat_abort', reason }
  | AgentChatError       // { type: 'agent_chat_error', error }
  | AgentContentDelta    // { type: 'agent_content_delta', delta }
  | AgentContentEnd      // { type: 'agent_content_end' }
  | AgentReasoningDelta  // { type: 'agent_reasoning_delta', delta }
  | AgentReasoningEnd    // { type: 'agent_reasoning_end' }
  | AgentToolCallDelta   // { type: 'agent_tool_call_delta', index, id?, name?, argumentsDelta }
  | AgentToolCallStart   // { type: 'agent_tool_call_start', call }
  | AgentToolCallResult  // { type: 'agent_tool_call_result', call, result }
  | AgentToolCallError   // { type: 'agent_tool_call_error', call, error }
```

**Terminal events are mutually exclusive**: `done | abort | error`. The type system guarantees exactly one fires per chat.

**agrun implication**: agrun's observer JSONL already has `channel` + `type` discrimination. Formalizing as a TypeScript discriminated union would:
1. Enable TypeScript exhaustiveness checking on event handlers
2. Make the contract explicit (vs implicit JSONL shape)
3. Auto-complete in IDE for event consumers

### 1.6 Error Taxonomy

AG2B defines 6 specific error types:

| Error | When | Carries |
|-------|------|---------|
| `Ag2bError` | Base class | — |
| `Ag2bProviderRequestError` | HTTP non-OK | `status`, `body` |
| `Ag2bProviderResponseError` | Malformed payload | `body` |
| `Ag2bMaxIterationsError` | Loop exceeded | `iterations` |
| `Ag2bToolValidationError` | Zod validation fail | `tool`, `issues[]` |
| `Ag2bUnknownToolError` | Hallucinated tool | `tool` |
| `Ag2bDisabledToolError` | Tool disabled | `tool` |

**Error serialization** (`errors.ts:92-97`):
```typescript
export const serializeError = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { ...value, name: value.name, message: value.message };
  }
  return value;
};
```
Note: explicitly spreads `name` and `message` because they're non-enumerable on `Error.prototype`.

**agrun implication**: agrun's error handling is ad-hoc (try/catch with string messages). Formalizing error types would:
1. Enable structured error logging in observer JSONL
2. Allow the LLM to receive typed error feedback (not just strings)
3. Support error-based hook routing

### 1.7 Plugin System

AG2B plugins are just functions that call `agent.addHook()`:

```typescript
type Ag2bPlugin = (agent: Agent) => void | (() => void);  // optional cleanup

// Example: WebMCP plugin
const webmcpPlugin: Ag2bPlugin = (agent) => {
  agent.addHook('preRequest', (ctx) => {
    // Inject WebMCP tools into request
  });
  return () => { /* cleanup on unmount */ };
};

await agent.use(webmcpPlugin);
```

**agrun implication**: This is already partially done — `observer.mjs` is a standalone module that "plugs into" the runtime. A formal plugin interface would make ALL extensions follow the same pattern.

---

## Part 2: Vercel AI SDK — Streaming Architecture Reference

### 2.1 `fullStream` — Typed Stream Parts

Vercel AI SDK's `result.fullStream` emits typed parts. This is the gold standard for streaming architecture:

| Part Type | Purpose | agrun equivalent |
|-----------|---------|------------------|
| `start` | Stream init | observer event `step_start` |
| `text-start/delta/end` | Incremental text | (not streamed — agrun buffers full response) |
| `reasoning-start/delta/end` | Chain-of-thought | (not captured separately) |
| `tool-input-start/delta/call` | Tool call streaming | observer event `action-start` |
| `tool-error` | Validation failure | observer event `action-error` |
| `source` | Citation source | (not in stream — in final report) |
| `finish` | Completion + usage | observer event `cycle_completed` |
| `error` | Stream error | observer event `error` |

**agrun implication**: agrun's observer currently captures events at the **action** granularity. Vercel AI SDK shows the value of **sub-action** streaming — text deltas, reasoning deltas, tool-input deltas. This would let the debugger/inspector show real-time progress within a single action.

### 2.2 `maxSteps` + Automatic Tool Loop

```typescript
const result = await generateText({
  model,
  tools: { webSearch, readUrl },
  maxSteps: 10,  // automatically runs tool loop up to 10 iterations
  messages,
});
```

The provider **internally** handles: model → tool call → execute → feed result → model → ... until maxSteps or no more tool calls.

**agrun comparison**: agrun **owns** the loop explicitly (OODAE cycle). This gives more control but more complexity. The tradeoff:
- Vercel approach: simpler API, less control over intermediate steps
- agrun approach: full control over each cycle (phase tracking, repair injection)

**Lesson**: Both are valid. agrun's explicit loop is the right choice for its domain (research reports need repair injection). But the Vercel approach shows where agrun could offer a **simplified mode** — a `maxSteps` wrapper for simple tasks that don't need OODAE phase tracking.

### 2.3 Provider-V4 Interface

```typescript
interface LanguageModelV4 {
  doGenerate(options): Promise<LanguageModelResponse>;
  doStream(options): Promise<StreamedResponse>;
}
```

Two methods, both returning typed responses. The provider handles all the complexity of API-specific formats.

**agrun comparison**: agrun's `provider.js` is API-key + endpoint mapping. The Vercel approach of a **formal provider interface** with typed `doGenerate`/`doStream` would make adding new providers a matter of implementing two methods.

### 2.4 Error Categorization

Vercel AI SDK (quests-org implementation) categorizes errors in assistant message metadata:

| Category | When |
|----------|------|
| `aborted` | User cancel or timeout |
| `api-call` | HTTP error from provider |
| `api-key` | Invalid/missing key |
| `invalid-tool-input` | Parameter validation fail |
| `no-such-tool` | Hallucinated tool |
| `unknown` | Unexpected runtime error |

**agrun implication**: This matches AG2B's error taxonomy. Both indicate that **structured error categories** (not just strings) are the industry standard. agrun should adopt this.

### 2.5 AI SDK Elements — UI Components for Streaming

Vercel's React components for rendering streaming agent state:

| Component | Use |
|-----------|-----|
| `<Reasoning>` / `<ReasoningTrigger>` | Agent thoughts — auto-open while streaming, collapse when done |
| `<Tool>` with state badges | Tool calls: pending → running → completed → error |
| `<ChainOfThought>` | Multi-step reasoning with search results, images |
| `<Message>` / `<MessageContent>` | Streaming user/assistant messages |

**agrun implication**: agrun's inspector panel (browser DevTools) could adopt similar visual patterns — showing reasoning as a collapsible section, tool calls with status badges, and streaming content.

---

## Part 3: Cross-Cutting Patterns (Both Projects)

### 3.1 The "Simple Core + Pluggable Hooks" Pattern

Both AG2B and Vercel AI SDK follow the same architecture: **the agent loop is simple and small; all policy/logic lives in hooks/middleware**.

| Concern | AG2B | Vercel AI SDK | agrun (current) |
|---------|------|---------------|-----------------|
| Loop | 30-line `while(true)` | `maxSteps` in provider | 200+ line OODAE with interleaved repair |
| Guardrails | `preToolCall` hook | Tool approval callback | `policy.js` + `terminal-repair-state.js` |
| Caching | `preRequest` short-circuit | `onGenerate` middleware | (none) |
| Observability | `AgentEvent` stream | `fullStream` parts | Dual-stream observer JSONL |
| Error handling | Typed errors + `onToolCallError` | Error categories in metadata | Ad-hoc try/catch |

**agrun should converge toward this pattern**: extract terminal repair, output guardrails, stuck detection, and policy as hooks. The OODAE loop becomes a simple 5-phase iteration with pluggable hooks at each phase boundary.

### 3.2 Zod as the Contract Layer

Both AG2B and Vercel AI SDK use **Zod** for:
- Tool parameter validation (runtime type checking)
- JSON Schema generation for LLM tool definitions
- Structured output parsing

**agrun implication**: agrun's `action-contract.js` validates actions manually. Switching to Zod (or a similar schema library) would:
1. Auto-generate JSON Schema for LLM tool definitions
2. Provide better validation error messages
3. Enable TypeScript type inference from schemas

### 3.3 Provider Abstraction

Both projects have a clean provider interface:

| Capability | AG2B (`AbstractProvider`) | Vercel AI SDK (`LanguageModelV4`) |
|-----------|--------------------------|----------------------------------|
| Generate | `generate(request)` | `doGenerate(options)` |
| Stream | `stream(request)` | `doStream(options)` |
| Context injection | `prepareRequest()` | (handled by caller) |
| Tool format conversion | Provider-specific | Provider-specific |

**agrun implication**: agrun's provider layer (`provider.js`, `provider-seam-*.js`) could be simplified into a single `Provider` interface with `generate()` and `stream()` methods.

---

## Part 4: Concrete Action Items

### Short-term (this milestone)
- [ ] **Extract HookRunner** — create `src/runtime/hook-runner.js` based on AG2B's pattern. Start with 3 hooks: `preRequest`, `onResponse`, `preToolCall`. These cover terminal repair, output guardrails, and policy.
- [ ] **Formalize AgentEvent types** — create `src/runtime/agent-events.js` as a discriminated union matching the observer JSONL shape + AG2B's granular events (add `reasoning_delta`, `tool_input_delta`)
- [ ] **Formalize error taxonomy** — 6 error types: `ProviderRequestError`, `ProviderResponseError`, `MaxIterationsError`, `ToolValidationError`, `UnknownToolError`, `DisabledToolError`

### Medium-term (next milestone)
- [ ] **Migrate terminal repair to hooks** — `terminal-repair-state.js` becomes a `preRequest` + `onResponse` hook pair, removed from the OODAE loop body
- [ ] **Migrate policy to preToolCall hook** — `policy.js` becomes a `preToolCall` hook with `{ call } | { error }` return
- [ ] **Scope system for tool grouping** — group agrun's tools by domain (browser, workspace, research) with per-scope context injection
- [ ] **Sub-action streaming** — add `text_delta`, `reasoning_delta`, `tool_input_delta` events to observer for real-time inspector updates

### Long-term / research
- [ ] **Plugin system** — `runtime.use(plugin)` following AG2B's pattern, where plugins are just hook bundles
- [ ] **Simplified mode** — `runtime.runSimple(prompt, { maxSteps })` wrapper for tasks that don't need OODAE
- [ ] **Zod-based tool contracts** — replace manual action validation with Zod schemas

---

## Part 5: Comparison Matrix

| Dimension | agrun | AG2B | Vercel AI SDK |
|-----------|-------|------|---------------|
| **Runtime** | Browser JS | Browser JS | Node.js / Edge |
| **Agent loop** | OODAE 5-phase | Simple while(true) | maxSteps in provider |
| **Tool system** | action-contract + policy | Zod schema + enabled() | Zod + execute |
| **Hooks** | Interleaved in loop | 11 typed hooks (pre+on) | Middleware callbacks |
| **Streaming** | Dual-stream observer JSONL | AgentEvent generator | fullStream typed parts |
| **Error handling** | Ad-hoc strings | 6 typed error classes | Categories in metadata |
| **Tool grouping** | Flat (skill-tool vs runtime-action) | Scope system | Flat tool list |
| **Provider abstraction** | API key mapping | AbstractProvider interface | LanguageModelV4 interface |
| **Graceful degradation** | AGRUN-307/309 (unique) | None | None |
| **Citation verification** | Evidence graph (unique) | None | None |
| **UI framework** | Inspector panel | React hooks + chat UI | AI SDK Elements |
| **Plugin system** | None | agent.use(plugin) | None |

---

## References

- AG2B source: `sample-projects/ag2b/packages/core/src/`
- Key file: `agent/agent.ts` — Agent.loop + runIteration + executeTool (343 lines)
- Key file: `hooks/hooks.ts` — 11 typed lifecycle hooks (300 lines)
- Key file: `hooks/hook-runner.ts` — Hook runner with short-circuit logic (129 lines)
- Key file: `scope/scope.ts` — Scope with context + injection strategy (134 lines)
- Key file: `tool/tool.ts` — Zod-based tool with schema stripping (149 lines)
- Key file: `agent/event.ts` — 12 typed events as discriminated union (150 lines)
- Key file: `errors.ts` — 6 typed error classes (98 lines)
- Vercel AI SDK: https://sdk.vercel.ai/docs
- DeepWiki architecture: https://deepwiki.com/vercel/ai/1.1-architecture-and-design-principles
