import { readString } from './semantic-json.js';

const SUPPORTED_POLICY_ACTIONS = new Set(["allow", "ask", "deny"]);

function normalizeSkillPolicy(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};

  return Object.freeze({
    availability: normalizeAvailability(source.availability),
    skills: normalizePolicyMap(source.skills),
    tools: normalizePolicyMap(source.tools)
  });
}

function evaluateSkillPolicy(options = {}) {
  const runtimeConfig = options.runtimeConfig && typeof options.runtimeConfig === "object"
    ? options.runtimeConfig
    : {};
  const policy = runtimeConfig.skillPolicy || normalizeSkillPolicy(null);
  const manifest = normalizeSkillPolicyManifest(options.manifest || options.skill || {});
  const skillKey = readString(options.skillId) || readString(manifest && manifest.skillId) || readString(manifest && manifest.name);
  const skillName = readString(options.skillName) || readString(manifest && manifest.name) || skillKey;
  const toolName = readString(options.toolName) || readString(options.tool && options.tool.name);
  const operation = readString(options.operation) || "unknown";

  const explicitToolPolicy = lookupToolPolicy(policy.tools, skillKey, skillName, toolName);
  if (explicitToolPolicy) {
    return createDecision(explicitToolPolicy, "explicit_tool_policy", {
      operation,
      skillId: skillKey,
      skillName,
      toolName
    });
  }

  const explicitSkillPolicy = lookupSkillPolicy(policy.skills, skillKey, skillName);
  if (explicitSkillPolicy) {
    return createDecision(explicitSkillPolicy, "explicit_skill_policy", {
      operation,
      skillId: skillKey,
      skillName,
      toolName
    });
  }

  const availabilityDecision = evaluateAvailability(manifest, policy.availability, {
    operation,
    skillId: skillKey,
    skillName,
    toolName
  });
  if (availabilityDecision) {
    return availabilityDecision;
  }

  const tier = readRiskTier(options.tool) ?? readRiskTier(options.manifest) ?? readRiskTier(options.skill);
  if (tier != null) {
    return createDecision(inferTierPolicy$1(tier), "risk_tier", {
      operation,
      skillId: skillKey,
      skillName,
      tier,
      toolName
    });
  }

  return createDecision("allow", "default_allow", {
    operation,
    skillId: skillKey,
    skillName,
    toolName
  });
}

function filterAvailableSkillManifests(manifests, runtimeConfig, options = {}) {
  const filtered = [];
  const reasons = [];

  for (const manifest of Array.isArray(manifests) ? manifests : []) {
    const decision = evaluateSkillPolicy({
      manifest,
      operation: options.operation || "list",
      runtimeConfig
    });

    if (decision.action === "deny") {
      reasons.push(createReason(decision));
      continue;
    }

    filtered.push(createSkillPolicySummary(manifest));
  }

  return {
    filtered: filtered.filter(Boolean),
    filteredCount: reasons.length,
    reasons
  };
}

async function getPolicyManifestForSkill(context, skillIdOrName) {
  const target = readString(skillIdOrName);
  if (!target) return null;

  const local = findManifest$1(context && context.agentSkills, target);
  if (local) return local;

  const provider = context && context.agentSkillIndexProvider;
  if (provider && typeof provider.getManifest === "function") {
    return normalizeSkillPolicyManifest(await provider.getManifest(target));
  }

  return null;
}

function createSkillPolicyError(decision) {
  const safe = sanitizeDecision(decision);
  const target = safe.toolName
    ? `${safe.skillName || safe.skillId || "unknown"}.${safe.toolName}`
    : safe.skillName || safe.skillId || "unknown";
  const reason = safe.reason || "policy";
  const error = new Error(`Skill policy blocked ${safe.operation || "operation"} for "${target}" (${reason}).`);
  error.code = "SKILL_POLICY_BLOCKED";
  error.skillPolicyDecision = safe;
  return error;
}

function emitSkillPolicyStep(pushStep, type, decision) {
  if (typeof pushStep !== "function") return;
  pushStep(type, sanitizeDecision(decision));
}

