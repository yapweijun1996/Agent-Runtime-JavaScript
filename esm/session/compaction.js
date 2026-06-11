import { requestProviderCompletion } from '../runtime/provider.js';
import { normalizeThrownError, createStructuredError, ERROR_CODES } from '../runtime/errors.js';
import { applyCompactionPolicyToHistory, mergeCompactionWindows } from './compaction-policy.js';
import { buildContextWindowPlan } from './context-window-plan.js';
import { readContextSnapshot, normalizeInquiryContext, createContextSnapshot } from './context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot, createSessionContextViewFromSnapshot } from './context-snapshot-projection.js';
import { estimateStructuredSummaryTokens, formatStructuredSummary } from './context-window-summary.js';
import { filterMessagesByThread, sliceAfterSummary, selectCompactionMessages, summarizeSessionContextMeta, buildCompactionPrompt } from './prompt.js';
import { buildProviderConversation } from './provider-conversation.js';
import { isCompactionMessage } from './messages.js';
import { buildSessionMemorySnapshot } from './session-memory.js';
import { DEFAULT_THREAD_ID } from './thread.js';
import { evaluateProviderPromptBudget } from './token-budget.js';

const COMPACTION_SYSTEM_PROMPT = [
  "You compress agrun.js session history.",
  "Produce a compact plain-text summary for future turns.",
  "Preserve goals, constraints, facts, decisions, and open questions.",
  "Do not invent details."
].join("\n");

