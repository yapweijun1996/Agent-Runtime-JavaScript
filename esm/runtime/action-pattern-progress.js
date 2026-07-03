import { countSuccessfulEvidenceArtifacts } from './final-readiness.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from './workspace-candidate-lifecycle.js';
import { readString } from './semantic-json.js';

// AGRUN-263 — built-in default. Tool-loop hosts can REPLACE this list via
// `runtimeConfig.productiveProgressDimensions`, e.g.
// `["workspace","source","tool_result"]`. Replacement (not merge) is
// intentional so misconfiguration is loud rather than silently additive.
const DEFAULT_PRODUCTIVE_PROGRESS_DIMENSIONS = ["workspace", "source"];

function resolveProductiveProgressDimensions(runtimeConfig) {
  const configured = runtimeConfig && Array.isArray(runtimeConfig.productiveProgressDimensions)
    ? runtimeConfig.productiveProgressDimensions
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean)
    : null;
  if (configured && configured.length > 0) return configured.slice();
  const defaults = DEFAULT_PRODUCTIVE_PROGRESS_DIMENSIONS.slice();
  const evidencePolicy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  if (evidencePolicy && evidencePolicy.enabled !== false && evidencePolicy.profile && evidencePolicy.profile !== "web_research") {
    defaults.push("evidence");
  }
  return defaults;
}

function createProgressSnapshot(runState, runtimeConfig) {
  const source = runState && typeof runState === "object" ? runState : {};
  const researchContext = source.researchContext && typeof source.researchContext === "object" ? source.researchContext : {};
  const readSources = Array.isArray(researchContext.readSources) ? researchContext.readSources : [];
  const searchResults = collectSearchResults$1(researchContext);
  const sourceMinimum = readSourceMinimum$1(source);
  const evidenceMinimum = readEvidenceMinimum(source, sourceMinimum);
  const successfulReadUrlCount = readSuccessfulReadUrlCount$1(source, readSources);
  const successfulEvidenceCount = readSuccessfulEvidenceCount(source, readSources, runtimeConfig, successfulReadUrlCount);
  const candidate = readCandidateSnapshot$1(source);
  const todo = readTodoSnapshot(source);
  const skill = readSkillSnapshot(source);
  const memoryEntriesAdded = Array.isArray(source.memoryEntriesAdded)
    ? source.memoryEntriesAdded.length
    : readNumber$g(source.memoryEntriesAdded);

  return {
    candidate,
    evidenceArtifactCount: evidenceMinimum ? readNumber$g(evidenceMinimum.evidenceArtifacts) : readSources.length,
    evidenceMinimumPassed: evidenceMinimum ? evidenceMinimum.passed === true : false,
    memoryEntriesAdded,
    readSourceCount: readSources.length,
    readSourceUrlCount: countDistinctReadUrls(readSources),
    relevantEvidenceArtifactCount: evidenceMinimum ? readNumber$g(evidenceMinimum.relevantEvidenceArtifacts) : countRelevantReadSources(readSources),
    relevantSourceCount: sourceMinimum ? readNumber$g(sourceMinimum.relevantSources) : countRelevantReadSources(readSources),
    requestedLength: readRequestedLengthStatus(source),
    searchPassCount: Array.isArray(researchContext.searchPasses) ? researchContext.searchPasses.length : 0,
    searchResultUrlCount: countDistinctSearchUrls(searchResults),
    skill,
    sourceMinimumPassed: sourceMinimum ? sourceMinimum.passed === true : false,
    successfulEvidenceCount,
    successfulReadUrlCount,
    todo,
    toolHistoryCount: source.toolContext && Array.isArray(source.toolContext.history)
      ? source.toolContext.history.length
      : 0,
    workspace: readWorkspaceSnapshot(source)
  };
}

