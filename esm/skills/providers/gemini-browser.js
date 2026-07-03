import { streamText, generateText } from '../../node_modules/ai/dist/index.js';
import { createGoogleGenerativeAI } from '../../node_modules/@ai-sdk/google/dist/index.js';
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
// `x-goog-api-key`, `Authorization`, and any future credential-bearing
// header the SDK might add) is dropped before reaching the host
// proxy. The host proxy is solely responsible for adding real auth.
const GEMINI_SERVER_AUTH_ALLOWED_HEADERS = Object.freeze([
  "content-type",
  "accept"
]);

async function requestGeminiContent(request, _fetchImpl) {
  const google = createGeminiProvider(request, _fetchImpl, "generate");
  const model = google(request.model);
  const messages = buildAISDKMessages$1(request);
  const system = buildSystemPrompt$1(request);
  const tools = convertGeminiTools(request.tools);
  const abortSignal = mergeAbortSignals([request.signal, createTimeoutSignal$1(request.timeoutMs || DEFAULT_LLM_TIMEOUT_MS)]);
  const providerOptions = buildGeminiProviderOptions(request);
  const requestBody = createProviderRequestTrace({
    apiVariant: request.apiVariant,
    authMode: request.authMode,
    callKind: "provider_generate",
    endpoint: request.endpoint,
    messages,
    model: request.model,
    prompt: request.prompt,
    provider: "gemini",
    providerOptions,
    sessionContext: request.sessionContext,
    system,
    toolChoice: request.toolChoice,
    tools
  });

  try {
    const providerStartedAt = Date.now();
    const result = await generateGeminiTextWithSemanticRetry({
      model,
      system: system || undefined,
      messages,
      tools: tools || undefined,
      toolChoice: request.toolChoice === "required" ? "required" : undefined,
      providerOptions,
      abortSignal,
      maxRetries: 1
    });

    const toolCalls = extractToolCalls$1(result.toolCalls);
    const text = result.text || "";
    const durationMs = Date.now() - providerStartedAt;

    if (!text && !toolCalls) {
      throw createProviderError$1("Gemini response did not include text output or function calls.", {
        request: { model: request.model, provider: "gemini" },
        response: { body: result.response, status: 200 }
      });
    }

    return {
      endpoint: request.endpoint || null,
      durationMs,
      finishReason: result.finishReason || null,
      raw: result.response,
      requestBody,
      status: 200,
      text,
      toolCalls,
      usage: result.usage || null
    };
  } catch (error) {
    if (error && error.debug) throw error;
    throw createProviderError$1(error.message || "Gemini request failed.", {
      request: { model: request.model, provider: "gemini" },
      response: { body: readErrorResponseBody$1(error), status: readErrorStatus$1(error) }
    });
  }
}

async function generateGeminiTextWithSemanticRetry(options) {
  const first = await generateGeminiTextOnce(options);
  if (!isEmptyGeminiResult(first)) return first;

  const retrySystem = [
    options.system,
    "The previous Gemini response was empty. Return a non-empty text response or a valid function/tool call. Empty responses are invalid."
  ].filter(Boolean).join("\n\n");

  const retry = await generateGeminiTextOnce({
    ...options,
    system: retrySystem || undefined
  });
  return retry;
}

async function generateGeminiTextOnce(options) {
  return generateText({
    model: options.model,
    system: options.system,
    messages: options.messages,
    tools: options.tools,
    toolChoice: options.toolChoice,
    providerOptions: options.providerOptions || undefined,
    abortSignal: options.abortSignal,
    maxRetries: 1
  });
}

function isEmptyGeminiResult(result) {
  const text = typeof result.text === "string" ? result.text.trim() : "";
  const toolCalls = extractToolCalls$1(result.toolCalls);
  return !text && !toolCalls;
}

