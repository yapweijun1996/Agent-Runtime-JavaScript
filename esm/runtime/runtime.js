import { createReadOnlyMemory } from '../memory/store.js';
import { createSessionHandle } from '../session/handle.js';
import { createSessionRecord, createSessionId } from '../session/messages.js';
import { seedSessionHistory } from '../session/seed.js';
import { createSessionStore } from '../session/store.js';
import { normalizeRuntimeConfig } from './config.js';
import { createRuntimeConfigLifecycle } from './runtime-config-lifecycle.js';
import { createActionRegistry } from './action-registry.js';
import { runLoop } from './run-loop.js';
import { createAgentSkillSummary } from './agent-skills.js';
import { createApprovalSigner } from './approval-signing.js';
import { mergeRunOptions } from './default-run-options.js';
import { createRuntimeEventBus } from './runtime-event-ledger.js';
import { createSessionMessageStore } from './session-message-store.js';
import { cloneValue } from './utils.js';

function createRuntime(options) {
  const configLifecycle = createRuntimeConfigLifecycle(options, normalizeRuntimeConfigWithRuntimeFields);
  const runtimeState = { lastRun: null };
  const runtimeEventBus = createRuntimeEventBus();
  const sessionMessageStore = createSessionMessageStore({
    onError: options && typeof options.onStorageError === "function" ? options.onStorageError : null,
    runtimeEventBus,
    storage: options && options.storage
  });
  const resolvedSessionStore = createSessionStore(readResolvedConfig().sessionStore);
  let runSequence = 0;

  function nextRunId() {
    return `run-${++runSequence}`;
  }

  return {
    async run(rawInput, runOptions) {
      const resolvedConfig = readResolvedConfig();
      const mergedRunOptions = mergeRunOptions(
        resolvedConfig.runtimeConfig.defaultRunOptions,
        runOptions
      );
      return runLoop({
        disabledActions: readDisabledActions(mergedRunOptions),
        onStep: readOnStep(mergedRunOptions),
        onToken: readOnToken(mergedRunOptions),
        onInvalidPlannerOutput: readFunctionOption(mergedRunOptions, "onInvalidPlannerOutput"),
        onPlannerDecision: readFunctionOption(mergedRunOptions, "onPlannerDecision"),
        onStreamEvent: readFunctionOption(mergedRunOptions, "onStreamEvent"),
        onToolResult: readFunctionOption(mergedRunOptions, "onToolResult"),
        onBeforeFinalize: readFunctionOption(mergedRunOptions, "onBeforeFinalize"),
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
