import { countSuccessfulEvidenceArtifacts } from './final-readiness.js';

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

function createProgressSnapshot$1(runState, runtimeConfig) {
  const source = runState && typeof runState === "object" ? runState : {};
  const researchContext = source.researchContext && typeof source.researchContext === "object" ? source.researchContext : {};
  const readSources = Array.isArray(researchContext.readSources) ? researchContext.readSources : [];
  const searchResults = collectSearchResults$1(researchContext);
  const sourceMinimum = readSourceMinimum$2(source);
  const evidenceMinimum = readEvidenceMinimum(source, sourceMinimum);
  const successfulReadUrlCount = readSuccessfulReadUrlCount$2(source, readSources);
  const successfulEvidenceCount = readSuccessfulEvidenceCount(source, readSources, runtimeConfig, successfulReadUrlCount);
  const candidate = readCandidateSnapshot$1(source);
  const todo = readTodoSnapshot(source);
  const skill = readSkillSnapshot(source);
  const memoryEntriesAdded = Array.isArray(source.memoryEntriesAdded)
    ? source.memoryEntriesAdded.length
    : readNumber$j(source.memoryEntriesAdded);

  return {
    candidate,
    evidenceArtifactCount: evidenceMinimum ? readNumber$j(evidenceMinimum.evidenceArtifacts) : readSources.length,
    evidenceMinimumPassed: evidenceMinimum ? evidenceMinimum.passed === true : false,
    memoryEntriesAdded,
    readSourceCount: readSources.length,
    readSourceUrlCount: countDistinctReadUrls(readSources),
    relevantEvidenceArtifactCount: evidenceMinimum ? readNumber$j(evidenceMinimum.relevantEvidenceArtifacts) : countRelevantReadSources(readSources),
    relevantSourceCount: sourceMinimum ? readNumber$j(sourceMinimum.relevantSources) : countRelevantReadSources(readSources),
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

function diffProgress$1(previous, next, options = {}) {
  const before = normalizeProgressSnapshot$1(previous);
  const after = normalizeProgressSnapshot$1(next);
  const productiveWhitelist = Array.isArray(options.productiveDimensions) && options.productiveDimensions.length > 0
    ? options.productiveDimensions
    : DEFAULT_PRODUCTIVE_PROGRESS_DIMENSIONS;
  const extraDimensions = Array.isArray(options.extraDimensions)
    ? options.extraDimensions.filter((d) => typeof d === "string" && d)
    : [];
  const dimensions = [];
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
    readNumber$j(after.candidate.words) > readNumber$j(before.candidate.words) ||
    readNumber$j(after.candidate.chars) > readNumber$j(before.candidate.chars) ||
    readNumber$j(after.candidate.cjkChars) > readNumber$j(before.candidate.cjkChars);
  const workspaceVersionGrew = readNumber$j(after.workspace.version) > readNumber$j(before.workspace.version);
  const lengthDeficitActive = after.requestedLength &&
    readNumber$j(after.requestedLength.requested) > 0 &&
    readNumber$j(after.requestedLength.observed) < readNumber$j(after.requestedLength.requested);
  if (candidateTextGrew || (workspaceVersionGrew && !lengthDeficitActive)) {
    dimensions.push("workspace");
  } else if (workspaceVersionGrew) {
    dimensions.push("workspace_churn");
  }
  if (readNumber$j(after.todo.done) > readNumber$j(before.todo.done) ||
      readNumber$j(after.todo.completed) > readNumber$j(before.todo.completed)) {
    dimensions.push("todo");
  }
  if (after.memoryEntriesAdded > before.memoryEntriesAdded ||
      readNumber$j(after.skill.loadedCount) > readNumber$j(before.skill.loadedCount)) {
    dimensions.push("memory_or_skill");
  }
  for (const extra of extraDimensions) dimensions.push(extra);
  const uniqueDimensions = Array.from(new Set(dimensions));
  const productiveDimensions = uniqueDimensions.filter((d) => productiveWhitelist.includes(d));
  const transitionalDimensions = uniqueDimensions.filter((d) => !productiveWhitelist.includes(d));
  return {
    dimensions: uniqueDimensions,
    productiveDimensions,
    transitionalDimensions,
    hasProgress: uniqueDimensions.length > 0,
    hasProductiveProgress: productiveDimensions.length > 0,
    hasTransitionalOnlyProgress: productiveDimensions.length === 0 && transitionalDimensions.length > 0
  };
}

function normalizeProgressSnapshot$1(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    candidate: {
      chars: readNumber$j(source.candidate && source.candidate.chars),
      cjkChars: readNumber$j(source.candidate && source.candidate.cjkChars),
      path: readString$1H(source.candidate && source.candidate.path) || null,
      words: readNumber$j(source.candidate && source.candidate.words)
    },
    evidenceArtifactCount: readNumber$j(source.evidenceArtifactCount != null ? source.evidenceArtifactCount : source.readSourceCount),
    evidenceMinimumPassed: source.evidenceMinimumPassed === true || source.sourceMinimumPassed === true,
    memoryEntriesAdded: readNumber$j(source.memoryEntriesAdded),
    readSourceCount: readNumber$j(source.readSourceCount),
    readSourceUrlCount: readNumber$j(source.readSourceUrlCount),
    relevantEvidenceArtifactCount: readNumber$j(source.relevantEvidenceArtifactCount != null ? source.relevantEvidenceArtifactCount : source.relevantSourceCount),
    relevantSourceCount: readNumber$j(source.relevantSourceCount),
    requestedLength: {
      observed: readNumber$j(source.requestedLength && source.requestedLength.observed),
      requested: readNumber$j(source.requestedLength && source.requestedLength.requested),
      statsKey: readString$1H(source.requestedLength && source.requestedLength.statsKey) || null
    },
    searchPassCount: readNumber$j(source.searchPassCount),
    searchResultUrlCount: readNumber$j(source.searchResultUrlCount),
    skill: {
      active: readString$1H(source.skill && source.skill.active) || null,
      lastRead: readString$1H(source.skill && source.skill.lastRead) || null,
      loadedCount: readNumber$j(source.skill && source.skill.loadedCount)
    },
    sourceMinimumPassed: source.sourceMinimumPassed === true,
    successfulEvidenceCount: readNumber$j(source.successfulEvidenceCount != null ? source.successfulEvidenceCount : source.successfulReadUrlCount),
    successfulReadUrlCount: readNumber$j(source.successfulReadUrlCount),
    todo: {
      completed: readNumber$j(source.todo && source.todo.completed),
      done: readNumber$j(source.todo && source.todo.done),
      version: readNumber$j(source.todo && source.todo.version)
    },
    toolHistoryCount: readNumber$j(source.toolHistoryCount),
    workspace: {
      finalCandidateReady: source.workspace && source.workspace.finalCandidateReady === true,
      operationCount: readNumber$j(source.workspace && source.workspace.operationCount),
      version: readNumber$j(source.workspace && source.workspace.version)
    }
  };
}

function summarizeProgressSnapshot(value) {
  const snapshot = normalizeProgressSnapshot$1(value);
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
  const packet = readAcceptancePacket$2(runState);
  const packetStats = packet && packet.candidate && packet.candidate.textStats
    ? packet.candidate.textStats
    : null;
  if (packetStats) {
    return {
      chars: readNumber$j(packetStats.chars),
      cjkChars: readNumber$j(packetStats.cjkChars),
      path: readString$1H(packet.candidate.path) || null,
      words: readNumber$j(packetStats.words)
    };
  }
  const workspace = runState && runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  const quality = workspace && workspace.quality && typeof workspace.quality === "object" ? workspace.quality : {};
  const path = readString$1H(quality.finalCandidatePath) || "final_candidate.md";
  const file = workspace && workspace.files && workspace.files[path] && typeof workspace.files[path] === "object"
    ? workspace.files[path]
    : null;
  const stats = file && file.textStats && typeof file.textStats === "object" ? file.textStats : {};
  return {
    chars: readNumber$j(stats.chars),
    cjkChars: readNumber$j(stats.cjkChars),
    path: file ? path : null,
    words: readNumber$j(stats.words)
  };
}

function readRequestedLengthStatus(runState) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  const packet = loop &&
    loop.gateSignal &&
    loop.gateSignal.acceptancePacket &&
    typeof loop.gateSignal.acceptancePacket === "object"
    ? loop.gateSignal.acceptancePacket
    : null;
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const requestedValue = readNumber$j(requested && requested.value);
  const statsKey = readString$1H(requested && requested.statsKey) ||
    (readString$1H(requested && requested.unit) === "words" ? "words" : "chars");
  if (!requestedValue || !statsKey) return null;
  const candidateStats = packet && packet.candidate && typeof packet.candidate === "object"
    ? (packet.candidate.textStats || packet.candidate.stats)
    : null;
  const workspaceStats = readWorkspaceCandidateStats(runState);
  const observed = readNumber$j(candidateStats && candidateStats[statsKey]) ||
    readNumber$j(workspaceStats && workspaceStats[statsKey]);
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
  if (readNumber$j(workspace.version) > 0) return true;
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
  if (readString$1H(todoState.activeItemId)) return true;
  if (!Array.isArray(todoState.items)) return false;
  return todoState.items.some((item) => {
    const status = readString$1H(item && item.status);
    return status === "active" || status === "pending" || status === "blocked";
  });
}

