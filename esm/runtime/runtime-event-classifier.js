import { readString } from './semantic-json.js';

// AGRUN-248-C — Pure classifier mapping `(type, mode)` → `{ visibility, phase }`.
//
// 104 step types do NOT get a per-type enum. Rules are prefix/suffix based so
// new step types are auto-categorized without a migration table. classifier
// stays free of runtime state — it only reads its inputs.


const VISIBILITY_AGENT_TYPES = Object.freeze(
  new Set(["action-executing", "action-executed", "action-execute-error"])
);

// Match failure / state-transition tokens at the end OR followed by another
// `-` segment, so both `policy-blocked` and `planner-invalid-action` qualify
// as user-visible without forcing a per-type allowlist.
const VISIBILITY_USER_TOKEN_RE = /-(?:blocked|error|failed|invalid|refreshed|rejected)(?:-|$)/;

const PHASE_FROM_PHASE_PREFIX_RE = /^phase-(observe|orient|decide|act|evaluate)(?:-|$)/;

const LIFECYCLE_TYPES = Object.freeze(
  new Set(["run-started", "run-completed", "cycle-started", "cycle-completed"])
);

function classifyEvent({ type, mode } = {}) {
  // ADR-0055 — stream events share the kebab-case spelling of their step
  // twins, so classification must key on mode, not on naming accidents:
  // wire-level stream duplicates stay debug-visibility (the step event is
  // the canonical agent/user-visible record) exactly as they were when
  // their snake_case names happened to match no visibility rule.
  if (mode === "stream") {
    return { visibility: "debug", phase: null };
  }
  return {
    visibility: classifyVisibility(type),
    phase: classifyPhase(type)
  };
}

function classifyVisibility(type, _mode) {
  const value = readString(type);
  if (!value) return "debug";

  // Explicit agent allowlist wins first — action-execute-error matches the
  // user-suffix regex but is an AI-loop signal the planner must observe.
  if (VISIBILITY_AGENT_TYPES.has(value)) return "agent";

  // User-visible failure / state-transition suffixes win over family prefix:
  // a planner-invalid-action is an error the user should see, not a normal
  // decide-phase signal.
  if (VISIBILITY_USER_TOKEN_RE.test(value)) return "user";

  if (value.startsWith("provider-")) return "agent";
  if (value.startsWith("planner-")) return "agent";
  if (value.startsWith("phase-")) return "agent";
  if (value.startsWith("cycle-")) return "agent";
  if (value.startsWith("observation-")) return "agent";

  return "debug";
}

function classifyPhase(type) {
  const value = readString(type);
  if (!value) return null;

  const phaseMatch = PHASE_FROM_PHASE_PREFIX_RE.exec(value);
  if (phaseMatch) return phaseMatch[1];

  if (value.startsWith("provider-")) return "decide";
  if (value.startsWith("planner-")) return "decide";
  if (value.startsWith("action-")) return "act";
  if (value.startsWith("observation-")) return "observe";
  if (value.startsWith("evaluate-")) return "evaluate";

  if (LIFECYCLE_TYPES.has(value)) return "lifecycle";

  return null;
}

export { classifyEvent, classifyPhase, classifyVisibility };
