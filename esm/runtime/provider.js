import { requestDeepSeekChatCompletionStreaming, requestDeepSeekChatCompletion } from '../skills/providers/deepseek-browser.js';
import { requestGeminiContentStreaming, requestGeminiContent } from '../skills/providers/gemini-browser.js';
import { requestOpenAIChatCompletionStreaming, requestOpenAIChatCompletion } from '../skills/providers/openai-browser.js';
import { normalizeBrowserProviderRequest } from '../skills/providers/request.js';
import { attachProviderError } from './provider-error.js';
import { normalizeProviderRetry, isTransientProviderError, waitMs, providerRetryDelayMs } from './provider-retry.js';
import { createProviderStreamEmitter } from './provider-stream-events.js';

// ADR/provider-registry-design.md — built-in providers are registry entries,
// not a hardcoded if/else. Each entry is `{ complete, stream }`; a host can
// register more via `createRuntime({ providers })` (P2), which merges over
// this map. `resolveProviderEntry` reads `options.providerRegistry` (the
// merged map threaded onto the request) and falls back to the built-ins for
// pure-function callers (tests, direct dispatch) that never thread a config.
const BUILTIN_PROVIDERS = Object.freeze({
  openai: Object.freeze({
    complete: requestOpenAIChatCompletion,
    stream: requestOpenAIChatCompletionStreaming
  }),
  gemini: Object.freeze({
    complete: requestGeminiContent,
    stream: requestGeminiContentStreaming
  }),
  deepseek: Object.freeze({
    complete: requestDeepSeekChatCompletion,
    stream: requestDeepSeekChatCompletionStreaming
  })
});

const BUILTIN_PROVIDER_NAMES = Object.freeze(Object.keys(BUILTIN_PROVIDERS));

function resolveProviderRegistry(options) {
  const registry = options && options.providerRegistry;
  return registry && typeof registry === "object" ? registry : BUILTIN_PROVIDERS;
}

function resolveProviderEntry(options) {
  const registry = resolveProviderRegistry(options);
  const entry = registry[options.provider];
  if (!entry) {
    const registered = Object.keys(registry).join(", ") || "(none)";
    throw new Error(`Unsupported provider "${options.provider}". Registered: ${registered}.`);
  }
  return entry;
}

// `registry` is the merged built-in + host provider map (runtimeConfig
// .providerRegistry). Omitted by pure-function callers (tests) → built-ins.
function registryHas(registry, name) {
  const map = registry && typeof registry === "object" ? registry : BUILTIN_PROVIDERS;
  return Boolean(name) && Object.prototype.hasOwnProperty.call(map, name);
}

function isToolLoopProviderRequest(rawInput, registry) {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return false;
  }

  if (readString$D(rawInput, "prompt").length === 0) {
    return false;
  }

  if (isInjectedTransport(rawInput.transport)) {
    return true;
  }

  return registryHas(registry, readString$D(rawInput, "provider", "providerId"));
}

function normalizeToolLoopProviderRequest(rawInput, registry) {
  const provider = readString$D(rawInput, "provider", "providerId");

  if (isInjectedTransport(rawInput && rawInput.transport)) {
    return normalizeInjectedTransportRequest(rawInput, provider);
  }

  const map = registry && typeof registry === "object" ? registry : BUILTIN_PROVIDERS;
  if (!registryHas(map, provider)) {
    const registered = Object.keys(map).join(", ") || "(none)";
    throw new Error(`Unsupported provider "${provider || "unknown"}". Registered: ${registered}.`);
  }

  // Host entries may supply their own normalizer; built-ins (and custom
  // entries that omit one) use the shared browser normalizer, which enforces
  // the generic apiKey/model/prompt requirements and the canonical request
  // shape. The resolved registry is carried on the request so downstream
  // dispatch resolves the same entry.
  const entry = map[provider];
  const request = entry && typeof entry.normalizeRequest === "function"
    ? entry.normalizeRequest(rawInput)
    : normalizeBrowserProviderRequest(rawInput, provider);
  if (request && typeof request === "object" && !request.providerRegistry) {
    request.providerRegistry = map;
  }
  return request;
}

