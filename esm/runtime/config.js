import { createMemoryStore } from '../memory/store.js';
import { normalizeSessionPolicy } from '../session/policy.js';
import { normalizeAgentSkills, normalizeSkillIndexProvider, normalizeSkillManifests, createAgentSkillSummary } from './agent-skills.js';
import { resolveActiveRole } from './agent-roles.js';
import { PROMPT_SECTION_KEYS } from './prompts/resolve.js';
import { PROMPT_SECTION_DEFAULTS } from './prompts/defaults.js';
import { normalizeDebug } from './debug.js';
import { normalizeActionPolicy } from './policy.js';
import { normalizeActionPermissionJudgeConfig } from './action-permission-judge.js';
import { normalizeActionGuardrailConfig } from './action-guardrail-controller.js';
import { normalizeConvergenceConfig } from './action-pattern-convergence.js';
import { normalizeSkillPolicy } from './skill-policy.js';
import { toRecord } from './utils.js';
import { createCircuitBreaker } from '../skills/providers/fetch-resilience.js';
import { BUILTIN_PROVIDERS, BUILTIN_PROVIDER_NAMES } from './provider.js';
import { normalizeBudgetConfig } from './session-budget.js';
import { normalizeHostHookTimeoutMs } from './host-hook-timeout.js';
import { normalizeProviderRetry } from './provider-retry.js';
import { normalizeDriftDetectionConfig } from './drift-detection-config.js';
import { normalizeGoalAnchorConfig } from './goal-anchor-config.js';
import { normalizeTodoAutopilotConfig } from './todo-autopilot.js';
import { normalizeVirtualWorkspaceConfig } from './virtual-workspace.js';
import { normalizeRepoFileToolsConfig } from './repo-file-tools.js';
import { normalizeDefaultRunOptions } from './default-run-options.js';
import { normalizeCostPricing } from './cost-ledger.js';
import { normalizeHandoffInputFilters } from './handoff-input-filter.js';
import { normalizeCompactionPolicy } from '../session/compaction-policy.js';
import { normalizeEvidencePolicyConfig } from './evidence-policy.js';
import { isKnownActionNamespace, ACTION_NAMESPACE_MANIFEST } from './action-namespace-gate.js';
import { classifyEvidenceState } from './evidence-state.js';
import { normalizeResearchReportLoopConfig } from './kernel-report-loop.js';
import { normalizeSkillCatalogTopK, normalizeSkillCatalogRanker, normalizeSkillCatalogMaxK } from './skill-catalog-ranking.js';

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_HISTORY_COMPACTION = Object.freeze({
  enabled: true,
  triggerTokens: 4000,
  protectHeadEntries: 5,
  protectTailEntries: 15
});
const DEFAULT_MAX_PLAN_ACTIONS = 10;
const HARD_MAX_PLAN_ACTIONS = 20;
const DEFAULT_MAX_PLAN_PARALLEL = 8;
const DEFAULT_MAX_SECTION_PARALLEL = 4;

