import { getPlannerProviderCapabilities } from './provider-capabilities.js';
import { formatStandalonePlanActionNames } from './action-plan-contract.js';
import { normalizeFinalReadiness } from './final-readiness.js';
import { readPlanActionFallbackArgs, mergeMissingArgs } from './plan-args-fallback.js';

/**
 * Converts action registry definitions to native provider tool definitions.
 *
 * Supports OpenAI Responses API and Gemini generateContent API formats.
 */


function buildOpenAITools(plannerActions, options) {
  const actions = Array.isArray(plannerActions) ? plannerActions : [];
  const capabilities = readCapabilities(options);
  const suppressFinalAnswerTool = options && options.suppressFinalAnswerTool === true;
  const suppressFinalizeTool = options && options.suppressFinalizeTool === true;
  const tools = [];

  for (const action of actions) {
    if (action.decisionType === "clarify") {
      tools.push({
        type: "function",
        name: "ask_clarification",
        description: action.description || "Ask the user a short clarifying question and stop.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The clarifying question to ask the user."
            },
            reasoning: {
              type: "string",
              description: "Why clarification is needed."
            }
          },
          required: ["question"]
        }
      });
      continue;
    }

    tools.push({
      type: "function",
      name: action.name,
      description: action.description || "",
      parameters: buildToolParameters(action)
    });
  }

  tools.push(buildPlanTool(actions, capabilities));

  if (!suppressFinalizeTool) {
    tools.push({
      type: "function",
      name: "finalize",
      description: "Synthesize a final answer using the gathered evidence. Use when you judge the current evidence, skill context, and draft artifacts are enough.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "Instruction for synthesizing the final answer from evidence."
          },
          reasoning: {
            type: "string",
            description: "Why finalization is appropriate now."
          },
          finalReadiness: {
            ...buildFinalReadinessSchema("For research/report tasks, AI-owned readiness declaration. Use decision='ready' when evidence is enough, or decision='limited' when you choose to finalize with explicit limitations. If not ready, do not call finalize.")
          }
        },
        required: ["instruction"]
      }
    });
  }

  if (!suppressFinalAnswerTool) {
    tools.push({
      type: "function",
      name: "final_answer",
      description: "Provide a direct final answer without executing any tools. Use only when no tool, loaded research/report skill, read_url evidence gathering, or virtual workspace workflow is needed.",
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "The direct answer to the user's question."
          },
          citations: {
            type: "array",
            items: { type: "string" },
            description: "Source citations if applicable."
          },
          reasoning: {
            type: "string",
            description: "Why a direct answer is sufficient."
          },
          finalReadiness: {
            ...buildFinalReadinessSchema("For research/report direct final answers, AI-owned readiness declaration. Use decision='ready' when evidence is enough, or decision='limited' when you choose to answer with explicit limitations.")
          }
        },
        required: ["answer"]
      }
    });
  }

  return tools;
}

function buildGeminiTools(plannerActions, options) {
  const openaiTools = buildOpenAITools(plannerActions, {
    ...(options && typeof options === "object" ? options : {}),
    provider: "gemini"
  });

  return [{
    functionDeclarations: openaiTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toGeminiSchema(tool.parameters)
    }))
  }];
}

function parseToolCallDecision(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return null;
  }

  const call = toolCalls[0];
  if (!call || typeof call !== "object") {
    return null;
  }

  const name = readString$u(call.name);
  const args = parseArgs(call.arguments);

  if (name === "final_answer") {
    return {
      answer: readString$u(args.answer),
      citations: Array.isArray(args.citations) ? args.citations : [],
      finalReadiness: normalizeFinalReadiness(args.finalReadiness),
      reasoning: readString$u(args.reasoning),
      type: "final"
    };
  }

  if (name === "finalize") {
    return {
      finalReadiness: normalizeFinalReadiness(args.finalReadiness),
      instruction: readString$u(args.instruction),
      reasoning: readString$u(args.reasoning),
      type: "finalize"
    };
  }

  if (name === "ask_clarification") {
    return {
      question: readString$u(args.question),
      reasoning: readString$u(args.reasoning),
      type: "clarify"
    };
  }

  if (name === "plan") {
    return normalizePlanToolDecision(args);
  }

  if (!name) {
    return null;
  }

  return {
    args,
    name,
    reasoning: readString$u(args.reasoning),
    type: "action"
  };
}

