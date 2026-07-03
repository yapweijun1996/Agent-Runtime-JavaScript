import { extractResearchCoverageTargets } from '../../runtime/research-coverage-guard.js';
import { readString } from '../../runtime/semantic-json.js';

const DEFAULT_WEB_SEARCH_MAX_PASSES = 3;
const DEFAULT_WEB_SEARCH_STRATEGY = "auto";

const SUPPORTED_STRATEGIES = new Set([
  "auto",
  "direct",
  "entity_lookup",
  "fresh_news",
  "general_lookup"
]);

const ENTITY_EXPANSION_ROLES = ["ceo", "director", "managing director", "founder", "owner"];
const ENTITY_ROLE_HINTS = new Set(["boss", ...ENTITY_EXPANSION_ROLES]);
const NEWS_PATTERN = /\b(news|headline|headlines|breaking|latest|today(?:'s)?)\b/i;
const DIRECT_PATTERN = /\b(site:|intitle:|inurl:|"|https?:\/\/)\b/i;
const QUESTION_FILLERS = new Set([
  "a",
  "an",
  "boss",
  "company",
  "currently",
  "current",
  "for",
  "from",
  "how",
  "is",
  "its",
  "of",
  "the",
  "their",
  "this",
  "to",
  "what",
  "which",
  "who",
  "with"
]);
const GENERIC_EXACT_PHRASE_TOKENS = new Set([
  "agent",
  "agents",
  "ai",
  "and",
  "design",
  "framework",
  "frameworks",
  "system",
  "systems"
]);

function normalizeWebSearchStrategy(value) {
  const normalized = readString(value).toLowerCase();
  return SUPPORTED_STRATEGIES.has(normalized)
    ? normalized
    : DEFAULT_WEB_SEARCH_STRATEGY;
}

function normalizeWebSearchMaxPasses(value, fallback = DEFAULT_WEB_SEARCH_MAX_PASSES) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, DEFAULT_WEB_SEARCH_MAX_PASSES)
    : fallback;
}

function normalizeSiteHints(value) {
  return Array.isArray(value)
    ? value
      .map((item) => readString(item).toLowerCase())
      .filter(Boolean)
      .slice(0, 5)
    : [];
}

function planWebSearch(options = {}) {
  const originalQuery = collapseWhitespace(readString(options.query)).toLowerCase();
  const strategy = resolveSearchStrategy(originalQuery, options.strategy);
  const maxPasses = normalizeWebSearchMaxPasses(options.maxPasses);
  const siteHints = normalizeSiteHints(options.siteHints);
  const baseQuery = createBaseQuery(originalQuery, strategy);
  const passes = buildPasses({
    baseQuery,
    maxPasses,
    originalQuery,
    siteHints,
    strategy
  });

  return {
    baseQuery,
    maxPasses,
    originalQuery,
    passes,
    siteHints,
    strategy
  };
}

function buildPasses(options) {
  const strategy = options.strategy;
  const maxPasses = options.maxPasses;

  if (strategy === "direct") {
    return [{ kind: "direct", query: options.originalQuery || options.baseQuery }];
  }

  if (strategy === "fresh_news") {
    return buildFreshNewsPasses(options).slice(0, maxPasses);
  }

  if (strategy === "entity_lookup") {
    return buildEntityLookupPasses(options).slice(0, maxPasses);
  }

  return buildGeneralLookupPasses(options).slice(0, maxPasses);
}

function buildFreshNewsPasses(options) {
  const targetPasses = buildTargetFreshNewsPasses(options);
  if (targetPasses.length > 0) {
    return targetPasses;
  }

  const baseQuery = createFreshNewsBaseQuery(options.originalQuery);
  const secondQuery = createFreshNewsExpansionQuery(options.originalQuery);
  const articleQuery = createFreshNewsArticleQuery(options.originalQuery);
  const passes = [{ kind: "compression", query: baseQuery }];

  if (secondQuery !== baseQuery) {
    passes.push({ kind: "expansion", query: secondQuery });
  }
  if (articleQuery !== baseQuery && articleQuery !== secondQuery) {
    passes.push({ kind: "article_source", query: articleQuery });
  }

  return passes;
}

function buildTargetFreshNewsPasses(options) {
  const targets = extractResearchCoverageTargets(options.originalQuery);
  if (!Array.isArray(targets) || targets.length < 2) {
    return [];
  }

  const limit = normalizeWebSearchMaxPasses(options.maxPasses);
  return targets.slice(0, limit).map((target) => ({
    kind: "target_article_source",
    query: createTargetFreshNewsQuery(target.label, options.originalQuery),
    target: target.label
  }));
}

function buildEntityLookupPasses(options) {
  const entity = extractEntityName(options.originalQuery);
  const baseRole = readEntityRole(options.originalQuery) || "boss";
  const passes = [{
    kind: "compression",
    query: entity ? `${entity} ${baseRole}` : options.baseQuery
  }];
  const expansionRole = createEntityExpansionRoles(baseRole)[0];

  if (entity && expansionRole) {
    passes.push({
      kind: "expansion",
      query: `${entity} ${expansionRole}`
    });
  }

  const fallbackSite = options.siteHints[0] || null;
  if (entity && fallbackSite) {
    passes.push({
      kind: "site_target",
      query: `site:${fallbackSite} "${entity}"`
    });
  }

  return passes;
}

function buildGeneralLookupPasses(options) {
  const passes = [{ kind: "compression", query: options.baseQuery }];
  const exactPhraseQuery = createExactPhraseQuery(options.baseQuery);
  const fallbackSite = options.siteHints[0] || "";

  if (exactPhraseQuery && exactPhraseQuery !== options.baseQuery) {
    passes.push({
      kind: "exact_phrase",
      query: exactPhraseQuery
    });
  }

  if (fallbackSite) {
    passes.push({
      kind: "site_target",
      query: `site:${fallbackSite} "${options.baseQuery}"`
    });
  }

  return passes;
}

function createExactPhraseQuery(query) {
  const tokens = tokenize(query).filter((token) => !QUESTION_FILLERS.has(token));
  if (tokens.length < 2) return "";
  const phraseTokens = tokens
    .filter((token) => !GENERIC_EXACT_PHRASE_TOKENS.has(token))
    .slice(0, 3);
  if (phraseTokens.length < 2) return "";
  const phrase = phraseTokens.slice(0, 2).join(" ");
  return `"${phrase}" ${tokens.slice(0, 6).join(" ")}`;
}

function resolveSearchStrategy(query, explicitStrategy) {
  const strategy = normalizeWebSearchStrategy(explicitStrategy);

  if (strategy !== "auto") {
    return strategy;
  }

  if (DIRECT_PATTERN.test(query)) {
    return "direct";
  }

  if (NEWS_PATTERN.test(query)) {
    return "fresh_news";
  }

  if (looksLikeEntityLookup(query)) {
    return "entity_lookup";
  }

  return "general_lookup";
}

function createBaseQuery(query, strategy) {
  if (strategy === "direct") {
    return query;
  }

  if (strategy === "fresh_news") {
    return createFreshNewsBaseQuery(query);
  }

  if (strategy === "entity_lookup") {
    const entity = extractEntityName(query);
    const role = readEntityRole(query) || "boss";
    return entity ? `${entity} ${role}` : compressQuery(query);
  }

  return compressQuery(query);
}

function createFreshNewsBaseQuery(prompt) {
  const trimmedPrompt = collapseWhitespace(prompt);

  if (trimmedPrompt.length === 0) {
    return "latest news headlines";
  }

  if (!/\bnews\b/i.test(trimmedPrompt) && !/\bheadline/i.test(trimmedPrompt)) {
    return `${trimmedPrompt} news`;
  }

  if (/^\s*(today(?:'s)?|latest|breaking)\s+news\s*$/i.test(trimmedPrompt)) {
    return "today news headlines";
  }

  if (!/\bheadline/i.test(trimmedPrompt)) {
    return `${trimmedPrompt} headlines`;
  }

  return trimmedPrompt;
}

function createFreshNewsExpansionQuery(prompt) {
  const trimmedPrompt = collapseWhitespace(prompt);

  if (trimmedPrompt.length === 0) {
    return "latest world news headlines today";
  }

  if (!/\bnews\b/i.test(trimmedPrompt) && !/\bheadline/i.test(trimmedPrompt)) {
    return `${trimmedPrompt} latest headlines`;
  }

  if (/^\s*(today(?:'s)?|latest|breaking)\s+news\s*$/i.test(trimmedPrompt)) {
    return "latest world news headlines today";
  }

  if (!/\bheadline/i.test(trimmedPrompt)) {
    return `${trimmedPrompt} latest updates major news outlets`;
  }

  return `${trimmedPrompt} latest`;
}

function createFreshNewsArticleQuery(prompt) {
  const trimmedPrompt = collapseWhitespace(prompt);

  if (trimmedPrompt.length === 0) {
    return "latest news article source Reuters AP";
  }

  return `${trimmedPrompt} article source Reuters AP official news`;
}

function createTargetFreshNewsQuery(targetLabel, prompt) {
  const target = collapseWhitespace(targetLabel);
  const dateHint = extractDateHint(prompt);
  return [
    target,
    dateHint,
    "latest news article source official publisher"
  ].filter(Boolean).join(" ");
}

function extractDateHint(value) {
  const text = collapseWhitespace(value);
  const iso = text.match(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/);
  if (iso) return iso[0];

  const monthDate = text.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/i);
  return monthDate ? monthDate[0] : "";
}

function createEntityExpansionRoles(baseRole) {
  const normalizedRole = baseRole === "boss" ? "" : baseRole;

  return ENTITY_EXPANSION_ROLES.filter((role) => role !== normalizedRole);
}

function looksLikeEntityLookup(query) {
  if (/\b(who is|who's|leadership|executive|owner|founder|director|ceo|boss)\b/i.test(query)) {
    return true;
  }

  return query.split(/\s+/).some((token) => ENTITY_ROLE_HINTS.has(token.toLowerCase()));
}

function extractEntityName(query) {
  const tokens = tokenize(query)
    .filter((token) => !QUESTION_FILLERS.has(token))
    .filter((token) => !ENTITY_ROLE_HINTS.has(token));

  return tokens.slice(0, 6).join(" ");
}

function readEntityRole(query) {
  const lowered = query.toLowerCase();

  if (/\bmanaging director\b/.test(lowered)) {
    return "managing director";
  }

  for (const role of ["boss", "ceo", "director", "founder", "owner"]) {
    if (new RegExp(`\\b${escapeRegExp$1(role)}\\b`, "i").test(lowered)) {
      return role;
    }
  }

  return "";
}

function compressQuery(query) {
  const tokens = tokenize(query).filter((token) => !QUESTION_FILLERS.has(token));
  return tokens.slice(0, 6).join(" ") || collapseWhitespace(query);
}

function tokenize(value) {
  return collapseWhitespace(readString(value))
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff.&-]+/i)
    .filter(Boolean);
}

function collapseWhitespace(value) {
  return readString(value).replace(/\s+/g, " ").trim();
}

function escapeRegExp$1(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { DEFAULT_WEB_SEARCH_MAX_PASSES, DEFAULT_WEB_SEARCH_STRATEGY, normalizeSiteHints, normalizeWebSearchMaxPasses, normalizeWebSearchStrategy, planWebSearch };
