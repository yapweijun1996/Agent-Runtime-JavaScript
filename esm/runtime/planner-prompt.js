import { hasSessionContext, buildSessionContextPromptBlock } from '../session/prompt.js';
import { COMPACTED_OBSERVATIONS_KIND } from './action-history-compaction.js';
import { PUBLISH_DIRECT_ACTION } from './kernel-terminal-actions.js';
import { projectSessionContextFromPlannerState } from './session-context-projection.js';
import { shouldShowSkillSurface } from './planner-action-surface.js';
import { buildRoleSystemPromptBlock } from './agent-roles.js';
import { buildEnvelopeLines } from './planner-envelope-lines.js';
export { readEnvelopeTerminalPolicy } from './planner-envelope-lines.js';
import { readContextSnapshot } from '../session/context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot, summarizeInquiryContext } from '../session/context-snapshot-projection.js';
import { toSkillPromptValue, readString, serializePromptValue, toSkillCatalogSummary, toSkillCatalogCompact, formatActiveSkillTools } from './planner-prompt-skills.js';
import { summarizePlanValidationFeedbackForPrompt } from './planner-plan-validation-feedback.js';
import { summarizeActionPatternConvergence } from './action-pattern-convergence.js';
import { summarizeReadUrlRecoverySignal } from './read-url-recovery-signal.js';
import { summarizeResearchAcceptanceEvaluator } from './kernel-acceptance-evaluator.js';
import { isEvidenceConvergenceRun } from './convergence-activation.js';
import { detectContinuedResearchThread, readStableResearchTopic } from './research-state.js';
import { summarizeRequirementRecoveryEvaluator } from './requirement-recovery-evaluator.js';
import { summarizeTerminalRepairState } from './terminal-repair-state.js';
import { summarizeInvalidActionConvergence } from './invalid-action-convergence.js';
import { buildInvalidActionPromptBlock } from './invalid-action-prompt-block.js';
import { summarizeSearchResults, summarizeLastObservationForPrompt } from './planner-prompt-projection.js';
import { buildVirtualWorkspacePromptBlock } from './virtual-workspace.js';
import { formatStandalonePlanActionNames } from './action-plan-contract.js';
import { summarizeTurnControlForPrompt } from './turn-signal.js';
import { buildLines as buildLines$1 } from './prompts/planner-base-directives.js';
import { buildLines } from './prompts/planner-compact-directives.js';
import { buildLines as buildLines$2 } from './prompts/skill-directives.js';
import { buildLines as buildLines$3 } from './prompts/workspace-directives.js';
import { buildLines as buildLines$4 } from './prompts/research-directives.js';
import { buildLines as buildLines$6 } from './prompts/convergence-advisory.js';
import { buildLines as buildLines$5 } from './prompts/todo-directives.js';
import { resolvePromptSection } from './prompts/resolve.js';

// SPIKE/oodae-ablation — A/B knob, NOT production logic. When the env var
// AGRUN_SPIKE_STRIP_OODAE_SIGNALS=1 is set, strip the orient/evaluate
// read-only signals (readAttemptSignal + qualityContext + evidenceState)
// from the planner prompt. This degrades the loop toward "pure ReAct"
// (observe -> decide -> act, no orient/evaluate signal feedback) so we can
// measure whether those signals actually help the AI. Default OFF -> the
// production prompt is byte-identical. Guarded for the browser bundle where
// `process` may be undefined.
// Level read at module-load: 0=off (production), 1=narrow, 2=wide.
const SPIKE_STRIP_LEVEL =
  (typeof process !== "undefined" && process.env
    ? parseInt(process.env.AGRUN_SPIKE_STRIP_OODAE_SIGNALS || "0", 10)
    : 0) || 0;
// L1 (narrow): the orient/evaluate signals that actually fire on single-turn
// research tasks — readAttemptSignal + qualityContext + evidenceState.
const SPIKE_STRIP_OODAE_SIGNALS = SPIKE_STRIP_LEVEL >= 1;
// L2 (wide): also strip clarificationStatus (orient) + the session evidence
// block (context/memory). NOTE: these are inert on single-turn,
// non-ambiguous tasks (clarification=none, no prior session evidence) — they
// only diverge from L1 on multi-turn or clarification-requiring tasks.
const SPIKE_STRIP_OODAE_SIGNALS_WIDE = SPIKE_STRIP_LEVEL >= 2;
// SPIKE/oodae-ablation — qualityContext WIRING experiment. The prompt has long
// instructed the AI to read loopState.qualityContext, but the value was never
// injected (issue codes only reached host result.diagnostics, never the
// in-loop AI). When AGRUN_SPIKE_WIRE_QUALITYCONTEXT=1, inject the recorded
// finalResponseQuality issue codes into loopState.qualityContext so the AI can
// actually see them on the next planner cycle — closing the half-wired signal
// so we can A/B test whether delivering it helps self-correction. Default OFF
// = current (unwired) production behaviour.
const SPIKE_WIRE_QUALITYCONTEXT =
  typeof process !== "undefined" &&
  process.env &&
  process.env.AGRUN_SPIKE_WIRE_QUALITYCONTEXT === "1";

function buildPlannerSystemPrompt(availableActions, options) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const opts = options && typeof options === "object" ? options : {};
  const roleBlock = buildRoleSystemPromptBlock(opts.agentRole || null);
  const dynamicSystemPrompt = typeof opts.systemPrompt === "string" ? opts.systemPrompt.trim() : "";
  // AGRUN-142 — verbatim anchor block (ORIGINAL USER QUERY + GOAL ANCHOR).
  // Injected right after roleBlock so it stays stable across cycles and can
  // be prompt-cached alongside system-level guidance. Empty when disabled
  // or when no anchor text is available.
  const goalAnchorBlock = compactDuplicateGoalAnchorBlock(
    typeof opts.goalAnchorBlock === "string"
    ? opts.goalAnchorBlock.trim()
      : "",
    opts.request && opts.request.prompt
  );
  const extraDirectives = Array.isArray(opts.plannerDirectives)
    ? opts.plannerDirectives.filter((line) => typeof line === "string" && line.trim())
    : [];
  const compactSystemPrompt = opts.compactSystemPrompt === true;

  return [
    ...(roleBlock ? [roleBlock, ""] : []),
    ...(goalAnchorBlock ? [goalAnchorBlock, ""] : []),
    ...(dynamicSystemPrompt ? [dynamicSystemPrompt, ""] : []),
    ...buildSystemPromptLines(actionDefinitions, {
      compactSystemPrompt,
      preferFinalizeOnLastResult: opts.preferFinalizeOnLastResult !== false,
      prompts: opts.prompts,
      runtimeConfig: opts.runtimeConfig
    }),
    ...buildEnvelopeLines(actionDefinitions, {
      compactExamples: opts.compactEnvelopeExamples !== false,
      effectivePlannerMode: opts.effectivePlannerMode,
      plannerMode: opts.plannerMode,
      request: opts.request,
      runState: opts.runState
    }),
    ...(compactSystemPrompt ? [] : buildGuidanceLines(actionDefinitions)),
    // Caller-supplied directives: appended last so override-by-recency applies.
    ...extraDirectives
  ].join("\n");
}