function normalizeRuntimeConfig(options) {
  const config = toRecord(options);
  const registeredSkills = normalizeSkills(config.skills);
  // AGRUN-313 P2f (2.0, BREAKING) — default flipped to []. agrun is now a
  // general agent runtime: a host that wires nothing gets a generic agent loop
  // with ZERO domain skills/concepts. Research/coder behavior is opt-in.
  //   agentSkills unset / [] -> generic loop, no domain skills (the new default).
  //   agentSkills: [...]      -> exactly the skills you pass. Import
  //                              `bundledAgentSkills` (or a subset) to opt in to
  //                              the shipped research/coder pack.
  // Migration: hosts that relied on the implicit bundled default must now pass
  // `agentSkills: bundledAgentSkills` explicitly. See micro-kernel RFC.
  const resolvedFullAgentSkills = normalizeAgentSkills(config.agentSkills == null ? [] : config.agentSkills);
  const resolvedAgentSkillIndexProvider = normalizeSkillIndexProvider(
    config.agentSkillIndexProvider,
    resolvedFullAgentSkills
  );
  const resolvedAgentSkillManifests = readInitialSkillManifests(
    resolvedAgentSkillIndexProvider,
    resolvedFullAgentSkills
  );
  // AGRUN-313 (post-3.0) — core no longer defaults to the bundled role catalog. A host
  // resolves a role-by-name against the roles it passes (e.g. bundledAgentRoles from
  // the in-tree role DATA default-research-roles.js); a role passed as an object still resolves with no catalog.
  const resolvedRole = resolveActiveRole(config.role, Array.isArray(config.agentRoles) ? config.agentRoles : []);
  const resolvedMemory = normalizeMemory(config.memory);
  // GAP 5 — maxCostUsd needs the resolved pricing to validate the
  // pricing-required rule, so costPricing is hoisted out of the literal.
  const resolvedCostPricing = normalizeCostPricingConfig(config.costPricing);
  const resolvedMaxCostUsd = normalizeMaxCostUsd(config.maxCostUsd, resolvedCostPricing);
  // AGRUN-274d-4 — `extractFallbackSkill` deleted with the skill-loop
  // router. The `fallbackSkill` option / `isFallback:true` skill marker
  // are silently ignored now; the `skills:` array still validates shape
  // (kept for AGRUN-274e to clean up) but the router that consumed it
  // is gone.

  return {
    agentSkillIndexProvider: resolvedAgentSkillIndexProvider,
    agentSkills: resolvedAgentSkillManifests,
    memory: resolvedMemory,
    sessionPolicy: normalizeSessionPolicy(config.sessionPolicy),
    sessionStore: config.sessionStore || null,
    runtimeConfig: {
      actionGuardrail: normalizeActionGuardrailConfig(config.actionGuardrail),
      actionPolicy: normalizeActionPolicy(config.actionPolicy),
      actionPermissionJudge: normalizeActionPermissionJudgeConfig(config.actionPermissionJudge),
      agentSkillIndexProvider: resolvedAgentSkillIndexProvider,
      agentSkills: resolvedAgentSkillManifests,
      agentRole: resolvedRole,
      approvalSigning: normalizeApprovalSigning(config.approvalSigning),
      budget: normalizeBudgetConfig(config.budget),
      // AGRUN-297 — host-defined output-acceptance POLICY (ADR-0051).
      // `candidateQuality` lets a host relax/tighten the built-in default
      // guardrail's structure-issue severity; `outputGuardrails` is the
      // host-written guardrail list (OpenAI-Agents-SDK shape, adapted:
      // block surfaces a re-plan observation to the AI, never halts/authors).
      candidateQuality: normalizeCandidateQuality(config.candidateQuality),
      outputGuardrails: normalizeOutputGuardrails(config.outputGuardrails),
      citationCoverageGuard: config.citationCoverageGuard,
      circuitBreaker: normalizeCircuitBreaker(config.circuitBreaker),
      // F1 (weak-model e2e comparison) — bounded retry for transient provider
      // errors on the non-streaming completion path. Threaded onto the request
      // like circuitBreaker; see provider-retry.js for defaults + posture.
      providerRetry: normalizeProviderRetry(config.providerRetry),
      // provider-registry-design.md — host LLM providers. The frozen map
      // merges host entries over the built-ins and is threaded onto the
      // request (like circuitBreaker) so dispatch resolves custom providers
      // with the full resilience chain. Built-in names cannot be overridden.
      providerRegistry: normalizeProviders(config.providers),
      compactionPolicy: normalizeCompactionPolicy(config.compactionPolicy),
      // AGRUN-456 — host-configurable action-pattern convergence tunables
      // (thresholds + forbidden-action lists). agrun is a GENERAL runtime; only
      // the host knows its task type and acceptable convergence aggressiveness.
      // Pre-normalized here (like actionGuardrail) so getRuntimeConfig().convergence
      // shows the resolved values; the detector re-normalizes idempotently. When
      // `convergence` is absent every value falls back to its DEFAULT_* constant,
      // so default behavior is byte-identical.
      convergence: normalizeConvergenceConfig(config),
      costPricing: resolvedCostPricing,
      defaultRunOptions: normalizeDefaultRunOptions(config.defaultRunOptions),
      debug: normalizeDebug(config.debug),
      evidencePolicy: normalizeEvidencePolicyConfig(config.evidencePolicy),
      // AGRUN-313-P2F (2.0 prep) — research evidence classifier hook. Default
      // wires the research impl so behavior is byte-identical; the kernel hot
      // path reads this instead of importing the research function. 2.0 flips
      // the default behind the opt-in research plugin.
      classifyEvidenceFn: typeof config.classifyEvidenceFn === "function"
        ? config.classifyEvidenceFn
        : classifyEvidenceState,
      customActions: normalizeCustomActions(config.customActions),
      disabledActions: normalizeDisabledActions(config.disabledActions),
      // ADR-0057 Phase 1 (AGRUN-565) — opt-in deferred action namespaces.
      // Default [] keeps prompts and dispatch byte-identical. When a declared
      // namespace is listed, its member actions leave the planner catalog and
      // both dispatch doors gate them until the AI calls open_action_namespace
      // (action-namespace-gate.js is the SSOT the doors + prompt read this
      // value through). runtime-level only — composes with disabledActions
      // (disabled subtracts unconditionally; deferred subtracts until opened).
      deferredNamespaces: normalizeDeferredNamespaces(config.deferredNamespaces),
      globalMemory: normalizeGlobalMemory(config.globalMemory),
      handoffInputFilters: normalizeHandoffInputFilters(config.handoffInputFilters),
      longResearchQualityGate: config.longResearchQualityGate,
      skillCatalogMaxK: normalizeSkillCatalogMaxK(config.skillCatalogMaxK),
      skillCatalogRanker: normalizeSkillCatalogRanker(config.skillCatalogRanker),
      skillCatalogTopK: normalizeSkillCatalogTopK(config.skillCatalogTopK),
      toolCallExamples: normalizeToolCallExamples(config.toolCallExamples),
      maxSteps: normalizeMaxSteps(config.maxSteps),
      // ROADMAP D2 — opt-in HEAP cap for session.actionHistory (prompt cost
      // is already bounded by history compaction; this bounds memory on very
      // long runs). null = disabled (default; no behavior change). When set,
      // the loop trims the OLDEST entries in place at each cycle boundary
      // and shifts the compaction cursor so folded-observation bookkeeping
      // stays consistent.
      actionHistoryLimit: normalizeActionHistoryLimit(config.actionHistoryLimit),
      // Opt-in whole-run wall-clock budget. null = disabled (default; no
      // behavior change). When set, the action loop checks elapsed time at
      // each cycle boundary and returns a structured RUN_DEADLINE_EXCEEDED
      // result carrying the cost ledger, instead of relying on the host to
      // SIGKILL the process (which loses in-memory usage/cost).
      runDeadlineMs: normalizeRunDeadlineMs(config.runDeadlineMs),
      // Defense-in-depth timeout for AWAITED host hooks at loop scope
      // (onPlannerDecision / onToolResult / onInvalidPlannerOutput /
      // onBeforeFinalize). Invalid/absent → 10s default; a hung hook is
      // ignored with a debug log, never freezes the run. See
      // cross-cutting-dispatch-matrix-2026-06-10.md §4.
      hostHookTimeoutMs: normalizeHostHookTimeoutMs(config.hostHookTimeoutMs),
      // Opt-in whole-run USD budget (GAP 5). null = disabled (default; no
      // behavior change). When set, the action loop reads the cost ledger's
      // already-recorded totals at each cycle boundary and returns a
      // structured COST_BUDGET_EXCEEDED result on breach — same hard-stop
      // class as runDeadlineMs. Requires costPricing (validated above);
      // assumes host pricing is per-USD. Never exposed to the AI.
      maxCostUsd: resolvedMaxCostUsd,
      // Fraction of maxCostUsd at which the one-time `cost-budget-warning`
      // step fires (codebase-review 2026-06-10 — was a hardcoded 0.8 in the
      // loop). Default 0.8; inert when maxCostUsd is unset.
      costWarnRatio: normalizeCostWarnRatio(config.costWarnRatio),
      // GAP 4 — prompt-side action-history compaction. Default enabled:
      // under triggerTokens the planner prompt is byte-identical, so short
      // runs are unchanged; long runs fold older entries into an observer-
      // authored observation log instead of overflowing the context window.
      // `enabled: false` restores the full raw history block exactly.
      historyCompaction: normalizeHistoryCompaction(config.historyCompaction),
      maxPlanActions: normalizeMaxPlanActions(config.maxPlanActions),
      recoverPlanMutator: config.recoverPlanMutator !== false,
      maxPlanParallel: normalizeMaxPlanParallel(config.maxPlanParallel),
      maxSectionParallel: normalizeMaxSectionParallel(config.maxSectionParallel),
      nativeToolsFailurePolicy: normalizeNativeToolsFailurePolicy(config.nativeToolsFailurePolicy),
      plannerMode: normalizePlannerMode(config.plannerMode),
      selfCorrection: normalizeSelfCorrection(config.selfCorrection),
      // ADR-0026 — `singleToolFastPath` was removed because the runtime
      // no longer skips the post-tool planner cycle. Hosts that need the
      // legacy fast-path behavior wire `onToolResult` and call their own
      // finalize path. The option is silently ignored if still passed.
      skillPolicy: normalizeSkillPolicy(config.skillPolicy),
      preferFinalizeOnLastResult: config.preferFinalizeOnLastResult !== false,
      plannerDirectives: normalizePlannerDirectives(config.plannerDirectives),
      // ADR-0035 (AGRUN-262) — host prompt-section overrides. Returns the full
      // resolved set (host override where given, runtime default otherwise) so
      // getRuntimeConfig().prompts shows exactly what ships. Per-section REPLACE
      // only; null/false disables a section; default behavior byte-identical.
      prompts: normalizePromptsConfig(config.prompts),
      // AGRUN-256 — publish-candidate mode gate. Default behavior hides
      // workspace_publish_candidate from the planner action surface unless
      // the run is an evidence-convergence run (a skill declaring the
      // requiresEvidenceConvergence capability is engaged),
      // unless the terminal repair surface explicitly authorizes it.
      // Hosts that intentionally need publish-direct in tool_loop mode
      // can pass `{ enabled: false }` to opt out.
      publishCandidateGate: normalizePublishCandidateGate(config.publishCandidateGate),
      researchCoverageGuard: config.researchCoverageGuard,
      researchReportLoop: normalizeResearchReportLoopConfig(config.researchReportLoop),
      repoFileTools: normalizeRepoFileToolsConfig(config.repoFileTools),
      threads: normalizeThreadsConfig(config.threads),
      driftDetection: normalizeDriftDetectionConfig(config.driftDetection),
      goalAnchor: normalizeGoalAnchorConfig(config.goalAnchor),
      todoAutopilot: normalizeTodoAutopilotConfig(config.todoAutopilot),
      virtualWorkspace: normalizeVirtualWorkspaceConfig(config.virtualWorkspace)
    },
    skills: registeredSkills,
    fallbackSkill: null
  };
}

