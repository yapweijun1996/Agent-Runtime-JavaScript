/**
 * Single source of truth for plan-action argument fallback aliases.
 *
 * Plan actions arrive from two sources with the same alias quirks:
 *   1. Native function-call envelopes parsed in `planner-tools.js`
 *      (`normalizePlanActionArgs`).
 *   2. Envelope plan/standalone decisions parsed in `action-loop-utils.js`
 *      (`readActionArgs`).
 *
 * Both must accept the same alias shapes (toolArgs / tool_args /
 * toolArguments / tool_arguments + their *Json variants) so providers
 * with different argument-emission habits all reach the runtime with the
 * correct payload. Keeping the alias list and merge policy here prevents
 * the two call sites from drifting out of sync when a new alias is added.
 *
 * Native parsing additionally accepts flat per-key fields on the record
 * (with optional `arg_` prefix); envelope decisions never carry those, so
 * the flat collector is opt-in via `options.includeFlatArgs`.
 */

const TOOL_ARGS_ALIAS_KEYS = Object.freeze([
  "toolArgs",
  "tool_args",
  "toolArguments",
  "tool_arguments"
]);

const TOOL_ARGS_JSON_ALIAS_KEYS = Object.freeze([
  "toolArgsJson",
  "tool_args_json",
  "toolArgumentsJson",
  "tool_arguments_json"
]);

const RESERVED_FLAT_ARG_KEYS = new Set([
  "action",
  "args",
  "arguments",
  "name",
  "reasoning",
  "section",
  "skillName",
  "skill_name",
  "tool",
  "toolName",
  "tool_name",
  "type",
  ...TOOL_ARGS_ALIAS_KEYS,
  ...TOOL_ARGS_JSON_ALIAS_KEYS
]);

/**
 * Read fallback arguments from a plan action record.
 *
 * Resolution order:
 *   1. Object-typed alias keys (`toolArgs`, `tool_args`, `toolArguments`,
 *      `tool_arguments`).
 *   2. JSON-string alias keys (`toolArgsJson`, `tool_args_json`,
 *      `toolArgumentsJson`, `tool_arguments_json`).
 *   3. Optionally, flat per-key fields on the record (when
 *      `options.includeFlatArgs === true`). Keys with an `arg_` prefix
 *      are normalized by stripping the prefix. Reserved keys are skipped.
 *
 * Returns a non-empty plain object on success, or `null` when no
 * fallback args are present.
 */
function readPlanActionFallbackArgs(record, options = {}) {
  if (!isPlainObject$2(record)) return null;

  for (const key of TOOL_ARGS_ALIAS_KEYS) {
    const value = readNonEmptyObject(record[key]);
    if (value) return value;
  }

  for (const key of TOOL_ARGS_JSON_ALIAS_KEYS) {
    const parsed = parseToolArgsJson(record[key]);
    if (parsed) return parsed;
  }

  if (options && options.includeFlatArgs === true) {
    return collectFlatToolArgs(record);
  }

  return null;
}

/**
 * Shallow-merge fallback args into a base args object without overwriting
 * existing keys. Returns a new object; inputs are not mutated. Used to
 * back-fill missing fields (e.g. when the model emitted `args: {}` plus a
 * sibling `toolArgsJson`).
 */
function mergeMissingArgs(base, fallback) {
  const target = isPlainObject$2(base) ? { ...base } : {};
  if (!isPlainObject$2(fallback)) return target;
  for (const [key, value] of Object.entries(fallback)) {
    if (target[key] == null) {
      target[key] = value;
    }
  }
  return target;
}

function collectFlatToolArgs(record) {
  const args = {};
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_FLAT_ARG_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (key.startsWith("arg_") && key.length > 4) {
      args[key.slice(4)] = value;
    } else {
      args[key] = value;
    }
  }
  return Object.keys(args).length > 0 ? args : null;
}

function parseToolArgsJson(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return readNonEmptyObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function readNonEmptyObject(value) {
  if (!isPlainObject$2(value)) return null;
  return Object.keys(value).length > 0 ? value : null;
}

function isPlainObject$2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { TOOL_ARGS_ALIAS_KEYS, TOOL_ARGS_JSON_ALIAS_KEYS, mergeMissingArgs, readPlanActionFallbackArgs };
