import { copySchemaEnum } from './tool-schema.js';

// AGRUN-313 Phase 1 — the concrete bundled-skill data (`bundledAgentSkills`,
// `getBundledAgentSkill`) moved to ./default-agent-skills.js so this file holds
// only the generic skill MECHANISM and carries no domain vocabulary.

function normalizeAgentSkills(skills) {
  if (!Array.isArray(skills)) {
    return [];
  }

  return skills
    .map(normalizeAgentSkill)
    .filter(Boolean);
}

function normalizeAgentSkill(skill) {
  if (!skill || typeof skill !== "object") {
    return null;
  }

  const skillId = readString$1Q(skill.skillId) || readString$1Q(skill.id) || readString$1Q(skill.name);
  const name = readString$1Q(skill.name);
  const instructions = readString$1Q(skill.instructions);

  if (!name || !instructions) {
    return null;
  }

  return {
    availability: normalizeAvailability$1(skill.availability),
    capabilities: normalizeCapabilities(skill.capabilities),
    category: readString$1Q(skill.category),
    checksum: readString$1Q(skill.checksum),
    description: readString$1Q(skill.description),
    instructions,
    inputTypes: normalizeStringArray$2(skill.inputTypes),
    name,
    namespace: readString$1Q(skill.namespace),
    requires: normalizeStringArray$2(skill.requires),
    riskTier: normalizeRiskTier(skill.riskTier),
    skillId,
    sourcePath: readString$1Q(skill.sourcePath),
    tags: normalizeStringArray$2(skill.tags),
    tools: normalizeAgentTools(skill.tools),
    version: readString$1Q(skill.version)
  };
}

function findAgentSkill(skills, name) {
  const target = readString$1Q(name).toLowerCase();

  if (!target) {
    return null;
  }

  return normalizeAgentSkills(skills).find((skill) => {
    return skill.name.toLowerCase() === target || skill.skillId.toLowerCase() === target;
  }) || null;
}

function normalizeSkillManifest(skill) {
  if (!skill || typeof skill !== "object") {
    return null;
  }

  const name = readString$1Q(skill.name);
  const skillId = readString$1Q(skill.skillId) || readString$1Q(skill.id) || name;

  if (!name || !skillId) {
    return null;
  }

  return {
    availability: normalizeAvailability$1(skill.availability),
    capabilities: normalizeCapabilities(skill.capabilities),
    category: readString$1Q(skill.category),
    checksum: readString$1Q(skill.checksum),
    description: readString$1Q(skill.description),
    inputTypes: normalizeStringArray$2(skill.inputTypes),
    name,
    namespace: readString$1Q(skill.namespace),
    requires: normalizeStringArray$2(skill.requires),
    riskTier: normalizeRiskTier(skill.riskTier),
    skillId,
    sourcePath: readString$1Q(skill.sourcePath),
    tags: normalizeStringArray$2(skill.tags),
    tools: normalizeAgentToolSummaries(skill.tools),
    version: readString$1Q(skill.version)
  };
}

function createAgentSkillSummary(skill) {
  const resolved = normalizeSkillManifest(skill);

  if (!resolved) {
    return null;
  }

  return {
    availability: cloneAvailability$1(resolved.availability),
    capabilities: cloneCapabilities(resolved.capabilities),
    category: resolved.category,
    checksum: resolved.checksum,
    description: resolved.description,
    inputTypes: resolved.inputTypes.slice(),
    name: resolved.name,
    namespace: resolved.namespace,
    requires: resolved.requires.slice(),
    riskTier: resolved.riskTier,
    skillId: resolved.skillId,
    sourcePath: resolved.sourcePath,
    tags: resolved.tags.slice(),
    tools: resolved.tools.map(createAgentSkillToolSummary).filter(Boolean),
    version: resolved.version
  };
}

function createAgentSkillToolSummary(tool) {
  const resolved = normalizeAgentToolSummary(tool);

  if (!resolved) {
    return null;
  }

  return {
    description: resolved.description,
    name: resolved.name,
    parameters: cloneToolParameters(resolved.parameters),
    riskTier: resolved.riskTier
  };
}

function buildActiveAgentSkillSystemPrompt(skill) {
  const resolved = normalizeAgentSkill(skill);

  if (!resolved) {
    return "";
  }

  return [
    "An agent skill has been activated for this turn.",
    `Skill name: ${resolved.name}`,
    resolved.description ? `Skill description: ${resolved.description}` : "",
    resolved.tools.length > 0
      ? `Bundled tools: ${resolved.tools.map((tool) => tool.name).join(", ")}`
      : "",
    "Follow the skill instructions below when producing the answer.",
    "",
    resolved.instructions
  ].filter(Boolean).join("\n");
}

