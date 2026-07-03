import { copySchemaEnum } from './tool-schema.js';

function toSkillCatalogCompact(skill) {
  if (!skill || typeof skill !== "object") return null;
  const name = readString$3(skill.name);
  if (!name) return null;
  const tools = Array.isArray(skill.tools) ? skill.tools : [];
  const toolArgHints = tools
    .map(toEnumBearingToolArgHint)
    .filter(Boolean);
  return {
    name,
    description: readString$3(skill.description),
    toolCount: tools.length,
    ...(toolArgHints.length > 0 ? { toolArgHints } : {}),
    toolNames: tools
      .map((t) => readString$3(t && t.name))
      .filter(Boolean)
  };
}

function toSkillCatalogSummary(skill) {
  if (!skill || typeof skill !== "object") return null;
  const name = readString$3(skill.name);
  if (!name) return null;
  return {
    name,
    description: readString$3(skill.description),
    tools: Array.isArray(skill.tools)
      ? skill.tools
          .map((t) => {
            const toolName = readString$3(t && t.name);
            if (!toolName) return null;
            const entry = { name: toolName, description: readString$3(t.description) };
            const argHint = toCompactArgHint(t && t.parameters);
            if (argHint) {
              entry.args = argHint.args;
              if (argHint.required) {
                entry.required = argHint.required;
              }
            }
            return entry;
          })
          .filter(Boolean)
      : []
  };
}

function toSkillPromptValue(skill, options) {
  if (!skill || typeof skill !== "object") {
    return null;
  }

  const name = readString$3(skill.name);
  if (!name) {
    return null;
  }

  const includeInstructions = Boolean(options && options.includeInstructions);
  const value = {
    description: readString$3(skill.description),
    name,
    tools: Array.isArray(skill.tools)
      ? skill.tools.map(createToolPromptValue).filter(Boolean)
      : []
  };

  if (includeInstructions) {
    const body = readString$3(skill.instructions);
    if (body) {
      value.instructions = body;
    }
  }

  return value;
}

function formatActiveSkillTools(skill) {
  const activeSkill = toSkillPromptValue(skill);

  if (!activeSkill || !Array.isArray(activeSkill.tools) || activeSkill.tools.length === 0) {
    return "None";
  }

  return activeSkill.tools.map((tool) => JSON.stringify(tool)).join("\n");
}

function serializePromptValue$2(value, maxChars) {
  if (value == null) {
    return null;
  }

  let text = "";

  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = String(value);
  }

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 3)}...`;
}

function readString$3(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toEnumBearingToolArgHint(tool) {
  const name = readString$3(tool && tool.name);
  if (!name || !hasSchemaEnum(tool && tool.parameters)) {
    return null;
  }
  const argHint = toCompactArgHint(tool.parameters);
  return argHint
    ? {
        name,
        args: argHint.args,
        ...(argHint.required ? { required: argHint.required } : {})
      }
    : null;
}

function toCompactArgHint(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return null;
  }

  const props = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties
    : {};
  const entries = Object.entries(props);

  if (entries.length === 0) {
    return null;
  }

  const args = {};

  for (const [key, prop] of entries) {
    args[key] = describePromptProperty(prop);
  }

  const required = Array.isArray(parameters.required) && parameters.required.length > 0
    ? parameters.required.filter((v) => typeof v === "string" && v.trim())
    : null;

  return {
    args,
    required: required && required.length > 0 ? required : null
  };
}

function describePromptProperty(prop) {
  const type = readString$3(prop && prop.type) || "string";
  if (type === "object" && prop && prop.properties && typeof prop.properties === "object" && !Array.isArray(prop.properties)) {
    const nested = Object.entries(prop.properties)
      .map(([key, value]) => `${key}:${describePromptProperty(value)}`);
    return nested.length > 0 ? `object{${nested.join(",")}}` : describeTypeWithEnum(prop, type);
  }
  return describeTypeWithEnum(prop, type);
}

function describeTypeWithEnum(prop, type) {
  const values = Array.isArray(prop && prop.enum)
    ? prop.enum.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    : [];
  return values.length > 0 ? `${type}|${values.join("|")}` : type;
}

function hasSchemaEnum(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return false;
  }
  const props = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties
    : parameters;
  return Object.values(props).some((prop) => {
    if (!prop || typeof prop !== "object" || Array.isArray(prop)) return false;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) return true;
    return prop.properties && typeof prop.properties === "object" && !Array.isArray(prop.properties)
      ? hasSchemaEnum({ properties: prop.properties })
      : false;
  });
}

function createToolPromptValue(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const name = readString$3(tool.name);
  if (!name) {
    return null;
  }

  return {
    description: readString$3(tool.description),
    name,
    parameters: clonePromptParameters(tool.parameters)
  };
}

function clonePromptParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return {
      properties: {},
      required: [],
      type: "object"
    };
  }

  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties
    : {};

  return {
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => {
        const prop = {
          description: readString$3(value && value.description),
          type: readString$3(value && value.type)
        };
        copySchemaEnum(prop, value);
        if (value && value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
          prop.properties = Object.fromEntries(
            Object.entries(value.properties).map(([nk, nv]) => [
              nk,
              copySchemaEnum({
                description: readString$3(nv && nv.description),
                type: readString$3(nv && nv.type)
              }, nv)
            ])
          );
        }
        return [key, prop];
      })
    ),
    required: Array.isArray(parameters.required)
      ? parameters.required.filter((value) => typeof value === "string" && value.trim())
      : [],
    type: readString$3(parameters.type) || "object"
  };
}

export { formatActiveSkillTools, readString$3 as readString, serializePromptValue$2 as serializePromptValue, toSkillCatalogCompact, toSkillCatalogSummary, toSkillPromptValue };