async function requestGeminiContentStreaming(request, _fetchImpl, onToken, onReasoning) {
  const google = createGeminiProvider(request, _fetchImpl, "stream");
  const model = google(request.model);
  const messages = buildAISDKMessages$1(request);
  const system = buildSystemPrompt$1(request);
  const tools = convertGeminiTools(request.tools);
  const safeOnToken = typeof onToken === "function" ? onToken : null;
  const safeOnReasoning = typeof onReasoning === "function" ? onReasoning : null;
  const abortSignal = mergeAbortSignals([request.signal, createTimeoutSignal$1(request.timeoutMs || DEFAULT_LLM_TIMEOUT_MS)]);
  const providerOptions = buildGeminiProviderOptions(request);
  const requestBody = createProviderRequestTrace({
    apiVariant: request.apiVariant,
    authMode: request.authMode,
    callKind: "provider_stream",
    endpoint: request.endpoint,
    messages,
    model: request.model,
    prompt: request.prompt,
    provider: "gemini",
    providerOptions,
    sessionContext: request.sessionContext,
    system,
    toolChoice: request.toolChoice,
    tools
  });

  try {
    const providerStartedAt = Date.now();
    const result = await streamGeminiTextWithSemanticRetry({
      model,
      system: system || undefined,
      messages,
      tools: tools || undefined,
      toolChoice: request.toolChoice === "required" ? "required" : undefined,
      providerOptions,
      abortSignal,
      maxRetries: 1,
      onToken: safeOnToken,
      onReasoning: safeOnReasoning
    });
    const toolCalls = extractToolCalls$1(result.toolCalls);
    const fullText = result.text || "";
    const durationMs = Date.now() - providerStartedAt;

    if (!fullText && !toolCalls) {
      throw createProviderError$1("Gemini response did not include text output or function calls.", {
        request: { model: request.model, provider: "gemini" },
        response: { body: result.response, status: 200 }
      });
    }

    return {
      endpoint: request.endpoint || null,
      durationMs,
      finishReason: result.finishReason || null,
      raw: result.response,
      requestBody,
      status: 200,
      text: fullText,
      toolCalls,
      usage: result.usage || null
    };
  } catch (error) {
    if (error && error.debug) throw error;
    throw createProviderError$1(error.message || "Gemini streaming request failed.", {
      request: { model: request.model, provider: "gemini" },
      response: { body: readErrorResponseBody$1(error), status: readErrorStatus$1(error) }
    });
  }
}

async function streamGeminiTextWithSemanticRetry(options) {
  const first = await streamGeminiTextOnce(options);
  if (!isEmptyGeminiResult(first)) return first;

  const retrySystem = [
    options.system,
    "The previous Gemini streaming response was empty. Return a non-empty text response or a valid function/tool call. Empty responses are invalid."
  ].filter(Boolean).join("\n\n");

  return streamGeminiTextOnce({
    ...options,
    system: retrySystem || undefined
  });
}

async function streamGeminiTextOnce(options) {
  const result = streamText({
    model: options.model,
    system: options.system,
    messages: options.messages,
    tools: options.tools,
    toolChoice: options.toolChoice,
    providerOptions: options.providerOptions || undefined,
    abortSignal: options.abortSignal,
    maxRetries: options.maxRetries
  });

  await pumpProviderFullStream(result, { onToken: options.onToken, onReasoning: options.onReasoning });

  return {
    finishReason: (await result.finishReason) || null,
    response: await result.response,
    text: (await result.text) || "",
    // RAW sdk tool calls — the caller (and isEmptyGeminiResult) run
    // extractToolCalls exactly once. Mapping here too double-extracted:
    // the second pass read toolName/input off already-mapped {name,
    // arguments} items and blanked every tool call name, so gemini
    // streaming turns looped planner-invalid to maxSteps (AGRUN-585).
    toolCalls: (await result.toolCalls) || null,
    usage: (await result.usage) || null
  };
}

function buildGeminiProviderOptions(request) {
  const thinkingConfig = request && request.geminiThinkingConfig && typeof request.geminiThinkingConfig === "object" && !Array.isArray(request.geminiThinkingConfig)
    ? request.geminiThinkingConfig
    : null;
  if (!thinkingConfig) return null;
  const normalizedThinkingConfig = {};
  if (typeof thinkingConfig.thinkingLevel === "string" && thinkingConfig.thinkingLevel.trim()) {
    normalizedThinkingConfig.thinkingLevel = thinkingConfig.thinkingLevel.trim();
  }
  if (typeof thinkingConfig.thinkingBudget === "number" && Number.isFinite(thinkingConfig.thinkingBudget)) {
    normalizedThinkingConfig.thinkingBudget = thinkingConfig.thinkingBudget;
  }
  if (typeof thinkingConfig.includeThoughts === "boolean") {
    normalizedThinkingConfig.includeThoughts = thinkingConfig.includeThoughts;
  }
  return Object.keys(normalizedThinkingConfig).length > 0
    ? { google: { thinkingConfig: normalizedThinkingConfig } }
    : null;
}

