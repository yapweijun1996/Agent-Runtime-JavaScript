import { requestSemanticJudge } from './semantic-judge.js';
import { USE_AGENT_SKILL_ACTION, EXECUTE_SKILL_TOOL_ACTION, READ_URL_ACTION } from './action-names.js';
import { readString, parseLooseJsonValue, readObject } from './semantic-json.js';
import { buildEnvelopeLines, readEnvelopeTerminalPolicy } from './planner-envelope-lines.js';
import { normalizeFinalReadiness } from './final-readiness.js';

function parsePlannerEnvelope(text) {
  const value = parseLooseJsonValue(text);
  return readObject(value);
}

function repairPlannerEnvelope(value, options) {
  const envelope = applyDeterministicPlannerGuards(
    normalizePlannerEnvelope(value, options),
    options
  );
  if (!isPlannerEnvelope(envelope)) {
    return null;
  }
  if (shouldRejectTerminalEnvelope(envelope, options)) {
    return null;
  }
  return envelope;
}

function diagnosePlannerEnvelopeRejection(value, options = {}) {
  const record = readObject(value);
  if (!record) {
    return {
      reason: "not_object",
      type: null
    };
  }

  const type = normalizeType(record);
  if (!type) {
    return {
      reason: "missing_type_or_action",
      type: null,
      rejectedActionName: readString(record.name || record.action || record.tool || record.toolName) || null
    };
  }

  if (type === "final") {
    return readString(record.answer) || readString(record.text)
      ? { reason: "accepted", type }
      : { reason: "missing_final_answer", type };
  }

  if (type === "clarify") {
    return readString(record.question) || readString(record.text)
      ? { reason: "accepted", type }
      : { reason: "missing_clarify_question", type };
  }

  if (type === "finalize") {
    const envelope = normalizePlannerEnvelope(record, options);
    return shouldRejectTerminalEnvelope(envelope, options)
      ? { reason: "terminal_finalize_not_allowed", type }
      : { reason: "accepted", type };
  }

  if (type === "plan") {
    const invalidActions = [];
    const actions = normalizePlanActions(record.actions, {
      ...options,
      onInvalidAction(detail) {
        invalidActions.push(diagnosePlanAction(detail, options));
      }
    });
    return actions.length > 0
      ? { reason: "accepted", type, invalidActions: invalidActions.slice(0, 5) }
      : {
          reason: Array.isArray(record.actions) ? "plan_has_no_valid_actions" : "plan_actions_not_array",
          type,
          invalidActions: invalidActions.slice(0, 8)
        };
  }

  const rejectedActionName = readString(record.name || record.action || record.tool || record.toolName).toLowerCase();
  const name = normalizeActionName(record, options);
  if (!name) {
    return {
      reason: rejectedActionName ? "unknown_action_name" : "missing_action_name",
      type,
      rejectedActionName,
      availableActionCount: Array.isArray(options.availableActions) ? options.availableActions.length : 0
    };
  }

  const normalized = normalizePlannerEnvelope(record, options);
  const guarded = applyDeterministicPlannerGuards(normalized, options);
  if (!guarded) {
    return {
      reason: "deterministic_guard_rejected",
      type,
      rejectedActionName: name
    };
  }

  return { reason: "accepted", type, rejectedActionName: name };
}

