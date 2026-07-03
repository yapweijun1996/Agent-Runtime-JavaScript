import { streamText, generateText } from '../../node_modules/ai/dist/index.js';
import { createOpenAI } from '../../node_modules/@ai-sdk/openai/dist/index.js';
import { buildSessionContextSystemPrompt } from '../../session/prompt.js';
import { buildCurrentTurnParts, isImagePart } from '../../runtime/multimodal.js';
import { mergeAbortSignals } from '../../runtime/abort-signal.js';
import { DEFAULT_LLM_TIMEOUT_MS } from './fetch-resilience.js';
import { filterHeadersByAllowList } from './header-allow-list.js';
import { createProviderRequestTrace } from '../../runtime/llm-trace.js';
import { pumpProviderFullStream } from './provider-stream-pump.js';
import { jsonSchema } from '../../node_modules/@ai-sdk/provider-utils/dist/index.js';

// AGRUN-207 — Allow-list of headers that may travel through the
// server-auth fetch wrapper. Anything outside this list (including
// `Authorization`, `OpenAI-Organization`, `OpenAI-Project`, and any
// future credential-bearing header the SDK might add) is dropped
// before reaching the host proxy. The host proxy is solely
// responsible for adding real auth.
const OPENAI_SERVER_AUTH_ALLOWED_HEADERS = Object.freeze([
  "content-type",
  "accept"
]);
const OPENAI_EMPTY_RESPONSE_REPAIR_REASONING_EFFORT = "none";

