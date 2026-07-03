import { searchWeb } from '../../skills/providers/web-search.js';
import { planWebSearch } from '../../skills/providers/web-search-planner.js';
import { normalizeSearchPassItems, aggregateRankedSearchResults, hasUsableSearchEvidence } from '../../skills/providers/web-search-ranking.js';
import { isConcreteArticleSource } from '../final-response-sources.js';
import { createSearchVerification } from '../web-search-verification.js';
import { withDeadline, DEFAULT_SEARCH_DEADLINE_MS } from '../../skills/providers/fetch-resilience.js';
import { readString } from '../semantic-json.js';

const webSearchAction = Object.freeze({
  description: "Search the web for current or factual information.",
  name: "web_search",
  planner: {
    aliases: ["search", "websearch"],
    argsExample: {
      limit: 5,
      maxPasses: 3,
      query: "...",
      strategy: "auto"
    },
    // AGRUN-595 — provider/searchProvider removed from the MODEL-facing
    // schema: the search backend is host configuration. Exposing a bare
    // `provider: string` invited engine-name guesses ('bing', 'google',
    // 'serpapi') that failed every call. Host-side request.searchProvider
    // wiring is unaffected; the executor still honors known values.
    argsSchema: {
      deadlineMs: { type: "number" },
      limit: { type: "number" },
      maxPasses: { type: "number" },
      query: { type: "string" },
      siteHints: { type: "array" },
      strategy: { type: "string" }
    },
    decisionType: "action",
    guidance: "Use web_search for current, factual, or lookup requests that need outside information. The search backend is preconfigured by the host — never pass a provider or engine name."
  },
  tier: 1,
  execute: executeWebSearchAction,
  outputSchema: {
    kinds: ["web_search_result"],
    controls: ["continue"],
    metrics: { resultCount: "count" }
  }
});