async function requestPlannerEnvelopeRepair(options) {
  const envelopeOptions = {
    effectivePlannerMode: options && options.effectivePlannerMode,
    plannerMode: options && options.plannerMode,
    request: options && options.request,
    runState: options && options.runState,
    todoState: options && options.todoState,
    // AGRUN-551 — forward the publish-gate inputs so allowFinalize matches the
    // gate: the finalize example must appear in the repair prompt whenever
    // publish is gated (otherwise the prompt and the rejection check desync).
    runtimeConfig: options && options.runtimeConfig,
    activeAgentSkill: options && options.activeAgentSkill,
    lastReadAgentSkill: options && options.lastReadAgentSkill
  };
  const envelopeExamples = buildEnvelopeLines(options && options.availableActions, envelopeOptions);
  const terminalPolicy = readEnvelopeTerminalPolicy(options && options.availableActions, envelopeOptions);
  const repairSystemPrompt = [
    "You repair invalid planner envelopes for agrun.js.",
    "Return exactly one valid planner JSON envelope and nothing else.",
    "Do not invent unsupported actions.",
    terminalPolicy.allowFinalize
      ? "If the answer should stop without tools, use final or finalize."
      : "If the answer should stop without tools, use final. Do not return finalize in this context."
  ].join("\n");
  const hostSystemPrompt = readString(options && options.systemPrompt);
  const systemPrompt = hostSystemPrompt
    ? [hostSystemPrompt, "", repairSystemPrompt].join("\n")
    : repairSystemPrompt;
  const prompt = [
    "Available actions:",
    JSON.stringify(
      (Array.isArray(options && options.availableActions) ? options.availableActions : []).map((action) => ({
        argsExample: action.argsExample || {},
        name: action.name
      })),
      null,
      2
    ),
    "",
    ...envelopeExamples,
    "",
    "Planner prompt:",
    readString(options && options.plannerPrompt) || "None",
    "",
    "Invalid planner output to repair:",
    readString(options && options.responseText) || "None"
  ].join("\n");
  const { response, text, value } = await requestSemanticJudge(options.request, {
    prompt,
    systemPrompt
  });
  const decision = repairPlannerEnvelope(value, options);

  return {
    decision,
    rejection: decision ? null : diagnosePlannerEnvelopeRejection(value, options),
    response,
    text
  };
}

function normalizePlannerEnvelope(value, options) {
  const record = readObject(value);

  if (!record) {
    return null;
  }

  const type = normalizeType(record);
  if (!type) {
    return null;
  }

  if (type === "final") {
    const answer = readString(record.answer) || readString(record.text);
    return answer
      ? {
          answer,
          citations: Array.isArray(record.citations) ? record.citations : [],
          finalReadiness: normalizeFinalReadiness(record.finalReadiness),
          reasoning: readString(record.reasoning),
          type
        }
      : null;
  }

  if (type === "clarify") {
    const question = readString(record.question) || readString(record.text);
    return question
      ? {
          question,
          reasoning: readString(record.reasoning),
          type
        }
      : null;
  }

  if (type === "finalize") {
    return {
      finalReadiness: normalizeFinalReadiness(record.finalReadiness),
      instruction: readString(record.instruction) || readString(record.answer) || readString(record.text),
      reasoning: readString(record.reasoning),
      type
    };
  }

  if (type === "plan") {
    const actions = normalizePlanActions(record.actions, options);
    return actions.length > 0
      ? {
          actions,
          finalReadiness: normalizeFinalReadiness(record.finalReadiness),
          partial_ok: record.partial_ok === true,
          reasoning: readString(record.reasoning),
          stitch: normalizeStitch$1(record.stitch),
          synthesize_per_action: record.synthesize_per_action === true,
          synthesize_instruction: readString(record.synthesize_instruction) || readString(record.instruction),
          type
        }
      : null;
  }

  const name = normalizeActionName(record, options);
  if (!name) {
    return null;
  }

  return {
    args: readPlannerArgs(record),
    name,
    reasoning: readString(record.reasoning),
    type
  };
}

function normalizeType(record) {
  const explicitType = readString(record.type || record.kind || record.decisionType);

  if (
    explicitType === "action" ||
    explicitType === "clarify" ||
    explicitType === "final" ||
    explicitType === "finalize" ||
    explicitType === "plan"
  ) {
    return explicitType;
  }

  if (Array.isArray(record.actions)) {
    return "plan";
  }

  if (readString(record.answer)) {
    return "final";
  }

  if (readString(record.question)) {
    return "clarify";
  }

  if (readString(record.instruction)) {
    return "finalize";
  }

  if (readString(record.name || record.action || record.tool || record.toolName)) {
    return "action";
  }

  return "";
}

