const DEFAULT_ACTION_TIMEOUT_MS = 30000;
const DEFAULT_ACTION_TIMEOUT_BEHAVIOR = "error_as_result";
const ACTION_TIMEOUT_BEHAVIORS = Object.freeze([
  "error_as_result",
  "raise_exception"
]);

const ACTION_TIMEOUT_BEHAVIOR_SET = new Set(ACTION_TIMEOUT_BEHAVIORS);

function cloneSchemaEnum(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .map((item) => item)
    : [];
}

function copySchemaEnum(target, source) {
  const values = cloneSchemaEnum(source && source.enum);
  if (values.length > 0) {
    target.enum = values;
  }
  return target;
}

function normalizeActionTimeoutMs(value) {
  return Number.isInteger(value) && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ACTION_TIMEOUT_MS;
}

function normalizeActionTimeoutBehavior(value) {
  const behavior = typeof value === "string" ? value.trim() : "";
  return ACTION_TIMEOUT_BEHAVIOR_SET.has(behavior)
    ? behavior
    : DEFAULT_ACTION_TIMEOUT_BEHAVIOR;
}

export { ACTION_TIMEOUT_BEHAVIORS, DEFAULT_ACTION_TIMEOUT_BEHAVIOR, DEFAULT_ACTION_TIMEOUT_MS, cloneSchemaEnum, copySchemaEnum, normalizeActionTimeoutBehavior, normalizeActionTimeoutMs };
