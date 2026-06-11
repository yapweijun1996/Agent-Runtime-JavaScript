// ADR-0013: pure helpers for list_agent_skills query matching.
// Extracted into its own module so unit tests can import the logic
// without pulling in virtual:agrun-agent-skills.

const LIST_SKILLS_BUDGET_PER_TURN = 5;
const LIST_SKILLS_MAX_RESULTS = 20;

function readListSkillsQuery(args) {
  if (!args || typeof args !== "object") return "";
  const raw = typeof args.query === "string" ? args.query : "";
  return raw.trim();
}

function matchesListSkillsQuery(manifest, queryLower) {
  if (!manifest) return false;
  const queryTerms = expandQueryTerms(queryLower);
  if (queryTerms.length === 0) return true;
  const haystack = buildSkillSearchText(manifest);
  return queryTerms.some((term) => matchesSearchTerm(haystack, term));
}

function applyListSkillsQuery(manifests, args) {
  const query = readListSkillsQuery(args);
  const queryLower = normalizeSearchText(query);
  const matches = queryLower
    ? manifests.filter((m) => matchesListSkillsQuery(m, queryLower))
    : manifests.slice();
  const moreAvailable = matches.length > LIST_SKILLS_MAX_RESULTS;
  const truncated = moreAvailable ? matches.slice(0, LIST_SKILLS_MAX_RESULTS) : matches;
  return { query, matches: truncated, moreAvailable };
}

function buildSkillSearchText(manifest) {
  const tags = Array.isArray(manifest.tags) ? manifest.tags : [];
  const inputTypes = Array.isArray(manifest.inputTypes) ? manifest.inputTypes : [];
  return normalizeSearchText([
    manifest.name,
    manifest.description,
    ...tags,
    ...inputTypes
  ].filter((value) => typeof value === "string").join(" "));
}

function expandQueryTerms(queryLower) {
  const normalized = normalizeSearchText(queryLower);
  if (!normalized) return [];
  const terms = new Set([normalized]);
  for (const entry of QUERY_ALIASES) {
    if (entry.pattern.test(normalized)) {
      for (const term of entry.terms) {
        terms.add(normalizeSearchText(term));
      }
    }
  }
  return [...terms].filter(Boolean);
}

function matchesSearchTerm(haystack, term) {
  if (!term) return true;
  if (haystack.includes(term)) return true;
  const compactHaystack = haystack.replace(/[\s_-]+/g, "");
  const compactTerm = term.replace(/[\s_-]+/g, "");
  return compactTerm.length > 0 && compactHaystack.includes(compactTerm);
}

function normalizeSearchText(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[\s_-]+/g, " ").trim()
    : "";
}

const QUERY_ALIASES = [
  {
    pattern: /(?:\u7814\u7a76|\u8c03\u7814|\u6df1\u5ea6|\u957f\u6587|\u9577\u6587|\u5b57|\u62a5\u544a|\u5831\u544a|\u5206\u6790)/,
    terms: ["research", "deep-research", "deep analysis", "long-form", "report", "evidence", "citations"]
  },
  {
    pattern: /(?:\u6bd4\u8f83|\u6bd4\u8f03|\u5bf9\u6bd4|\u5c0d\u6bd4|\u5e02\u573a|\u5e02\u5834)/,
    terms: ["comparison", "market scan", "analysis", "research"]
  },
  {
    pattern: /(?:\u4ee3\u7801|\u4ee3\u78bc|\u7f16\u7a0b|\u7de8\u7a0b|\u8c03\u8bd5|\u8abf\u8a66)/,
    terms: ["code", "debug", "refactor", "expert"]
  },
  {
    pattern: /(?:\u65f6\u95f4|\u6642\u9593|\u65f6\u533a|\u6642\u5340)/,
    terms: ["time", "timezone"]
  }
];

export { LIST_SKILLS_BUDGET_PER_TURN, LIST_SKILLS_MAX_RESULTS, applyListSkillsQuery, matchesListSkillsQuery, readListSkillsQuery };
