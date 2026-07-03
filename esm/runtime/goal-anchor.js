import { readString } from './semantic-json.js';

// AGRUN-142 — Goal anchor harness.
//
// Three-layer anchor model (per ADR 0002):
//   L1 (session-thread-scope) — `thread.goalAnchor.text` = verbatim first
//        user text for the thread. Stable across turns within that thread.
//   L2 (run-scope) — `runState.originalQuery` = verbatim rawInput for the
//        current run. Seeded on cycle 1 of the run; immutable thereafter.
//   L3 (turn-scope) — `turnState.goalAnchorText` = current-cycle derived
//        anchor (see turn-state.js). May change turn-to-turn.
//
// This harness exposes pure functions so planner-prompt.js and
// runtime-finalize.js can inject a uniform `[ORIGINAL USER QUERY — DO NOT
// REINTERPRET]` + `[GOAL ANCHOR]` block without each site re-implementing
// the layering / truncation logic.
//
// Lexicon-free: no domain vocabulary. The block is literally whichever
// verbatim strings are present, fenced by block headers.


const ORIGINAL_QUERY_HEADER = "[ORIGINAL USER QUERY — DO NOT REINTERPRET]";
const GOAL_ANCHOR_HEADER = "[GOAL ANCHOR]";
const TRUNCATION_SUFFIX = "…";

/**
 * Seed `runState.originalQuery` on the first cycle of a run. Noop when the
 * field is already populated (immutability contract) or when no text is
 * available. Returns the final value for callers that want to log.
 *
 * @param {object} runState — mutated in place.
 * @param {object} options
 * @param {string} [options.inputText] — `normalizedInput.text` when rawInput
 *   was a string.
 * @param {string} [options.requestPrompt] — `request.prompt` fallback.
 * @returns {string} — the resolved verbatim query (may be "").
 */
function captureOriginalQuery(runState, options) {
  if (!runState || typeof runState !== "object") return "";
  const existing = readString(runState.originalQuery);
  if (existing) return existing;
  const source = options && typeof options === "object" ? options : {};
  const captured = readString(source.inputText) || readString(source.requestPrompt);
  if (!captured) return "";
  runState.originalQuery = captured;
  return captured;
}

/**
 * Read the anchor view for a cycle. Combines run-scope + thread-scope
 * sources so callers can format once. Neither side is required — the
 * format helper tolerates missing values.
 *
 * @param {object} options
 * @param {object} [options.runState]
 * @param {object} [options.activeThread] — Thread record from session store.
 * @param {object} [options.config] — Normalized goalAnchor config.
 * @returns {{originalQuery: string, threadGoalAnchor: string, enabled: boolean}}
 */
function readGoalAnchorView(options) {
  const source = options && typeof options === "object" ? options : {};
  const config = source.config && typeof source.config === "object"
    ? source.config
    : { enabled: true, includeThreadAnchor: true };
  const enabled = config.enabled !== false;
  const originalQuery = readString(source.runState && source.runState.originalQuery);
  const threadGoalAnchor = config.includeThreadAnchor !== false
    ? readThreadAnchor(source.activeThread)
    : "";
  return { originalQuery, threadGoalAnchor, enabled };
}

/**
 * Format the verbatim anchor block for prompt injection. Returns "" when
 * disabled or when nothing to inject. Respects `maxAnchorChars` by
 * truncating each layer independently (never drop the fence headers).
 *
 * Output shape when both present:
 *   [ORIGINAL USER QUERY — DO NOT REINTERPRET]
 *   <verbatim run-scope text>
 *
 *   [GOAL ANCHOR]
 *   <verbatim thread-scope text>
 *
 * If only one layer has content, only that block is emitted. If both
 * layers are byte-identical, the thread block is skipped to avoid
 * duplicate injection.
 */
function formatGoalAnchorBlock(view, config) {
  const resolved = view && typeof view === "object" ? view : {};
  if (resolved.enabled === false) return "";
  const cfg = config && typeof config === "object" ? config : {};
  const limit = Number.isInteger(cfg.maxAnchorChars) && cfg.maxAnchorChars > 0
    ? cfg.maxAnchorChars
    : 4000;

  const originalQuery = truncate(readString(resolved.originalQuery), limit);
  const threadGoalAnchor = truncate(readString(resolved.threadGoalAnchor), limit);

  const blocks = [];
  if (originalQuery) {
    blocks.push(`${ORIGINAL_QUERY_HEADER}\n${originalQuery}`);
  }
  if (threadGoalAnchor && threadGoalAnchor !== originalQuery) {
    blocks.push(`${GOAL_ANCHOR_HEADER}\n${threadGoalAnchor}`);
  }
  return blocks.join("\n\n");
}

function readThreadAnchor(activeThread) {
  if (!activeThread || typeof activeThread !== "object") return "";
  const anchor = activeThread.goalAnchor;
  if (!anchor || typeof anchor !== "object") return "";
  return readString(anchor.text);
}

function truncate(value, limit) {
  if (!value) return "";
  if (value.length <= limit) return value;
  const sliceLen = Math.max(limit - TRUNCATION_SUFFIX.length, 1);
  return `${value.slice(0, sliceLen)}${TRUNCATION_SUFFIX}`;
}

export { captureOriginalQuery, formatGoalAnchorBlock, readGoalAnchorView };
