import { fetchWithRetry, DEFAULT_GROUNDING_TIMEOUT_MS, fetchWithTimeout } from './fetch-resilience.js';

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_LIMIT = 5;
const REDIRECT_RESOLVE_TIMEOUT_MS = 5000;

async function searchGeminiGrounding(request) {
  const authMode = readAuthMode$1(request.authMode);
  const apiKey = authMode === "server" ? "" : readRequiredString(request.apiKey, "apiKey");
  const model = readRequiredString(request.model, "model");
  const query = readRequiredString(request.query, "query");
  const resolvedFetch = resolveFetch$4(request.fetch);
  const endpoint = readGeminiGroundingEndpoint(request.endpoint, model, authMode);
  const requestBody = {
    contents: [{
      parts: [{
        text: buildGroundingPrompt(query)
      }],
      role: "user"
    }],
    tools: [{ google_search: {} }]
  };
  const response = await fetchWithRetry(resolvedFetch, endpoint, {
    body: JSON.stringify(requestBody),
    headers: buildGeminiGroundingHeaders(apiKey, authMode),
    method: "POST"
  }, {
    timeoutMs: request.timeoutMs || DEFAULT_GROUNDING_TIMEOUT_MS,
    maxRetries: 0,
    signal: request.signal
  });
  const payload = await readJsonPayload$1(response);

  if (!response.ok) {
    throw createSearchError$1(readGeminiErrorMessage(payload, response.status), {
      request: {
        endpoint,
        model,
        provider: "gemini_grounding",
        query,
        requestBody
      },
      response: {
        body: payload,
        status: response.status
      }
    });
  }

  const candidate = Array.isArray(payload && payload.candidates) ? payload.candidates[0] : null;
  const groundingMetadata = candidate && typeof candidate === "object" && candidate.groundingMetadata && typeof candidate.groundingMetadata === "object"
    ? candidate.groundingMetadata
    : {};
  const groundingQueries = Array.isArray(groundingMetadata.webSearchQueries)
    ? groundingMetadata.webSearchQueries.filter((value) => typeof value === "string" && value.trim())
    : [];
  const chunkItems = await normalizeGroundingItems(groundingMetadata, {
    authMode,
    fetch: resolvedFetch,
    limit: request.limit,
    signal: request.signal
  });

  // When Gemini returns webSearchQueries but no groundingChunks (common since mid-2025),
  // extract the model's text answer as a synthetic search result so the caller still
  // receives usable evidence.  The model DID search — it just no longer exposes source URLs.
  const items = chunkItems.length > 0
    ? chunkItems
    : buildSyntheticItems(candidate, groundingQueries, query, request.limit);

  return {
    groundingQueries,
    groundingSupportsCount: Array.isArray(groundingMetadata.groundingSupports) ? groundingMetadata.groundingSupports.length : 0,
    items,
    provider: "gemini_grounding",
    raw: payload,
    requestBody,
    requestUrl: endpoint,
    status: response.status,
    synthetic: chunkItems.length === 0 && items.length > 0
  };
}

function readAuthMode$1(value) {
  return value === "server" ? "server" : "client";
}

function readGeminiGroundingEndpoint(endpoint, model, authMode) {
  const normalizedEndpoint = readString$J(endpoint);
  if (normalizedEndpoint) {
    return normalizedEndpoint;
  }
  if (authMode === "server") {
    throw new Error('Gemini grounded web search with authMode "server" requires a non-empty "endpoint".');
  }
  return `${GEMINI_API_BASE_URL}/${encodeURIComponent(model)}:generateContent`;
}

function buildGeminiGroundingHeaders(apiKey, authMode) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (authMode !== "server") {
    headers["x-goog-api-key"] = apiKey;
  }
  return headers;
}

