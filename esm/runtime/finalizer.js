import { startPhase, completePhase, createEvaluationRecord } from './oodae.js';
import { summarizeLastObservationForPrompt } from './planner-prompt-projection.js';
import { scrubSecretText } from './provider-error.js';
import { applyFailure, finalizeResult } from './result.js';
import { cloneValue } from './utils.js';

// F7 (weak-model e2e audit 2026-06-10) — the observation text the model
// actually receives was not persisted in ANY trace artifact, so feedback-
// wording work had to reverse-engineer it from runtime code. recordObservation
// is the single funnel every observation passes through; attach the SAME
// projection the planner prompt will see (secret-scrubbed, size-capped) to
// the step so trace.v1 carries first-class evidence.
const OBSERVATION_PREVIEW_MAX_CHARS = 2000;

function recordObservation(runState, pushStep, observation, detail) {
  runState.observation = cloneValue(observation);
  const step = cloneValue(detail);
  const enriched = step && typeof step === "object" && !Array.isArray(step) ? step : {};
  if (enriched.observationPreview === undefined) {
    enriched.observationPreview = buildObservationPreview(observation);
  }
  pushStep("observation-recorded", enriched);
}

function buildObservationPreview(observation) {
  try {
    const projected = summarizeLastObservationForPrompt(observation);
    if (!projected) return null;
    const text = scrubSecretText(JSON.stringify(projected));
    return text.length > OBSERVATION_PREVIEW_MAX_CHARS
      ? `${text.slice(0, OBSERVATION_PREVIEW_MAX_CHARS - 1)}…`
      : text;
  } catch {
    // Preview is evidence, never load-bearing — a projection error must not
    // break the run.
    return null;
  }
}

function startEvaluatePhase(runState, pushStep, selectedSkill) {
  startPhase(runState, pushStep, "evaluate", {
    cycle: runState.cycleCount,
    selectedSkill: selectedSkill || null
  });
}

function completeEvaluatePhase(cycleRecord, pushStep, detail) {
  return completePhase(cycleRecord, pushStep, "evaluate", cloneValue(detail));
}

function finishRun(options) {
  return finalizeResult(
    options.rawInput,
    options.normalizedInput,
    options.runState,
    options.output,
    options.memoryEntriesAdded,
    options.steps,
    options.runtimeState
  );
}

function finishFailure(options) {
  applyFailure(options.runState, options.error, options.pushStep);
  startEvaluatePhase(options.runState, options.pushStep, options.selectedSkill || null);
  completeEvaluatePhase(
    options.cycleRecord,
    options.pushStep,
    options.evaluationDetail || createEvaluationRecord({
      error: options.error,
      memoryEntriesAdded: options.memoryEntriesAdded,
      output: options.output,
      runState: options.runState,
      skillEvaluation: options.skillEvaluation || null,
      source: options.source || "act"
    })
  );

  return finishRun(options);
}

export { completeEvaluatePhase, finishFailure, finishRun, recordObservation, startEvaluatePhase };
