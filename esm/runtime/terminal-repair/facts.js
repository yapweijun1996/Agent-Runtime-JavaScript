import { countSuccessfulReadUrlArtifacts } from '../final-readiness.js';
import { readCycleBudgetState } from '../cycle-budget.js';
import { CANDIDATE_QUALITY_BLOCKED_REASON } from '../kernel-terminal-actions.js';
import { normalizeCandidateQualitySignal } from '../candidate-quality-signal.js';
import { inspectWorkspacePublishProtocol } from '../virtual-workspace.js';
import { readString, readRecord, readNumber, normalizeStructureSamples, readStringArray, isTerminalAttempt, readCandidateStatsFromWorkspace, readFinalCandidatePathFromWorkspace, normalizeReadinessIssues, normalizeUrlKey, readCandidateUrl } from './internal-utils.js';

// H10 split, Step 3 (AGRUN-505) — terminal-repair observable deficit facts.
// VERBATIM moves from terminal-repair-state.js (see
// agrun_docs/terminal-repair-split-design-2026-06-12.md). readRepairFacts is
// the coordinator that assembles every observable deficit (source minimum,
// citation quality, length, structure, guardrail blocks, todo, readiness,
// budget) into the repair-facts record evaluateTerminalRepairState consumes.
// One function here is PUBLIC API, re-exported through the barrel:
// isOutputGuardrailStructureBlock. NOTE (design-doc amendment): facts is
// extracted BEFORE signals because signals depends on readAcceptancePacket /
// readSourceMinimum from this module — the import graph must stay acyclic.

// AGRUN-510 (audit M13 follow-up) — the five packet/minimum/length/structure/
// todo reads are shared with createProgressSnapshot (core.js), which
// evaluateTerminalRepairState calls in the SAME pass. This bundle lets the
// caller compute them once and thread them through both, instead of each
// function re-deriving identical pure reads. All reads are pure (no runState
// mutation), so precomputing is behavior-identical.
function readSharedRepairFactReads(runState) {
  const packet = readAcceptancePacket$2(runState);
  return {
    packet,
    sourceMinimum: readSourceMinimum$2(runState, packet),
    lengthStatus: readLengthStatus(packet, runState),
    structure: readStructureStatus(runState),
    todo: readTodoStatus(runState)
  };
}

