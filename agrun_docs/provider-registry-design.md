# Provider Registry (`providers`) — Design

## 30-second read: why this exists

**一句话**：让接入方能插上**自己的 LLM**，而不是只能用我们写死的那三家（openai / gemini / deepseek）。

**打个比方——插座和插头**。以前 agrun 只有三种固定形状的插座孔，你的电器（自建模型、企业网关、新厂商）必须把插头**伪装**成其中一种才能用。现在我们装了一个**标准插座**：任何插头按约定的形状（`{ complete, stream?, normalizeRequest? }`）都能插进来。

| | 没有这个 | 有这个 |
|---|---|---|
| 接自己的 LLM | 假装成 OpenAI 兼容端点，或用私有的 `transport` 暗门 | 传一个 `providers: { "my-llm": {...} }` 就行 |
| 待遇 | 暗门绕过熔断/超时/计费 | 和内置三家**走同一条路**，自动获得熔断、超时、错误归因、计费 |

**为什么重要**：agrun 自称"通用"agent runtime，但"通用"不能只对三家厂商成立。写死的 `if/else` 让自建模型变成二等公民——这个改动把"插自己的 LLM"变成一等公民的、公开的、有校验的扩展点。

---

**Status:** DONE (P1+P2 implemented 2026-06-10). P1 behavior-identical dispatch refactor + P2 public `providers` option, validation, threading, tests, and docs all landed. P3 (vendor packs) remains optional/future.
**Gap:** 2026-06-10 codebase review P1. agrun claims to be a *general* agent runtime, but the LLM provider surface is a closed three-way `if/else` (`openai` / `gemini` / `deepseek`) hardcoded in `src/runtime/provider.js`. A host with its own LLM endpoint (self-hosted model, enterprise gateway, new vendor) must either masquerade as an OpenAI-compatible endpoint or rely on the **private** per-run `transport` seam that the code explicitly marks "Not exposed from src/index.js — only consumed by trusted in-repo callers" (provider.js, `isInjectedTransport` comment). A general runtime needs a public, named, runtime-level provider extension point.

## Verified anchors (current code)

| Piece | Where | What it does today |
|---|---|---|
| Supported list | `provider.js:8` `SUPPORTED_PROVIDERS = ["openai", "gemini", "deepseek"]` | Gates `isToolLoopProviderRequest` (`:24`) and `normalizeToolLoopProviderRequest` (`:33` throws `Unsupported provider`) |
| Dispatch (complete) | `provider.js:56-64` | `if/else` chain to `requestOpenAIChatCompletion` / `requestGeminiContent` / `requestDeepSeekChatCompletion` |
| Dispatch (stream) | `provider.js:104-112` | Same chain, `*Streaming` variants |
| Provider impls | `src/skills/providers/{openai,gemini,deepseek}-browser.js` | `complete` + `streaming` request functions, browser-safe fetch |
| Request normalize | `skills/providers/request.js` `normalizeBrowserProviderRequest(rawInput, provider)` | Shared shape for the three built-ins |
| Transport seam | `provider.js` `isInjectedTransport` | Per-run `{ complete, stream }` object on run input; **bypasses circuit breaker, provider-timeout wiring, and named-provider identity**; private by convention |
| Resilience chain | `provider.js:49-51, 65-72` | Circuit breaker keyed by `providerKey`; `attachProviderError(error, providerKey)` |
| Usage/cost chain | `src/session/token-budget.js` `createUsageSnapshot` | Reads raw vendor keys (`prompt_tokens`, `promptTokenCount`, …) **and** canonical camelCase aliases (`inputTokens`/`outputTokens`/`totalTokens`/`model`/`provider`) |
| Pricing | `runtimeConfig.costPricing` | Keyed by provider/model strings — already name-agnostic |
| Provider-specific leak | `provider.js` `createRequestOptions` `geminiThinkingConfig` | A vendor-specific field living in the generic request layer (pre-existing smell; see Out of scope) |

## Design constraints (standing decisions this must respect)

1. **No hardcode / general runtime.** Provider names are host vocabulary, not kernel vocabulary. The kernel owns the *mechanism* (dispatch, resilience, usage accounting); vendors are *entries*. Same legitimacy class as `customActions`.
2. **The resilience chain is part of the contract.** Whatever replaces the `if/else` must keep circuit breaker, per-call timeout (`provider-timeout.js` derives `timeoutMs`; entries receive it in `options`), `attachProviderError`, and stream-emitter wrapping applying uniformly — including to host-registered providers. This is exactly what the `transport` seam does NOT give, and why it stays a test seam.
3. **No module-level mutable registration.** `provider.js` functions are pure; two runtimes in one page must not share provider state. The registry is built in `config.js` and threaded through the request object — mirroring how `request.circuitBreaker` is already threaded.
4. **A default is also an opinion, but built-ins here are mechanism-completing**: shipping openai/gemini/deepseek as pre-registered entries keeps current behavior byte-identical and costs nothing when unused (they are already in the bundle; physical extraction is P3).

