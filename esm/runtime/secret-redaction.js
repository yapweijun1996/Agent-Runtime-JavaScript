import { readString } from './semantic-json.js';

// Single source of truth for secret/API-key redaction.
//
// Consolidates what were two independently-drifted redaction implementations:
// llm-trace.js (trace/inspector display path) and provider-error.js
// (provider-error-message classification path). provider-error.js's broader
// pattern set — which additionally catches `gm-`/`AIza` Gemini/Google key
// prefixes and uses lower minimum-length thresholds — is now the canonical
// one used everywhere, closing a real gap where a leaked Gemini-style key
// could reach the trace/inspector output unredacted.

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:sk|gm)-[A-Za-z0-9._~+/-]{3,}/g,
  /gw_[A-Za-z0-9._~+/-]{6,}/g,
  /\b(?:sk|gm|gw_|AIza)[A-Za-z0-9._~+/=-]{6,}\b/g
];
const SECRET_FIELD_PATTERN = /("(?:apiKey|authorization|Authorization|x-goog-api-key)"\s*:\s*")[^"]+(")/g;

function scrubSecretText(value) {
  let scrubbed = typeof value === "string" ? value : "";
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[redacted]");
  }
  scrubbed = scrubbed.replace(SECRET_FIELD_PATTERN, "$1[redacted]$2");
  return scrubbed;
}

function isSecretKey(key) {
  const normalized = readString(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "apikey"
    || normalized.endsWith("apikey")
    || normalized === "authorization"
    || normalized === "bearer"
    || normalized === "token"
    || normalized.endsWith("token")
    || normalized === "secret"
    || normalized.endsWith("secret")
    || normalized === "password"
    || normalized.endsWith("password")
    || normalized === "credential"
    || normalized.endsWith("credential")
    || normalized === "cookie"
    || normalized.endsWith("cookie")
    || normalized === "xgoogapikey";
}

// AGRUN-515 — faithful secret redaction for echoed host input.
//
// Unlike sanitizeTraceValue (a bounded TRACE summarizer that caps arrays/depth
// and rewrites unknowns), this deep-clones `value` preserving its exact shape
// and ONLY replaces secret-keyed fields (apiKey, webSearchApiKey, authorization,
// token, …) with "[redacted]". Used for result.input so the runtime never hands
// a usable provider apiKey back to the host inside the result object (which is
// routinely logged / persisted / shown in an inspector), while keeping prompt /
// provider / model / conversation intact. Shares isSecretKey with the trace
// path — one secret-key definition.
function redactSecretFields(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular omitted]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => redactSecretFields(item, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    // AGRUN-523 — preserve nullish values verbatim even for secret-keyed fields.
    // A redactor must not fabricate a "[redacted]" placeholder where no value
    // ever existed; e.g. a server-auth resume token legitimately carries
    // `apiKey: null` (no client key) and that semantic must survive redaction.
    // Real secrets are always non-null strings, so this never re-exposes one.
    out[key] = isSecretKey(key)
      ? (raw == null ? raw : "[redacted]")
      : redactSecretFields(raw, seen);
  }
  seen.delete(value);
  return out;
}

export { isSecretKey, redactSecretFields, scrubSecretText };