function readRepairFacts(runState, context, sharedReads) {
  const reads = sharedReads || readSharedRepairFactReads(runState);
  const packet = reads.packet;
  const sourceMinimum = reads.sourceMinimum;
  const lengthStatus = reads.lengthStatus;
  const structure = reads.structure;
  const todo = reads.todo;
  const actionName = readString(context && context.actionName);
  const actionPattern = readRecord(runState && runState.actionPatternConvergence);
  const correction = readRecord(actionPattern && actionPattern.terminalCorrectionState);
  const cooldown = readRecord(actionPattern && actionPattern.terminalRetryCooldown);
  const readOnlyPlanning = readRecord(actionPattern && actionPattern.readOnlyPlanningState);
  const output = readRecord(context && context.output);
  const outputGuardrailBlocked = readString(output && output.status) === "output_guardrail_blocked";
  const outputGuardrailBlock = readOutputGuardrailBlock(output);
  const publishBlocked = readString(output && output.kind) === "virtual_workspace_publish_blocked" ||
    readString(output && output.kind) === "terminal_correction_preflight_block" ||
    readString(output && output.kind) === "terminal_repair_preflight_block";
  const readinessBlocked = isReadinessRepairOutput(output);
  const deficits = [];
  const observableDeficits = {
    length: null,
    readiness: null,
    source: null,
    structure: null,
    todo: null
  };
  const candidateQualityCitationDeficit = buildCandidateQualityCitationDeficit(
    readCandidateQualitySignal(runState, output),
    runState
  );

  if (sourceMinimum && sourceMinimum.passed !== true) {
    const readSourceDeficit = Math.max(readNumber(sourceMinimum.minReadSources) - readNumber(sourceMinimum.readSources), 0);
    const relevantSourceDeficit = Math.max(readNumber(sourceMinimum.minRelevantSources) - readNumber(sourceMinimum.relevantSources), 0);
    if (readSourceDeficit > 0 || relevantSourceDeficit > 0) {
      deficits.push("source");
      observableDeficits.source = {
        minReadSources: readNumber(sourceMinimum.minReadSources),
        minRelevantSources: readNumber(sourceMinimum.minRelevantSources),
        readSourceDeficit,
        readSources: readNumber(sourceMinimum.readSources),
        relevantSourceDeficit,
        relevantSources: readNumber(sourceMinimum.relevantSources),
        successfulReadUrlCount: readSuccessfulReadUrlCount$2(runState, packet)
      };
    }
  }
  if (candidateQualityCitationDeficit) {
    if (!deficits.includes("source")) deficits.push("source");
    observableDeficits.source = mergeSourceDeficit(observableDeficits.source, candidateQualityCitationDeficit);
  }

  // Length remains an observable fact rather than a content-authored runtime
  // rewrite. AGRUN-249 uses this signal to shape the recovery action surface
  // while the AI still writes every expansion.
  if (lengthStatus && lengthStatus.requested > 0 && lengthStatus.observed < lengthStatus.requested) {
    const alternativeCandidate = findWorkspaceLengthCandidate(
      runState,
      lengthStatus.statsKey,
      lengthStatus.requested,
      lengthStatus.observed,
      lengthStatus.path
    );
    observableDeficits.length = {
      observed: lengthStatus.observed,
      requested: lengthStatus.requested,
      unit: lengthStatus.unit,
      deficit: Math.max(lengthStatus.requested - lengthStatus.observed, 0),
      alternativeCandidate
    };
  }

  // AGRUN-244 Phase 3 — structure is likewise display-only, not a deficit. The
  // literal duplicate-heading checker is gameable (renamed duplicates evade it)
  // and Phase 2 runs fired it every cycle with zero effect. The AI sees the
  // structure observation and decides; the runtime does not force repair.
  if (structure && structure.ok === false) {
    observableDeficits.structure = {
      issueCodes: readStringArray(structure.issueCodes).slice(0, 8),
      reason: readString(structure.reason) || readString(structure.status) || "structure_not_ready",
      repeatedHeadingSamples: normalizeStructureSamples(structure.repeatedHeadingSamples, "heading"),
      repeatedNumberSamples: normalizeStructureSamples(structure.repeatedNumberSamples, "number"),
      status: readString(structure.status) || "fail"
    };
  }

  if (outputGuardrailBlocked && isOutputGuardrailStructureBlock(outputGuardrailBlock)) {
    deficits.push("structure");
    observableDeficits.structure = mergeOutputGuardrailStructureDeficit(
      observableDeficits.structure,
      outputGuardrailBlock
    );
  }

  if (todo.unfinishedCount > 0) {
    deficits.push("todo");
    observableDeficits.todo = todo;
  }

  // F8 (2026-06-10) — premature-finalize bypass. The packet-based facts above
  // (sourceMinimum, lengthStatus) only exist once the research report loop has
  // engaged, so a planner `finalize` BEFORE any workspace work saw zero
  // deficits and sailed through maybeBlockDirectTerminalDuringRepair,
  // terminating a convergence task with an empty candidate (observed 2/2 on
  // deepseek-v4-flash high effort: search -> read_url -> finalize at cycle 3).
  // The requirementRecoveryEvaluator already tracks the SAME contract
  // packet-independently (prompt-extracted requested length, workspace
  // candidate stats, recovery budget) and is refreshed on both dispatch paths,
  // so on a terminal attempt we adopt its recoverable deficits as repair
  // facts. Narrow by design: only `validLimitedAllowed === false` (recovery
  // budget remains) counts — once recovery is exhausted the evaluator opens
  // honest-limited and this gate stays out of the way. Existing escalation
  // (ignoredCount -> hard_veto -> escape valves) bounds repeat offenders.
  const terminalRequirementRecovery = isTerminalAttempt(actionName, context)
    ? readTerminalRequirementRecoveryFacts(runState)
    : null;
  if (terminalRequirementRecovery) {
    for (const dimension of terminalRequirementRecovery.dimensions) {
      if (!deficits.includes(dimension)) deficits.push(dimension);
    }
    if (terminalRequirementRecovery.length && !observableDeficits.length) {
      observableDeficits.length = terminalRequirementRecovery.length;
    }
    if (terminalRequirementRecovery.source && !observableDeficits.source) {
      observableDeficits.source = terminalRequirementRecovery.source;
    }
  }

  if (readinessBlocked && !deficits.includes("readiness")) {
    deficits.push("readiness");
    observableDeficits.readiness = readReadinessDeficit(output);
  }

  if ((correction && correction.active === true) || (cooldown && cooldown.active === true)) {
    deficits.push("terminal_loop");
  }

  const finalizedStructureBlocked = structure && structure.ok === false && isFinalizedCandidateSelected(runState);
  const readOnlyPlanningActive = readOnlyPlanning && readOnlyPlanning.active === true;
  const outputRepairReason = readOutputRepairReason(output);
  const structureRepairReason = (finalizedStructureBlocked || (outputGuardrailBlocked && observableDeficits.structure)) && (
    !outputRepairReason || outputRepairReason.includes("readiness")
  )
    ? "finalized_candidate_structure_not_ready"
    : null;

  const activeDeficits = Array.from(new Set(deficits)).slice(0, 8);
  const budgetState = readBudgetState$1(runState, context);
  const budgetConstrained = budgetState === "low" || budgetState === "exhausted";
  const proactiveBudgetRepair = budgetConstrained &&
    activeDeficits.length > 0 &&
    shouldProactivelyActivateBudgetRepair(lengthStatus);
  const todoOnlyTerminalAttempt = isTerminalAttempt(actionName, context) &&
    activeDeficits.includes("todo") &&
    !activeDeficits.some((name) => name === "source" || name === "length" || name === "structure");
  return {
    activeDeficits,
    budgetState,
    forceActive: publishBlocked ||
      Boolean(candidateQualityCitationDeficit) ||
      Boolean(terminalRequirementRecovery) ||
      todoOnlyTerminalAttempt ||
      finalizedStructureBlocked ||
      proactiveBudgetRepair ||
      (readOnlyPlanningActive && activeDeficits.length > 0) ||
      (correction && correction.active === true) ||
      (cooldown && cooldown.active === true),
    observableDeficits,
    reason: structureRepairReason ||
      outputRepairReason ||
      (candidateQualityCitationDeficit ? CANDIDATE_QUALITY_BLOCKED_REASON : null) ||
      readString(correction && correction.reason) ||
      readString(cooldown && cooldown.reason) ||
      (finalizedStructureBlocked ? "finalized_candidate_structure_not_ready" : null) ||
      (proactiveBudgetRepair ? `${budgetState}_budget_with_observable_deficits` : null) ||
      (readOnlyPlanningActive && activeDeficits.length > 0 ? "read_only_planning_with_observable_deficits" : null) ||
      (terminalRequirementRecovery ? "terminal_attempt_with_recoverable_requirement_deficits" : null) ||
      (todoOnlyTerminalAttempt ? "todo_state_not_synced" : null) ||
      (activeDeficits.length > 0 ? "observable_deficits_block_terminal_ready" : null)
  };
}

