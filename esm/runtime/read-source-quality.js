function classifyReadSourceTier(value, options = {}) {
  return explainReadSourceQuality(value, options).tier;
}

function explainReadSourceQuality(value, options = {}) {
  const source = value && typeof value === "object" ? value : null;
  if (!source) {
    return createQualityDetail("thin", "missing_source", [], {});
  }

  const existingTier = readString$1A(source.tier).toLowerCase();
  if (READ_SOURCE_TIERS.has(existingTier)) {
    return normalizeExistingQualityDetail(source, existingTier);
  }

  const url = readString$1A(source.url).toLowerCase();
  const title = readString$1A(source.title).toLowerCase();
  const text = readString$1A(source.text).toLowerCase();
  const platform = readString$1A(source.platform).toLowerCase();
  const originStatus = typeof source.originStatus === "number" ? source.originStatus : null;
  const bytes = typeof source.bytes === "number" ? source.bytes : 0;
  const query = readString$1A(options.query).toLowerCase();
  const overlap = countTokenOverlap$2(query, `${title} ${text} ${url}`);
  const metrics = {
    bytes,
    originStatus,
    overlap,
    status: typeof source.status === "number" ? source.status : null,
    textLength: text.length
  };

  if (originStatus != null && originStatus >= 400) {
    return createQualityDetail("blocked", "origin_status_blocked", [`origin:${originStatus}`], metrics);
  }

  if (title.includes("access to this page has been denied")) {
    return createQualityDetail("blocked", "denied_title", ["blocked:title"], metrics);
  }

  if (BLOCKED_PAGE_PATTERNS.some((pattern) => pattern.test(text))) {
    return createQualityDetail("blocked", "blocked_page_pattern", ["blocked:content"], metrics);
  }

  if (source.ok === false) {
    return createQualityDetail("thin", "read_url_failed", ["ok:false"], metrics);
  }

  if (
    text === "loading" ||
    THIN_PAGE_PATTERNS.some((pattern) => pattern.test(text)) ||
    bytes > 0 && bytes < 160 ||
    text.length < 120
  ) {
    return createQualityDetail("thin", "thin_content", createThinSignals({ bytes, text }), metrics);
  }

  // AGRUN-246-E (C3.1): removed early-exit blocks for MARKETPLACE_PATTERNS and
  // COMMUNITY_PATTERNS — categorical pre-tiering hides sources from AI before it
  // can judge relevance. Sources now fall through to the neutral overlap/length
  // quality check. MARKETPLACE_PATTERNS / COMMUNITY_PATTERNS still used inside
  // isTopicOwnedSource so no marketplace/community source becomes "topic_owned";
  // that remains a structural correctness check, not a content quality judgment.

  if (query && overlap === 0) {
    return createQualityDetail("weak", "query_no_overlap", ["overlap:0"], metrics);
  }

  if (isTopicOwnedSource({ query, text, title, url })) {
    return text.length >= 360
      ? createQualityDetail("strong", "topic_owned_strong", ["topic_owned", `text:${text.length}`], metrics)
      : createQualityDetail("usable", "topic_owned_usable", ["topic_owned", `text:${text.length}`], metrics);
  }

  if (platform === "read_url_service" && overlap >= 3 && text.length >= 480) {
    return createQualityDetail("strong", "read_url_service_relevant_strong", ["read_url_service", `overlap:${overlap}`, `text:${text.length}`], metrics);
  }

  // AGRUN-246-M: distinctive-token density gate. The body-overlap path
  // alone treats a 118 kB Wikipedia general-topic page (with two trivial
  // substring matches like "test" + "evaluation") the same as a focused
  // 1 kB blog post with the same hit count. The density gate requires
  // that AT LEAST one distinctive query token appears in the body AND
  // that the density of distinctive matches per kB clears a small floor.
  // If the query produced zero distinctive tokens (all stop/generic),
  // fall back to the original overlap-only gate.
  const distinctiveTokensForBody = extractDistinctiveTokens(query);
  let distinctiveBodyHits = 0;
  if (distinctiveTokensForBody.length > 0) {
    const haystackLower = readString$1A(text).toLowerCase();
    for (const token of distinctiveTokensForBody) {
      if (haystackLower.includes(token)) distinctiveBodyHits += 1;
    }
  }
  const textKb = Math.max(1, text.length / 1000);
  const distinctiveDensity = distinctiveBodyHits / textKb;
  const passDistinctive =
    distinctiveTokensForBody.length === 0 ||
    (distinctiveBodyHits >= 1 && distinctiveDensity >= 0.1);

  if (overlap >= 2 && text.length >= 240 && passDistinctive) {
    return createQualityDetail(
      "usable",
      "overlap_usable",
      [
        `overlap:${overlap}`,
        `text:${text.length}`,
        `distinctive:${distinctiveBodyHits}`,
        `density:${distinctiveDensity.toFixed(3)}`
      ],
      metrics
    );
  }
  return createQualityDetail(
    "weak",
    overlap >= 2 && text.length >= 240
      ? "overlap_low_distinctive_density"
      : "weak_overlap_or_short",
    [
      `overlap:${overlap}`,
      `text:${text.length}`,
      `distinctive:${distinctiveBodyHits}`,
      `density:${distinctiveDensity.toFixed(3)}`
    ],
    metrics
  );
}

