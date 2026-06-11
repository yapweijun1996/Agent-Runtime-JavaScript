import { createAgentSkillSummary, normalizeAgentSkill, normalizeSkillManifest, normalizeSkillManifests } from './agent-skills.js';
import { extractSkillCapabilities } from './skill-capabilities.js';

/**
 * Parse a SKILL.md string (YAML frontmatter + markdown body) into a
 * normalized agent skill object ready for createRuntime({ agentSkills }).
 *
 * Accepts the same frontmatter convention as ROLE.md:
 *   ---
 *   name: my-skill
 *   description: One-line description
 *   ---
 *   # Instructions body...
 *
 * Returns null if the result fails validation (missing name or instructions).
 */
function parseSkillMarkdown(text) {
  const raw = typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";

  if (!raw.startsWith("---\n")) {
    return normalizeAgentSkill({
      instructions: raw.trim(),
      name: "custom"
    });
  }

  const endIndex = raw.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return normalizeAgentSkill({
      instructions: raw.trim(),
      name: "custom"
    });
  }

  const frontmatter = raw.slice(4, endIndex).split("\n");
  const fields = {};

  for (const line of frontmatter) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      continue;
    }

    fields[key] = stripQuotes(value);
  }

  return normalizeAgentSkill({
    capabilities: extractSkillCapabilities(fields),
    description: fields.description || "",
    inputTypes: parseListField(fields.inputTypes || fields.input_types || ""),
    instructions: raw.slice(endIndex + 5).trim(),
    name: fields.name || "custom",
    tags: parseListField(fields.tags || "")
  });
}

/**
 * Load agent skills from a JSON manifest URL.
 *
 * Manifest format (paths resolved relative to manifest location):
 *
 *   {
 *     "skills": [
 *       "skills/module-a/SKILL.md",
 *       { "skill": "skills/module-b/SKILL.md", "tools": "skills/module-b/tools.mjs" }
 *     ]
 *   }
 *
 * Returns an array of normalized skill objects. Skills that fail to
 * fetch or parse are skipped with a console.warn — the loader never throws.
 */
async function loadAgentSkills(manifestUrl) {
  let manifest;
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      console.warn(`[agrun] Failed to fetch skill manifest: ${response.status} ${manifestUrl}`);
      return [];
    }
    manifest = await response.json();
  } catch (error) {
    console.warn(`[agrun] Failed to load skill manifest: ${manifestUrl}`, error);
    return [];
  }

  const entries = Array.isArray(manifest && manifest.skills) ? manifest.skills : [];
  if (entries.length === 0) {
    return [];
  }

  const baseUrl = resolveBaseUrl(manifestUrl);
  const results = await Promise.all(entries.map((entry) => loadSingleSkill(baseUrl, entry)));

  return results.filter(Boolean);
}

/**
 * Load a manifest-first SkillIndexProvider from a static skill catalog.
 *
 * Unlike loadAgentSkills(), this fetches only the manifest at setup time.
 * Full SKILL.md documents and optional tools modules are loaded lazily by
 * provider.loadSkill(skillIdOrName).
 */
async function loadSkillIndexProvider(manifestUrl) {
  let entries = await fetchSkillIndexEntries(manifestUrl);
  let records = normalizeSkillIndexEntries(entries);
  const baseUrl = resolveBaseUrl(manifestUrl);
  const cache = new Map();

  return Object.freeze({
    getManifest(skillIdOrName) {
      const record = findSkillIndexRecord(records, skillIdOrName);
      return record ? createAgentSkillSummary(record.manifest) : null;
    },

    listManifests() {
      return records.map((record) => createAgentSkillSummary(record.manifest)).filter(Boolean);
    },

    async loadSkill(skillIdOrName) {
      const record = findSkillIndexRecord(records, skillIdOrName);
      if (!record) {
        return null;
      }

      const cacheKey = createSkillCacheKey(record);
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
      }

      const skill = await loadSingleSkillFromRecord(baseUrl, record);
      if (skill) {
        cache.set(cacheKey, skill);
      }
      return skill;
    },

    async refreshManifests() {
      entries = await fetchSkillIndexEntries(manifestUrl);
      records = normalizeSkillIndexEntries(entries);
      return records.map((record) => createAgentSkillSummary(record.manifest)).filter(Boolean);
    }
  });
}