async function prepareProviderSessionContext(options) {
  const {
    input,
    sessionPolicy,
    sessionRecord,
    sessionStore,
    sessionId
  } = options;
  const threadScope = options && options.threadScope ? options.threadScope : null;
  // AGRUN-145 Slice B — Per-thread summary keying.
  // When threads are enabled and the planner scoped this turn to a thread,
  // read/write the summary slot for that thread; otherwise fall back to
  // DEFAULT_THREAD_ID so sessions without threads keep their single slot.
  const compactionThreadId = (threadScope && typeof threadScope.threadId === "string" && threadScope.threadId)
    ? threadScope.threadId
    : DEFAULT_THREAD_ID;
  const summary = await sessionStore.getSummary(sessionId, compactionThreadId);
  const messages = await sessionStore.readMessages(sessionId);
  const memoryEntries = await sessionStore.readMemory(sessionId);
  const completedMessages = messages.filter((message) => (
    message &&
    !isCompactionMessage(message) &&
    message.id !== options.excludeMessageId &&
    message.status === "completed"
  ));
  // AGRUN-145 Slice C — Scope compaction to the active thread when the
  // router gave us a concrete threadId. For legacy / cross-thread-recall
  // sessions (threadScope null) we keep the pre-145 whole-session view so
  // compaction + recent-turns behave exactly as before. Legacy messages
  // that lack `threadId` are bucketed under DEFAULT_THREAD_ID via
  // `filterMessagesByThread`, matching the summary store's key collapse.
  const scopeThreadId = (threadScope && typeof threadScope.threadId === "string" && threadScope.threadId)
    ? threadScope.threadId
    : "";
  const threadScopedMessages = scopeThreadId
    ? filterMessagesByThread(completedMessages, scopeThreadId)
    : completedMessages;
  const policyCompaction = await applyCompactionPolicyToHistory(threadScopedMessages, {
    compactionPolicy: options.compactionPolicy,
    sessionId,
    threadId: scopeThreadId || compactionThreadId
  });
  const policyScopedMessages = policyCompaction.history;
  const baseContextSnapshot = readContextSnapshot(input)
    || readContextSnapshot(sessionRecord && sessionRecord.contextSnapshot);
  let summaryRecord = summary;
  let sessionMemory = buildMemoryVariant({
    contextSnapshot: baseContextSnapshot,
    memoryEntries,
    messages: policyScopedMessages,
    policy: sessionPolicy,
    summary: summaryRecord,
    threadScope
  });
  let planMessages = sliceAfterSummary(policyScopedMessages, summaryRecord);
  let contextSnapshot = createPreparedSnapshot(input, sessionRecord, sessionMemory);
  let evaluatedBudget = evaluateContextBudget(input, projectSessionContextFromSnapshot(contextSnapshot), sessionPolicy);
  let plan = buildPlan({
    completedMessages: planMessages,
    contextSnapshot,
    input,
    initialBudget: evaluatedBudget,
    policy: sessionPolicy
  });
  let sessionContextMeta = createSessionContextMeta(contextSnapshot, plan, policyCompaction.detail);
  let summaryUpdatedAt = null;
  let compactionUsage = null;
  let compactionTurn = null;
  let compactionError = null;

  if (evaluatedBudget.needsCompaction) {
    const preCompactionBudget = plan.budget;
    const compactionMessages = selectCompactionMessages(
      policyScopedMessages,
      summaryRecord,
      sessionPolicy.recentMessages
    );

    if (compactionMessages.length > 0) {
      try {
        // Remember the summary we started with so we can detect concurrent
        // writes from overlapping session turns before overwriting.
        const startUpdatedAt = summaryRecord && summaryRecord.updatedAt
          ? summaryRecord.updatedAt
          : null;

        const compactionResult = await summarizeSessionContext({
          input,
          callerAbortSignal: options.callerAbortSignal || null,
          contextSnapshot,
          messages: compactionMessages,
          // AGRUN-145 Slice C — Tell the LLM which thread these messages
          // belong to so the structured headings summarize one topic, not
          // a cross-thread digest. Falsy when threads disabled — prompt
          // stays byte-identical to pre-145.
          threadId: scopeThreadId,
          previousSummary: summaryRecord && summaryRecord.text ? summaryRecord.text : ""
        });
        const nextSummaryText = compactionResult.text;
        compactionUsage = {
          usage: compactionResult.usage,
          model: compactionResult.model,
          provider: compactionResult.provider,
          latencyMs: compactionResult.latencyMs
        };

        // AGRUN-145 Slice D — Pre-compute the compaction window floor so
        // the summary record carries `oldestPreservedTurnId` (turnId of
        // the first message that survives into the preserved window).
        // Downstream runState hydration uses this to drop any tool /
        // research evidence from fully-compacted turns, preventing
        // finalizers from citing sources that no longer exist in the
        // prompt. Falls back to `null` when the preserved window is empty
        // (everything was compacted) or the first preserved message has
        // no `turnId` (legacy pre-Slice-A rows).
        const postCompactionWindow = sliceAfterSummary(policyScopedMessages, {
          uptoMessageId: compactionMessages[compactionMessages.length - 1].id
        });
        const oldestPreservedTurnId = postCompactionWindow.length > 0
          && typeof postCompactionWindow[0].turnId === "string"
          && postCompactionWindow[0].turnId
          ? postCompactionWindow[0].turnId
          : null;

        const writeResult = await resolveSummaryWrite({
          sessionStore,
          sessionId,
          threadId: compactionThreadId,
          startUpdatedAt,
          buildProposed: () => ({
            format: sessionPolicy.compaction.summaryFormat,
            meta: {
              estimatedTokens: estimateStructuredSummaryTokens(nextSummaryText, sessionPolicy.charsPerToken),
              sourceMessageCount: compactionMessages.length
            },
            sessionId,
            threadId: compactionThreadId,
            text: nextSummaryText,
            uptoMessageId: compactionMessages[compactionMessages.length - 1].id,
            oldestPreservedTurnId,
            updatedAt: Date.now()
          })
        });
        summaryRecord = writeResult.record;
        summaryUpdatedAt = summaryRecord.updatedAt;
        sessionMemory = buildMemoryVariant({
          contextSnapshot: baseContextSnapshot,
          memoryEntries,
          messages: policyScopedMessages,
          policy: sessionPolicy,
          summary: summaryRecord,
          threadScope
        });
        planMessages = sliceAfterSummary(policyScopedMessages, summaryRecord);
        contextSnapshot = createPreparedSnapshot(input, sessionRecord, sessionMemory);
        evaluatedBudget = evaluateContextBudget(input, projectSessionContextFromSnapshot(contextSnapshot), sessionPolicy);
        plan = buildPlan({
          completedMessages: planMessages,
          contextSnapshot,
          input,
          initialBudget: evaluatedBudget,
          policy: sessionPolicy,
          stage: writeResult.adopted ? "summary_adopted_concurrent" : "summary_refreshed"
        });
        sessionContextMeta = createSessionContextMeta(contextSnapshot, plan, policyCompaction.detail);
        if (!writeResult.adopted) {
          compactionTurn = {
            completedAt: summaryRecord.updatedAt,
            compactedMessageIds: compactionMessages.map((message) => message.id).filter(Boolean),
            durationMs: compactionResult.latencyMs,
            inputTokensEstimate: preCompactionBudget.estimatedPromptTokensBefore,
            oldestPreservedTurnId,
            outputTokensEstimate: estimateStructuredSummaryTokens(nextSummaryText, sessionPolicy.charsPerToken),
            ratio: computeBudgetRatio(preCompactionBudget),
            reason: "budget",
            runId: createCompactionRunId(),
            savedTokensEstimate: estimateSavedTokens(preCompactionBudget, evaluatedBudget),
            sourceMessageIds: compactionMessages.map((message) => message.id).filter(Boolean),
            summaryId: summaryRecord.id || null,
            summaryText: nextSummaryText,
            threadId: compactionThreadId,
            turnId: null,
            uptoMessageId: summaryRecord.uptoMessageId || compactionMessages[compactionMessages.length - 1].id
          };
          compactionTurn.turnId = compactionTurn.runId;
        }
      } catch (error) {
        // AGRUN-461 — Do NOT silently swallow a compaction failure. A caller
        // abort must propagate as cancellation (parity with the C3 plan
        // boundary), not be masked as a budget failure. Every other error is
        // captured so the caller (handle.js) can emit a `compaction-failed`
        // step — symmetric with `compaction-completed` — instead of leaving
        // the turn to degrade into an unexplained PROMPT_BUDGET_EXCEEDED.
        // Execution still continues into deterministic degradation below.
        if (error && error.name === "AbortError") {
          throw error;
        }
        compactionError = normalizeThrownError(error).message;
      }
    }
  }

  // AGRUN-145 Slice D — Surface the compaction window on the prepared
  // result. `oldestPreservedTurnId` is the turnId of the first message
  // that survives into the planner window, read directly from the
  // (possibly newly-written) summary record so both the compact-this-turn
  // and adopt-concurrent-summary paths agree on the floor. handle.js
  // merges this into threadHydration so runLoop trims tool / research
  // evidence that belongs to already-compacted turns.
  const summaryCompactionWindow = summaryRecord
    && typeof summaryRecord.oldestPreservedTurnId === "string"
    && summaryRecord.oldestPreservedTurnId
    ? { oldestPreservedTurnId: summaryRecord.oldestPreservedTurnId }
    : null;
  const compactionWindow = mergeCompactionWindows(summaryCompactionWindow, policyCompaction.window);

  if (plan.budget.estimatedPromptTokensAfter <= plan.budget.inputBudgetTokens) {
    const prepared = createPreparedContextResult(
      input,
      // AGRUN-145 Slice C + AGRUN-290 — Feed the provider-conversation
      // builder the thread-scoped and host-policy-scoped window. The final
      // model prompt then carries only the active topic plus any host
      // compaction trimming.
      policyScopedMessages,
      sessionPolicy,
      contextSnapshot,
      plan,
      sessionContextMeta,
      summaryUpdatedAt,
      compactionWindow,
      compactionUsage,
      compactionTurn
    );
    // AGRUN-461 — Surface a compaction failure even when deterministic
    // trimming kept the prompt within budget, so the host still learns the
    // LLM summary never refreshed.
    if (compactionError) {
      prepared.compactionError = compactionError;
    }
    return prepared;
  }

  return {
    compactionUsage,
    compactionTurn,
    // AGRUN-461 — Root cause for handle.js to surface alongside the budget
    // error; null when compaction either succeeded or was never attempted.
    compactionError: compactionError || null,
    compactionWindow,
    contextSnapshot,
    error: createPromptBudgetError(input, plan.budget, sessionContextMeta && sessionContextMeta.contextWindow),
    input: buildPreparedProviderInput(input, policyScopedMessages, sessionPolicy, contextSnapshot, plan),
    sessionContextMeta,
    sessionContextView: createSessionContextView(contextSnapshot),
    summaryUpdatedAt
  };
}