// AGRUN-297 / ADR-0051 — host output-acceptance policy normalizers.
function normalizeCandidateQuality(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    structureIssueSeverity: normalizeIssueSeverityMap(source.structureIssueSeverity),
    // 2026-06-10 — sourceIssueSeverity was documented as the host opt-in for
    // a hard source gate (candidate-quality-signal.js resolveSourceIssueSeverity)
    // but this normalizer silently dropped it: the allowlist-out-of-sync bug
    // class again. Live evidence: a declared citation contract stayed
    // advisory-only and a 0-citation report published as "ready".
    sourceIssueSeverity: normalizeIssueSeverityMap(source.sourceIssueSeverity)
  };
}

function normalizeIssueSeverityMap(value) {
  const overrides = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const normalized = {};
  if (overrides) {
    for (const [code, severity] of Object.entries(overrides)) {
      if (severity === "blocking" || severity === "advisory") {
        normalized[code] = severity;
      }
    }
  }
  return normalized;
}

// ADR-0035 (AGRUN-262) — host prompt-section overrides.
//
// Returns the FULL resolved set: every section key present, with the host's
// override where supplied and the runtime default otherwise. This is both the
// value threaded to the prompt builders (resolvePromptSection treats a default
// builder/array identically to a host one) and what getRuntimeConfig().prompts
// exposes so hosts can verify what shipped.
//
// Per-section REPLACE only (no merge inside a section). A section value may be:
//   - an array of strings  → used verbatim (non-strings dropped at render)
//   - a function (ctx) => string[]  → called at render with the section's ctx
//   - null or false        → section disabled (renders nothing)
//   - undefined            → keep the runtime default
// Unknown keys and wrong value types THROW with a helpful message (a silently
// ignored typo would make a host think they overrode a section when they did
// not). Backward-compatible forever: adding a key is safe; this is public surface.
function normalizePromptsConfig(value) {
  const resolved = { ...PROMPT_SECTION_DEFAULTS };
  if (value == null) return Object.freeze(resolved);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `runtimeConfig.prompts must be an object keyed by section name, got ` +
      `${Array.isArray(value) ? "array" : typeof value}. ` +
      `Valid sections: ${PROMPT_SECTION_KEYS.join(", ")}.`
    );
  }
  for (const [key, override] of Object.entries(value)) {
    if (!PROMPT_SECTION_KEYS.includes(key)) {
      throw new Error(
        `runtimeConfig.prompts: unknown section "${key}". ` +
        `Valid sections: ${PROMPT_SECTION_KEYS.join(", ")}.`
      );
    }
    if (override === undefined) continue;
    if (override === null || override === false || Array.isArray(override) || typeof override === "function") {
      resolved[key] = override;
      continue;
    }
    throw new TypeError(
      `runtimeConfig.prompts.${key} must be an array of strings, a function ` +
      `(ctx) => string[], null, or false to disable; got ${typeof override}.`
    );
  }
  return Object.freeze(resolved);
}

