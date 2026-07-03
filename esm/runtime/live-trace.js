import { sanitizeTraceValue, TRACE_REDACTION_POLICY, summarizeTraceText, sanitizeTraceString, stableTraceHash } from './llm-trace.js';
import { readString } from './semantic-json.js';

const TRACE_JSON_CONTRACT_VERSION = "agrun.trace.v1";

const PHASES = Object.freeze(["observe", "orient", "decide", "act", "evaluate"]);
const SECRET_SAFE_TEXT_LIMIT = 8000;

function buildLiveTraceContract(options = {}) {
  const result = toRecord(options.result);
  const rawInput = readInput(options, result);
  const output = readOutput(options, result);
  const error = readError(options, result);
  const stepEntries = normalizeStepEntries(options.events || options.stepEvents || result.steps || []);
  const startedAtMs = readTimelineStart(options, stepEntries);
  const endedAtMs = readTimelineEnd(options, stepEntries, startedAtMs);
  const trace = stepEntries.map((entry, index) => createTraceItem(entry, index, startedAtMs));
  const meta = createMeta({
    endedAtMs,
    error,
    options,
    output,
    rawInput,
    result,
    startedAtMs,
    trace
  });
  return sanitizeLiveTraceContract({
    meta,
    input: createInputSection(rawInput, meta),
    output: createOutputSection(output, result, error),
    trace,
    otel: {
      spans: createOtelSpans({
        endedAtMs,
        error,
        meta,
        startedAtMs,
        trace
      })
    }
  });
}

function summarizeLiveTrace(traceContract) {
  const contract = toRecord(traceContract);
  const meta = toRecord(contract.meta);
  const output = toRecord(contract.output);
  const trace = Array.isArray(contract.trace) ? contract.trace : [];
  const spans = Array.isArray(toRecord(contract.otel).spans) ? toRecord(contract.otel).spans : [];
  const providerRequests = trace.filter((item) => toRecord(item).providerRequest).length;
  const providerResponses = trace.filter((item) => toRecord(item).providerResponse).length;
  return {
    apiVariant: readString(meta.apiVariant) || null,
    durationMs: readNumber(meta.durationMs),
    geminiThinkingLevel: readString(meta.thinkingLevel) || null,
    outputKind: readString(meta.outputKind) || null,
    provider: readString(meta.provider) || null,
    model: readString(meta.model) || null,
    providerRequests,
    providerResponses,
    reasoningEffort: readString(meta.reasoningEffort) || null,
    spanCount: spans.length,
    status: readString(meta.status) || readString(output.status) || null,
    text: readString(output.text) || readString(output.message) || null,
    traceCount: trace.length
  };
}

function createMeta({ endedAtMs, error, options, output, rawInput, result, startedAtMs, trace }) {
  const outputRecord = toRecord(output);
  const runState = toRecord(result.runState);
  const providerMeta = readProviderMeta(rawInput, trace, outputRecord);
  const status = readString(runState.status)
    || (error ? "failed" : readString(outputRecord.status))
    || "completed";
  const usage = readUsageSummary(outputRecord, trace);
  return {
    schemaVersion: TRACE_JSON_CONTRACT_VERSION,
    generatedAt: new Date(readNumber(options.generatedAtMs) ?? Date.now()).toISOString(),
    source: readString(options.source) || "agrun",
    redaction: TRACE_REDACTION_POLICY,
    runId: readString(runState.runId) || readString(options.runId) || null,
    status,
    provider: providerMeta.provider,
    model: providerMeta.model,
    apiVariant: providerMeta.apiVariant,
    reasoningEffort: providerMeta.reasoningEffort,
    geminiThinkingConfig: providerMeta.geminiThinkingConfig,
    thinkingLevel: providerMeta.thinkingLevel,
    thinkingBudget: providerMeta.thinkingBudget,
    outputKind: readString(outputRecord.kind) || readString(result.finalAnswerSource) || null,
    finalAnswerSource: readString(result.finalAnswerSource || runState.finalAnswerSource) || null,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    stepCount: trace.length,
    usage,
    error: error ? sanitizeError(error) : null
  };
}

