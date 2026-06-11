import { normalizeAgentSkill, loadAgentSkillFromProvider, findAgentSkillTool } from '../agent-skills.js';
import { normalizeAliases } from '../action-args-validation.js';
import { getPolicyManifestForSkill, evaluateSkillPolicy, emitSkillPolicyStep, createSkillPolicyError } from '../skill-policy.js';

function createExecuteSkillToolAction(agentSkills, agentSkillIndexProvider, toolCallExamples, options = {}) {
  const firstToolContext = findFirstToolContext(agentSkills);
  const reservedActionNames = normalizeReservedActionNames(options && options.reservedActionNames);

  if (!firstToolContext && !agentSkillIndexProvider) {
    return null;
  }

  const extraExamples = Array.isArray(toolCallExamples) && toolCallExamples.length > 0
    ? toolCallExamples
    : null;

  return Object.freeze({
    description: "Execute a browser-safe tool bundled with the active agent skill or a named bundled skill.",
    name: "execute_skill_tool",
    planner: {
      aliases: ["run_skill_tool", "call_skill_tool", "use_tool"],
      argsExample: extraExamples
        ? { skillName: extraExamples[0].skillName, toolName: extraExamples[0].toolName, args: extraExamples[0].args }
        : {
            args: {},
            skillName: firstToolContext ? firstToolContext.skill.name : "skill-name",
            toolName: firstToolContext ? firstToolContext.tool.name : "tool-name"
          },
      argsSchema: {
        skillName: { type: "string", required: true },
        toolName: { type: "string", required: true },
        args: { type: "object", required: true }
      },
      decisionType: "action",
      extraExamples: extraExamples ? extraExamples.slice(1) : null,
      guidance: "If a bundled skill tool is enough on its own, call execute_skill_tool directly with skillName and toolName. Both skillName and toolName are REQUIRED — always provide them by looking up the correct names from bundledAgentSkills. Do not pass runtime action names such as workspace_publish_candidate as toolName; call that runtime action directly. Use read_agent_skill and use_agent_skill only when the skill instructions must be loaded first. After the tool returns the needed evidence, prefer finalize instead of rerunning the same tool."
    },
    preflight: (context, args) => {
      assertNoReservedRuntimeActionToolName(args, reservedActionNames);
      return prepareExecuteSkillToolInvocation(context, args);
    },
    tier: 0,
    outputSchema: {
      kinds: ["agent_skill_tool_result"],
      controls: ["continue"]
    },
    execute: async (context, args) => {
      assertNoReservedRuntimeActionToolName(args, reservedActionNames);
      await assertEarlyExecuteSkillPolicy(context, args);
      const invocation = await prepareExecuteSkillToolInvocationForExecution(context, args);
      assertExecuteSkillPolicy(context, invocation);
      const debug = context.debug;
      const pushStep = typeof context.pushStep === "function" ? context.pushStep : null;
      const resolvedSkill = invocation.resolvedSkill;
      const resolvedSkillName = invocation.resolvedSkillName;
      const tool = invocation.tool;
      const toolArgs = invocation.toolArgs;

      if (pushStep && Array.isArray(invocation.aliasRewrites) && invocation.aliasRewrites.length > 0) {
        pushStep("action-args-alias-rewrite", {
          actionName: "execute_skill_tool",
          skillName: resolvedSkillName,
          toolName: tool.name,
          rewrites: invocation.aliasRewrites
        });
      }

      if (debug && debug.enabled) {
        debug.log("execute_skill_tool | calling", {
          skill: resolvedSkillName,
          tool: tool.name,
          args: toolArgs
        });
      }

      const result = await tool.func(toolArgs, {
        activeAgentSkill: resolvedSkill,
        agentSkillContext: context.agentSkillContext,
        request: context.request,
        runState: context.runState,
        searchResults: context.searchResults
      });

      if (debug && debug.enabled) {
        debug.log("execute_skill_tool | result", {
          skill: resolvedSkillName,
          tool: tool.name,
          resultType: typeof result,
          resultKeys: result && typeof result === "object" ? Object.keys(result) : null
        });
      }

      const output = {
        args: toolArgs,
        kind: "agent_skill_tool_result",
        result,
        skill: resolvedSkillName,
        tool: tool.name
      };

      // Hoist harness metadata (resultKind + _meta) out of the tool's return
      // value onto the output envelope so the planner sees it as a first-class
      // structured field instead of buried inside result.
      if (result && typeof result === "object" && !Array.isArray(result)) {
        if (typeof result.resultKind === "string" && result.resultKind.trim()) {
          output.resultKind = result.resultKind.trim();
        }
        if (result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)) {
          output._meta = result._meta;
        }
      }
      // Tool declares resultKind in its schema → hoist from schema default.
      if (!output.resultKind && tool.resultKind && typeof tool.resultKind === "string") {
        output.resultKind = tool.resultKind;
      }

      return {
        control: "continue",
        output,
        summary: `execute_skill_tool(${resolvedSkillName}.${tool.name})`
      };
    }
  });
}