function normalizeActionName(record, options) {
  const candidate = readString(record.name || record.action || record.tool || record.toolName).toLowerCase();
  if (!candidate) {
    return "";
  }

  const actions = Array.isArray(options && options.availableActions) ? options.availableActions : [];
  for (const action of actions) {
    if (action.name === candidate) {
      return action.name;
    }

    if (Array.isArray(action.aliases) && action.aliases.includes(candidate)) {
      return action.name;
    }
  }

  // AGRUN-615 — a name absent from the OFFERED surface only because a static
  // policy denies it (selectPlannerActions, planner-action-surface.js) is a
  // real, registered action, not a hallucinated one. Accept it here so the
  // decision reaches normal dispatch, where the execution-side policy check
  // (handlePolicyDenied) applies the graceful, AGRUN-562-shaped denial —
  // instead of this validator rejecting it as unknown_action_name and
  // burning a repair cycle the model can never resolve (the action is
  // permanently denied; no repaired envelope makes it available).
  const deniedNames = Array.isArray(options && options.policyDeniedActionNames)
    ? options.policyDeniedActionNames
    : [];
  if (deniedNames.includes(candidate)) {
    return candidate;
  }

  return "";
}

function readPlannerArgs(record) {
  if (record.args && typeof record.args === "object" && !Array.isArray(record.args)) {
    return record.args;
  }

  if (record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)) {
    return record.arguments;
  }

  return {};
}

function normalizePlanActions(actions, options) {
  if (!Array.isArray(actions)) {
    return [];
  }

  const onInvalidAction = typeof options?.onInvalidAction === "function"
    ? options.onInvalidAction
    : null;

  const normalized = [];
  for (const item of actions) {
    const record = readObject(item);
    if (!record || normalizeType(record) !== "action") {
      if (onInvalidAction) onInvalidAction({ reason: "shape", record: item });
      continue;
    }
    const name = normalizeActionName(record, options);
    if (!name) {
      if (onInvalidAction) onInvalidAction({ reason: "unknown_action_name", record });
      continue;
    }
    normalized.push({
      args: readPlannerArgs(record),
      name,
      reasoning: readString(record.reasoning),
      section: normalizeSection$1(record.section),
      type: "action"
    });
  }
  return normalized;
}

function diagnosePlanAction(detail, options) {
  const record = readObject(detail && detail.record);
  const rejectedActionName = readString(record && (record.name || record.action || record.tool || record.toolName)).toLowerCase();
  return {
    reason: readString(detail && detail.reason) || "invalid_plan_action",
    rejectedActionName: rejectedActionName || null,
    availableActionCount: Array.isArray(options && options.availableActions) ? options.availableActions.length : 0
  };
}

function normalizeSection$1(section) {
  const record = readObject(section);
  if (!record) {
    return null;
  }
  return {
    prompt: readString(record.prompt),
    title: readString(record.title)
  };
}

function normalizeStitch$1(stitch) {
  const record = readObject(stitch);
  if (!record) {
    return null;
  }
  return {
    drill_hints: Array.isArray(record.drill_hints) ? record.drill_hints : [],
    followups: Array.isArray(record.followups)
      ? record.followups.filter((item) => typeof item === "string")
      : [],
    intro_prompt: readString(record.intro_prompt),
    outro_prompt: readString(record.outro_prompt),
    provenance: readString(record.provenance)
  };
}

function isPlannerEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  if (value.type === "final") {
    return readString(value.answer).length > 0;
  }

  if (value.type === "clarify") {
    return readString(value.question).length > 0;
  }

  if (value.type === "finalize") {
    return true;
  }

  if (value.type === "plan") {
    return Array.isArray(value.actions) && value.actions.length > 0;
  }

  return value.type === "action" && readString(value.name).length > 0;
}

function shouldRejectTerminalEnvelope(envelope, options) {
  if (!envelope || envelope.type !== "finalize") {
    return false;
  }
  const terminalPolicy = readEnvelopeTerminalPolicy(options && options.availableActions, {
    effectivePlannerMode: options && options.effectivePlannerMode,
    plannerMode: options && options.plannerMode,
    request: options && options.request,
    runState: options && options.runState,
    todoState: options && options.todoState,
    // AGRUN-551 — forward the publish-gate inputs so the finalize REJECTION check
    // agrees with the prompt: when publish is gated, finalize must NOT be rejected.
    runtimeConfig: options && options.runtimeConfig,
    activeAgentSkill: options && options.activeAgentSkill,
    lastReadAgentSkill: options && options.lastReadAgentSkill
  });
  return terminalPolicy.allowFinalize === false;
}

