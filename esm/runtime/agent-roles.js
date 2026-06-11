// AGRUN-313 (post-3.0) — this is the role MECHANISM only. The concrete bundled role
// DATA (bundledAgentRoles / getBundledAgentRole) moved to default-agent-roles.js and ships
// from @agrun/skills-research, so core's createRuntime graph carries zero domain roles.
// resolveActiveRole resolves names ONLY against the catalog the host passes in.

function normalizeAgentRoles(roles) {
  if (!Array.isArray(roles)) {
    return [];
  }

  return roles
    .map(normalizeAgentRole)
    .filter(Boolean);
}

function normalizeAgentRole(role) {
  if (!role || typeof role !== "object") {
    return null;
  }

  const name = readString$x(role.name);
  const instructions = readString$x(role.instructions);

  if (!name || !instructions) {
    return null;
  }

  return {
    description: readString$x(role.description),
    instructions,
    name,
    priority: readString$x(role.priority) || "actions",
    sourcePath: readString$x(role.sourcePath)
  };
}

function findAgentRole(roles, name) {
  const target = readString$x(name).toLowerCase();

  if (!target) {
    return null;
  }

  return normalizeAgentRoles(roles).find(
    (role) => role.name.toLowerCase() === target
  ) || null;
}

function resolveActiveRole(roleConfig, bundledRoles) {
  if (!roleConfig) {
    return null;
  }

  if (typeof roleConfig === "string") {
    return findAgentRole(bundledRoles, roleConfig) || null;
  }

  if (typeof roleConfig === "object" && !Array.isArray(roleConfig)) {
    return normalizeAgentRole(roleConfig);
  }

  return null;
}

function buildRoleSystemPromptBlock$1(role) {
  const resolved = normalizeAgentRole(role);

  if (!resolved) {
    return "";
  }

  return [
    resolved.instructions
  ].filter(Boolean).join("\n");
}

function parseRoleMarkdown(text) {
  const raw = typeof text === "string" ? text.replace(/\r\n/g, "\n") : "";

  if (!raw.startsWith("---\n")) {
    return normalizeAgentRole({
      instructions: raw.trim(),
      name: "custom"
    });
  }

  const endIndex = raw.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return normalizeAgentRole({
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

    fields[key] = stripQuotes$1(value);
  }

  return normalizeAgentRole({
    description: fields.description || "",
    instructions: raw.slice(endIndex + 5).trim(),
    name: fields.name || "custom",
    priority: fields.priority || "actions"
  });
}

function stripQuotes$1(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function readString$x(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildRoleSystemPromptBlock$1 as buildRoleSystemPromptBlock, findAgentRole, normalizeAgentRole, normalizeAgentRoles, parseRoleMarkdown, resolveActiveRole };