function sanitizeDecision(decision) {
  const source = decision && typeof decision === "object" && !Array.isArray(decision)
    ? decision
    : {};
  const safe = {
    action: readPolicy(source.action) || "allow",
    operation: readString(source.operation) || null,
    reason: readString(source.reason) || "default_allow",
    skillId: readString(source.skillId) || null,
    skillName: readString(source.skillName) || null,
    toolName: readString(source.toolName) || null
  };
  if (Number.isInteger(source.tier)) safe.tier = source.tier;
  if (Array.isArray(source.missingFeatures)) safe.missingFeatures = source.missingFeatures.slice();
  if (Array.isArray(source.missingInputTypes)) safe.missingInputTypes = source.missingInputTypes.slice();
  return safe;
}

function normalizePolicyMap(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const result = {};

  for (const [key, policy] of Object.entries(source)) {
    const normalizedKey = readString(key).toLowerCase();
    const normalizedPolicy = readPolicy(policy);
    if (!normalizedKey) continue;
    if (!normalizedPolicy) {
      throw new Error(`Unsupported skill policy "${policy}" for "${key}".`);
    }
    result[normalizedKey] = normalizedPolicy;
  }

  return Object.freeze(result);
}

function normalizeAvailability(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return Object.freeze({
    browser: typeof source.browser === "boolean" ? source.browser : null,
    features: normalizeStringArray$1(source.features),
    inputTypes: normalizeStringArray$1(source.inputTypes),
    network: typeof source.network === "boolean" ? source.network : null
  });
}

function evaluateAvailability(manifest, hostAvailability, detail) {
  if (!manifest) return null;
  const requiredFeatures = normalizeStringArray$1(manifest.requires);
  const manifestAvailability = manifest.availability && typeof manifest.availability === "object" && !Array.isArray(manifest.availability)
    ? manifest.availability
    : {};
  const featureRequirements = Array.from(new Set(requiredFeatures.concat(normalizeStringArray$1(manifestAvailability.features))));
  const hostFeatures = new Set(hostAvailability.features.map((item) => item.toLowerCase()));
  const missingFeatures = featureRequirements.filter((item) => !hostFeatures.has(item.toLowerCase()));
  if (missingFeatures.length > 0) {
    return createDecision("deny", "missing_feature", {
      ...detail,
      missingFeatures
    });
  }

  if (manifestAvailability.browser === true && hostAvailability.browser === false) {
    return createDecision("deny", "browser_unavailable", detail);
  }

  if (manifestAvailability.network === true && hostAvailability.network === false) {
    return createDecision("deny", "network_unavailable", detail);
  }

  const requiredInputTypes = normalizeStringArray$1(manifestAvailability.inputTypes).concat(normalizeStringArray$1(manifest.inputTypes));
  if (requiredInputTypes.length > 0 && hostAvailability.inputTypes.length > 0) {
    const hostInputTypes = new Set(hostAvailability.inputTypes.map((item) => item.toLowerCase()));
    const missingInputTypes = Array.from(new Set(requiredInputTypes))
      .filter((item) => !hostInputTypes.has(item.toLowerCase()));
    if (missingInputTypes.length > 0) {
      return createDecision("deny", "input_type_unavailable", {
        ...detail,
        missingInputTypes
      });
    }
  }

  return null;
}

function lookupToolPolicy(tools, skillId, skillName, toolName) {
  const toolKey = readString(toolName).toLowerCase();
  if (!toolKey) return null;
  for (const skillKey of [skillId, skillName]) {
    const key = readString(skillKey).toLowerCase();
    if (!key) continue;
    const exact = tools[`${key}.${toolKey}`];
    if (exact) return exact;
  }
  return tools[toolKey] || null;
}

function lookupSkillPolicy(skills, skillId, skillName) {
  for (const key of [skillId, skillName]) {
    const normalized = readString(key).toLowerCase();
    if (normalized && skills[normalized]) return skills[normalized];
  }
  return null;
}

function createDecision(action, reason, detail = {}) {
  return {
    action: readPolicy(action) || "allow",
    missingFeatures: Array.isArray(detail.missingFeatures) ? detail.missingFeatures.slice() : undefined,
    missingInputTypes: Array.isArray(detail.missingInputTypes) ? detail.missingInputTypes.slice() : undefined,
    operation: readString(detail.operation) || null,
    reason,
    skillId: readString(detail.skillId) || null,
    skillName: readString(detail.skillName) || null,
    tier: Number.isInteger(detail.tier) ? detail.tier : undefined,
    toolName: readString(detail.toolName) || null
  };
}