// AGRUN-404 — the proactive budget-repair branch (forceActive under a
// constrained budget BEFORE any terminal attempt) is INTENTIONALLY scoped to
// long-form tasks via this length-target gate. It is NOT an oversight that
// source/structure/todo deficits WITHOUT a length target don't proactively
// repair:
//   - Length is the budget-SENSITIVE dimension. A long-form task already behind
//     on length under low budget should enter repair early, because every
//     remaining cycle must go to expansion or the output ships too short.
//   - SHORT-FORM tasks (no length target) reach activation through the OTHER
//     deficit dimensions' terminal-attempt-REACTIVE branches instead
//     (terminalRequirementRecovery for source, todoOnlyTerminalAttempt for todo,
//     finalizedStructureBlocked for structure — all in readRepairFacts above).
//     Reactive-on-attempt is the correct timing there: it lets the AI reach a
//     finalize and then either recover OR open honest-limited, rather than being
//     proactively trapped in repair while it could still legitimately finalize
//     with limitations under a tight budget.
// Removing this gate would force proactive repair on short-form runs and risk
// repair-churn / blocked honest-limited finalization. (Length itself is
// observable-only — it is never pushed to activeDeficits; see readRepairFacts.)
// Pinned by terminal-repair-budget-proactive.test.js.
function shouldProactivelyActivateBudgetRepair(lengthStatus) {
  return Boolean(lengthStatus && lengthStatus.requested > 0);
}

