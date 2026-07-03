import { DEFAULT_THREAD_ID } from '../session/thread.js';
import { isTurnIdBefore } from './turn-ordering.js';

/**
 * AGRUN-145 · Slice A — Shared thread/turn provenance stamping.
 *
 * The compaction layer needs to answer "which thread produced this entry,
 * and in which turn?" for messages, tool history, and read sources. Slice A
 * stamps this provenance at the write site so Slice C/D can group and trim
 * without re-deriving it from message order.
 *
 * Harness: a single source of truth for the provenance shape. Every consumer
 * reads the same `{ threadId, turnId }` tuple; downstream trim logic never
 * needs to reach back into runState to reconstruct it.
 *
 * Contract:
 *   - `readActiveThreadId(runState)` — always returns a non-empty string.
 *     Pre-AGRUN-144 runtimes (threads disabled) get `DEFAULT_THREAD_ID`.
 *   - `readActiveTurnId(runState)` — returns `runState.runId` or `null`.
 *     We do not fabricate a turn id when the runtime omits one; trim logic
 *     must gracefully skip entries whose provenance carries `turnId: null`.
 *   - `stampThreadProvenance(entry, runState)` — returns `entry` with
 *     `_provenance` added. Pure: creates a new top-level field on the same
 *     object reference (the caller already deep-cloned the payload), never
 *     mutates any pre-existing consumer-visible field. If `entry` is falsy
 *     or already carries `_provenance`, it is returned unchanged.
 */


function readActiveThreadId(runState) {
  if (!runState || typeof runState !== "object") {
    return DEFAULT_THREAD_ID;
  }
  const threadId = typeof runState.threadId === "string" ? runState.threadId.trim() : "";
  return threadId || DEFAULT_THREAD_ID;
}

function readActiveTurnId(runState) {
  if (!runState || typeof runState !== "object") {
    return null;
  }
  const turnId = typeof runState.runId === "string" ? runState.runId.trim() : "";
  return turnId || null;
}

function stampThreadProvenance(entry, runState) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return entry;
  }
  if (entry._provenance && typeof entry._provenance === "object") {
    return entry;
  }
  entry._provenance = {
    threadId: readActiveThreadId(runState),
    turnId: readActiveTurnId(runState)
  };
  return entry;
}

function readProvenance$2(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const provenance = entry._provenance;
  if (!provenance || typeof provenance !== "object") {
    return null;
  }
  const threadId = typeof provenance.threadId === "string" && provenance.threadId.trim()
    ? provenance.threadId.trim()
    : DEFAULT_THREAD_ID;
  const turnId = typeof provenance.turnId === "string" && provenance.turnId.trim()
    ? provenance.turnId.trim()
    : null;
  return { threadId, turnId };
}

/**
 * AGRUN-145 Slice D — Thread + compaction-window filter.
 *
 * Given a list of provenance-stamped entries (tool history, read sources,
 * memory outputs, etc.), keep only those that match the active thread
 * AND fall inside the compaction window. The window is a turn-id lower
 * bound — everything older than `oldestPreservedTurnId` has been folded
 * into the summary and must not be re-surfaced downstream.
 *
 * Harness rules (single source of truth, no per-call-site divergence):
 *   - Missing `threadId` arg → no thread check (equivalent to "any
 *     thread"). This lets callers that disable thread scoping still
 *     benefit from window trimming.
 *   - Missing `oldestPreservedTurnId` arg → no window check (no
 *     compaction happened yet).
 *   - Legacy entries with no `_provenance` are KEPT. They pre-date
 *     Slice A and carry no turn/thread info, so we cannot safely
 *     classify them; dropping would silently delete unlabeled evidence.
 *   - Provenance with `turnId: null` is treated as "unknown time" and
 *     kept (same rationale as legacy entries).
 *   - When both thread and window are set, BOTH must match; otherwise
 *     the entry is dropped.
 */
function filterByThreadWindow(entries, options) {
  if (!Array.isArray(entries)) return [];
  const opts = options && typeof options === "object" ? options : {};
  const threadFilter = typeof opts.threadId === "string" && opts.threadId.trim()
    ? opts.threadId.trim()
    : null;
  const windowFloor = typeof opts.oldestPreservedTurnId === "string" && opts.oldestPreservedTurnId.trim()
    ? opts.oldestPreservedTurnId.trim()
    : null;
  if (!threadFilter && !windowFloor) {
    return entries.slice();
  }
  return entries.filter((entry) => {
    const provenance = readProvenance$2(entry);
    if (!provenance) return true; // legacy / unlabeled — keep
    if (threadFilter && provenance.threadId !== threadFilter) return false;
    if (windowFloor && provenance.turnId && isTurnIdBefore(provenance.turnId, windowFloor)) return false;
    return true;
  });
}

/**
 * AGRUN-145 Slice D — Apply `filterByThreadWindow` to the mutable tool /
 * research context on a runState. Returns the runState for chaining.
 *
 * Today `runState.toolContext.history` and
 * `runState.researchContext.readSources` start empty each turn, so this
 * is usually a no-op. The harness is wired now so that once thread-level
 * persistence lands (rehydrating prior-turn tool evidence from the
 * Thread record), the trim already runs automatically at hydration time.
 *
 * Empty/missing `options` is a safe no-op — callers do not need to
 * branch on "is there a window".
 */
function trimRunStateForThreadWindow(runState, options) {
  if (!runState || typeof runState !== "object") return runState;
  const opts = options && typeof options === "object" ? options : {};
  const hasThread = typeof opts.threadId === "string" && opts.threadId.trim();
  const hasWindow = typeof opts.oldestPreservedTurnId === "string" && opts.oldestPreservedTurnId.trim();
  if (!hasThread && !hasWindow) return runState;
  if (runState.toolContext && Array.isArray(runState.toolContext.history)) {
    runState.toolContext.history = filterByThreadWindow(runState.toolContext.history, opts);
  }
  if (runState.researchContext && Array.isArray(runState.researchContext.readSources)) {
    runState.researchContext.readSources = filterByThreadWindow(runState.researchContext.readSources, opts);
  }
  // AGRUN-212a Phase D — `runState.todoState` is intentionally NOT
  // trimmed. The plan is the active-task truth source; folding it
  // into a summary would lose item ids, statuses, and notes that
  // the planner needs for the next turn. The summary text may
  // describe completed items in prose, but TodoState itself
  // survives compaction windows untouched.
  return runState;
}

export { filterByThreadWindow, readActiveThreadId, readActiveTurnId, readProvenance$2 as readProvenance, stampThreadProvenance, trimRunStateForThreadWindow };