function buildSystemPromptLines(availableActions, options) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  const opts = options && typeof options === "object" ? options : {};
  const compactSystemPrompt = opts.compactSystemPrompt === true;
  const preferFinalizeOnLastResult = opts.preferFinalizeOnLastResult !== false;
  const hasAction = (name) => actionDefinitions.some((action) => action.name === name);
  // ADR-0035 (AGRUN-262) — each section resolves through the host override map
  // (opts.prompts). undefined → runtime default; null/false → disabled;
  // array/function → host content. Defaults are byte-identical (snapshot-locked).
  const prompts = opts.prompts && typeof opts.prompts === "object" ? opts.prompts : {};
  const ctx = {
    availableActions: actionDefinitions,
    compactSystemPrompt,
    runtimeConfig: opts.runtimeConfig,
    stripOodaeSignals: SPIKE_STRIP_OODAE_SIGNALS
  };
  const lines = [
    ...resolvePromptSection(
      compactSystemPrompt ? prompts.compactPlannerDirectives : prompts.basePlannerDirectives,
      compactSystemPrompt ? buildLines : buildLines$1,
      ctx
    )
  ];
  const standaloneActionNames = formatStandalonePlanActionNames(actionDefinitions);
  lines.push(`Current standalone-only actions for plan validation: ${standaloneActionNames}.`);

  lines.push(...resolvePromptSection(prompts.skillDirectives, buildLines$2, ctx));

  lines.push(...resolvePromptSection(prompts.workspaceDirectives, buildLines$3, ctx));

  lines.push(...resolvePromptSection(prompts.researchDirectives, buildLines$4, ctx));

  if (!compactSystemPrompt && preferFinalizeOnLastResult && hasAction("execute_skill_tool")) {
    lines.push("If the needed skill tool result is already present in toolContext.lastResult, prefer finalize instead of repeating the same execute_skill_tool call. Exception: when toolContext.lastResult.resultKind is one of \"resolution\", \"lookup\", \"preparatory\", \"intermediate\", \"partial\", or \"other\", the tool call was preparatory — continue with the next evidence-gathering tool call instead of finalizing.");
  }

  lines.push(...resolvePromptSection(prompts.todoDirectives, buildLines$5, ctx));

  lines.push(...resolvePromptSection(prompts.convergenceAdvisory, buildLines$6, ctx));

  return lines;
}

function buildGuidanceLines(availableActions) {
  const actionDefinitions = Array.isArray(availableActions) ? availableActions : [];
  return actionDefinitions
    .map((action) => readString(action.guidance))
    .filter(Boolean);
}

// SPIKE/oodae-ablation — read the recorded finalResponseQuality issue codes
// off runState and shape them for the planner prompt. Returns null when there
// are no issues so JSON.stringify omits the field (AI sees nothing, same as
// the unwired baseline). Only invoked when AGRUN_SPIKE_WIRE_QUALITYCONTEXT=1.
function buildQualityContextForPrompt(runState) {
  const fq = runState && typeof runState === "object" ? runState.finalResponseQuality : null;
  const issues = fq && Array.isArray(fq.lastIssues) ? fq.lastIssues.filter(Boolean) : [];
  if (issues.length === 0) return undefined;
  return {
    issues,
    noteCount: Number.isInteger(fq.vetoCount) && fq.vetoCount >= 0 ? fq.vetoCount : issues.length
  };
}