function createInputSection(rawInput, meta) {
  const input = toRecord(rawInput);
  const prompt = readString(input.prompt);
  const systemPrompt = readString(input.systemPrompt || input.system);
  const providerRequest = {
    provider: readString(input.provider || input.providerId) || meta.provider || null,
    model: readString(input.model || input.modelId) || meta.model || null,
    apiVariant: readString(input.apiVariant) || meta.apiVariant || null,
    reasoningEffort: readString(input.reasoningEffort) || meta.reasoningEffort || null,
    geminiThinkingConfig: readGeminiThinkingConfig(input) || meta.geminiThinkingConfig || null,
    endpoint: summarizeEndpoint(input.endpoint),
    streamEndpoint: summarizeEndpoint(input.streamEndpoint),
    searchProvider: readString(input.searchProvider) || null,
    webSearchEndpoint: summarizeEndpoint(input.webSearchEndpoint)
  };
  return {
    kind: readString(input.type) || "provider_request",
    prompt: truncateSecretSafeText(prompt, SECRET_SAFE_TEXT_LIMIT),
    promptSummary: summarizeTraceText(sanitizeTraceString(prompt)),
    systemPrompt: systemPrompt ? summarizeTraceText(sanitizeTraceString(systemPrompt)) : null,
    providerRequest,
    rawShape: Object.keys(input).filter((key) => !isSensitiveKey(key)).sort()
  };
}

function createOutputSection(output, result, error) {
  const outputRecord = toRecord(output);
  const runState = toRecord(result.runState);
  const text = readString(outputRecord.text || outputRecord.message);
  return {
    status: readString(runState.status) || (error ? "failed" : "completed"),
    kind: readString(outputRecord.kind) || null,
    finalAnswerSource: readString(result.finalAnswerSource || runState.finalAnswerSource) || null,
    text: truncateSecretSafeText(text, SECRET_SAFE_TEXT_LIMIT),
    textSummary: text ? summarizeTraceText(sanitizeTraceString(text)) : null,
    provider: readString(outputRecord.provider) || null,
    model: readString(outputRecord.model) || null,
    finishReason: readString(outputRecord.finishReason) || null,
    usage: sanitizeTraceValue(outputRecord.usage || null),
    error: error ? sanitizeError(error) : null
  };
}

function createTraceItem(entry, index, startedAtMs) {
  const step = entry.step;
  const detail = toRecord(step.detail);
  const snapshot = toRecord(entry.snapshot);
  const providerRequest = readProviderRequest(detail);
  const providerResponse = readProviderResponse(detail);
  const item = {
    index,
    timestamp: step.timestamp,
    tPlusMs: Math.max(0, entry.timestampMs - startedAtMs),
    phase: readPhase(step.type, detail, snapshot),
    eventType: step.type,
    cycle: readCycle(detail, snapshot, step.type),
    decision: readDecision(detail, step.type),
    action: readAction(detail),
    providerRequest,
    providerResponse,
    // F7 — the model-visible observation projection (scrubbed + capped at the
    // recordObservation funnel). Only observation-recorded steps carry it.
    observationPreview: readString(detail.observationPreview) || null,
    snapshotSummary: createSnapshotSummary(snapshot)
  };

  return sanitizeTraceValue(item);
}

function sanitizeLiveTraceContract(contract) {
  const otel = toRecord(contract.otel);
  return {
    meta: sanitizeTraceValue(contract.meta),
    input: sanitizeTraceValue(contract.input),
    output: sanitizeTraceValue(contract.output),
    trace: Array.isArray(contract.trace)
      ? contract.trace.map((item) => sanitizeTraceValue(item))
      : [],
    otel: {
      spans: Array.isArray(otel.spans)
        ? otel.spans.map((span) => sanitizeTraceValue(span))
        : []
    }
  };
}

