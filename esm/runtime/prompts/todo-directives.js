import { buildTodoAutoPlannerGuidance } from '../todo-auto-planner-guidance.js';

// ADR-0035 (AGRUN-262) — TodoState auto-planner planner directives.
// The directive STRINGS already live in todo-auto-planner-guidance.js (gated on
// the presence of todo_* actions). This thin section wraps that module so the
// override API exposes a `todoDirectives` key and so the todo guidance is a
// first-class, host-replaceable section like the others. Default output is
// byte-identical: base mode renders buildTodoAutoPlannerGuidance(actions),
// compact mode renders nothing (matches the pre-refactor `!compactSystemPrompt`
// gate). Locked by test/unit/prompt-snapshot.test.js.

function buildLines$1({ availableActions, compactSystemPrompt } = {}) {
  if (compactSystemPrompt) return [];
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  return buildTodoAutoPlannerGuidance(actionDefinitions);
}

export { buildLines$1 as buildLines };