// F8 — adopt the requirementRecoveryEvaluator's recoverable deficits as repair
// facts for a terminal attempt. The evaluator is refreshed by both dispatch
// paths after every evidence/workspace action, so at finalize-decision time it
// is at most one action stale. Returns null unless the evaluator explicitly
// says honest-limited is NOT yet allowed (recovery budget remains), keeping
// this gate inert for chat tasks, satisfied contracts, and exhausted budgets.
function readTerminalRequirementRecoveryFacts(runState) {
  const evaluator = readRecord(runState && runState.requirementRecoveryEvaluator);
  if (!evaluator || evaluator.validLimitedAllowed !== false) return null;
  const entries = Array.isArray(evaluator.recoverableDeficits) ? evaluator.recoverableDeficits : [];
  const dimensions = Array.from(new Set(
    entries
      .map((entry) => readString(entry && entry.dimension))
      .filter((dimension) => dimension === "length" || dimension === "source")
  ));
  if (dimensions.length === 0) return null;
  const observed = readRecord(evaluator.lastObservableDeficits) || {};
  const lengthRequested = readNumber(observed.lengthRequested);
  const lengthObserved = readNumber(observed.lengthObserved);
  const length = dimensions.includes("length")
    ? {
        observed: lengthObserved,
        requested: lengthRequested,
        unit: readString(observed.lengthUnit) || "words",
        deficit: Math.max(lengthRequested - lengthObserved, 0),
        alternativeCandidate: null
      }
    : null;
  const sourceEntry = entries.find((entry) => readString(entry && entry.dimension) === "source") || null;
  const sourceObserved = readRecord(sourceEntry && sourceEntry.observed) || {};
  const sourceTarget = readRecord(sourceEntry && sourceEntry.target) || {};
  const source = dimensions.includes("source")
    ? {
        minReadSources: readNumber(sourceTarget.minReadSources),
        minRelevantSources: readNumber(sourceTarget.minRelevantSources),
        readSourceDeficit: readNumber(observed.readSourceDeficit),
        readSources: readNumber(sourceObserved.readSources),
        relevantSourceDeficit: readNumber(observed.relevantSourceDeficit),
        relevantSources: readNumber(sourceObserved.relevantSources),
        successfulReadUrlCount: readSuccessfulReadUrlCount$2(runState, readAcceptancePacket$2(runState))
      }
    : null;
  return { dimensions, length, source };
}

function readReadinessDeficit(output) {
  const result = readRecord(output) || {};
  const audit = readRecord(result.readinessAudit);
  const issues = normalizeReadinessIssues(audit && audit.issues);
  return {
    kind: "readiness_payload_deficit",
    issues,
    message: readString((audit && audit.message) || result.message) || null,
    status: readString(result.status) || readString(audit && audit.status) || "readiness_audit_failed"
  };
}

function readCandidateQualitySignal(runState, output) {
  const outputSignal = readRecord(output && output.candidateQualitySignal);
  if (outputSignal) return normalizeCandidateQualitySignal(outputSignal);
  const stateSignal = readRecord(runState && runState.candidateQualitySignal);
  if (stateSignal) return normalizeCandidateQualitySignal(stateSignal);
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  const workspaceSignal = readRecord(quality && quality.candidateQualitySignal);
  return workspaceSignal ? normalizeCandidateQualitySignal(workspaceSignal) : null;
}

