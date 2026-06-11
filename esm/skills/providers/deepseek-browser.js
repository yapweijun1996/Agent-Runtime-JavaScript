import { streamText, generateText } from '../../node_modules/ai/dist/index.js';
import { createDeepSeek } from '../../node_modules/@ai-sdk/deepseek/dist/index.js';
import { buildSessionContextSystemPrompt } from '../../session/prompt.js';
import { buildCurrentTurnParts, isImagePart } from '../../runtime/multimodal.js';
import { mergeAbortSignals } from '../../runtime/abort-signal.js';
import { DEFAULT_LLM_TIMEOUT_MS } from './fetch-resilience.js';
import { filterHeadersByAllowList } from './header-allow-list.js';
import { createProviderRequestTrace } from '../../runtime/llm-trace.js';
import { jsonSchema } from '../../node_modules/@ai-sdk/provider-utils/dist/index.js';

// AGRUN-207 — Only content-type and accept are forwarded to the host proxy;
// all credential-bearing headers (Authorization, etc.) are stripped so the
// proxy can add real auth without leaking the SDK's injected key.
const DEEPSEEK_SERVER_AUTH_ALLOWED_HEADERS = Object.freeze([
  "content-type",
  "accept"
]);

async function requestDeepSeekChatCompletion(request, fetchImpl) {
  const deepseek = createDeepSeekProvider(request, fetchImpl);
  const model = deepseek.chat(request.model);
  const messages = buildAISDKMessages$2(request);
  const system = buildSystemPrompt$2(request);
  const tools = convertDeepSeekTools(request.tools);
  const providerOptions = buildDeepSeekProviderOptions(request);
  const timeoutMs = request.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const abortSignal = mergeAbortSignals([request.signal, createTimeoutSignal$2(timeoutMs)]);
  const requestBody = createProviderRequestTrace({
    apiVariant: "chat",
    authMode: request.authMode,
    callKind: "provider_generate",
    endpoint: request.endpoint,
    messages,
    model: request.model,
    prompt: request.prompt,
    provider: "deepseek",
    providerOptions,
    sessionContext: request.sessionContext,
    system,
    toolChoice: request.toolChoice,
    tools
  });

  try {
    const providerStartedAt = Date.now();
    const result = await generateText({
      model,
      system: system || undefined,
      messages,
      tools: tools || undefined,
      toolChoice: normalizeToolChoice(request.toolChoice),
      providerOptions: providerOptions || undefined,
      abortSignal,
      timeout: timeoutMs,
      maxRetries: 1
    });

    const toolCalls = extractToolCalls$2(result.toolCalls);
    const reasoningSummary = extractReasoningSummary$1(result);
    const text = result.text || "";
    const durationMs = Date.now() - providerStartedAt;

    if (!text && !toolCalls) {
      throw createProviderError$2("DeepSeek response did not include assistant text or tool calls.", {
        request: { model: request.model, provider: "deepseek" },
        response: { body: result.response, status: 200 }
      });
    }

    return {
      endpoint: request.endpoint || null,
      durationMs,
      finishReason: result.finishReason || null,
      raw: result.response,
      reasoningSummary,
      requestBody,
      status: 200,
      text,
      toolCalls,
      usage: result.usage || null
    };
  } catch (error) {
    if (error && error.debug) throw error;
    throw createProviderError$2(error.message || "DeepSeek request failed.", {
      request: { model: request.model, provider: "deepseek" },
      response: { body: readErrorResponseBody$2(error), status: readErrorStatus$2(error) }
    });
  }
}

async function requestDeepSeekChatCompletionStreaming(request, fetchImpl, onToken) {
  const deepseek = createDeepSeekProvider(request, fetchImpl);
  const model = deepseek.chat(request.model);
  const messages = buildAISDKMessages$2(request);
  const system = buildSystemPrompt$2(request);
  const tools = convertDeepSeekTools(request.tools);
  const providerOptions = buildDeepSeekProviderOptions(request);
  const safeOnToken = typeof onToken === "function" ? onToken : null;
  const timeoutMs = request.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const abortSignal = mergeAbortSignals([request.signal, createTimeoutSignal$2(timeoutMs)]);
  const requestBody = createProviderRequestTrace({
    apiVariant: "chat",
    authMode: request.authMode,
    callKind: "provider_stream",
    endpoint: request.endpoint,
    messages,
    model: request.model,
    prompt: request.prompt,
    provider: "deepseek",
    providerOptions,
    sessionContext: request.sessionContext,
    system,
    toolChoice: request.toolChoice,
    tools
  });

  try {
    const providerStartedAt = Date.now();
    const result = streamText({
      model,
      system: system || undefined,
      messages,
      tools: tools || undefined,
      toolChoice: normalizeToolChoice(request.toolChoice),
      providerOptions: providerOptions || undefined,
      abortSignal,
      timeout: timeoutMs,
      maxRetries: 1
    });

    if (safeOnToken) {
      for await (const delta of result.textStream) {
        try { safeOnToken(delta); } catch (_ignored) { /* consumer error */ }
      }
    }

    const finalResult = await result.response;
    const fullText = await result.text;
    const reasoningSummary = (await result.reasoningText) || null;
    const toolCalls = extractToolCalls$2(await result.toolCalls);
    const durationMs = Date.now() - providerStartedAt;

    return {
      endpoint: request.endpoint || null,
      durationMs,
      finishReason: (await result.finishReason) || null,
      raw: finalResult,
      reasoningSummary,
      requestBody,
      status: 200,
      text: fullText || "",
      toolCalls,
      usage: (await result.usage) || null
    };
  } catch (error) {
    if (error && error.debug) throw error;
    throw createProviderError$2(error.message || "DeepSeek streaming request failed.", {
      request: { model: request.model, provider: "deepseek" },
      response: { body: readErrorResponseBody$2(error), status: readErrorStatus$2(error) }
    });
  }
}

