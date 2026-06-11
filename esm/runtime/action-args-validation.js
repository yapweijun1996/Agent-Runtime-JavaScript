const ALLOWED_TYPES = new Set(["string", "number", "boolean", "object", "array"]);

function validateActionArgs(action, args) {
  const schema = readSchema(action);
  if (!schema) {
    return { ok: true };
  }

  const sourceRecord = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const { record, rewrites } = normalizeAliases(schema, sourceRecord);

  for (const [key, rule] of Object.entries(schema)) {
    const hasValue = Object.prototype.hasOwnProperty.call(record, key)
      && record[key] !== undefined
      && record[key] !== null
      && !(typeof record[key] === "string" && record[key].trim() === "");

    if (rule && rule.required === true && !hasValue) {
      return {
        ok: false,
        error: `Missing required arg "${key}" for ${action.name}.`,
        key,
        reason: "missing"
      };
    }

    if (!hasValue) {
      continue;
    }

    if (rule && typeof rule.type === "string" && ALLOWED_TYPES.has(rule.type)) {
      const actual = readType(record[key]);
      if (actual !== rule.type) {
        return {
          ok: false,
          error: `Arg "${key}" for ${action.name} expected ${rule.type}, received ${actual}.`,
          key,
          reason: "type"
        };
      }
    }
  }

  return { ok: true, normalizedArgs: record, aliasRewrites: rewrites };
}

function assertPlannerActionArgsContract(actions) {
  const actionList = Array.isArray(actions) ? actions : [];

  for (const action of actionList) {
    if (!isPlannerVisibleAction(action)) {
      continue;
    }

    const planner = action.planner;
    if (readSchema(action)) {
      continue;
    }

    const optOut = planner && planner.argsSchemaOptOut;
    const reason = optOut && typeof optOut.reason === "string" ? optOut.reason.trim() : "";
    if (reason) {
      continue;
    }

    throw new Error(
      `Planner-visible action "${action.name || "unknown"}" must declare planner.argsSchema or planner.argsSchemaOptOut.reason.`
    );
  }
}

function normalizeAliases(schema, sourceRecord) {
  // Auto camelCase↔snake_case normalization + opt-in explicit aliases.
  // For each canonical key, derive its case variant (e.g. document_no ↔
  // documentNo) as an implicit alias so the planner never needs to declare it.
  // Explicit `aliases: [...]` are merged after, deduped against the auto variant.
  const record = sourceRecord && typeof sourceRecord === "object" && !Array.isArray(sourceRecord)
    ? { ...sourceRecord }
    : {};
  const rewrites = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { record, rewrites };
  }
  for (const [canonical, rule] of Object.entries(schema)) {
    const autoVariant = toCaseVariant(canonical);
    const explicitAliases = rule && Array.isArray(rule.aliases) ? rule.aliases : [];
    const aliases = autoVariant
      ? [autoVariant, ...explicitAliases.filter(a => a !== autoVariant && a !== canonical)]
      : explicitAliases.filter(a => a !== canonical);
    if (aliases.length === 0) continue;
    const canonicalPresent = Object.prototype.hasOwnProperty.call(record, canonical)
      && record[canonical] !== undefined
      && record[canonical] !== null;
    for (const alias of aliases) {
      if (typeof alias !== "string" || alias === canonical) continue;
      if (!Object.prototype.hasOwnProperty.call(record, alias)) continue;
      const aliasValue = record[alias];
      if (aliasValue === undefined || aliasValue === null) continue;
      if (canonicalPresent) {
        rewrites.push({ from: alias, to: canonical, collision: true });
        delete record[alias];
        continue;
      }
      record[canonical] = aliasValue;
      delete record[alias];
      rewrites.push({ from: alias, to: canonical, collision: false });
      break;
    }
  }
  return { record, rewrites };
}

function toCaseVariant(name) {
  if (typeof name !== "string" || !name) return null;
  if (name.includes("_")) {
    const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    return camel !== name ? camel : null;
  }
  if (/[A-Z]/.test(name)) {
    const snake = name.replace(/([A-Z])/g, (_, c) => `_${c.toLowerCase()}`);
    return snake !== name ? snake : null;
  }
  return null;
}

function readSchema(action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  const planner = action.planner;
  if (!planner || typeof planner !== "object") {
    return null;
  }
  const schema = planner.argsSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  return schema;
}

function isPlannerVisibleAction(action) {
  if (!action || typeof action !== "object") {
    return false;
  }
  if (action.planner === false) {
    return false;
  }
  return Boolean(action.planner && typeof action.planner === "object");
}

function readType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export { assertPlannerActionArgsContract, normalizeAliases, validateActionArgs };