function diffProgress(previous, next, options = {}) {
  const before = normalizeProgressSnapshot(previous);
  const after = normalizeProgressSnapshot(next);
  const productiveWhitelist = Array.isArray(options.productiveDimensions) && options.productiveDimensions.length > 0
    ? options.productiveDimensions
    : DEFAULT_PRODUCTIVE_PROGRESS_DIMENSIONS;
  const extraDimensions = Array.isArray(options.extraDimensions)
    ? options.extraDimensions.filter((d) => typeof d === "string" && d)
    : [];
  const dimensions = [];
  const regression = detectCandidateRegression(before, after);
  const regressiveDimensions = regression ? ["candidate"] : [];
  if (after.successfulEvidenceCount > before.successfulEvidenceCount ||
      after.evidenceArtifactCount > before.evidenceArtifactCount ||
      after.relevantEvidenceArtifactCount > before.relevantEvidenceArtifactCount ||
      (after.evidenceMinimumPassed === true && before.evidenceMinimumPassed !== true)) {
    dimensions.push("evidence");
  }
  if (after.successfulReadUrlCount > before.successfulReadUrlCount ||
      after.readSourceUrlCount > before.readSourceUrlCount ||
      after.relevantSourceCount > before.relevantSourceCount ||
      (after.sourceMinimumPassed === true && before.sourceMinimumPassed !== true)) {
    dimensions.push("source");
  }
  if (after.searchPassCount > before.searchPassCount || after.searchResultUrlCount > before.searchResultUrlCount) {
    dimensions.push("search");
  }
  const candidateTextGrew =
    readNumber$g(after.candidate.words) > readNumber$g(before.candidate.words) ||
    readNumber$g(after.candidate.chars) > readNumber$g(before.candidate.chars) ||
    readNumber$g(after.candidate.cjkChars) > readNumber$g(before.candidate.cjkChars);
  const workspaceVersionGrew = readNumber$g(after.workspace.version) > readNumber$g(before.workspace.version);
  const lengthDeficitActive = after.requestedLength &&
    readNumber$g(after.requestedLength.requested) > 0 &&
    readNumber$g(after.requestedLength.observed) < readNumber$g(after.requestedLength.requested);
  if (!regression && (candidateTextGrew || (workspaceVersionGrew && !lengthDeficitActive))) {
    dimensions.push("workspace");
  } else if (workspaceVersionGrew && !regression) {
    dimensions.push("workspace_churn");
  }
  if (readNumber$g(after.todo.done) > readNumber$g(before.todo.done) ||
      readNumber$g(after.todo.completed) > readNumber$g(before.todo.completed)) {
    dimensions.push("todo");
  }
  if (after.memoryEntriesAdded > before.memoryEntriesAdded ||
      readNumber$g(after.skill.loadedCount) > readNumber$g(before.skill.loadedCount)) {
    dimensions.push("memory_or_skill");
  }
  for (const extra of extraDimensions) dimensions.push(extra);
  const uniqueDimensions = Array.from(new Set(dimensions));
  const productiveDimensions = uniqueDimensions.filter((d) => productiveWhitelist.includes(d));
  const transitionalDimensions = uniqueDimensions.filter((d) => !productiveWhitelist.includes(d));
  return {
    dimensions: uniqueDimensions,
    regressiveDimensions,
    productiveDimensions,
    transitionalDimensions,
    candidateDelta: regression
      ? {
          chars: readNumber$g(after.candidate.chars) - readNumber$g(before.candidate.chars),
          cjkChars: readNumber$g(after.candidate.cjkChars) - readNumber$g(before.candidate.cjkChars),
          words: readNumber$g(after.candidate.words) - readNumber$g(before.candidate.words)
        }
      : null,
    hasRegressiveProgress: regressiveDimensions.length > 0,
    hasProgress: uniqueDimensions.length > 0,
    hasProductiveProgress: productiveDimensions.length > 0,
    hasTransitionalOnlyProgress: productiveDimensions.length === 0 && transitionalDimensions.length > 0
  };
}

