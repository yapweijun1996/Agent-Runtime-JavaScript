import { ERROR_CODES } from '../../runtime/errors.js';
import { validateImageParts, normalizeMultimodalParts } from '../../runtime/multimodal.js';
import { normalizeTimeContext } from '../../runtime/host-time-context.js';

function readString$1(source, keys) {
  for (const key of keys) {
    if (typeof source[key] === "string") {
      return source[key].trim();
    }
  }

  return "";
}

function readOptionalString$1(source, keys) {
  const value = readString$1(source, keys);
  return value.length > 0 ? value : null;
}

function readOptionalNumber(source, keys) {
  for (const key of keys) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) {
      return source[key];
    }
  }

  return null;
}

function readOptionalFunction(source, keys) {
  for (const key of keys) {
    if (typeof source[key] === "function") {
      return source[key];
    }
  }

  return null;
}

function readSessionContext$2(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }

  const sessionContext = source.sessionContext;

  if (!sessionContext || typeof sessionContext !== "object" || Array.isArray(sessionContext)) {
    return null;
  }

  const history = readOptionalString$1(sessionContext, ["history"]);
  const memory = readOptionalString$1(sessionContext, ["memory"]);
  const summary = readOptionalString$1(sessionContext, ["summary"]);
  const compactedContext = readOptionalString$1(sessionContext, ["compactedContext"]);
  const clarificationStatus = normalizeClarificationStatus(readOptionalString$1(sessionContext, ["clarificationStatus"]));
  const currentGoal = readOptionalString$1(sessionContext, ["currentGoal"]);
  const currentTopic = readOptionalString$1(sessionContext, ["currentTopic"]);
  const activeQuery = readOptionalString$1(sessionContext, ["activeQuery"]);
  const facts = readOptionalString$1(sessionContext, ["facts"]);
  const lastReadSource = readStructuredValue$1(sessionContext.lastReadSource);
  const lastResolution = readStructuredValue$1(sessionContext.lastResolution);
  const openAmbiguity = readOptionalString$1(sessionContext, ["openAmbiguity"]);
  const pendingClarification = readStructuredValue$1(sessionContext.pendingClarification);
  const preferences = readOptionalString$1(sessionContext, ["preferences"]);
  const decisions = readOptionalString$1(sessionContext, ["decisions"]);
  const recentTurns = readOptionalString$1(sessionContext, ["recentTurns"]);
  const selectedSource = readStructuredValue$1(sessionContext.selectedSource);
  const items = readSessionEvidenceItems(sessionContext.items);

  if (!history && !memory && !summary && !compactedContext && !clarificationStatus && !currentGoal && !currentTopic && !activeQuery && !facts && !lastReadSource && !lastResolution && !openAmbiguity && !pendingClarification && !preferences && !decisions && !recentTurns && !selectedSource && items.length === 0) {
    return null;
  }

  return {
    activeQuery,
    clarificationStatus,
    compactedContext,
    currentGoal,
    currentTopic,
    decisions,
    facts,
    history,
    items,
    lastReadSource,
    lastResolution,
    memory,
    openAmbiguity,
    pendingClarification,
    preferences,
    recentTurns,
    selectedSource,
    summary
  };
}

function readSessionEvidenceItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const kind = readString$1(item, ["kind"]);
      const text = readString$1(item, ["text"]);

      if (!kind || !text) {
        return null;
      }

      return {
        confidence: typeof item.confidence === "number" ? item.confidence : null,
        kind,
        slot: readOptionalString$1(item, ["slot"]),
        status: readOptionalString$1(item, ["status"]),
        text
      };
    })
    .filter(Boolean);
}

function readStructuredValue$1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return JSON.parse(JSON.stringify(value));
}

function normalizeClarificationStatus(value) {
  return value === "none" ? null : value;
}

// AGRUN-274a removed `isBrowserProviderRequest`. It was only used by the
// canHandle methods of gemini-browser-skill and openai-browser-skill,
// which are deleted in this ticket (the router never reached those
// canHandles anyway — skill-probe skipped them via isProviderAdapter).

