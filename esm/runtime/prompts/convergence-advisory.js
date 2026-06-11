// ADR-0035 (AGRUN-262) — convergence / read-only-signal advisory directives.
// Extracted verbatim from planner-prompt.js buildSystemPromptLines (the final
// compact-vs-base signal-reading block). These lines tell the AI how to read
// loopState repair signals (plannerInvalidSignal, actionFailureSignal,
// readAttemptSignal, qualityContext, planValidationFeedback) and finalize.
// Host override key: `convergenceAdvisory`. Default output is byte-identical
// (locked by test/unit/prompt-snapshot.test.js).
//
// `stripOodaeSignals` is the SPIKE/oodae-ablation flag (planner-prompt.js
// SPIKE_STRIP_OODAE_SIGNALS) threaded in so the A/B knob keeps working; in
// production it is false and every line renders.
function buildLines$2({ compactSystemPrompt, stripOodaeSignals = false } = {}) {
  const lines = [];

  if (compactSystemPrompt) {
    lines.push("If plannerInvalidSignal, planValidationFeedback, qualityContext, actionFailureSignal, or readAttemptSignal is present, read it and choose a corrected next envelope yourself.");
  } else {
    lines.push("If your previous envelope was invalid or empty, the runtime surfaces loopState.plannerInvalidSignal as read-only repair facts. Return one corrected planner JSON envelope yourself; runtime will not synthesize web_search or any other fallback action.");
    lines.push("If loopState.planValidationFeedback is present, your previous type:\"plan\" envelope failed the runtime envelope contract. Read its code/detail/error and choose the next valid envelope yourself; do not repeat the same invalid plan shape.");
    if (!stripOodaeSignals) {
      lines.push("If your previous final answer triggered runtime quality issues, runtime emits enum codes via loopState.qualityContext (issues: ['placeholder_artifact', 'claim_count_exceeds_source_coverage', 'missing_research_report_sections', etc.], noteCount). The runtime no longer blocks finalize on these — read the codes and either expand the answer (workspace_replace, fresh finalize) or accept and re-emit if you disagree with the diagnosis.");
    }
    // ADR-0026 — read-only signal replacing the deleted consecutive-failure
    // force-finalize guard. AI sees the count and decides; runtime no longer
    // pushes the run to terminate.
    lines.push("If loopState.actionFailureSignal is present (actionName, consecutiveCount, threshold), the same action has failed `consecutiveCount` times in a row. That endpoint or tool may be down. Switch tactics (different action, different query, or finalize with what you have already gathered) — do not retry the exact same call indefinitely. The runtime will not force-terminate the run; it will hit `maxSteps` if you keep retrying.");
    lines.push("If loopState.plannerInvalidSignal is present, your prior planner envelope was invalid or empty. Read reason, repairMode, requiredEnvelope, forbiddenMoves, and lastResponsePreview. When escalation=hard_veto, stop repeating the same invalid shape and return one valid planner JSON envelope; runtime reports the problem but does not choose a fallback action.");
    lines.push("If the workspace block shows publish block or low-budget facts, read them as action-contract feedback and choose a corrected next envelope yourself. Runtime reports the facts; it does not decide the recovery strategy.");
    // ADR-0028 — read-only signal replacing the deleted resolveResearchContinuation
    // auto-read pick + summarize_limits push. AI owns the read_url URL choice
    // and decides whether thin evidence warrants finalize or another search.
    if (!stripOodaeSignals) {
      lines.push("If loopState.readAttemptSignal is present (attemptCount, threshold), you have read `attemptCount` URLs this turn. The runtime no longer auto-picks the next URL or auto-finalizes when attemptCount reaches threshold — that is your call. Choose one: read another URL (different from the ones already in `readSources`), run a fresh `web_search` with a different query, or finalize with whatever evidence you have gathered (state limitations honestly per ADR-0024). The runtime will not stop you; it will hit `maxSteps` if you keep retrying without progress.");
    }
    lines.push("Use finalize only when YOU judge the current tool evidence, readSources, skill instructions, and any virtual workspace draft are enough for a user-facing answer. Runtime does not decide sufficiency for you.");
    lines.push("When a loaded skill or action contract requires finalReadiness, include it on finalize/publish using observable tool, readSources, and workspace facts. It is YOUR self-assessment; runtime records consistency and required-field checks only.");
    lines.push("If the user explicitly asks the final answer to include finalReadiness.decision, include one plain-text line with that exact field in the visible answer and keep it consistent with your finalReadiness.decision. Do not output readiness JSON.");
    lines.push("Use final only when no tool, loaded skill workflow, virtual workspace drafting, read_url evidence, or readiness contract is needed.");
  }

  return lines;
}

export { buildLines$2 as buildLines };