function countBlockedReadSources(value) {
  return countReadSourcesByTier(value, "blocked");
}

function countReadSourcesByTier(value, tier) {
  const normalizedTier = readString$1A(tier).toLowerCase();
  const sources = Array.isArray(value) ? value : [];
  let count = 0;

  for (const source of sources) {
    if (classifyReadSourceTier(source) === normalizedTier) {
      count += 1;
    }
  }

  return count;
}

function hasUsableReadSource(value) {
  return Array.isArray(value) && value.some((item) => {
    const tier = classifyReadSourceTier(item);
    return tier === "usable" || tier === "strong";
  });
}

function isReadableEvidenceSource(value) {
  const tier = classifyReadSourceTier(value);
  return tier === "usable" || tier === "strong";
}

const READ_SOURCE_TIERS = new Set(["blocked", "thin", "weak", "usable", "strong"]);

function normalizeExistingQualityDetail(source, tier) {
  const existing = source.sourceQualityDetail && typeof source.sourceQualityDetail === "object"
    ? source.sourceQualityDetail
    : source.qualityDetail && typeof source.qualityDetail === "object"
      ? source.qualityDetail
      : null;
  if (existing) {
    return createQualityDetail(
      tier,
      readString$1A(existing.reason) || "explicit_tier",
      Array.isArray(existing.signals) ? existing.signals.map(readString$1A).filter(Boolean) : [],
      existing.metrics && typeof existing.metrics === "object" ? existing.metrics : {}
    );
  }
  return createQualityDetail(tier, "explicit_tier", [`tier:${tier}`], {
    bytes: typeof source.bytes === "number" ? source.bytes : 0,
    originStatus: typeof source.originStatus === "number" ? source.originStatus : null,
    status: typeof source.status === "number" ? source.status : null,
    textLength: readString$1A(source.text).length
  });
}

function createQualityDetail(tier, reason, signals, metrics) {
  const safeMetrics = metrics && typeof metrics === "object" ? metrics : {};
  return {
    metrics: {
      bytes: typeof safeMetrics.bytes === "number" ? safeMetrics.bytes : 0,
      originStatus: typeof safeMetrics.originStatus === "number" ? safeMetrics.originStatus : null,
      overlap: typeof safeMetrics.overlap === "number" ? safeMetrics.overlap : 0,
      status: typeof safeMetrics.status === "number" ? safeMetrics.status : null,
      textLength: typeof safeMetrics.textLength === "number" ? safeMetrics.textLength : 0
    },
    reason: readString$1A(reason) || "unknown",
    signals: Array.isArray(signals) ? signals.map(readString$1A).filter(Boolean).slice(0, 8) : [],
    tier
  };
}

