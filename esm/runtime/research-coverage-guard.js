import { readString } from './semantic-json.js';
import { isNewsLikeSourceCoveragePrompt } from './external-source-intent.js';

const LIST_INTRO_PATTERN = /\b(?:each\s+for|for|across|covering|in)\s+([^.;:\n]{3,220})/gi;
const SEGMENT_STOP_PATTERN = /\s+(?:with|using|use|cite|include|provide|explain|summari[sz]e|keep|show|while|where|that|and\s+keep)\b/i;
const ENTITY_STOPWORDS = new Set([
  "a",
  "an",
  "current",
  "each",
  "evidence",
  "find",
  "generate",
  "important",
  "item",
  "items",
  "latest",
  "link",
  "links",
  "markdown",
  "news",
  "do",
  "paused",
  "report",
  "research",
  "restart",
  "resume",
  "run",
  "source",
  "sources",
  "step",
  "task",
  "today",
  "url",
  "urls"
]);

const ENTITY_ALIASES = new Map([
  ["u.s.", "United States"],
  ["u.s.a.", "United States"],
  ["usa", "United States"],
  ["us", "United States"],
  ["united states", "United States"],
  ["united states of america", "United States"],
  ["uk", "United Kingdom"],
  ["u.k.", "United Kingdom"],
  ["my", "Malaysia"],
  ["malaysia", "Malaysia"],
  ["sg", "Singapore"],
  ["singapore", "Singapore"]
]);

function extractResearchCoverageTargets(prompt) {
  const source = collapseWhitespace$1(prompt);
  if (!source) return [];

  const targets = [];
  const seen = new Set();
  const pushTarget = (raw) => {
    const target = normalizeTarget(raw);
    if (!target || seen.has(target.key)) return;
    seen.add(target.key);
    targets.push(target);
  };

  for (const segment of extractCandidateListSegments(source)) {
    for (const part of splitCandidateList(segment)) {
      pushTarget(part);
    }
  }

  if (targets.length >= 2) return targets;
  if (!isNewsLikeSourceCoveragePrompt(source)) return targets;

  for (const match of source.matchAll(/\b(?:[A-Z]{2,3}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g)) {
    pushTarget(match[0]);
  }

  return targets;
}

function extractCandidateListSegments(prompt) {
  const segments = [];
  for (const match of prompt.matchAll(LIST_INTRO_PATTERN)) {
    const raw = readString(match[1]);
    if (!raw) continue;
    const stopped = raw.split(SEGMENT_STOP_PATTERN)[0] || raw;
    segments.push(stopped);
  }
  return segments;
}

function splitCandidateList(segment) {
  const normalized = segment
    .replace(/\band\b/gi, ",")
    .replace(/[()]/g, " ")
    .split(/[,/&]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return normalized;
}

function normalizeTarget(raw) {
  const cleaned = collapseWhitespace$1(readString(raw)
    .replace(/^the\s+/i, "")
    .replace(/\b(?:for|on|at)\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}).*$/i, "")
    .replace(/\b(?:news|headlines?|report|research|briefing|roundup)\b.*$/i, ""));
  if (!cleaned || cleaned.length > 80) return null;

  const alias = ENTITY_ALIASES.get(cleaned.toLowerCase());
  const label = alias || cleaned;
  const key = normalizeComparableText$3(label);
  if (!key || ENTITY_STOPWORDS.has(key)) return null;
  if (!looksLikeTargetEntity(cleaned, alias)) return null;

  return {
    aliases: createTargetAliases(label, cleaned),
    key,
    label
  };
}

function looksLikeTargetEntity(value, alias) {
  if (alias) return true;
  if (/^[A-Z]{2,3}$/.test(value)) return true;
  if (!/[A-Z]/.test(value[0] || "")) return false;
  return !value
    .toLowerCase()
    .split(/\s+/)
    .every((token) => ENTITY_STOPWORDS.has(token));
}

function createTargetAliases(label, raw) {
  const aliases = new Set([
    label,
    raw,
    normalizeComparableText$3(label),
    normalizeComparableText$3(raw)
  ]);
  for (const [alias, mappedLabel] of ENTITY_ALIASES.entries()) {
    if (normalizeComparableText$3(mappedLabel) === normalizeComparableText$3(label)) {
      aliases.add(alias);
    }
  }
  return Array.from(aliases).map((alias) => readString(alias)).filter(Boolean);
}

function normalizeComparableText$3(value) {
  return readString(value)
    .toLowerCase()
    .replace(/\bu\.s\.a\.\b/g, "usa")
    .replace(/\bu\.s\.\b/g, "us")
    .replace(/\bu\.k\.\b/g, "uk")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collapseWhitespace$1(value) {
  return readString(value).replace(/\s+/g, " ").trim();
}

export { extractResearchCoverageTargets };