function readSourceMinimum$2(runState) {
  const packet = readAcceptancePacket$2(runState);
  if (packet && packet.evidence && packet.evidence.sourceMinimum && typeof packet.evidence.sourceMinimum === "object") {
    return packet.evidence.sourceMinimum;
  }
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  return loop.sourceMinimum && typeof loop.sourceMinimum === "object" ? loop.sourceMinimum : null;
}

function readEvidenceMinimum(runState, sourceMinimum = readSourceMinimum$2(runState)) {
  const packet = readAcceptancePacket$2(runState);
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

function readAcceptancePacket$2(runState) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
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
  const path = readString$1H(quality && quality.finalCandidatePath) || "final_candidate.md";
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
    version: readNumber$j(workspace.version)
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

function readSuccessfulReadUrlCount$2(runState, readSources) {
  const packet = readAcceptancePacket$2(runState);
  if (packet && packet.evidence) {
    const value = readNullableNumber$7(packet.evidence.successfulReadUrlCount);
    if (value != null) return value;
  }
  const sources = Array.isArray(readSources) ? readSources : [];
  return sources.filter((source) => source && (source.ok === true || source.status === 200 || source.status === "ok")).length;
}

function readSuccessfulEvidenceCount(runState, readSources, runtimeConfig, successfulReadUrlCount) {
  const packet = readAcceptancePacket$2(runState);
  if (packet && packet.evidence) {
    const value = readNullableNumber$7(packet.evidence.successfulEvidenceCount);
    if (value != null) return value;
  }
  const policy = runtimeConfig && runtimeConfig.evidencePolicy && typeof runtimeConfig.evidencePolicy === "object"
    ? runtimeConfig.evidencePolicy
    : null;
  if (policy && policy.enabled !== false && policy.profile && policy.profile !== "web_research") {
    return countSuccessfulEvidenceArtifacts(runState, runtimeConfig);
  }
  return readNumber$j(successfulReadUrlCount != null ? successfulReadUrlCount : readSuccessfulReadUrlCount$2(runState, readSources));
}

function buildEvidenceMinimumFromSourceMinimum(sourceMinimum) {
  if (!sourceMinimum || typeof sourceMinimum !== "object") return null;
  return {
    evidenceArtifacts: readNumber$j(sourceMinimum.readSources),
    minEvidenceArtifacts: readNumber$j(sourceMinimum.minReadSources),
    minRelevantEvidenceArtifacts: readNumber$j(sourceMinimum.minRelevantSources),
    passed: sourceMinimum.passed === true,
    relevantEvidenceArtifacts: readNumber$j(sourceMinimum.relevantSources)
  };
}

function countRelevantReadSources(readSources) {
  const sources = Array.isArray(readSources) ? readSources : [];
  return sources.filter((source) => {
    const quality = readString$1H(source && source.quality);
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
    const url = readString$1H(item && (item.url || item.link || item.href));
    if (url) urls.add(url);
  }
  return urls.size;
}

function countDistinctReadUrls(readSources) {
  const urls = new Set();
  const list = Array.isArray(readSources) ? readSources : [];
  for (const item of list) {
    const url = readString$1H(item && item.url);
    if (url) urls.add(url);
  }
  return urls.size;
}

function readSkillLabel(value) {
  if (!value || typeof value !== "object") return null;
  return readString$1H(value.name) || readString$1H(value.skillId) || null;
}

function readString$1H(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber$j(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function readNullableNumber$7(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export { createProgressSnapshot$1 as createProgressSnapshot, diffProgress$1 as diffProgress, hasUnfinishedTodoState$1 as hasUnfinishedTodoState, hasWorkspaceArtifacts, normalizeProgressSnapshot$1 as normalizeProgressSnapshot, readAcceptancePacket$2 as readAcceptancePacket, readCandidateSnapshot$1 as readCandidateSnapshot, readEvidenceMinimum, readRequestedLengthStatus, readSourceMinimum$2 as readSourceMinimum, resolveProductiveProgressDimensions, summarizeProgressSnapshot };
