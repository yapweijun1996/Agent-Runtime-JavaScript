import { fetchWithRetry, DEFAULT_SEARCH_TIMEOUT_MS } from './fetch-resilience.js';

const DEFAULT_SEARXNG_LIMIT = 5;

async function searchSearxng(request) {
  const resolvedFetch = resolveFetch$3(request.fetch);
  const endpoint = readEndpoint(request.endpoint);
  const url = new URL(endpoint);

  url.searchParams.set("q", request.query);
  url.searchParams.set("format", "json");

  if (request.limit != null) {
    url.searchParams.set("count", String(request.limit));
  }

  const response = await fetchWithRetry(resolvedFetch, url.toString(), {
    headers: {
      Accept: "application/json"
    },
    method: "GET"
  }, {
    timeoutMs: request.timeoutMs || DEFAULT_SEARCH_TIMEOUT_MS,
    maxRetries: 1,
    signal: request.signal
  });
  const payload = await readJsonPayload(response);

  if (!response.ok) {
    throw createSearchError(readSearxngErrorMessage(payload, response.status), {
      request: {
        endpoint,
        query: request.query,
        requestUrl: url.toString()
      },
      response: {
        body: payload,
        status: response.status
      }
    });
  }

  return {
    items: normalizeResults(payload, request.limit),
    provider: "searxng",
    raw: payload,
    requestUrl: url.toString(),
    status: response.status
  };
}

function normalizeResults(payload, limit) {
  const maxItems = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SEARXNG_LIMIT;
  const results = Array.isArray(payload && payload.results) ? payload.results : [];

  return results.slice(0, maxItems).map((item) => ({
    domain: readResultDomain(item),
    engine: readResultEngine(item),
    snippet: readResultSnippet(item),
    source: readResultSource(item),
    title: readResultTitle(item),
    url: readResultUrl(item)
  }));
}

function readResultTitle(item) {
  return item && typeof item.title === "string" ? item.title.trim() : "";
}

function readResultUrl(item) {
  return item && typeof item.url === "string" ? item.url.trim() : "";
}

function readResultSnippet(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  if (typeof item.content === "string") {
    return item.content.trim();
  }

  if (typeof item.description === "string") {
    return item.description.trim();
  }

  return "";
}

function readResultSource(item) {
  const domain = readResultDomain(item);
  return domain || readResultEngine(item);
}

function readResultEngine(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  if (typeof item.engine === "string" && item.engine.trim().length > 0) {
    return item.engine.trim();
  }

  return "";
}

function readResultDomain(item) {
  const url = readResultUrl(item);
  if (url.length === 0) {
    return "";
  }

  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function readEndpoint(endpoint) {
  if (typeof endpoint === "string" && endpoint.trim().length > 0) {
    const trimmed = endpoint.trim();
    // ROADMAP D4 — the endpoint is host/user configuration that reaches
    // fetch verbatim; only http(s) is a search backend. Reject file:,
    // javascript:, data:, chrome-extension: and friends up front with a
    // clear message instead of whatever the fetch layer would do with them.
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Web search endpoint is not a valid URL: "${trimmed.slice(0, 80)}".`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Web search endpoint must use http or https, got "${parsed.protocol}".`);
    }
    return trimmed;
  }

  throw new Error('Web search requires a non-empty "endpoint".');
}

function resolveFetch$3(fetchImpl) {
  if (typeof fetchImpl === "function") {
    return fetchImpl;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }

  throw new Error("A fetch implementation is required for web search adapters.");
}

async function readJsonPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readSearxngErrorMessage(payload, status) {
  if (payload && typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error.trim();
  }

  return `SearXNG request failed with status ${status}.`;
}

function createSearchError(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

export { searchSearxng };