function detectCandidateRegression(previous, next) {
  const before = normalizeProgressSnapshot(previous);
  const after = normalizeProgressSnapshot(next);
  if (!before || !after) return false;
  const beforeWords = readNumber$g(before.candidate.words);
  const afterWords = readNumber$g(after.candidate.words);
  const beforeChars = readNumber$g(before.candidate.chars);
  const afterChars = readNumber$g(after.candidate.chars);
  const beforeCjkChars = readNumber$g(before.candidate.cjkChars);
  const afterCjkChars = readNumber$g(after.candidate.cjkChars);
  const requested = readNumber$g(after.requestedLength.requested) || readNumber$g(before.requestedLength.requested);
  const observedAfter = readNumber$g(after.requestedLength.observed) || afterWords || afterChars || afterCjkChars;
  const observedBefore = readNumber$g(before.requestedLength.observed) || beforeWords || beforeChars || beforeCjkChars;
  const hasRequestedDeficit = requested > 0 && observedAfter > 0 && observedAfter < requested;
  const nearOrAboveTargetBefore = requested > 0 && observedBefore >= Math.floor(requested * 0.95);
  if (isMaterialCountRegression(beforeWords, afterWords, { absoluteFloor: 100 })) {
    return hasRequestedDeficit || nearOrAboveTargetBefore || beforeWords >= 1000 || beforeWords - afterWords >= 200;
  }
  if (isMaterialCountRegression(beforeChars, afterChars, { absoluteFloor: 600 })) {
    return hasRequestedDeficit || nearOrAboveTargetBefore || beforeChars >= 6000 || beforeChars - afterChars >= 1200;
  }
  if (isMaterialCountRegression(beforeCjkChars, afterCjkChars, { absoluteFloor: 250 })) {
    return hasRequestedDeficit || nearOrAboveTargetBefore || beforeCjkChars >= 2500 || beforeCjkChars - afterCjkChars >= 500;
  }
  return false;
}

function isMaterialCountRegression(before, after, options = {}) {
  const previous = readNumber$g(before);
  const current = readNumber$g(after);
  if (!previous || current >= previous) return false;
  const absoluteFloor = readNumber$g(options.absoluteFloor) || 1;
  const delta = previous - current;
  return delta >= absoluteFloor && current <= Math.floor(previous * 0.9);
}

function normalizeProgressSnapshot(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    candidate: {
      chars: readNumber$g(source.candidate && source.candidate.chars),
      cjkChars: readNumber$g(source.candidate && source.candidate.cjkChars),
      path: readString(source.candidate && source.candidate.path) || null,
      words: readNumber$g(source.candidate && source.candidate.words)
    },
    evidenceArtifactCount: readNumber$g(source.evidenceArtifactCount != null ? source.evidenceArtifactCount : source.readSourceCount),
    evidenceMinimumPassed: source.evidenceMinimumPassed === true || source.sourceMinimumPassed === true,
    memoryEntriesAdded: readNumber$g(source.memoryEntriesAdded),
    readSourceCount: readNumber$g(source.readSourceCount),
    readSourceUrlCount: readNumber$g(source.readSourceUrlCount),
    relevantEvidenceArtifactCount: readNumber$g(source.relevantEvidenceArtifactCount != null ? source.relevantEvidenceArtifactCount : source.relevantSourceCount),
    relevantSourceCount: readNumber$g(source.relevantSourceCount),
    requestedLength: {
      observed: readNumber$g(source.requestedLength && source.requestedLength.observed),
      requested: readNumber$g(source.requestedLength && source.requestedLength.requested),
      statsKey: readString(source.requestedLength && source.requestedLength.statsKey) || null
    },
    searchPassCount: readNumber$g(source.searchPassCount),
    searchResultUrlCount: readNumber$g(source.searchResultUrlCount),
    skill: {
      active: readString(source.skill && source.skill.active) || null,
      lastRead: readString(source.skill && source.skill.lastRead) || null,
      loadedCount: readNumber$g(source.skill && source.skill.loadedCount)
    },
    sourceMinimumPassed: source.sourceMinimumPassed === true,
    successfulEvidenceCount: readNumber$g(source.successfulEvidenceCount != null ? source.successfulEvidenceCount : source.successfulReadUrlCount),
    successfulReadUrlCount: readNumber$g(source.successfulReadUrlCount),
    todo: {
      completed: readNumber$g(source.todo && source.todo.completed),
      done: readNumber$g(source.todo && source.todo.done),
      version: readNumber$g(source.todo && source.todo.version)
    },
    toolHistoryCount: readNumber$g(source.toolHistoryCount),
    workspace: {
      finalCandidateReady: source.workspace && source.workspace.finalCandidateReady === true,
      operationCount: readNumber$g(source.workspace && source.workspace.operationCount),
      version: readNumber$g(source.workspace && source.workspace.version)
    }
  };
}

