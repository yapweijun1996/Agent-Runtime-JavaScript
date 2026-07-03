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

// AGRUN-517 — host-policy gate for the per-turn memory-extraction LLM call.
//
// `shouldExtractSessionMemory` decides whether a turn is *structurally eligible*
// (completed tool-loop turn). This evaluates the host's optional
// `memoryExtractionPolicy` to decide whether to actually SPEND the extraction
// provider call on an eligible turn. agrun ships NO prompt heuristic of its own:
// with no policy the answer is always "extract", preserving memory quality and
// the historical default. A host whose simple-chat profile does not need
// per-turn cross-session mining supplies a policy that returns `false`
// (or `{ extract: false, reason }`) to skip the call — eliminating the extra
// provider round-trip the live smoke flagged.
//
// Fail-open: a throwing host policy must never silently drop memory, so an error
// is reported (via the returned `error`) and the turn still extracts.
//
// Returns `{ extract, reason?, error? }`.
async function evaluateMemoryExtractionPolicy(policy, context) {
  if (typeof policy !== "function") {
    return { extract: true };
  }

  let decision;
  try {
    decision = await policy(context);
  } catch (error) {
    return { extract: true, error: normalizeThrownError(error).message };
  }

  if (decision === false) {
    return { extract: false, reason: "" };
  }
  if (decision && typeof decision === "object" && decision.extract === false) {
    return {
      extract: false,
      reason: typeof decision.reason === "string" ? decision.reason : ""
    };
  }
  return { extract: true };
}

// AGRUN-514 — pure extraction + sync-only result mutation.
//
// Returns `{ entries, status }` where `status` is the extraction outcome
// (`{ status: "completed", entryCount }` or `{ status: "failed", message }`).
// The returned `result.runState.semanticState.memoryExtraction` is written ONLY
// when `options.mutateResult === true` (the sync, default path). On the async
// path the result object has already been handed back to the caller, so mutating
// it would make a returned value change after the fact; instead the caller
// records the returned `status` into a host-visible memory diagnostic.
async function extractMemoryEntries(options) {
  const mutateResult = options.mutateResult === true;
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
    const status = { entryCount: entries.length, status: "completed" };
    if (mutateResult) writeMemoryExtractionState(options.result.runState, status);
    return { entries, status };
  } catch (error) {
    const status = { message: normalizeThrownError(error).message, status: "failed" };
    if (mutateResult) writeMemoryExtractionState(options.result.runState, status);
    return { entries: [], status };
  }
}

// SSOT for stamping the extraction outcome onto the turn's runState — used only
// on the sync path so the returned result stays stable once handed back.
function writeMemoryExtractionState(runState, status) {
  if (!runState || typeof runState !== "object") return;
  const semanticState = runState.semanticState && typeof runState.semanticState === "object"
    ? runState.semanticState
    : {};
  runState.semanticState = {
    ...semanticState,
    memoryExtraction: { ...status }
  };
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

export { createSessionFailureResult, evaluateMemoryExtractionPolicy, extractMemoryEntries, shouldExtractSessionMemory };