// Host-written output guardrails. Each entry is { name, execute } where execute
// is preserved by reference (a function — never cloned/stripped). Invalid
// entries are dropped so a malformed host config cannot break the run.
function normalizeOutputGuardrails(value) {
  if (!Array.isArray(value)) return [];
  const guardrails = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.execute !== "function") continue;
    const name = typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : `guardrail_${guardrails.length + 1}`;
    guardrails.push({ name, execute: entry.execute });
  }
  return guardrails;
}

function readInitialSkillManifests(provider, defaultSkills) {
  if (provider && typeof provider.listManifests === "function") {
    try {
      const manifests = provider.listManifests();
      if (Array.isArray(manifests)) {
        return normalizeSkillManifests(manifests);
      }
    } catch {
      // Runtime creation should stay cheap and non-remote. Provider-backed
      // actions can surface load/list errors at execution time.
    }
  }

  return (Array.isArray(defaultSkills) ? defaultSkills : [])
    .map(createAgentSkillSummary)
    .filter(Boolean);
}

function normalizeCostPricingConfig(value) {
  return normalizeCostPricing(value);
}

function normalizeApprovalSigning(value) {
  if (value == null || value === false) {
    return { enabled: false };
  }
  const record = value === true ? {} : (value && typeof value === "object" ? value : {});
  return {
    enabled: true,
    key: record.key != null ? record.key : null,
    ttlMs: Number.isFinite(record.ttlMs) && record.ttlMs > 0 ? record.ttlMs : 15 * 60 * 1000,
    enforceSessionBinding: record.enforceSessionBinding !== false,
    onDegraded: typeof record.onDegraded === "function" ? record.onDegraded : null
  };
}

