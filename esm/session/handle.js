import { createMemoryStore } from '../memory/store.js';
import { readAbortSignal, wrapHookForAbort, isAbortSignalAborted, createAbortError } from '../runtime/abort-signal.js';
import { isApprovalResolutionRequest } from '../runtime/approval-state.js';
import { runLoop } from '../runtime/run-loop.js';
import { routeTopic } from '../runtime/topic-router.js';
import { extractTurnIntent } from '../runtime/turn-intent.js';
import { planTurnIntent, mergeTurnIntent } from '../runtime/turn-intent-planner.js';
import { cloneValue } from '../runtime/utils.js';
import { mergeRunOptions } from '../runtime/default-run-options.js';
import { isToolLoopProviderRequest } from '../runtime/provider.js';
import { serializeResearchSlice, normalizeResearchSlice } from '../runtime/research-thread-sync.js';
import { readActiveThreadId, readActiveTurnId } from '../runtime/thread-provenance.js';
import { createSessionRunIdGenerator } from '../runtime/run-identity.js';
import { createWriteQueue } from '../runtime/durable-write-queue.js';
import { createRunEventStream } from '../runtime/run-event-stream.js';
import { prepareSessionApprovalResumeInput } from './approval-resume.js';
import { prepareProviderSessionContext } from './compaction.js';
import { buildThreadScopedEvidenceUrls } from './evidence.js';
import { mergeGlobalIntoSessionMemory, isGlobalMemoryCandidate, promoteToGlobalMemory } from './global-memory.js';
import { extractUserMessageText, readThreadsState, applyRouterVerdict } from './thread.js';
import { createPendingUserMessage, readPersistedMessageStatus, createAssistantMessage, createCompactionTurnMessages } from './messages.js';
import { createUsageSnapshot, accumulateUsage } from './token-budget.js';
import { recordCostEntry } from '../runtime/cost-ledger.js';
import { projectTodoRunState, projectResearchRunState } from '../runtime/run-state-projections.js';
import { readFiniteNumber } from '../runtime/semantic-json.js';
import { projectSessionContextFromSnapshot, createSessionContextViewFromSnapshot } from './context-snapshot-projection.js';
import { summarizeSessionContextMeta } from './prompt.js';
import { createSessionFailureResult, shouldExtractSessionMemory, evaluateMemoryExtractionPolicy, extractMemoryEntries } from './handle-turn.js';
import { normalizeThrownError } from '../runtime/errors.js';