function createSessionContextView(value) {
  const snapshot = readContextSnapshot(value);

  if (snapshot) {
    return createSessionContextViewFromSnapshot(snapshot);
  }

  const context = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

  if (!context) {
    return null;
  }

  return {
    clarificationStatus: readString$6(context.clarificationStatus),
    currentGoal: readString$6(context.currentGoal),
    currentTopic: readString$6(context.currentTopic),
    lastResolution: cloneNullable(context.lastResolution),
    openAmbiguity: readString$6(context.openAmbiguity),
    pendingClarification: cloneNullable(context.pendingClarification)
  };
}

// Compare-and-swap summary write: if another concurrent turn already wrote
// a newer summary while we were awaiting the LLM, adopt theirs instead of
// overwriting. Without this, two overlapping turns on the same session can
// race such that an older summary (covering fewer messages) clobbers a
// newer one, making session context appear to regress in time.
//
// Returns { record, adopted } where `adopted` is true when we used the
// concurrent turn's summary instead of writing our own.
async function resolveSummaryWrite(options) {
  const { sessionStore, sessionId, startUpdatedAt, buildProposed } = options;
  // AGRUN-145 Slice B — CAS now scoped per thread. Callers pass threadId so
  // overlapping turns on two different threads never clobber each other:
  // each thread has its own summary slot, and the CAS check reads only
  // that slot.
  const threadId = typeof options.threadId === "string" && options.threadId
    ? options.threadId
    : DEFAULT_THREAD_ID;
  const latest = await sessionStore.getSummary(sessionId, threadId);
  const storeAdvanced = latest
    && typeof latest.updatedAt === "number"
    && latest.updatedAt !== startUpdatedAt;

  if (storeAdvanced) {
    return { record: latest, adopted: true };
  }

  const proposed = buildProposed();
  // AGRUN-473 (audit M7) — The CAS version key is `updatedAt` (ms precision):
  // a slot's `id` is the fixed `sessionId::threadId` composite, so the only
  // per-write discriminator is the timestamp. Two DISTINCT summary versions
  // written within the same millisecond would share that key, so a concurrent
  // advance could go undetected (`latest.updatedAt !== startUpdatedAt` reads
  // equal) and this turn would clobber the newer summary — a lost update.
  // Guarantee STRICT monotonicity: each write's version is at least one tick
  // past the version this turn started from (which, in this non-advanced
  // branch, equals the stored version). Distinct versions can therefore never
  // collide, so the `!==` detection is exact regardless of clock resolution.
  const baseline = typeof startUpdatedAt === "number" ? startUpdatedAt : 0;
  const proposedAt = typeof proposed.updatedAt === "number" ? proposed.updatedAt : Date.now();
  proposed.updatedAt = Math.max(proposedAt, baseline + 1);
  await sessionStore.writeSummary(proposed);
  return { record: proposed, adopted: false };
}