function normalizeSkills(skills) {
  // AGRUN-274e — `skills:` is now a backwards-compatibility field. The
  // skill-loop router (run-skill-loop.js / router.js / skill-probe.js)
  // was deleted in AGRUN-274d-4, so `canHandle` / `orient` / `evaluate`
  // / `execute` are no longer invoked by the runtime. We keep light
  // shape validation (every entry must be an object with a non-empty
  // `name`) so hosts that still pass legacy skill arrays get a clear
  // error on malformed input. The array may be empty or omitted.
  if (skills == null) {
    return [];
  }
  if (!Array.isArray(skills)) {
    throw new Error('createRuntime(options).skills must be an array when provided.');
  }

  return skills.map((skill) => {
    if (!skill || typeof skill !== "object") {
      throw new Error("Each skill must be an object.");
    }

    if (typeof skill.name !== "string" || skill.name.length === 0) {
      throw new Error("Each skill must define a non-empty name.");
    }

    return skill;
  });
}

function normalizeMemory(memory) {
  if (memory == null) {
    return createMemoryStore();
  }

  if (typeof memory.readAll !== "function" || typeof memory.append !== "function") {
    throw new Error('memory must define "readAll()" and "append()".');
  }

  return memory;
}

function normalizePlannerMode(value) {
  if (value === "native_tools") {
    return "native_tools";
  }
  if (value === "envelope") {
    return "envelope";
  }
  return "auto";
}

