import { readString } from './semantic-json.js';

// AGRUN-248-B — Single source of truth for action result envelopes.
//
// Every action.execute(...) result flows through normalizeActionResultEnvelope()
// once. Downstream consumers (handleActionResult, recordObservation, Inspector,
// guardrail refresh, action-executed step detail) read only the envelope shape.
//
// Envelope v1:
//   { resultEnvelopeVersion: "v1", actionName, control, status, ok, kind,
//     summary, reason, metrics: { resultCount, durationMs }, body }
//
// AI-first: runtime validates *mechanical shape* only. Action body is opaque
// pass-through; per-action body schemas are out of scope for v1.


const ACTION_RESULT_ENVELOPE_VERSION = "v1";

const ALLOWED_CONTROLS$2 = Object.freeze(["continue", "stop", "complete"]);
const FALLBACK_BLOCKED_STATUS_VALUES = Object.freeze(
  new Set(["blocked", "failed", "aborted", "denied"])
);

function normalizeActionResultEnvelope({ action, rawResult, durationMs }) {
  const actionName = readActionName$1(action);
  const durationMsNumber = readDurationMs(durationMs);

  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
    return createProtocolErrorEnvelope({
      actionName,
      durationMs: durationMsNumber,
      reason: "envelope_missing_result",
      summary: `${actionName} returned no result object`,
      body: { error: "action_returned_non_object", ok: false }
    });
  }

  const control = readString(rawResult.control);
  const body = rawResult.output && typeof rawResult.output === "object" && !Array.isArray(rawResult.output)
    ? rawResult.output
    : {};
  const summary = readString(rawResult.summary) || `${actionName} executed`;
  const schema = action && action.outputSchema && typeof action.outputSchema === "object"
    ? action.outputSchema
    : null;

  if (!ALLOWED_CONTROLS$2.includes(control)) {
    return createProtocolErrorEnvelope({
      actionName,
      durationMs: durationMsNumber,
      reason: "envelope_invalid_control",
      summary: `${actionName} returned unsupported control "${control || "<empty>"}"`,
      body
    });
  }

  if (schema) {
    const allowedControls = readKindArray(schema.controls);
    if (allowedControls.length > 0 && !allowedControls.includes(control)) {
      return createProtocolErrorEnvelope({
        actionName,
        durationMs: durationMsNumber,
        reason: "envelope_control_mismatch",
        summary: `${actionName} control "${control}" not in declared controls [${allowedControls.join(",")}]`,
        body
      });
    }

    const allowedKinds = readKindArray(schema.kinds);
    const bodyKind = readString(body.kind);
    if (bodyKind && allowedKinds.length > 0 && !allowedKinds.includes(bodyKind)) {
      return createProtocolErrorEnvelope({
        actionName,
        durationMs: durationMsNumber,
        reason: "envelope_kind_mismatch",
        summary: `${actionName} kind "${bodyKind}" not in declared kinds [${allowedKinds.join(",")}]`,
        body
      });
    }
    const envelopeKind = bodyKind || (allowedKinds.length > 0 ? allowedKinds[0] : "");
    if (!envelopeKind) {
      return createProtocolErrorEnvelope({
        actionName,
        durationMs: durationMsNumber,
        reason: "envelope_missing_kind",
        summary: `${actionName} produced no kind and outputSchema declares no fallback`,
        body
      });
    }
    return finalizeEnvelope({
      actionName,
      control,
      kind: envelopeKind,
      schema,
      body,
      summary,
      durationMs: durationMsNumber
    });
  }

  // outputSchema:null waiver path — body kind passes through unchanged.
  const envelopeKind = readString(body.kind) || actionName;
  return finalizeEnvelope({
    actionName,
    control,
    kind: envelopeKind,
    schema: null,
    body,
    summary,
    durationMs: durationMsNumber
  });
}

function createExecuteErrorEnvelope({ action, error, durationMs }) {
  const actionName = readActionName$1(action);
  const errorMessage = readString(error && error.message) || "action_execute_error";
  return finalizeEnvelopeRaw({
    actionName,
    control: "continue",
    status: "protocol_error",
    kind: "action_execute_error",
    summary: `${actionName} failed: ${errorMessage}`,
    reason: "execute_threw",
    metrics: { resultCount: null, durationMs: readDurationMs(durationMs) },
    body: {
      error: errorMessage,
      errorStage: "execute",
      ok: false,
      status: "failed"
    }
  });
}

