# Provider Seam 2026-05-16

`grep -nE "request\.provider|providerCall" src/runtime/action-loop-planner.js` shows the planner seam at lines 166, 176, 198, 301, 306, and 358.

The action loop keeps the provider request as `session.request`, then `requestPlanner()` passes that same `request` into `planNextAction()`. `planNextAction()` is the only planner LLM boundary: it calls `requestProviderCompletion(options.request, ...)` in `src/runtime/planner.js` for native-tools or envelope mode. `action-loop-planner.js` records `request.provider` in planner/request/response/error steps and usage, but it does not choose the transport.

## Production dispatch

`src/runtime/provider.js` only knows two production providers: `SUPPORTED_PROVIDERS = ["openai", "gemini"]`. `requestProviderCompletion` / `requestProviderCompletionStreaming` dispatch by `options.provider` to `requestOpenAIChatCompletion*` or `requestGeminiContent*`. The circuit breaker (`request.circuitBreaker`) wraps that dispatch.

## Transport-injection seam (test / replay / eval)

Callers may attach a `transport` object to the provider request:

```
{
  provider: "<label>",
  transport: { complete(options), stream(options, onToken), [model], [provider] },
  prompt, ...
}
```

`isToolLoopProviderRequest()` accepts the request when `transport` is present, regardless of the `provider` label. `normalizeToolLoopProviderRequest()` routes it through `normalizeInjectedTransportRequest()`, which validates the prompt and forwards the transport to `createRequestOptions`. `requestProviderCompletion` / `requestProviderCompletionStreaming` short-circuit before the circuit breaker and call `transport.complete(options)` / `transport.stream(options, onToken)` directly.

This replaces the earlier `provider: "mock"` hard-coded branch. The transport seam is **not** exported from `src/index.js` — it is only consumed by trusted in-repo callers (test helpers, replay tools, evals). `test/helpers/mock-provider.mjs` exports `createMockProvider({ responses })` for the offline L1 plan-loop reproduction in `test/unit/mock-provider-plan-loop.test.js`.

Production bundles do not carry mock dispatch logic; the `mock` string is no longer in `SUPPORTED_PROVIDERS`.