async function executeWebSearchAction(context, args) {
  const originalQuery = readString(args && args.query) || readString(context.request && context.request.prompt);
  const limit = readPositiveInteger$f(args && args.limit) || 5;
  const provider = readSearchProvider(context, args);
  const searchAuthMode = readSearchAuthMode(context, provider);
  const searchApiKey = readSearchApiKey(context, provider);
  const searchEndpoint = readSearchEndpoint(context, provider, searchAuthMode);
  const searchModel = readSearchModel(context, provider);
  const searchPlan = planWebSearch({
    maxPasses: readPositiveInteger$f(args && args.maxPasses) || readPositiveInteger$f(context.request && context.request.maxPasses),
    query: originalQuery,
    siteHints: readStringArray$2(args && args.siteHints) || readStringArray$2(context.request && context.request.siteHints),
    strategy: readString(args && args.strategy) || readString(context.request && context.request.strategy)
  });
  const readSources = Array.isArray(context && context.runState && context.runState.researchContext && context.runState.researchContext.readSources)
    ? context.runState.researchContext.readSources
    : [];
  const searchPasses = [];
  let verification = createSearchVerification({
    query: searchPlan.baseQuery,
    rankedItems: [],
    readSources,
    strategy: searchPlan.strategy
  });
  let rankedItems = [];
  let lastResult = null;

  const deadline = withDeadline(
    readPositiveInteger$f(args && args.deadlineMs) || DEFAULT_SEARCH_DEADLINE_MS
  );

  try {
    for (let index = 0; index < searchPlan.passes.length; index += 1) {
      if (deadline.expired()) {
        break;
      }

      const pass = searchPlan.passes[index];
      if (!shouldExecutePass(pass, searchPasses, verification)) {
        continue;
      }

      try {
        lastResult = await searchWeb({
          apiKey: searchApiKey,
          authMode: searchAuthMode,
          endpoint: searchEndpoint,
          fetch: context.request.fetch,
          limit,
          model: searchModel,
          provider,
          query: pass.query,
          signal: deadline.signal
        });
      } catch (error) {
        // If a single pass times out / fails, stop the loop but keep results so far.
        if (error && (error.name === "TimeoutError" || error.name === "AbortError" || error.code === "FETCH_TIMEOUT")) {
          break;
        }
        throw error;
      }

      const normalizedItems = normalizeSearchPassItems(lastResult.items, {
        baseQuery: searchPlan.baseQuery,
        passIndex: searchPasses.length,
        query: pass.query
      });

      searchPasses.push({
        count: normalizedItems.length,
        items: normalizedItems,
        kind: pass.kind,
        provider,
        groundingQueries: Array.isArray(lastResult.groundingQueries) ? lastResult.groundingQueries : [],
        groundingSupportsCount: typeof lastResult.groundingSupportsCount === "number" ? lastResult.groundingSupportsCount : 0,
        query: pass.query,
        raw: lastResult.raw,
        requestUrl: lastResult.requestUrl,
        status: lastResult.status
      });
      rankedItems = aggregateRankedSearchResults(searchPasses, { limit });
      verification = createSearchVerification({
        query: searchPlan.baseQuery,
        rankedItems,
        readSources,
        strategy: searchPlan.strategy
      });

      if (shouldStopSearch(searchPlan, searchPasses, rankedItems, verification)) {
        break;
      }
    }

    if (shouldTryGroundingFallback({
      context,
      deadline,
      provider,
      rankedItems,
      searchPlan
    })) {
      const fallbackAuthMode = readSearchAuthMode(context, "gemini_grounding");
      const fallbackQuery = createGroundingFallbackQuery(searchPlan.originalQuery || searchPlan.baseQuery);
      try {
        const fallbackResult = await searchWeb({
          apiKey: readSearchApiKey(context, "gemini_grounding"),
          authMode: fallbackAuthMode,
          endpoint: fallbackAuthMode === "server"
            ? readSearchEndpoint(context, "gemini_grounding", fallbackAuthMode)
            : "",
          fetch: context.request.fetch,
          limit,
          model: readSearchModel(context, "gemini_grounding"),
          provider: "gemini_grounding",
          query: fallbackQuery,
          signal: deadline.signal
        });
        lastResult = fallbackResult;
        const normalizedItems = normalizeSearchPassItems(fallbackResult.items, {
          baseQuery: searchPlan.baseQuery,
          passIndex: searchPasses.length,
          query: fallbackQuery
        });
        searchPasses.push({
          count: normalizedItems.length,
          items: normalizedItems,
          kind: "grounding_fallback",
          provider: "gemini_grounding",
          groundingQueries: Array.isArray(fallbackResult.groundingQueries) ? fallbackResult.groundingQueries : [],
          groundingSupportsCount: typeof fallbackResult.groundingSupportsCount === "number" ? fallbackResult.groundingSupportsCount : 0,
          query: fallbackQuery,
          raw: fallbackResult.raw,
          requestUrl: fallbackResult.requestUrl,
          status: fallbackResult.status
        });
        rankedItems = aggregateRankedSearchResults(searchPasses, { limit });
        verification = createSearchVerification({
          query: searchPlan.baseQuery,
          rankedItems,
          readSources,
          strategy: searchPlan.strategy
        });
      } catch (error) {
        searchPasses.push({
          count: 0,
          error: readString(error && error.message) || "Gemini grounding fallback failed.",
          items: [],
          kind: "grounding_fallback",
          provider: "gemini_grounding",
          query: fallbackQuery,
          status: "error"
        });
      }
    }
  } finally {
    deadline.cleanup();
  }

  const items = rankedItems.slice(0, limit);
  const query = searchPlan.baseQuery;

  return {
    control: "continue",
    output: {
      count: items.length,
      items,
      kind: "web_search_result",
      lastExecutedQuery: searchPasses.length > 0
        ? searchPasses[searchPasses.length - 1].query
        : query,
      originalQuery,
      provider,
      query,
      rankedItems,
      raw: lastResult ? lastResult.raw : null,
      requestUrl: lastResult ? lastResult.requestUrl : null,
      searchPasses,
      searchPlan,
      status: lastResult ? lastResult.status : null,
      verification
    },
    summary: `web_search(${query}) -> ${items.length} result(s)`
  };
}

function shouldExecutePass(pass, searchPasses, verification) {
  if (!pass || typeof pass !== "object") {
    return false;
  }

  if (pass.kind !== "site_target") {
    return true;
  }

  return searchPasses.length >= 2 && readString(verification && verification.state) === "none";
}

function shouldStopSearch(searchPlan, searchPasses, rankedItems, verification) {
  if (searchPasses.length === 0) {
    return false;
  }

  if (searchPasses.length === searchPlan.passes.length) {
    return true;
  }

  if (
    searchPlan.strategy === "general_lookup" &&
    searchPasses.length === 1 &&
    searchPlan.passes.some((pass) => pass && pass.kind === "exact_phrase")
  ) {
    return readString(verification && verification.state) === "official_plus_secondary"
      || hasUsableSearchEvidence(rankedItems);
  }

  if (searchPlan.strategy === "entity_lookup" && searchPasses.length < 2) {
    return false;
  }

  if (searchPlan.strategy === "fresh_news" && !hasConcreteArticleEvidence(rankedItems)) {
    return false;
  }

  if (readString(verification && verification.state) === "official_plus_secondary") {
    return true;
  }

  return hasUsableSearchEvidence(rankedItems);
}

