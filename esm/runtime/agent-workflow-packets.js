import { summarizeToolCallsForDebug } from './planner-tools.js';
import { createProviderRequestTrace, createProviderResponseTrace, summarizeTraceText } from './llm-trace.js';

const MAX_NAMES = 20;

function createPlannerRequestPacket(options = {}) {
  const request = options.request && typeof options.request === "object" ? options.request : {};
  const runState = options.runState && typeof options.runState === "object" ? options.runState : {};
  const modeSelection = runState.plannerModeSelection && typeof runState.plannerModeSelection === "object"
    ? runState.plannerModeSelection
    : {};
  const actions = Array.isArray(options.availableActions) ? options.availableActions : [];
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const prompt = readString$s(options.prompt);
  const systemPrompt = readString$s(options.systemPrompt);
  return {
    availableActions: actions.map((action) => readString$s(action && action.name)).filter(Boolean).slice(0, MAX_NAMES),
    availableActionCount: actions.length,
    activeSkill: readSkillName(options.activeAgentSkill || (runState.agentSkillContext && runState.agentSkillContext.activeSkill)),
    callKind: "planner_request",
    packetId: createPacketId(runState, options.mode || "planner"),
    plannerMode: readString$s(options.mode) || readString$s(modeSelection.effectiveMode) || "n/a",
    plannerModeReason: readString$s(modeSelection.reason) || "n/a",
    provider: readString$s(request.provider) || "n/a",
    model: readString$s(request.model) || "n/a",
    prompt: summarizeTextPayload(prompt),
    requestPayload: createProviderRequestTrace({
      apiVariant: request.apiVariant,
      authMode: request.authMode,
      callKind: "planner_request",
      endpoint: request.endpoint,
      messages: [{ role: "user", content: prompt }],
      model: request.model,
      prompt,
      provider: request.provider,
      providerOptions: options.providerOptions || null,
      sessionContext: options.sessionContext || null,
      system: systemPrompt,
      toolChoice: options.toolChoice,
      tools
    }),
    readSources: summarizeReadSources(runState.researchContext && runState.researchContext.readSources),
    systemPrompt: summarizeTextPayload(systemPrompt),
    toolChoice: readString$s(options.toolChoice) || null,
    tools: summarizeTools(tools),
    virtualWorkspace: summarizeVirtualWorkspace(runState.virtualWorkspace)
  };
}

function createPlannerResponsePacket(options = {}) {
  const response = options.response && typeof options.response === "object" ? options.response : {};
  const decision = options.decision && typeof options.decision === "object" ? options.decision : null;
  const runState = options.runState && typeof options.runState === "object" ? options.runState : {};
  return {
    callKind: "planner_response",
    decision: summarizeDecision(decision),
    finishReason: readString$s(response.finishReason) || null,
    packetId: createPacketId(runState, options.mode || "planner"),
    parse: {
      parseError: readString$s(options.parseError) || null,
      rejection: compactRejection(options.rejection),
      repairPath: readString$s(options.repairPath) || "none",
      responseType: readString$s(options.responseType) || inferResponseType(response, decision)
    },
    provider: readString$s(options.provider) || readString$s(options.request && options.request.provider) || "n/a",
    model: readString$s(options.model) || readString$s(options.request && options.request.model) || "n/a",
    responsePayload: createProviderResponseTrace({
      durationMs: options.durationMs || response.durationMs,
      finishReason: response.finishReason,
      model: readString$s(options.model) || readString$s(options.request && options.request.model) || "n/a",
      provider: readString$s(options.provider) || readString$s(options.request && options.request.provider) || "n/a",
      response: response.raw,
      status: response.status,
      text: response.text,
      toolCalls: response.toolCalls,
      usage: response.usage
    }),
    text: summarizeTextPayload(response.text),
    toolCalls: summarizeToolCallsForDebug(response.toolCalls)
  };
}

function compactRejection(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const compact = {
    reason: readString$s(source.reason) || null,
    type: readString$s(source.type) || null
  };
  const rejectedActionName = readString$s(source.rejectedActionName);
  if (rejectedActionName) compact.rejectedActionName = rejectedActionName;
  const message = readString$s(source.message);
  if (message) compact.message = summarizeTraceText(message, 240);
  if (Number.isFinite(source.availableActionCount)) {
    compact.availableActionCount = source.availableActionCount;
  }
  if (Array.isArray(source.invalidActions) && source.invalidActions.length > 0) {
    compact.invalidActions = source.invalidActions.slice(0, 5).map((item) => compactRejection(item));
  }
  return compact;
}

function createPacketId(runState, mode) {
  const runId = readString$s(runState && runState.runId) || "run";
  const cycle = Number.isInteger(runState && runState.cycleCount) ? runState.cycleCount : 0;
  return `${runId}:${cycle}:${readString$s(mode) || "planner"}`;
}

