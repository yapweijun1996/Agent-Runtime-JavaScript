import { normalizeCandidateSource } from '../session/context-snapshot-fields.js';
import { readString } from './semantic-json.js';
import { isExternalSourceCoveragePrompt } from './external-source-intent.js';
import { isReadableEvidenceSource } from './read-source-quality.js';
import { extractResearchCoverageTargets } from './research-coverage-guard.js';
import { readVerificationState } from './web-search-verification.js';

const DEFAULT_SOURCE_LIMIT = 3;
const PROMPT_RELEVANCE_STOP_WORDS = new Set([
  "about",
  "agent",
  "caveats",
  "check",
  "citations",
  "complete",
  "continue",
  "evidence",
  "executive",
  "findings",
  "final",
  "first",
  "gaps",
  "links",
  "long",
  "multiple",
  "public",
  "recommendations",
  "report",
  "research",
  "search",
  "short",
  "source",
  "sources",
  "summary",
  "table",
  "topic",
  "track",
  "urls",
  "web",
  "with"
]);
const GENERIC_NEWS_TITLE_RE = /\b(?:latest|breaking|top)\s+(?:[a-z]+\s+){0,3}(?:news|headlines?)\b|\b(?:news|headlines?)\s+(?:home|homepage|hub|topic|roundup|portal|coverage|section)\b|\bgoogle\s+news\b/i;
const NON_NEWS_EVIDENCE_TEXT_RE = /\b(?:q&a|question|answer|forum|community|discussion|thread|subreddit|resume|résumé|cv|curriculum\s+vitae|job\s+posting|job\s+listing|profile|wiki|\u767e\u79d1|newsletter|email\s+newsletter)\b/i;
const GENERIC_PATH_SEGMENTS = new Set([
  "article",
  "articles",
  "breaking-news",
  "category",
  "coverage",
  "home",
  "homepage",
  "hub",
  "latest",
  "latest-news",
  "local",
  "malaysia",
  "nation",
  "national",
  "newsletter",
  "newsletters",
  "news",
  "regional",
  "search",
  "singapore",
  "stories",
  "tag",
  "tags",
  "topic",
  "topics",
  "united-states",
  "us",
  "usa",
  "world"
]);

function collectFinalResponseSources(researchContext, limit = DEFAULT_SOURCE_LIMIT, options = {}) {
  const context = researchContext && typeof researchContext === "object" ? researchContext : {};
  // AGRUN-519 (part B) — in evidence-convergence (research quality-gate) runs the
  // runtime must NOT author a Sources section from unread search-snippet URLs: the
  // report's cited evidence must be read-checked. `requireReadEvidence` suppresses
  // the search-snippet fallback so only read_url sources surface. Non-research
  // prompts (article/news coverage) keep the fallback. Read-evidence absence then
  // yields an empty payload — the AI's own in-prose Sources/limitations stand.
  const requireReadEvidence = !!(options && options.requireReadEvidence);
  const searchResults = normalizeSearchResults(
    context.aggregatedSearchResults || context.searchResults
  );
  const readSources = normalizeReadSources(context.readSources);
  const verificationState = readVerificationState(context.verificationState || context.verification);
  const verifiedUrls = new Set(readVerifiedUrls(context.verification));
  const matchingSearchByUrl = new Map(searchResults.map((item) => [item.url, item]));
  const promptFocusTerms = extractPromptFocusTerms(options && options.prompt);
  const sources = [];
  const seenUrls = new Set();
  const targetAwareSources = selectTargetAwareSources({
    requireConcreteArticle: isArticleLikePrompt(options && options.prompt),
    requireReadEvidence,
    limit,
    prompt: readString(options && options.prompt),
    readSources,
    searchResults,
    verificationState,
    verifiedUrls
  });

  if (targetAwareSources) {
    return createSourcePayload(targetAwareSources);
  }

  for (const item of readSources) {
    const url = readString(item.url);
    if (!url || seenUrls.has(url) || !isReadableEvidenceSource(item) || !isDirectEvidenceUrl(url)) {
      continue;
    }
    if (!sourceMatchesPromptFocus(item, promptFocusTerms)) {
      continue;
    }

    seenUrls.add(url);
    sources.push({
      kind: "read_url",
      title: readString(item.title) || readString(matchingSearchByUrl.get(url)?.title) || url,
      url
    });

    if (sources.length >= limit) {
      return createSourcePayload(sources);
    }
  }

  if (sources.length > 0) {
    return createSourcePayload(sources);
  }

  if (requireReadEvidence) {
    return createSourcePayload(sources);
  }

  const searchCandidates = verificationState !== "none" && verifiedUrls.size > 0
    ? searchResults.filter((item) => verifiedUrls.has(item.url))
    : searchResults;

  for (const item of searchCandidates) {
    const url = readString(item.url);
    if (!url || seenUrls.has(url) || !isDirectEvidenceUrl(url)) {
      continue;
    }
    const matchesPromptFocus = sourceMatchesPromptFocus(item, promptFocusTerms);
    if (!matchesPromptFocus) {
      continue;
    }
    if (
      isArticleLikePrompt(options && options.prompt)
      && promptFocusTerms.length === 0
      && !isConcreteArticleSource(item)
    ) {
      continue;
    }

    seenUrls.add(url);
    sources.push({
      kind: "web_search",
      title: readString(item.title) || url,
      url
    });

    if (sources.length >= limit) {
      break;
    }
  }

  return createSourcePayload(sources);
}