function createOtelSpans({ endedAtMs, error, meta, startedAtMs, trace }) {
  const traceId = createTraceId(meta);
  const runSpanId = createSpanId(`${traceId}:agrun.run`);
  const rootAttributes = createCommonSpanAttributes(meta);
  const rootStatus = error || meta.status === "failed" ? createStatus("ERROR", readErrorMessage(error)) : createStatus("OK");
  const spans = [
    createSpan({
      attributes: rootAttributes,
      endMs: endedAtMs,
      events: trace.map((item) => createSpanEvent(item)),
      name: "agrun.run",
      parentSpanId: null,
      spanId: runSpanId,
      startMs: startedAtMs,
      status: rootStatus,
      traceId
    })
  ];
  const cycles = readCycles(trace);

  for (const cycle of cycles) {
    const cycleItems = trace.filter((item) => item.cycle === cycle);
    const cycleStart = firstTimestampFor(cycleItems, startedAtMs, "cycle-started") ?? readFirstEventMs(cycleItems, startedAtMs);
    const cycleEnd = firstTimestampFor(cycleItems, startedAtMs, "cycle-completed")
      ?? firstTimestampFor(cycleItems, startedAtMs, "phase-evaluate-completed")
      ?? readLastEventMs(cycleItems, startedAtMs)
      ?? cycleStart;
    const cycleSpanId = createSpanId(`${traceId}:cycle:${cycle}`);
    spans.push(createSpan({
      attributes: {
        ...rootAttributes,
        "agrun.cycle": cycle
      },
      endMs: Math.max(cycleStart, cycleEnd),
      events: cycleItems.map((item) => createSpanEvent(item)),
      name: `agrun.cycle.${cycle}`,
      parentSpanId: runSpanId,
      spanId: cycleSpanId,
      startMs: cycleStart,
      status: rootStatus,
      traceId
    }));

    for (const phase of PHASES) {
      const phaseItems = cycleItems.filter((item) => item.phase === phase);
      const phaseStart = firstTimestampFor(cycleItems, startedAtMs, `phase-${phase}-started`)
        ?? readFirstEventMs(phaseItems, startedAtMs)
        ?? cycleStart;
      const phaseEnd = firstTimestampFor(cycleItems, startedAtMs, `phase-${phase}-completed`)
        ?? readLastEventMs(phaseItems, startedAtMs)
        ?? phaseStart;
      const phaseSpanId = createSpanId(`${traceId}:cycle:${cycle}:phase:${phase}`);
      spans.push(createSpan({
        attributes: {
          ...rootAttributes,
          "agrun.cycle": cycle,
          "agrun.phase": phase
        },
        endMs: Math.max(phaseStart, phaseEnd),
        events: phaseItems.map((item) => createSpanEvent(item)),
        name: `agrun.${phase}`,
        parentSpanId: cycleSpanId,
        spanId: phaseSpanId,
        startMs: phaseStart,
        status: rootStatus,
        traceId
      }));

      if (phase === "decide") {
        appendLlmSpans(spans, {
          cycle,
          parentSpanId: phaseSpanId,
          phaseItems,
          rootAttributes,
          startedAtMs,
          traceId
        });
      }
    }
  }

  return spans;
}

function appendLlmSpans(spans, options) {
  const llmItems = options.phaseItems.filter((item) => item.providerRequest || item.providerResponse);
  for (const item of llmItems) {
    if (item.providerRequest) {
      const request = toRecord(item.providerRequest);
      const spanId = createSpanId(`${options.traceId}:cycle:${options.cycle}:llm.request:${item.index}`);
      spans.push(createSpan({
        attributes: {
          ...options.rootAttributes,
          "agrun.cycle": options.cycle,
          "llm.request.kind": readString(request.callKind) || "provider_request",
          "llm.request.event_type": item.eventType
        },
        endMs: options.startedAtMs + item.tPlusMs,
        events: [createSpanEvent(item, "llm.request")],
        name: "llm.request",
        parentSpanId: options.parentSpanId,
        spanId,
        startMs: options.startedAtMs + item.tPlusMs,
        status: createStatus("OK"),
        traceId: options.traceId
      }));
    }
    if (item.providerResponse) {
      const response = toRecord(item.providerResponse);
      const metrics = toRecord(response.metrics);
      const latencyMs = readNumber(metrics.latencyMs);
      const totalTokens = readNumber(metrics.totalTokens);
      const spanId = createSpanId(`${options.traceId}:cycle:${options.cycle}:llm.response:${item.index}`);
      spans.push(createSpan({
        attributes: {
          ...options.rootAttributes,
          "agrun.cycle": options.cycle,
          "llm.finish_reason": readString(response.finishReason) || "unknown",
          "llm.latency_ms": latencyMs ?? 0,
          "llm.token.total": totalTokens ?? 0,
          "llm.response.event_type": item.eventType
        },
        endMs: options.startedAtMs + item.tPlusMs,
        events: [createSpanEvent(item, "llm.response")],
        name: "llm.response",
        parentSpanId: options.parentSpanId,
        spanId,
        startMs: Math.max(options.startedAtMs, options.startedAtMs + item.tPlusMs - (latencyMs || 0)),
        status: createStatus((readNumber(response.status) ?? 0) >= 400 ? "ERROR" : "OK"),
        traceId: options.traceId
      }));
    }
  }
}