function buildCandidateQualityCitationDeficit(signal, runState) {
  const quality = normalizeCandidateQualitySignal(signal);
  if (!quality || quality.hasBlockingIssues !== true) return null;
  const issues = Array.isArray(quality.blockingIssues) ? quality.blockingIssues : [];
  const citationIssues = issues
    .filter((issue) => {
      const code = readString(issue && issue.code);
      return code === "unread_cited_url" || code === "blocked_source_cited";
    })
    .map((issue) => ({
      code: readString(issue.code),
      message: readString(issue.message) || null,
      path: readString(issue.path) || readString(quality.path) || readFinalCandidatePathFromWorkspace(runState),
      qualityReason: readString(issue.qualityReason) || null,
      qualityTier: readString(issue.qualityTier) || null,
      status: readString(issue.status) || null,
      url: readString(issue.url)
    }))
    .filter((issue) => issue.code && issue.url)
    .slice(0, 8);
  if (citationIssues.length === 0) return null;
  const context = readRecord(runState && runState.researchContext);
  const sourceMinimum = readSourceMinimum$2(runState, readAcceptancePacket$2(runState)) || {};
  return {
    issueCodes: citationIssues.map((issue) => issue.code),
    citationIssues,
    citationIssueCount: citationIssues.length,
    minReadSources: readNumber(sourceMinimum.minReadSources),
    minRelevantSources: readNumber(sourceMinimum.minRelevantSources),
    readSourceDeficit: 0,
    readSources: readNumber(sourceMinimum.readSources),
    relevantSourceDeficit: 0,
    relevantSources: readNumber(sourceMinimum.relevantSources),
    reason: CANDIDATE_QUALITY_BLOCKED_REASON,
    sourceMinimumPassed: sourceMinimum.passed === true,
    successfulReadUrlCount: countSuccessfulReadUrlArtifacts(runState),
    unreadCitedUrls: citationIssues
      .filter((issue) => issue.code === "unread_cited_url")
      .map((issue) => issue.url),
    blockedCitedUrls: citationIssues
      .filter((issue) => issue.code === "blocked_source_cited")
      .map((issue) => issue.url),
    readUrlCandidatesAvailable: hasUnreadCitationUrls(context, citationIssues)
  };
}

function mergeSourceDeficit(existing, next) {
  const base = readRecord(existing);
  const incoming = readRecord(next);
  if (!base) return incoming;
  if (!incoming) return base;
  const citationIssues = [
    ...(Array.isArray(base.citationIssues) ? base.citationIssues : []),
    ...(Array.isArray(incoming.citationIssues) ? incoming.citationIssues : [])
  ].slice(0, 8);
  const issueCodes = Array.from(new Set([
    ...readStringArray(base.issueCodes),
    ...readStringArray(incoming.issueCodes)
  ])).slice(0, 12);
  return {
    ...base,
    ...incoming,
    citationIssueCount: citationIssues.length,
    citationIssues,
    issueCodes,
    readSourceDeficit: Math.max(readNumber(base.readSourceDeficit), readNumber(incoming.readSourceDeficit)),
    relevantSourceDeficit: Math.max(readNumber(base.relevantSourceDeficit), readNumber(incoming.relevantSourceDeficit)),
    reason: readString(incoming.reason) || readString(base.reason) || null,
    unreadCitedUrls: Array.from(new Set([
      ...readStringArray(base.unreadCitedUrls),
      ...readStringArray(incoming.unreadCitedUrls)
    ])).slice(0, 8),
    blockedCitedUrls: Array.from(new Set([
      ...readStringArray(base.blockedCitedUrls),
      ...readStringArray(incoming.blockedCitedUrls)
    ])).slice(0, 8)
  };
}

function hasUnreadCitationUrls(context, issues) {
  if (!context || typeof context !== "object") return true;
  const readSources = Array.isArray(context.readSources) ? context.readSources : [];
  const readUrls = new Set(readSources.map((source) => normalizeUrlKey(readCandidateUrl(source))).filter(Boolean));
  return issues.some((issue) => (
    issue.code === "unread_cited_url" &&
    normalizeUrlKey(issue.url) &&
    !readUrls.has(normalizeUrlKey(issue.url))
  ));
}