function buildPlanTool(actions, capabilities) {
  const nativePlan = capabilities && capabilities.nativePlan ? capabilities.nativePlan : {};
  const toolArgsJsonRequired = nativePlan.toolArgsJsonRequired === true;
  const preferredShape = readString$u(nativePlan.executeSkillToolArgsShape) || "object";
  const standaloneActionNames = formatStandalonePlanActionNames(actions);
  const toolArgsJsonDescription = toolArgsJsonRequired
    ? "Compatibility field for execute_skill_tool. REQUIRED for this provider's plan actions that need tool arguments because nested objects can be emitted as empty objects. JSON string containing tool arguments, for example '{\"label\":\"alpha\"}'. Prefer this over nested toolArgs."
    : "Compatibility field for execute_skill_tool. JSON string containing tool arguments, for example '{\"label\":\"alpha\"}'. Used when a provider is more reliable with stringified tool args than nested objects.";
  const toolArgsDescription = toolArgsJsonRequired
    ? "Flat execute_skill_tool tool arguments. Used only when name is execute_skill_tool; normalized to args.args by the runtime. For this provider, prefer toolArgsJson because nested objects can be emitted as empty objects. Simple tool-specific fields may also be placed directly on the plan action item, optionally prefixed with arg_."
    : "Flat execute_skill_tool tool arguments. Used only when name is execute_skill_tool; normalized to args.args by the runtime. Simple tool-specific fields may also be placed directly on the plan action item, optionally prefixed with arg_.";
  return {
    type: "function",
    name: "plan",
    description: `Run multiple independent non-mutating runtime actions before one synthesis step. Use only when the required actions are known, can run without inspecting each other's outputs first, and do not require approval (actionPolicy=allow). Actions marked standalone-only by action metadata must not appear inside plan.actions: ${standaloneActionNames}. Approval-gated actions must also be standalone. Preferred execute_skill_tool payload shape for this provider: ${preferredShape}.`,
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Independent non-mutating action calls to execute as one plan. Actions that are state-changing or require approval must be standalone actions, not plan actions.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: `Canonical runtime action name. Must be independent, non-mutating, and approval-free. Do not use standalone-only actions inside plan.actions: ${standaloneActionNames}.`
              },
              skillName: {
                type: "string",
                description: "Flat execute_skill_tool skillName. Used only when name is execute_skill_tool."
              },
              toolName: {
                type: "string",
                description: "Flat execute_skill_tool toolName. Used only when name is execute_skill_tool."
              },
              toolArgsJson: {
                type: "string",
                description: toolArgsJsonDescription
              },
              toolArgs: {
                type: "object",
                description: toolArgsDescription
              },
              args: {
                type: "object",
                description: "Arguments for the action. For execute_skill_tool, prefer the flatter skillName/toolName/toolArgs fields instead of nesting args.args."
              },
              reasoning: {
                type: "string",
                description: "Why this action belongs in the plan."
              },
              section: {
                type: "object",
                description: "Optional per-action section metadata used when synthesize_per_action is true.",
                properties: {
                  prompt: {
                    type: "string",
                    description: "Instruction for synthesizing this action result into a section."
                  },
                  title: {
                    type: "string",
                    description: "Markdown section title."
                  }
                }
              }
            },
            required: ["name"]
          }
        },
        partial_ok: {
          type: "boolean",
          description: "Whether the plan may continue when some actions fail."
        },
        reasoning: {
          type: "string",
          description: "Why these actions can run as a plan."
        },
        finalReadiness: {
          ...buildFinalReadinessSchema("Required for research/report plans that will synthesize directly after the plan. Use decision='ready' or 'limited' only when you choose finalization; otherwise choose another action instead of a finalizing plan.")
        },
        stitch: {
          type: "object",
          description: "Optional final stitching metadata for per-action synthesis.",
          properties: {
            drill_hints: {
              type: "array",
              description: "Optional UI drill hints.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Drill hint label." },
                  match_header: { type: "string", description: "Header to match." },
                  prompt: { type: "string", description: "Prompt template for the drill action." }
                }
              }
            },
            followups: {
              type: "array",
              description: "Optional follow-up suggestions.",
              items: { type: "string" }
            },
            intro_prompt: {
              type: "string",
              description: "Instruction for the opening synthesis text."
            },
            outro_prompt: {
              type: "string",
              description: "Instruction for the closing synthesis text."
            },
            provenance: {
              type: "string",
              description: "Source/provenance note for the stitched answer."
            },
            result_budget: {
              type: "object",
              description: "Optional result budget hints for per-action synthesis."
            }
          }
        },
        synthesize_instruction: {
          type: "string",
          description: "Instruction for synthesizing the plan outputs."
        },
        synthesize_per_action: {
          type: "boolean",
          description: "Whether each action result should be synthesized into its own section before stitching."
        },
        result_budget: {
          type: "object",
          description: "Optional finalizer budget hints."
        }
      },
      required: ["actions"]
    }
  };
}

