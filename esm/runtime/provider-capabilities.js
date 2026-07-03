const DEFAULT_PLANNER_CAPABILITIES = Object.freeze({
  nativePlan: Object.freeze({
    executeSkillToolArgsShape: "object",
    guidance: "",
    toolArgsJsonRequired: false
  })
});

const GEMINI_PLANNER_CAPABILITIES = Object.freeze({
  nativePlan: Object.freeze({
    executeSkillToolArgsShape: "toolArgsJson",
    guidance: "Gemini native plan compatibility: when a plan action calls execute_skill_tool, put the tool payload in toolArgsJson as a JSON string, for example {\"label\":\"alpha\"}. Do not use nested toolArgs for Gemini plan actions.",
    toolArgsJsonRequired: true
  })
});

function resolvePlannerMode({
  configuredMode
} = {}) {
  const normalizedConfiguredMode = normalizeConfiguredPlannerMode(configuredMode);
  if (normalizedConfiguredMode !== "auto") {
    return Object.freeze({
      configuredMode: normalizedConfiguredMode,
      effectiveMode: normalizedConfiguredMode,
      reason: "explicit"
    });
  }

  // ADR-0058 (2026-07-02, supersedes ADR-0031) — auto resolves to
  // native_tools: measured equal-or-faster with equal-or-better correctness
  // on openai/gemini/deepseek across short-task and long-report live A/Bs
  // after the C3a/C3b gap fixes (AGRUN-574/575/576/577/578).
  // `nativeToolsFailurePolicy` (default fallback_to_envelope) keeps envelope
  // as the per-call safety net; `plannerMode: "envelope"` remains the
  // explicit opt-out. The resolver stays provider/model-agnostic.
  return Object.freeze({
    configuredMode: "auto",
    effectiveMode: "native_tools",
    reason: "default_native_tools"
  });
}

function getPlannerProviderCapabilities(provider) {
  return readProviderId(provider) === "gemini"
    ? GEMINI_PLANNER_CAPABILITIES
    : DEFAULT_PLANNER_CAPABILITIES;
}

// ADR-0033 Tier A (revised AGRUN-294I, 2026-05-29) — lite tier is a
// HOST-DECLARED policy, not a model-name heuristic.
//
// The previous implementation matched a hardcoded marker list
// (flash / mini / haiku / nano / flash-lite) against the model string and
// forced the compact planner prompt for any match. Two problems:
//   1. It is exactly the model-name hardcode the project's "no hardcode"
//      mandate bans — harness behaviour branched on the literal model id.
//   2. Compact mode STRIPS skill/todo/workspace context. Auto-applying it by
//      name removed context from precisely the weak models that most need
//      decomposition support — the "blame the model for a harness gap"
//      anti-pattern.
//
// Now: lite tier is opt-in only. A host that genuinely wants compact prompts
// for a weak model declares `request.modelTier: "lite"`. The default is
// capable (full, state-based prompt). `modelTier: "capable"` is accepted for
// symmetry/explicitness. The `model` arg is kept for signature stability but
// no longer influences the result.
function isLiteTierModel(model, options) {
  const opts = options && typeof options === "object" ? options : {};
  return readModelTierOverride(opts.modelTier) === "lite";
}

function normalizeConfiguredPlannerMode(value) {
  if (value === "native_tools" || value === "envelope") {
    return value;
  }
  return "auto";
}

function readProviderId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function readModelTierOverride(value) {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (tier === "lite" || tier === "capable") return tier;
  return "";
}

export { getPlannerProviderCapabilities, isLiteTierModel, resolvePlannerMode };