function appendSourcesSection(text, sources) {
  const normalizedText = stripGenericSourceLabels(readString(text));
  const sourceList = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const textWithoutModelSources = stripSourcesSection(normalizedText);

  if (sourceList.length === 0) {
    return textWithoutModelSources;
  }

  const sourceBlock = [
    "Sources:",
    ...sourceList.map((item, index) => `${index + 1}. ${formatSourceLine(item)}`)
  ].join("\n");

  return textWithoutModelSources
    ? `${textWithoutModelSources}\n\n${sourceBlock}`
    : sourceBlock;
}

function collectResearchEvidenceUrls(researchContext) {
  const context = researchContext && typeof researchContext === "object" ? researchContext : {};
  const urls = new Set();

  for (const item of normalizeReadSources(context.readSources)) {
    addDirectUrl(urls, item.url);
  }

  for (const item of normalizeSearchResults(context.aggregatedSearchResults || context.searchResults)) {
    addDirectUrl(urls, item.url);
  }

  const passes = Array.isArray(context.searchPasses) ? context.searchPasses : [];
  for (const pass of passes) {
    for (const item of normalizeSearchResults(readOutputArray$1(pass, "items", "rankedItems"))) {
      addDirectUrl(urls, item.url);
    }
  }

  return Array.from(urls);
}

function createSourcePayload(sources) {
  return {
    citations: sources.map((item) => item.url),
    sources
  };
}

function formatSourceLine(item) {
  const title = readString(item && item.title);
  const url = readString(item && item.url);

  if (!title || title === url) {
    return `[${url}](${url})`;
  }

  return `[${escapeMarkdownLinkText(title)}](${url})`;
}

function stripSourcesSection(text) {
  const normalized = readString(text);
  if (!normalized) return "";

  const lines = normalized.split(/\r?\n/);
  let sourcesIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isSourcesHeadingLine(lines[index]) || isUnsupportedInlineSourcesLine(lines[index])) {
      sourcesIndex = index;
      break;
    }
  }

  if (sourcesIndex === -1) {
    return normalized;
  }

  return lines.slice(0, sourcesIndex).join("\n").trim();
}

function stripGenericSourceLabels(text) {
  const normalized = readString(text);
  if (!normalized) return "";

  return normalized
    .split(/\r?\n/)
    .filter((line) => !isGenericSourceLabelLine(line))
    .join("\n")
    .trim();
}

