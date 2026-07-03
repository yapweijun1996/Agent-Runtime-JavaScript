import { readString, readFiniteNumber } from './semantic-json.js';
import { isSecretKey, scrubSecretText } from './secret-redaction.js';
export { redactSecretFields } from './secret-redaction.js';

const TEXT_PREVIEW_CHARS = 1200;
const RAW_PREVIEW_CHARS = 2000;
const MAX_MESSAGES = 12;
const MAX_TOOLS = 24;
const TRACE_REDACTION_POLICY = "safe_summary_no_secrets_no_image_bytes";

function createProviderRequestTrace(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const tools = normalizeTools(options.tools);
  const system = readString(options.system);
  const providerOptions = sanitizeStructuredValue(options.providerOptions);
  const sessionContext = summarizeSessionContext$1(options.sessionContext);
  const prompt = readString(options.prompt);
  const messageSummary = summarizeMessages(messages);
  const toolSchemaChars = measureJsonChars(tools.raw);

  return {
    type: "llm_request_trace",
    version: 1,
    redaction: "safe_summary_no_secrets_no_image_bytes",
    provider: readString(options.provider) || "n/a",
    model: readString(options.model) || "n/a",
    apiVariant: readString(options.apiVariant) || null,
    authMode: readString(options.authMode) || null,
    callKind: readString(options.callKind) || null,
    endpoint: summarizeEndpoint$1(options.endpoint),
    payload: {
      providerOptions,
      system: summarizeText(system),
      prompt: summarizeText(prompt),
      messages: messageSummary.messages,
      tools: tools.summary,
      toolChoice: readString(options.toolChoice) || null,
      sessionContext
    },
    metrics: {
      estimatedChars: system.length + messageSummary.textChars + toolSchemaChars,
      debugPromptChars: prompt.length,
      messageCount: messages.length,
      messageTextChars: messageSummary.textChars,
      omittedImages: messageSummary.omittedImages,
      sessionContextSourceChars: sessionContext.textChars,
      sessionContextChars: sessionContext.textChars,
      systemChars: system.length,
      toolCount: tools.summary.count,
      toolSchemaChars
    }
  };
}

function createProviderResponseTrace(options = {}) {
  const response = options.response && typeof options.response === "object" ? options.response : {};
  const text = readString(options.text);
  const toolCalls = summarizeToolCalls(options.toolCalls);
  const usageSummary = summarizeUsage$1(options.usage);
  const latencyMs = readFiniteNumber(options.durationMs);
  return {
    type: "llm_response_trace",
    version: 1,
    redaction: "safe_summary_no_secrets",
    provider: readString(options.provider) || "n/a",
    model: readString(options.model) || "n/a",
    status: typeof options.status === "number" && Number.isFinite(options.status) ? options.status : null,
    finishReason: readString(options.finishReason) || null,
    metrics: {
      inputTokens: usageSummary.inputTokens,
      latencyMs,
      outputTokens: usageSummary.outputTokens,
      textChars: text.length,
      toolCallCount: toolCalls.length,
      totalTokens: usageSummary.totalTokens
    },
    text: summarizeText(text),
    toolCalls,
    usage: sanitizeStructuredValue(options.usage),
    usageSummary,
    raw: summarizeRawResponse(response)
  };
}

function summarizeTraceText(value, max = TEXT_PREVIEW_CHARS) {
  const text = readString(value);
  return {
    chars: text.length,
    hash: text ? stableHash(text) : null,
    preview: text ? truncate$1(text.replace(/\s+/g, " "), max) : ""
  };
}

function stableTraceHash(value) {
  return stableHash(readString(value));
}

function sanitizeTraceValue(value) {
  return sanitizeStructuredValue(value);
}

function sanitizeTraceString(value) {
  return sanitizeString(readString(value));
}

function summarizeMessages(messages) {
  let textChars = 0;
  let omittedImages = 0;
  const summarized = [];
  for (const message of messages.slice(0, MAX_MESSAGES)) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const role = readString(message.role) || "unknown";
    const content = summarizeContent(message.content);
    textChars += content.textChars;
    omittedImages += content.omittedImages;
    summarized.push({
      role,
      content: content.summary
    });
  }
  return {
    messages: summarized,
    omittedImages,
    textChars,
    truncated: messages.length > summarized.length
  };
}

function summarizeContent(content) {
  if (typeof content === "string") {
    return {
      omittedImages: 0,
      summary: {
        kind: "text",
        text: summarizeText(content)
      },
      textChars: content.length
    };
  }
  if (!Array.isArray(content)) {
    return {
      omittedImages: 0,
      summary: { kind: "unknown" },
      textChars: 0
    };
  }
  let textChars = 0;
  let omittedImages = 0;
  const parts = content.slice(0, 16).map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return { type: "unknown" };
    if (part.type === "text") {
      const text = readString(part.text);
      textChars += text.length;
      return {
        type: "text",
        text: summarizeText(text)
      };
    }
    if (part.type === "image") {
      omittedImages += 1;
      return {
        type: "image",
        image: "[omitted]",
        mimeType: readString(part.mimeType) || null
      };
    }
    return {
      type: readString(part.type) || "unknown"
    };
  });
  return {
    omittedImages,
    summary: {
      kind: "parts",
      parts,
      truncated: content.length > parts.length
    },
    textChars
  };
}