function summarizeTools(tools) {
  const names = [];
  for (const group of tools) {
    if (group && Array.isArray(group.functionDeclarations)) {
      for (const declaration of group.functionDeclarations) {
        const name = readString$s(declaration && declaration.name);
        if (name) names.push(name);
      }
      continue;
    }
    const name = readString$s(group && group.name);
    if (name) names.push(name);
  }
  return {
    count: names.length,
    names: names.slice(0, MAX_NAMES)
  };
}

function summarizeTextPayload(value) {
  return summarizeTraceText(value, 160);
}

function summarizeReadSources(value) {
  const sources = Array.isArray(value) ? value : [];
  const latest = sources.length > 0 && sources[sources.length - 1] && typeof sources[sources.length - 1] === "object"
    ? sources[sources.length - 1]
    : null;
  return {
    count: sources.length,
    latest: latest ? {
      ok: latest.ok !== false,
      status: typeof latest.status === "number" ? latest.status : null,
      tier: readString$s(latest.tier) || null,
      url: readString$s(latest.url) || null
    } : null,
    successful: sources.filter((source) => source && typeof source === "object" && source.ok !== false).length
  };
}

function summarizeVirtualWorkspace(value) {
  if (!value || typeof value !== "object" || value.enabled !== true) {
    return {
      enabled: false,
      fileCount: 0,
      finalCandidateReady: false,
      finalCandidateStats: null
    };
  }
  const files = value.files && typeof value.files === "object" && !Array.isArray(value.files)
    ? value.files
    : {};
  const quality = value.quality && typeof value.quality === "object" ? value.quality : {};
  return {
    enabled: true,
    fileCount: Object.keys(files).length,
    finalCandidateReady: quality.finalCandidateReady === true,
    finalCandidateStats: normalizeTextStats(quality.finalCandidateStats)
  };
}

function summarizeDecision(decision) {
  if (!decision) return null;
  const finalReadiness = decision.finalReadiness && typeof decision.finalReadiness === "object"
    ? {
      decision: readString$s(decision.finalReadiness.decision) || null,
      evidenceMode: readString$s(decision.finalReadiness.evidenceMode) || null,
      limitations: summarizeTextPayload(decision.finalReadiness.limitations),
      requirementsAssessment: summarizeRequirementsAssessment(
        decision.finalReadiness.requirementsAssessment || decision.finalReadiness.selfAudit
      )
    }
    : null;
  return {
    actionName: readString$s(decision.name || decision.actionName) || null,
    finalReadiness,
    instruction: summarizeTextPayload(decision.instruction || decision.synthesize_instruction),
    reasoning: summarizeTextPayload(decision.reasoning),
    type: readString$s(decision.type) || null
  };
}

function summarizeRequirementsAssessment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    checkedReadUrlEvidence: value.checkedReadUrlEvidence === true,
    checkedWorkspaceStats: value.checkedWorkspaceStats === true,
    evidenceSatisfied: typeof value.evidenceSatisfied === "boolean" ? value.evidenceSatisfied : null,
    lengthSatisfied: typeof value.lengthSatisfied === "boolean" ? value.lengthSatisfied : null,
    observedLength: readNumberOrNull(value.observedLength) ?? readNumberOrNull(value.actualLength),
    observedLengthUnit: readString$s(value.observedLengthUnit || value.lengthUnit) || null,
    requestedLength: readNumberOrNull(value.requestedLength),
    requirementSatisfied: typeof value.requirementSatisfied === "boolean" ? value.requirementSatisfied : null,
    summary: readString$s(value.summary) || null,
    successfulReadUrlCount: readNumberOrNull(value.successfulReadUrlCount)
  };
}

function inferResponseType(response, decision) {
  if (Array.isArray(response.toolCalls) && response.toolCalls.length > 0) return "tool_call";
  if (decision) return readString$s(decision.type) || "parsed";
  if (readString$s(response.text)) return "text";
  return "empty";
}

function normalizeTextStats(value) {
  const source = value && typeof value === "object" ? value : {};
  const hasAny = ["chars", "nonWhitespaceChars", "cjkChars", "words"].some((key) => Number.isFinite(source[key]));
  if (!hasAny) return null;
  return {
    chars: readNumber$3(source.chars),
    cjkChars: readNumber$3(source.cjkChars),
    nonWhitespaceChars: readNumber$3(source.nonWhitespaceChars),
    words: readNumber$3(source.words)
  };
}

function readSkillName(skill) {
  if (!skill || typeof skill !== "object") return null;
  return readString$s(skill.name || skill.id || skill.skillId) || null;
}

function readNumber$3(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString$s(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createPlannerRequestPacket, createPlannerResponsePacket };
