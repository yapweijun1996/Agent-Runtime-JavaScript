import { normalizeSkillManifests, createAgentSkillSummary } from './agent-skills.js';

const DEFAULT_SKILL_CATALOG_TOP_K = 10;
const DEFAULT_SKILL_CATALOG_MAX_K = 30;

const FIELD_WEIGHTS = Object.freeze({
  name: 10,
  tags: 8,
  toolNames: 6,
  description: 3,
  toolDescriptions: 2,
  inputTypes: 2
});

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "for",
  "from",
  "help",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "the",
  "this",
  "to",
  "use",
  "using",
  "with"
]);

function normalizeSkillCatalogTopK(value) {
  if (value == null) {
    return DEFAULT_SKILL_CATALOG_TOP_K;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error("skillCatalogTopK must be a non-negative integer when provided.");
  }

  return value;
}

function normalizeSkillCatalogMaxK(value) {
  if (value == null) {
    return DEFAULT_SKILL_CATALOG_MAX_K;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("skillCatalogMaxK must be a positive integer when provided.");
  }

  return value;
}

function normalizeSkillCatalogRanker(value) {
  return typeof value === "function" ? value : null;
}

function rankSkillManifests(options = {}) {
  const manifests = normalizeSkillManifests(options.manifests);
  const topK = clampTopK(options.topK, options.maxK);
  const queryTokens = tokenizeSkillCatalogText(options.prompt);
  const totalSkillCount = manifests.length;

  if (topK === 0 || manifests.length === 0 || queryTokens.length === 0) {
    return createRankingResult([], {
      matches: [],
      topK,
      totalSkillCount
    });
  }

  const ranked = manifests
    .map((manifest, index) => ({
      index,
      manifest,
      ...scoreSkillManifest(queryTokens, manifest)
    }))
    .sort((left, right) => (
      right.score - left.score ||
      left.manifest.name.localeCompare(right.manifest.name) ||
      left.index - right.index
    ));
  const eligible = manifests.length <= topK
    ? ranked
    : ranked.filter((entry) => entry.score > 0);

  const selected = eligible.slice(0, topK);

  return createRankingResult(selected.map((entry) => entry.manifest), {
    matches: selected.map((entry) => ({
      matchedFields: entry.matchedFields,
      name: entry.manifest.name,
      score: entry.score,
      skillId: entry.manifest.skillId
    })),
    topK,
    totalSkillCount
  });
}

async function selectSkillCatalogCandidates(options = {}) {
  const manifests = normalizeSkillManifests(options.manifests);
  const topK = clampTopK(options.topK, options.maxK);
  const ranker = typeof options.ranker === "function" ? options.ranker : null;

  if (ranker) {
    const ranked = await ranker({
      manifests,
      maxK: normalizeSkillCatalogMaxK(options.maxK),
      prompt: readString$3(options.prompt),
      topK
    });
    return normalizeCustomRankerResult(ranked, {
      topK,
      totalSkillCount: manifests.length
    });
  }

  return rankSkillManifests({
    manifests,
    maxK: options.maxK,
    prompt: options.prompt,
    topK: options.topK
  });
}

function scoreSkillManifest(queryTokens, manifest) {
  const query = Array.isArray(queryTokens) ? queryTokens : tokenizeSkillCatalogText(queryTokens);
  const fields = createManifestTokenFields(manifest);
  let score = 0;
  const matchedFields = [];

  for (const [field, tokens] of Object.entries(fields)) {
    const overlap = countOverlap(query, tokens);
    if (overlap <= 0) continue;
    matchedFields.push(field);
    score += overlap * (FIELD_WEIGHTS[field] || 1);
  }

  return {
    matchedFields,
    score
  };
}

function tokenizeSkillCatalogText(value) {
  const text = readString$3(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  if (!text) return [];

  return Array.from(new Set(
    text
      .split(/[^a-z0-9_+-]+/i)
      .flatMap(splitCompoundToken)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
  ));
}

function normalizeCustomRankerResult(value, defaults) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { manifests: value };
  const selectedSource = Array.isArray(source.manifests)
    ? source.manifests
    : Array.isArray(source.skills)
      ? source.skills
      : Array.isArray(source.candidates)
        ? source.candidates
        : [];
  const selected = normalizeSkillManifests(selectedSource)
    .slice(0, defaults.topK);
  const matches = Array.isArray(source.matches)
    ? source.matches
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          matchedFields: Array.isArray(item.matchedFields) ? item.matchedFields.filter((field) => typeof field === "string") : [],
          name: readString$3(item.name),
          score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0,
          skillId: readString$3(item.skillId)
        }))
    : selected.map((manifest) => ({
        matchedFields: ["custom"],
        name: manifest.name,
        score: 1,
        skillId: manifest.skillId
      }));

  return createRankingResult(selected, {
    matches,
    topK: defaults.topK,
    totalSkillCount: defaults.totalSkillCount
  });
}

function createRankingResult(selected, options) {
  const skills = (Array.isArray(selected) ? selected : [])
    .map(createAgentSkillSummary)
    .filter(Boolean);
  const totalSkillCount = typeof options.totalSkillCount === "number" ? options.totalSkillCount : 0;
  const topK = typeof options.topK === "number" ? options.topK : DEFAULT_SKILL_CATALOG_TOP_K;
  const matches = Array.isArray(options.matches) ? options.matches : [];

  return {
    debug: {
      filteredCount: Math.max(0, totalSkillCount - skills.length),
      matches,
      selectedSkillCount: skills.length,
      topK,
      totalSkillCount
    },
    skills
  };
}

function createManifestTokenFields(manifest) {
  const tools = Array.isArray(manifest && manifest.tools) ? manifest.tools : [];

  return {
    name: tokenizeSkillCatalogText(manifest && manifest.name),
    tags: tokenizeSkillCatalogText((Array.isArray(manifest && manifest.tags) ? manifest.tags : []).join(" ")),
    toolNames: tokenizeSkillCatalogText(tools.map((tool) => readString$3(tool && tool.name)).join(" ")),
    description: tokenizeSkillCatalogText(manifest && manifest.description),
    toolDescriptions: tokenizeSkillCatalogText(tools.map((tool) => readString$3(tool && tool.description)).join(" ")),
    inputTypes: tokenizeSkillCatalogText((Array.isArray(manifest && manifest.inputTypes) ? manifest.inputTypes : []).join(" "))
  };
}

function clampTopK(topKValue, maxKValue) {
  const topK = normalizeSkillCatalogTopK(topKValue);
  const maxK = normalizeSkillCatalogMaxK(maxKValue);
  return Math.min(topK, maxK);
}

function countOverlap(queryTokens, targetTokens) {
  const target = new Set(Array.isArray(targetTokens) ? targetTokens : []);
  return (Array.isArray(queryTokens) ? queryTokens : [])
    .filter((token) => target.has(token))
    .length;
}

function splitCompoundToken(token) {
  if (!token) return [];
  return token.split(/[_+-]+/).filter(Boolean).concat(token);
}

function readString$3(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { DEFAULT_SKILL_CATALOG_MAX_K, DEFAULT_SKILL_CATALOG_TOP_K, normalizeSkillCatalogMaxK, normalizeSkillCatalogRanker, normalizeSkillCatalogTopK, rankSkillManifests, scoreSkillManifest, selectSkillCatalogCandidates, tokenizeSkillCatalogText };