function findAgentSkillTool(skill, toolName) {
  const resolvedSkill = normalizeAgentSkill(skill);
  const target = readString$1Q(toolName).toLowerCase();

  if (!resolvedSkill || !target) {
    return null;
  }

  return resolvedSkill.tools.find((tool) => tool.name.toLowerCase() === target) || null;
}

function createInMemorySkillIndexProvider(skills) {
  const normalizedSkills = normalizeAgentSkills(skills);
  assertUniqueSkillIds(normalizedSkills);
  const manifests = normalizedSkills.map(normalizeSkillManifest).filter(Boolean);

  return Object.freeze({
    getManifest(skillIdOrName) {
      const target = readString$1Q(skillIdOrName).toLowerCase();
      if (!target) return null;
      const manifest = manifests.find((item) => matchesSkillKey(item, target));
      return manifest ? createAgentSkillSummary(manifest) : null;
    },

    listManifests() {
      return manifests.map(createAgentSkillSummary).filter(Boolean);
    },

    loadSkill(skillIdOrName) {
      const target = readString$1Q(skillIdOrName).toLowerCase();
      if (!target) return null;
      return normalizedSkills.find((skill) => matchesSkillKey(skill, target)) || null;
    }
  });
}

function normalizeSkillIndexProvider(provider, defaultSkills) {
  if (provider == null) {
    return createInMemorySkillIndexProvider(defaultSkills);
  }

  if (!provider || typeof provider !== "object") {
    throw new Error("agentSkillIndexProvider must be an object when provided.");
  }

  if (typeof provider.listManifests !== "function" ||
      typeof provider.getManifest !== "function" ||
      typeof provider.loadSkill !== "function") {
    throw new Error("agentSkillIndexProvider must define listManifests(), getManifest(), and loadSkill().");
  }

  return Object.freeze({
    getManifest(skillIdOrName) {
      return normalizeMaybeAsync(provider.getManifest(skillIdOrName), normalizeSkillManifest);
    },

    listManifests() {
      return normalizeMaybeAsync(provider.listManifests(), normalizeSkillManifests);
    },

    loadSkill(skillIdOrName) {
      return normalizeMaybeAsync(provider.loadSkill(skillIdOrName), normalizeAgentSkill);
    }
  });
}

function normalizeSkillManifests(manifests) {
  if (!Array.isArray(manifests)) {
    return [];
  }

  const normalized = manifests
    .map(normalizeSkillManifest)
    .filter(Boolean);
  assertUniqueSkillIds(normalized);
  return normalized;
}

async function listSkillManifests(provider) {
  if (!provider || typeof provider.listManifests !== "function") {
    return [];
  }
  const manifests = await provider.listManifests();
  return normalizeSkillManifests(manifests);
}

async function loadAgentSkillFromProvider(provider, skillIdOrName) {
  if (!provider || typeof provider.loadSkill !== "function") {
    return null;
  }
  return normalizeAgentSkill(await provider.loadSkill(skillIdOrName));
}

function normalizeAgentTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map(normalizeAgentTool)
    .filter(Boolean);
}

function normalizeAgentTool(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const name = readString$1Q(tool.name);
  const description = readString$1Q(tool.description);
  const func = typeof tool.func === "function" ? tool.func : null;

  if (!name || !description || !func) {
    return null;
  }

  return {
    description,
    func,
    name,
    parameters: normalizeToolParameters(tool.parameters),
    riskTier: normalizeRiskTier(tool.riskTier)
  };
}

function normalizeAgentToolSummaries(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map(normalizeAgentToolSummary)
    .filter(Boolean);
}

function normalizeAgentToolSummary(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const name = readString$1Q(tool.name);
  const description = readString$1Q(tool.description);

  if (!name || !description) {
    return null;
  }

  const summary = {
    description,
    name,
    parameters: normalizeToolParameters(tool.parameters)
  };

  if (readString$1Q(tool.resultKind)) {
    summary.resultKind = readString$1Q(tool.resultKind);
  }
  if (normalizeRiskTier(tool.riskTier) != null) {
    summary.riskTier = normalizeRiskTier(tool.riskTier);
  }

  return summary;
}