async function summarizeSessionContext(options) {
  const startMs = Date.now();
  const response = await requestProviderCompletion(
    {
      ...options.input,
      contextSnapshot: null,
      conversation: [],
      multimodal: null,
      parts: [],
      sessionContext: null,
      // AGRUN-CALLER-ABORT — Compaction runs BEFORE the runLoop kicks
      // in, but a Stop click during a slow compaction summarize call
      // should still terminate the LLM fetch. Browser providers merge
      // this with their per-request timeout via AbortSignal.any.
      signal: options.callerAbortSignal || options.input.signal || null
    },
    {
      prompt: buildCompactionPrompt(options),
      systemPrompt: COMPACTION_SYSTEM_PROMPT
    }
  );

  return {
    text: formatStructuredSummary(response.text.trim(), options.contextSnapshot, options.messages),
    usage: response.usage || null,
    model: typeof response.model === "string" ? response.model : null,
    provider: typeof response.provider === "string" ? response.provider : null,
    latencyMs: Date.now() - startMs
  };
}

function createPreparedSnapshot(input, sessionRecord, sessionMemory) {
  const inputSnapshot = readContextSnapshot(input);
  const persistedSnapshot = readContextSnapshot(sessionRecord && sessionRecord.contextSnapshot);
  const legacyIntent = sessionMemory && sessionMemory.legacyIntent;
  const inquiryContext = normalizeInquiryContext(
    inputSnapshot && inputSnapshot.inquiryContext
      ? inputSnapshot.inquiryContext
      : persistedSnapshot && persistedSnapshot.inquiryContext
        ? persistedSnapshot.inquiryContext
        : null,
    legacyIntent
  );

  return createContextSnapshot({
    inquiryContext,
    sessionMemory,
    turnIntent: inputSnapshot && inputSnapshot.turnIntent ? inputSnapshot.turnIntent : null
  });
}

function buildMemoryVariant(options) {
  return buildSessionMemorySnapshot({
    contextSnapshot: options.contextSnapshot,
    includeOtherMemory: options.includeOtherMemory !== false,
    memoryEntries: options.memoryEntries,
    messages: sliceAfterSummary(options.messages, options.summary),
    policy: {
      ...options.policy,
      recentMessages: options.recentMessages == null
        ? options.policy.recentMessages
        : options.recentMessages
    },
    summary: options.summary,
    threadScope: options.threadScope || null
  });
}

function buildPreparedProviderInput(input, messages, sessionPolicy, contextSnapshot, plan) {
  const providerConversation = buildProviderConversation(messages, input, sessionPolicy);

  return {
    ...input,
    contextSnapshot,
    conversation: providerConversation.conversation,
    multimodal: providerConversation.summary,
    parts: providerConversation.currentParts,
    sessionContext: plan ? plan.sessionContext : projectSessionContextFromSnapshot(contextSnapshot)
  };
}