function normalizeTools(tools) {
  if (!tools) {
    return {
      raw: null,
      summary: {
        count: 0,
        names: []
      }
    };
  }
  const names = [];
  const raw = sanitizeStructuredValue(tools);

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && Array.isArray(tool.functionDeclarations)) {
        for (const declaration of tool.functionDeclarations) {
          const name = readString(declaration && declaration.name);
          if (name) names.push(name);
        }
      } else {
        const name = readString(tool && (tool.name || (tool.function && tool.function.name)));
        if (name) names.push(name);
      }
    }
  } else if (typeof tools === "object") {
    names.push(...Object.keys(tools).filter(Boolean));
  }

  return {
    raw,
    summary: {
      count: names.length,
      names: names.slice(0, MAX_TOOLS),
      schema: summarizeStructured(raw)
    }
  };
}

function summarizeToolCalls(value) {
  const calls = Array.isArray(value) ? value : [];
  return calls.slice(0, MAX_TOOLS).map((call) => {
    const args = parseMaybeJson(call && (call.arguments || call.args || call.input));
    return {
      name: readString(call && (call.name || call.toolName)) || null,
      argsShape: summarizeShape(args)
    };
  });
}

function summarizeSessionContext$1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      present: false,
      textChars: 0
    };
  }
  const fields = {};
  let textChars = 0;
  for (const [key, rawValue] of Object.entries(value)) {
    if (isSecretKey(key)) {
      fields[key] = "[redacted]";
      continue;
    }
    if (typeof rawValue === "string") {
      fields[key] = summarizeText(rawValue);
      textChars += rawValue.length;
    } else if (Array.isArray(rawValue)) {
      fields[key] = {
        count: rawValue.length
      };
      textChars += measureJsonChars(rawValue);
    } else if (rawValue && typeof rawValue === "object") {
      fields[key] = summarizeStructured(sanitizeStructuredValue(rawValue));
      textChars += measureJsonChars(rawValue);
    } else if (rawValue != null) {
      fields[key] = sanitizeStructuredValue(rawValue);
    }
  }
  return {
    present: true,
    fields,
    textChars
  };
}

function summarizeRawResponse(value) {
  if (!value || typeof value !== "object") {
    return {
      present: false,
      type: value == null ? "null" : typeof value
    };
  }
  const safe = sanitizeStructuredValue(value);
  return {
    present: true,
    shape: summarizeShape(safe),
    preview: truncate$1(JSON.stringify(safe), RAW_PREVIEW_CHARS)
  };
}

function summarizeStructured(value) {
  return {
    chars: measureJsonChars(value),
    hash: stableHash(JSON.stringify(value == null ? null : value)),
    shape: summarizeShape(value)
  };
}

function summarizeShape(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length
    };
  }
  if (value && typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).slice(0, 20)
    };
  }
  return {
    type: value == null ? "null" : typeof value
  };
}

function sanitizeStructuredValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return "[depth omitted]";
  if (value == null) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular omitted]";
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((item) => sanitizeStructuredValue(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (isSecretKey(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = sanitizeStructuredValue(raw, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return `[${typeof value}]`;
}

function sanitizeString(value) {
  if (value.startsWith("data:image/")) return "[image data omitted]";
  return scrubSecretText(value);
}

function summarizeUsage$1(value) {
  const usage = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const inputTokens = firstFiniteNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokenCount,
    usage.inputTokens
  );
  const outputTokens = firstFiniteNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.candidatesTokenCount,
    usage.outputTokens
  );
  const totalTokens = firstFiniteNumber(
    usage.total_tokens,
    usage.totalTokenCount,
    usage.totalTokens
  ) ?? (
    inputTokens != null || outputTokens != null
      ? (inputTokens || 0) + (outputTokens || 0)
      : null
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = readFiniteNumber(value);
    if (number != null) return number;
  }
  return null;
}

function summarizeText(value) {
  return summarizeTraceText(value, TEXT_PREVIEW_CHARS);
}

function summarizeEndpoint$1(value) {
  const endpoint = readString(value);
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return {
      origin: url.origin,
      path: url.pathname || "/"
    };
  } catch {
    return {
      origin: endpoint.replace(/[?#].*$/, ""),
      path: null
    };
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value == null ? null : value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function measureJsonChars(value) {
  try {
    return JSON.stringify(value == null ? null : value).length;
  } catch {
    return 0;
  }
}

function stableHash(value) {
  const text = readString(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function truncate$1(value, max) {
  const text = readString(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export { TRACE_REDACTION_POLICY, createProviderRequestTrace, createProviderResponseTrace, sanitizeTraceString, sanitizeTraceValue, stableTraceHash, summarizeTraceText };