function createProtocolErrorEnvelope({
  actionName,
  durationMs,
  reason,
  summary,
  body
}) {
  return finalizeEnvelopeRaw({
    actionName: readActionName$1({ name: actionName }),
    control: "continue",
    status: "protocol_error",
    kind: "action_envelope_protocol_error",
    summary: summary || `${actionName} returned a malformed envelope`,
    reason: reason || "envelope_protocol_error",
    metrics: { resultCount: null, durationMs: readDurationMs(durationMs) },
    body: body && typeof body === "object" && !Array.isArray(body)
      ? body
      : { ok: false }
  });
}

function envelopeToObservation(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  if (envelope.status === "protocol_error") {
    const message = readString(envelope.summary)
      || readString(envelope.body && envelope.body.error)
      || `${envelope.actionName} protocol_error`;
    const stage = readString(envelope.body && envelope.body.errorStage)
      || (envelope.reason === "execute_threw" ? "execute" : "envelope");
    return {
      actionName: envelope.actionName,
      kind: "error",
      message,
      output: envelope.body,
      stage
    };
  }
  return {
    actionName: envelope.actionName,
    kind: envelope.control === "continue" ? "continue" : "success",
    output: envelope.body
  };
}

function finalizeEnvelope({ actionName, control, kind, schema, body, summary, durationMs }) {
  const status = deriveStatusFromBody(body);
  const metrics = buildMetrics(schema, body, durationMs);
  return finalizeEnvelopeRaw({
    actionName,
    control,
    status,
    kind,
    summary,
    reason: status === "blocked" ? readString(body && body.reason) || readString(body && body.status) || null : null,
    metrics,
    body
  });
}

function finalizeEnvelopeRaw({
  actionName,
  control,
  status,
  kind,
  summary,
  reason,
  metrics,
  body
}) {
  return Object.freeze({
    resultEnvelopeVersion: ACTION_RESULT_ENVELOPE_VERSION,
    actionName,
    control,
    status,
    ok: status === "success",
    kind,
    summary,
    reason: reason || null,
    metrics: Object.freeze({
      resultCount: metrics && typeof metrics.resultCount === "number" ? metrics.resultCount : null,
      durationMs: metrics && typeof metrics.durationMs === "number" ? metrics.durationMs : 0
    }),
    body
  });
}

function deriveStatusFromBody(body) {
  if (!body || typeof body !== "object") return "success";
  if (body.ok === false) return "blocked";
  const status = readString(body.status).toLowerCase();
  if (status && FALLBACK_BLOCKED_STATUS_VALUES.has(status)) return "blocked";
  return "success";
}

function buildMetrics(schema, body, durationMs) {
  const metricsSchema = schema && schema.metrics && typeof schema.metrics === "object" && !Array.isArray(schema.metrics)
    ? schema.metrics
    : null;
  let resultCount = null;
  if (metricsSchema && typeof metricsSchema.resultCount === "string") {
    resultCount = readMetricPath(body, metricsSchema.resultCount);
  }
  return { resultCount, durationMs };
}

function readMetricPath(body, path) {
  if (!body || typeof body !== "object") return null;
  const segments = String(path).split(".");
  let cursor = body;
  for (const segment of segments) {
    if (!segment) continue;
    if (segment === "length") {
      if (Array.isArray(cursor)) return cursor.length;
      if (typeof cursor === "string") return cursor.length;
      return null;
    }
    if (cursor == null || typeof cursor !== "object") return null;
    cursor = cursor[segment];
  }
  if (typeof cursor === "number" && Number.isFinite(cursor)) return cursor;
  if (Array.isArray(cursor)) return cursor.length;
  return null;
}

function readKindArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry)).filter(Boolean);
}

function readActionName$1(action) {
  return readString(action && action.name) || "unknown_action";
}

function readDurationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export { ACTION_RESULT_ENVELOPE_VERSION, createExecuteErrorEnvelope, createProtocolErrorEnvelope, envelopeToObservation, normalizeActionResultEnvelope };