function createSessionHandle(options) {
  let sessionRecord = cloneValue(options.sessionRecord);

  // AGRUN-202 — Session-scoped, durable run id generator.
  // AGRUN-206 — Generator is now async and persists each increment
  // through a CAS write, so concurrent tabs cannot both claim the
  // same `run-N`. Callers MUST `await nextRunId()`.
  const nextRunId = createSessionRunIdGenerator({
    sessionRecord,
    sessionStore: options.sessionStore
  });

  // AGRUN-440/444 — opt-in async memory extraction. Default OFF: extraction (an
  // LLM call) + appendMemory run on the turn's critical path and
  // result.memoryEntriesAdded is populated. When ON, that whole side-effect runs
  // off the critical path through a durable ordered queue, so the turn returns
  // before the extraction completes. Consistency is preserved automatically:
  // every later read (next turn start, getMemory, flushMemory) drains the queue
  // first, so the next turn always sees the prior turn's memory — only
  // result.memoryEntriesAdded for the CURRENT turn becomes eventual.
  // AGRUN-514 — host-visible async memory diagnostics. The extract->append->
  // promote side-effect runs off the critical path, so its outcome can no longer
  // ride the returned result. `lastExtraction` carries the most recent extraction
  // status (completed/failed); `errors` accumulates storage/promotion failures
  // the queue captured. Mirrors the message store's getState() error surface so a
  // host/inspector can see async failures without depending on timing.
  const MAX_MEMORY_ERRORS = 20;
  const memoryDiagnostics = { errors: [], lastExtraction: null };

  function recordMemoryExtraction(status) {
    if (status) memoryDiagnostics.lastExtraction = status;
  }

  function recordMemoryError(error, label) {
    memoryDiagnostics.errors.push({
      label: typeof label === "string" && label.trim() ? label.trim() : "memory",
      message: normalizeThrownError(error).message
    });
    if (memoryDiagnostics.errors.length > MAX_MEMORY_ERRORS) {
      memoryDiagnostics.errors.splice(0, memoryDiagnostics.errors.length - MAX_MEMORY_ERRORS);
    }
  }

  // AGRUN-517 — optional host policy that decides, per eligible turn, whether to
  // spend the memory-extraction LLM call. Null = always extract (historical
  // default). Memory extraction is a session-handle-only mechanism (runtime.run
  // never extracts), so this is a single-door capability — no runtime.run parity
  // to wire. See evaluateMemoryExtractionPolicy in handle-turn.js.
  const memoryExtractionPolicy = typeof options.memoryExtractionPolicy === "function"
    ? options.memoryExtractionPolicy
    : null;

  const asyncMemoryExtraction = options.asyncMemoryExtraction === true;
  const memoryQueue = asyncMemoryExtraction
    ? createWriteQueue({
        label: "memory",
        onError: ({ error, label }) => recordMemoryError(error, label)
      })
    : null;

  async function flushMemoryQueue() {
    if (memoryQueue) await memoryQueue.flush();
  }

  return {
    id: sessionRecord.id,

    async run(input, runOptions) {
      const mergedRunOptions = mergeRunOptions(options.defaultRunOptions, runOptions);
      if (isApprovalResolutionRequest(input)) {
        return this.resumeApproval(input, runOptions);
      }

      const callerAbortSignal = readAbortSignal(mergedRunOptions);
      return executeSessionTurn(
        input,
        true,
        wrapHookForAbort(readOnStep$1(mergedRunOptions), callerAbortSignal),
        wrapHookForAbort(readOnToken$1(mergedRunOptions), callerAbortSignal),
        mergedRunOptions,
        callerAbortSignal
      );
    },

    // AGRUN-442 — streaming engine surface (dispatch-parity with runtime.runStream).
    // Iterate typed AgentLoopEvents at your own pace; break / generator.return()
    // aborts the turn. Delegates to this.run, so session setup (compaction, memory,
    // thread routing) and every run mechanism carry over unchanged.
    runStream(input, runOptions) {
      const self = this;
      return createRunEventStream(
        (hookedOptions) => self.run(input, hookedOptions),
        runOptions || {}
      );
    },

    async resumeApproval(input, runOptions) {
      const mergedRunOptions = mergeRunOptions(options.defaultRunOptions, runOptions);
      const callerAbortSignal = readAbortSignal(mergedRunOptions);
      return executeSessionTurn(
        input,
        false,
        wrapHookForAbort(readOnStep$1(mergedRunOptions), callerAbortSignal),
        wrapHookForAbort(readOnToken$1(mergedRunOptions), callerAbortSignal),
        mergedRunOptions,
        callerAbortSignal
      );
    },

    /* hooks plumbed via runOptions: onPlannerDecision, onToolResult, onBeforeFinalize */

    async getHistory() {
      return cloneValue(await options.sessionStore.readMessages(sessionRecord.id));
    },

    async getMemory() {
      await flushMemoryQueue();
      return cloneValue(await options.sessionStore.readMemory(sessionRecord.id));
    },

    // AGRUN-440/444 — await durability of any in-flight async memory extraction.
    // A no-op unless asyncMemoryExtraction is enabled. Hosts can call it at a
    // checkpoint; turn-start and getMemory already drain it automatically.
    async flushMemory() {
      await flushMemoryQueue();
    },

    // AGRUN-514 — host-visible async memory extraction state, parallel to the
    // message store's getState(). `enabled` reflects asyncMemoryExtraction;
    // `pendingWrites` is the in-flight queue depth; `lastExtraction` is the most
    // recent extraction outcome; `errors` lists captured storage/promotion
    // failures. Lets a host/inspector see async failures without timing tricks.
    getMemoryState() {
      return {
        enabled: Boolean(memoryQueue),
        pendingWrites: memoryQueue ? memoryQueue.size() : 0,
        lastExtraction: cloneValue(memoryDiagnostics.lastExtraction),
        errors: cloneValue(memoryDiagnostics.errors)
      };
    },

    getState() {
      return cloneValue(sessionRecord);
    }
  };

  async function executeSessionTurn(input, persistUserMessage, onStep, onToken, runOptions, callerAbortSignal) {
    if (isAbortSignalAborted(callerAbortSignal)) {
      throw createAbortError("Run aborted by caller before session turn started.");
    }

    // AGRUN-240 — Read parentSessionId from input object (first arg to session.run).
    const incomingParentSessionId = input && typeof input === "object" && !Array.isArray(input)
      && typeof input.parentSessionId === "string" && input.parentSessionId.trim()
      ? input.parentSessionId.trim()
      : null;

    const userMessage = persistUserMessage
      ? createPendingUserMessage(sessionRecord.id, input)
      : null;

    if (userMessage) {
      await options.sessionStore.appendMessage(userMessage);
    }

    // AGRUN-440/444 — drain any in-flight async memory extraction from a prior
    // turn BEFORE this turn reads memory, so the next turn always sees the last
    // turn's extracted memory (no-op when asyncMemoryExtraction is off).
    await flushMemoryQueue();

    // Route the turn to a thread BEFORE preparing session context so
    // compaction/recall see only memory entries scoped to the active thread
    // (unless threads.crossThreadRecall is on, in which case scope is null
    // and the full memory set flows through — preserving legacy behavior).
    const sessionMemoryEntries = await options.sessionStore.readMemory(sessionRecord.id);
    // Read cross-session global memory ONCE, before prompt prep, so both
    // consumers agree: prepareSessionInput merges it into the actual prompt
    // context (compaction.js), and the resolvedMemory facade built below
    // reuses the same fetched entries for the in-loop memory tools.
    const globalMemoryEnabled = ((options.runtimeConfig && options.runtimeConfig.globalMemory) || {}).enabled !== false;
    const globalMemoryEntries = globalMemoryEnabled ? await options.sessionStore.readAllGlobalMemory() : [];
    if (globalMemoryEnabled) {
      emitGlobalMemoryStep(onStep, {
        type: "global-memory-recalled",
        count: Array.isArray(globalMemoryEntries) ? globalMemoryEntries.length : 0
      });
    }
    const threadRouting = await routeTurnToThread({
      input,
      onStep,
      runtimeConfig: options.runtimeConfig,
      sessionMemoryEntries,
      userMessage
    });
    const threadScope = readThreadScope(options.runtimeConfig, threadRouting);

    const prepared = await prepareSessionInput(input, userMessage, threadScope, callerAbortSignal, globalMemoryEntries);

    const compactionSnapshot = prepared.compactionUsage
      ? createUsageSnapshot(prepared.compactionUsage)
      : null;
    if (compactionSnapshot) {
      sessionRecord.cumulativeUsage = accumulateUsage(sessionRecord.cumulativeUsage, compactionSnapshot);
      if (typeof onStep === "function") {
        onStep({
          type: "compaction-completed",
          inputTokens: compactionSnapshot.inputTokens,
          outputTokens: compactionSnapshot.outputTokens,
          totalTokens: compactionSnapshot.totalTokens,
          model: compactionSnapshot.model,
          provider: compactionSnapshot.provider
        });
      }
    }

    // AGRUN-461 — Surface a swallowed LLM compaction failure so it is never
    // silent. Symmetric with `compaction-completed` above; fires on either
    // the budget-OK or budget-exceeded prepared shape (and on the approval
    // door, which forwards `compactionError`). Without this the host only
    // sees an unexplained PROMPT_BUDGET_EXCEEDED.
    if (prepared.compactionError && typeof onStep === "function") {
      onStep({
        type: "compaction-failed",
        error: prepared.compactionError
      });
    }

    if (prepared.compactionTurn) {
      await persistCompactionTurn(prepared.compactionTurn, userMessage);
    }

    if (prepared.summaryUpdatedAt) {
      sessionRecord.compactedAt = prepared.summaryUpdatedAt;
    }

    if (prepared.error) {
      return handlePreparedSessionError(prepared, userMessage, onStep);
    }

    // AGRUN-145 Slice D — Merge the compaction window into the thread
    // hydration payload so runLoop's `hydrateRunStateWithThread` can trim
    // tool / research state that belongs to fully-compacted turns before
    // the first planner cycle. `compactionWindow` is null when no summary
    // was written this turn (legacy / cross-thread-recall / no-op).
    const threadHydrationPayload = threadRouting && threadRouting.hydration
      ? { ...threadRouting.hydration, compactionWindow: prepared.compactionWindow || null }
      : (prepared.compactionWindow
          ? { compactionWindow: prepared.compactionWindow }
          : null);

    const runtimeState = {
      lastRun: cloneValue(sessionRecord.lastRun)
    };
    const resolvedMemory = createMemoryStore(mergeGlobalIntoSessionMemory(sessionMemoryEntries, globalMemoryEntries));
    // AGRUN-206 — `nextRunId` is now async (CAS retry loop), so the
    // run id must be claimed before constructing the runLoop options.
    const claimedRunId = await nextRunId();
    const result = await runLoop({
      callerAbortSignal,
      disabledActions: readDisabledActions$1(runOptions),
      onStep,
      onToken,
      // AGRUN-419-followup — dispatch-parity (both doors): runtime.run forwards
      // onReasoning, so session.run must too or a session host's live-thinking
      // listener never fires. Same abort wrapping as onToken (sibling per-event
      // emission hook).
      onReasoning: wrapHookForAbort(readFunctionOption$1(runOptions, "onReasoning"), callerAbortSignal),
      onInvalidPlannerOutput: wrapHookForAbort(readFunctionOption$1(runOptions, "onInvalidPlannerOutput"), callerAbortSignal),
      onPlannerDecision: wrapHookForAbort(readFunctionOption$1(runOptions, "onPlannerDecision"), callerAbortSignal),
      onStreamEvent: wrapHookForAbort(readFunctionOption$1(runOptions, "onStreamEvent"), callerAbortSignal),
      // AGRUN-465 — dispatch-parity: runtime.run always forwarded
      // onStreamEvent; this door silently dropped it, so a session host's
      // stream listener never fired. Same abort wrapping as onToken (its
      // closest sibling — both are per-event emission hooks).
      onToolResult: wrapHookForAbort(readFunctionOption$1(runOptions, "onToolResult"), callerAbortSignal),
      onBeforeFinalize: wrapHookForAbort(readFunctionOption$1(runOptions, "onBeforeFinalize"), callerAbortSignal),
      // Crash-recovery (run-state-export-import-design.md P2). The session
      // path must thread these too — runtime.run() wires them in runtime.js,
      // but session.run() builds its own runLoop options object.
      onCheckpoint: readFunctionOption$1(runOptions, "onCheckpoint"),
      resumeState: readResumeState$1(runOptions),
      plannerDirectives: readPlannerDirectives$1(runOptions),
      plannerDirectivesMode: readPlannerDirectivesMode$1(runOptions),
      rawInput: prepared.input,
      resolvedMemory,
      runId: claimedRunId,
      runtimeConfig: options.runtimeConfig,
      runtimeEventBus: options.runtimeEventBus,
      runtimeState,
      // AGRUN-240-followup — pass session lineage into runLoop so runState
      // carries sessionId + parentSessionId from cycle 0. pushStep /
      // event-ledger then tag every emission with the owning + spawning
      // session, enabling orchestrator-worker task tree rendering without
      // relying on the post-run projection at handle.js:272.
      sessionId: sessionRecord.id,
      parentSessionId: incomingParentSessionId || sessionRecord.parentSessionId || null,
      skills: options.skills,
      threadHydration: threadHydrationPayload,
      turnIntent: threadRouting && threadRouting.turnIntent
        ? cloneValue(threadRouting.turnIntent)
        : null
    });

    // AGRUN-CALLER-ABORT — Even when the runtime catches the underlying
    // fetch's AbortError and packages it as a failed result, surface
    // caller cancellation as a thrown AbortError so the integration
    // contract is symmetric (caller asked to abort → caller gets
    // AbortError, not a "succeeded with failure" result).
    if (isAbortSignalAborted(callerAbortSignal)) {
      throw createAbortError("Run aborted by caller during session turn.");
    }

    // AGRUN-144 · Slice H — Expose thread routing on the returned runState so
    // downstream consumers (browser UI, debug tooling) can reflect the
    // router's decision in message metadata. The streamed `thread-routed`
    // step event stays (for live tracing), but the result-level snapshot
    // provides a stable, non-streaming contract: `runState.threadId` +
    // `runState.threadRouting = { action, activeThreadId, previousThreadId,
    // reasoning }`. Missing when threads config is disabled — UI omits the
    // divider gracefully.
    if (threadRouting && threadRouting.verdict && result.runState) {
      result.runState.threadId = threadRouting.activeThreadId;
      result.runState.threadRouting = {
        action: threadRouting.verdict.action,
        activeThreadId: threadRouting.activeThreadId,
        previousThreadId: threadRouting.previousThreadId || null,
        reasoning: threadRouting.verdict.reasoning || ""
      };
    }

    result.runState.sessionContextMeta = cloneValue(
      result.runState.sessionContextMeta || prepared.sessionContextMeta || null
    );
    result.runState.sessionContextView = cloneValue(
      result.runState.sessionContextView || prepared.sessionContextView || null
    );
    result.runState.contextSnapshot = cloneValue(
      result.runState.contextSnapshot || prepared.contextSnapshot || null
    );
    if (result.runState.contextSnapshot) {
      const projectedSessionContext = projectSessionContextFromSnapshot(result.runState.contextSnapshot);
      result.runState.sessionContextMeta = projectedSessionContext
        ? summarizeSessionContextMeta(projectedSessionContext)
        : null;
      result.runState.sessionContextView = projectedSessionContext
        ? createSessionContextViewFromSnapshot(result.runState.contextSnapshot)
        : null;
    }
    result.runState.sessionContextSource = prepared.sessionContextSource || result.runState.sessionContextSource || null;
    result.runState.approvalResumeFallbackUsed = prepared.approvalResumeFallbackUsed === true;
    // AGRUN-240 — Project parentSessionId onto runState snapshot.
    result.runState.parentSessionId = incomingParentSessionId || sessionRecord.parentSessionId || null;

    if (userMessage) {
      userMessage.runId = result.runState.runId;
      userMessage.status = readPersistedMessageStatus(result);
      // AGRUN-145 Slice A — Stamp thread provenance on the user message
      // now that both the router verdict and `runId` are final. This lets
      // Slice C group messages by `(threadId, turnId)` without relying on
      // order-based inference.
      userMessage.threadId = readActiveThreadId(result.runState);
      userMessage.turnId = readActiveTurnId(result.runState) || result.runState.runId || null;
      await options.sessionStore.updateMessage(userMessage);
      await recordStoredMessage("recordUserMessage", {
        message: userMessage,
        result,
        sessionId: sessionRecord.id
      });
    }

    if (Array.isArray(result.memoryEntriesAdded)) {
      // Model-initiated entries (remember action) are created inside the run
      // loop, before the router's threadId is stamped onto runState — so the
      // session layer (which owns threads) fills in missing provenance here.
      // Without a threadId the entry would fall into the legacy "default"
      // bucket and be invisible to every real thread's scoped recall.
      const activeThreadId = readActiveThreadId(result.runState);
      const activeTurnId = readActiveTurnId(result.runState) || (result.runState && result.runState.runId) || null;
      for (const entry of result.memoryEntriesAdded) {
        if (entry && entry.metadata && typeof entry.metadata === "object") {
          if (activeThreadId && !entry.metadata.threadId) entry.metadata.threadId = activeThreadId;
          if (activeTurnId && !entry.metadata.turnId) entry.metadata.turnId = activeTurnId;
        }
        await options.sessionStore.appendMemory(sessionRecord.id, entry);
      }
    }

    const assistantMessage = createAssistantMessage(sessionRecord.id, result);
    await options.sessionStore.appendMessage(assistantMessage);
    await recordStoredMessage("recordAssistantMessage", {
      message: assistantMessage,
      result,
      sessionId: sessionRecord.id
    });
    // AGRUN-440/444 — the turn's memory side-effects: extract (LLM) -> append to
    // the session store -> promote candidates to global memory. `mutateResult`
    // controls whether the current turn's result.memoryEntriesAdded / lastRun
    // count are updated; it is true on the sync (default) path and false on the
    // async path (where the result was already returned, so the extracted
    // entries surface only via the next memory read).
    const applyTurnMemorySideEffects = async (mutateResult) => {
      const structurallyEligible = globalMemoryEnabled
        && shouldExtractSessionMemory(userMessage, assistantMessage, result, prepared.input);

      // AGRUN-517 — let the host policy veto the extraction LLM call on an
      // eligible turn. No policy => extract (default). A skip is recorded as a
      // first-class outcome so getMemoryState() surfaces extracted/skipped/failed.
      let policyDecision = { extract: true };
      if (structurallyEligible && memoryExtractionPolicy) {
        policyDecision = await evaluateMemoryExtractionPolicy(memoryExtractionPolicy, {
          sessionId: sessionRecord.id,
          runId: result.runState && result.runState.runId,
          userText: readMessageText(userMessage),
          assistantText: readMessageText(assistantMessage)
        });
        if (policyDecision.error) recordMemoryError(policyDecision.error, "memory-policy");
      }

      const extraction = structurallyEligible && policyDecision.extract
        ? await extractMemoryEntries({
            assistantMessage,
            preparedInput: prepared.input,
            result,
            userMessage,
            mutateResult
          })
        : {
            entries: [],
            status: structurallyEligible && !policyDecision.extract
              ? { status: "skipped", reason: policyDecision.reason || "" }
              : null
          };

      // Record the extraction outcome before any storage write, so a later
      // append/promote failure (captured by the queue) does not hide whether the
      // extraction itself completed. Host reads it via session.getMemoryState().
      recordMemoryExtraction(extraction.status);

      const extractedEntries = extraction.entries;
      for (const entry of extractedEntries) {
        await options.sessionStore.appendMemory(sessionRecord.id, entry);
      }

      if (mutateResult && extractedEntries.length > 0) {
        result.memoryEntriesAdded = [
          ...(Array.isArray(result.memoryEntriesAdded) ? result.memoryEntriesAdded : []),
          ...extractedEntries.map(cloneValue)
        ];

        if (runtimeState.lastRun && typeof runtimeState.lastRun === "object") {
          runtimeState.lastRun.memoryEntriesAdded = result.memoryEntriesAdded.length;
        }
      }

      const allMemoryEntries = [
        ...(Array.isArray(result.memoryEntriesAdded) ? result.memoryEntriesAdded : []),
        ...extractedEntries
      ];
      const globalMemoryConfig = (options.runtimeConfig && options.runtimeConfig.globalMemory) || {};
      const sourceTurn = {
        user: readMessageText(userMessage),
        assistant: readMessageText(assistantMessage)
      };
      const globalMemoryOptions = {
        minConfidence: globalMemoryConfig.minConfidence,
        maxEntries: globalMemoryConfig.maxEntries,
        hookTimeoutMs: globalMemoryConfig.hookTimeoutMs,
        sensitivityFilter: globalMemoryConfig.sensitivityFilter || null,
        promotionValidator: globalMemoryConfig.promotionValidator || null,
        sessionId: sessionRecord.id,
        sourceTurn,
        onTelemetry: (event) => emitGlobalMemoryStep(onStep, event)
      };
      if (globalMemoryEnabled) {
        for (const entry of allMemoryEntries) {
          if (isGlobalMemoryCandidate(entry, globalMemoryOptions)) {
            await promoteToGlobalMemory(options.sessionStore, entry, globalMemoryOptions);
          }
        }
      }
    };

    if (memoryQueue) {
      // Off the critical path: enqueue and return immediately. The queue
      // preserves ordering + captures errors; the next memory read drains it.
      memoryQueue.enqueue(() => applyTurnMemorySideEffects(false), "memory");
    } else {
      await applyTurnMemorySideEffects(true);
    }

    const usageSnapshot = createUsageSnapshot(result.output);

    if (usageSnapshot) {
      sessionRecord.lastTokenUsage = usageSnapshot;
      sessionRecord.cumulativeUsage = accumulateUsage(sessionRecord.cumulativeUsage, usageSnapshot);
    }

    if (compactionSnapshot && result.runState && result.runState.costLedger) {
      recordCostEntry(result.runState.costLedger, {
        phase: "planner",
        callKind: "compaction",
        provider: compactionSnapshot.provider,
        model: compactionSnapshot.model,
        inputTokens: compactionSnapshot.inputTokens,
        outputTokens: compactionSnapshot.outputTokens,
        totalTokens: compactionSnapshot.totalTokens,
        latencyMs: prepared.compactionUsage && prepared.compactionUsage.latencyMs
      });
    }

    sessionRecord.lastRun = cloneValue(runtimeState.lastRun);
    // AGRUN-240 — Persist parentSessionId latch: set once on first non-null, callers may
    // override by passing a new value on any subsequent run() call.
    if (incomingParentSessionId) {
      sessionRecord.parentSessionId = incomingParentSessionId;
    }
    sessionRecord.contextSnapshot = cloneValue(
      result.runState && result.runState.contextSnapshot
        ? result.runState.contextSnapshot
        : sessionRecord.contextSnapshot || null
    );
    if (threadRouting) {
      sessionRecord.threads = cloneValue(threadRouting.threads);
      sessionRecord.activeThreadId = threadRouting.activeThreadId;
    }
    // AGRUN-212a Phase C — write the per-turn TodoState snapshot back
    // onto the active thread record. Actions mutate
    // `runState.todoState`; this is the only place that promotion to
    // sessionRecord happens, so saveSession's CAS owns durability.
    // No-op when TodoState is unchanged (still null) or threads are
    // disabled.
    if (
      result && result.runState && typeof result.runState.threadId === "string"
      && Array.isArray(sessionRecord.threads)
    ) {
      const activeThread = sessionRecord.threads.find((t) => t && t.id === result.runState.threadId);
      if (activeThread) {
        const todoProjection = projectTodoRunState(result.runState);
        const researchProjection = projectResearchRunState(result.runState);
        activeThread.todoState = todoProjection.todoState || null;
        activeThread.researchContext = cloneThreadResearchContext(researchProjection.researchContext);
        // qualityContext wiring — persist the finalize quality issue codes so
        // the next turn's planner can surface them via loopState.qualityContext
        // (the cross-turn self-correction signal). Mirrors researchContext carry.
        activeThread.finalResponseQuality = result.runState.finalResponseQuality
          ? cloneValue(result.runState.finalResponseQuality)
          : null;
        // AGRUN-214m — persist the durable research slice (topic,
        // evidenceGraph, reportLoop status, finalEnvelope) so the next
        // turn can finalize from existing evidence instead of treating
        // a recovery prompt as a brand-new topic.
        const nextSlice = serializeResearchSlice(result.runState, {
          turnId: typeof result.runState.runId === "string" ? result.runState.runId : null,
          now: Date.now()
        });
        if (nextSlice) {
          activeThread.research = normalizeResearchSlice(nextSlice);
        }
      }
    }
    sessionRecord.updatedAt = Date.now();
    await options.sessionStore.saveSession(sessionRecord);
    return result;
  }

  async function routeTurnToThread(context) {
    const threadsConfig = (context.runtimeConfig && context.runtimeConfig.threads) || null;
    if (!threadsConfig || threadsConfig.enabled !== true) {
      return null;
    }
    const userText = extractUserMessageText(context.input);
    if (!userText) return null;

    const { threads, activeThreadId } = readThreadsState(sessionRecord);
    // Structural-signal intent extraction sits in the extractor layer so
    // the router stays a pure decision layer. Produces {pivotIntent?,
    // divergentIntent?} from Jaccard + token-count magnitude — no lexicon.
    const structuralIntent = extractTurnIntent({
      userMessage: userText,
      threads,
      activeThreadId
    });

    // Escalation to LLM-backed planner when:
    //  (a) A classifier callback was configured (runtime opts in), AND
    //  (b) At least one thread exists so there is something to route against, AND
    //  (c) EITHER the structural extractor found no signal, OR it claims
    //      divergentIntent. AGRUN-618 — a structural divergent is a pure
    //      zero-Jaccard-overlap guess, and acting on it unconfirmed splits
    //      the session into a brand-new EMPTY thread (destructive: recall/
    //      meta questions like "summarize this session" or "what was the
    //      image I uploaded" land with no context at all). Only the AI can
    //      distinguish a genuinely new topic from a recall/referential turn
    //      that happens to share no tokens, so a divergent claim must be
    //      confirmed by the planner whenever one is available. Structural
    //      signals remain the complete fallback when no classifier is
    //      configured, and a planner failure ({}) leaves the structural
    //      verdict standing — graceful degrade, never a blocked turn.
    //      Structural pivotIntent stays unescalated: it requires positive
    //      dominant overlap with an existing thread and lands on related
    //      context, so a misfire is non-destructive.
    let turnIntent = structuralIntent;
    const classify = typeof threadsConfig.intentClassifier === "function"
      ? threadsConfig.intentClassifier
      : null;
    const needsPlanner = classify
      && threads.length >= 1
      && (Object.keys(structuralIntent).length === 0 || structuralIntent.divergentIntent === true);
    if (needsPlanner) {
      const planned = await planTurnIntent({
        userMessage: userText,
        threads,
        activeThreadId,
        classify
      });
      turnIntent = mergeTurnIntent(structuralIntent, planned);
    }

    const verdict = routeTopic({
      userMessage: userText,
      threads,
      activeThreadId,
      turnIntent
    });

    const now = Date.now();
    const applied = applyRouterVerdict({
      sessionRecord: { threads, activeThreadId },
      verdict,
      userText,
      // AGRUN-142 — turnId is unknown at route time (nextRunId() runs after
      // routing). Seed goalAnchor.text now; turnId stays null until a
      // future enhancement hoists runId generation above the router call.
      turnId: null,
      now,
      maxThreads: threadsConfig.maxThreads
    });

    emitThreadStep(context.onStep, {
      type: "thread-routed",
      action: verdict.action,
      threadId: applied.activeThreadId,
      previousThreadId: activeThreadId,
      reasoning: verdict.reasoning
    });

    const scopedEvidenceUrls = buildThreadScopedEvidenceUrls(
      context.sessionMemoryEntries,
      applied.activeThreadId
    );

    // AGRUN-142 — surface the active thread's goalAnchor.text through
    // hydration so runLoop can seed runState.threadGoalAnchorText for the
    // planner prompt. Empty string when the anchor was never populated
    // (legacy thread / image-only turn).
    const activeThreadGoalAnchorText = applied.activeThread
      && applied.activeThread.goalAnchor
      && typeof applied.activeThread.goalAnchor.text === "string"
      ? applied.activeThread.goalAnchor.text
      : "";

    // AGRUN-212a Phase C — surface the active thread's TodoState
    // through hydration so todo_* actions can read/mutate a per-turn
    // snapshot on `runState.todoState`. cloneValue keeps the
    // sessionRecord copy isolated from any in-flight mutations.
    const activeThreadTodoState = applied.activeThread && applied.activeThread.todoState
      ? cloneValue(applied.activeThread.todoState)
      : null;
    const activeThreadResearchContext = applied.activeThread && applied.activeThread.researchContext
      ? cloneValue(applied.activeThread.researchContext)
      : null;
    const activeThreadFinalResponseQuality = applied.activeThread && applied.activeThread.finalResponseQuality
      ? cloneValue(applied.activeThread.finalResponseQuality)
      : null;
    // AGRUN-214m — surface the durable research slice so a follow-up
    // finalize-only turn inherits the original topic + evidenceGraph
    // instead of seeing a fresh runState and re-extracting topic from
    // the recovery prompt.
    const activeThreadResearchSlice = applied.activeThread && applied.activeThread.research
      ? cloneValue(applied.activeThread.research)
      : null;

    return {
      activeThreadId: applied.activeThreadId,
      hydration: {
        threadId: applied.activeThreadId,
        scopedEvidenceUrls,
        goalAnchorText: activeThreadGoalAnchorText,
        research: activeThreadResearchSlice,
        researchContext: activeThreadResearchContext,
        finalResponseQuality: activeThreadFinalResponseQuality,
        todoState: activeThreadTodoState
      },
      previousThreadId: activeThreadId,
      threads: applied.threads,
      turnIntent,
      verdict
    };
  }

  async function prepareSessionInput(input, userMessage, threadScope, callerAbortSignal, globalMemoryEntries) {
    const preparedInput = cloneValue(input);

    if (isToolLoopProviderRequest(input)) {
      const preparedProviderInput = await prepareProviderSessionContext({
        callerAbortSignal: callerAbortSignal || null,
        compactionPolicy: options.runtimeConfig && options.runtimeConfig.compactionPolicy,
        excludeMessageId: userMessage ? userMessage.id : null,
        globalMemoryEntries: globalMemoryEntries || [],
        input: {
          ...preparedInput,
          agrunSessionId: sessionRecord.id
        },
        sessionRecord,
        sessionId: sessionRecord.id,
        sessionPolicy: options.sessionPolicy,
        sessionStore: options.sessionStore,
        threadScope: threadScope || null
      });

      return {
        ...preparedProviderInput,
        approvalResumeFallbackUsed: false,
        input: preparedProviderInput.input
          ? {
              ...preparedProviderInput.input,
              agrunSessionId: sessionRecord.id
            }
          : preparedInput,
        sessionContextSource: "session_store"
      };
    }

    if (isApprovalResolutionRequest(input)) {
      return prepareSessionApprovalResumeInput({
        input: preparedInput,
        sessionId: sessionRecord.id,
        sessionRecord,
        sessionPolicy: options.sessionPolicy,
        sessionStore: options.sessionStore,
        approvalSigner: options.runtimeConfig && options.runtimeConfig.approvalSigner,
        enforceSessionBinding: !!(options.runtimeConfig && options.runtimeConfig.approvalSigning && options.runtimeConfig.approvalSigning.enforceSessionBinding),
        globalMemoryEntries: globalMemoryEntries || [],
        threadScope: threadScope || null
      });
    }

    return {
      approvalResumeFallbackUsed: false,
      input: preparedInput,
      contextSnapshot: null,
      sessionContextMeta: null,
      sessionContextSource: null,
      sessionContextView: null,
      summaryUpdatedAt: null
    };
  }

  async function handlePreparedSessionError(prepared, userMessage, onStep) {
    const claimedRunId = await nextRunId();
    const failedSessionTurn = createSessionFailureResult({
      error: prepared.error,
      onStep,
      rawInput: prepared.input,
      runId: claimedRunId,
      runtimeConfig: options.runtimeConfig,
      runtimeEventBus: options.runtimeEventBus,
      sessionContextMeta: prepared.sessionContextMeta || null,
      sessionContextView: prepared.sessionContextView || null,
      contextSnapshot: prepared.contextSnapshot || null,
      runtimeState: {
        lastRun: cloneValue(sessionRecord.lastRun)
      }
    });

    failedSessionTurn.result.runState.contextSnapshot = cloneValue(prepared.contextSnapshot || null);
    failedSessionTurn.result.runState.sessionContextSource = prepared.sessionContextSource || null;
    failedSessionTurn.result.runState.approvalResumeFallbackUsed = prepared.approvalResumeFallbackUsed === true;

    if (userMessage) {
      userMessage.runId = failedSessionTurn.result.runState.runId;
      userMessage.status = "failed";
      await options.sessionStore.updateMessage(userMessage);
      await recordStoredMessage("recordUserMessage", {
        message: userMessage,
        result: failedSessionTurn.result,
        sessionId: sessionRecord.id
      });
    }

    const assistantMessage = createAssistantMessage(sessionRecord.id, failedSessionTurn.result);
    await options.sessionStore.appendMessage(assistantMessage);
    await recordStoredMessage("recordAssistantMessage", {
      message: assistantMessage,
      result: failedSessionTurn.result,
      sessionId: sessionRecord.id
    });
    sessionRecord.lastRun = cloneValue(failedSessionTurn.lastRun);
    sessionRecord.updatedAt = Date.now();
    await options.sessionStore.saveSession(sessionRecord);
    return failedSessionTurn.result;
  }

  async function recordStoredMessage(method, context) {
    const messageStore = options.sessionMessageStore;
    if (!messageStore || typeof messageStore[method] !== "function") return null;
    return messageStore[method](context);
  }

  async function persistCompactionTurn(compactionTurn, currentUserMessage) {
    const turn = compactionTurn && typeof compactionTurn === "object" ? compactionTurn : null;
    if (!turn || !turn.summaryText) return null;

    const createdAt = currentUserMessage && typeof currentUserMessage.createdAt === "number"
      ? currentUserMessage.createdAt - 2
      : Date.now();
    const messages = createCompactionTurnMessages(sessionRecord.id, {
      ...turn,
      createdAt
    });
    const startedEvent = appendRuntimeEvent("compaction.started", {
      inputTokens: readFiniteNumber(turn.inputTokensEstimate),
      ratio: readFiniteNumber(turn.ratio),
      reason: turn.reason || "budget",
      sessionID: sessionRecord.id,
      sourceMessageIDs: cloneValue(turn.sourceMessageIds || []),
      uptoMessageID: turn.uptoMessageId || null
    }, turn);

    await options.sessionStore.appendMessage(messages.userMessage);
    await options.sessionStore.appendMessage(messages.assistantMessage);

    const completedTurn = {
      ...turn,
      assistantMessageId: messages.assistantMessage.id,
      turnId: messages.assistantMessage.turnId,
      userMessageId: messages.userMessage.id
    };
    const completedEvent = appendRuntimeEvent("compaction.completed", {
      compactedMessageIDs: cloneValue(turn.compactedMessageIds || turn.sourceMessageIds || []),
      compactedPartIDs: [],
      durationMs: readFiniteNumber(turn.durationMs),
      oldestPreservedTurnID: turn.oldestPreservedTurnId || null,
      savedTokensEstimate: readFiniteNumber(turn.savedTokensEstimate),
      sessionID: sessionRecord.id,
      sourceMessageIDs: cloneValue(turn.sourceMessageIds || []),
      summaryMessageID: messages.assistantMessage.id,
      uptoMessageID: turn.uptoMessageId || null
    }, completedTurn);

    await recordStoredMessage("recordCompactionTurn", {
      assistantMessage: messages.assistantMessage,
      compactionTurn: {
        ...completedTurn,
        events: [startedEvent, completedEvent].filter(Boolean)
      },
      sessionId: sessionRecord.id,
      userMessage: messages.userMessage
    });

    return {
      assistantMessage: messages.assistantMessage,
      completedEvent,
      startedEvent,
      userMessage: messages.userMessage
    };
  }

  function appendRuntimeEvent(type, detail, compactionTurn) {
    const bus = options.runtimeEventBus;
    if (!bus || typeof bus.appendEvent !== "function") return null;
    try {
      return bus.appendEvent({
        detail,
        mode: "step",
        parentSessionId: sessionRecord.parentSessionId || null,
        runId: compactionTurn && compactionTurn.runId,
        sessionId: sessionRecord.id,
        type
      });
    } catch (_error) {
      return null;
    }
  }
}

