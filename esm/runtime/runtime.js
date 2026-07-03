import { createReadOnlyMemory } from '../memory/store.js';
import { createSessionHandle } from '../session/handle.js';
import { createSessionRecord, createSessionId } from '../session/messages.js';
import { seedSessionHistory } from '../session/seed.js';
import { createSessionStore } from '../session/store.js';
import { normalizeRuntimeConfig } from './config.js';
import { createRuntimeConfigLifecycle } from './runtime-config-lifecycle.js';
import { createActionRegistry } from './action-registry.js';
import { readAbortSignal, wrapHookForAbort } from './abort-signal.js';
import { runLoop } from './run-loop.js';
import { createAgentSkillSummary } from './agent-skills.js';
import { createApprovalSigner } from './approval-signing.js';
import { mergeRunOptions } from './default-run-options.js';
import { createRuntimeEventBus } from './runtime-event-ledger.js';
import { createSessionMessageStore } from './session-message-store.js';
import { createRunEventStream } from './run-event-stream.js';
import { cloneValue } from './utils.js';

function createRuntime(options) {
  const configLifecycle = createRuntimeConfigLifecycle(options, normalizeRuntimeConfigWithRuntimeFields);
  const runtimeState = { lastRun: null };
  const runtimeEventBus = createRuntimeEventBus();
  const sessionMessageStore = createSessionMessageStore({
    // AGRUN-440 — opt-in fire-and-forget assistant transcript writes. Default
    // off (every write awaited). When on, the host should call
    // runtime.flushMessageStorage() at a checkpoint to guarantee durability.
    asyncWrites: Boolean(options && options.asyncMessageWrites),
    onError: options && typeof options.onStorageError === "function" ? options.onStorageError : null,
    runtimeEventBus,
    storage: options && options.storage
  });
  const resolvedSessionStore = createSessionStore(readResolvedConfig().sessionStore);
  let runSequence = 0;

  function nextRunId() {
    return `run-${++runSequence}`;
  }

  function runOnce(rawInput, runOptions) {
    const resolvedConfig = readResolvedConfig();
    const mergedRunOptions = mergeRunOptions(
      resolvedConfig.runtimeConfig.defaultRunOptions,
      runOptions
    );
    // AGRUN-465 — dispatch-parity: session.run always honored the
    // `abortSignal` run option (readAbortSignal → callerAbortSignal +
    // abort-wrapped hooks); this door silently ignored it, so
    // runtime.run(input, { abortSignal }) could not be cancelled. Same
    // wrapping set as session/handle.js; onCheckpoint deliberately
    // UNwrapped on both doors (a checkpoint persisting crash-recovery
    // state must still fire while an abort is unwinding).
    const callerAbortSignal = readAbortSignal(mergedRunOptions);
    return runLoop({
      callerAbortSignal,
      disabledActions: readDisabledActions(mergedRunOptions),
      onStep: wrapHookForAbort(readOnStep(mergedRunOptions), callerAbortSignal),
      onToken: wrapHookForAbort(readOnToken(mergedRunOptions), callerAbortSignal),
      onReasoning: wrapHookForAbort(readFunctionOption(mergedRunOptions, "onReasoning"), callerAbortSignal),
      onInvalidPlannerOutput: wrapHookForAbort(readFunctionOption(mergedRunOptions, "onInvalidPlannerOutput"), callerAbortSignal),
      onPlannerDecision: wrapHookForAbort(readFunctionOption(mergedRunOptions, "onPlannerDecision"), callerAbortSignal),
      onStreamEvent: wrapHookForAbort(readFunctionOption(mergedRunOptions, "onStreamEvent"), callerAbortSignal),
      onToolResult: wrapHookForAbort(readFunctionOption(mergedRunOptions, "onToolResult"), callerAbortSignal),
      onBeforeFinalize: wrapHookForAbort(readFunctionOption(mergedRunOptions, "onBeforeFinalize"), callerAbortSignal),
      onCheckpoint: readFunctionOption(mergedRunOptions, "onCheckpoint"),
      resumeState: readResumeState(mergedRunOptions),
      plannerDirectives: readPlannerDirectives(mergedRunOptions),
      plannerDirectivesMode: readPlannerDirectivesMode(mergedRunOptions),
      rawInput,
      runId: nextRunId(),
      runtimeConfig: resolvedConfig.runtimeConfig,
      runtimeEventBus,
      runtimeState,
      resolvedMemory: resolvedConfig.memory,
      skills: resolvedConfig.skills
    });
  }

  return {
    async run(rawInput, runOptions) {
      return runOnce(rawInput, runOptions);
    },

    // AGRUN-442 — streaming engine surface. Iterate typed AgentLoopEvents at your
    // own pace; break / generator.return() aborts the run. Built on the same
    // runOnce as run(), so every run mechanism (abort, hooks, budget) carries over.
    runStream(rawInput, runOptions) {
      return createRunEventStream(
        (hookedOptions) => runOnce(rawInput, hookedOptions),
        runOptions || {}
      );
    },

    async createSession(sessionOptions) {
      const resolvedConfig = readResolvedConfig();
      const explicitId = sessionOptions && typeof sessionOptions === "object" && typeof sessionOptions.id === "string"
        ? sessionOptions.id.trim()
        : "";
      const seedMessages = sessionOptions && typeof sessionOptions === "object"
        ? sessionOptions.seedMessages
        : null;
      const sessionRecord = createSessionRecord(explicitId || createSessionId());
      await resolvedSessionStore.createSession(sessionRecord);
      await seedSessionHistory(resolvedSessionStore, sessionRecord, seedMessages);
      await resolvedSessionStore.saveSession(sessionRecord);
      await sessionMessageStore.createSession(sessionRecord, sessionOptions);
      return createSessionHandle({
        // AGRUN-440/444 — opt-in: run session memory extraction off the turn's
        // critical path (default off = awaited, result.memoryEntriesAdded set).
        asyncMemoryExtraction: Boolean(options && options.asyncMemoryExtraction),
        // AGRUN-517 — optional host policy gating the per-turn extraction LLM call.
        memoryExtractionPolicy: options && typeof options.memoryExtractionPolicy === "function"
          ? options.memoryExtractionPolicy
          : null,
        runtimeConfig: resolvedConfig.runtimeConfig,
        runtimeEventBus,
        sessionMessageStore,
        defaultRunOptions: resolvedConfig.runtimeConfig.defaultRunOptions,
        sessionPolicy: resolvedConfig.sessionPolicy,
        sessionRecord,
        sessionStore: resolvedSessionStore,
        skills: resolvedConfig.skills
      });
    },

    async openSession(sessionId) {
      const resolvedConfig = readResolvedConfig();
      const sessionRecord = await resolvedSessionStore.getSession(sessionId);

      if (!sessionRecord) {
        throw new Error(`Session "${sessionId}" was not found.`);
      }

      return createSessionHandle({
        // AGRUN-440/444 — opt-in: run session memory extraction off the turn's
        // critical path (default off = awaited, result.memoryEntriesAdded set).
        asyncMemoryExtraction: Boolean(options && options.asyncMemoryExtraction),
        // AGRUN-517 — optional host policy gating the per-turn extraction LLM call.
        memoryExtractionPolicy: options && typeof options.memoryExtractionPolicy === "function"
          ? options.memoryExtractionPolicy
          : null,
        runtimeConfig: resolvedConfig.runtimeConfig,
        runtimeEventBus,
        sessionMessageStore,
        defaultRunOptions: resolvedConfig.runtimeConfig.defaultRunOptions,
        sessionPolicy: resolvedConfig.sessionPolicy,
        sessionRecord,
        sessionStore: resolvedSessionStore,
        skills: resolvedConfig.skills
      });
    },

    getState() {
      return cloneValue(runtimeState);
    },

    getMemory() {
      const resolvedConfig = readResolvedConfig();
      return createReadOnlyMemory(resolvedConfig.memory);
    },

    getRuntimeConfig() {
      return cloneValue(readResolvedConfig().runtimeConfig);
    },

    getRuntimeConfigState() {
      return configLifecycle.getState();
    },

    getMessageStorageState() {
      return sessionMessageStore.getState();
    },

    // AGRUN-440 — await durability of all pending transcript writes. Relevant
    // when the store runs with asyncWrites (fire-and-forget assistant writes);
    // call at a host checkpoint (beforeunload, before close) to flush the queue.
    async flushMessageStorage() {
      return sessionMessageStore.flush();
    },

    async reloadRuntimeConfig(nextOptionsOrLoader, reloadOptions) {
      return configLifecycle.reload(nextOptionsOrLoader, reloadOptions);
    },

    getAgentSkills() {
      const resolvedConfig = readResolvedConfig();
      return cloneValue(
        (resolvedConfig.agentSkills || [])
          .map(createAgentSkillSummary)
          .filter(Boolean)
      );
    },

    getActionRegistry() {
      const resolvedConfig = readResolvedConfig();
      const registry = createActionRegistry({
        agentSkills: resolvedConfig.agentSkills,
        agentSkillIndexProvider: resolvedConfig.agentSkillIndexProvider,
        customActions: resolvedConfig.runtimeConfig.customActions,
        // ADR-0057 Phase 1 — keep host introspection consistent with the run
        // path: open_action_namespace appears here exactly when it runs.
        deferredNamespaces: resolvedConfig.runtimeConfig.deferredNamespaces,
        repoFileTools: resolvedConfig.runtimeConfig.repoFileTools,
        toolCallExamples: resolvedConfig.runtimeConfig.toolCallExamples
      });
      return registry.list().map((action) => ({
        name: action.name,
        description: action.description || "",
        permission: action.permission,
        tier: action.tier ?? 0
      }));
    },

    subscribeEvents(callback, subscribeOptions) {
      return runtimeEventBus.subscribe(callback, subscribeOptions);
    }
  };

  function readResolvedConfig() {
    return configLifecycle.getConfig();
  }
}