function buildFinalReadinessSchema(description) {
  return {
    type: "object",
    description,
    properties: {
      decision: {
        type: "string",
        enum: ["ready", "limited"],
        description: "AI's finalization decision."
      },
      evidenceMode: {
        type: "string",
        enum: ["read_sources", "search_summary_only", "model_knowledge", "mixed"],
        description: "What evidence mode the final answer will honestly use."
      },
      limitations: {
        type: "string",
        description: "Limitations the final answer must disclose when evidence is thin or only search snippets are available."
      },
      requirementsAssessment: {
        type: "object",
        description: "AI-authored assessment of whether the final answer satisfies the end user's requirements. Runtime records this declaration but does not judge or verify sufficiency; use workspace textStats/readSources already visible in the planner prompt and do not invent counts.",
        properties: {
          userRequirementSummary: {
            type: "string",
            description: "Short summary of the relevant end-user requirement you checked, such as requested scope, evidence, language, or length."
          },
          requirementSatisfied: {
            type: "boolean",
            description: "Whether YOU judge the final answer satisfies the end-user requirement."
          },
          requestedLength: {
            type: "number",
            description: "Requested answer length, if the user asked for a length."
          },
          observedLength: {
            type: "number",
            description: "Observed draft/final candidate length in observedLengthUnit, based on workspace textStats when available."
          },
          observedLengthUnit: {
            type: "string",
            enum: ["chars", "cjk_chars", "words", "tokens"],
            description: "Unit used for requestedLength and observedLength."
          },
          lengthSatisfied: {
            type: "boolean",
            description: "Whether YOU judge the observed answer satisfies the requested length, if any."
          },
          successfulReadUrlCount: {
            type: "number",
            description: "Count of successful read_url sources visible in readSources."
          },
          evidenceSatisfied: {
            type: "boolean",
            description: "Whether the evidence is enough for the chosen decision."
          },
          checkedWorkspaceStats: {
            type: "boolean",
            description: "True only if you inspected workspace_read/workspace_list textStats or equivalent visible stats."
          },
          checkedReadUrlEvidence: {
            type: "boolean",
            description: "True only if you inspected readSources/read_url evidence status."
          },
          remainingGaps: {
            type: "array",
            items: { type: "string" },
            description: "Known unresolved gaps to disclose or accept when decision is limited."
          },
          summary: {
            type: "string",
            description: "Short explanation of your readiness judgment."
          }
        }
      }
    }
  };
}

function readCapabilities(options) {
  if (options && typeof options === "object" && options.capabilities) {
    return options.capabilities;
  }
  return getPlannerProviderCapabilities(options && options.provider);
}

function normalizePlanToolDecision(args) {
  return {
    actions: normalizePlanToolActions(args.actions),
    partial_ok: args.partial_ok === true,
    finalReadiness: normalizeFinalReadiness(args.finalReadiness),
    reasoning: readString$u(args.reasoning),
    result_budget: readObject(args.result_budget),
    stitch: normalizePlanStitch(args.stitch),
    synthesize_instruction: readString$u(args.synthesize_instruction) || readString$u(args.instruction),
    synthesize_per_action: args.synthesize_per_action === true,
    type: "plan"
  };
}

function normalizePlanToolActions(actions) {
  if (!Array.isArray(actions)) return [];
  const normalized = [];
  for (const item of actions) {
    const record = readObject(item);
    if (!record) continue;
    const name = readString$u(record.name || record.action || record.tool || record.toolName).toLowerCase();
    if (!name) continue;
    normalized.push({
      args: normalizePlanActionArgs(name, record),
      name,
      reasoning: readString$u(record.reasoning),
      section: normalizePlanSection(record.section),
      type: "action"
    });
  }
  return normalized;
}

function normalizePlanActionArgs(name, record) {
  const args = readObject(record.args) || readObject(record.arguments) || {};
  const genericArgs = readPlanActionFallbackArgs(record, { includeFlatArgs: true });

  if (name !== "execute_skill_tool") {
    return mergeMissingArgs(args, genericArgs);
  }

  const flatSkillName = readString$u(record.skillName || record.skill_name);
  const flatToolName = readString$u(record.toolName || record.tool_name);
  const flatToolArgs = genericArgs;
  const hasFlatFields = Boolean(flatSkillName || flatToolName || flatToolArgs);

  if (!hasFlatFields) {
    return args;
  }

  const normalized = { ...args };
  if (flatSkillName && !readString$u(normalized.skillName)) normalized.skillName = flatSkillName;
  if (flatToolName && !readString$u(normalized.toolName)) normalized.toolName = flatToolName;
  if (flatToolArgs && !readObject(normalized.args)) normalized.args = flatToolArgs;
  return normalized;
}