async function requestProviderCompletion(request, overrides) {
  const options = createRequestOptions(request, overrides);
  const providerKey = options.provider;

  if (isInjectedTransport(options.transport)) {
    return options.transport.complete(options);
  }

  const breaker = request && request.circuitBreaker;
  // F1 (weak-model e2e comparison) — transient errors (timeout/429/network/
  // 5xx) get bounded retries here, the single shared exit for every
  // non-streaming planner/finalize/repair call. The streaming variant is
  // deliberately NOT retried (emitted tokens cannot be unemitted); see
  // provider-retry.js for the full posture.
  const retryPolicy = normalizeProviderRetry(request && request.providerRetry);
  let attempt = 0;

  for (;;) {
    if (breaker && !breaker.canRequest(providerKey)) {
      throw createCircuitOpenError(providerKey, breaker.getState(providerKey));
    }

    try {
      const result = await resolveProviderEntry(options).complete(options, options.fetch);
      if (breaker) breaker.recordSuccess(providerKey);
      if (attempt > 0 && result && typeof result === "object") {
        result.providerRetries = attempt;
      }
      return result;
    } catch (error) {
      attachProviderError(error, providerKey);
      if (breaker && isProviderCircuitCountable(error)) breaker.recordFailure(providerKey);
      if (attempt >= retryPolicy.maxRetries || !isTransientProviderError(error, providerKey)) {
        throw error;
      }
      attempt += 1;
      await waitMs(providerRetryDelayMs(retryPolicy, attempt));
    }
  }
}

async function requestProviderCompletionStreaming(request, overrides, onToken, onStreamEvent, streamContext = {}) {
  const options = createRequestOptions(request, overrides);
  const providerKey = options.provider;
  const streamEmitter = createProviderStreamEmitter(onStreamEvent, {
    ...(streamContext && typeof streamContext === "object" ? streamContext : {}),
    model: options.model,
    provider: providerKey
  });
  const wrappedOnToken = streamEmitter.wrapToken(onToken);
  streamEmitter.emit("provider-stream-start");

  if (isInjectedTransport(options.transport)) {
    try {
      const result = await options.transport.stream(options, wrappedOnToken);
      streamEmitter.emit("provider-stream-finish", { final: true });
      return result;
    } catch (error) {
      streamEmitter.emit("provider-stream-error", { error: normalizeErrorMessage$1(error) });
      throw error;
    }
  }

  const breaker = request && request.circuitBreaker;

  if (breaker && !breaker.canRequest(providerKey)) {
    throw createCircuitOpenError(providerKey, breaker.getState(providerKey));
  }

  try {
    const entry = resolveProviderEntry(options);
    let result;
    if (typeof entry.stream === "function") {
      result = await entry.stream(options, options.fetch, wrappedOnToken);
    } else {
      // Host provider without a stream() impl: complete() then emit the full
      // text as one delta so onToken/onStreamEvent consumers still fire.
      result = await entry.complete(options, options.fetch);
      if (result && typeof result.text === "string" && result.text.length > 0) {
        wrappedOnToken(result.text);
      }
    }
    streamEmitter.emit("provider-stream-finish", { final: true });
    if (breaker) breaker.recordSuccess(providerKey);
    return result;
  } catch (error) {
    streamEmitter.emit("provider-stream-error", { error: normalizeErrorMessage$1(error) });
    attachProviderError(error, providerKey);
    if (breaker && isProviderCircuitCountable(error)) breaker.recordFailure(providerKey);
    throw error;
  }
}

function normalizeErrorMessage$1(error) {
  return error && typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : "provider stream failed";
}

function createRequestOptions(request, overrides) {
  const config = overrides && typeof overrides === "object" ? overrides : {};

  return {
    ...request,
    apiVariant: readOptionalString(config, "apiVariant") || request.apiVariant || "chat",
    authMode: readOptionalString(config, "authMode") || request.authMode || "client",
    cachedContentMode: readOptionalString(config, "cachedContentMode") || request.cachedContentMode || null,
    endpoint: readOptionalString(config, "endpoint") || request.endpoint || null,
    parts: Array.isArray(config.parts) ? config.parts : request.parts,
    prompt: readString$D(config, "prompt") || request.prompt,
    sessionContext: hasOwn(config, "sessionContext") ? config.sessionContext : request.sessionContext,
    streamEndpoint: readOptionalString(config, "streamEndpoint") || request.streamEndpoint || null,
    systemPrompt: readOptionalString(config, "systemPrompt") || request.systemPrompt || null,
    // AGRUN-212a amendment 2D — Per-call timeout override (autopilot
    // finalize bumps to 180s; planner cycles to 120s). Falls through
    // to `request.timeoutMs` (and ultimately DEFAULT_LLM_TIMEOUT_MS)
    // when no override is supplied. See provider-timeout.js.
    timeoutMs: readPositiveInteger$e(config.timeoutMs) || request.timeoutMs || null,
    tools: hasOwn(config, "tools") ? config.tools : null,
    toolChoice: hasOwn(config, "toolChoice") ? config.toolChoice : null,
    geminiThinkingConfig: hasOwn(config, "geminiThinkingConfig")
      ? readStructuredValue(config.geminiThinkingConfig)
      : request.geminiThinkingConfig || null,
    reasoningEffort: readOptionalString(config, "reasoningEffort") || request.reasoningEffort || null,
    reasoningSummary: hasOwn(config, "reasoningSummary")
      ? readNullableString(config.reasoningSummary)
      : request.reasoningSummary || null,
    transport: isInjectedTransport(request.transport) ? request.transport : null
  };
}

