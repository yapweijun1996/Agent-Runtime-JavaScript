/**
 * SSOT for every LLM-facing string the terminal-repair preflight emits to
 * the planner.
 *
 * Why this exists (2026-05-16):
 *   "Terminal repair mode is active..." was duplicated across
 *   `action-loop-action.js` (terminal repair preflight block, two
 *   variants for invalid publish vs action-not-allowed) and
 *   `action-loop-session-loop.js` (direct final/finalize suppression
 *   during terminal repair). Tuning the wording for a planner model
 *   required editing two files in lockstep, which is the same
 *   patch-thinking that motivated `todo-prompt-strings.js`. This module
 *   centralizes the catalog so both sites import the same SSOT.
 *
 * Layering:
 *   - `block.*` strings are surfaced from
 *     `maybeBlockTerminalRepairAction` in `action-loop-action.js`.
 *   - `directTerminalBlock.*` strings are surfaced from
 *     `maybeBlockDirectTerminalDuringRepair` in
 *     `action-loop-session-loop.js`.
 *   - Functions take named-parameter objects so future fields are
 *     additive, not positional.
 *
 * No host-override surface is exposed yet (todo-prompt-strings.js carries
 * one via runtimeConfig). When a host needs to tune these, add the
 * deep-merge normalizer pattern from todo-prompt-strings.js; defaults
 * here preserve existing call-site behavior verbatim so adding the
 * config surface later is purely additive.
 */

const DEFAULT_TERMINAL_REPAIR_STRINGS = Object.freeze({
  block: Object.freeze({
    invalidPublish: ({ protocolHint }) =>
      "Terminal repair mode is active: workspace_publish_candidate is "
      + "allowed only with finalReadiness.decision='limited', non-empty "
      + "concrete remainingGaps, evidenceSatisfied=false only when source "
      + "deficits remain, lengthSatisfied=false for length deficits, and "
      + "requirementSatisfied=false while any core deficit remains."
      + (protocolHint || ""),
    actionNotAllowed: ({ actionName }) =>
      `Terminal repair mode is active: ${actionName} is not an allowed `
      + "recovery action for the current deficits. Choose one of the "
      + "allowedActions, or publish only a valid limited workspace "
      + "candidate.",
    // ADR-0033 Part 4 Tier A.6 (B2 fix) — deficit-aware hard veto recovery instruction.
    // Previously this message forced workspace_publish_candidate with decision='limited'
    // regardless of budgetState, which pushed AI to ship a short "limited" report even
    // when budget remained for more content work. Live data (tier-a-2026-05-20 run2:
    // 56 hard_veto fires with budgetState='enough') showed AI ignored the publish push
    // and kept retrying finalize because publishing 437 words as "limited" felt wrong.
    // Fix: when budget is NOT exhausted, surface the FIRST allowed deficit-clearing
    // action with a per-deficit hint built from observableDeficits. AI still chooses
    // freely; runtime is only restating what is available, not picking for AI.
    hardVetoActionNotAllowed: ({
      actionName,
      ignoredCount,
      budgetState,
      activeDeficits,
      allowedActions,
      observableDeficits
    }) => {
      const budgetExhausted = (typeof budgetState === "string" && budgetState.trim().toLowerCase()) === "exhausted";
      const deficits = Array.isArray(activeDeficits) ? activeDeficits : [];
      const deficitHint = buildTerminalRepairDeficitHint(deficits, observableDeficits);
      const deficitPrefix = deficitHint ? `${deficitHint} ` : "";

      const recovery = budgetExhausted
        ? "Budget is exhausted. A valid limited workspace_publish_candidate requires "
          + "finalReadiness.decision='limited', non-empty concrete remainingGaps naming each observable "
          + "deficit, and false flags for each failed dimension (evidenceSatisfied, lengthSatisfied, "
          + "requirementSatisfied). See requiredArgsExample for the exact contract."
        : `Continue recovery work before any further finalize. ${deficitPrefix}Use structured allowedActions, `
          + "observableDeficits, and requiredArgsExample to choose the next move. A limited workspace publish "
          + "is valid only when recovery is not feasible.";

      return `HARD VETO — ${actionName} has been blocked ${ignoredCount} time(s) while terminal repair is `
        + `active (budgetState=${budgetState || "unknown"}). Any further ${actionName} call will continue `
        + `to be blocked. ${recovery}`;
    },
    // AGRUN-542 — content-structure exit contract. Emitted by BOTH doors
    // (blocks/terminal-repair.js preflight + the onResponse finalize hook)
    // when the single content-changing repair attempt budget is used and a
    // content-level structure issue (duplicate-purpose sections / body after
    // the final section) still remains while length and sources are satisfied.
    contentStructureForcedPublish: ({ actionName, attemptsUsed, attemptLimit }) =>
      `BLOCKED — ${actionName} is not available. The content-structure repair attempt budget is used `
      + `(${attemptsUsed}/${attemptLimit}) and a content-level structure issue remains while length and `
      + "sources are already satisfied. The ONLY allowed action now is workspace_publish_candidate with "
      + "finalReadiness.decision='limited' and the concrete structure gap in remainingGaps (see "
      + "requiredArgsExample). Further finalize/final_answer or repair attempts will keep being blocked."
  }),
  directTerminalBlock: Object.freeze({
    message:
      "Terminal repair mode is active. Direct final/finalize cannot "
      + "bypass workspace publish or valid limited contract."
  })
});