function applyDeterministicPlannerGuards(envelope, options) {
  if (!envelope || envelope.type !== "action") {
    return envelope;
  }

  if (
    envelope.name === USE_AGENT_SKILL_ACTION &&
    isAlreadyActiveSkill(envelope.args && envelope.args.skillName, options && options.activeAgentSkill)
  ) {
    return {
      instruction: "The requested skill is already active. Use the current active skill context to answer directly.",
      reasoning: readString(envelope.reasoning) || "Requested bundled agent skill is already active.",
      type: "finalize"
    };
  }

  if (
    envelope.name === EXECUTE_SKILL_TOOL_ACTION &&
    isMissingRequiredSkillToolFields(envelope.args, options && options.activeAgentSkill)
  ) {
    // Missing skillName AND toolName with no active skill — envelope is invalid.
    // Return null to trigger the repair cascade so the model retries with correct fields.
    return null;
  }

  if (
    envelope.name === EXECUTE_SKILL_TOOL_ACTION &&
    hasReusableToolResult(envelope.args, options && options.toolContext)
  ) {
    return {
      instruction: "The requested bundled tool result is already available. Use the existing tool evidence to answer directly.",
      reasoning: readString(envelope.reasoning) || "Requested bundled skill tool result is already available.",
      type: "finalize"
    };
  }

  if (
    envelope.name === READ_URL_ACTION &&
    hasReadableSourceForUrl(envelope.args && envelope.args.url, options && options.readSources)
  ) {
    return {
      instruction: "Read URL evidence is already available. Use the current source content to answer directly.",
      reasoning: readString(envelope.reasoning) || "Requested URL content is already available.",
      type: "finalize"
    };
  }

  return envelope;
}

function isMissingRequiredSkillToolFields(args, activeAgentSkill) {
  // If an active skill exists, the action handler can resolve from it — allow.
  if (activeAgentSkill && typeof activeAgentSkill === "object" && readString(activeAgentSkill.name)) {
    return false;
  }

  const skillName = readString(args && args.skillName);
  const toolName = readString(args && args.toolName);

  // Both missing — inference fallback cannot reliably distinguish tools.
  return !skillName && !toolName;
}

function isAlreadyActiveSkill(requestedSkillName, activeAgentSkill) {
  const requested = readString(requestedSkillName).toLowerCase();
  const active = readString(activeAgentSkill && activeAgentSkill.name).toLowerCase();
  return Boolean(requested && active && requested === active);
}

function hasReusableToolResult(args, toolContext) {
  const lastResult = toolContext && typeof toolContext === "object" ? toolContext.lastResult : null;
  if (!lastResult || typeof lastResult !== "object") {
    return false;
  }

  // Error results are not reusable — the planner should be allowed to retry
  // the same tool with corrected arguments (self-correction).
  const inner = lastResult.result;
  if (inner && typeof inner === "object" && (inner.ok === false || typeof inner.error === "string")) {
    return false;
  }

  const lastTool = readString(lastResult.tool).toLowerCase();
  if (!lastTool) {
    return false;
  }

  const requestedTool = readString(args && args.toolName).toLowerCase();

  // Exact match: planner explicitly requests the same tool that already ran.
  if (requestedTool && requestedTool === lastTool) {
    return true;
  }

  // No toolName specified: the action would resolve via fallback inference to the
  // same tool that already produced lastResult. Force finalize to break the loop.
  // If the planner genuinely needs a different tool, it must specify toolName explicitly.
  if (!requestedTool) {
    return true;
  }

  return false;
}

function hasReadableSourceForUrl(url, readSources) {
  const normalizedUrl = readString(url).toLowerCase();
  if (!normalizedUrl) {
    return false;
  }

  return (Array.isArray(readSources) ? readSources : []).some((item) => {
    const sourceUrl = readString(item && item.url).toLowerCase();
    return sourceUrl === normalizedUrl;
  });
}

export { diagnosePlannerEnvelopeRejection, parsePlannerEnvelope, repairPlannerEnvelope, requestPlannerEnvelopeRepair };