function normalizeNativeToolsFailurePolicy(value) {
  if (value === "hard_fail") {
    return "hard_fail";
  }
  return "fallback_to_envelope";
}

function normalizeSelfCorrection(value) {
  if (value === false) {
    return { enabled: false, maxRetries: 0 };
  }
  if (value && typeof value === "object") {
    return {
      enabled: value.enabled !== false,
      maxRetries: Number.isInteger(value.maxRetries) && value.maxRetries > 0
        ? value.maxRetries
        : 2
    };
  }
  return { enabled: true, maxRetries: 2 };
}

function normalizePlannerDirectives(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line) => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim());
}

function normalizeDisabledActions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim());
}

// ADR-0057 Phase 1 — validate against the declared namespace manifest and
// FAIL LOUD on unknown names. Unlike disabledActions (which may legitimately
// name host custom actions unknown at config time), the namespace set is
// static and declared in-core, so a typo ("workspaces") would otherwise be a
// silent no-op — the "silent no-op cap is worse than an error" posture of
// maxCostUsd above.
function normalizeDeferredNamespaces(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("deferredNamespaces must be an array of namespace names when provided.");
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("deferredNamespaces entries must be non-empty strings.");
    }
    const name = entry.trim();
    if (!isKnownActionNamespace(name)) {
      const known = ACTION_NAMESPACE_MANIFEST.map((item) => item.name).join(", ");
      throw new Error(`deferredNamespaces: unknown namespace "${name}". Known namespaces: ${known}.`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      normalized.push(name);
    }
  }
  return normalized;
}

// AGRUN-271 — host-supplied actions. Each entry must already have been
// produced by defineAction() (or otherwise match the same shape). We do
// shape-validation here rather than blindly trusting the caller, because
// these run inside the same context as bundled actions and a malformed
// entry could crash the registry at planner-projection time.
function normalizeCustomActions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("createRuntime: customActions must be an array (use defineAction(spec) to build entries).");
  }
  const seen = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`createRuntime: customActions[${index}] must be an object (got ${typeof entry}).`);
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`createRuntime: customActions[${index}].name must be a non-empty string.`);
    }
    if (typeof entry.execute !== "function") {
      throw new Error(`createRuntime: customActions[${index}] ("${entry.name}").execute must be a function.`);
    }
    if (!entry.planner || typeof entry.planner !== "object") {
      throw new Error(`createRuntime: customActions[${index}] ("${entry.name}").planner must be an object.`);
    }
    if (!("outputSchema" in entry)) {
      throw new Error(`createRuntime: customActions[${index}] ("${entry.name}") must declare outputSchema (or outputSchema:null waiver).`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`createRuntime: customActions contains duplicate name "${entry.name}".`);
    }
    seen.add(entry.name);
    return entry;
  });
}

function normalizePublishCandidateGate(value) {
  if (value == null) {
    return { enabled: true };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { enabled: true };
  }
  return {
    enabled: value.enabled !== false
  };
}

function normalizeToolCallExamples(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    return typeof item.skillName === "string" && item.skillName.trim()
      && typeof item.toolName === "string" && item.toolName.trim();
  }).map((item) => ({
    skillName: item.skillName.trim(),
    toolName: item.toolName.trim(),
    args: item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args : {}
  }));
}

function normalizeCircuitBreaker(value) {
  if (value === false) return null;
  if (value && typeof value === "object" && typeof value.canRequest === "function") {
    return value; // Already a circuit breaker instance.
  }
  if (value === true) return createCircuitBreaker();
  if (value && typeof value === "object") {
    return createCircuitBreaker(value);
  }
  return null; // Disabled by default.
}