// AGRUN-246-C (C1 fix) — expose deficit facts only; AI decides recovery action.
// Removed action-prescribing prose ("call workspace_insert_after_section", etc.) that
// violated AI-first principle: harness provides state, AI composes own plan.
function buildTerminalRepairDeficitHint(deficits, observableDeficits) {
  const od = (observableDeficits && typeof observableDeficits === "object") ? observableDeficits : {};
  const deficitList = Array.isArray(deficits) ? deficits : [];
  const parts = [];

  if (!deficitList.includes("length")) {
    const length = readObservableLengthDeficit(od);
    const observed = readDeficitNumber(length && length.observed, od.lengthObservedWords, od.lengthObserved);
    const requested = readDeficitNumber(length && length.requested, od.lengthRequestedWords, od.lengthRequested);
    if (observed != null && requested != null && observed < requested) {
      parts.push(`Length deficit: observed ${observed} words, target ${requested} words, gap ${Math.max(requested - observed, 0)} words.`);
    }
  }

  if (deficitList.length === 0) return parts.join(" ");

  for (const deficit of deficitList.slice(0, 3)) {
    if (deficit === "length") {
      const length = readObservableLengthDeficit(od);
      const observed = readDeficitNumber(length && length.observed, od.lengthObservedWords, od.lengthObserved);
      const requested = readDeficitNumber(length && length.requested, od.lengthRequestedWords, od.lengthRequested);
      const range = (observed != null && requested != null)
        ? `observed ${observed} words, target ${requested} words, gap ${Math.max(requested - observed, 0)} words`
        : "length is below the target";
      parts.push(`Length deficit: ${range}.`);
    } else if (deficit === "source") {
      const observed = readDeficitNumber(od.sourceObserved, od.sourceCount);
      const minimum = readDeficitNumber(od.sourceMinimum);
      const range = (observed != null && minimum != null)
        ? `have ${observed} of ${minimum} required authoritative sources`
        : "source minimum is not met";
      parts.push(`Source deficit (${range}).`);
    } else if (deficit === "structure") {
      parts.push("Structure deficit (duplicate headings or broken outline).");
    } else if (deficit === "todo") {
      parts.push("Todo deficit (TodoState is out of sync with current progress).");
    } else if (deficit === "readiness") {
      parts.push("Readiness deficit (evidence is too thin to support the requested answer).");
    }
  }
  return parts.join(" ");
}

function readObservableLengthDeficit(observableDeficits) {
  return observableDeficits &&
    observableDeficits.length &&
    typeof observableDeficits.length === "object" &&
    !Array.isArray(observableDeficits.length)
    ? observableDeficits.length
    : null;
}

function readDeficitNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export { DEFAULT_TERMINAL_REPAIR_STRINGS };
