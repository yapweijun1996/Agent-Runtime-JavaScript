import { tokenizeTopicText } from '../session/thread.js';
import { jaccard } from './topic-scoring.js';

/**
 * AGRUN-146 — Goal drift detector.
 *
 * Harness-only: pure functions, no hidden state, no I/O. The runtime cycle
 * loop calls `detectDrift` every N cycles, stashes the verdict, and the
 * planner prepends a reminder line into `plannerDirectives` for that one
 * call. After the call the verdict is cleared.
 *
 * Similarity is pluggable:
 *   - Default is a Jaccard overlap over `tokenizeTopicText` tokens — the
 *     same lexicon-free primitive the topic-router already uses.
 *   - Hosts can pass `similarityFn(goalText, trajectoryText) → number in
 *     [0,1]` (e.g. an embedding API) without changing this module. The
 *     detector always clamps + sanitizes the return value, so a misbehaving
 *     hook degrades to `null` rather than corrupting the loop.
 *
 * No lexicon, no hardcoded stop phrases — drift is judged by token overlap
 * only. Thresholds and cycle cadence are config-driven.
 */

const DEFAULT_SEVERE_THRESHOLD = 0.4;
const DEFAULT_MILD_THRESHOLD = 0.7;
const DEFAULT_CYCLE_INTERVAL = 5;
const DEFAULT_MAX_TRAJECTORY_ENTRIES = 5;

/**
 * Decide whether to inject a drift reminder or force a replan this cycle.
 *
 * @param {object} input
 * @param {string} input.goalAnchorText       Verbatim goal anchor (L1).
 * @param {string} input.trajectoryText       Concatenated recent trajectory.
 * @param {number} input.cycleCount           Current cycle number (1-based).
 * @param {number} [input.cycleInterval=5]    Only check every Nth cycle.
 * @param {number} [input.severeThreshold=0.4] similarity < severe → force_replan.
 * @param {number} [input.mildThreshold=0.7]   severe ≤ similarity < mild → inject_reminder.
 * @param {Function} [input.similarityFn]     Optional custom (goal, traj) → [0,1].
 * @returns {null | {drift: "mild"|"severe", action: "inject_reminder"|"force_replan", similarity: number, method: "jaccard"|"custom", cycleCount: number, cycleInterval: number}}
 */
function detectDrift(input) {
  const spec = normalizeDetectInput(input);
  if (!spec) return null;

  const similarity = computeSimilarity(spec);
  if (similarity == null) return null;

  if (similarity < spec.severeThreshold) {
    return {
      drift: "severe",
      action: "force_replan",
      similarity,
      method: spec.method,
      cycleCount: spec.cycleCount,
      cycleInterval: spec.cycleInterval
    };
  }
  if (similarity < spec.mildThreshold) {
    return {
      drift: "mild",
      action: "inject_reminder",
      similarity,
      method: spec.method,
      cycleCount: spec.cycleCount,
      cycleInterval: spec.cycleInterval
    };
  }
  return null;
}

/**
 * Flatten the last N actionHistory entries into a single string:
 *   `${actionName}: ${summary}\n…`
 *
 * Keeps the signal lexicon-free — only observable planner output, no
 * synthesized descriptions. Accepts either a runState (with
 * `toolContext.history`) or a bare actionHistory array so callers in tests
 * and in the planner wiring can share the same helper.
 *
 * @param {object|Array} source
 * @param {object} [options]
 * @param {number} [options.maxEntries=5]
 */
function computeTrajectorySignal(source, options) {
  const maxEntries = readPositiveInteger$a(
    options && options.maxEntries,
    DEFAULT_MAX_TRAJECTORY_ENTRIES
  );
  const history = extractActionHistory(source);
  if (history.length === 0) return "";

  const slice = history.slice(-maxEntries);
  const parts = [];
  for (const entry of slice) {
    if (!entry || typeof entry !== "object") continue;
    const name = readNonEmpty(entry.actionName);
    const summary = readNonEmpty(entry.summary);
    if (!name && !summary) continue;
    parts.push(name && summary ? `${name}: ${summary}` : name || summary);
  }
  return parts.join("\n");
}

/**
 * Build a single-line reminder for the planner directives block. Kept
 * separate from `detectDrift` so the runtime cycle can control phrasing
 * (and so agrun_docs/tests can assert the exact string).
 */
function formatDriftReminder(signal) {
  if (!signal || typeof signal !== "object") return "";
  const similarity = Number.isFinite(signal.similarity) ? signal.similarity.toFixed(2) : "?";
  if (signal.drift === "severe") {
    return `Goal-drift guard: trajectory similarity to the original goal has dropped to ${similarity}. Replan against the goal anchor and discard branches that no longer serve it.`;
  }
  if (signal.drift === "mild") {
    return `Goal-drift guard: trajectory similarity to the original goal is ${similarity}. Re-check the goal anchor before selecting the next action.`;
  }
  return "";
}

// ---- internals ----------------------------------------------------------

function normalizeDetectInput(raw) {
  if (!raw || typeof raw !== "object") return null;

  const goal = readNonEmpty(raw.goalAnchorText);
  const trajectory = readNonEmpty(raw.trajectoryText);
  if (!goal || !trajectory) return null;

  const cycleCount = Number.isInteger(raw.cycleCount) ? raw.cycleCount : null;
  if (cycleCount == null || cycleCount <= 0) return null;

  const cycleInterval = readPositiveInteger$a(raw.cycleInterval, DEFAULT_CYCLE_INTERVAL);
  if (cycleCount % cycleInterval !== 0) return null;

  const severeThreshold = readUnitInterval$1(raw.severeThreshold, DEFAULT_SEVERE_THRESHOLD);
  const mildThreshold = readUnitInterval$1(raw.mildThreshold, DEFAULT_MILD_THRESHOLD);
  // Severe must be <= mild for the bands to make sense; if the caller
  // inverted them, treat them as undefined and fall back to defaults
  // rather than producing incoherent verdicts.
  const coherent = severeThreshold <= mildThreshold
    ? { severe: severeThreshold, mild: mildThreshold }
    : { severe: DEFAULT_SEVERE_THRESHOLD, mild: DEFAULT_MILD_THRESHOLD };

  const similarityFn = typeof raw.similarityFn === "function" ? raw.similarityFn : null;

  return {
    goalAnchorText: goal,
    trajectoryText: trajectory,
    cycleCount,
    cycleInterval,
    severeThreshold: coherent.severe,
    mildThreshold: coherent.mild,
    similarityFn,
    method: similarityFn ? "custom" : "jaccard"
  };
}

function computeSimilarity(spec) {
  if (spec.similarityFn) {
    try {
      const raw = spec.similarityFn(spec.goalAnchorText, spec.trajectoryText);
      return clampUnitInterval(raw);
    } catch {
      // A broken host hook must not break the loop — fall back to silence.
      return null;
    }
  }
  const goalTokens = new Set(tokenizeTopicText(spec.goalAnchorText));
  const trajectoryTokens = new Set(tokenizeTopicText(spec.trajectoryText));
  if (goalTokens.size === 0 || trajectoryTokens.size === 0) return null;
  return jaccard(goalTokens, trajectoryTokens);
}

function extractActionHistory(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (typeof source === "object") {
    const tc = source.toolContext;
    if (tc && Array.isArray(tc.history)) return tc.history;
  }
  return [];
}

function readNonEmpty(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function readPositiveInteger$a(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readUnitInterval$1(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

function clampUnitInterval(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export { computeTrajectorySignal, detectDrift, formatDriftReminder };