function createReason(decision) {
  return sanitizeDecision(decision);
}

function findManifest$1(manifests, skillIdOrName) {
  const target = readString(skillIdOrName).toLowerCase();
  if (!target) return null;

  for (const item of Array.isArray(manifests) ? manifests : []) {
    const manifest = normalizeSkillPolicyManifest(item);
    if (!manifest) continue;
    if (readString(manifest.skillId).toLowerCase() === target || readString(manifest.name).toLowerCase() === target) {
      return manifest;
    }
  }

  return null;
}

function normalizeSkillPolicyManifest(skill) {
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
  const name = readString(skill.name);
  const skillId = readString(skill.skillId) || readString(skill.id) || name;
  if (!name || !skillId) return null;
  return {
    availability: normalizeManifestAvailability(skill.availability),
    checksum: readString(skill.checksum),
    description: readString(skill.description),
    inputTypes: normalizeStringArray$1(skill.inputTypes),
    name,
    requires: normalizeStringArray$1(skill.requires),
    riskTier: readRiskTier(skill),
    skillId,
    sourcePath: readString(skill.sourcePath),
    tags: normalizeStringArray$1(skill.tags),
    tools: normalizeToolSummaries(skill.tools),
    version: readString(skill.version)
  };
}

function createSkillPolicySummary(skill) {
  const manifest = normalizeSkillPolicyManifest(skill);
  if (!manifest) return null;
  return {
    availability: cloneAvailability(manifest.availability),
    checksum: manifest.checksum,
    description: manifest.description,
    inputTypes: manifest.inputTypes.slice(),
    name: manifest.name,
    requires: manifest.requires.slice(),
    riskTier: manifest.riskTier,
    skillId: manifest.skillId,
    sourcePath: manifest.sourcePath,
    tags: manifest.tags.slice(),
    tools: manifest.tools.map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: cloneParameters(tool.parameters),
      riskTier: tool.riskTier
    })),
    version: manifest.version
  };
}

function normalizeToolSummaries(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
      const name = readString(tool.name);
      const description = readString(tool.description);
      if (!name || !description) return null;
      return {
        description,
        name,
        parameters: normalizeParameters$1(tool.parameters),
        riskTier: readRiskTier(tool)
      };
    })
    .filter(Boolean);
}

function normalizeParameters$1(parameters) {
  const source = parameters && typeof parameters === "object" && !Array.isArray(parameters)
    ? parameters
    : {};
  const properties = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
    ? source.properties
    : {};
  return {
    properties: { ...properties },
    required: Array.isArray(source.required)
      ? source.required.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
      : [],
    type: readString(source.type) || "object"
  };
}

function cloneParameters(parameters) {
  const source = normalizeParameters$1(parameters);
  return {
    properties: { ...source.properties },
    required: source.required.slice(),
    type: source.type
  };
}

function normalizeManifestAvailability(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const availability = {};
  if (typeof source.browser === "boolean") availability.browser = source.browser;
  if (typeof source.network === "boolean") availability.network = source.network;
  const features = normalizeStringArray$1(source.features);
  if (features.length > 0) availability.features = features;
  const inputTypes = normalizeStringArray$1(source.inputTypes);
  if (inputTypes.length > 0) availability.inputTypes = inputTypes;
  return availability;
}

function cloneAvailability(value) {
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

function inferTierPolicy$1(tier) {
  if (tier === 1 || tier === 2) return "ask";
  if (tier === 3) return "deny";
  return "allow";
}

function readRiskTier(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Number.isInteger(value.riskTier) && value.riskTier >= 0 && value.riskTier <= 3
    ? value.riskTier
    : null;
}

function readPolicy(value) {
  const policy = readString(value);
  return SUPPORTED_POLICY_ACTIONS.has(policy) ? policy : null;
}

function normalizeStringArray$1(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

export { createSkillPolicyError, emitSkillPolicyStep, evaluateSkillPolicy, filterAvailableSkillManifests, getPolicyManifestForSkill, normalizeSkillPolicy, sanitizeDecision };