function normalizeReservedActionNames(values) {
  const names = Array.isArray(values) ? values : [];
  return new Set(names.map((name) => readString$U(name).toLowerCase()).filter(Boolean));
}

function assertNoReservedRuntimeActionToolName(args, reservedActionNames) {
  const toolName = readString$U(args && args.toolName);
  if (!toolName || !reservedActionNames || !reservedActionNames.has(toolName.toLowerCase())) return;
  throw new Error(
    `execute_skill_tool toolName "${toolName}" is a runtime action, not a bundled skill tool. Call the "${toolName}" action directly with its own args envelope instead of wrapping it in execute_skill_tool.`
  );
}

async function assertEarlyExecuteSkillPolicy(context, args) {
  const requestedSkillName = readString$U(args && args.skillName);
  const toolName = readString$U(args && args.toolName);
  if (!requestedSkillName && !toolName) return;

  const manifest = await getPolicyManifestForSkill(context, requestedSkillName);
  const decision = evaluateSkillPolicy({
    manifest,
    operation: "execute",
    runtimeConfig: context.runtimeConfig,
    skillId: requestedSkillName,
    skillName: requestedSkillName,
    toolName
  });
  if (decision.action === "deny") {
    emitSkillPolicyStep(context.pushStep, "skill-policy-denied", decision);
    throw createSkillPolicyError(decision);
  }
  if (decision.action === "ask" && !isApprovalResolution(context)) {
    emitSkillPolicyStep(context.pushStep, "skill-policy-approval-required", decision);
    throw createSkillPolicyError(decision);
  }
}

function assertExecuteSkillPolicy(context, invocation) {
  const decision = evaluateSkillPolicy({
    manifest: invocation.resolvedSkill,
    operation: "execute",
    runtimeConfig: context.runtimeConfig,
    skill: invocation.resolvedSkill,
    skillId: invocation.resolvedSkill && invocation.resolvedSkill.skillId,
    skillName: invocation.resolvedSkillName,
    tool: invocation.tool,
    toolName: invocation.tool && invocation.tool.name
  });
  if (decision.action === "deny") {
    emitSkillPolicyStep(context.pushStep, "skill-policy-denied", decision);
    throw createSkillPolicyError(decision);
  }
  if (decision.action === "ask" && !isApprovalResolution(context)) {
    emitSkillPolicyStep(context.pushStep, "skill-policy-approval-required", decision);
    throw createSkillPolicyError(decision);
  }
}

function isApprovalResolution(context) {
  return context && context.request && context.request.type === "approval_resolution";
}