function buildPlannerPrompt(options) {
  const history = Array.isArray(options.history) ? options.history : [];
  const skillCatalog = Array.isArray(options.availableAgentSkills) ? options.availableAgentSkills : [];
  const actionDefinitions = Array.isArray(options.availableActions) ? options.availableActions : [];
  const showSkillSurface = shouldShowSkillSurface(actionDefinitions);
  const activeSkill = toSkillPromptValue(options.activeAgentSkill, { includeInstructions: true });
  const lastReadSkill = toSkillPromptValue(options.lastReadAgentSkill, { includeInstructions: true });
  const handoffContext = readAgentSkillHandoffContext(options);
  const plannerState = options.plannerState && typeof options.plannerState === "object"
    ? options.plannerState
    : {};
  const virtualWorkspace = options.virtualWorkspace || (options.runState && options.runState.virtualWorkspace);
  const contextSnapshot = readContextSnapshot(options.contextSnapshot)
    || readContextSnapshot(options.request);
  const sessionContext = projectSessionContextFromPlannerState(
    contextSnapshot
      ? projectSessionContextFromSnapshot(contextSnapshot)
      : options.request && options.request.sessionContext,
    plannerState
  );
  const projectionProfile = selectPlannerPromptProjectionProfile(options);
  const toolContext = normalizeToolContext(options.toolContext, projectionProfile.toolContext);
  const actionDescriptions = actionDefinitions
    .map((action) => `- ${action.name}: ${action.description}`)
    .join("\n");
  const historyBlock = history.length === 0
    ? "None"
    : history.map((entry, index) => {
        // GAP 4 — the compacted-observations projection entry renders as its
        // own labelled block so the planner can tell compressed earlier
        // context from verbatim recent steps.
        if (entry && entry.kind === COMPACTED_OBSERVATIONS_KIND) {
          return `Earlier steps (compressed observations):\n${entry.summary}`;
        }
        const summary = entry.summary || entry.actionName || entry.kind || "step";
        return `${index + 1}. ${summary}`;
      }).join("\n");
  const requestPrompt = readString(options.request && options.request.prompt);
  const promptSessionContext = dedupePromptSessionContext(sessionContext, requestPrompt);
  const sessionContextBlock = hasSessionContext(promptSessionContext)
    ? buildSessionContextPromptBlock(
        promptSessionContext,
        "Session evidence to use before deciding:"
      )
    : "";
  const inquiryContext = contextSnapshot
    ? dedupePromptInquiryContext(summarizeInquiryContext(contextSnapshot.inquiryContext), requestPrompt)
    : null;
  const loopState = {
    // ADR-0026 — read-only signal: surfaces { actionName, consecutiveCount,
    // threshold } when the same action has failed in a row, so the AI can
    // switch tactics. Runtime no longer force-finalizes on this.
    actionFailureSignal: summarizeActionFailureSignalForPrompt(options.actionFailureSignal),
    actionGuardrail: summarizeActionGuardrailForPrompt(
      options.actionGuardrail || (options.runState && options.runState.actionGuardrail)
    ),
    plannerInvalidSignal: summarizePlannerInvalidSignalForPrompt(
      options.plannerInvalidSignal || (options.runState && options.runState.plannerInvalidSignal)
    ),
    turnControl: summarizeTurnControlForPrompt(options.turnControl || (options.runState && options.runState.turnControl)),
    readAttemptSignal: SPIKE_STRIP_OODAE_SIGNALS
      ? null
      : sanitizeReadAttemptSignalForPrompt(options.readAttemptSignal),
    qualityContext: SPIKE_WIRE_QUALITYCONTEXT
      ? buildQualityContextForPrompt(options.runState)
      : undefined,
    deniedActions: options.deniedActions || [],
    hasEvidenceSignal: plannerState.hasEvidenceSignal === true,
    hasUserClarification: plannerState.hasUserClarification === true,
    inquiryContext,
    lastResolution: serializePromptValue(plannerState.lastResolution, 500),
    lastObservation: summarizeLastObservationForPrompt(options.lastObservation, projectionProfile.observation),
    planValidationFeedback: summarizePlanValidationFeedbackForPrompt(options.lastObservation),
    pendingClarification: serializePromptValue(plannerState.pendingClarification, 500),
    promptProjection: projectionProfile.summary,
    candidatePathMismatchSignal: summarizeCandidatePathMismatchSignalForPrompt(
      options.candidatePathMismatchSignal || (options.runState && options.runState.candidatePathMismatchSignal)
    ),
      actionPatternConvergence: summarizeActionPatternConvergence(options.actionPatternConvergence || (options.runState && options.runState.actionPatternConvergence)),
      terminalRepairState: summarizeTerminalRepairState(options.terminalRepairState || (options.runState && options.runState.terminalRepairState)),
      invalidActionConvergence: summarizeInvalidActionConvergence(options.invalidActionConvergence || (options.runState && options.runState.invalidActionConvergence)),
      lengthExpansionSignal: summarizeLengthExpansionSignalForPrompt(options.terminalRepairState || (options.runState && options.runState.terminalRepairState)),
      readUrlRecoverySignal: summarizeReadUrlRecoverySignal(options.readUrlRecoverySignal || (options.runState && options.runState.readUrlRecoverySignal)),
    readSources: summarizeReadSources$1(options.readSources || (options.runState && options.runState.researchContext && options.runState.researchContext.readSources), projectionProfile.readSources),
    researchReportLoop: summarizeResearchReportLoop(
      options.researchReportLoop || (options.runState && options.runState.researchReportLoop),
      options.researchEvidenceGraph || (options.runState && options.runState.researchEvidenceGraph),
      options.researchContext || (options.runState && options.runState.researchContext)
    ),
    researchAcceptanceEvaluator: summarizeResearchAcceptanceEvaluator(options.researchAcceptanceEvaluator),
    requirementRecoveryEvaluator: summarizeRequirementRecoveryEvaluator(options.requirementRecoveryEvaluator || (options.runState && options.runState.requirementRecoveryEvaluator)),
    searchResults: summarizeSearchResults(options.searchResults, options.researchContext || (options.runState && options.runState.researchContext), projectionProfile.searchResults),
    virtualWorkspace: summarizeVirtualWorkspace$1(virtualWorkspace)
  };

  if (options.strictRetry === true) {
    loopState.invalidActionCount = options.invalidActionCount || 0;
  }

  if (showSkillSurface) {
    loopState.activeAgentSkill = activeSkill;
    loopState.bundledAgentSkillCount = skillCatalog.length;
    // Use compact catalog (name + description + toolCount only) when no skill
    // is active yet. Full tool schemas are sent only after a skill is selected,
    // via the "Active skill tools" section. This reduces prompt tokens by ~2,500
    // for catalogs with many skills.
    loopState.bundledAgentSkills = activeSkill
      ? skillCatalog.map(toSkillCatalogSummary).filter(Boolean)
      : skillCatalog.map(toSkillCatalogCompact).filter(Boolean);
    loopState.catalogListed = options.catalogListed === true;
    loopState.deniedActions = options.deniedActions || [];
    loopState.handoffContext = handoffContext || null;
    loopState.lastReadAgentSkill = lastReadSkill;
    loopState.toolContext = toolContext;
    loopState.turnCount = options.turnCount || 0;
  }

  const resolvedTodoStateBlock = compactDuplicateTodoStateBlock(
    typeof options.todoStateBlock === "string" ? options.todoStateBlock.trim() : "",
    options.request && options.request.prompt
  );
  const focusedTerminalRepairBlock = buildFocusedTerminalRepairPromptBlock(loopState.terminalRepairState);
  const focusedResearchPhaseBlock = focusedTerminalRepairBlock
    ? ""
    : buildFocusedResearchPhasePromptBlock(loopState, {
        runState: options.runState
      });
  // ADR-0034 — surface the invalid-action convergence observation only
  // when it is active. The block is JSON-only (no MUST/SHOULD/NOW
  // imperatives) and clears automatically once a valid action executes.
  const invalidActionBlock = buildInvalidActionPromptBlock(loopState.invalidActionConvergence);

  return [
    focusedTerminalRepairBlock || null,
    focusedTerminalRepairBlock ? "" : null,
    focusedResearchPhaseBlock || null,
    focusedResearchPhaseBlock ? "" : null,
    invalidActionBlock || null,
    invalidActionBlock ? "" : null,
    `User request: ${options.request.prompt}`,
    (SPIKE_STRIP_OODAE_SIGNALS_WIDE || !sessionContextBlock) ? null : "",
    SPIKE_STRIP_OODAE_SIGNALS_WIDE ? null : (sessionContextBlock || null),
    "",
    "Normalization state:",
    JSON.stringify({
      clarificationStatus: SPIKE_STRIP_OODAE_SIGNALS_WIDE
        ? "none"
        : (readString(plannerState.clarificationStatus) || "none"),
      hasPendingClarification: Boolean(plannerState.pendingClarification),
      evidenceState: SPIKE_STRIP_OODAE_SIGNALS
        ? "none"
        : (readString(plannerState.evidenceState) || "none")
    }, null, 2),
    "",
    "Available actions:",
    actionDescriptions,
    "",
    "Loop state:",
    JSON.stringify(loopState),
    showSkillSurface ? "" : null,
    showSkillSurface ? "Active skill tools:" : null,
    showSkillSurface ? formatActiveSkillTools(options.activeAgentSkill) : null,
    showSkillSurface ? "" : null,
    resolvedTodoStateBlock ? "" : null,
    resolvedTodoStateBlock ? "Plan state:" : null,
    resolvedTodoStateBlock || null,
    "Action history:",
    historyBlock,
    virtualWorkspace ? "" : null,
    virtualWorkspace
        ? buildVirtualWorkspacePromptBlock(virtualWorkspace, {
          ...projectionProfile.virtualWorkspace,
          cyclesUsed: readNullableNumber(options.runState && options.runState.cycleCount),
          cyclesMax: readNullableNumber(options.runState && options.runState.maxSteps),
          terminalRepairState: options.runState && options.runState.terminalRepairState
            ? options.runState.terminalRepairState
            : null,
          publishBlockSignal: options.runState && options.runState.publishBlockSignal
            ? options.runState.publishBlockSignal
            : null
        })
      : null
  ].filter((value) => value !== null).join("\n");
}

// ADR-0026 — Sanitize the action-failure signal before exposing it to the
// planner prompt. Returns null when the signal is missing or malformed,
// or a copy with safe types when valid.
function summarizeActionFailureSignalForPrompt(signal) {
  if (!signal || typeof signal !== "object") return null;
  const actionName = readString(signal.actionName);
  if (!actionName) return null;
  const consecutiveCount = Number.isInteger(signal.consecutiveCount) && signal.consecutiveCount > 0
    ? signal.consecutiveCount
    : 0;
  if (consecutiveCount === 0) return null;
  const threshold = Number.isInteger(signal.threshold) && signal.threshold > 0
    ? signal.threshold
    : null;
  return { actionName, consecutiveCount, threshold };
}

function summarizeCandidatePathMismatchSignalForPrompt(signal) {
  if (!signal || typeof signal !== "object") return null;
  const mismatchKind = readString(signal.mismatchKind);
  const selectedPath = readSafeWorkspacePath(signal.selectedPath);
  if (!mismatchKind || !selectedPath) return null;
  return {
    activePath: readSafeWorkspacePath(signal.activePath) || selectedPath,
    finalizedPath: readSafeWorkspacePath(signal.finalizedPath) || null,
    mismatchKind,
    publishedPath: readSafeWorkspacePath(signal.publishedPath) || null,
    selectedPath,
    status: readString(signal.status) || "observed",
    writtenPath: readSafeWorkspacePath(signal.writtenPath) || null
  };
}

function summarizeActionGuardrailForPrompt(value) {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  if (!state) return null;
  const latest = state.latestDecision && typeof state.latestDecision === "object"
    ? state.latestDecision
    : null;
  if (!latest) return null;
  const action = readString(latest.action);
  const code = readString(latest.code);
  if (!action || action === "allow" || !code) return null;
  return {
    latestDecision: {
      action,
      actionName: readString(latest.actionName) || null,
      code,
      count: Number.isInteger(latest.count) && latest.count > 0 ? latest.count : 0,
      message: readString(latest.message) || null
    }
    };
}