async function loadSingleSkill(baseUrl, entry) {
  const skillPath = typeof entry === "string" ? entry : (entry && entry.skill) || "";
  const toolsPath = typeof entry === "object" && entry ? (entry.tools || "") : "";

  if (!skillPath) {
    return null;
  }

  const skillUrl = new URL(skillPath, baseUrl).href;
  let skillText;

  try {
    const response = await fetch(skillUrl);
    if (!response.ok) {
      console.warn(`[agrun] Failed to fetch skill: ${response.status} ${skillUrl}`);
      return null;
    }
    skillText = await response.text();
  } catch (error) {
    console.warn(`[agrun] Failed to fetch skill: ${skillUrl}`, error);
    return null;
  }

  const skill = parseSkillMarkdown(skillText);
  if (!skill) {
    console.warn(`[agrun] Failed to parse skill: ${skillUrl}`);
    return null;
  }

  skill.sourcePath = skillPath;

  if (toolsPath) {
    const tools = await loadSkillTools(baseUrl, toolsPath);
    if (tools.length > 0) {
      skill.tools = tools;
    }
  }

  return skill;
}

async function fetchSkillIndexEntries(manifestUrl) {
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      console.warn(`[agrun] Failed to fetch skill index manifest: ${response.status} ${manifestUrl}`);
      return [];
    }
    const manifest = await response.json();
    return Array.isArray(manifest && manifest.skills) ? manifest.skills : [];
  } catch (error) {
    console.warn(`[agrun] Failed to load skill index manifest: ${manifestUrl}`, error);
    return [];
  }
}

function normalizeSkillIndexEntries(entries) {
  const records = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const sourcePath = readEntryPath(entry);
    const toolsPath = readEntryToolsPath(entry);
    const manifest = normalizeSkillManifest({
      ...(entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}),
      sourcePath
    });

    if (!manifest || !sourcePath) {
      continue;
    }

    records.push({
      manifest,
      sourcePath,
      toolsPath
    });
  }

  const manifests = normalizeSkillManifests(records.map((record) => record.manifest));
  const byId = new Map(records.map((record) => [record.manifest.skillId, record]));
  return manifests.map((manifest) => {
    const record = byId.get(manifest.skillId);
    return {
      ...record,
      manifest
    };
  });
}

async function loadSingleSkillFromRecord(baseUrl, record) {
  const skillUrl = new URL(record.sourcePath, baseUrl).href;
  let skillText;

  try {
    const response = await fetch(skillUrl);
    if (!response.ok) {
      console.warn(`[agrun] Failed to fetch skill: ${response.status} ${skillUrl}`);
      return null;
    }
    skillText = await response.text();
  } catch (error) {
    console.warn(`[agrun] Failed to fetch skill: ${skillUrl}`, error);
    return null;
  }

  const parsedSkill = parseSkillMarkdown(skillText);
  if (!parsedSkill) {
    console.warn(`[agrun] Failed to parse skill: ${skillUrl}`);
    return null;
  }

  const mergedSkill = {
    ...parsedSkill,
    availability: record.manifest.availability,
    category: record.manifest.category,
    checksum: record.manifest.checksum,
    description: record.manifest.description || parsedSkill.description,
    inputTypes: record.manifest.inputTypes,
    name: record.manifest.name || parsedSkill.name,
    namespace: record.manifest.namespace,
    requires: record.manifest.requires,
    riskTier: record.manifest.riskTier,
    skillId: record.manifest.skillId,
    sourcePath: record.manifest.sourcePath,
    tags: record.manifest.tags,
    version: record.manifest.version
  };

  if (record.toolsPath) {
    const tools = await loadSkillTools(baseUrl, record.toolsPath);
    if (tools.length > 0) {
      mergedSkill.tools = tools;
    }
  }

  return normalizeAgentSkill(mergedSkill);
}

function findSkillIndexRecord(records, skillIdOrName) {
  const target = readString$1(skillIdOrName).toLowerCase();
  if (!target) return null;
  return records.find((record) => {
    return record.manifest.skillId.toLowerCase() === target ||
      record.manifest.name.toLowerCase() === target;
  }) || null;
}

function createSkillCacheKey(record) {
  return [
    record.manifest.skillId,
    record.manifest.version,
    record.manifest.checksum,
    record.sourcePath,
    record.toolsPath
  ].map(readString$1).join("|");
}

function readEntryPath(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }
  return readString$1(entry.sourcePath) || readString$1(entry.skill);
}

function readEntryToolsPath(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }
  return readString$1(entry.toolsPath) || readString$1(entry.tools);
}

async function loadSkillTools(baseUrl, toolsPath) {
  const toolsUrl = new URL(toolsPath, baseUrl).href;

  try {
    const module = await import(/* @vite-ignore */ toolsUrl);
    const tools = module.default || module;

    if (Array.isArray(tools)) {
      return tools;
    }
  } catch (error) {
    console.warn(`[agrun] Failed to load skill tools: ${toolsUrl}`, error);
  }

  return [];
}

function resolveBaseUrl(manifestUrl) {
  try {
    return new URL(manifestUrl, window.location.href).href;
  } catch {
    return manifestUrl;
  }
}

function stripQuotes(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function parseListField(value) {
  return String(value || "")
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function readString$1(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { loadAgentSkills, loadSkillIndexProvider, parseSkillMarkdown };
