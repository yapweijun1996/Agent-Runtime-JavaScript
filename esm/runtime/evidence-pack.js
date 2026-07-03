import { isDirectEvidenceUrl, isConcreteArticleSource } from './final-response-sources.js';
import { readFinalSourcePrompt } from './final-source-prompt.js';
import { isExternalSourceCoveragePrompt } from './external-source-intent.js';
import { extractResearchCoverageTargets } from './research-coverage-guard.js';
import { readString } from './semantic-json.js';

/**
 * Single source of truth for finalize-time evidence aggregation.
 *
 * Both citation-source-coverage.js (pre-finalize veto) and
 * final-response-quality.js (finalize-time enforcement) consume the
 * same EvidencePack so that "what counts as a usable source" is
 * defined in exactly one place.
 *
 * Schema (see agrun_docs/evidence-graph-memory-architecture.md):
 *
 *   EvidencePackSource = {
 *     url: string,            // canonical direct-evidence URL
 *     title: string,
 *     domain: string,
 *     snippet: string,
 *     query: string           // search query that surfaced this source, if any
 *   }
 *
 *   EvidencePack = {
 *     prompt: string,
 *     targets: ResearchCoverageTarget[],
 *     sources: EvidencePackSource[],
 *     coveredTargets: ResearchCoverageTarget[],
 *     missingTargets: ResearchCoverageTarget[],
 *     requireConcreteArticle: boolean
 *   }
 *
 * Confidence/freshness fields described in the doc are not yet emitted
 * by the runtime; downstream consumers should treat absence as "unknown"
 * and not fabricate values.
 */

function buildEvidencePack(runState, options = {}) {
  const prompt = typeof options.prompt === "string" ? options.prompt : readPrompt$4(runState);
  const requiresExternalSources = isExternalSourceCoveragePrompt(prompt);
  const targets = requiresExternalSources ? extractResearchCoverageTargets(prompt) : [];
  const requireConcreteArticle = options.requireConcreteArticle === true
    || (options.requireConcreteArticle !== false && requiresExternalSources);
  const sources = collectEvidencePackSources(runState && runState.researchContext, {
    requireConcreteArticle
  });

  const coveredTargets = targets.filter((target) => (
    sources.some((source) => sourceCoversTarget(source, target))
  ));
  const coveredKeys = new Set(coveredTargets.map((target) => target.key));
  const missingTargets = targets.filter((target) => !coveredKeys.has(target.key));

  return {
    prompt,
    targets,
    sources,
    coveredTargets,
    missingTargets,
    requireConcreteArticle
  };
}

function collectEvidencePackSources(researchContext, options = {}) {
  const context = researchContext && typeof researchContext === "object" ? researchContext : {};
  const requireConcreteArticle = options && options.requireConcreteArticle === true;
  const sources = [];
  const seen = new Set();
  const pushSource = (item, fallback = {}) => {
    if (!item || typeof item !== "object") return;
    const url = readString(item.url);
    if (!url || !isDirectEvidenceUrl(url) || seen.has(url)) return;
    const source = {
      domain: readString(item.domain) || readDomain$2(url),
      query: readString(item.query) || readString(fallback.query),
      snippet: readString(item.snippet) || readString(item.content) || readString(fallback.snippet),
      title: readString(item.title) || readString(fallback.title) || url,
      url
    };
    if (requireConcreteArticle && !isConcreteArticleSource(source)) return;
    seen.add(url);
    sources.push(source);
  };

  for (const item of readArray$2(context.readSources)) pushSource(item);
  for (const item of readArray$2(context.aggregatedSearchResults)) pushSource(item);
  for (const item of readArray$2(context.searchResults)) pushSource(item);
  for (const pass of readArray$2(context.searchPasses)) {
    const query = readString(pass && pass.query);
    for (const item of readArray$2(pass && pass.items)) {
      pushSource(item, { query });
    }
  }

  return sources;
}

function sourceCoversTarget(source, target) {
  const aliases = Array.isArray(target && target.aliases) ? target.aliases : [target && target.label];
  const haystack = [
    source && source.title,
    source && source.snippet,
    source && source.url,
    source && source.domain
  ].map(readString).join(" ");
  return aliases.some((alias) => hasComparablePhrase(haystack, alias));
}

function hasComparablePhrase(text, phrase) {
  const haystack = ` ${normalizeComparableText$1(text)} `;
  const needle = normalizeComparableText$1(phrase);
  return needle ? haystack.includes(` ${needle} `) : false;
}

function readPrompt$4(runState) {
  return readFinalSourcePrompt(runState, null);
}

function readArray$2(value) {
  return Array.isArray(value) ? value : [];
}

function readDomain$2(url) {
  try {
    return new URL(readString(url)).hostname.replace(/^www\./i, "");
  } catch (error) {
    return "";
  }
}

function normalizeComparableText$1(value) {
  return readString(value)
    .toLowerCase()
    .replace(/\bu\.s\.a\.\b/g, "usa")
    .replace(/\bu\.s\.\b/g, "us")
    .replace(/\bu\.k\.\b/g, "uk")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { buildEvidencePack, collectEvidencePackSources, sourceCoversTarget };