function readOnStep$1(options) {
  return options && typeof options === "object" && typeof options.onStep === "function"
    ? options.onStep
    : null;
}

function readResumeState$1(options) {
  return options && typeof options === "object"
    && options.resumeState && typeof options.resumeState === "object"
    && !Array.isArray(options.resumeState)
    ? options.resumeState
    : null;
}

function readOnToken$1(options) {
  return options && typeof options === "object" && typeof options.onToken === "function"
    ? options.onToken
    : null;
}

function readDisabledActions$1(options) {
  return options && typeof options === "object" && Array.isArray(options.disabledActions)
    ? options.disabledActions.slice()
    : [];
}

function readPlannerDirectives$1(options) {
  return options && typeof options === "object" && Array.isArray(options.plannerDirectives)
    ? options.plannerDirectives.slice()
    : [];
}

function readPlannerDirectivesMode$1(options) {
  return options && typeof options === "object" && options.plannerDirectivesMode === "replace"
    ? "replace"
    : "append";
}

function readMessageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  if (message.content && typeof message.content === "object") {
    if (typeof message.content.text === "string") return message.content.text;
  }
  return "";
}

function cloneThreadResearchContext(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    aggregatedSearchResults: Array.isArray(source.aggregatedSearchResults) ? cloneValue(source.aggregatedSearchResults) : [],
    lastQuery: typeof source.lastQuery === "string" && source.lastQuery.trim() ? source.lastQuery.trim() : null,
    readSources: Array.isArray(source.readSources) ? cloneValue(source.readSources) : [],
    searchPasses: Array.isArray(source.searchPasses) ? cloneValue(source.searchPasses) : [],
    searchResults: Array.isArray(source.searchResults) ? cloneValue(source.searchResults) : []
  };
}