function normalizeBrowserProviderRequest(rawInput, providerId) {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new Error("Provider requests must be plain objects.");
  }

  assertNoUnsupportedProviderParameters(rawInput);

  const provider = readString$1(rawInput, ["provider", "providerId"]);
  const apiVariant = readApiVariant(rawInput, providerId);
  const authMode = readAuthMode(rawInput);
  const apiKey = readString$1(rawInput, ["apiKey"]);
  const model = readString$1(rawInput, ["model", "modelId"]);
  const prompt = readString$1(rawInput, ["prompt"]);
  const cachedContentMode = readCachedContentMode(rawInput, authMode);
  const systemPrompt = readOptionalString$1(rawInput, ["systemPrompt", "system"]);
  const endpoint = readOptionalString$1(rawInput, ["endpoint"]);
  const streamEndpoint = readOptionalString$1(rawInput, ["streamEndpoint"]);
  const agrunSessionId = readOptionalString$1(rawInput, ["agrunSessionId"]);
  const browserSessionId = readOptionalString$1(rawInput, ["browserSessionId"]);
  const fetch = readOptionalFunction(rawInput, ["fetch", "fetchImpl"]);
  const searchProvider = readOptionalString$1(rawInput, ["searchProvider"]);
  const webSearchApiKey = readOptionalString$1(rawInput, ["webSearchApiKey"]);
  const webSearchAuthMode = readOptionalString$1(rawInput, ["webSearchAuthMode"]);
  const webSearchEndpoint = readOptionalString$1(rawInput, ["webSearchEndpoint"]);
  const webSearchModel = readOptionalString$1(rawInput, ["webSearchModel"]);
  const multimodal = readMultimodalSummary(rawInput);
  const contextSnapshot = readStructuredValue$1(rawInput.contextSnapshot);
  const sessionContext = readSessionContext$2(rawInput);
  const parts = readInputParts(rawInput);
  const conversation = readConversation(rawInput);
  const signal = readAbortSignal(rawInput.signal);
  const timeoutMs = readTimeoutMs(rawInput);
  const reasoningEffort = readReasoningEffort(rawInput);
  const reasoningSummary = readReasoningSummary(rawInput);
  const geminiThinkingConfig = readGeminiThinkingConfig$1(rawInput, providerId);
  const previousResponseId = readPreviousResponseId(rawInput, providerId, apiVariant);
  const responseFormat = readResponseFormat(rawInput, providerId, apiVariant);
  // AGRUN-518 — opt-in host time context (null when the host omits it).
  const timeContext = normalizeTimeContext(rawInput.timeContext);

  if (provider !== providerId) {
    throw new Error(`Expected provider "${providerId}".`);
  }

  if (authMode === "server" && providerId !== "gemini" && providerId !== "openai" && providerId !== "deepseek") {
    throw new Error(`Provider "${providerId}" does not support authMode "server".`);
  }

  if (providerId === "gemini" && authMode === "server" && cachedContentMode === "client") {
    throw new Error('Gemini authMode "server" does not support cachedContentMode "client". Use "disabled" or "server".');
  }

  if (apiKey.length === 0 && authMode !== "server") {
    throw new Error(`Provider "${providerId}" requires a non-empty apiKey.`);
  }

  if (model.length === 0) {
    throw new Error(`Provider "${providerId}" requires a non-empty model.`);
  }

  if (prompt.length === 0) {
    throw new Error(`Provider "${providerId}" requires a non-empty prompt.`);
  }

  const imageValidationError = validateImageParts(parts);
  if (imageValidationError) {
    throw new Error(imageValidationError);
  }

  return {
    apiKey,
    apiVariant,
    agrunSessionId,
    authMode,
    browserSessionId,
    cachedContentMode,
    conversation,
    contextSnapshot,
    endpoint,
    fetch,
    model,
    multimodal,
    parts,
    prompt,
    provider,
    searchProvider,
    sessionContext,
    signal,
    streamEndpoint,
    systemPrompt,
    timeContext,
    timeoutMs,
    previousResponseId,
    geminiThinkingConfig,
    reasoningEffort,
    reasoningSummary,
    responseFormat,
    webSearchApiKey,
    webSearchAuthMode,
    webSearchEndpoint,
    webSearchModel
  };
}

function readAbortSignal(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.aborted !== "boolean") return null;
  if (typeof value.addEventListener !== "function") return null;
  return value;
}

function readTimeoutMs(source) {
  if (!Object.prototype.hasOwnProperty.call(source, "timeoutMs")) return null;
  const value = readOptionalNumber(source, ["timeoutMs"]);
  if (value == null || value <= 0) return null;
  return Math.floor(value);
}

function readApiVariant(source, providerId) {
  const variant = readOptionalString$1(source, ["apiVariant"]) || "chat";
  if (variant === "chat") return variant;
  if (providerId === "openai" && variant === "responses") return variant;
  throw new Error(`Provider "${providerId}" apiVariant must be "chat"${providerId === "openai" ? ' or "responses"' : ""}.`);
}

function readReasoningEffort(source) {
  const effort = readOptionalString$1(source, ["reasoningEffort"]);
  if (effort == null) return null;
  if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)) return effort;
  throw new Error('Provider reasoningEffort must be "none", "minimal", "low", "medium", "high", or "xhigh".');
}