function isGenericSourceLabelLine(line) {
  return /^\s*(?:[-*+]\s*)?(?:[*_]{0,2})?Sources?\s*:\s*(?:Web\s+Search(?:\s+Results?)?|Search(?:\s+Results?)?|web_search|Provider|Grounding|Model|Planned\s+Tool\s+Results?|Tool\s+Results?|Search\s+Data)(?:[*_]{0,2})?\s*$/i.test(readString(line));
}

function isSourcesHeadingLine(line) {
  return /^\s*(?:#{1,6}\s*)?(?:[*_]{1,2})?(?:(?:Verified|Selected|Reference|Evidence)\s+)?Sources\s*:?\s*(?:[*_]{1,2})?\s*$/i.test(readString(line));
}

function isUnsupportedInlineSourcesLine(line) {
  const normalized = readString(line);
  if (!normalized || /https?:\/\//i.test(normalized)) return false;
  return /^\s*(?:#{1,6}\s*)?(?:[*_]{0,2})?(?:(?:Verified|Selected|Reference|Evidence)\s+)?Sources\b\s+.{1,180}$/i.test(normalized);
}

function escapeMarkdownLinkText(value) {
  return readString(value).replace(/[[\]]/g, "");
}

function normalizeSearchResults(value) {
  const items = Array.isArray(value) ? value : [];

  return items
    .map((item) => normalizeCandidateSource(item))
    .filter((item) => item && isHttpUrl$1(item.url));
}

function normalizeReadSources(value) {
  const items = Array.isArray(value) ? value : [];

  return items
    .map((item) => (
      item && typeof item === "object" && !Array.isArray(item)
        ? {
            ...item,
            title: readString(item.title),
            url: readString(item.url)
          }
        : null
    ))
    .filter((item) => item && isHttpUrl$1(item.url));
}

function selectTargetAwareSources(options) {
  const targets = extractResearchCoverageTargets(readString(options && options.prompt));
  if (targets.length < 2) return null;

  const candidates = collectSourceCandidates(options);
  if (candidates.length === 0) return [];

  const selected = [];
  const seenUrls = new Set();
  for (const target of targets) {
    const match = candidates.find((candidate) => (
      !seenUrls.has(candidate.url) && sourceMatchesTarget(candidate, target)
      && (options.requireConcreteArticle !== true || isConcreteArticleSource(candidate))
    ));
    if (!match) continue;
    selected.push({
      kind: match.kind,
      title: match.title,
      url: match.url
    });
    seenUrls.add(match.url);
    if (selected.length >= options.limit) break;
  }

  return selected;
}

function collectSourceCandidates(options) {
  const readSources = Array.isArray(options && options.readSources) ? options.readSources : [];
  const searchResults = Array.isArray(options && options.searchResults) ? options.searchResults : [];
  const verifiedUrls = options && options.verifiedUrls instanceof Set ? options.verifiedUrls : new Set();
  const verificationState = readString(options && options.verificationState);
  // AGRUN-519 (part B) — research quality-gate runs only cite read-checked sources.
  const requireReadEvidence = !!(options && options.requireReadEvidence);
  const candidates = [];
  const seenUrls = new Set();
  const push = (item, kind) => {
    const url = readString(item && item.url);
    if (!url || seenUrls.has(url) || !isDirectEvidenceUrl(url)) return;
    if (kind === "read_url" && !isReadableEvidenceSource(item)) return;
    if (kind === "web_search" && verificationState !== "none" && verifiedUrls.size > 0 && !verifiedUrls.has(url)) return;
    seenUrls.add(url);
    candidates.push({
      domain: readDomain$3(url),
      kind,
      snippet: readString(item && item.snippet) || readString(item && item.content),
      title: readString(item && item.title) || url,
      url
    });
  };

  for (const item of readSources) push(item, "read_url");
  if (!requireReadEvidence) {
    for (const item of searchResults) push(item, "web_search");
  }
  return candidates;
}

function isConcreteArticleSource(source) {
  const url = readString(source && source.url);
  if (!isDirectEvidenceUrl(url)) return false;

  const title = readString(source && source.title);
  const snippet = readString(source && source.snippet) || readString(source && source.content);
  if (isNonNewsEvidenceSource({ title, snippet, url })) {
    return false;
  }
  if (!hasSpecificPath(url) && isHomepageOrGenericSection(url)) {
    return false;
  }
  if (GENERIC_NEWS_TITLE_RE.test(title) && !hasSpecificPath(url)) {
    return false;
  }
  if (/^(?:ap|reuters|cnn|bbc|cna|bernama|the star|the straits times|stomp|google news)\s*(?:news|headlines?|coverage)?$/i.test(title) && !hasSpecificPath(url)) {
    return false;
  }

  if (hasSpecificPath(url)) return true;
  return /\b(?:\d{4}|court|minister|president|election|market|tariff|policy|appeal|attack|launch|announces?|reports?|investigation|inflation)\b/i.test(`${title} ${snippet}`);
}

function isNonNewsEvidenceSource(source) {
  const url = readString(source && source.url);
  const title = readString(source && source.title);
  const snippet = readString(source && source.snippet);
  try {
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    return NON_NEWS_EVIDENCE_TEXT_RE.test(`${title} ${snippet} ${pathname}`);
  } catch (error) {
    return NON_NEWS_EVIDENCE_TEXT_RE.test(`${title} ${snippet} ${url}`);
  }
}

function sourceMatchesTarget(source, target) {
  const haystack = [
    source.title,
    source.snippet,
    source.url,
    source.domain
  ].map(readString).join(" ");
  return Array.isArray(target && target.aliases)
    && target.aliases.some((alias) => hasComparablePhrase$1(haystack, alias));
}

function hasComparablePhrase$1(text, phrase) {
  const haystack = ` ${normalizeComparableText$2(text)} `;
  const needle = normalizeComparableText$2(phrase);
  return needle ? haystack.includes(` ${needle} `) : false;
}

function isArticleLikePrompt(value) {
  return isExternalSourceCoveragePrompt(value);
}

function hasSpecificPath(url) {
  try {
    const parsed = new URL(readString(url));
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).toLowerCase().replace(/[^a-z0-9-]+/g, ""))
      .filter(Boolean)
      .filter((segment) => !GENERIC_PATH_SEGMENTS.has(segment));
    if (segments.some((segment) => /\b20\d{2}\b|\d{6,}|[a-f0-9]{16,}/i.test(segment))) return true;
    return segments.length >= 3;
  } catch (error) {
    return false;
  }
}

function isHomepageOrGenericSection(url) {
  try {
    const parsed = new URL(readString(url));
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).toLowerCase().replace(/[^a-z0-9-]+/g, ""))
      .filter(Boolean);
    if (segments.length === 0) return true;
    return segments.every((segment) => GENERIC_PATH_SEGMENTS.has(segment));
  } catch (error) {
    return false;
  }
}