function summarizeLengthExpansionSignalForPrompt(value) {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  const signal = state && state.lengthExpansionSignal && typeof state.lengthExpansionSignal === "object"
    ? state.lengthExpansionSignal
    : null;
  if (!signal) return null;
  const observed = readNumber$4(signal.observed);
  const requested = readNumber$4(signal.requested);
  if (!requested || observed >= requested) return null;
  return {
    kind: readString(signal.kind) || "lengthExpansionSignal",
    observed,
    requested,
    unit: readString(signal.unit) || "words",
    gap: readNumber$4(signal.gap) || Math.max(requested - observed, 0),
    perSectionDelta: Array.isArray(signal.perSectionDelta)
      ? signal.perSectionDelta.map((entry) => ({
        heading: readString(entry && entry.heading).slice(0, 120),
        observed: readNumber$4(entry && entry.observed),
        target: readNumber$4(entry && entry.target),
        gap: readNumber$4(entry && entry.gap)
      })).slice(0, 8)
      : [],
    averageSectionGap: readNumber$4(signal.averageSectionGap),
    iterationCount: readNumber$4(signal.iterationCount)
  };
}

function summarizePlannerInvalidSignalForPrompt(signal) {
  if (!signal || typeof signal !== "object") return null;
  const count = Number.isInteger(signal.count) && signal.count > 0
    ? signal.count
    : 0;
  if (count === 0) return null;
  const summary = {
    active: true,
    count,
    escalation: readString(signal.escalation) === "hard_veto" ? "hard_veto" : "advisory",
    forbiddenMoves: Array.isArray(signal.forbiddenMoves)
      ? signal.forbiddenMoves.map(readString).filter(Boolean).slice(0, 4)
      : [],
    reason: readString(signal.reason) || "invalid_planner_output",
    repairMode: readString(signal.repairMode) || "planner_owned_retry",
    requiredEnvelope: readString(signal.requiredEnvelope) || "valid planner JSON envelope only",
    retryDirective: readString(signal.retryDirective) || "Return one valid planner JSON envelope."
  };
  const source = readString(signal.source);
  if (source) summary.source = source;
  const preview = readString(signal.lastResponsePreview);
  if (preview) summary.lastResponsePreview = preview.slice(0, 300);
  return summary;
}

// ADR-0028 — Sanitize the read-attempt signal before exposing it to the
// planner prompt. Returns null when the signal is missing or malformed,
// or a copy with safe types when valid. Mirrors the action-failure signal
// pattern (ADR-0026): runtime records, AI decides.
function sanitizeReadAttemptSignalForPrompt(signal) {
  if (!signal || typeof signal !== "object") return null;
  const attemptCount = Number.isInteger(signal.attemptCount) && signal.attemptCount > 0
    ? signal.attemptCount
    : 0;
  if (attemptCount === 0) return null;
  const threshold = Number.isInteger(signal.threshold) && signal.threshold > 0
    ? signal.threshold
    : null;
  return { attemptCount, threshold };
}

