import { readString } from './semantic-json.js';
import { EXECUTE_SKILL_TOOL_ACTION } from './action-names.js';

const MAX_STRING_CHARS = 40;
const MAX_KEYS_PER_LEVEL = 6;
const CONTROL_KEYS_SKILL_TOOL = new Set(["skillName", "toolName", "args", "reasoning"]);

function sanitizeActionStepArgs(actionName, rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return undefined;
  }

  if (actionName === EXECUTE_SKILL_TOOL_ACTION) {
    return sanitizeSkillToolArgs(rawArgs);
  }

  const argKeys = Object.keys(rawArgs);
  if (argKeys.length === 0) {
    return undefined;
  }
  const digest = buildDigest(rawArgs, 0);
  const preview = buildPreview(rawArgs, 0);
  return {
    argKeys,
    argsDigest: digest || undefined,
    argsPreview: preview
  };
}

function sanitizeSkillToolArgs(rawArgs) {
  const skillName = readString(rawArgs.skillName) || undefined;
  const toolName = readString(rawArgs.toolName) || undefined;

  const nested = rawArgs.args && typeof rawArgs.args === "object" && !Array.isArray(rawArgs.args)
    ? rawArgs.args
    : null;

  let effectiveArgs = nested;
  if (!effectiveArgs) {
    const lifted = {};
    for (const key of Object.keys(rawArgs)) {
      if (!CONTROL_KEYS_SKILL_TOOL.has(key)) {
        lifted[key] = rawArgs[key];
      }
    }
    effectiveArgs = Object.keys(lifted).length > 0 ? lifted : null;
  }

  const argKeys = effectiveArgs ? Object.keys(effectiveArgs) : [];
  const digest = effectiveArgs ? buildDigest(effectiveArgs, 0) : "";
  const preview = effectiveArgs ? buildPreview(effectiveArgs, 0) : null;

  const detail = {};
  if (skillName) detail.skillName = skillName;
  if (toolName) detail.toolName = toolName;
  if (argKeys.length > 0) detail.argKeys = argKeys;
  if (digest) detail.argsDigest = digest;
  if (preview && Object.keys(preview).length > 0) detail.argsPreview = preview;
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function buildDigest(obj, depth) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }

  const parts = [];
  let rendered = 0;
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (rendered >= MAX_KEYS_PER_LEVEL) {
      parts.push("…");
      break;
    }
    parts.push(`${key}=${renderValue(obj[key], depth)}`);
    rendered += 1;
  }
  return parts.join(";");
}

function buildPreview(obj, depth) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }

  const out = {};
  let rendered = 0;
  for (const key of Object.keys(obj)) {
    if (rendered >= MAX_KEYS_PER_LEVEL) {
      break;
    }
    out[key] = renderPreviewValue(obj[key], depth);
    rendered += 1;
  }
  return out;
}

function renderPreviewValue(value, depth) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (typeof value === "object") {
    if (depth >= 1) {
      return "{…}";
    }
    return buildPreview(value, depth + 1);
  }
  return String(value);
}

function renderValue(value, depth) {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    if (value.length === 0) return "";
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}…`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length}]`;
  }
  if (typeof value === "object") {
    if (depth >= 1) {
      return "{…}";
    }
    const nested = buildDigest(value, depth + 1);
    return nested ? `{${nested}}` : "{}";
  }
  return String(value);
}

export { sanitizeActionStepArgs };
