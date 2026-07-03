import { readString } from './semantic-json.js';

function scrubFinalResponseText(value) {
  const text = readString(value);

  if (!text) {
    return "";
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !isActionEnvelopeBlock(paragraph))
    .filter((paragraph) => !isInternalReadinessBlock(paragraph));

  while (paragraphs.length > 0 && isFollowUpParagraph(paragraphs[paragraphs.length - 1])) {
    paragraphs.pop();
  }

  return paragraphs.join("\n\n").trim();
}

// True when the final response still carries a leaked planner-action /
// tool-call envelope as a standalone block (fenced or bare {"action":...}).
// The finalizer uses this to re-prompt ONCE for prose: scrubFinalResponseText
// removes the JSON, but a weak model often pairs it with "I'll go look at the
// skills" filler that survives scrubbing and is not an answer. Detecting the
// leak (not "scrubbed text is empty") is the correct re-prompt trigger.
function finalResponseHasLeakedActionBlock(value) {
  const text = readString(value);
  if (!text) return false;
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .some((paragraph) => isActionEnvelopeBlock(paragraph));
}

/**
 * Creates a streaming fence that buffers potential action envelope JSON and
 * only forwards safe narrative text to onToken. Parsed action envelopes are
 * dispatched to onAction (if provided) instead of being streamed as text.
 *
 * Returns { wrappedOnToken, flush } — call flush() after streaming completes
 * to emit any remaining buffered text that turned out not to be action JSON.
 */
function createStreamFence(onToken, onAction) {
  const safeOnToken = typeof onToken === "function" ? onToken : null;

  if (!safeOnToken) {
    return { wrappedOnToken: null, flush: noop };
  }

  let buffer = "";
  let mode = "idle"; // "idle" | "json" | "fence"

  function emit(text) {
    if (text) {
      try { safeOnToken(text); } catch (_ignored) { /* consumer error */ }
    }
  }

  // Either swallow a completed candidate block (if it is an action envelope) or
  // emit it as normal text. isActionEnvelopeBlock strips the code fence, so a
  // ```json … ``` wrapper is handled here transparently.
  function dispatch(text) {
    const trimmed = text.trim();
    if (isActionEnvelopeBlock(trimmed)) {
      return; // swallowed — never forwarded to onToken
    }
    emit(text);
  }

  function wrappedOnToken(delta) {
    buffer += typeof delta === "string" ? delta : "";
    // Drain the buffer: emit safe text, swallow/emit completed candidate blocks,
    // and stop as soon as the tail is incomplete (a partial trigger, an unclosed
    // object, or an unclosed fence) so we wait for more tokens.
    for (;;) {
      if (!buffer) return;

      if (mode === "idle") {
        const trigger = findStreamTrigger(buffer);
        if (!trigger) {
          emit(buffer);
          buffer = "";
          return;
        }
        if (trigger.kind === "partial") {
          emit(buffer.slice(0, trigger.index));
          buffer = buffer.slice(trigger.index); // hold the partial tail
          return;
        }
        emit(buffer.slice(0, trigger.index));
        buffer = buffer.slice(trigger.index);
        mode = trigger.mode;
        continue;
      }

      if (mode === "json") {
        const end = completedBracedBlockEnd(buffer);
        if (end < 0) return; // object still accumulating
        dispatch(buffer.slice(0, end));
        buffer = buffer.slice(end);
        mode = "idle";
        continue;
      }

      // mode === "fence" (opened with ```json)
      if (fenceContentClearlyNotJson(buffer)) {
        // The fence does not wrap a JSON object — not an action leak. Emit it
        // and resume scanning. (We only trigger on ```json, never bare ```, so
        // the eventual closing ``` will not re-trigger fence buffering.)
        emit(buffer);
        buffer = "";
        mode = "idle";
        return;
      }
      const fenceEnd = closedFenceEnd(buffer);
      if (fenceEnd < 0) return; // fence still open
      dispatch(buffer.slice(0, fenceEnd));
      buffer = buffer.slice(fenceEnd);
      mode = "idle";
    }
  }

  function flush() {
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    mode = "idle";
    dispatch(text);
  }

  return { wrappedOnToken, flush };
}

// Keys a PURE planner-action / tool-call envelope is allowed to contain. If a
// standalone JSON object's keys are ALL within this set and it carries an
// action intent, the model leaked a control envelope into the final answer
// instead of writing prose. Constrained to a pure key set so a legitimate
// answer that merely *discusses* an action (narrative keys, extra fields) is
// not mistaken for a leak.
const ACTION_ENVELOPE_KEYS = new Set([
  "type", "action", "args", "name", "input", "parameters"
]);

