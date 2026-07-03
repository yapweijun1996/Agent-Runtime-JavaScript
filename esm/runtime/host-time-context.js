// AGRUN-518 — host-provided time context. A general frontend runtime cannot
// rely on the model to infer the exact current time (a live multi-turn smoke
// returned 2026-06-14 00:00:00 MYT while the real clock was 19:25 +08). Rather
// than add a tool round-trip for "what time is it", the host can OPT IN by
// passing a `timeContext` field on the run input; the runtime surfaces it as a
// trusted read-only signal in the planner prompt so the model uses real host
// time instead of guessing.
//
// PRIVACY / HOST RESPONSIBILITY: this is opt-in. When the host omits
// `timeContext`, NOTHING is injected — the model never sees a clock. The host
// decides what time/timezone to expose and bears responsibility for its
// accuracy; the runtime never reads the wall clock on the host's behalf.
//
// Pure, dependency-free so both the request normalizer (src/skills/providers)
// and the planner-prompt builder (src/runtime) can import it without a cycle.

// Normalize a host-supplied time context into { currentTime, timezone } or null.
// Accepts an ISO/string time under currentTime|now|iso|time, a Date, or epoch ms.
// timezone is an optional IANA string (timezone|timeZone).
function normalizeTimeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const currentTime = readTimeValue(
    value.currentTime !== undefined ? value.currentTime
      : value.now !== undefined ? value.now
      : value.iso !== undefined ? value.iso
      : value.time
  );
  if (!currentTime) return null;
  const timezone = readTimezone(value.timezone) || readTimezone(value.timeZone);
  return { currentTime, timezone };
}

// Compact, self-describing projection for the planner loopState. Returns null
// when no usable time context is present so callers can omit the field entirely.
function summarizeTimeContextForPrompt(value) {
  const normalized = normalizeTimeContext(value);
  if (!normalized) return null;
  return {
    currentTime: normalized.currentTime,
    timezone: normalized.timezone,
    source: "host",
    trusted: true
  };
}

function readTimeValue(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function readTimezone(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export { normalizeTimeContext, summarizeTimeContextForPrompt };