function readGeminiThinkingConfig$1(source, providerId) {
  const candidates = [
    source && source.geminiThinkingConfig,
    source && source.thinkingConfig,
    source && source.providerOptions && source.providerOptions.google && source.providerOptions.google.thinkingConfig
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  const topLevel = {};
  if (Object.prototype.hasOwnProperty.call(source, "thinkingLevel")) topLevel.thinkingLevel = source.thinkingLevel;
  if (Object.prototype.hasOwnProperty.call(source, "thinkingBudget")) topLevel.thinkingBudget = source.thinkingBudget;
  if (Object.prototype.hasOwnProperty.call(source, "includeThoughts")) topLevel.includeThoughts = source.includeThoughts;
  if (Object.keys(topLevel).length > 0) candidates.push(topLevel);
  if (candidates.length === 0) return null;
  if (providerId !== "gemini") {
    throw new Error('Provider thinkingConfig is only supported when providerId="gemini".');
  }

  const config = {};
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(candidate, "thinkingLevel")) {
      const level = typeof candidate.thinkingLevel === "string" ? candidate.thinkingLevel.trim() : "";
      if (!["minimal", "low", "medium", "high"].includes(level)) {
        throw new Error('Gemini thinkingLevel must be "minimal", "low", "medium", or "high".');
      }
      config.thinkingLevel = level;
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "thinkingBudget")) {
      const budget = candidate.thinkingBudget;
      if (typeof budget !== "number" || !Number.isFinite(budget) || Math.floor(budget) !== budget) {
        throw new Error("Gemini thinkingBudget must be an integer number.");
      }
      config.thinkingBudget = budget;
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "includeThoughts")) {
      if (typeof candidate.includeThoughts !== "boolean") {
        throw new Error("Gemini includeThoughts must be a boolean.");
      }
      config.includeThoughts = candidate.includeThoughts;
    }
  }

  return Object.keys(config).length > 0 ? config : null;
}

function readPreviousResponseId(source, providerId, apiVariant) {
  if (!Object.prototype.hasOwnProperty.call(source, "previousResponseId")) return null;
  const value = source.previousResponseId;
  if (value == null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error('Provider previousResponseId must be a non-empty string or null.');
  }
  if (providerId !== "openai" || apiVariant !== "responses") {
    throw new Error('Provider previousResponseId is only supported when providerId="openai" and apiVariant="responses".');
  }
  return value.trim();
}

function readResponseFormat(source, providerId, apiVariant) {
  if (!Object.prototype.hasOwnProperty.call(source, "responseFormat")) return null;
  const value = source.responseFormat;
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Provider responseFormat must be an object or null.');
  }
  if (providerId !== "openai" || apiVariant !== "responses") {
    throw new Error('Provider responseFormat is only supported when providerId="openai" and apiVariant="responses".');
  }
  const type = typeof value.type === "string" ? value.type : "";
  if (type !== "json_object" && type !== "json_schema" && type !== "text") {
    throw new Error('Provider responseFormat.type must be "json_object", "json_schema", or "text".');
  }
  return value;
}

function readReasoningSummary(source) {
  if (Object.prototype.hasOwnProperty.call(source, "reasoningSummary") && source.reasoningSummary == null) {
    return null;
  }
  const summary = readOptionalString$1(source, ["reasoningSummary"]);
  if (summary == null) return null;
  if (["auto", "concise", "detailed"].includes(summary)) return summary;
  throw new Error('Provider reasoningSummary must be "auto", "concise", "detailed", or null.');
}

function readAuthMode(source) {
  const authMode = readOptionalString$1(source, ["authMode"]) || "client";
  if (authMode === "client" || authMode === "server") {
    return authMode;
  }
  throw new Error('Provider authMode must be "client" or "server".');
}

function readCachedContentMode(source, authMode) {
  const fallback = authMode === "server" ? "disabled" : "client";
  const mode = readOptionalString$1(source, ["cachedContentMode"]) || fallback;
  if (mode === "disabled" || mode === "client" || mode === "server") {
    return mode;
  }
  throw new Error('Provider cachedContentMode must be "disabled", "client", or "server".');
}

function assertNoUnsupportedProviderParameters(rawInput) {
  const unsupportedParameters = [
    "temperature",
    "max_output_tokens",
    "maxOutputTokens",
    "maxTokens"
  ].filter((key) => Object.prototype.hasOwnProperty.call(rawInput, key));

  if (unsupportedParameters.length === 0) {
    return;
  }

  const error = new Error(
    `Unsupported provider parameter(s): ${unsupportedParameters.join(", ")}. agrun.js no longer accepts generation tuning or output token limit parameters.`
  );
  error.code = ERROR_CODES.UNSUPPORTED_PROVIDER_PARAMETER;
  error.debug = {
    unsupportedParameters
  };
  throw error;
}

function readMultimodalSummary(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || !source.multimodal || typeof source.multimodal !== "object") {
    return null;
  }

  const summary = source.multimodal;

  return {
    omittedImages: readOptionalNumber(summary, ["omittedImages"]) || 0,
    replayedImages: readOptionalNumber(summary, ["replayedImages"]) || 0
  };
}

function readInputParts(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return [];
  }

  return normalizeMultimodalParts(source.parts);
}

function readConversation(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || !Array.isArray(source.conversation)) {
    return [];
  }

  return source.conversation
    .map((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return null;
      }

      const role = readString$1(message, ["role"]);
      const parts = normalizeMultimodalParts(message.parts);

      if ((role !== "user" && role !== "assistant") || parts.length === 0) {
        return null;
      }

      return {
        parts,
        role
      };
    })
    .filter(Boolean);
}

export { normalizeBrowserProviderRequest };
