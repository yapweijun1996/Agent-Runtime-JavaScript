// AGRUN-142 — Goal anchor config normalizer.
//
// Extracted into its own module (same pattern as drift-detection-config.js)
// so unit tests can exercise the validation table without importing the
// full runtime config graph (which transitively pulls in virtual: bundler
// aliases). Lexicon-free: only controls whether the verbatim original-query
// + thread goal-anchor block is prepended to planner / finalizer prompts.

const DEFAULTS = Object.freeze({
  enabled: true,
  maxAnchorChars: 4000,
  includeThreadAnchor: true
});

function normalizeGoalAnchorConfig(value) {
  if (value == null) return { ...DEFAULTS };
  if (value === true) return { ...DEFAULTS, enabled: true };
  if (value === false) return { ...DEFAULTS, enabled: false };
  if (typeof value !== "object") return { ...DEFAULTS };

  const enabled = value.enabled !== false;
  const maxAnchorChars = readPositiveInteger$2(value.maxAnchorChars, DEFAULTS.maxAnchorChars);
  const includeThreadAnchor = value.includeThreadAnchor !== false;

  return {
    enabled,
    maxAnchorChars,
    includeThreadAnchor
  };
}

function readPositiveInteger$2(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export { normalizeGoalAnchorConfig };
