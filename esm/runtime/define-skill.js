// AGRUN-268 — Public helpers for host-defined actions and skills.
//
// `defineAction(spec)` validates an action descriptor against the same shape
// the bundled actions use (name, description, planner.{argsSchema, argsExample,
// guidance}, tier, execute, outputSchema) and returns a frozen copy. Host
// engineers use it to register new tools via `createRuntime({ actions: [...] })`
// without forking `src/runtime/actions/`.
//
// `defineSkill(spec)` is the same idea for higher-level "skills" — capabilities
// that the AI discovers through `list_agent_skills` and invokes through
// `use_agent_skill` / `execute_skill_tool`. A skill projects into one or more
// underlying action descriptors plus a manifest entry; this helper produces a
// uniform shape that downstream registration code can consume.
//
// Both helpers are STATELESS: they only validate and freeze. Name uniqueness
// against the bundled set is enforced later, at registry construction time
// (see ADR-0040).

const ALLOWED_SCHEMA_TYPES = new Set(["string", "number", "boolean", "object", "array"]);
const ALLOWED_CONTROLS = new Set(["continue", "stop", "complete"]);

function defineAction(spec) {
  assertObject(spec, "defineAction(spec) requires a plain object.");

  const name = readNonEmptyString(spec.name);
  if (!name) {
    throw new Error("defineAction: spec.name must be a non-empty string.");
  }

  const description = readNonEmptyString(spec.description);
  if (!description) {
    throw new Error(`defineAction(${name}): spec.description must be a non-empty string.`);
  }

  if (typeof spec.execute !== "function") {
    throw new Error(`defineAction(${name}): spec.execute must be a function.`);
  }

  const planner = assertPlannerShape(spec.planner, name);
  const outputSchema = assertOutputSchemaShape(spec.outputSchema, name);
  const tier = readPositiveInteger(spec.tier);
  if (tier === null) {
    throw new Error(`defineAction(${name}): spec.tier must be a positive integer (1, 2, 3, ...).`);
  }

  const action = {
    name,
    description,
    planner,
    tier,
    execute: spec.execute,
    outputSchema
  };
  if (spec.timeoutMs != null) action.timeoutMs = spec.timeoutMs;
  if (spec.timeoutBehavior != null) action.timeoutBehavior = spec.timeoutBehavior;
  return Object.freeze(action);
}

function defineSkill(spec) {
  assertObject(spec, "defineSkill(spec) requires a plain object.");

  const name = readNonEmptyString(spec.name);
  if (!name) {
    throw new Error("defineSkill: spec.name must be a non-empty string.");
  }

  const description = readNonEmptyString(spec.description);
  if (!description) {
    throw new Error(`defineSkill(${name}): spec.description must be a non-empty string.`);
  }

  if (typeof spec.execute !== "function") {
    throw new Error(`defineSkill(${name}): spec.execute must be a function.`);
  }

  const argsSchema = readSchemaRecord(spec.argsSchema, name, "argsSchema");
  const argsExample = readPlainObject(spec.argsExample, name, "argsExample");
  const guidance = readNonEmptyString(spec.guidance);
  if (!guidance) {
    throw new Error(`defineSkill(${name}): spec.guidance must be a non-empty string (planner needs it to know when to call this skill).`);
  }
  const tier = readPositiveInteger(spec.tier);
  if (tier === null) {
    throw new Error(`defineSkill(${name}): spec.tier must be a positive integer.`);
  }

  return Object.freeze({
    kind: "agrun-skill",
    name,
    description,
    guidance,
    argsSchema,
    argsExample,
    tier,
    execute: spec.execute
  });
}

function assertPlannerShape(planner, actionName) {
  if (!planner || typeof planner !== "object" || Array.isArray(planner)) {
    throw new Error(`defineAction(${actionName}): spec.planner must be an object.`);
  }
  const argsSchema = readSchemaRecord(planner.argsSchema, actionName, "planner.argsSchema");
  const argsExample = readPlainObject(planner.argsExample, actionName, "planner.argsExample");
  const guidance = readNonEmptyString(planner.guidance);
  if (!guidance) {
    throw new Error(`defineAction(${actionName}): spec.planner.guidance must be a non-empty string.`);
  }
  const aliases = readStringArray(planner.aliases);
  return Object.freeze({
    aliases: Object.freeze(aliases),
    argsExample,
    argsSchema,
    decisionType: readNonEmptyString(planner.decisionType) || "action",
    guidance
  });
}

function assertOutputSchemaShape(outputSchema, actionName) {
  if (outputSchema === null) return null;
  if (!outputSchema || typeof outputSchema !== "object" || Array.isArray(outputSchema)) {
    throw new Error(`defineAction(${actionName}): spec.outputSchema must be an object or null waiver.`);
  }
  const kinds = readStringArray(outputSchema.kinds);
  if (kinds.length === 0) {
    throw new Error(`defineAction(${actionName}): spec.outputSchema.kinds must be a non-empty string array.`);
  }
  const controls = readStringArray(outputSchema.controls);
  if (controls.length === 0) {
    throw new Error(`defineAction(${actionName}): spec.outputSchema.controls must be a non-empty string array.`);
  }
  for (const control of controls) {
    if (!ALLOWED_CONTROLS.has(control)) {
      throw new Error(
        `defineAction(${actionName}): spec.outputSchema.controls contains unknown value "${control}" (allowed: ${Array.from(ALLOWED_CONTROLS).join(", ")}).`
      );
    }
  }
  return Object.freeze({
    kinds: Object.freeze(kinds),
    controls: Object.freeze(controls),
    metrics: outputSchema.metrics ? Object.freeze({ ...outputSchema.metrics }) : undefined
  });
}

function readSchemaRecord(value, owner, fieldLabel) {
  if (value === undefined) {
    throw new Error(`define(${owner}): ${fieldLabel} is required (declare {} if the action takes no args).`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`define(${owner}): ${fieldLabel} must be an object keyed by arg name.`);
  }
  const frozen = {};
  for (const [key, rule] of Object.entries(value)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`define(${owner}): ${fieldLabel}.${key} must be an object like { type: "string" }.`);
    }
    if (typeof rule.type === "string" && !ALLOWED_SCHEMA_TYPES.has(rule.type)) {
      throw new Error(
        `define(${owner}): ${fieldLabel}.${key}.type "${rule.type}" not in (${Array.from(ALLOWED_SCHEMA_TYPES).join(", ")}).`
      );
    }
    frozen[key] = Object.freeze({ ...rule });
  }
  return Object.freeze(frozen);
}

function readPlainObject(value, owner, fieldLabel) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`define(${owner}): ${fieldLabel} must be a plain object.`);
  }
  return Object.freeze({ ...value });
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function readNonEmptyString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readPositiveInteger(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const int = Math.trunc(value);
  return int >= 1 ? int : null;
}

function readStringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return out;
}

export { defineAction, defineSkill };