// provider-registry-design.md — validate host LLM providers and merge them
// over the built-ins into one frozen registry. Returns the built-in map
// unchanged when no custom providers are given (behavior-identical default).
// Built-in names cannot be overridden; bad shapes throw at createRuntime
// (mirror defineAction strictness) so a misconfigured provider fails loud.
function normalizeProviders(value) {
  if (value == null) return BUILTIN_PROVIDERS;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("createRuntime({ providers }) must be a plain object keyed by provider name.");
  }
  const custom = {};
  for (const [name, entry] of Object.entries(value)) {
    if (BUILTIN_PROVIDER_NAMES.includes(name)) {
      throw new Error(`providers: "${name}" is a built-in provider and cannot be overridden. Register a new name instead.`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`providers["${name}"] must be an object with a complete(options, fetch) function.`);
    }
    if (typeof entry.complete !== "function") {
      throw new Error(`providers["${name}"].complete must be a function.`);
    }
    if (entry.stream != null && typeof entry.stream !== "function") {
      throw new Error(`providers["${name}"].stream must be a function when provided.`);
    }
    if (entry.normalizeRequest != null && typeof entry.normalizeRequest !== "function") {
      throw new Error(`providers["${name}"].normalizeRequest must be a function when provided.`);
    }
    // A host that omits stream() still streams: requestProviderCompletionStreaming
    // falls back to complete() and emits the full text as one delta (handled in
    // provider.js). Freeze the resolved entry so downstream cannot mutate it.
    custom[name] = Object.freeze({
      complete: entry.complete,
      stream: typeof entry.stream === "function" ? entry.stream : null,
      normalizeRequest: typeof entry.normalizeRequest === "function" ? entry.normalizeRequest : null
    });
  }
  return Object.freeze({ ...BUILTIN_PROVIDERS, ...custom });
}

function normalizeGlobalMemory(value) {
  const defaults = {
    enabled: true,
    minConfidence: 0.7,
    maxEntries: 100,
    hookTimeoutMs: 2000,
    sensitivityFilter: null,
    promotionValidator: null
  };
  if (!value || typeof value !== "object") return defaults;
  const enabled = value.enabled !== false;
  const minConfidence = typeof value.minConfidence === "number" && value.minConfidence >= 0 && value.minConfidence <= 1
    ? value.minConfidence
    : defaults.minConfidence;
  const maxEntries = Number.isInteger(value.maxEntries) && value.maxEntries > 0
    ? value.maxEntries
    : defaults.maxEntries;
  const hookTimeoutMs = Number.isInteger(value.hookTimeoutMs) && value.hookTimeoutMs > 0
    ? value.hookTimeoutMs
    : defaults.hookTimeoutMs;
  const sensitivityFilter = typeof value.sensitivityFilter === "function" ? value.sensitivityFilter : null;
  const promotionValidator = typeof value.promotionValidator === "function" ? value.promotionValidator : null;
  return { enabled, minConfidence, maxEntries, hookTimeoutMs, sensitivityFilter, promotionValidator };
}

function normalizeThreadsConfig(value) {
  const defaults = {
    enabled: false,
    maxThreads: 8,
    routerMinOverlap: 0.2,
    ambiguityDelta: 0.05,
    allowPivot: true,
    crossThreadRecall: false,
    intentClassifier: null
  };
  if (value == null || value === false) return { ...defaults };
  if (value === true) return { ...defaults, enabled: true };
  if (typeof value !== "object") return { ...defaults };
  const enabled = value.enabled === true;
  const maxThreads = Number.isInteger(value.maxThreads) && value.maxThreads > 0
    ? value.maxThreads
    : defaults.maxThreads;
  const routerMinOverlap = typeof value.routerMinOverlap === "number"
    && value.routerMinOverlap >= 0 && value.routerMinOverlap <= 1
    ? value.routerMinOverlap
    : defaults.routerMinOverlap;
  const ambiguityDelta = typeof value.ambiguityDelta === "number"
    && value.ambiguityDelta >= 0 && value.ambiguityDelta <= 1
    ? value.ambiguityDelta
    : defaults.ambiguityDelta;
  const allowPivot = value.allowPivot !== false;
  const crossThreadRecall = value.crossThreadRecall === true;
  // Optional callback: ({userMessage, threads, activeThreadId}) => Promise<intent>.
  // Runtime consumer wires this up when an LLM-backed intent planner is
  // desired; structural extractor stays the default cheap path.
  const intentClassifier = typeof value.intentClassifier === "function"
    ? value.intentClassifier
    : null;
  return {
    enabled,
    maxThreads,
    routerMinOverlap,
    ambiguityDelta,
    allowPivot,
    crossThreadRecall,
    intentClassifier
  };
}

