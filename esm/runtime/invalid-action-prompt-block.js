// ADR-0034 — planner-prompt observation block surfaced when
// invalidActionConvergence.active === true. AGRUN-249 regrowth-guard
// compliant: no MUST/SHOULD/NOW prose, no hardcoded action-name fallback
// arrays. Output is a JSON observation block the AI reads to choose a
// different action; runtime does NOT author the move.

function buildInvalidActionPromptBlock(convergence) {
  if (!convergence || typeof convergence !== "object" || convergence.active !== true) {
    return "";
  }
  const payload = {
    lastInvalidActionName: typeof convergence.actionName === "string" ? convergence.actionName : (convergence.lastInvalidActionName || null),
    isInDisabledActions: Array.isArray(convergence.disabledActionsEncountered)
      ? convergence.disabledActionsEncountered.includes(convergence.actionName || convergence.lastInvalidActionName)
      : false,
    consecutiveInvalidCount: readNonNegativeInteger$1(convergence.consecutiveInvalidCount),
    consecutiveRepairFailureCount: readNonNegativeInteger$1(convergence.consecutiveRepairFailureCount),
    escalation: convergence.escalation === "hard_signal" ? "hard_signal" : "advisory",
    availableActions: trimArray(convergence.availableActions, 24),
    availableAgentSkillIds: trimArray(convergence.availableAgentSkillIds, 32)
  };
  return ["Invalid action observation:", JSON.stringify(payload)].join("\n");
}

function readNonNegativeInteger$1(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function trimArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).filter((item) => typeof item === "string" && item.length > 0);
}

export { buildInvalidActionPromptBlock };
