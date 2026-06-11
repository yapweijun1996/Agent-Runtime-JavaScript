import { buildSessionContextSystemPrompt } from './prompt.js';
import { buildCurrentTurnParts, isImagePart } from '../runtime/multimodal.js';

const DEFAULT_BYTES_PER_TOKEN = 4;
const ACTION_LOOP_ENVELOPE_OVERHEAD = 192;
const OPENAI_MESSAGE_OVERHEAD = 12;
const OPENAI_REQUEST_OVERHEAD = 6;
const GEMINI_PART_OVERHEAD = 10;
const GEMINI_REQUEST_OVERHEAD = 6;

let cachedEncoder = null;

function evaluateProviderPromptBudget(request, sessionPolicy) {
  const inputBudgetTokens = Math.max(1, sessionPolicy.contextWindowTokens);
  const compactAtTokens = Math.min(sessionPolicy.compactAtTokens, inputBudgetTokens);
  const estimatedPromptTokens = estimateProviderPromptTokens(request, sessionPolicy);

  return {
    compactAtTokens,
    contextWindowTokens: sessionPolicy.contextWindowTokens,
    estimatedPromptTokens,
    inputBudgetTokens,
    needsCompaction: estimatedPromptTokens > compactAtTokens,
    withinBudget: estimatedPromptTokens <= inputBudgetTokens
  };
}

function createUsageSnapshot(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }

  const usage = output.usage;

  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  // The camelCase aliases (inputTokens/outputTokens/model/provider) make
  // this idempotent over its own output: step details built with
  // createUsageDetail are re-sanitized by prepareRuntimeStepDetail, and
  // without them the second pass nulled input/output splits and the model —
  // which left cost-ledger USD totals permanently null. totalTokens already
  // had its camel alias; raw provider keys keep priority.
  return {
    inputTokens: readUsageNumber(
      usage.prompt_tokens,
      usage.input_tokens,
      usage.promptTokenCount,
      usage.inputTokens
    ),
    model: readString$1M(output.model) || readString$1M(usage.model) || null,
    outputTokens: readUsageNumber(
      usage.completion_tokens,
      usage.output_tokens,
      usage.candidatesTokenCount,
      usage.outputTokens
    ),
    provider: readString$1M(output.provider) || readString$1M(usage.provider) || null,
    totalTokens: readUsageNumber(
      usage.total_tokens,
      usage.totalTokenCount,
      usage.totalTokens
    ),
    updatedAt: Date.now()
  };
}

function accumulateUsage(cumulative, snapshot) {
  if (!snapshot) {
    return cumulative;
  }

  const prev = cumulative && typeof cumulative === "object" && !Array.isArray(cumulative)
    ? cumulative
    : null;

  return {
    inputTokens: (prev ? prev.inputTokens || 0 : 0) + (snapshot.inputTokens || 0),
    outputTokens: (prev ? prev.outputTokens || 0 : 0) + (snapshot.outputTokens || 0),
    totalTokens: (prev ? prev.totalTokens || 0 : 0) + (snapshot.totalTokens || 0),
    turnCount: (prev ? prev.turnCount || 0 : 0) + 1,
    updatedAt: Date.now()
  };
}

function estimateProviderPromptTokens(request, sessionPolicy) {
  const provider = readString$1M(request && request.provider) || "openai";
  const sessionPrompt = buildSessionContextSystemPrompt(request && request.sessionContext);
  const bytesPerToken = readPositiveInteger$m(
    sessionPolicy && sessionPolicy.charsPerToken,
    DEFAULT_BYTES_PER_TOKEN
  );

  if (provider === "gemini") {
    return estimateGeminiPromptTokens(request, sessionPrompt, bytesPerToken);
  }

  return estimateOpenAIPromptTokens(request, sessionPrompt, bytesPerToken);
}

function estimateOpenAIPromptTokens(request, sessionPrompt, bytesPerToken) {
  let total = OPENAI_REQUEST_OVERHEAD + ACTION_LOOP_ENVELOPE_OVERHEAD;

  if (readString$1M(request && request.systemPrompt)) {
    total += estimateMessageTokens("system", request.systemPrompt, bytesPerToken);
  }

  if (sessionPrompt) {
    total += estimateMessageTokens("system", sessionPrompt, bytesPerToken);
  }

  total += estimateConversationTokens(request && request.conversation, bytesPerToken, OPENAI_MESSAGE_OVERHEAD);
  total += estimatePartsTokens(buildCurrentTurnParts(request && request.prompt, request && request.parts), bytesPerToken, OPENAI_MESSAGE_OVERHEAD);
  return total;
}

function estimateGeminiPromptTokens(request, sessionPrompt, bytesPerToken) {
  let total = GEMINI_REQUEST_OVERHEAD + ACTION_LOOP_ENVELOPE_OVERHEAD;
  const systemPrompt = [readString$1M(request && request.systemPrompt), sessionPrompt]
    .filter(Boolean)
    .join("\n\n");

  if (systemPrompt) {
    total += estimatePartTokens("system", systemPrompt, bytesPerToken);
  }

  total += estimateConversationTokens(request && request.conversation, bytesPerToken, GEMINI_PART_OVERHEAD);
  total += estimatePartsTokens(buildCurrentTurnParts(request && request.prompt, request && request.parts), bytesPerToken, GEMINI_PART_OVERHEAD);
  return total;
}

function estimateMessageTokens(role, content, bytesPerToken) {
  return OPENAI_MESSAGE_OVERHEAD + estimateTextTokens$1(`${role}:${content}`, bytesPerToken);
}

function estimatePartTokens(role, content, bytesPerToken) {
  return GEMINI_PART_OVERHEAD + estimateTextTokens$1(`${role}:${content}`, bytesPerToken);
}

function estimateConversationTokens(conversation, bytesPerToken, overhead) {
  return (Array.isArray(conversation) ? conversation : []).reduce((total, message) => {
    if (!message || typeof message !== "object") {
      return total;
    }

    const role = readString$1M(message.role) || "user";
    return total + estimatePartsTokens(message.parts, bytesPerToken, overhead, role);
  }, 0);
}

function estimatePartsTokens(parts, bytesPerToken, overhead, role = "user") {
  const list = Array.isArray(parts) ? parts : [];
  const text = list
    .filter((part) => part && typeof part === "object" && !isImagePart(part))
    .map((part) => readString$1M(part.text))
    .filter(Boolean)
    .join("\n");
  const imageCount = list.filter(isImagePart).length;

  return overhead + estimateTextTokens$1(`${role}:${text}`, bytesPerToken) + imageCount * overhead;
}

function estimateTextTokens$1(text, bytesPerToken) {
  return Math.ceil(byteLength(text) / bytesPerToken);
}

function byteLength(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }

  if (!cachedEncoder && typeof TextEncoder === "function") {
    cachedEncoder = new TextEncoder();
  }

  if (cachedEncoder) {
    return cachedEncoder.encode(text).length;
  }

  return text.length;
}

function readPositiveInteger$m(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readString$1M(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readUsageNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

export { accumulateUsage, createUsageSnapshot, evaluateProviderPromptBudget };