/**
 * Derive the thread scope we pass into compaction / recall based on the
 * active runtimeConfig and the routing verdict just produced. Returns null
 * when the threads flag is off OR when `threads.crossThreadRecall === true`
 * — both cases mean memory should not be filtered by thread. Otherwise
 * returns `{ threadId, crossThread: false }` so downstream
 * `filterMemoryEntriesByThread` trims memory before it reaches the planner's
 * semantic-recall request.
 */
function readThreadScope(runtimeConfig, threadRouting) {
  const threadsConfig = (runtimeConfig && runtimeConfig.threads) || null;
  if (!threadsConfig || threadsConfig.enabled !== true) return null;
  if (threadsConfig.crossThreadRecall === true) return null;
  if (!threadRouting || !threadRouting.activeThreadId) return null;
  // AGRUN-593 — a cross_thread_recall verdict gives THIS turn the whole-
  // session view (null scope = pre-AGRUN-145 behavior the compaction layer
  // already supports): the turn references facts that live outside the
  // active thread, so thread-scoped history cannot answer it. Thread state
  // itself stays on the active thread (applyRouterVerdict).
  if (threadRouting.verdict && threadRouting.verdict.action === "cross_thread_recall") return null;
  return { threadId: threadRouting.activeThreadId, crossThread: false };
}

function emitThreadStep(onStep, event) {
  if (typeof onStep !== "function" || !event || typeof event !== "object") return;
  try {
    onStep({
      type: event.type,
      detail: { ...event, type: undefined },
      timestamp: new Date().toISOString()
    });
  } catch { /* consumer error */ }
}

function emitGlobalMemoryStep(onStep, event) {
  if (typeof onStep !== "function" || !event || typeof event !== "object") return;
  try {
    onStep({
      type: event.type,
      detail: { ...event, type: undefined },
      timestamp: new Date().toISOString()
    });
  } catch { /* consumer error */ }
}

function readFunctionOption$1(options, key) {
  return options && typeof options === "object" && typeof options[key] === "function"
    ? options[key]
    : null;
}

export { createSessionHandle };
