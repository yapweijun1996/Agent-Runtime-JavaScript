import { requestProviderCompletion } from './provider.js';
import { createUsageDetail } from './runtime-events.js';
import { normalizeThrownError } from './errors.js';
import { normalizeSessionPolicy } from '../session/policy.js';

// GAP 4 — prompt-side action-history compaction (Mastra Observational
// Memory, Observer layer only). Design:
// agrun_docs/action-history-compaction-design.md.
//
// The one rule that kills regression risk: compact the PROJECTION, not the
// state. `session.actionHistory` stays full in memory — readDeniedActions,
// summarizeActionFailureSignal, checkBudget and the drift/convergence
// detectors all keep consuming the full array. Only the history view handed
// to buildPlannerPrompt is replaced by `projectActionHistory()`.
//
// AI-first split: the observer LLM authors the observation log (merging,
// superseding, preserving specifics verbatim); the runtime owns only generic
// mechanism — threshold detection (same legitimacy class as maxSteps /
// runDeadlineMs), head/tail protection, and the mechanical fallback marker
// when the observer call fails. Compaction never breaks the run.


// Reuse the session-surface estimator heuristic (~4 chars/token,
// DEFAULT_SESSION_POLICY.charsPerToken in src/session/policy.js) instead of
// inventing a second token estimator.
const CHARS_PER_TOKEN = normalizeSessionPolicy(null).charsPerToken;

const COMPACTED_OBSERVATIONS_KIND = "compacted-observations";

const OBSERVER_SYSTEM_PROMPT = [
  "You are the action-history observer for agrun.js.",
  "Merge the previous observation log and the new raw action entries into one updated observation log.",
  "Rules:",
  "- Keep an ordered, numbered list of factual events: decisions made, actions denied, failures, and their outcomes.",
  "- Preserve file paths, URLs, identifiers, and numbers verbatim.",
  "- Merge or supersede earlier observations when newer entries update them.",
  "- Never invent events that are not present in the input.",
  "- Output only the updated observation log text, with no preamble or commentary."
].join("\n");

// Pure projection of the planner-prompt history view. Under the threshold
// (no observations folded yet) or when disabled it returns the raw array
// untouched, so short runs render a byte-identical prompt. Once entries have
// been folded it returns: protected head raw entries + one synthetic
// `compacted-observations` entry + raw entries from `compactedThrough` on
// (which includes the protected tail).
function projectActionHistory(session, config) {
  const history = Array.isArray(session && session.actionHistory) ? session.actionHistory : [];
  const state = session && session.historyCompaction && typeof session.historyCompaction === "object"
    ? session.historyCompaction
    : null;
  if (
    !config
    || config.enabled === false
    || !state
    || typeof state.observations !== "string"
    || state.observations.length === 0
    || !Number.isInteger(state.compactedThrough)
    || state.compactedThrough <= 0
  ) {
    return history;
  }
  const head = Math.min(config.protectHeadEntries, state.compactedThrough, history.length);
  return [
    ...history.slice(0, head),
    { kind: COMPACTED_OBSERVATIONS_KIND, summary: state.observations },
    ...history.slice(Math.min(state.compactedThrough, history.length))
  ];
}

// Estimate of the projected history block the planner prompt would carry,
// using the same per-entry summary the prompt renders.
function estimateProjectedHistoryTokens(session, config) {
  const projected = projectActionHistory(session, config);
  let chars = 0;
  for (const entry of projected) {
    chars += renderEntrySummary(entry).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// Cycle-boundary trigger. Mutates ONLY session.historyCompaction (the
// observation log + fold cursor) and pushes one `history-compaction` step;
// session.actionHistory is never touched. Returns the step mode when a
// compaction ran, null otherwise.
async function maybeCompactActionHistory(session) {
  const config = session && session.runtimeConfig ? session.runtimeConfig.historyCompaction : null;
  const state = session && session.historyCompaction && typeof session.historyCompaction === "object"
    ? session.historyCompaction
    : null;
  if (!config || config.enabled === false || !state) return null;
  const history = Array.isArray(session.actionHistory) ? session.actionHistory : [];
  const start = Math.max(
    Number.isInteger(state.compactedThrough) ? state.compactedThrough : 0,
    config.protectHeadEntries
  );
  const end = history.length - config.protectTailEntries;
  if (end <= start) return null;
  const approxTokensBefore = estimateProjectedHistoryTokens(session, config);
  if (approxTokensBefore < config.triggerTokens) return null;

  const entries = history.slice(start, end);
  const startedAt = Date.now();
  let mode = "observer";
  let usage = null;
  try {
    const response = await requestProviderCompletion(session.request, {
      prompt: buildObserverPrompt(state.observations, entries, start),
      systemPrompt: OBSERVER_SYSTEM_PROMPT
    });
    const text = response && typeof response.text === "string" ? response.text.trim() : "";
    if (!text) {
      throw new Error("observer returned an empty observation log");
    }
    state.observations = text;
    // Usage on the step detail flows through the normal provider event path
    // (prepareRuntimeStepDetail → recordCostEntry), so the GAP 5 cost ledger
    // and maxCostUsd automatically account for observer spend.
    usage = createUsageDetail(response, {
      model: session.request && session.request.model,
      provider: session.request && session.request.provider
    });
  } catch (error) {
    // Never break the run: keep the protected head/tail and stand in for the
    // compactable middle with a mechanical omission marker. No runtime-
    // authored summary of content — the marker only states what was dropped.
    mode = "fallback";
    const marker = `[${entries.length} earlier steps omitted — compaction unavailable]`;
    state.observations = state.observations ? `${state.observations}\n${marker}` : marker;
    if (session.debug && typeof session.debug.log === "function") {
      session.debug.log("history-compaction observer failed; mechanical fallback", {
        error: normalizeThrownError(error).message
      });
    }
  }
  state.compactedThrough = end;
  const approxTokensAfter = estimateProjectedHistoryTokens(session, config);
  session.pushStep("history-compaction", {
    approxTokensAfter,
    approxTokensBefore,
    durationMs: Date.now() - startedAt,
    entriesCompacted: entries.length,
    mode,
    provider: session.request && session.request.provider,
    ...(usage ? { usage } : {})
  });
  return mode;
}

function buildObserverPrompt(observations, entries, startIndex) {
  const lines = entries.map(
    (entry, index) => `${startIndex + index + 1}. ${renderEntrySummary(entry)}`
  );
  return [
    "Previous observation log:",
    observations || "None",
    "",
    "New raw action entries (oldest first):",
    lines.join("\n")
  ].join("\n");
}

// Same summary derivation as the planner-prompt history block, so the
// estimate measures what the prompt would actually carry.
function renderEntrySummary(entry) {
  if (!entry || typeof entry !== "object") return "step";
  return entry.summary || entry.actionName || entry.kind || "step";
}

export { COMPACTED_OBSERVATIONS_KIND, estimateProjectedHistoryTokens, maybeCompactActionHistory, projectActionHistory };