function shouldTryGroundingFallback(options) {
  if (!options || options.provider !== "searxng") return false;
  if (!options.searchPlan || options.searchPlan.strategy !== "fresh_news") return false;
  if (hasConcreteArticleEvidence(options.rankedItems)) return false;
  if (options.deadline && typeof options.deadline.expired === "function" && options.deadline.expired()) {
    return false;
  }
  const apiKey = readSearchApiKey(options.context, "gemini_grounding");
  const model = readSearchModel(options.context, "gemini_grounding");
  return !!apiKey && !!model;
}

function hasConcreteArticleEvidence(items) {
  return (Array.isArray(items) ? items : []).some((item) => isConcreteArticleSource(item));
}

function createGroundingFallbackQuery(query) {
  const text = readString(query);
  return text
    ? `${text} direct article sources`
    : "latest news direct article sources";
}

function readSearchProvider(context, args) {
  const requestProvider = readString(context && context.request && context.request.searchProvider)
    || (
      context &&
      context.request &&
      context.request.type === "web_search"
        ? readString(context.request.provider)
        : ""
    );
  // AGRUN-595 — the search provider is HOST configuration, not a model
  // decision. Models (live: gpt-5-mini) guess engine names ('bing',
  // 'google', 'serpapi') into the args field; trusting them verbatim made
  // searchWeb throw "Unsupported web search provider" before any fetch, and
  // the model concluded the tool itself was broken (clarification loops /
  // "search tool is failing" — the AGRUN-596 'variance' was this bug's
  // probability of the model filling the field). Only KNOWN provider values
  // are honored from args; anything else falls through to host config.
  const KNOWN_SEARCH_PROVIDERS = new Set(["searxng", "gemini_grounding"]);
  const argsProvider = readString(args && (args.searchProvider || args.provider));
  const requestedProvider = (argsProvider && KNOWN_SEARCH_PROVIDERS.has(argsProvider) ? argsProvider : "")
    || requestProvider;

  if (requestedProvider && requestedProvider !== "web_search") {
    return requestedProvider;
  }

  const hasSearxngEndpoint = !!readString(context && context.webSearchEndpoint);
  if (hasSearxngEndpoint) {
    return "searxng";
  }

  const hasGeminiApiKey = !!(
    readString(context && context.request && context.request.webSearchApiKey)
    || readString(context && context.request && context.request.apiKey)
  );
  if (hasGeminiApiKey) {
    return "gemini_grounding";
  }

  return "searxng";
}

function readSearchApiKey(context, provider) {
  if (provider !== "gemini_grounding") {
    return "";
  }

  if (readSearchAuthMode(context, provider) === "server") {
    return "";
  }

  const request = context && context.request;
  const explicitSearchKey = readString(request && request.webSearchApiKey);
  if (explicitSearchKey) {
    return explicitSearchKey;
  }

  const requestedSearchProvider = readString(request && (request.searchProvider || request.provider));
  if (requestedSearchProvider === "gemini_grounding" || readString(request && request.type) === "web_search") {
    return readString(request && request.apiKey);
  }

  return "";
}

function readSearchEndpoint(context, provider, authMode) {
  if (provider === "searxng") {
    return readString(context && context.webSearchEndpoint);
  }

  const request = context && context.request;
  if (authMode === "server") {
    return readString(request && request.webSearchEndpoint)
      || (request && request.type === "web_search" ? readString(request.endpoint) : "");
  }

  return readString(request && request.webSearchEndpoint)
    || readString(request && request.endpoint);
}

function readSearchModel(context, provider) {
  if (provider !== "gemini_grounding") {
    return "";
  }

  const request = context && context.request;
  const explicitSearchModel = readString(request && request.webSearchModel);
  if (explicitSearchModel) {
    return explicitSearchModel;
  }

  const requestedSearchProvider = readString(request && (request.searchProvider || request.provider));
  if (requestedSearchProvider === "gemini_grounding" || readString(request && request.type) === "web_search") {
    return readString(request && request.model);
  }

  return "";
}

function readSearchAuthMode(context, provider) {
  if (provider !== "gemini_grounding") {
    return "client";
  }

  const request = context && context.request;
  const value = readString(request && request.webSearchAuthMode)
    || readString(request && request.authMode);
  return value === "server" ? "server" : "client";
}

function readPositiveInteger$f(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function readStringArray$2(value) {
  return Array.isArray(value)
    ? value.map((item) => readString(item)).filter(Boolean)
    : null;
}

export { executeWebSearchAction, webSearchAction };