function normalizePlanSection(section) {
  const record = readObject(section);
  if (!record) return null;
  return {
    prompt: readString$u(record.prompt),
    title: readString$u(record.title)
  };
}

function normalizePlanStitch(stitch) {
  const record = readObject(stitch);
  if (!record) return null;
  return {
    drill_hints: Array.isArray(record.drill_hints) ? record.drill_hints : [],
    followups: Array.isArray(record.followups)
      ? record.followups.filter((item) => typeof item === "string")
      : [],
    intro_prompt: readString$u(record.intro_prompt),
    outro_prompt: readString$u(record.outro_prompt),
    provenance: readString$u(record.provenance),
    result_budget: readObject(record.result_budget)
  };
}

function summarizeToolCallsForDebug(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter((call) => call && typeof call === "object")
    .map((call) => ({
      argsShape: summarizeDebugValue(parseArgs(call.arguments), 0),
      name: readString$u(call.name) || null
    }));
}

function buildToolParameters(action) {
  if (action.argsSchema && typeof action.argsSchema === "object" && !Array.isArray(action.argsSchema)) {
    return buildToolParametersFromArgsSchema(action);
  }

  const example = action.argsExample && typeof action.argsExample === "object"
    ? action.argsExample
    : {};
  const properties = {};
  const required = [];

  for (const [key, value] of Object.entries(example)) {
    properties[key] = inferParameterSchema(key, value, action.name);
    if (isLikelyRequired(key, action.name)) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required
  };
}

function buildToolParametersFromArgsSchema(action) {
  const properties = {};
  const required = [];

  for (const [key, rule] of Object.entries(action.argsSchema)) {
    properties[key] = toNativePropertySchema(key, rule, action.name);
    if (rule && rule.required === true) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required
  };
}

function toNativePropertySchema(key, rule, actionName) {
  const source = rule && typeof rule === "object" && !Array.isArray(rule) ? rule : {};
  const type = normalizeNativeType(source.type);
  const schema = {
    type,
    description: typeof source.description === "string" && source.description.trim()
      ? source.description.trim()
      : inferParameterDescription(key)
  };

  if (type === "array") {
    schema.items = source.items && typeof source.items === "object" && !Array.isArray(source.items)
      ? toNativeNestedSchema(source.items)
      : { type: "string" };
  }

  if (type === "object" && source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    schema.properties = {};
    for (const [childKey, childRule] of Object.entries(source.properties)) {
      schema.properties[childKey] = toNativePropertySchema(childKey, childRule);
    }
    if (Array.isArray(source.required)) {
      schema.required = source.required.filter((value) => typeof value === "string" && value.trim());
    }
  }

  return schema;
}

function toNativeNestedSchema(rule) {
  const source = rule && typeof rule === "object" && !Array.isArray(rule) ? rule : {};
  const type = normalizeNativeType(source.type);
  const schema = {
    type,
    description: typeof source.description === "string" && source.description.trim()
      ? source.description.trim()
      : ""
  };

  if (type === "array") {
    schema.items = source.items && typeof source.items === "object" && !Array.isArray(source.items)
      ? toNativeNestedSchema(source.items)
      : { type: "string" };
  }

  if (type === "object" && source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    schema.properties = {};
    for (const [key, child] of Object.entries(source.properties)) {
      schema.properties[key] = toNativeNestedSchema(child);
    }
    if (Array.isArray(source.required)) {
      schema.required = source.required.filter((value) => typeof value === "string" && value.trim());
    }
  }

  if (!schema.description) {
    delete schema.description;
  }
  return schema;
}

function normalizeNativeType(type) {
  if (type === "string" || type === "number" || type === "boolean" || type === "array" || type === "object") {
    return type;
  }
  return "string";
}

function inferParameterSchema(key, exampleValue, actionName) {
  const schema = {
    description: inferParameterDescription(key)
  };

  if (typeof exampleValue === "string") {
    schema.type = "string";
  } else if (typeof exampleValue === "number") {
    schema.type = "integer";
  } else if (typeof exampleValue === "boolean") {
    schema.type = "boolean";
  } else if (Array.isArray(exampleValue)) {
    schema.type = "array";
    schema.items = { type: "string" };
  } else if (exampleValue && typeof exampleValue === "object") {
    schema.type = "object";
  } else {
    schema.type = "string";
  }

  return schema;
}