function summarizeProgressSnapshot(value) {
  const snapshot = normalizeProgressSnapshot(value);
  return {
    candidate: snapshot.candidate,
    evidenceArtifactCount: snapshot.evidenceArtifactCount,
    evidenceMinimumPassed: snapshot.evidenceMinimumPassed,
    readSourceCount: snapshot.readSourceCount,
    readSourceUrlCount: snapshot.readSourceUrlCount,
    relevantEvidenceArtifactCount: snapshot.relevantEvidenceArtifactCount,
    relevantSourceCount: snapshot.relevantSourceCount,
    searchPassCount: snapshot.searchPassCount,
    searchResultUrlCount: snapshot.searchResultUrlCount,
    sourceMinimumPassed: snapshot.sourceMinimumPassed,
    successfulEvidenceCount: snapshot.successfulEvidenceCount,
    successfulReadUrlCount: snapshot.successfulReadUrlCount,
    todo: snapshot.todo,
    workspace: snapshot.workspace
  };
}

function readCandidateSnapshot$1(runState) {
  const packet = readAcceptancePacket$1(runState);
  const packetStats = packet && packet.candidate && packet.candidate.textStats
    ? packet.candidate.textStats
    : null;
  if (packetStats) {
    return {
      chars: readNumber$g(packetStats.chars),
      cjkChars: readNumber$g(packetStats.cjkChars),
      path: readString(packet.candidate.path) || null,
      words: readNumber$g(packetStats.words)
    };
  }
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const quality = workspace && workspace.quality && typeof workspace.quality === "object" ? workspace.quality : {};
  const path = readString(quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const file = workspace && workspace.files && workspace.files[path] && typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  const stats = file && file.textStats && typeof file.textStats === "object" ? file.textStats : {};
  return {
    chars: readNumber$g(stats.chars),
    cjkChars: readNumber$g(stats.cjkChars),
    path: file ? path : null,
    words: readNumber$g(stats.words)
  };
}

function readRequestedLengthStatus(runState) {
  const packet = readAcceptancePacket$1(runState);
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const requestedValue = readNumber$g(requested && requested.value);
  const statsKey = readString(requested && requested.statsKey) ||
    (readString(requested && requested.unit) === "words" ? "words" : "chars");
  if (!requestedValue || !statsKey) return null;
  const candidateStats = packet && packet.candidate && typeof packet.candidate === "object"
    ? (packet.candidate.textStats || packet.candidate.stats)
    : null;
  const workspaceStats = readWorkspaceCandidateStats(runState);
  const observed = readNumber$g(candidateStats && candidateStats[statsKey]) ||
    readNumber$g(workspaceStats && workspaceStats[statsKey]);
  return {
    observed,
    requested: requestedValue,
    statsKey
  };
}

function hasWorkspaceArtifacts(runState) {
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  if (!workspace) return false;
  if (readNumber$g(workspace.version) > 0) return true;
  const files = workspace.files && typeof workspace.files === "object" && !Array.isArray(workspace.files)
    ? workspace.files
    : null;
  return Boolean(files && Object.keys(files).length > 0);
}

function hasUnfinishedTodoState$1(runState) {
  const todoState = runState && runState.todoState && typeof runState.todoState === "object"
    ? runState.todoState
    : null;
  if (!todoState || todoState.status !== "active") return false;
  if (readString(todoState.activeItemId)) return true;
  if (!Array.isArray(todoState.items)) return false;
  return todoState.items.some((item) => {
    const status = readString(item && item.status);
    return status === "active" || status === "pending" || status === "blocked";
  });
}

// AGRUN-554 — DORMANT, not dead. This reads the source-BREADTH minimum
// (read/relevant source counts vs a target) from the research-report loop's
// gateSignal/acceptancePacket or loop.sourceMinimum. AGRUN-522 removed the loop's
// PRODUCER, so in current production runs both are absent and this returns null —
// every downstream `sourceMinimum && …` breadth-deficit branch (terminal-repair
// facts, planner-prompt, long-research, requirement-recovery, …) is therefore
// dormant. The CONSUMER logic + its unit tests are intact and resume the moment a
// host/skill repopulates sourceMinimum, so this is NOT removable dead code: it is a
// disabled feature. Design stance (2026-06-26): how MANY sources to gather is the
// model's call (AI-first / AGRUN-244/246-C), so breadth gating stays OFF by default;
// the harness's live source job is citation INTEGRITY (candidate-quality-signal),
// not breadth. Deleting this machinery would drop a working dormant capability and
// its coverage — out of scope for a janitorial pass.
function readSourceMinimum$1(runState) {
  const packet = readAcceptancePacket$1(runState);
  if (packet && packet.evidence && packet.evidence.sourceMinimum && typeof packet.evidence.sourceMinimum === "object") {
    return packet.evidence.sourceMinimum;
  }
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  return loop.sourceMinimum && typeof loop.sourceMinimum === "object" ? loop.sourceMinimum : null;
}

function readEvidenceMinimum(runState, sourceMinimum = readSourceMinimum$1(runState)) {
  const packet = readAcceptancePacket$1(runState);
  if (packet && packet.evidence && packet.evidence.evidenceMinimum && typeof packet.evidence.evidenceMinimum === "object") {
    return packet.evidence.evidenceMinimum;
  }
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  if (loop.evidenceMinimum && typeof loop.evidenceMinimum === "object") {
    return loop.evidenceMinimum;
  }
  return buildEvidenceMinimumFromSourceMinimum(sourceMinimum);
}

function readAcceptancePacket$1(runState) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  const directPacket = loop && loop.acceptancePacket && typeof loop.acceptancePacket === "object"
    ? loop.acceptancePacket
    : null;
  if (directPacket) return directPacket;
  const signal = loop && loop.gateSignal && typeof loop.gateSignal === "object"
    ? loop.gateSignal
    : null;
  return signal && signal.acceptancePacket && typeof signal.acceptancePacket === "object"
    ? signal.acceptancePacket
    : null;
}