async function requestOpenAIChatCompletion(request, fetchImpl) {
  const openai = createOpenAIProvider(request, fetchImpl);
  const model = selectOpenAIModel(openai, request);
  const messages = buildAISDKMessages(request);
  const system = buildSystemPrompt(request);
  const tools = convertOpenAITools(request.tools);
  const timeoutMs = request.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const abortSignal = mergeAbortSignals([request.signal, createTimeoutSignal(timeoutMs)]);
  const providerOptions = buildOpenAIProviderOptions(request);
  const requestBody = createProviderRequestTrace({
    apiVariant: request.apiVariant,
    authMode: request.authMode,
    callKind: "provider_generate",
    endpoint: request.endpoint,
    messages,
    model: request.model,
    prompt: request.prompt,
    provider: "openai",
    providerOptions,
    sessionContext: request.sessionContext,
    system,
    toolChoice: request.toolChoice,
    tools
  });

  try {
    const providerStartedAt = Date.now();
    const result = await generateTextWithEmptyResponseRepair({
      abortSignal,
      messages,
      model,
      providerOptions,
      request,
      system,
      timeoutMs,
      toolChoice: normalizeOpenAIToolChoice(request.toolChoice),
      tools
    });

    const toolCalls = extractToolCalls(result.toolCalls);
    const reasoningSummary = extractReasoningSummary(result);
    const text = result.text || "";
    const durationMs = Date.now() - providerStartedAt;

    if (!text && !toolCalls) {
      throw createProviderError("OpenAI response did not include assistant text or tool calls.", {
        request: { model: request.model, provider: "openai" },
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
    throw createProviderError(error.message || "OpenAI request failed.", {
      request: { model: request.model, provider: "openai" },
      response: { body: readErrorResponseBody(error), status: readErrorStatus(error) }
    });
  }
}

async function generateTextWithEmptyResponseRepair({
  abortSignal,
  messages,
  model,
  providerOptions,
  request,
  system,
  timeoutMs,
  toolChoice,
  tools
}) {
  const options = {
    model,
    system: system || undefined,
    messages,
    tools: tools || undefined,
    toolChoice,
    providerOptions: providerOptions || undefined,
    abortSignal,
    timeout: timeoutMs,
    maxRetries: 1
  };
  const result = await generateText(options);
  if (hasAssistantContent(result)) return result;

  const repairMessages = [
    ...messages,
    {
      role: "user",
      content: "The previous provider response was empty. Return a non-empty response that follows the existing system and developer instructions exactly."
    }
  ];
  return await generateText({
    ...options,
    messages: repairMessages,
    maxRetries: 0,
    providerOptions: buildEmptyResponseRepairProviderOptions(providerOptions, request)
  });
}

function hasAssistantContent(result) {
  if (!result || typeof result !== "object") return false;
  if (typeof result.text === "string" && result.text.length > 0) return true;
  return Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
}

function addOpenAIRequestMetadata(providerOptions, metadata) {
  return {
    ...(providerOptions || {}),
    openai: {
      ...((providerOptions && providerOptions.openai) || {}),
      metadata: {
        ...((providerOptions && providerOptions.openai && providerOptions.openai.metadata) || {}),
        ...metadata
      }
    }
  };
}

function buildEmptyResponseRepairProviderOptions(providerOptions, request) {
  const next = addOpenAIRequestMetadata(providerOptions, { agrun_empty_response_repair: "true" });
  if (!request || request.apiVariant !== "responses") return next;
  const openaiOptions = {
    ...((next && next.openai) || {}),
    reasoningEffort: OPENAI_EMPTY_RESPONSE_REPAIR_REASONING_EFFORT
  };
  delete openaiOptions.reasoningSummary;
  return {
    ...next,
    openai: openaiOptions
  };
}

async function requestOpenAIChatCompletionStreaming(request, fetchImpl, onToken, onReasoning) {
  const openai = createOpenAIProvider(request, fetchImpl);
  const model = selectOpenAIModel(openai, request);
  const messages = buildAISDKMessages(request);
  const system = buildSystemPrompt(request);
  const tools = convertOpenAITools(request.tools);
  const safeOnToken = typeof onToken === "function" ? onToken : null;
  const safeOnReasoning = typeof onReasoning === "function" ? onReasoning : null;
  const timeoutMs = request.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
  const abortSignal = mergeAbortSignals([request.signal, createTimeoutSignal(timeoutMs)]);
  const providerOptions = buildOpenAIProviderOptions(request);
  const requestBody = createProviderRequestTrace({
    apiVariant: request.apiVariant,
    authMode: request.authMode,
    callKind: "provider_stream",
    endpoint: request.endpoint,
    messages,
    model: request.model,
    prompt: request.prompt,
    provider: "openai",
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
      toolChoice: normalizeOpenAIToolChoice(request.toolChoice),
      providerOptions: providerOptions || undefined,
      abortSignal,
      timeout: timeoutMs,
      maxRetries: 1
    });

    await pumpProviderFullStream(result, { onToken: safeOnToken, onReasoning: safeOnReasoning });

    const finalResult = await result.response;
    const fullText = await result.text;
    const reasoningSummary = await result.reasoningText;
    const toolCalls = extractToolCalls(await result.toolCalls);
    const durationMs = Date.now() - providerStartedAt;

    return {
      endpoint: request.endpoint || null,
      durationMs,
      finishReason: (await result.finishReason) || null,
      raw: finalResult,
      reasoningSummary: reasoningSummary || null,
      requestBody,
      responseId: extractResponseId(finalResult),
      status: 200,
      text: fullText || "",
      toolCalls,
      usage: (await result.usage) || null
    };
  } catch (error) {
    if (error && error.debug) throw error;
    throw createProviderError(error.message || "OpenAI streaming request failed.", {
      request: { model: request.model, provider: "openai" },
      response: { body: readErrorResponseBody(error), status: readErrorStatus(error) }
    });
  }
}

function extractResponseId(finalResult) {
  if (!finalResult || typeof finalResult !== "object") return null;
  return typeof finalResult.id === "string" && finalResult.id.length > 0 ? finalResult.id : null;
}

function selectOpenAIModel(openai, request) {
  if (request.apiVariant === "responses") {
    return openai.responses(request.model);
  }
  return openai.chat(request.model);
}

function normalizeOpenAIToolChoice(toolChoice) {
  if (toolChoice === "required" || toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }
  return undefined;
}

function buildOpenAIProviderOptions(request) {
  if (request.apiVariant !== "responses") return null;
  const openaiOptions = {};
  if (request.reasoningEffort) openaiOptions.reasoningEffort = request.reasoningEffort;
  if (request.reasoningSummary) openaiOptions.reasoningSummary = request.reasoningSummary;
  if (request.previousResponseId) openaiOptions.previousResponseId = request.previousResponseId;
  if (request.responseFormat) openaiOptions.responseFormat = request.responseFormat;
  return Object.keys(openaiOptions).length > 0 ? { openai: openaiOptions } : null;
}

function extractReasoningSummary(result) {
  if (result && typeof result.reasoningText === "string" && result.reasoningText.trim().length > 0) {
    return result.reasoningText;
  }
  if (!result || !Array.isArray(result.reasoning)) {
    return null;
  }
  const text = result.reasoning
    .map((part) => part && typeof part.text === "string" ? part.text : "")
    .filter((partText) => partText.trim().length > 0)
    .join("\n\n");
  return text || null;
}

function buildAISDKMessages(request) {
  const messages = [];
  for (const message of Array.isArray(request.conversation) ? request.conversation : []) {
    messages.push({
      role: message.role,
      content: mapAISDKParts(message.role, message.parts)
    });
  }
  messages.push({
    role: "user",
    content: mapAISDKParts("user", buildCurrentTurnParts(request.prompt, request.parts))
  });
  return messages;
}

function mapAISDKParts(role, parts) {
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

function buildSystemPrompt(request) {
  return [request.systemPrompt, buildSessionContextSystemPrompt(request.sessionContext)]
    .filter(Boolean).join("\n\n") || null;
}

function convertOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const converted = {};
  for (const tool of tools) {
    if (!tool || tool.type !== "function") continue;
    // buildOpenAITools (src/runtime/planner-tools.js) emits flat {type, name,
    // description, parameters}. Older Chat Completions wire format used a
    // nested {function: {...}} envelope, so accept both shapes.
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

function extractToolCalls(sdkToolCalls) {
  if (!Array.isArray(sdkToolCalls) || sdkToolCalls.length === 0) return null;
  return sdkToolCalls.map((call) => ({
    name: call.toolName || "",
    arguments: call.input ? JSON.stringify(call.input) : "{}"
  }));
}

// AGRUN-205 — Wire host fetch + endpoint into the AI SDK provider.
//
// The pre-fix code accepted `request.fetch` / `request.endpoint` and
// echoed them on the response, but `createOpenAI({ apiKey })` ignored
// them. As a result the host's proxy fetch (used for browser-safe
// auth, signing, telemetry) never ran.
//
// Auth modes mirror the Gemini provider for harness symmetry:
//   - `client` (default): apiKey is sent by the SDK to OpenAI (or to
//     `endpoint` as `baseURL` when the host points at an OpenAI-
//     compatible proxy / Azure / LiteLLM). `fetch` is plumbed through.
//   - `server`: NO apiKey. A fetch wrapper rewrites the SDK's URL to
//     `request.endpoint` and strips `Authorization` so the SDK cannot
//     leak credentials at the network layer. The host's proxy is
//     responsible for adding real auth.
function createOpenAIProvider(request, fetchImpl) {
  if (request.authMode === "server") {
    if (!request.endpoint) {
      throw new Error('OpenAI authMode "server" requires a non-empty endpoint.');
    }
    return createOpenAI({
      apiKey: "agrun-server-auth",
      fetch: createServerAuthFetch(request, fetchImpl)
    });
  }

  const config = { apiKey: request.apiKey };
  if (typeof request.endpoint === "string" && request.endpoint.trim().length > 0) {
    config.baseURL = request.endpoint.trim();
  }
  if (typeof fetchImpl === "function") {
    config.fetch = fetchImpl;
  }
  return createOpenAI(config);
}

function createServerAuthFetch(request, fetchImpl) {
  const baseFetch = resolveFetch(fetchImpl);
  return (input, init) => {
    readFetchUrl(input);
    const targetUrl = resolveServerAuthUrl(request);
    const nextInit = {
      ...init,
      headers: stripProviderAuthHeaders(init && init.headers)
    };
    return baseFetch(targetUrl, nextInit);
  };
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new Error("OpenAI provider requires a fetch implementation.");
}

function readFetchUrl(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.href === "string") return input.href;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

function resolveServerAuthUrl(request, _sourceUrl) {
  // OpenAI exposes a single chat-completions path at the moment; the
  // host proxy is expected to terminate that contract. Future
  // multi-endpoint variants (e.g. embeddings) would dispatch on
  // `_sourceUrl` the way the Gemini provider does.
  return request.endpoint;
}

// AGRUN-207 — Allow-list filter (replaces the prior black-list strip).
// Only `content-type` and `accept` are forwarded; every other header
// the SDK might attach is dropped. See OPENAI_SERVER_AUTH_ALLOWED_HEADERS.
function stripProviderAuthHeaders(headers) {
  return filterHeadersByAllowList(headers, OPENAI_SERVER_AUTH_ALLOWED_HEADERS);
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function createProviderError(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

function readErrorStatus(error) {
  if (!error || typeof error !== "object") return null;
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  if (Number.isInteger(error.status)) return error.status;
  if (error.response && Number.isInteger(error.response.status)) return error.response.status;
  return null;
}

function readErrorResponseBody(error) {
  if (!error || typeof error !== "object") return null;
  if (error.responseBody != null) return error.responseBody;
  if (error.response && error.response.body != null) return error.response.body;
  return null;
}

export { requestOpenAIChatCompletion, requestOpenAIChatCompletionStreaming };