function inferParameterDescription(key, actionName) {
  const descriptions = {
    query: "The search query.",
    url: "The URL to read.",
    limit: "Maximum number of results.",
    maxPasses: "Maximum number of search refinement passes.",
    strategy: "Search strategy: auto, direct, or refined.",
    mode: "Read mode: html_text, raw, or auto.",
    maxBytes: "Maximum bytes to read.",
    skillName: "Name of the bundled skill.",
    toolName: "Name of the tool within the skill.",
    args: "Arguments to pass to the skill tool.",
    question: "The clarifying question to ask."
  };

  return descriptions[key] || `The ${key} parameter.`;
}

function isLikelyRequired(key, actionName) {
  const requiredKeys = {
    web_search: ["query"],
    read_url: ["url"],
    execute_skill_tool: ["skillName", "toolName"],
    ask_clarification: ["question"],
    use_agent_skill: ["skillName"],
    read_agent_skill: ["skillName"]
  };

  const keys = requiredKeys[actionName];
  return Array.isArray(keys) && keys.includes(key);
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "OBJECT" };
  }

  const result = toGeminiPropertySchema(schema);

  if (!result.description) {
    delete result.description;
  }

  return result;
}

function toGeminiPropertySchema(value) {
  if (!value || typeof value !== "object") {
    return { type: "STRING", description: "" };
  }

  const prop = {
    type: (value.type || "string").toUpperCase(),
    description: value.description || ""
  };

  if (value.properties && typeof value.properties === "object") {
    prop.properties = {};
    for (const [key, child] of Object.entries(value.properties)) {
      prop.properties[key] = toGeminiPropertySchema(child);
    }
    const propertyOrdering = createPropertyOrdering(value);
    if (propertyOrdering.length > 0) {
      prop.propertyOrdering = propertyOrdering;
    }
  }

  if (Array.isArray(value.required)) {
    prop.required = value.required;
  }

  if (prop.type === "ARRAY" && value.items && typeof value.items === "object") {
    prop.items = toGeminiPropertySchema(value.items);
    if (!prop.items.description) delete prop.items.description;
  }

  return prop;
}

function createPropertyOrdering(schema) {
  const properties = schema && schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : null;
  if (!properties) return [];

  const propertyKeys = Object.keys(properties);
  const known = new Set(propertyKeys);
  const seen = new Set();
  const ordering = [];

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!known.has(key) || seen.has(key)) continue;
      ordering.push(key);
      seen.add(key);
    }
  }

  for (const key of propertyKeys) {
    if (seen.has(key)) continue;
    ordering.push(key);
    seen.add(key);
  }

  return ordering;
}

function summarizeDebugValue(value, depth) {
  if (value === null) {
    return { type: "null" };
  }
  if (Array.isArray(value)) {
    const summary = { length: value.length, type: "array" };
    if (value.length > 0 && depth < 3) {
      summary.itemShape = summarizeDebugValue(value[0], depth + 1);
    }
    return summary;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const summary = { keys: [], type: "object" };
    const properties = {};
    let sensitiveKeyCount = 0;

    for (const [key, child] of entries.slice(0, 30)) {
      if (isSensitiveDebugKey(key)) {
        sensitiveKeyCount += 1;
        continue;
      }
      summary.keys.push(key);
      properties[key] = depth >= 3
        ? { type: readDebugType(child) }
        : summarizeDebugValue(child, depth + 1);
    }

    if (Object.keys(properties).length > 0) {
      summary.properties = properties;
    }
    if (sensitiveKeyCount > 0) {
      summary.sensitiveKeyCount = sensitiveKeyCount;
    }
    if (entries.length > summary.keys.length + sensitiveKeyCount) {
      summary.truncatedKeyCount = entries.length - summary.keys.length - sensitiveKeyCount;
    }
    return summary;
  }
  if (typeof value === "string") {
    return { length: value.length, type: "string" };
  }
  return { type: readDebugType(value) };
}

function readDebugType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isSensitiveDebugKey(key) {
  return /api[-_]?key|authorization|bearer|cookie|credential|password|secret|token|x-goog-api-key/i.test(String(key || ""));
}

function parseArgs(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function readString$u(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export { buildGeminiTools, buildOpenAITools, parseToolCallDecision, summarizeToolCallsForDebug };