## Proposed API

```js
const runtime = createRuntime({
  providers: {
    "my-llm": {
      // Required. Same result contract the built-ins and the mock transport
      // already share: { text, usage, raw, status, toolCalls }.
      complete: async (options, fetchImpl) => ({ text, usage, raw, status }),
      // Required for streaming hosts; optional otherwise (runtime falls back
      // to complete() and emits the full text as one delta).
      stream: async (options, fetchImpl, onToken) => ({ text, usage, raw, status }),
      // Optional. Defaults to the shared generic normalizer.
      normalizeRequest: (rawInput) => request
    }
  }
});
await runtime.run({ provider: "my-llm", model: "...", apiKey: "...", prompt: "..." });
```

- `options` passed to `complete`/`stream` is the same normalized request the built-ins receive today (`endpoint`, `model`, `apiKey`, `timeoutMs`, `systemPrompt`, `conversation`, `parts`, …).
- **Usage contract for custom entries:** return `usage` with canonical camelCase keys (`inputTokens`, `outputTokens`, `totalTokens`, optionally `model`/`provider`) — `createUsageSnapshot` accepts them since the maxCostUsd fix, which makes cost-ledger/`maxCostUsd` work for custom providers with zero extra wiring (pricing via `costPricing["my-llm"]`).
- Name collision with a built-in (`openai`, `gemini`, `deepseek`) **throws at `createRuntime`** — overriding a built-in silently is a debugging trap; a host that wants a variant registers a new name.
- Validation at `createRuntime` (mirror `defineAction` strictness): entry must be an object, `complete` a function, `stream` a function when present; throw with the entry name in the message.

## Implementation sketch (mirror the threading of `circuitBreaker`)

| Step | File | Change |
|---|---|---|
| 1. Normalize | `config.js` | `normalizeProviders(config.providers)` → frozen map; merge over built-in entries (built-ins defined once, next to their impls) |
| 2. Thread | same path that puts `circuitBreaker` on the request | add `providerRegistry` to the provider request |
| 3. Membership | `provider.js` `isToolLoopProviderRequest` / `normalizeToolLoopProviderRequest` | accept registry from the raw input; `SUPPORTED_PROVIDERS` constant is replaced by registry keys (built-ins when no registry present, for pure-function callers in tests) |
| 4. Dispatch | `provider.js:56-64` and `:104-112` | `const entry = registry[options.provider]; if (!entry) throw …; entry.complete(options, options.fetch)` — both if/else chains deleted; breaker/error/stream wrapping unchanged around the call |
| 5. Error message | `provider.js` | `Unsupported provider "x". Registered: openai, gemini, deepseek, my-llm.` |

Phases:
- **P1 (behavior-identical refactor):** built-ins become registry entries; both `if/else` chains deleted; no public option yet. Litmus: `grep -n 'provider === "openai"' src/runtime/` → 0 hits; `npm test` green with zero test edits.
- **P2 (public option):** `providers` accepted by `createRuntime`; validation; unit test (custom provider completes a run; breaker records custom-provider failures; collision and bad-shape throw; unknown name error lists registered names); docs row in `public-runtime-api.md` + a custom-provider example in `usage-quickstart.md`.
- **P3 (optional, later):** physically move built-in entries to opt-in packs (mirror `@agrun/skills-*`) so a host wiring only `my-llm` tree-shakes vendor code out of the ESM build.

## Relationship to the `transport` seam

`transport` stays exactly what its comment says: a per-run, anonymous, bypass-everything seam for tests/replay/evals. The registry is the production path: named (circuit breaker + pricing + error attribution key on the name), runtime-level, validated. Do not document `transport` as a host extension point; do not break it.

## Out of scope

- `geminiThinkingConfig` and other vendor fields in the generic request layer — pre-existing; a `providerOptions` passthrough namespace is a separate cleanup, noted here so the registry doesn't accidentally legitimize more vendor fields in core.
- Provider-native tool-calling policy (ADR-0031 envelope default) — unchanged; entries return text, the planner protocol is above this layer.
- Embedding/search/reranker backends — action-scoped, not provider-scoped.
- npm-publishing provider packs (P3 packaging decision rides on the existing package-split infrastructure).

## Acceptance

1. P1: `npm run build && npm test` green with **no test file edits**; grep litmus passes; dist behavior byte-identical for the three built-ins.
2. P2: new unit test `test/unit/provider-registry.test.js` covering the five cases above; `npm test` green.
3. Docs: `public-runtime-api.md` gains the `providers` row; `usage-quickstart.md` gains a "Bring your own LLM" snippet; this doc flips to DONE with the implementing commit hash.
4. Browser example continues to work unmodified (built-ins unchanged); optional follow-up adds a "custom gateway" entry to its provider dropdown via the new option.