function normalizeComparableText$2(value) {
  return readString(value)
    .toLowerCase()
    .replace(/\bu\.s\.a\.\b/g, "usa")
    .replace(/\bu\.s\.\b/g, "us")
    .replace(/\bu\.k\.\b/g, "uk")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractPromptFocusTerms(value) {
  const text = readString(value).toLowerCase();
  if (!text) return [];

  const terms = [];
  const seen = new Set();
  const push = (term) => {
    const normalized = normalizeComparableText$2(term);
    if (!normalized || normalized.length < 5 || PROMPT_RELEVANCE_STOP_WORDS.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push(normalized);
  };

  for (const match of text.matchAll(/["'“”‘’`]([^"'“”‘’`]{5,80})["'“”‘’`]/g)) {
    push(match[1]);
  }

  for (const match of text.matchAll(/\b[a-z0-9][a-z0-9._-]{4,}\b/g)) {
    push(match[0]);
  }

  return terms.slice(0, 12);
}

function sourceMatchesPromptFocus(source, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return true;

  const haystack = normalizeComparableText$2([
    source && source.title,
    source && source.snippet,
    source && source.content,
    source && source.text,
    source && source.url
  ].map(readString).join(" "));

  return terms.some((term) => haystack.includes(term));
}

function readOutputArray$1(output, ...keys) {
  const source = output && typeof output === "object" ? output : null;

  for (const key of keys) {
    if (Array.isArray(source && source[key])) {
      return source[key];
    }
  }

  return [];
}

function addDirectUrl(sink, value) {
  const url = readString(value);
  if (isDirectEvidenceUrl(url)) {
    sink.add(url);
  }
}

function readDomain$3(url) {
  try {
    return new URL(readString(url)).hostname.replace(/^www\./i, "");
  } catch (error) {
    return "";
  }
}

/**
 * Restrict a source payload (from `collectFinalResponseSources`) to entries
 * whose URL appears in the provided provenance-backed evidence URL list.
 * When `evidenceUrls` is empty / missing, returns the payload unchanged — the
 * caller has opted out of scoping. When `evidenceUrls` is provided, sources
 * not in the set are treated as unprovenanced (i.e. hallucinated citations)
 * and dropped. Citations are re-derived from the surviving sources so the
 * payload stays internally consistent.
 */
function filterSourcesByEvidence(payload, evidenceUrls) {
  const sources = Array.isArray(payload && payload.sources) ? payload.sources : [];
  const citations = Array.isArray(payload && payload.citations) ? payload.citations : [];
  const urls = Array.isArray(evidenceUrls) ? evidenceUrls : null;

  if (!urls) {
    return {
      citations: citations.slice(),
      sources: sources.slice()
    };
  }

  const allowed = new Set(urls.map((url) => readString(url)).filter(Boolean));
  const kept = sources.filter((item) => allowed.has(readString(item && item.url)));
  return {
    citations: kept.map((item) => item.url),
    sources: kept
  };
}

/**
 * Reconcile planner-provided citations with evidence-derived citations.
 * Guarantees HTTP citations ⊆ evidence by returning deduplicated
 * evidence-derived URLs. Planner-provided non-HTTP citation markers
 * such as `session_memory` are preserved because they are internal
 * provenance labels, not user-facing web URLs.
 */
function reconcileCitations(plannerCitations, evidenceCitations) {
  const planner = Array.isArray(plannerCitations) ? plannerCitations : [];
  const evidence = Array.isArray(evidenceCitations) ? evidenceCitations : [];
  const seen = new Set();
  const merged = [];

  // Evidence citations take priority.
  for (const url of evidence) {
    const normalized = readString(url);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      merged.push(normalized);
    }
  }

  for (const citation of planner) {
    const normalized = readString(citation);
    if (!normalized || /^https?:\/\//i.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

function isDirectEvidenceUrl(value) {
  const normalized = readString(value);
  if (!isHttpUrl$1(normalized)) return false;

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (hostname === "vertexaisearch.cloud.google.com" && pathname.includes("/grounding-api-redirect/")) {
      return false;
    }
    if (pathname.includes("/grounding-api-redirect/")) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function isHttpUrl$1(value) {
  return /^https?:\/\//i.test(readString(value));
}

function readVerifiedUrls(verification) {
  return Array.isArray(verification && verification.verifiedUrls)
    ? verification.verifiedUrls.filter((item) => typeof item === "string" && item.trim())
    : [];
}

export { appendSourcesSection, collectFinalResponseSources, collectResearchEvidenceUrls, filterSourcesByEvidence, isConcreteArticleSource, isDirectEvidenceUrl, reconcileCitations };