function prepareExecuteSkillToolInvocation(context, args) {
  const debug = context.debug;
  const activeSkill = context.activeAgentSkill;
  const normalizedArgs = args && typeof args === "object" && !Array.isArray(args)
    ? { ...args }
    : {};
  let requestedSkillName = readString$U(normalizedArgs.skillName);
  let toolName = readString$U(normalizedArgs.toolName);

  if (debug && debug.enabled) {
    debug.log("execute_skill_tool | resolve start", {
      providedSkillName: requestedSkillName || null,
      providedToolName: toolName || null,
      hasActiveSkill: !!activeSkill,
      activeSkillName: readString$U(activeSkill && activeSkill.name) || null,
      argsKeys: Object.keys(normalizedArgs),
      availableSkills: (context.agentSkills || []).map((s) => ({
        name: s && s.name,
        tools: (s && Array.isArray(s.tools) ? s.tools : []).map((t) => t && t.name)
      }))
    });
  }

  if (!requestedSkillName && toolName) {
    const owner = findSkillByToolName(context.agentSkills, toolName);
    if (owner) {
      requestedSkillName = owner.name;
      normalizedArgs.skillName = requestedSkillName;
      if (debug && debug.enabled) {
        debug.log("execute_skill_tool | reverse-lookup", {
          toolName,
          resolvedSkillName: requestedSkillName
        });
      }
    }
  }

  if (!requestedSkillName && !activeSkill) {
    const inferred = inferSkillTool(context.agentSkills, normalizedArgs, debug);
    if (inferred) {
      requestedSkillName = inferred.skillName;
      toolName = toolName || inferred.toolName;
      normalizedArgs.skillName = requestedSkillName;
      normalizedArgs.toolName = toolName;
      if (!normalizedArgs.args || typeof normalizedArgs.args !== "object" || Object.keys(normalizedArgs.args).length === 0) {
        const toolParams = {};
        for (const key of Object.keys(normalizedArgs)) {
          if (key !== "skillName" && key !== "toolName" && key !== "args" && key !== "reasoning") {
            toolParams[key] = normalizedArgs[key];
          }
        }
        if (Object.keys(toolParams).length > 0) {
          normalizedArgs.args = toolParams;
        }
      }
    }
  }

  const resolvedSkill = requestedSkillName
    ? findSkillByName(context.agentSkills, requestedSkillName)
    : activeSkill;
  const resolvedSkillName = readString$U(resolvedSkill && resolvedSkill.name) || requestedSkillName;

  if (!resolvedSkill || !resolvedSkillName) {
    if (context.agentSkillIndexProvider && requestedSkillName && toolName) {
      return {
        aliasRewrites: [],
        args: normalizedArgs,
        resolvedSkill: null,
        resolvedSkillName: requestedSkillName,
        tool: { name: toolName, parameters: { properties: {}, required: [], type: "object" } },
        toolArgs: normalizeToolArgs(liftFlattenedToolArgs(normalizedArgs, debug))
      };
    }
    if (debug && debug.enabled) {
      debug.log("execute_skill_tool | resolve FAILED", {
        requestedSkillName: requestedSkillName || null,
        toolName: toolName || null,
        hasActiveSkill: !!activeSkill,
        reason: "no skill resolved — neither skillName, activeSkill, nor inference produced a match"
      });
    }
    throw new Error("execute_skill_tool requires an active bundled agent skill or a non-empty skillName.");
  }

  if (!toolName) {
    if (debug && debug.enabled) {
      debug.log("execute_skill_tool | resolve FAILED", {
        resolvedSkillName,
        reason: "toolName is empty after all inference attempts"
      });
    }
    throw new Error("execute_skill_tool requires a non-empty toolName.");
  }

  const tool = findToolInSkill(resolvedSkill, toolName);
  if (!tool) {
    if (debug && debug.enabled) {
      debug.log("execute_skill_tool | tool not found", {
        resolvedSkillName,
        requestedToolName: toolName,
        availableTools: (resolvedSkill.tools || []).map((t) => t && t.name)
      });
    }
    throw new Error(`Bundled agent skill "${resolvedSkillName}" does not define tool "${toolName}".`);
  }

  const rawToolArgs = normalizeToolArgs(liftFlattenedToolArgs(normalizedArgs, debug));
  const validation = validateToolArgs(tool.parameters, rawToolArgs, tool.name);
  const toolArgs = validation.args;

  return {
    aliasRewrites: validation.aliasRewrites,
    args: normalizedArgs,
    resolvedSkill,
    resolvedSkillName,
    tool,
    toolArgs
  };
}