function isReadinessRepairOutput(output) {
  const result = readRecord(output) || {};
  const status = readString(result.status);
  const reason = readString(result.reason);
  if (status === "readiness_audit_failed") return true;
  if (status.includes("readiness") || reason.includes("readiness")) return true;
  const audit = readRecord(result.readinessAudit);
  return Boolean(
    audit &&
    audit.ok === false &&
    Array.isArray(audit.issues) &&
    audit.issues.length > 0
  );
}

function readOutputGuardrailBlock(output) {
  const block = readRecord(output && output.outputGuardrailBlock);
  if (!block) return null;
  return {
    info: block.info == null ? null : block.info,
    name: readString(block.name) || null,
    reason: readString(block.reason) || null
  };
}

// AGRUN-401 — classify an output-guardrail block as "structure" ONLY from its
// own issue codes. The previous early-return (`if (existingStructure) return
// true`) short-circuited before inspecting codes, so once any structure
// observation existed, EVERY subsequent guardrail block (language bias, image
// dimension, …) was mislabelled a structure deficit and merged its unrelated
// codes into observableDeficits.structure — polluting activeDeficits and
// steering the model to repair a non-existent structure problem. A genuine
// pre-existing structure deficit is still captured independently via the
// `structure.ok === false` path in readRepairFacts, so dropping the
// short-circuit loses no real signal; existingStructure stays display-only.
function isOutputGuardrailStructureBlock(block) {
  const codes = readOutputGuardrailIssueCodes(block);
  if (codes.length === 0) return false;
  return codes.some((code) => (
    code.includes("heading") ||
    code.includes("section") ||
    code.includes("structure") ||
    code.includes("placeholder") ||
    code.includes("artifact") ||
    code.includes("reference") ||
    code.includes("source_position") ||
    code.includes("final_")
  ));
}

function mergeOutputGuardrailStructureDeficit(existingStructure, block) {
  const base = readRecord(existingStructure) || {};
  const guardrailCodes = readOutputGuardrailIssueCodes(block);
  const issueCodes = Array.from(new Set([
    ...readStringArray(base.issueCodes),
    ...guardrailCodes
  ])).slice(0, 8);
  return {
    issueCodes,
    reason: readString(base.reason) ||
      readString(block && block.reason) ||
      "output_guardrail_blocked",
    repeatedHeadingSamples: normalizeStructureSamples(base.repeatedHeadingSamples, "heading"),
    repeatedNumberSamples: normalizeStructureSamples(base.repeatedNumberSamples, "number"),
    status: "fail"
  };
}

function readOutputGuardrailIssueCodes(block) {
  const info = readRecord(block && block.info);
  const issues = Array.isArray(info && info.issues) ? info.issues : [];
  return issues
    .map((issue) => readString(issue && issue.code))
    .filter(Boolean)
    .slice(0, 12);
}

function readOutputRepairReason(output) {
  const status = readString(output && output.status);
  const reason = readString(output && output.reason);
  for (const value of [status, reason]) {
    if (!value) continue;
    if (value === "ok" || value === "complete" || value === "completed") continue;
    if (value.startsWith("after_") || value.startsWith("before_")) continue;
    return value;
  }
  return null;
}

function readBudgetState$1(runState, context) {
  const cycle = readNumber(runState && runState.cycleCount);
  const maxSteps = readNumber(runState && runState.maxSteps) ||
    readNumber(context && context.runtimeConfig && context.runtimeConfig.maxSteps);
  // AGRUN-413 — "low" is proportional to maxSteps, not a fixed 10-step window.
  return readCycleBudgetState(maxSteps, cycle);
}

function readAcceptancePacket$2(runState) {
  const loop = readRecord(runState && runState.researchReportLoop);
  const directPacket = readRecord(loop && loop.acceptancePacket);
  if (directPacket) return directPacket;
  const signal = readRecord(loop && loop.gateSignal);
  return readRecord(signal && signal.acceptancePacket);
}

function readSourceMinimum$2(runState, packet) {
  const evidence = readRecord(packet && packet.evidence);
  if (readRecord(evidence && evidence.sourceMinimum)) return evidence.sourceMinimum;
  const loop = readRecord(runState && runState.researchReportLoop);
  return readRecord(loop && loop.sourceMinimum);
}