function normalizeRuntimeConfigWithRuntimeFields(options) {
  const resolvedConfig = normalizeRuntimeConfig(options);
  if (resolvedConfig.runtimeConfig.approvalSigning.enabled) {
    resolvedConfig.runtimeConfig.approvalSigner = createApprovalSigner(
      resolvedConfig.runtimeConfig.approvalSigning
    );
  } else {
    resolvedConfig.runtimeConfig.approvalSigner = null;
  }
  return resolvedConfig;
}

function readOnStep(options) {
  return options && typeof options === "object" && typeof options.onStep === "function"
    ? options.onStep
    : null;
}

function readOnToken(options) {
  return options && typeof options === "object" && typeof options.onToken === "function"
    ? options.onToken
    : null;
}

function readFunctionOption(options, key) {
  return options && typeof options === "object" && typeof options[key] === "function"
    ? options[key]
    : null;
}

function readResumeState(options) {
  return options && typeof options === "object"
    && options.resumeState && typeof options.resumeState === "object"
    && !Array.isArray(options.resumeState)
    ? options.resumeState
    : null;
}

function readDisabledActions(options) {
  return options && typeof options === "object" && Array.isArray(options.disabledActions)
    ? options.disabledActions.slice()
    : [];
}

function readPlannerDirectives(options) {
  return options && typeof options === "object" && Array.isArray(options.plannerDirectives)
    ? options.plannerDirectives.slice()
    : [];
}

function readPlannerDirectivesMode(options) {
  return options && typeof options === "object" && options.plannerDirectivesMode === "replace"
    ? "replace"
    : "append";
}

export { createRuntime };
