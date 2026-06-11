// ADR-0035 (AGRUN-262) — host prompt-override resolution.
//
// Each planner-prompt section has a default (a frozen string[] OR a
// buildLines(ctx) function). A host may override a section via
// runtimeConfig.prompts.<key>. This module is the SSOT for the override
// contract and the single resolver both the envelope-mode
// (buildSystemPromptLines) and native-mode (buildNativeToolsSystemPrompt)
// builders call.

// The complete, backward-compatible-forever set of override keys. config.js
// validates host input against this list (throws on unknown keys). Adding a
// key is safe; renaming/removing one is a breaking change.
const PROMPT_SECTION_KEYS = Object.freeze([
  "basePlannerDirectives",    // envelope base-mode directive body
  "compactPlannerDirectives", // envelope compact-mode directive body
  "skillDirectives",          // envelope skill-discovery blocks
  "workspaceDirectives",      // envelope virtual-workspace blocks
  "researchDirectives",       // envelope web_search/read_url blocks
  "convergenceAdvisory",      // envelope signal/finalize advisory block
  "todoDirectives",           // envelope TodoState auto-planner block
  "nativePlannerDirectives"   // native tool-calling mode directive body
]);

// Resolve one section to its final string[] lines.
//
//   override === undefined → use the runtime default (array or builder fn)
//   override === null / false → section disabled (empty); NO default re-inject
//   override is array → used verbatim
//   override is function → called with ctx, must return string[]
//
// The same branch handles array/function for BOTH the default and the override.
// Non-string entries in a function's return (host OR default) are dropped so a
// malformed override cannot break the run — matching config.js house style
// (normalizeOutputGuardrails drops invalid entries rather than throwing).
//
// ctx shape is per-call-site and is public surface (documented in
// prompts/README.md): envelope sections receive
// { availableActions, compactSystemPrompt } (+ stripOodaeSignals for
// convergenceAdvisory); the native section receives
// { availableActions, standaloneActionNames, nativePlanGuidance }.
function resolvePromptSection(override, defaultValue, ctx) {
  const chosen = override === undefined ? defaultValue : override;
  if (chosen === null || chosen === false) return [];
  const out = typeof chosen === "function" ? chosen(ctx) : chosen;
  if (!Array.isArray(out)) return [];
  return out.filter((line) => typeof line === "string");
}

export { PROMPT_SECTION_KEYS, resolvePromptSection };
