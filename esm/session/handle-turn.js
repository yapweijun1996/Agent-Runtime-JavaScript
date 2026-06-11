import { createPushStep } from '../runtime/context.js';
import { normalizeInput } from '../runtime/input.js';
import { finalizeResult } from '../runtime/result.js';
import { projectResearchRunState } from '../runtime/run-state-projections.js';
import { createRunState, readSessionLineage } from '../runtime/state.js';
import { cloneValue } from '../runtime/utils.js';
import { isToolLoopProviderRequest } from '../runtime/provider.js';
import { normalizeThrownError } from '../runtime/errors.js';
import { projectSessionContextFromSnapshot } from './context-snapshot-projection.js';
import { extractSessionMemoryEntries } from './extract.js';

function shouldExtractSessionMemory(userMessage, assistantMessage, result, preparedInput) {
  return Boolean(
    result &&
    result.runState &&
    result.runState.mode === "tool_loop" &&
    result.runState.status === "completed" &&
    isToolLoopProviderRequest(preparedInput) &&
    userMessage &&
    userMessage.status === "completed" &&
    assistantMessage &&
    assistantMessage.status === "completed"
  );
}

async function extractMemoryEntries(options) {
  const sessionContext = options.result &&
    options.result.runState &&
    options.result.runState.contextSnapshot
    ? projectSessionContextFromSnapshot(options.result.runState.contextSnapshot)
    : null;
  const provenance = readExtractionProvenance(options.result && options.result.runState);

  try {
    const entries = await extractSessionMemoryEntries({
      assistantMessage: options.assistantMessage,
      provenance,
      request: options.preparedInput,
      sessionContext,
      userMessage: options.userMessage
    });
    const semanticState = options.result.runState.semanticState && typeof options.result.runState.semanticState === "object"
      ? options.result.runState.semanticState
      : {};
    options.result.runState.semanticState = {
      ...semanticState,
      memoryExtraction: {
        entryCount: entries.length,
        status: "completed"
      }
    };
    return entries;
  } catch (error) {
    const semanticState = options.result.runState.semanticState && typeof options.result.runState.semanticState === "object"
      ? options.result.runState.semanticState
      : {};
    options.result.runState.semanticState = {
      ...semanticState,
      memoryExtraction: {
        message: normalizeThrownError(error).message,
        status: "failed"
      }
    };
    return [];
  }
}

/**
 * Assemble provenance for auto-extracted memory entries. Reads the active
 * thread + turn identifiers off the completed runState and harvests read
 * source URLs from the research context so downstream
 * `buildThreadScopedEvidenceUrls` has thread-tagged evidence to filter.
 * Returns null when the runState is missing or carries no distinguishing
 * information (flag-off path, non-tool-loop turns, etc.).
 */
function readExtractionProvenance(runState) {
  if (!runState || typeof runState !== "object") return null;
  const provenance = { source: "auto_extract" };
  if (typeof runState.threadId === "string" && runState.threadId.trim()) {
    provenance.threadId = runState.threadId.trim();
  }
  if (typeof runState.runId === "string" && runState.runId.trim()) {
    provenance.turnId = runState.runId.trim();
  }
  const research = projectResearchRunState(runState).researchContext;
  if (research && Array.isArray(research.readSources)) {
    provenance.readSources = research.readSources.slice();
  }
  return provenance;
}

function createSessionFailureResult(options) {
  const normalizedInput = normalizeInput(options.rawInput);
  const runState = createRunState(
    options.runId,
    options.runtimeConfig.maxSteps,
    readSessionLineage(options),
    { runtimeEventBus: options.runtimeEventBus }
  );
  const steps = [];
  const pushStep = createPushStep(steps, runState, options.onStep);

  runState.mode = "tool_loop";
  pushStep("run-started", {
    inputType: normalizedInput.type,
    maxSteps: options.runtimeConfig.maxSteps
  });
  pushStep("prompt-budget-exceeded", {
    code: options.error.code
  });
  runState.status = "failed";
  runState.contextSnapshot = cloneValue(options.contextSnapshot || null);
  runState.sessionContextMeta = cloneValue(options.sessionContextMeta);
  runState.sessionContextView = cloneValue(options.sessionContextView);
  runState.phase = "evaluate";
  runState.error = cloneValue(options.error);
  runState.observation = {
    code: options.error.code,
    kind: "error",
    message: options.error.message
  };

  const result = finalizeResult(
    options.rawInput,
    normalizedInput,
    runState,
    null,
    [],
    steps,
    options.runtimeState
  );

  return {
    lastRun: cloneValue(options.runtimeState.lastRun),
    result
  };
}

export { createSessionFailureResult, extractMemoryEntries, shouldExtractSessionMemory };
