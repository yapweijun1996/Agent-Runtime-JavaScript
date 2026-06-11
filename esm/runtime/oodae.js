import { cloneValue } from './utils.js';

const OODAE_PHASES = Object.freeze([
  "observe",
  "orient",
  "decide",
  "act",
  "evaluate"
]);

function createOodaeState() {
  return {
    currentPhase: null,
    phases: [...OODAE_PHASES],
    cycles: []
  };
}

function createCycleRecord(runState) {
  const cycle = {
    cycle: runState.cycleCount,
    observe: null,
    orient: null,
    decide: null,
    act: null,
    evaluate: null
  };

  runState.oodae.cycles.push(cycle);
  return cycle;
}

function startPhase(runState, pushStep, phase, detail) {
  runState.phase = phase;
  runState.oodae.currentPhase = phase;
  pushStep(`phase-${phase}-started`, detail);
}

function completePhase(cycleRecord, pushStep, phase, detail) {
  cycleRecord[phase] = cloneValue(detail);
  pushStep(`phase-${phase}-completed`, detail);
  return cycleRecord[phase];
}

function createObserveRecord(currentInput, memory, runState) {
  return {
    cycle: runState.cycleCount,
    inputType: currentInput.type,
    hasTextInput: typeof currentInput.text === "string" && currentInput.text.length > 0,
    memoryEntries: memory.readAll().length,
    previousObservationKind: runState.observation ? runState.observation.kind : null,
    previousSkill: runState.selectedSkill
  };
}

function createOrientRecord(observeRecord, runtimeConfig, options) {
  const config = {};
  const record = {
    cycle: observeRecord.cycle,
    // AGRUN-274d-4 — `fallbackSkill` was a skill-loop concept. Kept
    // as `null` for backwards-compat with consumers reading the
    // projection.
    fallbackSkill: null,
    inputType: observeRecord.inputType,
    maxSteps: runtimeConfig.maxSteps,
    previousObservationKind: observeRecord.previousObservationKind
  };

  if (typeof config.selectedSkill === "string" && config.selectedSkill.length > 0) {
    record.selectedSkill = config.selectedSkill;
  }

  if (config.skillOrientation != null) {
    record.skillOrientation = cloneValue(config.skillOrientation);
  }

  return record;
}

function createEvaluationRecord(options) {
  const {
    error,
    memoryEntriesAdded,
    nextInput,
    output,
    runState,
    skillEvaluation,
    source
  } = options;

  if (error) {
    const record = {
      code: error.code,
      errorSource: source,
      outcome: "error",
      selectedSkill: error.skill
    };

    if (skillEvaluation != null) {
      record.skillEvaluation = cloneValue(skillEvaluation);
    }

    return record;
  }

  if (nextInput) {
    const record = {
      nextInputType: nextInput.type,
      observationKind: runState.observation ? runState.observation.kind : null,
      outcome: "continue",
      selectedSkill: runState.selectedSkill
    };

    if (skillEvaluation != null) {
      record.skillEvaluation = cloneValue(skillEvaluation);
    }

    return record;
  }

  const record = {
    memoryEntriesAdded: memoryEntriesAdded.length,
    observationKind: runState.observation ? runState.observation.kind : null,
    outcome: "complete",
    outputKind: detectOutputKind(output),
    selectedSkill: runState.selectedSkill
  };

  if (skillEvaluation != null) {
    record.skillEvaluation = cloneValue(skillEvaluation);
  }

  return record;
}

function detectOutputKind(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return typeof output;
  }

  if (typeof output.kind === "string" && output.kind.length > 0) {
    return output.kind;
  }

  return "object";
}

export { OODAE_PHASES, completePhase, createCycleRecord, createEvaluationRecord, createObserveRecord, createOodaeState, createOrientRecord, startPhase };