function readWorkspaceCandidateStats(runState) {
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const quality = workspace && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : null;
  const path = readString(quality && quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const file = workspace &&
    workspace.files &&
    workspace.files[path] &&
    typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  return file && typeof file.textStats === "object" ? file.textStats : null;
}

function readWorkspaceSnapshot(runState) {
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : {};
  const quality = workspace.quality && typeof workspace.quality === "object" ? workspace.quality : {};
  return {
    finalCandidateReady: quality.finalCandidateReady === true,
    operationCount: Array.isArray(workspace.operations) ? workspace.operations.length : 0,
    version: readNumber$g(workspace.version)
  };
}

function readTodoSnapshot(runState) {
  const todoState = runState && runState.todoState && typeof runState.todoState === "object"
    ? runState.todoState
    : null;
  const items = todoState && Array.isArray(todoState.items) ? todoState.items : [];
  return {
    completed: todoState && todoState.status === "completed" ? 1 : 0,
    done: items.filter((item) => item && item.status === "done").length,
    version: todoState && Number.isInteger(todoState.version) ? todoState.version : 0
  };
}

function readSkillSnapshot(runState) {
  const context = runState && runState.agentSkillContext && typeof runState.agentSkillContext === "object"
    ? runState.agentSkillContext
    : {};
  const active = readSkillLabel(context.activeSkill);
  const lastRead = readSkillLabel(context.lastReadSkill);
  return {
    active,
    lastRead,
    loadedCount: (active ? 1 : 0) + (lastRead && lastRead !== active ? 1 : 0)
  };
}

function readSuccessfulReadUrlCount$1(runState, readSources) {
  const packet = readAcceptancePacket$1(runState);
  if (packet && packet.evidence) {
    const value = readNullableNumber$6(packet.evidence.successfulReadUrlCount);
    if (value != null) return value;
  }
  const sources = Array.isArray(readSources) ? readSources : [];
  return sources.filter((source) => source && (source.ok === true || source.status === 200 || source.status === "ok")).length;
}

function readSuccessfulEvidenceCount(runState, readSources, runtimeConfig, successfulReadUrlCount) {
  const packet = readAcceptancePacket$1(runState);
  if (packet && packet.evidence) {
    const value = readNullableNumber$6(packet.evidence.successfulEvidenceCount);
    if (value != null) return value;
  }
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  if (policy && policy.enabled !== false && policy.profile && policy.profile !== "web_research") {
    return countSuccessfulEvidenceArtifacts(runState, runtimeConfig);
  }
  return readNumber$g(successfulReadUrlCount != null ? successfulReadUrlCount : readSuccessfulReadUrlCount$1(runState, readSources));
}

function buildEvidenceMinimumFromSourceMinimum(sourceMinimum) {
  if (!sourceMinimum || typeof sourceMinimum !== "object") return null;
  return {
    evidenceArtifacts: readNumber$g(sourceMinimum.readSources),
    minEvidenceArtifacts: readNumber$g(sourceMinimum.minReadSources),
    minRelevantEvidenceArtifacts: readNumber$g(sourceMinimum.minRelevantSources),
    passed: sourceMinimum.passed === true,
    relevantEvidenceArtifacts: readNumber$g(sourceMinimum.relevantSources)
  };
}

function countRelevantReadSources(readSources) {
  const sources = Array.isArray(readSources) ? readSources : [];
  return sources.filter((source) => {
    const quality = readString(source && source.quality);
    return source && source.ok !== false && quality !== "thin" && quality !== "rejected";
  }).length;
}

function collectSearchResults$1(researchContext) {
  const results = [];
  if (Array.isArray(researchContext.searchResults)) results.push(...researchContext.searchResults);
  if (Array.isArray(researchContext.aggregatedSearchResults)) results.push(...researchContext.aggregatedSearchResults);
  if (Array.isArray(researchContext.searchPasses)) {
    for (const pass of researchContext.searchPasses) {
      if (pass && Array.isArray(pass.results)) results.push(...pass.results);
    }
  }
  return results;
}

function countDistinctSearchUrls(results) {
  const urls = new Set();
  const list = Array.isArray(results) ? results : [];
  for (const item of list) {
    const url = readString(item && (item.url || item.link || item.href));
    if (url) urls.add(url);
  }
  return urls.size;
}

function countDistinctReadUrls(readSources) {
  const urls = new Set();
  const list = Array.isArray(readSources) ? readSources : [];
  for (const item of list) {
    const url = readString(item && item.url);
    if (url) urls.add(url);
  }
  return urls.size;
}

function readSkillLabel(value) {
  if (!value || typeof value !== "object") return null;
  return readString(value.name) || readString(value.skillId) || null;
}

function readNumber$g(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function readNullableNumber$6(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export { createProgressSnapshot, detectCandidateRegression, diffProgress, hasUnfinishedTodoState$1 as hasUnfinishedTodoState, hasWorkspaceArtifacts, normalizeProgressSnapshot, readAcceptancePacket$1 as readAcceptancePacket, readCandidateSnapshot$1 as readCandidateSnapshot, readEvidenceMinimum, readRequestedLengthStatus, readSourceMinimum$1 as readSourceMinimum, resolveProductiveProgressDimensions, summarizeProgressSnapshot };