function createGeminiProvider(request, fetchImpl, mode) {
  if (request.authMode === "server") {
    validateServerAuthRequest(request, mode);
    return createGoogleGenerativeAI({
      apiKey: "agrun-server-auth",
      fetch: createServerAuthFetch$1(request, fetchImpl)
    });
  }

  return createGoogleGenerativeAI({
    apiKey: request.apiKey,
    fetch: typeof fetchImpl === "function" ? fetchImpl : undefined
  });
}

function validateServerAuthRequest(request, mode) {
  if (!request.endpoint) {
    throw new Error('Gemini authMode "server" requires a non-empty endpoint.');
  }
  if (mode === "stream" && !request.streamEndpoint) {
    throw new Error('Gemini streaming with authMode "server" requires a non-empty streamEndpoint.');
  }
}

function createServerAuthFetch$1(request, fetchImpl) {
  const baseFetch = resolveFetch$1(fetchImpl);
  return (input, init) => {
    const sourceUrl = readFetchUrl$1(input);
    const targetUrl = resolveServerAuthUrl$1(request, sourceUrl);
    const nextInit = {
      ...init,
      headers: stripProviderAuthHeaders$1(init && init.headers)
    };
    return baseFetch(targetUrl, nextInit);
  };
}

function resolveFetch$1(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new Error("Gemini provider requires a fetch implementation.");
}

function readFetchUrl$1(input) {
  if (typeof input === "string") return input;
  if (input && typeof input.href === "string") return input.href;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

function resolveServerAuthUrl$1(request, sourceUrl) {
  if (sourceUrl.includes(":streamGenerateContent")) {
    return request.streamEndpoint;
  }
  if (sourceUrl.includes(":generateContent")) {
    return request.endpoint;
  }
  return sourceUrl;
}

// AGRUN-207 — Allow-list filter (replaces the prior black-list strip).
// Only `content-type` and `accept` are forwarded; every other header
// the SDK might attach is dropped. See GEMINI_SERVER_AUTH_ALLOWED_HEADERS.
function stripProviderAuthHeaders$1(headers) {
  return filterHeadersByAllowList(headers, GEMINI_SERVER_AUTH_ALLOWED_HEADERS);
}

function buildAISDKMessages$1(request) {
  const messages = [];
  for (const message of Array.isArray(request.conversation) ? request.conversation : []) {
    messages.push({
      role: message.role === "model" ? "assistant" : message.role,
      content: mapAISDKParts$1(message.parts)
    });
  }
  messages.push({
    role: "user",
    content: mapAISDKParts$1(buildCurrentTurnParts(request.prompt, request.parts))
  });
  return messages;
}

function mapAISDKParts$1(parts) {
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

function buildSystemPrompt$1(request) {
  return [request.systemPrompt, buildSessionContextSystemPrompt(request.sessionContext)]
    .filter(Boolean).join("\n\n") || null;
}

function convertGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const converted = {};
  for (const toolGroup of tools) {
    if (toolGroup && Array.isArray(toolGroup.functionDeclarations)) {
      for (const decl of toolGroup.functionDeclarations) {
        if (decl && typeof decl.name === "string") {
          converted[decl.name] = {
            description: decl.description || "",
            inputSchema: jsonSchema(decl.parameters || { type: "object", properties: {} })
          };
        }
      }
    }
  }
  return Object.keys(converted).length > 0 ? converted : null;
}

function extractToolCalls$1(sdkToolCalls) {
  if (!Array.isArray(sdkToolCalls) || sdkToolCalls.length === 0) return null;
  return sdkToolCalls.map((call) => ({
    name: call.toolName || "",
    arguments: call.input ? JSON.stringify(call.input) : "{}"
  }));
}

function createTimeoutSignal$1(timeoutMs) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function createProviderError$1(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

function readErrorStatus$1(error) {
  if (!error || typeof error !== "object") return null;
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  if (Number.isInteger(error.status)) return error.status;
  if (error.response && Number.isInteger(error.response.status)) return error.response.status;
  return null;
}

function readErrorResponseBody$1(error) {
  if (!error || typeof error !== "object") return null;
  if (error.responseBody != null) return error.responseBody;
  if (error.response && error.response.body != null) return error.response.body;
  return null;
}

export { requestGeminiContent, requestGeminiContentStreaming };