function readLengthStatus(packet, runState) {
  const requested = readRecord(packet && packet.requestedLength);
  const statsKey = readString(requested && requested.statsKey) ||
    (readString(requested && requested.unit) === "words" ? "words" : "chars");
  const requestedValue = readNumber(requested && requested.value);
  if (!requestedValue || !statsKey) return null;
  const candidate = readRecord(packet && packet.candidate) ||
    readRecord(packet && packet.workspace && packet.workspace.candidate);
  const stats = readRecord(candidate && candidate.textStats) || readRecord(candidate && candidate.stats) ||
    readCandidateStatsFromWorkspace(runState);
  return {
    observed: readNumber(stats && stats[statsKey]),
    path: readString(candidate && candidate.path) || readFinalCandidatePathFromWorkspace(runState),
    requested: requestedValue,
    statsKey,
    unit: readString(requested && requested.unit) || statsKey
  };
}

function findWorkspaceLengthCandidate(runState, statsKey, requested, observed, currentPath) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  if (!files) return null;
  const selectedPath = readString(currentPath) || readFinalCandidatePathFromWorkspace(runState);
  let best = null;
  for (const [path, file] of Object.entries(files)) {
    const safePath = readString(path);
    if (!safePath || safePath === selectedPath) continue;
    const stats = readRecord(file && file.textStats);
    const value = readNumber(stats && stats[statsKey]);
    if (value < requested || value <= observed) continue;
    if (!best || value > best.observed) {
      best = {
        path: safePath,
        observed: value,
        requested,
        unit: statsKey
      };
    }
  }
  return best;
}

function readStructureStatus(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  return readRecord(quality && quality.finalCandidateStructure);
}

function isFinalizedCandidateSelected(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const quality = readRecord(workspace && workspace.quality);
  const protocol = inspectWorkspacePublishProtocol(workspace, readFinalCandidatePathFromWorkspace(runState));
  return quality && (
    quality.finalCandidateReady === true ||
    readString(quality.finalCandidateStatus) === "needs_structure_repair" ||
    readString(quality.finalCandidateStatus) === "ready" ||
    (protocol && protocol.finalizedAfterLatestWrite === true)
  );
}

function readTodoStatus(runState) {
  const todoState = readRecord(runState && runState.todoState);
  if (!todoState || readString(todoState.status) !== "active") {
    return { unfinishedCount: 0, activeItemId: null };
  }
  const items = Array.isArray(todoState.items) ? todoState.items : [];
  const unfinished = items.filter((item) => {
    const status = readString(item && item.status);
    return status === "active" || status === "pending" || status === "blocked";
  });
  return {
    activeItemId: readString(todoState.activeItemId) || null,
    unfinishedCount: unfinished.length,
    pendingCount: unfinished.filter((item) => readString(item.status) === "pending").length,
    blockedCount: unfinished.filter((item) => readString(item.status) === "blocked").length
  };
}

function readSuccessfulReadUrlCount$2(runState, packet) {
  const packetCount = packet && packet.evidence && Number.isFinite(Number(packet.evidence.successfulReadUrlCount))
    ? readNumber(packet.evidence.successfulReadUrlCount)
    : 0;
  return Math.max(packetCount, countSuccessfulReadUrlArtifacts(runState));
}

export { buildCandidateQualityCitationDeficit, findWorkspaceLengthCandidate, hasUnreadCitationUrls, isFinalizedCandidateSelected, isOutputGuardrailStructureBlock, isReadinessRepairOutput, mergeOutputGuardrailStructureDeficit, mergeSourceDeficit, readAcceptancePacket$2 as readAcceptancePacket, readBudgetState$1 as readBudgetState, readCandidateQualitySignal, readLengthStatus, readOutputGuardrailBlock, readOutputGuardrailIssueCodes, readOutputRepairReason, readReadinessDeficit, readRepairFacts, readSharedRepairFactReads, readSourceMinimum$2 as readSourceMinimum, readStructureStatus, readSuccessfulReadUrlCount$2 as readSuccessfulReadUrlCount, readTerminalRequirementRecoveryFacts, readTodoStatus, shouldProactivelyActivateBudgetRepair };
