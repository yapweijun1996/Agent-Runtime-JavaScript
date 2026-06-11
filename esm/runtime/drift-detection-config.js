// AGRUN-146 — Drift detector config normalizer.
//
// Extracted into its own module so unit tests can exercise the validation
// table without importing the full runtime config graph (which transitively
// pulls in virtual: bundler aliases). Kept lexicon-free: thresholds are
// numeric bands on similarity in [0,1]; no domain vocabulary.

const DEFAULTS$1 = Object.freeze({
  enabled: false,
  cycleInterval: 5,
  severeThreshold: 0.4,
  mildThreshold: 0.7,
  maxTrajectoryEntries: 5,
  similarityFn: null
});

function normalizeDriftDetectionConfig(value) {
  if (value == null || value === false) return { ...DEFAULTS$1 };
  if (value === true) return { ...DEFAULTS$1, enabled: true };
  if (typeof value !== "object") return { ...DEFAULTS$1 };

  const enabled = value.enabled === true;
  const cycleInterval = readPositiveInteger$3(value.cycleInterval, DEFAULTS$1.cycleInterval);
  const severeThreshold = readUnitInterval(value.severeThreshold, DEFAULTS$1.severeThreshold);
  const mildThreshold = readUnitInterval(value.mildThreshold, DEFAULTS$1.mildThreshold);
  const maxTrajectoryEntries = readPositiveInteger$3(
    value.maxTrajectoryEntries,
    DEFAULTS$1.maxTrajectoryEntries
  );
  const similarityFn = typeof value.similarityFn === "function" ? value.similarityFn : null;

  return {
    enabled,
    cycleInterval,
    severeThreshold,
    mildThreshold,
    maxTrajectoryEntries,
    similarityFn
  };
}

function readPositiveInteger$3(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function readUnitInterval(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0 || value > 1) return fallback;
  return value;
}

export { normalizeDriftDetectionConfig };