function createSpan(options) {
  return {
    spanId: options.spanId,
    parentSpanId: options.parentSpanId,
    traceId: options.traceId,
    name: options.name,
    startTime: new Date(options.startMs).toISOString(),
    endTime: new Date(Math.max(options.startMs, options.endMs)).toISOString(),
    attributes: sanitizeTraceValue(options.attributes || {}),
    events: sanitizeTraceValue(options.events || []),
    status: options.status || createStatus("UNSET")
  };
}

function createSpanEvent(item, name) {
  const attributes = {
    "agrun.event_type": item.eventType,
    "agrun.phase": item.phase || "unknown"
  };
  if (Number.isInteger(item.cycle)) attributes["agrun.cycle"] = item.cycle;
  if (item.action) attributes["agrun.action"] = item.action.name || item.action.actionName || item.action.type || "unknown";
  return {
    name: name || item.eventType,
    time: readString(item.timestamp) || new Date(0).toISOString(),
    attributes
  };
}

function createCommonSpanAttributes(meta) {
  const usage = toRecord(meta.usage);
  return {
    "agrun.provider": readString(meta.provider) || "unknown",
    "agrun.model": readString(meta.model) || "unknown",
    "agrun.api_variant": readString(meta.apiVariant) || "unknown",
    "agrun.reasoning_effort": readString(meta.reasoningEffort) || "unspecified",
    "agrun.gemini_thinking_level": readString(meta.thinkingLevel) || "unspecified",
    "agrun.output_kind": readString(meta.outputKind) || "unknown",
    "llm.token.total": readNumber(usage.totalTokens) ?? 0,
    "llm.latency_ms": readNumber(usage.latencyMs) ?? 0
  };
}

function normalizeStepEntries(value) {
  const entries = Array.isArray(value) ? value : [];
  return entries
    .map((entry, index) => normalizeStepEntry(entry, index))
    .filter(Boolean);
}

function normalizeStepEntry(entry, index) {
  const source = toRecord(entry);
  const step = source.step && typeof source.step === "object" ? source.step : source;
  if (!step || typeof step !== "object" || Array.isArray(step)) return null;
  const type = readString(step.type);
  if (!type) return null;
  const timestampMs = readTimestampMs(step.timestamp) ?? readTimestampMs(source.timestamp) ?? Date.now() + index;
  return {
    snapshot: source.snapshot || null,
    step: {
      detail: step.detail == null ? null : step.detail,
      timestamp: new Date(timestampMs).toISOString(),
      type
    },
    timestampMs
  };
}

function readTimelineStart(options, stepEntries) {
  return readTimestampMs(options.startedAt)
    ?? readNumber(options.startedAtMs)
    ?? (stepEntries.length > 0 ? stepEntries[0].timestampMs : Date.now());
}

function readTimelineEnd(options, stepEntries, startedAtMs) {
  return readTimestampMs(options.endedAt)
    ?? readNumber(options.endedAtMs)
    ?? (stepEntries.length > 0 ? stepEntries[stepEntries.length - 1].timestampMs : startedAtMs);
}

function readProviderMeta(rawInput, trace, output) {
  const input = toRecord(rawInput);
  const requestPayloads = trace.map((item) => toRecord(item.providerRequest)).filter((item) => Object.keys(item).length > 0);
  const responsePayloads = trace.map((item) => toRecord(item.providerResponse)).filter((item) => Object.keys(item).length > 0);
  const firstRequest = requestPayloads[0] || {};
  const firstResponse = responsePayloads[0] || {};
  const providerOptions = toRecord(firstRequest.providerOptions || toRecord(firstRequest.payload).providerOptions);
  const openaiOptions = toRecord(providerOptions.openai);
  const googleOptions = toRecord(providerOptions.google);
  const thinkingConfig = readGeminiThinkingConfig(input)
    || toRecord(googleOptions.thinkingConfig)
    || null;
  return {
    provider: readString(input.provider || input.providerId)
      || readString(firstRequest.provider)
      || readString(firstResponse.provider)
      || readString(output.provider)
      || null,
    model: readString(input.model || input.modelId)
      || readString(firstRequest.model)
      || readString(firstResponse.model)
      || readString(output.model)
      || null,
    apiVariant: readString(input.apiVariant) || readString(firstRequest.apiVariant) || null,
    reasoningEffort: readString(input.reasoningEffort)
      || readString(input.openaiReasoningEffort)
      || readString(openaiOptions.reasoningEffort)
      || null,
    geminiThinkingConfig: thinkingConfig && Object.keys(thinkingConfig).length > 0 ? thinkingConfig : null,
    thinkingLevel: readString(input.geminiThinkingLevel)
      || readString(input.thinkingLevel)
      || readString(thinkingConfig && thinkingConfig.thinkingLevel)
      || null,
    thinkingBudget: readNumber(input.thinkingBudget) ?? readNumber(thinkingConfig && thinkingConfig.thinkingBudget)
  };
}