function normalizeMaxSteps(value) {
  if (value == null) {
    return DEFAULT_MAX_STEPS;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('maxSteps must be a positive integer when provided.');
  }

  return value;
}

function normalizeActionHistoryLimit(value) {
  if (value == null) {
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('actionHistoryLimit must be a positive integer when provided.');
  }

  return value;
}

function normalizeRunDeadlineMs(value) {
  if (value == null) {
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('runDeadlineMs must be a positive integer of milliseconds when provided.');
  }

  return value;
}

function normalizeMaxCostUsd(value, costPricing) {
  if (value == null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error('maxCostUsd must be a positive finite number when provided.');
  }

  // Fail loud at createRuntime: without pricing the cost ledger never
  // computes USD totals (totals.cost stays null) and the budget could
  // never trigger — a silent no-op cap is worse than an error.
  if (!costPricing) {
    throw new Error('maxCostUsd requires costPricing — without pricing the cost ledger never computes USD totals and the budget could never trigger.');
  }

  return value;
}

// Warning threshold for the maxCostUsd budget, as a fraction of the cap.
// Strictly between 0 and 1: at 1 the warning would coincide with the breach
// (useless), at 0 it would fire on the first recorded cost (noise).
function normalizeCostWarnRatio(value) {
  if (value == null) {
    return 0.8;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error('costWarnRatio must be a number greater than 0 and less than 1 when provided.');
  }

  return value;
}

// GAP 4 — action-loop history compaction config (see
// agrun_docs/action-history-compaction-design.md). Generic mechanism knobs
// only: when the projected planner-prompt history block crosses
// `triggerTokens`, entries between the protected head and tail are folded
// into an observer-LLM observation log.
function normalizeHistoryCompaction(value) {
  if (value == null) {
    return { ...DEFAULT_HISTORY_COMPACTION };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('historyCompaction must be an object when provided.');
  }

  return {
    enabled: value.enabled !== false,
    triggerTokens: readHistoryCompactionInteger(
      value.triggerTokens,
      DEFAULT_HISTORY_COMPACTION.triggerTokens,
      'historyCompaction.triggerTokens must be a positive integer when provided.',
      1
    ),
    protectHeadEntries: readHistoryCompactionInteger(
      value.protectHeadEntries,
      DEFAULT_HISTORY_COMPACTION.protectHeadEntries,
      'historyCompaction.protectHeadEntries must be a non-negative integer when provided.',
      0
    ),
    protectTailEntries: readHistoryCompactionInteger(
      value.protectTailEntries,
      DEFAULT_HISTORY_COMPACTION.protectTailEntries,
      'historyCompaction.protectTailEntries must be a non-negative integer when provided.',
      0
    )
  };
}

function readHistoryCompactionInteger(value, fallback, message, minimum) {
  if (value == null) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(message);
  }

  return value;
}

function normalizeMaxPlanActions(value) {
  if (value == null) {
    return DEFAULT_MAX_PLAN_ACTIONS;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('maxPlanActions must be a positive integer when provided.');
  }

  if (value > HARD_MAX_PLAN_ACTIONS) {
    throw new Error(`maxPlanActions must be ${HARD_MAX_PLAN_ACTIONS} or less.`);
  }

  return value;
}

function normalizeMaxPlanParallel(value) {
  if (value == null) {
    return DEFAULT_MAX_PLAN_PARALLEL;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('maxPlanParallel must be a positive integer when provided.');
  }

  return value;
}

function normalizeMaxSectionParallel(value) {
  if (value == null) {
    return DEFAULT_MAX_SECTION_PARALLEL;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('maxSectionParallel must be a positive integer when provided.');
  }

  return value;
}

export { normalizeRuntimeConfig };