// Strip a single fenced code block (```json … ``` or ``` … ```) down to its
// inner content. Weak models routinely wrap a leaked action envelope in a
// markdown fence (the observed deepseek case); without this the
// startsWith("{") guard never matches and the JSON ships as the answer.
function stripCodeFence(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const match = trimmed.match(/^```[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}

function isActionEnvelopeBlock(text) {
  if (!text || typeof text !== "string") return false;
  const inner = stripCodeFence(text);
  if (!inner.startsWith("{") || !inner.endsWith("}")) return false;
  let parsed;
  try {
    parsed = JSON.parse(inner);
  } catch (_error) {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return false;
  if (!keys.every((key) => ACTION_ENVELOPE_KEYS.has(key))) return false;
  // Must actually carry an action intent: the legacy {"type":"action",…} shape
  // OR the bare {"action":"<name>"} shape a weak model emits when it ignores
  // the "final answer = prose" contract.
  return parsed.type === "action"
    || (typeof parsed.action === "string" && parsed.action.trim() !== "");
}

function isInternalReadinessBlock(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (/^finalReadiness\s*:/i.test(trimmed)) return true;
  if (/^requirementsAssessment\s*:/i.test(trimmed)) return true;
  if (/^readiness\s+json\s*:/i.test(trimmed)) return true;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return Boolean(
      parsed
      && typeof parsed === "object"
      && (parsed.finalReadiness || parsed.requirementsAssessment)
    );
  } catch (_error) {
    return false;
  }
}

// Stream-time leak triggers. Two shapes are buffered live so the user never
// sees them flash: a ```json fenced block (the observed deepseek leak) and the
// legacy minified {"type":"action" envelope. We deliberately do NOT trigger on
// bare {"action" or bare ``` here: swallowing inline minified JSON mid-sentence
// would diverge from the paragraph-level at-rest scrubber, and only ```json (not
// bare ```) keeps a non-action code block's closing fence from re-triggering.
// Bare {"action":…} leaks are still caught at rest by scrubFinalResponseText and
// recovered by the finalizer re-prompt.
const STREAM_TRIGGERS = ['```json', '{"type":"action"'];
const STREAM_MAX_TRIGGER_LEN = Math.max(...STREAM_TRIGGERS.map((token) => token.length));

function findStreamTrigger(text) {
  let best = null;
  for (const token of STREAM_TRIGGERS) {
    const index = text.indexOf(token);
    if (index >= 0 && (best === null || index < best.index)) {
      best = { index, mode: token === "```json" ? "fence" : "json" };
    }
  }
  if (best) return { kind: "full", index: best.index, mode: best.mode };
  const partial = partialStreamTriggerStart(text);
  return partial >= 0 ? { kind: "partial", index: partial } : null;
}

// Smallest tail position whose suffix is a proper prefix of some trigger token,
// so a trigger split across token boundaries is held rather than emitted early.
function partialStreamTriggerStart(text) {
  const start = Math.max(0, text.length - STREAM_MAX_TRIGGER_LEN + 1);
  for (let position = start; position < text.length; position += 1) {
    const tail = text.slice(position);
    if (STREAM_TRIGGERS.some((token) => token.startsWith(tail))) return position;
  }
  return -1;
}

// `text` starts with "{"; returns the index just past the matching close brace,
// or -1 while the object is still accumulating.
function completedBracedBlockEnd(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

// `text` starts with "```json"; true once we can see the first content char
// after the opening fence line is not "{" (so the fence does not wrap a JSON
// object). False while still on the opening line or before any content arrives.
function fenceContentClearlyNotJson(text) {
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex < 0) return false;
  const rest = text.slice(newlineIndex + 1).replace(/^\s+/, "");
  if (rest.length === 0) return false;
  return rest[0] !== "{";
}

// `text` starts with "```json"; returns the index just past the closing ```
// (inclusive), or -1 while the fence is still open.
function closedFenceEnd(text) {
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex < 0) return -1;
  const closeIndex = text.indexOf("```", newlineIndex + 1);
  return closeIndex < 0 ? -1 : closeIndex + 3;
}

function noop() {}

function isFollowUpParagraph(value) {
  const text = readString(value);

  if (!text) {
    return false;
  }

  if (/^(next step|which would you like|which of the|tell me which|choose one)\b/i.test(text)) {
    return true;
  }

  if (/\?\s*$/.test(text) && /(which|what|would you like|do you want me to|tell me)\b/i.test(text)) {
    return true;
  }

  return false;
}

export { createStreamFence, finalResponseHasLeakedActionBlock, scrubFinalResponseText };
