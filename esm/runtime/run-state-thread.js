import { applyResearchSliceToRunState } from './research-thread-sync.js';
import { trimRunStateForThreadWindow } from './thread-provenance.js';

/**
 * Small standalone helper split out from state.js so tests (and any
 * consumer that does not need the full agent-skills virtual module graph)
 * can load it directly in plain Node ESM.
 */


/**
 * AGRUN-212a amendment 2E — Detect terminal TodoState that should NOT
 * carry over to a new turn. `completed` and `abandoned` are work-unit-
 * done markers; the next user message starts a new work unit and
 * deserves a clean slate so the planner can re-decide.
 *
 * `active` plans DO carry over — that is the legitimate "continue
 * the task across turns" path. Same-thread continuation is what the
 * persistence layer was built for; only terminal status resets here.
 *
 * 2026-05-11 amendment — also treat a `terminatedAt` annotation as
 * terminal. `observeTodoStateOnTerminal` adds that field when a
 * terminal action (workspace_publish_candidate / planner_final /
 * runtime/planner finalize) ends a turn whose Todo plan still had
 * unfinished items. The thread record keeps the annotated todoState
 * for audit; the next turn must not inherit it as an active plan,
 * because the work unit ended (AI chose to publish anyway) and a
 * fresh user message deserves a clean slate.
 */
function isTerminalTodoState(todoState) {
  if (!todoState || typeof todoState !== "object") return false;
  if (todoState.status === "completed" || todoState.status === "abandoned") return true;
  if (todoState.terminatedAt != null) return true;
  return false;
}

/**
 * Apply thread hydration onto a freshly-created runState. `hydration` may
 * carry `{threadId, scopedEvidenceUrls, compactionWindow}`; unknown keys
 * are ignored. Safe to call with null/undefined (no-op) so non-thread-
 * aware call sites stay unchanged.
 *
 * - `threadId` — stamped onto `runState.threadId` for downstream provenance.
 * - `scopedEvidenceUrls` may be `null` (passthrough) or an array; when set
 *   to `[]`, downstream filters drop all citations.
 * - `compactionWindow` (AGRUN-145 Slice D) — optional
 *   `{ oldestPreservedTurnId }` from the summary just written. Applied
 *   through `trimRunStateForThreadWindow` so any hydrated tool / research
 *   state older than the window (and any entry not belonging to the
 *   active thread) is dropped before runLoop starts. Today the seeded
 *   runState arrays are empty so trim is a no-op, but wiring it through
 *   hydration now means the guarantee holds when per-thread persistence
 *   lands (thread-level toolContext rehydration will not bring back
 *   compacted evidence).
 */
function hydrateRunStateWithThread(runState, hydration) {
  if (!runState || typeof runState !== "object") return runState;
  if (!hydration || typeof hydration !== "object") return runState;
  if (typeof hydration.threadId === "string" && hydration.threadId.trim()) {
    runState.threadId = hydration.threadId.trim();
  }
  if (Array.isArray(hydration.scopedEvidenceUrls)) {
    runState.scopedEvidenceUrls = hydration.scopedEvidenceUrls.slice();
  } else if (hydration.scopedEvidenceUrls === null) {
    runState.scopedEvidenceUrls = null;
  }
  // AGRUN-142 — mirror the active thread's goalAnchor.text onto runState so
  // the planner-prompt injector does not need to reach back into the
  // session record every cycle. Trimmed; empty string when absent.
  if (typeof hydration.goalAnchorText === "string") {
    runState.threadGoalAnchorText = hydration.goalAnchorText.trim();
  }
  // AGRUN-212a Phase C — mirror the active thread's TodoState onto
  // runState so todo_* actions mutate a per-turn snapshot. handle.js
  // writes the snapshot back to `sessionRecord.threads[i].todoState`
  // after the action loop, and saveSession's CAS protects the write.
  // We accept `null` (no plan yet) as a first-class value; missing
  // key on hydration leaves runState.todoState untouched (defaults
  // to null via the runState seed).
  if (Object.prototype.hasOwnProperty.call(hydration, "todoState")) {
    // AGRUN-212a amendment 2E — A new turn must NOT inherit a
    // `completed`/`abandoned` plan from a previous turn. Once the
    // plan reached a terminal state the work unit is done; the next
    // turn should start with a clean slate so the planner can decide
    // whether to call `todo_plan` again (new task) or skip it
    // (single-shot question). Without this reset the UI keeps
    // showing "5/5 done" on every subsequent unrelated turn in the
    // same thread, which is the carry-over bug live test caught.
    const incoming = hydration.todoState || null;
    runState.todoState = isTerminalTodoState(incoming) ? null : incoming;
  }
  if (hydration.researchContext && typeof hydration.researchContext === "object") {
    runState.researchContext = {
      ...runState.researchContext,
      ...hydration.researchContext,
      aggregatedSearchResults: Array.isArray(hydration.researchContext.aggregatedSearchResults)
        ? hydration.researchContext.aggregatedSearchResults.slice()
        : Array.isArray(hydration.researchContext.searchResults)
          ? hydration.researchContext.searchResults.slice()
          : runState.researchContext.aggregatedSearchResults,
      readSources: Array.isArray(hydration.researchContext.readSources)
        ? hydration.researchContext.readSources.slice()
        : runState.researchContext.readSources,
      searchPasses: Array.isArray(hydration.researchContext.searchPasses)
        ? hydration.researchContext.searchPasses.slice()
        : runState.researchContext.searchPasses,
      searchResults: Array.isArray(hydration.researchContext.searchResults)
        ? hydration.researchContext.searchResults.slice()
        : runState.researchContext.searchResults
    };
  }
  // qualityContext wiring — rehydrate the prior turn's finalize quality issue
  // codes so this turn's planner can surface them via loopState.qualityContext.
  // Mirrors the researchContext carry above; harmless when absent.
  if (hydration.finalResponseQuality && typeof hydration.finalResponseQuality === "object") {
    runState.finalResponseQuality = { ...hydration.finalResponseQuality };
  }
  // AGRUN-214m — apply the durable research slice (topic, evidence graph,
  // report-loop status, final envelope) before compaction trim so a
  // finalize-only follow-up turn inherits the original research topic
  // instead of re-extracting from the recovery prompt.
  if (hydration.research) {
    applyResearchSliceToRunState(runState, hydration.research);
  }
  const compactionWindow = hydration.compactionWindow
    && typeof hydration.compactionWindow === "object"
    && !Array.isArray(hydration.compactionWindow)
    ? hydration.compactionWindow
    : null;
  if (compactionWindow) {
    trimRunStateForThreadWindow(runState, {
      threadId: runState.threadId || null,
      oldestPreservedTurnId: compactionWindow.oldestPreservedTurnId || null
    });
  }
  return runState;
}

export { hydrateRunStateWithThread };