async function normalizeGroundingItems(metadata, options = {}) {
  const supportsByIndex = collectSupportSnippets(metadata);
  const chunks = Array.isArray(metadata && metadata.groundingChunks) ? metadata.groundingChunks : [];
  const limit = options.limit;
  const maxItems = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const items = [];
  const seenUrls = new Set();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const web = chunk && typeof chunk === "object" && chunk.web && typeof chunk.web === "object"
      ? chunk.web
      : null;
    const rawUrl = readString$J(web && web.uri);
    const url = await resolveGroundingRedirectUrl(rawUrl, {
      authMode: options.authMode,
      fetch: options.fetch,
      signal: options.signal
    });
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    items.push({
      domain: readDomain(url),
      engine: "gemini_grounding",
      snippet: supportsByIndex.get(index) || "",
      source: readDomain(url) || "gemini_grounding",
      title: readString$J(web && web.title) || `Source ${items.length + 1}`,
      url
    });

    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

async function resolveGroundingRedirectUrl(url, options = {}) {
  const normalized = readString$J(url);
  if (!normalized || !isGroundingRedirectUrl(normalized)) {
    return normalized;
  }

  // In browser ("client") authMode the redirect endpoint
  // (vertexaisearch.cloud.google.com) returns no Access-Control-Allow-Origin
  // header, so a cross-origin HEAD is unconditionally CORS-blocked. Skip the
  // futile request and keep the still-navigable redirect URL.
  if (options.authMode === "client") {
    return normalized;
  }

  const fetchImpl = typeof options.fetch === "function"
    ? options.fetch
    : (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  if (!fetchImpl) {
    return normalized;
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, normalized, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      method: "HEAD",
      redirect: "follow"
    }, {
      timeoutMs: REDIRECT_RESOLVE_TIMEOUT_MS,
      signal: options.signal
    });
    const finalUrl = readString$J(response && response.url);
    return finalUrl && !isGroundingRedirectUrl(finalUrl) ? finalUrl : normalized;
  } catch (error) {
    return normalized;
  }
}

function isGroundingRedirectUrl(value) {
  const normalized = readString$J(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.hostname.toLowerCase() === "vertexaisearch.cloud.google.com" &&
      parsed.pathname.toLowerCase().includes("/grounding-api-redirect/");
  } catch (error) {
    return false;
  }
}

function buildSyntheticItems(candidate, groundingQueries, originalQuery, limit) {
  const text = extractCandidateText(candidate);
  if (!text) {
    return [];
  }

  const maxItems = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  // Primary item: the model's grounded answer as a synthetic snippet.
  // This preserves the research evidence for downstream planner/finalize use.
  const items = [{
    domain: "gemini_grounding",
    engine: "gemini_grounding",
    snippet: text.length > 1000 ? text.slice(0, 1000) + "…" : text,
    source: "gemini_grounding",
    synthetic: true,
    title: groundingQueries.length > 0
      ? `Gemini search: ${groundingQueries[0]}`
      : `Gemini search: ${originalQuery}`,
    url: ""
  }];

  // Additional items from each grounding query (for multi-pass ranking diversity).
  for (let index = 1; index < groundingQueries.length && items.length < maxItems; index += 1) {
    items.push({
      domain: "gemini_grounding",
      engine: "gemini_grounding",
      snippet: "",
      source: "gemini_grounding",
      synthetic: true,
      title: `Gemini search: ${groundingQueries[index]}`,
      url: ""
    });
  }

  return items;
}

function extractCandidateText(candidate) {
  if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) {
    return "";
  }

  return candidate.content.parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function collectSupportSnippets(metadata) {
  const supports = Array.isArray(metadata && metadata.groundingSupports) ? metadata.groundingSupports : [];
  const snippetsByIndex = new Map();

  for (const support of supports) {
    if (!support || typeof support !== "object") {
      continue;
    }

    const segmentText = readString$J(support.segment && support.segment.text);
    const chunkIndices = Array.isArray(support.groundingChunkIndices)
      ? support.groundingChunkIndices.filter((value) => Number.isInteger(value) && value >= 0)
      : [];

    if (!segmentText || chunkIndices.length === 0) {
      continue;
    }

    for (const index of chunkIndices) {
      const existing = snippetsByIndex.get(index);
      snippetsByIndex.set(index, existing ? `${existing} ${segmentText}`.trim() : segmentText);
    }
  }

  return snippetsByIndex;
}

function buildGroundingPrompt(query) {
  return [
    "Search the public web for reliable sources that answer this query.",
    "Prioritize official sites, government registries, business directories, and reputable news.",
    "Return a concise evidence-focused answer with citations.",
    `Query: ${query}`
  ].join("\n");
}

function readRequiredString(value, name) {
  const normalized = readString$J(value);
  if (!normalized) {
    throw new Error(`Web search requires a non-empty "${name}".`);
  }

  return normalized;
}

function readString$J(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readDomain(value) {
  try {
    return new URL(readString$J(value)).hostname;
  } catch {
    return "";
  }
}

function resolveFetch$4(fetchImpl) {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error("A fetch implementation is required for web search adapters.");
}

async function readJsonPayload$1(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readGeminiErrorMessage(payload, status) {
  const message = payload && payload.error && typeof payload.error.message === "string"
    ? payload.error.message
    : `Gemini grounding request failed with status ${status}.`;

  return message;
}

function createSearchError$1(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

export { resolveGroundingRedirectUrl, searchGeminiGrounding };