function createThinSignals({ bytes, text }) {
  const signals = [];
  if (readString$1A(text) === "loading") signals.push("loading");
  if (THIN_PAGE_PATTERNS.some((pattern) => pattern.test(readString$1A(text)))) signals.push("thin_pattern");
  if (bytes > 0 && bytes < 160) signals.push(`bytes:${bytes}`);
  if (readString$1A(text).length < 120) signals.push(`text:${readString$1A(text).length}`);
  return signals.length > 0 ? signals : ["thin_content"];
}

const BLOCKED_PAGE_PATTERNS = [
  /perimeterx/i,
  /\bcaptcha\b/i,
  /\battention required\b/i,
  /\bjust a moment\b/i,
  /\bcloudflare\b/i,
  /\bcf_chl\b/i,
  /window\._?cf_?chl/i,
  /press\s*&\s*hold/i,
  /confirm you are\s+a\s+human/i,
  /disable your ad-blocker/i,
  /\bpx[a-z0-9_]+\b/i,
  /security verification/i,
  /access denied/i,
  /enable javascript and cookies/i,
  /verify you are human/i
];

const THIN_PAGE_PATTERNS = [
  /^loading$/i,
  /^please wait$/i,
  /^redirecting$/i,
  /javascript is required/i,
  /enable javascript/i
];

const MARKETPLACE_PATTERNS$1 = [
  /poshmark/i,
  /ebay/i,
  /carousell/i,
  /\blisting\b/i,
  /\bfor sale\b/i
];

const COMMUNITY_PATTERNS$1 = [
  /community\./i,
  /forum/i,
  /reddit/i,
  /discussion/i
];

function isTopicOwnedSource({ query, text, title, url }) {
  const queryTokens = extractDistinctiveTokens(query);
  if (queryTokens.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(readString$1A(url));
  } catch {
    return false;
  }

  const domainCompact = parsed.hostname.replace(/^www\./i, "").replace(/[^a-z0-9]+/gi, "");
  const pathCompact = parsed.pathname.replace(/[^a-z0-9]+/gi, "");
  const titleCompact = readString$1A(title).replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const haystack = `${domainCompact} ${pathCompact} ${titleCompact}`;
  const matched = queryTokens.some((token) => haystack.includes(token));
  if (!matched) return false;

  const lowValue = [
    ...MARKETPLACE_PATTERNS$1,
    ...COMMUNITY_PATTERNS$1
  ].some((pattern) => pattern.test(readString$1A(url)) || pattern.test(readString$1A(title)));
  if (lowValue) return false;

  return readString$1A(text).length >= 180;
}

function extractDistinctiveTokens(value) {
  return tokenize$3(value)
    .filter((token) => !GENERIC_QUERY_TOKENS.has(token))
    .filter((token) => token.length >= 4 || /\d/.test(token))
    .slice(0, 4);
}

const GENERIC_QUERY_TOKENS = new Set([
  "article",
  "documentation",
  "github",
  "latest",
  "official",
  "primary",
  "profile",
  "report",
  "research",
  "source",
  "today",
  "website"
]);

function countTokenOverlap$2(query, haystack) {
  const queryTokens = tokenize$3(query);
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystackText = readString$1A(haystack).toLowerCase();
  let count = 0;

  for (const token of queryTokens) {
    if (haystackText.includes(token)) {
      count += 1;
    }
  }

  return count;
}

function tokenize$3(value) {
  return splitMixedScriptBoundaries$1(readString$1A(value))
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((token) => token.length >= 3)
    .slice(0, 12);
}

function splitMixedScriptBoundaries$1(value) {
  return readString$1A(value)
    .replace(/([\u4e00-\u9fff])([a-z0-9])/gi, "$1 $2")
    .replace(/([a-z0-9])([\u4e00-\u9fff])/gi, "$1 $2");
}

function readString$1A(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { classifyReadSourceTier, countBlockedReadSources, countReadSourcesByTier, explainReadSourceQuality, hasUsableReadSource, isReadableEvidenceSource };