// Auth modes mirror the OpenAI/Gemini providers:
//   - `client` (default): apiKey forwarded to DeepSeek directly (or to
//     `endpoint` as baseURL when pointing at a custom proxy).
//   - `server`: NO apiKey. A fetch wrapper rewrites the SDK's URL to
//     `request.endpoint` and strips Authorization so the proxy injects real auth.
function createDeepSeekProvider(request, fetchImpl) {
  if (request.authMode === "server") {
    if (!request.endpoint) {
      throw new Error('DeepSeek authMode "server" requires a non-empty endpoint.');
    }
    return createDeepSeek({
      apiKey: "agrun-server-auth",
      fetch: createServerAuthFetch$2(request, fetchImpl)
    });
  }

  const config = { apiKey: request.apiKey };
  if (typeof request.endpoint === "string" && request.endpoint.trim().length > 0) {
    config.baseURL = request.endpoint.trim();
  }
  if (typeof fetchImpl === "function") {
    config.fetch = fetchImpl;
  }
  return createDeepSeek(config);
}

function createServerAuthFetch$2(request, fetchImpl) {
  const baseFetch = resolveFetch$2(fetchImpl);
  return (input, init) => {
    const nextInit = {
      ...init,
      headers: stripProviderAuthHeaders$2(init && init.headers)
    };
    return baseFetch(request.endpoint, nextInit);
  };
}

function resolveFetch$2(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new Error("DeepSeek provider requires a fetch implementation.");
}

function stripProviderAuthHeaders$2(headers) {
  return filterHeadersByAllowList(headers, DEEPSEEK_SERVER_AUTH_ALLOWED_HEADERS);
}

// F5 — thread reasoning effort into the native DeepSeek path. @ai-sdk/deepseek
// accepts reasoning_effort under providerOptions.deepseek for V4 reasoning
// models (enum: low/medium/high/xhigh/max; sent only when thinking is not
// disabled). agrun's reasoningEffort also allows "none"/"minimal", which the
// SDK's zod enum rejects — so those map to "no reasoning_effort sent" (provider
// default) rather than being forwarded and erroring out.
const DEEPSEEK_REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

function buildDeepSeekProviderOptions(request) {
  const effort = request && typeof request.reasoningEffort === "string" ? request.reasoningEffort : "";
  if (!DEEPSEEK_REASONING_EFFORTS.includes(effort)) return null;
  return { deepseek: { reasoningEffort: effort } };
}

function normalizeToolChoice(toolChoice) {
  if (toolChoice === "required" || toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }
  return undefined;
}

function extractReasoningSummary$1(result) {
  // @ai-sdk/deepseek maps reasoning_content → reasoningText automatically
  if (result && typeof result.reasoningText === "string" && result.reasoningText.trim().length > 0) {
    return result.reasoningText;
  }
  return null;
}

function buildAISDKMessages$2(request) {
  const messages = [];
  for (const message of Array.isArray(request.conversation) ? request.conversation : []) {
    messages.push({
      role: message.role,
      content: mapAISDKParts$2(message.role, message.parts)
    });
  }
  messages.push({
    role: "user",
    content: mapAISDKParts$2("user", buildCurrentTurnParts(request.prompt, request.parts))
  });
  return messages;
}

function mapAISDKParts$2(role, parts) {
  const mapped = (Array.isArray(parts) ? parts : [])
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      if (part.type === "text" && typeof part.text === "string") {
        return { type: "text", text: part.text };
      }
      if (isImagePart(part)) {
        return { type: "image", image: part.url, mimeType: part.mimeType };
      }
      return null;
    })
    .filter(Boolean);
  if (mapped.length === 1 && mapped[0].type === "text") return mapped[0].text;
  return mapped;
}

function buildSystemPrompt$2(request) {
  return [request.systemPrompt, buildSessionContextSystemPrompt(request.sessionContext)]
    .filter(Boolean).join("\n\n") || null;
}

function convertDeepSeekTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const converted = {};
  for (const tool of tools) {
    if (!tool || tool.type !== "function") continue;
    const flatName = typeof tool.name === "string" ? tool.name : null;
    const nested = tool.function && typeof tool.function === "object" ? tool.function : null;
    const name = flatName || (nested && typeof nested.name === "string" ? nested.name : null);
    if (!name) continue;
    const description = tool.description || (nested && nested.description) || "";
    const parameters = tool.parameters || (nested && nested.parameters) || { type: "object", properties: {} };
    converted[name] = {
      description,
      inputSchema: jsonSchema(parameters)
    };
  }
  return Object.keys(converted).length > 0 ? converted : null;
}

function extractToolCalls$2(sdkToolCalls) {
  if (!Array.isArray(sdkToolCalls) || sdkToolCalls.length === 0) return null;
  return sdkToolCalls.map((call) => ({
    name: call.toolName || "",
    arguments: call.input ? JSON.stringify(call.input) : "{}"
  }));
}

function createTimeoutSignal$2(timeoutMs) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function createProviderError$2(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

function readErrorStatus$2(error) {
  if (!error || typeof error !== "object") return null;
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  if (Number.isInteger(error.status)) return error.status;
  if (error.response && Number.isInteger(error.response.status)) return error.response.status;
  return null;
}

function readErrorResponseBody$2(error) {
  if (!error || typeof error !== "object") return null;
  if (error.responseBody != null) return error.responseBody;
  if (error.response && error.response.body != null) return error.response.body;
  return null;
}

export { buildDeepSeekProviderOptions, requestDeepSeekChatCompletion, requestDeepSeekChatCompletionStreaming };
