import { DEFAULT_THREAD_ID } from './thread.js';

/**
 * AGRUN-145 · Slice B — Per-thread summary keying helpers.
 *
 * Summaries moved from one-slot-per-session to one-slot-per-(session,
 * thread) so Slice C can group compaction by thread without races and
 * without mixing evidence across topics. A composite string key
 * `${sessionId}::${threadId}` is used because:
 *   - The in-memory store keys a native `Map` by string.
 *   - The IndexedDB store uses `keyPath: "id"` (string) and a secondary
 *     `sessionId` index for `listSummaries`, which is simpler and more
 *     portable than IndexedDB compound keys.
 *
 * Legacy call sites may omit `threadId`; all helpers collapse empty /
 * nullable values to `DEFAULT_THREAD_ID`, preserving pre-AGRUN-144
 * behavior.
 */


const KEY_SEPARATOR = "::";

function normalizeThreadId(value) {
  if (typeof value !== "string") return DEFAULT_THREAD_ID;
  const trimmed = value.trim();
  return trimmed || DEFAULT_THREAD_ID;
}

function composeSummaryKey(sessionId, threadId) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("composeSummaryKey: sessionId must be a non-empty string.");
  }
  return `${sessionId}${KEY_SEPARATOR}${normalizeThreadId(threadId)}`;
}

/**
 * Ensure a summary record carries `threadId` + `id`. Callers may build
 * legacy shapes without `threadId`; the store layer stamps both before
 * persistence so the keyPath and the body stay in sync.
 */
function ensureSummaryKeyFields(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return summary;
  }
  const threadId = normalizeThreadId(summary.threadId);
  const id = composeSummaryKey(summary.sessionId, threadId);
  return {
    ...summary,
    id,
    threadId
  };
}

export { DEFAULT_THREAD_ID, composeSummaryKey, ensureSummaryKeyFields, normalizeThreadId };