// Test/observability seam: callers (test helpers, replay tools, evals)
// may inject a transport object exposing `complete(options)` and
// `stream(options, onToken)`. When present, it bypasses the production
// openai/gemini dispatch and the circuit breaker entirely. Not exposed
// from src/index.js — only consumed by trusted in-repo callers.
function isInjectedTransport(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.complete === "function" &&
    typeof value.stream === "function"
  );
}

function normalizeInjectedTransportRequest(rawInput, providerLabel) {
  const prompt = readString$D(rawInput, "prompt");
  if (prompt.length === 0) {
    throw new Error("Transport-injected provider request requires a non-empty prompt.");
  }

  const transport = rawInput.transport;
  const label = providerLabel || (typeof transport.provider === "string" && transport.provider) || "transport";

  return {
    apiKey: "",
    apiVariant: "chat",
    authMode: "client",
    cachedContentMode: "disabled",
    conversation: Array.isArray(rawInput.conversation) ? rawInput.conversation : [],
    contextSnapshot: readStructuredValue(rawInput.contextSnapshot),
    endpoint: null,
    fetch: typeof rawInput.fetch === "function" ? rawInput.fetch : null,
    model: readString$D(rawInput, "model", "modelId") || (typeof transport.model === "string" && transport.model) || "injected-transport",
    parts: Array.isArray(rawInput.parts) ? rawInput.parts : [],
    prompt,
    provider: label,
    searchProvider: readOptionalString(rawInput, "searchProvider"),
    sessionContext: readStructuredValue(rawInput.sessionContext),
    streamEndpoint: null,
    systemPrompt: readOptionalString(rawInput, "systemPrompt", "system"),
    transport,
    geminiThinkingConfig: null,
    previousResponseId: null,
    reasoningEffort: null,
    reasoningSummary: null,
    responseFormat: null,
    webSearchApiKey: readOptionalString(rawInput, "webSearchApiKey"),
    webSearchAuthMode: readOptionalString(rawInput, "webSearchAuthMode"),
    webSearchEndpoint: readOptionalString(rawInput, "webSearchEndpoint"),
    webSearchModel: readOptionalString(rawInput, "webSearchModel")
  };
}

function readPositiveInteger$e(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function hasOwn(source, key) {
  return Boolean(source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, key));
}

function readString$D(source, ...keys) {
  if (!source || typeof source !== "object") {
    return "";
  }

  for (const key of keys) {
    if (typeof source[key] === "string") {
      return source[key].trim();
    }
  }

  return "";
}

function readOptionalString(source, ...keys) {
  const value = readString$D(source, ...keys);
  return value.length > 0 ? value : null;
}

function readNullableString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStructuredValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return JSON.parse(JSON.stringify(value));
}

function createCircuitOpenError(providerKey, state) {
  const error = new Error(
    `Circuit breaker open for "${providerKey}". ${state.failures} consecutive failures. Retry after ${state.remainingMs}ms.`
  );
  error.code = "CIRCUIT_OPEN";
  error.providerKey = providerKey;
  error.circuitState = state;
  return error;
}

function isProviderCircuitCountable(error) {
  if (!error) return false;
  // Already a circuit open error — don't double-count.
  if (error.code === "CIRCUIT_OPEN") return false;
  // Timeout / network / abort errors.
  if (error.name === "AbortError" || error.name === "TimeoutError" || error.code === "FETCH_TIMEOUT") return true;
  if (error.name === "TypeError" && /fetch|network/i.test(error.message)) return true;
  if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT" || error.code === "ENOTFOUND") return true;
  // AI SDK wraps provider errors — check for debug.response.status.
  const status = error.debug && error.debug.response && error.debug.response.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;
  return false;
}

export { BUILTIN_PROVIDERS, BUILTIN_PROVIDER_NAMES, isToolLoopProviderRequest, normalizeToolLoopProviderRequest, requestProviderCompletion, requestProviderCompletionStreaming };