function normalizeToolParameters(parameters) {
  const source = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? parameters
    : {};
  const sourceProperties = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
    ? source.properties
    : {};
  const properties = {};

  for (const [key, value] of Object.entries(sourceProperties)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const prop = {
      description: readString$1Q(value.description),
      type: readString$1Q(value.type)
    };
    copySchemaEnum(prop, value);
    copySchemaAliases(prop, value);

    // Preserve one level of nested object properties so the planner can see
    // sub-keys (e.g. filters.party_desc) when building argument hints.
    if (prop.type === "object" && value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
      const nested = {};
      for (const [nk, nv] of Object.entries(value.properties)) {
        if (nv && typeof nv === "object" && !Array.isArray(nv)) {
          const nestedProp = copySchemaEnum({
            description: readString$1Q(nv.description),
            type: readString$1Q(nv.type)
          }, nv);
          copySchemaAliases(nestedProp, nv);
          nested[nk] = nestedProp;
        }
      }
      if (Object.keys(nested).length > 0) {
        prop.properties = nested;
      }
    }

    properties[key] = prop;
  }

  return {
    properties,
    required: Array.isArray(source.required)
      ? source.required.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
      : [],
    type: readString$1Q(source.type) || "object"
  };
}

function cloneToolParameters(parameters) {
  return {
    properties: Object.fromEntries(
      Object.entries(parameters.properties).map(([key, value]) => {
        const prop = {
          description: value.description,
          type: value.type
        };
        copySchemaEnum(prop, value);
        copySchemaAliases(prop, value);
        if (value.properties && typeof value.properties === "object") {
          prop.properties = Object.fromEntries(
            Object.entries(value.properties).map(([nk, nv]) => {
              const nested = copySchemaEnum({ description: nv.description, type: nv.type }, nv);
              copySchemaAliases(nested, nv);
              return [nk, nested];
            })
          );
        }
        return [key, prop];
      })
    ),
    required: parameters.required.slice(),
    type: parameters.type
  };
}

function copySchemaAliases(target, source) {
  // Preserve optional `aliases: string[]` declared on a property so the
  // runtime validator (validateToolArgs / validateActionArgs) can absorb
  // planner camelCase↔snake_case drift. Opt-in per property — callers
  // without aliases see byte-for-byte identical behaviour to pre-feature.
  if (!source || typeof source !== "object") return target;
  if (!Array.isArray(source.aliases) || source.aliases.length === 0) return target;
  const aliases = source.aliases.filter((value) => typeof value === "string" && value.trim());
  if (aliases.length > 0) {
    target.aliases = aliases.slice();
  }
  return target;
}

function readString$1Q(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRiskTier(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

function normalizeAvailability$1(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const availability = {};
  if (typeof source.browser === "boolean") availability.browser = source.browser;
  if (typeof source.network === "boolean") availability.network = source.network;
  const features = normalizeStringArray$2(source.features);
  if (features.length > 0) availability.features = features;
  const inputTypes = normalizeStringArray$2(source.inputTypes);
  if (inputTypes.length > 0) availability.inputTypes = inputTypes;
  return availability;
}

function normalizeCapabilities(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const capabilities = {};
  for (const [key, entry] of Object.entries(source)) {
    const name = readString$1Q(key);
    if (!name) continue;
    if (
      typeof entry === "boolean" ||
      typeof entry === "number" ||
      typeof entry === "string"
    ) {
      capabilities[name] = entry;
    }
  }
  return capabilities;
}

function cloneAvailability$1(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const availability = {};
  if (typeof source.browser === "boolean") availability.browser = source.browser;
  if (typeof source.network === "boolean") availability.network = source.network;
  if (Array.isArray(source.features)) availability.features = source.features.slice();
  if (Array.isArray(source.inputTypes)) availability.inputTypes = source.inputTypes.slice();
  return availability;
}

function cloneCapabilities(value) {
  return normalizeCapabilities(value);
}

function normalizeStringArray$2(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function assertUniqueSkillIds(skills) {
  const seen = new Set();

  for (const skill of Array.isArray(skills) ? skills : []) {
    const key = readString$1Q(skill && (skill.skillId || skill.name)).toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      throw new Error(`Duplicate agent skill id "${key}".`);
    }
    seen.add(key);
  }
}

function matchesSkillKey(skill, target) {
  if (!skill || !target) return false;
  return readString$1Q(skill.skillId).toLowerCase() === target ||
    readString$1Q(skill.name).toLowerCase() === target;
}

function normalizeMaybeAsync(value, normalize) {
  if (value && typeof value.then === "function") {
    return value.then((resolved) => normalize(resolved));
  }
  return normalize(value);
}

export { buildActiveAgentSkillSystemPrompt, createAgentSkillSummary, createAgentSkillToolSummary, createInMemorySkillIndexProvider, findAgentSkill, findAgentSkillTool, listSkillManifests, loadAgentSkillFromProvider, normalizeAgentSkill, normalizeAgentSkills, normalizeSkillIndexProvider, normalizeSkillManifest, normalizeSkillManifests };