function readProviderRequest(detail) {
  if (detail.requestPayload && typeof detail.requestPayload === "object") return detail.requestPayload;
  if (detail.type === "llm_request_trace") return detail;
  return null;
}

function readProviderResponse(detail) {
  if (detail.responsePayload && typeof detail.responsePayload === "object") return detail.responsePayload;
  if (detail.type === "llm_response_trace") return detail;
  return null;
}

function readDecision(detail, eventType) {
  const decision = detail.decision && typeof detail.decision === "object" ? detail.decision : null;
  if (decision) return decision;
  if (eventType === "planner-responded" || eventType === "planner-native-tool-call") {
    return {
      responseType: readString(detail.responseType) || null,
      source: readString(detail.source) || "planner"
    };
  }
  if (eventType === "phase-decide-completed") {
    return {
      actionName: readString(detail.actionName) || null,
      decisionSource: readString(detail.decisionSource) || null,
      decisionType: readString(detail.decisionType) || null,
      outcome: readString(detail.outcome) || null
    };
  }
  return null;
}

function readAction(detail) {
  const actionName = readString(detail.actionName || detail.name || detail.toolName);
  if (!actionName) return null;
  return {
    name: actionName,
    callId: readString(detail.callId) || null,
    status: readString(detail.status || detail.outcome) || null
  };
}

function createSnapshotSummary(snapshot) {
  const runState = toRecord(snapshot.runState);
  const metrics = toRecord(snapshot.metrics || runState.metrics);
  return {
    runId: readString(snapshot.runId || runState.runId) || null,
    status: readString(snapshot.status || runState.status) || null,
    phase: readString(snapshot.phase || runState.phase) || null,
    currentPhase: readString(toRecord(snapshot.oodae).currentPhase || toRecord(runState.oodae).currentPhase) || null,
    stepCount: readNumber(snapshot.stepCount) ?? readNumber(runState.stepCount),
    cycleCount: readNumber(runState.cycleCount),
    lastAction: readString(runState.lastAction) || null,
    finalAnswerSource: readString(runState.finalAnswerSource) || null,
    metrics: Object.keys(metrics).length > 0 ? metrics : null
  };
}

function readPhase(eventType, detail, snapshot) {
  const explicit = readString(detail.phase || snapshot.phase);
  if (PHASES.includes(explicit)) return explicit;
  const current = readString(toRecord(snapshot.oodae).currentPhase || toRecord(toRecord(snapshot.runState).oodae).currentPhase);
  if (PHASES.includes(current)) return current;
  const match = /^phase-(observe|orient|decide|act|evaluate)-/.exec(eventType);
  if (match) return match[1];
  if (eventType === "planner-requested" || eventType === "planner-responded" || eventType === "planner-native-tool-call" || eventType === "agent-workflow-packet") return "decide";
  if (eventType.startsWith("action-")) return "act";
  if (eventType === "terminal-final-contract-audited" || eventType === "phase-evaluate-completed") return "evaluate";
  if (eventType === "cycle-started" || eventType === "run-started") return "lifecycle";
  return null;
}

function readCycle(detail, snapshot, eventType) {
  if (eventType === "run-started") return null;
  return readNumber(detail.cycle)
    ?? readNumber(toRecord(snapshot.runState).cycleCount)
    ?? null;
}

function readUsageSummary(output, trace) {
  const outputUsage = summarizeUsage(output.usage);
  const responseMetrics = trace
    .map((item) => toRecord(toRecord(item.providerResponse).metrics))
    .filter((metrics) => Object.keys(metrics).length > 0);
  const seed = responseMetrics.length > 0
    ? { inputTokens: 0, latencyMs: 0, outputTokens: 0, totalTokens: 0 }
    : {
      inputTokens: outputUsage.inputTokens || 0,
      latencyMs: 0,
      outputTokens: outputUsage.outputTokens || 0,
      totalTokens: outputUsage.totalTokens || 0
    };
  const totals = responseMetrics.reduce((acc, metrics) => ({
    inputTokens: acc.inputTokens + (readNumber(metrics.inputTokens) || 0),
    latencyMs: acc.latencyMs + (readNumber(metrics.latencyMs) || 0),
    outputTokens: acc.outputTokens + (readNumber(metrics.outputTokens) || 0),
    totalTokens: acc.totalTokens + (readNumber(metrics.totalTokens) || 0)
  }), seed);
  return totals.totalTokens > 0 || totals.inputTokens > 0 || totals.outputTokens > 0 || totals.latencyMs > 0
    ? totals
    : null;
}