async function prepareExecuteSkillToolInvocationForExecution(context, args) {
  const invocation = prepareExecuteSkillToolInvocation(context, args);
  let resolvedSkill = normalizeAgentSkill(invocation.resolvedSkill);

  if (!resolvedSkill && context.agentSkillIndexProvider) {
    resolvedSkill = await loadAgentSkillFromProvider(
      context.agentSkillIndexProvider,
      invocation.resolvedSkillName
    );
  }

  if (!resolvedSkill) {
    throw new Error(`Bundled agent skill "${invocation.resolvedSkillName || "unknown"}" could not be loaded.`);
  }

  const tool = findAgentSkillTool(resolvedSkill, invocation.tool.name);
  if (!tool) {
    throw new Error(`Bundled agent skill "${resolvedSkill.name}" does not define executable tool "${invocation.tool.name}".`);
  }

  const validation = validateToolArgs(tool.parameters, invocation.toolArgs, tool.name);

  return {
    ...invocation,
    aliasRewrites: [
      ...(Array.isArray(invocation.aliasRewrites) ? invocation.aliasRewrites : []),
      ...(Array.isArray(validation.aliasRewrites) ? validation.aliasRewrites : [])
    ],
    resolvedSkill,
    resolvedSkillName: resolvedSkill.name,
    tool,
    toolArgs: validation.args
  };
}

function findSkillByName(agentSkills, requestedSkillName) {
  const skills = Array.isArray(agentSkills) ? agentSkills : [];
  const target = readString$U(requestedSkillName).toLowerCase();

  if (!target) {
    return null;
  }

  return skills.find((skill) => (
    readString$U(skill && skill.name).toLowerCase() === target ||
    readString$U(skill && skill.skillId).toLowerCase() === target
  )) || null;
}

function findSkillByToolName(agentSkills, toolName) {
  const skills = Array.isArray(agentSkills) ? agentSkills : [];
  const target = readString$U(toolName).toLowerCase();

  if (!target) return null;

  for (const skill of skills) {
    if (!skill || !Array.isArray(skill.tools)) continue;
    if (skill.tools.some((t) => t && readString$U(t.name).toLowerCase() === target)) {
      return skill;
    }
  }

  return null;
}

function findToolInSkill(skill, toolName) {
  const executableTool = findAgentSkillTool(skill, toolName);
  if (executableTool) {
    return executableTool;
  }

  const target = readString$U(toolName).toLowerCase();
  const tools = skill && Array.isArray(skill.tools) ? skill.tools : [];
  return tools.find((tool) => readString$U(tool && tool.name).toLowerCase() === target) || null;
}

function inferSkillTool(agentSkills, args, debug) {
  const skills = Array.isArray(agentSkills) ? agentSkills : [];
  if (!args || typeof args !== "object") return null;

  const candidateKeys = Object.keys(args).filter(
    (k) => k !== "skillName" && k !== "toolName" && k !== "args" && k !== "reasoning"
  );

  if (candidateKeys.length === 0) {
    if (debug && debug.enabled) {
      debug.log("execute_skill_tool | inference skipped", { reason: "no candidate keys in args" });
    }
    return null;
  }

  let bestMatch = null;
  let bestScore = 0;
  let bestParamCount = Infinity;
  const candidates = [];

  for (const skill of skills) {
    if (!skill || !Array.isArray(skill.tools)) continue;

    for (const tool of skill.tools) {
      if (!tool || !tool.name) continue;
      const params = tool.parameters && typeof tool.parameters === "object" && tool.parameters.properties
        ? tool.parameters.properties
        : {};
      const paramKeys = Object.keys(params);
      const score = candidateKeys.filter((k) => paramKeys.includes(k)).length;

      if (score > 0) {
        candidates.push({ skill: skill.name, tool: tool.name, score, paramKeys: paramKeys.length });
      }

      if (score > bestScore || (score === bestScore && score > 0 && paramKeys.length < bestParamCount)) {
        bestScore = score;
        bestParamCount = paramKeys.length;
        bestMatch = { skillName: skill.name, toolName: tool.name };
      }
    }
  }

  // Reject ambiguous inference: if multiple candidates share the best score,
  // the arg-key heuristic cannot reliably distinguish them (e.g. 51 tools all
  // have filters/sortField/sortDir/pageSize). Return null so the action throws
  // a clear error instead of silently picking the wrong tool.
  const tiedCount = candidates.filter(
    (c) => c.score === bestScore && c.paramKeys === bestParamCount
  ).length;

  if (debug && debug.enabled) {
    debug.log("execute_skill_tool | inference result", {
      candidateKeys,
      matches: candidates,
      best: bestMatch,
      bestScore,
      tiedCount
    });
  }

  if (tiedCount > 1) {
    if (debug && debug.enabled) {
      debug.log("execute_skill_tool | inference rejected", {
        reason: `${tiedCount} candidates tied at score ${bestScore} — ambiguous`,
        tied: candidates.filter((c) => c.score === bestScore && c.paramKeys === bestParamCount)
      });
    }
    return null;
  }

  return bestScore >= 1 ? bestMatch : null;
}

