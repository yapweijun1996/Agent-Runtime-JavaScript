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

// AGRUN-623 follow-up: LIST_SKILLS_MAX_RESULTS was an undocumented hard cap
// with no way to reach a 21st+ match beyond the more_available flag. offset
// pages through matches LIST_SKILLS_MAX_RESULTS at a time.
function readListSkillsOffset(args) {
  if (!args || typeof args !== "object") return 0;
  const raw = Number(args.offset);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

function matchesListSkillsQuery(manifest, queryLower) {
  if (!manifest) return false;
  const queryTerms = expandQueryTerms(queryLower);
  if (queryTerms.length === 0) return true;
  const haystack = buildSkillSearchText(manifest);
  if (queryTerms.some((term) => matchesSearchTerm(haystack, term))) return true;
  // AGRUN-623: a multi-word query used to match ONLY as one whole phrase
  // substring, so query "category customer" returned 0 against a skill
  // literally named "globe3-customer" (the Globe3 reproduction, stage 1).
  // Fall back to per-token OR — for discovery, some candidates always beat
  // zero; alias expansion above already uses the same OR semantics.
  const tokens = tokenizeQueryTerms(queryTerms);
  return tokens.length > 1 && tokens.some((token) => matchesSearchTerm(haystack, token));
}

function applyListSkillsQuery(manifests, args) {
  const query = readListSkillsQuery(args);
  const offset = readListSkillsOffset(args);
  const queryLower = normalizeSearchText(query);
  const allMatches = queryLower
    ? manifests.filter((m) => matchesListSkillsQuery(m, queryLower))
    : manifests.slice();
  const page = allMatches.slice(offset, offset + LIST_SKILLS_MAX_RESULTS);
  const moreAvailable = offset + page.length < allMatches.length;
  return {
    query,
    offset,
    matches: page,
    moreAvailable,
    totalMatches: allMatches.length
  };
}

// AGRUN-623: the catalog observation must stay small enough that the planner
// can actually read every skill NAME. Full tool parameter schemas made a
// 20-40 skill catalog blow past the observation budget and truncate after the
// first skill, so the catalog now carries name/description/tags/toolNames
// only — full instructions and tool schemas stay with read_agent_skill.
function createCompactSkillCatalogEntry(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!name) return null;
  const entry = { name };
  const skillId = typeof manifest.skillId === "string" ? manifest.skillId.trim() : "";
  if (skillId && skillId !== name) entry.skillId = skillId;
  const description = typeof manifest.description === "string" ? manifest.description.trim() : "";
  if (description) entry.description = description;
  const tags = Array.isArray(manifest.tags)
    ? manifest.tags.filter((tag) => typeof tag === "string" && tag)
    : [];
  if (tags.length > 0) entry.tags = tags;
  const toolNames = Array.isArray(manifest.tools)
    ? manifest.tools
      .map((tool) => {
        if (typeof tool === "string") return tool;
        return tool && typeof tool === "object" && typeof tool.name === "string" ? tool.name : "";
      })
      .filter(Boolean)
    : [];
  if (toolNames.length > 0) entry.toolNames = toolNames;
  return entry;
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

function tokenizeQueryTerms(queryTerms) {
  const tokens = new Set();
  for (const term of queryTerms) {
    for (const token of term.split(" ")) {
      if (token.length >= 2) tokens.add(token);
    }
  }
  return [...tokens];
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

export { LIST_SKILLS_BUDGET_PER_TURN, LIST_SKILLS_MAX_RESULTS, applyListSkillsQuery, createCompactSkillCatalogEntry, matchesListSkillsQuery, readListSkillsOffset, readListSkillsQuery };
