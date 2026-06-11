import { hasUsableSearchEvidence, classifySearchSourceCategory } from '../skills/providers/web-search-ranking.js';
import { isReadableEvidenceSource } from './read-source-quality.js';

// AGRUN-246-E (C3.4): LOW_VALUE_CATEGORIES removed — categorical pre-filtering of
// community/marketplace search results hides potentially relevant sources from
// verification analysis before AI sees them. AI observes source category signal
// via item.sourceCategory and judges relevance itself.

function createSearchVerification(options = {}) {
  const strategy = readString$1k(options.strategy) || "general_lookup";
  const query = readString$1k(options.query);
  const rankedItems = Array.isArray(options.rankedItems) ? options.rankedItems : [];
  const readSources = Array.isArray(options.readSources) ? options.readSources : [];
  const supportiveSources = collectSupportiveSources(rankedItems, readSources, query);
  const supportingDomains = uniqueStrings(supportiveSources.map((item) => item.domain));
  const officialDomains = uniqueStrings(
    supportiveSources
      .filter((item) => item.sourceCategory === "official" || item.sourceCategory === "government_registry")
      .map((item) => item.domain)
  );
  const tupleMatches = strategy === "entity_lookup"
    ? collectMatchingEntityTuples(supportiveSources, query)
    : [];
  const corroboratedDomains = uniqueStrings(tupleMatches.map((entry) => entry.domain));
  let state = "none";

  if (supportingDomains.length === 1) {
    state = "single_source";
  }

  if (strategy === "entity_lookup") {
    if (corroboratedDomains.length >= 2) {
      state = "corroborated";
    }
  } else if (supportingDomains.length >= 2) {
    state = "corroborated";
  }

  if (officialDomains.length >= 1 && supportingDomains.length >= 2) {
    state = "official_plus_secondary";
  }

  if (!hasUsableSearchEvidence(rankedItems) && readSources.filter(isReadableEvidenceSource).length === 0) {
    state = "none";
  }

  return {
    matchedEntityTuples: uniqueStrings(tupleMatches.map((entry) => entry.key)),
    officialDomainCount: officialDomains.length,
    readableSourceCount: readSources.filter(isReadableEvidenceSource).length,
    state,
    supportDomainCount: supportingDomains.length,
    supportingDomains,
    verifiedUrls: uniqueStrings(
      supportiveSources
        .filter((item) => supportingDomains.includes(item.domain))
        .map((item) => item.url)
    )
  };
}

function readVerificationState(value) {
  const state = value && typeof value === "object"
    ? readString$1k(value.state)
    : readString$1k(value);

  return state || "none";
}

function collectSupportiveSources(rankedItems, readSources, query) {
  const searchEntries = rankedItems
    .map((item) => normalizeSupportiveSource(item, query))
    .filter(Boolean);
  const readEntries = readSources
    .filter(isReadableEvidenceSource)
    .map((item) => normalizeSupportiveSource(item, query))
    .filter(Boolean);
  const byUrl = new Map();

  for (const item of [...searchEntries, ...readEntries]) {
    if (!byUrl.has(item.url)) {
      byUrl.set(item.url, item);
    }
  }

  return Array.from(byUrl.values());
}

function normalizeSupportiveSource(item, query) {
  const url = readString$1k(item && item.url);
  if (!url) {
    return null;
  }

  const domain = readDomain$4(url);
  const title = readString$1k(item && item.title);
  const snippet = readString$1k(item && (item.snippet || item.text));
  const sourceCategory = readString$1k(item && item.sourceCategory) || classifySearchSourceCategory({
    domain,
    snippet,
    title,
    url
  });

  return {
    domain,
    keyText: `${title}\n${snippet}\n${query}`.trim(),
    snippet,
    sourceCategory,
    title,
    url
  };
}

function collectMatchingEntityTuples(entries, query) {
  const entityHint = extractEntityHint(query);
  if (!entityHint) {
    return [];
  }

  const matches = [];

  for (const entry of entries) {
    const tuple = extractEntityTuple(entry.keyText, entityHint);
    if (!tuple) {
      continue;
    }

    matches.push({
      domain: entry.domain,
      key: `${tuple.person}|${tuple.role}|${tuple.entity}`
    });
  }

  const counts = new Map();
  for (const match of matches) {
    const domains = counts.get(match.key) || new Set();
    domains.add(match.domain);
    counts.set(match.key, domains);
  }

  return matches.filter((match) => {
    const domains = counts.get(match.key);
    return domains && domains.size >= 2;
  });
}

function extractEntityTuple(text, entityHint) {
  const normalizedText = readString$1k(text);
  if (!normalizedText) {
    return null;
  }

  const patterns = [
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+is\s+(?:listed\s+as\s+)?(ceo|director|managing director|founder|owner)\s+of\s+([A-Z][A-Za-z0-9.&\-\s]+?)(?:[.,]|$)/,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*,?\s+(ceo|director|managing director|founder|owner)\s+of\s+([A-Z][A-Za-z0-9.&\-\s]+?)(?:[.,]|$)/
  ];

  for (const pattern of patterns) {
    const match = normalizedText.match(pattern);
    if (!match) {
      continue;
    }

    const entity = normalizeEntityValue(match[3]);
    if (!entity.includes(entityHint)) {
      continue;
    }

    return {
      entity,
      person: normalizeEntityValue(match[1]),
      role: normalizeEntityValue(match[2])
    };
  }

  return null;
}

function extractEntityHint(query) {
  return readString$1k(query)
    .toLowerCase()
    .replace(/\b(boss|ceo|director|founder|owner|managing director|who|is|the|of)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(" ");
}

function normalizeEntityValue(value) {
  return readString$1k(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function readDomain$4(value) {
  try {
    return new URL(readString$1k(value)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function readString$1k(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createSearchVerification, readVerificationState };
