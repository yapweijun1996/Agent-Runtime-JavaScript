const COMMUNITY_PATTERNS = [
  /community\./i,
  /forum/i,
  /reddit/i,
  /discussion/i
];

const MARKETPLACE_PATTERNS = [
  /carousell/i,
  /ebay/i,
  /etsy/i,
  /listing/i,
  /marketplace/i,
  /poshmark/i
];

const GOVERNMENT_PATTERNS = [
  /\.gov\b/i,
  /\.gov\.[a-z]{2,3}\b/i,
  /registry/i,
  /registration/i
];

const DIRECTORY_PATTERNS = [
  /directory/i,
  /profile/i,
  /corporation/i
];

const NEWS_PATTERNS = [
  /apnews/i,
  /bbc/i,
  /bloomberg/i,
  /cnn/i,
  /news/i,
  /reuters/i
];

const CATEGORY_WEIGHTS = {
  business_directory: 5,
  community: -2,
  government_registry: 7,
  marketplace: -3,
  news: 4,
  official: 7,
  unknown: 2
};

function normalizeSearchPassItems(items, options = {}) {
  const query = readString$1l(options.query);
  const baseQuery = readString$1l(options.baseQuery) || query;
  const passIndex = typeof options.passIndex === "number" ? options.passIndex : 0;
  const entityTokens = extractEntityTokens(baseQuery);

  return (Array.isArray(items) ? items : []).map((item, index) => {
    const url = readString$1l(item && item.url);
    const title = readString$1l(item && item.title) || `Result ${index + 1}`;
    const snippet = readString$1l(item && item.snippet) || readString$1l(item && item.content);
    const domain = readDomain$5(url);
    const engine = readString$1l(item && item.engine) || readString$1l(item && item.source);
    const sourceCategory = classifySearchSourceCategory({
      domain,
      entityTokens,
      snippet,
      title,
      url
    });
    const queryOverlap = countTokenOverlap$1(baseQuery, `${title} ${snippet} ${url}`);
    const exactPhraseMatches = countExactQueryPhraseMatches(baseQuery, `${title} ${snippet} ${url}`);
    const sourceScore = scoreSearchResult({
      domain,
      exactPhraseMatches,
      queryOverlap,
      snippet,
      sourceCategory,
      title,
      url
    });

    return {
      domain,
      engine,
      passIndex,
      query,
      snippet,
      source: domain || engine,
      sourceCategory,
      sourceScore,
      queryOverlap,
      exactPhraseMatches,
      title,
      url
    };
  }).filter((item) => item.url || item.snippet);
}

function aggregateRankedSearchResults(searchPasses, options = {}) {
  const flattened = (Array.isArray(searchPasses) ? searchPasses : [])
    .flatMap((pass) => Array.isArray(pass && pass.items) ? pass.items : []);
  const deduped = dedupeByUrl(flattened);
  const ordered = diversifyByDomain(deduped)
    .slice(0, normalizeLimit(options.limit, deduped.length));

  return ordered.map((item, index) => ({
    ...item,
    rank: index + 1
  }));
}

function classifySearchSourceCategory(options = {}) {
  const domain = readString$1l(options.domain).toLowerCase();
  const title = readString$1l(options.title).toLowerCase();
  const snippet = readString$1l(options.snippet).toLowerCase();
  const url = readString$1l(options.url).toLowerCase();
  const haystack = `${domain} ${title} ${snippet} ${url}`;
  const entityTokens = Array.isArray(options.entityTokens) ? options.entityTokens : [];

  if (MARKETPLACE_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "marketplace";
  }

  if (COMMUNITY_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "community";
  }

  if (GOVERNMENT_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "government_registry";
  }

  if (DIRECTORY_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "business_directory";
  }

  if (NEWS_PATTERNS.some((pattern) => pattern.test(haystack)) || /\/article\/|\/articles\/|\/live-|\d{4}\/\d{2}\/\d{2}\//i.test(url)) {
    return "news";
  }

  if (looksOfficialDomain(domain, entityTokens)) {
    return "official";
  }

  return "unknown";
}