function compactDuplicateGoalAnchorBlock(goalAnchorBlock, requestPrompt) {
  const block = readString(goalAnchorBlock);
  const requestKey = normalizePromptDuplicateKey$1(requestPrompt);
  if (!block || !requestKey) return block;
  const sections = [];
  const pattern = /(\[[^\]\n]+\]\n)([\s\S]*?)(?=\n\n\[[^\]\n]+\]\n|$)/g;
  let match;
  while ((match = pattern.exec(block)) !== null) {
    const header = match[1];
    const body = readString(match[2]);
    if (!body) continue;
    if (normalizePromptDuplicateKey$1(body) === requestKey) continue;
    sections.push(`${header}${body}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "";
}

function compactDuplicateTodoStateBlock(todoStateBlock, requestPrompt) {
  const block = readString(todoStateBlock);
  const requestKey = normalizePromptDuplicateKey$1(requestPrompt);
  if (!block || !requestKey) return block;
  return block
    .split("\n")
    .map((line) => {
      const match = /^(\s*Goal:\s*)([\s\S]*)$/.exec(line);
      if (!match) return line;
      if (normalizePromptDuplicateKey$1(match[2]) !== requestKey) return line;
      return `${match[1]}same as current user request`;
    })
    .join("\n");
}

function dedupePromptSessionContext(sessionContext, requestPrompt) {
  if (!sessionContext || typeof sessionContext !== "object" || Array.isArray(sessionContext)) {
    return sessionContext;
  }
  const requestKey = normalizePromptDuplicateKey$1(requestPrompt);
  if (!requestKey) return sessionContext;
  const next = { ...sessionContext };
  for (const key of ["activeQuery", "currentGoal", "currentTopic"]) {
    if (normalizePromptDuplicateKey$1(next[key]) === requestKey) {
      delete next[key];
    }
  }
  return next;
}

function dedupePromptInquiryContext(inquiryContext, requestPrompt) {
  if (!inquiryContext || typeof inquiryContext !== "object" || Array.isArray(inquiryContext)) {
    return inquiryContext;
  }
  const requestKey = normalizePromptDuplicateKey$1(requestPrompt);
  if (!requestKey) return inquiryContext;
  const next = { ...inquiryContext };
  for (const key of ["activeGoal", "activeTopic", "activeQuery"]) {
    if (normalizePromptDuplicateKey$1(next[key]) === requestKey) {
      delete next[key];
    }
  }
  return Object.keys(next).length > 0 ? next : null;
}

function normalizePromptDuplicateKey$1(value) {
  return readString(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeToolContext(toolContext, projection = {}) {
  const source = toolContext && typeof toolContext === "object" ? toolContext : {};
  const history = Array.isArray(source.history) ? source.history : [];
  const deduplicated = history.length <= 1;
  const lastResultChars = readPositiveInteger$c(projection.lastResultChars) || (deduplicated ? 2000 : 800);
  const historyEntryChars = readPositiveInteger$c(projection.historyEntryChars) || 500;
  const recentHistoryCount = readPositiveInteger$c(projection.recentHistoryCount) || 3;

  return {
    historyCount: history.length,
    lastResult: serializePromptValue(source.lastResult, lastResultChars),
    recentHistory: deduplicated ? [] : history.slice(-recentHistoryCount).map((entry) => serializePromptValue(entry, historyEntryChars))
  };
}

function summarizeReadSources$1(value, projection = {}) {
  const sources = Array.isArray(value) ? value : [];
  const sourceLimit = readPositiveInteger$c(projection.sourceLimit) || 3;
  const previewChars = readPositiveInteger$c(projection.previewChars) || 220;

  return sources
    .slice(-sourceLimit)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      return {
        error: readString(item.error) || null,
        mode: readString(item.mode) || null,
        ok: item.ok !== false,
        status: typeof item.status === "number" ? item.status : null,
        textPreview: serializePromptValue(readString(item.text), previewChars),
        textRange: summarizeReadSourceTextRange(item.textRange),
        truncated: item.truncated === true,
        url: readString(item.url) || null
      };
    })
    .filter(Boolean);
}

function summarizeReadSourceTextRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    end: readNumber$4(value.end),
    hasAfter: value.hasAfter === true,
    hasBefore: value.hasBefore === true,
    nextTextStart: readNullableNumber(value.nextTextStart),
    start: readNumber$4(value.start),
    totalChars: readNumber$4(value.totalChars)
  };
}

function selectPlannerPromptProjectionProfile(options) {
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : {};
  const cycleCount = readNumber$4(runState.cycleCount);
  if (isHardVetoTerminalRepairPromptState(options && (options.terminalRepairState || runState.terminalRepairState))) {
    return {
      observation: {
        genericOutputChars: 220,
        readUrlPreviewChars: 300,
        searchResults: {
          maxResults: 2,
          snippetChars: 160
        }
      },
      readSources: {
        previewChars: 100,
        sourceLimit: 3
      },
      searchResults: {
        maxResults: 2,
        snippetChars: 160
      },
      summary: {
        mode: "terminal_repair_hard_veto_focused",
        reason: "terminal_repair_hard_veto_requires_contract_projection",
        cycleCount
      },
      toolContext: {
        historyEntryChars: 220,
        lastResultChars: 360,
        recentHistoryCount: 1
      },
      virtualWorkspace: {
        maxFilePreviewChars: 700,
        maxFiles: 3
      }
    };
  }
  const hasLongRunState = hasPromptTodoState(runState.todoState)
    || hasPromptVirtualWorkspace((options && options.virtualWorkspace) || runState.virtualWorkspace)
    || hasPromptSkillState(options && options.activeAgentSkill)
    || hasPromptSkillState(options && options.lastReadAgentSkill);
  if (!hasLongRunState || cycleCount < 6) {
    return {
      observation: {},
      readSources: {},
      searchResults: {},
      summary: {
        mode: "default",
        reason: "early_or_simple_state"
      },
      toolContext: {},
      virtualWorkspace: {}
    };
  }
  return {
    observation: {
      genericOutputChars: 900,
      readUrlPreviewChars: 600,
      searchResults: {
        maxResults: 3,
        snippetChars: 220
      }
    },
    readSources: {
      previewChars: 120,
      sourceLimit: 3
    },
    searchResults: {
      maxResults: 3,
      snippetChars: 220
    },
    summary: {
      mode: "long_run_compact",
      reason: "long_run_state_after_cycle_6",
      cycleCount
    },
    toolContext: {
      historyEntryChars: 320,
      lastResultChars: 600,
      recentHistoryCount: 2
    },
    virtualWorkspace: {
      maxFilePreviewChars: 900,
      maxFiles: 3
    }
  };
}

function buildFocusedTerminalRepairPromptBlock(terminalRepairState) {
  if (!isHardVetoTerminalRepairPromptState(terminalRepairState)) return "";
  const state = terminalRepairState && typeof terminalRepairState === "object" && !Array.isArray(terminalRepairState)
    ? terminalRepairState
    : {};
  const allowedActions = Array.isArray(state.allowedActions)
    ? state.allowedActions.map(readString).filter(Boolean)
    : [];
  const forbiddenLines = [];
  if (!allowedActions.includes("workspace_read")) {
    forbiddenLines.push("workspace_read is FORBIDDEN now because it is not in terminalRepairState.allowedActions.");
  }
  const validPublishContract = state.validPublishContract && typeof state.validPublishContract === "object"
    ? state.validPublishContract
    : {};
    const requiredArgsExample = validPublishContract.requiredArgsExample && typeof validPublishContract.requiredArgsExample === "object"
      ? validPublishContract.requiredArgsExample
      : null;
    const actionOrderingSignals = Array.isArray(state.actionOrderingSignals) ? state.actionOrderingSignals.slice(0, 4) : [];
    const multiWriteSignal = actionOrderingSignals.find((signal) => signal && signal.kind === "multi_write_iteration_nudge");
    const workspaceRepairSignal = state.workspaceRepairSignal && typeof state.workspaceRepairSignal === "object"
      ? state.workspaceRepairSignal
      : null;
    const preferredExpansionActions = multiWriteSignal && Array.isArray(multiWriteSignal.preferredActions)
      ? multiWriteSignal.preferredActions.map(readString).filter((actionName) => allowedActions.includes(actionName))
      : [];
    const primaryAction = workspaceRepairSignal && workspaceRepairSignal.mustInspectCandidate === true && allowedActions.includes("workspace_read")
      ? "workspace_read"
      : preferredExpansionActions[0] ||
      (allowedActions.includes(PUBLISH_DIRECT_ACTION)
        ? PUBLISH_DIRECT_ACTION
        : (allowedActions[0] || null));
    const focused = {
      mode: "terminal_repair_hard_veto_focused",
      active: true,
      escalation: "hard_veto",
      rule: workspaceRepairSignal && workspaceRepairSignal.mustInspectCandidate === true && allowedActions.includes("workspace_read")
        ? "Read the selected candidate first because workspaceRepairSignal says it was not inspected after the latest content change; then choose a targeted repair action."
        : preferredExpansionActions.length > 0
        ? "A length expansion ordering signal is active. Choose one preferred expansion action before limited publish unless recovery is not feasible."
        : allowedActions.includes(PUBLISH_DIRECT_ACTION)
          ? "workspace_publish_candidate is available for valid limited publish with validPublishContract.requiredArgsExample."
          : "Choose one terminalRepairState.allowedActions protocol action; actions outside this list are blocked.",
      primaryAction,
      allowedActions,
      actionOrderingSignals,
      advisoryPersistenceSignal: state.advisoryPersistenceSignal && typeof state.advisoryPersistenceSignal === "object"
        ? state.advisoryPersistenceSignal
        : null,
      forbidden: forbiddenLines,
      activeDeficits: Array.isArray(state.activeDeficits) ? state.activeDeficits.slice(0, 8) : [],
      lengthExpansionSignal: state.lengthExpansionSignal && typeof state.lengthExpansionSignal === "object"
        ? state.lengthExpansionSignal
        : null,
    workspaceRepairSignal,
    patchOperationContract: allowedActions.includes("workspace_propose_patch") ? {
      validShapes: [
        "{type:\"append\",content:\"...\"}",
        "{type:\"insert_after_section\",heading:\"Existing Heading\",content:\"...\"}",
        "{type:\"replace\",find:\"exact current text\",replace:\"new text\",replace_all?:true}",
        "{type:\"normalize_headings\",headings:[{\"lineNumber\":42,\"text\":\"## 4. Unique Heading\"}]}"
      ],
      invalidShape: "{type:\"replace\",content:\"full document\"}",
      recovery: "For duplicate headings or section numbers when length is already satisfied, send exactly one normalize_headings operation with duplicate_heading_context or section_number_repair_context line numbers. If you cannot quote exact current text for replace, use append/insert_after_section when allowed or publish limited with concrete remainingGaps."
    } : null,
    requiredRepair: readString(state.requiredRepair) || null,
    validPublishContract: {
      decision: validPublishContract.decision || "limited",
      evidenceSatisfied: validPublishContract.evidenceSatisfied,
      lengthSatisfied: validPublishContract.lengthSatisfied,
      requirementSatisfied: validPublishContract.requirementSatisfied,
      remainingGaps: validPublishContract.remainingGaps || "non-empty string array with concrete blockers",
      requiredArgsExample
    },
    observationOverride: "Older observations or generic rules that suggest workspace_read/finalize/plain ready do not override this focused hard_veto contract."
  };
  return [
    "Focused terminal repair contract:",
    JSON.stringify(focused, null, 2)
  ].join("\n");
}

function buildFocusedResearchPhasePromptBlock(loopState, options = {}) {
  const state = loopState && typeof loopState === "object" && !Array.isArray(loopState)
    ? loopState
    : {};
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : {};
  const researchReportLoop = state.researchReportLoop && typeof state.researchReportLoop === "object"
    ? state.researchReportLoop
    : null;
  const searchResults = state.searchResults && typeof state.searchResults === "object"
    ? state.searchResults
    : null;
  const readSources = Array.isArray(state.readSources) ? state.readSources : [];
  const virtualWorkspace = state.virtualWorkspace && typeof state.virtualWorkspace === "object"
    ? state.virtualWorkspace
    : null;
  const researchActive = isLongResearchPromptState(runState, researchReportLoop);
  if (!researchActive) return "";

  const candidateUrlCount = readNumber$4(searchResults && searchResults.count);
  const successfulReadUrlCount = countPromptSuccessfulReadSources(readSources, researchReportLoop);
  const searchPassCount = countPromptSearchPasses(researchReportLoop, runState);
  const sourceMinimum = readPromptSourceMinimum(researchReportLoop);
  const sourceMinimumUnmet = isPromptSourceMinimumUnmet(sourceMinimum);
  const hasUnreadCandidate = candidateUrlCount > successfulReadUrlCount;
  const length = readPromptCandidateLength(researchReportLoop, virtualWorkspace);
  const requestedLength = readPromptRequestedLength(researchReportLoop);
  const hasOpenAmbiguity = Boolean(
    state.pendingClarification ||
    (state.inquiryContext && typeof state.inquiryContext === "object" && (
      state.inquiryContext.pendingClarification ||
      readString(state.inquiryContext.openAmbiguity)
    ))
  );
  // AGRUN-246-G (C5.1/C5.2 fix) — removed harness-computed phase + allowedNextMoveHints.
  // AI now sees raw evidence facts and selects its own next action.
  const hasDraft = length.observed > 0;
  // AGRUN-246-E/J — continued-research-thread FACT. Read-only signal that
  // replaced the deleted regex-driven force-finalize bypass
  // (`maybeCreateFinalizeOnlyResearchRecoveryFinal`). It tells the AI the
  // above evidence was carried in from earlier turns of this thread so it can
  // finalize on existing evidence when asked, instead of re-gathering. The
  // runtime never decides finalize-vs-more here — the AI's next action does.
  const continuedThread = detectContinuedResearchThread(runState)
    ? {
      active: true,
      existingReadSources: successfulReadUrlCount,
      searchPassCount,
      stableTopic: readStableResearchTopic(runState) || null,
      choice: "Prior-turn evidence is already available this thread. You may finalize on this existing evidence, gather more, or refine — decide from the user's request; do not re-gather by default."
    }
    : { active: false };
  const contract = {
    mode: "research_phase_contract_focused",
    active: true,
    rule: "Use these as current research facts and choose the next action yourself. Runtime must not write the report or pick sources for you.",
    continuedResearchThread: continuedThread,
    clarificationPolicy: hasOpenAmbiguity
      ? "An open ambiguity is recorded; ask only if it blocks the report scope."
      : "No open ambiguity is recorded. If a term is non-standard or evidence is thin, continue research/drafting and disclose the limitation; do not ask clarification just because coverage is weak.",
    evidenceHandoff: {
      candidateUrlCount,
      searchPassCount,
      successfulReadUrlCount,
      sourceMinimum,
      evidenceStatus: candidateUrlCount > 0 && hasUnreadCandidate && (successfulReadUrlCount === 0 || sourceMinimumUnmet)
        ? "unread candidates available; source minimum not yet met"
        : "evidence-gathering nominal"
    },
    workspaceGrowth: {
      candidatePath: length.path,
      observedLength: length.observed,
      requestedLength: requestedLength.value,
      unit: requestedLength.unit,
      draftStatus: !hasDraft
        ? "no_draft_yet"
        : requestedLength.value > 0 && length.observed < requestedLength.value
          ? "draft_exists_below_target"
          : "draft_at_or_above_target"
    },
    reportWritingProtocol: buildResearchReportWritingProtocol({
      hasDraft,
      observedLength: length.observed,
      readSourceCount: successfulReadUrlCount,
      requestedLength: requestedLength.value,
      unit: requestedLength.unit
    }),
    forbiddenWhenNoOpenAmbiguity: hasOpenAmbiguity ? [] : ["ask_clarification"]
  };
  return [
    "Focused research phase contract:",
    JSON.stringify(contract, null, 2)
  ].join("\n");
}

function isLongResearchPromptState(runState, researchReportLoop, searchResults) {
  // AGRUN-313 P2e/H2 — read the requiresEvidenceConvergence capability via
  // isEvidenceConvergenceRun instead of a hardcoded skill-name list. This was the
  // SECOND L1 name list (the first was removed from research-state.js in P2c).
  // isEvidenceConvergenceRun reads the capability off the engaged skill object —
  // so the kernel keeps no skill names. The legacy persisted mode flag was removed
  // in H2; activation is now SOLELY capability-driven. In production selectedSkill
  // is always co-populated with a capability-bearing agentSkillContext object
  // (see action-loop-action.js).
  if (isEvidenceConvergenceRun(runState)) return true;
  if (isPromptResearchReportLoopActive(researchReportLoop)) return true;
  return false;
}

// AGRUN-246-G (C5 fix) — removed phase-dependent nextWritingMove prescription.
// growthRule no longer names specific workspace tools; AI selects repair action.
function buildResearchReportWritingProtocol(facts) {
  const hasDraft = Boolean(facts && facts.hasDraft);
  const observed = readNumber$4(facts && facts.observedLength);
  const requested = readNumber$4(facts && facts.requestedLength);
  const unit = readString(facts && facts.unit) || "words";
  const remaining = requested > 0 ? Math.max(requested - observed, 0) : 0;
  const base = {
    sourceOrder: "web_search finds leads; read_url creates evidence; write from read evidence, not search snippets alone.",
    indexFirst: "After useful reads, create or update outline.md with section titles and source URLs before drafting.",
    drafting: "Write real user-facing prose into draft.md/final_candidate.md. Do not write promises, placeholders, or summaries of what you will write later.",
    growthRule: "After a draft exists, deepen its existing sections with real source-grounded content. Do not add renamed duplicate sections to inflate length."
  };
  if (hasDraft && remaining > 0) {
    return {
      ...base,
      remainingLength: remaining,
      remainingLengthUnit: unit,
      remainingNote: `${remaining} ${unit} figure is an observation of remaining scope, not a target to pad toward — if genuine material runs out, publish a limited result honestly.`
    };
  }
  return base;
}

function isPromptResearchReportLoopActive(researchReportLoop) {
  const loop = researchReportLoop && typeof researchReportLoop === "object"
    ? researchReportLoop
    : null;
  if (!loop) return false;
  const status = readString(loop.status);
  if (status && status !== "idle" && status !== "none") return true;
  if (loop.acceptancePacket && typeof loop.acceptancePacket === "object") return true;
  if (loop.gateSignal && typeof loop.gateSignal === "object" && (
    readString(loop.gateSignal.status) ||
    readString(loop.gateSignal.finalMode)
  )) return true;
  if (Array.isArray(loop.evidenceGaps) && loop.evidenceGaps.length > 0) return true;
  if (Array.isArray(loop.recentSearches) && loop.recentSearches.length > 0) return true;
  return false;
}

function countPromptSuccessfulReadSources(readSources, researchReportLoop) {
  const direct = readSources.filter((source) => source && source.ok !== false).length;
  const packetCount = readNumber$4(
    researchReportLoop &&
    researchReportLoop.acceptancePacket &&
    researchReportLoop.acceptancePacket.evidence &&
    researchReportLoop.acceptancePacket.evidence.successfulReadUrlCount
  );
  const sourceMinimumReads = readNumber$4(
    researchReportLoop &&
    researchReportLoop.sourceMinimum &&
    researchReportLoop.sourceMinimum.reads
  );
  return Math.max(direct, packetCount, sourceMinimumReads);
}

function countPromptSearchPasses(researchReportLoop, runState) {
  const recent = researchReportLoop && Array.isArray(researchReportLoop.recentSearches)
    ? researchReportLoop.recentSearches.length
    : 0;
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const passes = Array.isArray(context.searchPasses) ? context.searchPasses.length : 0;
  return Math.max(recent, passes);
}

function readPromptCandidateLength(researchReportLoop, virtualWorkspace) {
  const packetCandidate = researchReportLoop &&
    researchReportLoop.acceptancePacket &&
    researchReportLoop.acceptancePacket.candidate &&
    typeof researchReportLoop.acceptancePacket.candidate === "object"
    ? researchReportLoop.acceptancePacket.candidate
    : {};
  const packetStats = packetCandidate.textStats || {};
  const packetWords = readNumber$4(packetStats.words);
  if (packetWords > 0) {
    return {
      observed: packetWords,
      path: readString(packetCandidate.path) || "final_candidate.md",
      unit: "words"
    };
  }
  const files = virtualWorkspace && Array.isArray(virtualWorkspace.files)
    ? virtualWorkspace.files
    : [];
  const finalFile = files.find((file) => readString(file && file.path) === "final_candidate.md") || files[0] || {};
  const stats = finalFile.textStats && typeof finalFile.textStats === "object" ? finalFile.textStats : {};
  return {
    observed: readNumber$4(stats.words),
    path: readString(finalFile.path) || null,
    unit: "words"
  };
}

function readPromptRequestedLength(researchReportLoop) {
  const requested = researchReportLoop &&
    researchReportLoop.acceptancePacket &&
    researchReportLoop.acceptancePacket.requestedLength &&
    typeof researchReportLoop.acceptancePacket.requestedLength === "object"
    ? researchReportLoop.acceptancePacket.requestedLength
    : {};
  return {
    unit: readString(requested.unit) || "words",
    value: readNumber$4(requested.value)
  };
}


function readPromptSourceMinimum(researchReportLoop) {
  const direct = researchReportLoop && researchReportLoop.sourceMinimum && typeof researchReportLoop.sourceMinimum === "object"
    ? researchReportLoop.sourceMinimum
    : null;
  const packet = researchReportLoop &&
    researchReportLoop.acceptancePacket &&
    researchReportLoop.acceptancePacket.evidence &&
    researchReportLoop.acceptancePacket.evidence.sourceMinimum &&
    typeof researchReportLoop.acceptancePacket.evidence.sourceMinimum === "object"
    ? researchReportLoop.acceptancePacket.evidence.sourceMinimum
    : null;
  const source = direct || packet;
  if (!source) return null;
  return {
    minReadSources: readNumber$4(source.minReadSources) || readNumber$4(source.minReads),
    minRelevantSources: readNumber$4(source.minRelevantSources) || readNumber$4(source.minRelevant),
    passed: source.passed === true,
    readSources: readNumber$4(source.readSources) || readNumber$4(source.reads),
    relevantSources: readNumber$4(source.relevantSources) || readNumber$4(source.relevant)
  };
}

function isPromptSourceMinimumUnmet(sourceMinimum) {
  if (!sourceMinimum || sourceMinimum.passed === true) return false;
  return Boolean(
    (sourceMinimum.minReadSources > 0 && sourceMinimum.readSources < sourceMinimum.minReadSources) ||
    (sourceMinimum.minRelevantSources > 0 && sourceMinimum.relevantSources < sourceMinimum.minRelevantSources)
  );
}

function isHardVetoTerminalRepairPromptState(value) {
  const allowedActions = value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.allowedActions)
    ? value.allowedActions.map(readString).filter(Boolean)
    : [];
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.active === true &&
    (
      readString(value.escalation) === "hard_veto" ||
      (
        allowedActions.length === 1 &&
        allowedActions[0] === PUBLISH_DIRECT_ACTION
      )
    )
  );
}

function hasPromptTodoState(todoState) {
  return Boolean(
    todoState
    && typeof todoState === "object"
    && Array.isArray(todoState.items)
    && todoState.items.length > 0
    && todoState.status !== "completed"
    && todoState.status !== "abandoned"
    // 2026-05-11 — `terminatedAt` is added by
    // `observeTodoStateOnTerminal` to preserve the audit snapshot on
    // the thread record without re-steering the next turn's planner.
    // Treat the annotation as terminal here so the projection profile
    // does not classify the run as "long-run state" based on a Todo
    // that already terminated.
    && todoState.terminatedAt == null
  );
}

function hasPromptVirtualWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return false;
  const files = workspace.files && typeof workspace.files === "object" && !Array.isArray(workspace.files)
    ? workspace.files
    : {};
  return Object.values(files).some((file) => readString(file && file.content));
}

function hasPromptSkillState(value) {
  return Boolean(value && typeof value === "object" && readString(value.name));
}

function readAgentSkillHandoffContext(options) {
  const direct = readString(options && options.handoffContext);
  if (direct) return direct;
  const runState = options && options.runState && typeof options.runState === "object"
    ? options.runState
    : {};
  const context = runState.agentSkillContext && typeof runState.agentSkillContext === "object"
    ? runState.agentSkillContext
    : {};
  return readString(context.handoffContext);
}

function summarizeResearchReportLoop(loopValue, graphValue, contextValue) {
  const loop = loopValue && typeof loopValue === "object" && !Array.isArray(loopValue)
    ? loopValue
    : null;
  const graph = graphValue && typeof graphValue === "object" && !Array.isArray(graphValue)
    ? graphValue
    : null;
  const context = contextValue && typeof contextValue === "object" && !Array.isArray(contextValue)
    ? contextValue
    : {};
  if (!loop && !graph) return null;

  const sourceMinimum = loop && loop.sourceMinimum && typeof loop.sourceMinimum === "object"
    ? loop.sourceMinimum
    : null;
  const authorityCoverage = (loop && loop.authorityCoverage && typeof loop.authorityCoverage === "object"
    ? loop.authorityCoverage
    : null) || (graph && graph.authorityCoverage && typeof graph.authorityCoverage === "object"
      ? graph.authorityCoverage
      : null);
  // AGRUN-217 / ADR-0012 — `loop.coverageTargets` was deleted with the
  // runtime action-selection path. The AI / `long-web-research` skill
  // reads `gateSignal.evidenceGaps` + `authorityStatus` directly to
  // decide its next move; the planner prompt no longer projects a
  // coverage-target table.
  const coverageTargets = [];
  const evidenceGaps = Array.isArray(graph && graph.evidenceGaps)
    ? graph.evidenceGaps.map(readString).filter(Boolean).slice(0, 8)
    : [];
  const searchPasses = Array.isArray(context.searchPasses) ? context.searchPasses : [];
  const recentSearches = searchPasses.slice(-8).map((pass) => ({
    count: typeof pass.count === "number" ? pass.count : null,
    kind: readString(pass.kind) || null,
    query: readString(pass.query),
    status: pass.status == null ? null : String(pass.status)
  })).filter((pass) => pass.query);
  const zeroResultQueries = Array.from(new Set(
    searchPasses
      .filter((pass) => readNumber$4(pass && pass.count) === 0)
      .map((pass) => readString(pass && pass.query))
      .filter(Boolean)
  )).slice(-6);
  const gateSignal = loop && loop.gateSignal && typeof loop.gateSignal === "object"
    ? loop.gateSignal
    : null;
  const acceptancePacket = summarizeAcceptancePacketForPrompt(
    gateSignal && gateSignal.acceptancePacket
  );

  return {
    status: readString(loop && loop.status) || null,
    finalMode: readString(loop && loop.finalMode) || null,
    sourceMinimum: sourceMinimum ? {
      passed: sourceMinimum.passed === true,
      reads: readNumber$4(sourceMinimum.readSources),
      minReads: readNumber$4(sourceMinimum.minReadSources),
      relevant: readNumber$4(sourceMinimum.relevantSources),
      minRelevant: readNumber$4(sourceMinimum.minRelevantSources)
    } : null,
    authorityCoverage: authorityCoverage ? {
      passed: authorityCoverage.passed === true,
      hasPrimaryOrOfficial: authorityCoverage.hasPrimaryOrOfficial === true,
      hasIndependent: authorityCoverage.hasIndependent === true
    } : null,
    coverageTargets,
    evidenceGaps,
    acceptancePacket,
    gateSignal: gateSignal ? {
      finalMode: readString(gateSignal.finalMode) || null,
      status: readString(gateSignal.status) || null
    } : null,
    recentSearches,
    zeroResultQueries,
    nextMoveContract: [
      "Use this as state, not as a script.",
      "Use the loaded skill workflow to decide the next action from these facts.",
      "Match finalReadiness to acceptancePacket facts: if observedLength is below requestedLength, lengthSatisfied=false; if researchFinalAllowed=false or sourceMinimum.passed=false, gather more evidence or use decision=limited with concrete remainingGaps.",
      "Do not repeat zeroResultQueries.",
      "If you choose to stop, finalize honestly with limitations you own."
    ].join(" ")
  };
}

function summarizeAcceptancePacketForPrompt(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return null;
  const candidate = packet.candidate && typeof packet.candidate === "object" ? packet.candidate : {};
  const evidence = packet.evidence && typeof packet.evidence === "object" ? packet.evidence : {};
  const sourceMinimum = evidence.sourceMinimum && typeof evidence.sourceMinimum === "object"
    ? evidence.sourceMinimum
    : null;
  const publish = packet.publish && typeof packet.publish === "object" ? packet.publish : null;
  return {
    candidate: {
      lastRead: candidate.lastRead && typeof candidate.lastRead === "object" ? {
        path: readString(candidate.lastRead.path) || null,
        textStats: summarizePromptTextStats(candidate.lastRead.textStats)
      } : null,
      path: readString(candidate.path) || null,
      ready: candidate.ready === true,
      textStats: summarizePromptTextStats(candidate.textStats)
    },
    cycles: packet.cycles && typeof packet.cycles === "object" ? {
      max: readNullableNumber(packet.cycles.max),
      remaining: readNullableNumber(packet.cycles.remaining),
      used: readNumber$4(packet.cycles.used)
    } : null,
    evidence: {
      researchFinalAllowed: evidence.researchFinalAllowed === true,
      researchFinalReason: readString(evidence.researchFinalReason) || null,
      researchGaps: Array.isArray(evidence.researchGaps)
        ? evidence.researchGaps.map(readString).filter(Boolean).slice(0, 8)
        : [],
      sourceMinimum: sourceMinimum ? {
        minReadSources: readNumber$4(sourceMinimum.minReadSources),
        minRelevantSources: readNumber$4(sourceMinimum.minRelevantSources),
        passed: sourceMinimum.passed === true,
        readSources: readNumber$4(sourceMinimum.readSources),
        relevantSources: readNumber$4(sourceMinimum.relevantSources)
      } : null,
      successfulReadUrlCount: readNumber$4(evidence.successfulReadUrlCount)
    },
    observedLength: readNullableNumber(packet.observedLength),
    publish: publish ? {
      count: readNumber$4(publish.count),
      cyclesRemaining: readNullableNumber(publish.cyclesRemaining),
      lastStatus: readString(publish.lastStatus) || null
    } : null,
    recentSearch: packet.recentSearch && typeof packet.recentSearch === "object" ? {
      lastSearchAttempt: packet.recentSearch.lastSearchAttempt || null,
      recentQueries: Array.isArray(packet.recentSearch.recentQueries)
        ? packet.recentSearch.recentQueries.map(readString).filter(Boolean).slice(-5)
        : []
    } : null,
    requestedLength: packet.requestedLength && typeof packet.requestedLength === "object" ? {
      statsKey: readString(packet.requestedLength.statsKey) || null,
      unit: readString(packet.requestedLength.unit) || null,
      value: readNumber$4(packet.requestedLength.value)
    } : null,
    status: readString(packet.status) || null,
    updatedBy: readString(packet.updatedBy) || null
  };
}

function summarizeVirtualWorkspace$1(value) {
  if (!value || typeof value !== "object" || value.enabled !== true) {
    return null;
  }
  const files = value.files && typeof value.files === "object" && !Array.isArray(value.files)
    ? value.files
    : {};
  const quality = value.quality && typeof value.quality === "object" ? value.quality : {};
  const lifecycle = value.candidateLifecycle && typeof value.candidateLifecycle === "object"
    ? value.candidateLifecycle
    : null;
  const pendingPatch = value.pendingPatch && typeof value.pendingPatch === "object" ? value.pendingPatch : null;
  const checks = Array.isArray(quality.checks)
    ? quality.checks.map((check) => ({
      code: readString(check && check.code),
      reason: readString(check && check.reason),
      status: readString(check && check.status)
    })).filter((check) => check.code || check.status || check.reason).slice(0, 12)
    : [];
  return {
    candidateLifecycle: lifecycle ? {
      activePath: readSafeWorkspacePath(lifecycle.activePath) || "final_candidate.md",
      draftPaths: Array.isArray(lifecycle.draftPaths) ? lifecycle.draftPaths.map(readSafeWorkspacePath).filter(Boolean).slice(0, 12) : [],
      finalizedPath: readSafeWorkspacePath(lifecycle.finalizedPath) || null,
      lastReadPath: readSafeWorkspacePath(lifecycle.lastReadPath) || null,
      lastWrittenPath: readSafeWorkspacePath(lifecycle.lastWrittenPath) || null,
      publishedPath: readSafeWorkspacePath(lifecycle.publishedPath) || null,
      status: readString(lifecycle.status) || "idle"
    } : null,
    candidatePathMismatchSignal: summarizeCandidatePathMismatchSignalForPrompt(value.candidatePathMismatchSignal),
    enabled: true,
    files: Object.entries(files).map(([path, file]) => ({
      hasContent: readString(file && file.content).length > 0,
      path,
      size: readString(file && file.content).length,
      textStats: summarizePromptTextStats(file && file.textStats, file && file.content),
      version: typeof (file && file.version) === "number" ? file.version : 0
    })),
    finalCandidateReady: quality.finalCandidateReady === true,
    mode: readString(value.mode) || "complex_response",
    operationCount: Array.isArray(value.operations) ? value.operations.length : 0,
    pendingPatch: pendingPatch ? {
      deltaWords: readNumber$4(pendingPatch.deltaWords),
      patchId: readString(pendingPatch.patchId) || null,
      path: readString(pendingPatch.path) || null,
      riskFlags: Array.isArray(pendingPatch.riskFlags) ? pendingPatch.riskFlags.map(readString).filter(Boolean).slice(0, 8) : [],
      status: readString(pendingPatch.status) || null,
      valid: pendingPatch.valid === true
    } : null,
    qualityChecks: checks,
    qualityStatus: readString(quality.status) || "needs_draft"
  };
}

function readNumber$4(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readSafeWorkspacePath(value) {
  const path = readString(value);
  if (!path || path.startsWith("/") || path.includes("..") || /[\\]/.test(path)) return "";
  return path;
}

function readNullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPositiveInteger$c(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function summarizePromptTextStats(stats, fallbackContent) {
  const source = stats && typeof stats === "object" ? stats : null;
  if (source) {
    return {
      chars: readNumber$4(source.chars),
      cjkChars: readNumber$4(source.cjkChars),
      nonWhitespaceChars: readNumber$4(source.nonWhitespaceChars),
      words: readNumber$4(source.words)
    };
  }
  const text = readString(fallbackContent);
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

export { buildEnvelopeLines, buildGuidanceLines, buildPlannerPrompt, buildPlannerSystemPrompt, buildSystemPromptLines };