function createPreparedContextResult(
  input,
  messages,
  sessionPolicy,
  contextSnapshot,
  plan,
  sessionContextMeta,
  summaryUpdatedAt,
  compactionWindow,
  compactionUsage,
  compactionTurn
) {
  return {
    compactionTurn: compactionTurn || null,
    compactionUsage: compactionUsage || null,
    compactionWindow: compactionWindow || null,
    contextSnapshot,
    input: buildPreparedProviderInput(input, messages, sessionPolicy, contextSnapshot, plan),
    sessionContextMeta,
    sessionContextView: createSessionContextView(contextSnapshot),
    summaryUpdatedAt
  };
}

function evaluateContextBudget(input, sessionContext, sessionPolicy) {
  return evaluateProviderPromptBudget({
    ...input,
    sessionContext
  }, sessionPolicy);
}

function buildPlan(options) {
  return buildContextWindowPlan({
    contextSnapshot: options.contextSnapshot,
    evaluate(sessionContext) {
      return evaluateContextBudget(options.input, sessionContext, options.policy);
    },
    fitEvaluator(sessionContext) {
      const evaluated = evaluateContextBudget(options.input, sessionContext, options.policy);
      return evaluated.withinBudget;
    },
    initialBudget: options.initialBudget,
    inputBudgetTokens: options.initialBudget.inputBudgetTokens,
    messages: options.completedMessages,
    policy: options.policy,
    stage: options.stage || "initial"
  });
}

function createSessionContextMeta(contextSnapshot, plan, compactionPolicyDetail = null) {
  const meta = summarizeSessionContextMeta(projectSessionContextFromSnapshot(contextSnapshot));

  return {
    ...meta,
    contextWindow: {
      budget: {
        compactAtTokens: plan.budget.compactAtTokens,
        estimatedPromptTokensAfter: plan.budget.estimatedPromptTokensAfter,
        estimatedPromptTokensBefore: plan.budget.estimatedPromptTokensBefore,
        inputBudgetTokens: plan.budget.inputBudgetTokens
      },
      compacted: plan.compacted,
      degradedFields: plan.degradedFields.slice(),
      droppedSegments: plan.droppedSegments.slice(),
      segmentStats: plan.segments.map((segment) => ({
        dropped: segment.dropped,
        estimatedTokens: segment.estimatedTokens,
        key: segment.key,
        pinned: segment.pinned,
        targetTokens: segment.targetTokens,
        truncated: segment.truncated
      })),
      stage: plan.stage,
      strategy: plan.strategy
    },
    compactionPolicy: cloneNullable(compactionPolicyDetail)
  };
}

function createPromptBudgetError(input, budget, contextWindow) {
  return createStructuredError(
    ERROR_CODES.PROMPT_BUDGET_EXCEEDED,
    "Session prompt exceeded the available context window after compaction.",
    null,
    {
      debug: {
        compactAtTokens: budget.compactAtTokens,
        contextWindow: cloneNullable(contextWindow),
        contextWindowTokens: budget.contextWindowTokens,
        estimatedPromptTokens: budget.estimatedPromptTokensAfter,
        inputBudgetTokens: budget.inputBudgetTokens,
        prompt: typeof input.prompt === "string" ? input.prompt : null,
        provider: typeof input.provider === "string" ? input.provider : null
      }
    }
  );
}

function readString$6(value) {
  return typeof value === "string" ? value.trim() : "";
}

function computeBudgetRatio(budget) {
  const inputBudgetTokens = budget && typeof budget.inputBudgetTokens === "number"
    ? budget.inputBudgetTokens
    : 0;
  const estimatedPromptTokensBefore = budget && typeof budget.estimatedPromptTokensBefore === "number"
    ? budget.estimatedPromptTokensBefore
    : 0;
  if (!inputBudgetTokens || inputBudgetTokens <= 0) return null;
  return estimatedPromptTokensBefore / inputBudgetTokens;
}

function estimateSavedTokens(beforeBudget, afterBudget) {
  const before = beforeBudget && typeof beforeBudget.estimatedPromptTokensBefore === "number"
    ? beforeBudget.estimatedPromptTokensBefore
    : null;
  const after = afterBudget && typeof afterBudget.estimatedPromptTokensAfter === "number"
    ? afterBudget.estimatedPromptTokensAfter
    : null;
  if (before == null || after == null) return null;
  return Math.max(0, before - after);
}

function createCompactionRunId() {
  return `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneNullable(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

export { createSessionContextView, prepareProviderSessionContext, resolveSummaryWrite };