function summarizeUsage(value) {
  const usage = toRecord(value);
  const inputTokens = readNumber(usage.prompt_tokens) ?? readNumber(usage.input_tokens) ?? readNumber(usage.promptTokenCount) ?? readNumber(usage.inputTokens);
  const outputTokens = readNumber(usage.completion_tokens) ?? readNumber(usage.output_tokens) ?? readNumber(usage.candidatesTokenCount) ?? readNumber(usage.outputTokens);
  const totalTokens = readNumber(usage.total_tokens) ?? readNumber(usage.totalTokenCount) ?? readNumber(usage.totalTokens)
    ?? (inputTokens != null || outputTokens != null ? (inputTokens || 0) + (outputTokens || 0) : null);
  return { inputTokens, outputTokens, totalTokens };
}

function readCycles(trace) {
  const cycles = [...new Set(trace.map((item) => item.cycle).filter(Number.isInteger))].sort((a, b) => a - b);
  return cycles.filter((cycle) => cycle > 0 || trace.some((item) => item.cycle === cycle && PHASES.includes(item.phase)));
}

function firstTimestampFor(items, startedAtMs, eventType) {
  const item = items.find((entry) => entry.eventType === eventType);
  return item ? startedAtMs + item.tPlusMs : null;
}

function readFirstEventMs(items, startedAtMs) {
  if (!items.length) return null;
  return startedAtMs + Math.min(...items.map((item) => item.tPlusMs));
}

function readLastEventMs(items, startedAtMs) {
  if (!items.length) return null;
  return startedAtMs + Math.max(...items.map((item) => item.tPlusMs));
}

function readInput(options, result) {
  return options.input || options.rawInput || result.input || {};
}

function readOutput(options, result) {
  if (options.output && typeof options.output === "object") return options.output;
  return result.output && typeof result.output === "object" ? result.output : {};
}

function readError(options, result) {
  return options.error || result.error || null;
}

function sanitizeError(error) {
  const record = toRecord(error);
  return sanitizeTraceValue({
    cause: record.cause || null,
    code: readString(record.code) || null,
    details: record.details ?? null,
    message: readErrorMessage(error)
  });
}

function readErrorMessage(error) {
  if (!error) return null;
  if (typeof error === "string") return sanitizeTraceString(error);
  return sanitizeTraceString(toRecord(error).message || "run failed");
}

function createStatus(code, message) {
  const status = { code };
  if (message) status.message = message;
  return status;
}

function createTraceId(meta) {
  return `${stableTraceHash(`${meta.runId || ""}:${meta.startedAt}:${meta.provider}:${meta.model}`)}${stableTraceHash(`${meta.status}:${meta.endedAt}:${meta.stepCount}`)}`
    .padEnd(32, "0")
    .slice(0, 32);
}

function createSpanId(seed) {
  return stableTraceHash(seed).padEnd(16, "0").slice(0, 16);
}

function readGeminiThinkingConfig(value) {
  const record = toRecord(value);
  const direct = toRecord(record.geminiThinkingConfig || record.thinkingConfig);
  const nested = toRecord(toRecord(toRecord(record.providerOptions).google).thinkingConfig);
  const config = Object.keys(direct).length > 0 ? direct : nested;
  const topLevel = {};
  if (readString(record.thinkingLevel)) topLevel.thinkingLevel = readString(record.thinkingLevel);
  if (readNumber(record.thinkingBudget) != null) topLevel.thinkingBudget = readNumber(record.thinkingBudget);
  return Object.keys(topLevel).length > 0
    ? { ...config, ...topLevel }
    : (Object.keys(config).length > 0 ? config : null);
}

function summarizeEndpoint(value) {
  const endpoint = readString(value);
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return { origin: url.origin, path: url.pathname || "/" };
  } catch {
    return { origin: endpoint.replace(/[?#].*$/u, ""), path: null };
  }
}

function truncateSecretSafeText(value, max) {
  const text = sanitizeTraceString(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function readTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isSensitiveKey(key) {
  return /(?:api[_-]?key|authorization|bearer|token|secret|password|credential|cookie|x-goog-api-key)/i.test(key);
}

export { TRACE_JSON_CONTRACT_VERSION, buildLiveTraceContract, summarizeLiveTrace };
