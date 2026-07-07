// AGRUN-559 — SSOT descriptor for the terminal-escape valve metadata.
//
// AGRUN-555 made the four graceful-degradation escape valves an ordered
// first-match-wins rule array inside evaluateTerminalRepairState (core.js),
// but the "what does a granted escape OPEN" fact was still duplicated per
// consumer: the onResponse hook enumerated the three finalize-opening flags by
// name (the AGRUN-550 bug was exactly this door silently ignoring flags it did
// not know about), and the publish-side gates (blocks/terminal-repair.js,
// actions/workspace/publish-sources.js) each hardcoded
// `publishLoopEscapeGranted === true`. Adding a fifth valve therefore required
// editing every door again — the same shape of bug AGRUN-555 removed from the
// grant side.
//
// This module is the ONE place that knows, per escape valve, (a) its state
// flag key, (b) which terminal door it opens (finalize vs publish-direct), and
// (c) its observability reason label. core.js builds terminalEscapeRules FROM
// these descriptors (the descriptor ORDER is the grant priority), and every
// door consumer resolves the granted escape through
// resolveGrantedTerminalEscape instead of naming flags. Adding a valve is now:
// append one descriptor here + one grant predicate in core.js — every door
// honors it automatically.
//
// Zero imports on purpose: this sits below core.js AND below
// terminal-repair/availability.js in the import graph, so neither pulls a
// cycle through the terminal-repair-state.js barrel.

const TERMINAL_ESCAPE_RULE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    // AGRUN-542 — content-level structure exit: length and sources are
    // satisfied, a real candidate exists, but semantic duplicate sections /
    // body-after-final-section remain after the single content-changing repair
    // attempt budget is used (or the model kept ignoring the repair contract).
    // Opens PUBLISH (honest limited delivery of the drafted artifact) and
    // NEVER finalize — a finalize here would re-summarize/compress a candidate
    // whose length contract is already satisfied (the AGRUN-541 regression
    // shape). FIRST in priority: its grant predicate is mutually exclusive
    // with the source/candidate-quality escapes (those require source
    // deficits; this requires source satisfied) and it must outrank the
    // generic publish-loop escape so the observability reason names the real
    // cause.
    key: "contentStructureExitForcedPublishGranted",
    opensFinalize: false,
    opensPublish: true,
    escapeReason: "content_structure_exit_forced_publish"
  }),
  Object.freeze({
    // AGRUN-307 — zero-evidence source deficit is unresolvable; opens an honest
    // finalize (answer with disclosed limitations) instead of a dead repair loop.
    key: "sourceDeficitEscapeGranted",
    opensFinalize: true,
    opensPublish: false,
    escapeReason: "source_deficit_unresolvable"
  }),
  Object.freeze({
    // AGRUN-307 — un-convergeable publish protocol with a real drafted
    // candidate; deliberately opens PUBLISH (deliver the drafted artifact
    // as-is), NOT finalize (which would re-summarize/compress the report).
    key: "publishLoopEscapeGranted",
    opensFinalize: false,
    opensPublish: true,
    escapeReason: "publish_loop_unconvergeable"
  }),
  Object.freeze({
    // AGRUN-309 — unresolvable candidate-quality citation loop; opens finalize
    // (honest terminal answer), never publish (would ship a "verified report"
    // citing an unread URL).
    key: "candidateQualityUnresolvable",
    opensFinalize: true,
    opensPublish: false,
    escapeReason: "candidate_quality_unresolvable"
  }),
  Object.freeze({
    // AGRUN-550 — terminal thrash with NO drafted candidate; opens finalize so
    // the runtime finalizer delivers an honest answer from gathered evidence.
    key: "terminalThrashEscapeGranted",
    opensFinalize: true,
    opensPublish: false,
    escapeReason: "terminal_thrash_no_candidate"
  })
]);

// Resolve which escape valve (if any) the given terminal-repair state has
// granted. Pure flag read in descriptor priority order — core.js guarantees at
// most one flag is true per evaluation (first-match-wins), and
// clearTerminalRepairState/createTerminalRepairState drop the flags entirely,
// so a cleared or never-active state resolves to null. Deliberately does NOT
// gate on `state.active`: each door keeps its own active-gating exactly where
// it always was (behavior-preserving), and publish-side consumers historically
// read the flag without an active check.
function resolveGrantedTerminalEscape(terminalRepairState) {
  const state = terminalRepairState && typeof terminalRepairState === "object" && !Array.isArray(terminalRepairState)
    ? terminalRepairState
    : null;
  if (!state) return null;
  return TERMINAL_ESCAPE_RULE_DESCRIPTORS.find((rule) => state[rule.key] === true) || null;
}

export { TERMINAL_ESCAPE_RULE_DESCRIPTORS, resolveGrantedTerminalEscape };