function countTokenOverlap$1(query, haystack) {
  const queryTokens = tokenize$2(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const normalizedHaystack = readString$1l(haystack).toLowerCase();
  let count = 0;

  for (const token of queryTokens) {
    if (normalizedHaystack.includes(token)) {
      count += 1;
    }
  }

  return count;
}

function hasUsableSearchEvidence(items) {
  return (Array.isArray(items) ? items : []).some((item) => {
    if (!item || typeof item !== "object") return false;

    // Synthetic items (grounded model answer, no URL) count as usable evidence.
    if (!readString$1l(item.url) && readString$1l(item.snippet)) return true;

    return readString$1l(item.url) &&
      readString$1l(item.sourceCategory) !== "community" &&
      readString$1l(item.sourceCategory) !== "marketplace" &&
      typeof item.sourceScore === "number" &&
      (typeof item.queryOverlap !== "number" || readNumber$8(item.queryOverlap) >= 2) &&
      item.sourceScore >= 3;
  });
}

function scoreSearchResult(options) {
  const domain = readString$1l(options.domain);
  const title = readString$1l(options.title);
  const snippet = readString$1l(options.snippet);
  readString$1l(options.url);
  const category = readString$1l(options.sourceCategory) || "unknown";
  const overlap = readNumber$8(options.queryOverlap);
  const exactPhraseMatches = readNumber$8(options.exactPhraseMatches);
  let score = CATEGORY_WEIGHTS[category] || CATEGORY_WEIGHTS.unknown;

  score += overlap * 2;
  score += exactPhraseMatches * 4;

  if (/\b(leadership|company profile|executive|managing director|ceo|founder|owner)\b/i.test(`${title} ${snippet}`)) {
    score += 2;
  }

  if (/\b(article|press|update|published|reported)\b/i.test(`${title} ${snippet}`)) {
    score += 1;
  }

  if (domain && /^www\./i.test(domain)) {
    score += 0.5;
  }

  return score;
}

function dedupeByUrl(items) {
  const bestByUrl = new Map();
  const syntheticItems = [];

  for (const item of items) {
    const url = readString$1l(item && item.url);

    // Synthetic items (no URL but have snippet) are kept as-is, not deduped.
    if (!url) {
      if (readString$1l(item && item.snippet)) {
        syntheticItems.push({ ...item });
      }
      continue;
    }

    const current = bestByUrl.get(url);
    if (
      !current ||
      readNumber$8(item.sourceScore) > readNumber$8(current.sourceScore) ||
      (
        readNumber$8(item.sourceScore) === readNumber$8(current.sourceScore) &&
        readNumber$8(item.passIndex) < readNumber$8(current.passIndex)
      )
    ) {
      bestByUrl.set(url, { ...item });
    }
  }

  // Real URL items first, then synthetic items appended at the end.
  return [...Array.from(bestByUrl.values()), ...syntheticItems];
}

function diversifyByDomain(items) {
  const remaining = items.slice().sort((left, right) => (
    readNumber$8(right.sourceScore) - readNumber$8(left.sourceScore)
      || readNumber$8(left.passIndex) - readNumber$8(right.passIndex)
  ));
  const ordered = [];
  const domainCounts = new Map();

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      const domain = readString$1l(item && item.domain);
      const domainPenalty = (domainCounts.get(domain) || 0) * 1.5;
      const diversifiedScore = readNumber$8(item && item.sourceScore) - domainPenalty;

      if (diversifiedScore > bestScore) {
        bestIndex = index;
        bestScore = diversifiedScore;
      }
    }

    const next = remaining.splice(bestIndex, 1)[0];
    const domain = readString$1l(next && next.domain);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    ordered.push(next);
  }

  return ordered;
}

function looksOfficialDomain(domain, entityTokens) {
  const normalizedDomain = readString$1l(domain).replace(/^www\./i, "");
  if (!normalizedDomain) {
    return false;
  }

  const compactDomain = normalizedDomain.replace(/[^a-z0-9]+/gi, "");
  const compactEntity = entityTokens.join("");

  if (compactEntity && compactDomain.includes(compactEntity)) {
    return true;
  }

  const matchingTokens = entityTokens.filter((token) => compactDomain.includes(token));
  return matchingTokens.length >= 2;
}

function extractEntityTokens(query) {
  return tokenize$2(query)
    .filter((token) => !["boss", "ceo", "director", "founder", "headlines", "latest", "managing", "news", "owner", "today"].includes(token))
    .slice(0, 4);
}

function tokenize$2(value) {
  return splitMixedScriptBoundaries(readString$1l(value))
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((token) => token.length >= 2);
}

function countExactQueryPhraseMatches(query, haystack) {
  const phrases = extractQueryPhrases(query);
  if (phrases.length === 0) return 0;
  const normalizedHaystack = splitMixedScriptBoundaries(readString$1l(haystack))
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return phrases.filter((phrase) => normalizedHaystack.includes(phrase)).length;
}

function extractQueryPhrases(query) {
  const tokens = tokenize$2(query)
    .filter((token) => !GENERIC_QUERY_PHRASE_TOKENS.has(token));
  const phrases = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    phrases.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return Array.from(new Set(phrases)).slice(0, 6);
}

const GENERIC_QUERY_PHRASE_TOKENS = new Set([
  "about",
  "agent",
  "agents",
  "ai",
  "and",
  "design",
  "for",
  "framework",
  "frameworks",
  "of",
  "system",
  "systems",
  "the"
]);

function splitMixedScriptBoundaries(value) {
  return readString$1l(value)
    .replace(/([\u4e00-\u9fff])([a-z0-9])/gi, "$1 $2")
    .replace(/([a-z0-9])([\u4e00-\u9fff])/gi, "$1 $2");
}

function normalizeLimit(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function readDomain$5(value) {
  try {
    return new URL(readString$1l(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function readNumber$8(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString$1l(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { aggregateRankedSearchResults, classifySearchSourceCategory, countTokenOverlap$1 as countTokenOverlap, hasUsableSearchEvidence, normalizeSearchPassItems };