function findFirstToolContext(agentSkills) {
  const skills = Array.isArray(agentSkills) ? agentSkills : [];

  for (const skill of skills) {
    if (!skill || !Array.isArray(skill.tools) || skill.tools.length === 0) {
      continue;
    }

    const firstTool = skill.tools[0];
    if (firstTool && typeof firstTool.name === "string" && firstTool.name.trim()) {
      return {
        skill,
        tool: firstTool
      };
    }
  }

  return null;
}

function liftFlattenedToolArgs(args, debug) {
  if (!args || typeof args !== "object") return undefined;

  // If args.args exists and is a non-empty object, use it as-is.
  if (args.args && typeof args.args === "object" && !Array.isArray(args.args) && Object.keys(args.args).length > 0) {
    return args.args;
  }

  // Auto-heal: smaller LLMs sometimes flatten tool params as siblings of
  // skillName/toolName instead of nesting them inside args.args. Lift any
  // keys that aren't execute_skill_tool control keys.
  const CONTROL_KEYS = new Set(["skillName", "toolName", "args", "reasoning"]);
  const lifted = {};
  for (const key of Object.keys(args)) {
    if (!CONTROL_KEYS.has(key)) lifted[key] = args[key];
  }

  if (Object.keys(lifted).length > 0) {
    if (debug && debug.enabled) {
      debug.log("execute_skill_tool | auto-heal flattened args", {
        liftedKeys: Object.keys(lifted)
      });
    }
    return lifted;
  }

  return args.args;
}

function normalizeToolArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function validateToolArgs(parameters, args, toolName) {
  const schema = normalizeParameters(parameters);

  // Opt-in per-property alias rewrite BEFORE required/type checks. Absorbs
  // planner camelCase↔snake_case drift when a tool schema declares
  // `aliases: [...]` on a property; otherwise byte-for-byte identical to
  // pre-feature behaviour.
  const { record, rewrites } = normalizeAliases(schema.properties, args);

  for (const key of schema.required) {
    if (!(key in record)) {
      throw new Error(`Bundled tool "${toolName}" requires argument "${key}".`);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      continue;
    }

    const expectedType = readString$U(schema.properties[key] && schema.properties[key].type);
    if (!expectedType || matchesExpectedType(value, expectedType)) {
      continue;
    }

    throw new Error(
      `Bundled tool "${toolName}" expected argument "${key}" to be ${expectedType}.`
    );
  }

  return { args: record, aliasRewrites: rewrites };
}

function normalizeParameters(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return {
      properties: {},
      required: []
    };
  }

  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties
    : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value) => typeof value === "string" && value.trim())
    : [];

  return {
    properties,
    required
  };
}

function matchesExpectedType(value, expectedType) {
  if (expectedType === "array") {
    return Array.isArray(value);
  }

  if (expectedType === "object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }

  return typeof value === expectedType;
}

function readString$U(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createExecuteSkillToolAction, prepareExecuteSkillToolInvocation };
