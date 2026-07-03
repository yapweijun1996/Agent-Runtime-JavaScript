import { cloneValue } from './utils.js';
import { WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_APPLY_PATCH_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_REPLACE_ACTION } from './action-names.js';
import { lowCycleRemainingThreshold } from './cycle-budget.js';
import { normalizeCandidatePathMismatchSignal, normalizeWorkspaceCandidateLifecycle, DEFAULT_FINAL_CANDIDATE_PATH, createWorkspaceCandidateLifecycle, recordWorkspaceCandidateRead, syncRunStateCandidatePathMismatchSignal, recordWorkspaceCandidateWrite, recordWorkspaceCandidateFinalize, recordWorkspaceCandidatePublish, projectWorkspaceCandidateLifecycle } from './workspace-candidate-lifecycle.js';
import { readString } from './semantic-json.js';
import { extractRequestedLengthContract } from './terminal-final-contract.js';

const DEFAULT_MAX_FILE_CHARS$1 = 24000;
const DEFAULT_MAX_OPERATION_CHARS = 240;
const DEFAULT_MAX_OPERATIONS = 80;
const STRUCTURE_REPAIR_SHRINK_MIN_RATIO = 0.4;
const STRUCTURE_REPAIR_SHRINK_MIN_WORDS = 250;
// ADR-0015 PR 2 — three English-only prompt regexes
// (COMPLEX_PROMPT_RE, FINAL_CANDIDATE_GATE_PROMPT_RE,
// STRICT_RESEARCH_WORKSPACE_PROMPT_RE) deleted along with the
// regex-gated veto path. Workspace activation is opt-in: explicit
// host config OR AI calling workspace_write (which forces enable).
const INTERNAL_VIRTUAL_WORKSPACE_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(virtual\s+workspace|workspace\s+(?:draft|files?|operations?|quality)|draft\s+workspace|final\s+candidate|critique\s+notes?)\s*(?:\*\*)?\s*:?\s*$/i;

function normalizeVirtualWorkspaceConfig(value) {
  if (value === false) {
    return {
      enabled: false,
      maxFileChars: DEFAULT_MAX_FILE_CHARS$1,
      maxOperations: DEFAULT_MAX_OPERATIONS,
      requirePublishPath: false
    };
  }
  const source = value && typeof value === "object" ? value : {};
  const enabled = source.enabled === false
    ? false
    : source.enabled === true
      ? true
      : "auto";
  return {
    enabled,
    maxFileChars: readPositiveInteger$o(source.maxFileChars) || DEFAULT_MAX_FILE_CHARS$1,
    maxOperations: readPositiveInteger$o(source.maxOperations) || DEFAULT_MAX_OPERATIONS,
    requirePublishPath: source.requirePublishPath === true
  };
}

function createEmptyVirtualWorkspace() {
  return createVirtualWorkspace({ enabled: false, mode: "idle" });
}

function createVirtualWorkspace(options = {}) {
  // ADR-0015 PR 2 — workspace starts empty. Reserved-path stubs are no
  // longer pre-populated; AI creates files by calling workspace_write.
  return {
    enabled: options.enabled === true,
    mode: readString(options.mode) || "complex_response",
    files: {},
    operations: [],
    pendingPatch: null,
    candidateLifecycle: createWorkspaceCandidateLifecycle({ activePath: DEFAULT_FINAL_CANDIDATE_PATH }),
    candidatePathMismatchSignal: null,
    quality: createWorkspaceQuality(),
    replaceFindFailures: {},
    version: 1
  };
}

function ensureVirtualWorkspace(runState, options = {}) {
  if (!runState || typeof runState !== "object") {
    throw new Error("virtual workspace requires runState");
  }
  const existing = normalizeVirtualWorkspace(runState.virtualWorkspace);
  const shouldEnable = shouldEnableVirtualWorkspace({
    config: options.config,
    prompt: options.prompt,
    force: options.force
  });
  if (!existing || (shouldEnable && existing.enabled !== true)) {
    runState.virtualWorkspace = createVirtualWorkspace({
      enabled: shouldEnable,
      mode: shouldEnable ? "complex_response" : "idle"
    });
    return runState.virtualWorkspace;
  }
  runState.virtualWorkspace = existing;
  return existing;
}

function normalizeVirtualWorkspace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const files = {};
  const sourceFiles = value.files && typeof value.files === "object" && !Array.isArray(value.files)
    ? value.files
    : {};
  // ADR-0015 PR 2 — iterate whatever filenames AI used. Skip security
  // violations silently (the path validator rejects them on write).
  for (const [path, source] of Object.entries(sourceFiles)) {
    if (typeof path !== "string" || !path) continue;
    if (path.startsWith("/") || path.includes("..") || /[\\]/.test(path)) continue;
    const file = source && typeof source === "object" ? source : {};
    files[path] = {
      content: readString(file.content),
      path,
      updatedAt: readString(file.updatedAt) || null,
      version: readPositiveInteger$o(file.version) || 0
    };
  }
  const quality = normalizeWorkspaceQuality(value.quality);
  return {
    enabled: value.enabled === true,
    mode: readString(value.mode) || "complex_response",
    files,
    operations: normalizeOperations(value.operations),
    pendingPatch: normalizePendingPatch(value.pendingPatch),
    candidateLifecycle: normalizeWorkspaceCandidateLifecycle(value.candidateLifecycle, {
      activePath: quality.finalCandidatePath
    }),
    candidatePathMismatchSignal: normalizeCandidatePathMismatchSignal(value.candidatePathMismatchSignal),
    quality,
    replaceFindFailures: normalizeReplaceFindFailures(value.replaceFindFailures),
    version: readPositiveInteger$o(value.version) || 1
  };
}

function normalizeReplaceFindFailures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || !key) continue;
    const count = readPositiveInteger$o(raw && raw.count) || 0;
    if (count <= 0) continue;
    out[key] = {
      count,
      lastCycle: readPositiveInteger$o(raw.lastCycle) || 0,
      findPreview: readString(raw.findPreview).slice(0, 80)
    };
  }
  return out;
}

function shouldEnableVirtualWorkspace(options = {}) {
  // ADR-0015 PR 2 — language-neutral activation gate. Workspace
  // activates only on explicit host config or `force: true` (which the
  // workspace_write action sets when AI calls it). The legacy English
  // regex on prompt was deleted; non-English prompts now activate
  // workspace identically to English ones once AI uses it.
  if (options.force === true) return true;
  const config = normalizeVirtualWorkspaceConfig(options.config);
  if (config.enabled === true) return true;
  return false;
}

function validateWorkspacePathRecoverable(path) {
  // ADR-0013 — workspace path validation is recoverable, not fatal.
  // Returns { ok, path?, error? }. Callers translate failure into an
  // invalid_args observation rather than throwing.
  const value = readString(path);
  if (!value) {
    return { ok: false, error: "workspace_path_required", path: value };
  }
  if (value.startsWith("/") || value.includes("..") || /[\\]/.test(value)) {
    return { ok: false, error: "workspace_path_not_allowed", path: value };
  }
  return { ok: true, path: value };
}

function validateWorkspacePath(path) {
  // ADR-0015 PR 2 — security-only validation. Kept as a sharp throw for
  // internal helpers and tests; the recoverable variant above is what
  // boundary helpers must call. Throwing here represents a programming
  // error (missing recoverable check upstream), not user-visible input.
  const result = validateWorkspacePathRecoverable(path);
  if (!result.ok) {
    if (result.error === "workspace_path_required") {
      throw new Error("workspace path is required");
    }
    throw new Error(`workspace path "${result.path}" is not allowed`);
  }
  return result.path;
}

function describeWorkspacePathError(error) {
  if (error === "workspace_path_required") return "workspace path is required";
  if (error === "workspace_path_not_allowed") return "workspace path is not allowed (no absolute, no '..', no backslash)";
  return "workspace path is invalid";
}

function invalidArgsResult({ action, error, message, file, extra }) {
  return {
    changed: false,
    status: "invalid_args",
    error,
    message: message || describeWorkspacePathError(error),
    file: file || null,
    action,
    ...(extra && typeof extra === "object" ? extra : {})
  };
}

function listWorkspaceFiles(workspace) {
  const source = normalizeVirtualWorkspace(workspace) || createEmptyVirtualWorkspace();
  // ADR-0015 PR 2 — list whatever AI authored. Empty workspace returns []
  // instead of 5 stub entries.
  return Object.keys(source.files)
    .sort()
    .map((path) => summarizeWorkspaceFile(source.files[path]));
}

function readWorkspaceFile(workspace, path) {
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    return addWorkspaceFileStats({
      ...createWorkspaceFile(readString(path) || "", ""),
      status: "invalid_args",
      error: pathValidation.error,
      message: describeWorkspacePathError(pathValidation.error)
    });
  }
  const filePath = pathValidation.path;
  const source = normalizeVirtualWorkspace(workspace) || createEmptyVirtualWorkspace();
  // ADR-0015 PR 2 — return an empty stub when AI has not written the
  // file yet so callers see a consistent shape regardless of whether
  // the path is present. Reserved-path conventions (final_candidate.md
  // etc.) work the same as free-form filenames.
  return addWorkspaceFileStats(cloneValue(source.files[filePath]) || createWorkspaceFile(filePath, ""));
}

function readWorkspaceFinalCandidate(workspace, path) {
  const source = normalizeVirtualWorkspace(workspace) || createEmptyVirtualWorkspace();
  const resolvedPath = readString(path) || readFinalCandidatePath(source);
  const pathValidation = validateWorkspacePathRecoverable(resolvedPath);
  if (!pathValidation.ok) {
    return addWorkspaceFileStats({
      ...createWorkspaceFile(resolvedPath || "", ""),
      status: "invalid_args",
      error: pathValidation.error,
      message: describeWorkspacePathError(pathValidation.error)
    });
  }
  const filePath = pathValidation.path;
  return addWorkspaceFileStats(cloneValue(source.files[filePath]) || createWorkspaceFile(filePath, ""));
}

function recordWorkspaceRead(runState, path, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "read",
      path: readString(path) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    return workspace;
  }
  const filePath = pathValidation.path;
  const file = readWorkspaceFile(workspace, filePath);
  workspace.quality.lastRead = {
    observedAt: new Date().toISOString(),
    path: filePath,
    textStats: file.textStats
  };
  appendWorkspaceOperation(workspace, {
    action: "read",
    path: filePath,
    status: "ok",
    summary: options.summary || `read ${filePath}`,
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  recordWorkspaceCandidateRead(workspace, filePath, { });
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return workspace;
}

function recordWorkspaceCandidateReview(runState, path, review, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "review_candidate",
      path: readString(path) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    return workspace;
  }
  const filePath = pathValidation.path;
  const file = readWorkspaceFile(workspace, filePath);
  const source = review && typeof review === "object" && !Array.isArray(review) ? review : {};
  const issues = Array.isArray(source.issues)
    ? source.issues.map(normalizeCandidateReviewIssue).filter(Boolean).slice(0, 24)
    : [];
  const candidateReview = {
    fileUpdatedAt: readString(file.updatedAt) || null,
    fileVersion: readPositiveInteger$o(file.version) || 0,
    finalSectionTitle: readString(source.finalSectionTitle) || null,
    issueCount: issues.length,
    issues,
    path: filePath,
    readyToPublish: source.readyToPublish === true,
    repairPlan: readString(source.repairPlan) || null,
    requirementsChecklist: normalizeCandidateRequirementsChecklist(source.requirementsChecklist),
    reviewedAt: new Date().toISOString(),
    summary: readString(source.summary) || null,
    textStats: file.textStats || summarizeTextStats$2(file.content)
  };
  workspace.quality.candidateReview = candidateReview;
  appendWorkspaceOperation(workspace, {
    action: "review_candidate",
    path: filePath,
    status: "ok",
    summary: candidateReview.summary || options.summary || `reviewed ${filePath}`,
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  return workspace;
}

function recordWorkspacePublishCandidateLifecycle(runState, path, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    syncRunStateCandidatePathMismatchSignal(runState, workspace);
    return null;
  }
  const signal = recordWorkspaceCandidatePublish(workspace, pathValidation.path, {
    action: "publish_candidate",
    completed: options.completed === true,
    lastWrittenPath: options.lastWrittenPath
  });
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return signal;
}

function writeWorkspaceFile(runState, path, content, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "write",
      path: readString(path) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return {
      ...createWorkspaceFile(readString(path) || "", ""),
      status: "invalid_args",
      error: pathValidation.error,
      message: describeWorkspacePathError(pathValidation.error)
    };
  }
  const filePath = pathValidation.path;
  const maxFileChars = readPositiveInteger$o(options.maxFileChars) || DEFAULT_MAX_FILE_CHARS$1;
  const nextContent = truncate$3(readString(content), maxFileChars);
  const file = workspace.files[filePath] || createWorkspaceFile(filePath, "");
  const shrinkRisk = detectDestructiveWriteShrink(runState, workspace, filePath, file, nextContent, options);
  if (shrinkRisk) {
    appendWorkspaceOperation(workspace, {
      action: "write",
      path: filePath,
      status: "destructive_shrink_blocked",
      summary: options.summary || `blocked shrink write for ${filePath}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0}, options);
    refreshWorkspaceQuality(workspace);
    syncRunStateCandidatePathMismatchSignal(runState, workspace);
    return {
      ...addWorkspaceFileStats(file),
      message: "workspace_write refused to replace a substantial final candidate with much shorter content. Use workspace_insert_after_section, workspace_replace, workspace_multi_edit, or workspace_propose_patch for targeted repair.",
      shrinkRisk,
      status: "destructive_shrink_blocked"
    };
  }
  workspace.files[filePath] = {
    content: nextContent,
    path: filePath,
    updatedAt: new Date().toISOString(),
    version: (readPositiveInteger$o(file.version) || 0) + 1
  };
  workspace.version += 1;
  appendWorkspaceOperation(workspace, {
    action: "write",
    path: filePath,
    status: "ok",
    summary: options.summary || `wrote ${filePath}`,
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  recordWorkspaceCandidateWrite(workspace, filePath, { action: "write" });
  refreshWorkspaceQuality(workspace);
  syncWorkspaceLastReadToFile(workspace, workspace.files[filePath]);
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return workspace.files[filePath];
}

function detectDestructiveWriteShrink(runState, workspace, filePath, file, nextContent, options = {}) {
  const quality = workspace && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : {};
  const finalCandidatePath = readString(quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  if (filePath !== finalCandidatePath) return null;
  const current = readString(file && file.content);
  if (!current) return null;
  const before = summarizeTextStats$2(current);
  const after = summarizeTextStats$2(nextContent);
  const beforeSize = Math.max(before.nonWhitespaceChars, before.cjkChars, before.words);
  const afterSize = Math.max(after.nonWhitespaceChars, after.cjkChars, after.words);
  const requestedLength = readRequestedLengthForWorkspace(runState, options);
  const requestedRegression = detectRequestedLengthRegression(before, after, requestedLength);
  if (requestedRegression) {
    return requestedRegression;
  }
  if (beforeSize < 1500) return null;
  if (afterSize >= beforeSize * 0.75) return null;
  const beforeStructure = inspectWorkspaceCandidateStructure(current);
  const afterStructure = inspectWorkspaceCandidateStructure(nextContent);
  if (shouldAllowStructureRepairShrinkWrite({
    afterStats: after,
    afterStructure,
    beforeStats: before,
    beforeStructure,
    requestedLength
  })) {
    return null;
  }
  return {
    afterSize,
    beforeSize,
    ratio: Number((afterSize / beforeSize).toFixed(3)),
    reason: "final_candidate_destructive_shrink"
  };
}

function shouldAllowStructureRepairShrinkWrite({
  afterStats,
  afterStructure,
  beforeStats,
  beforeStructure,
  requestedLength
}) {
  if (!hasContentStructureIssue(beforeStructure)) return false;
  if (!isStructureImproved(beforeStructure, afterStructure)) return false;
  const afterIssueCodes = Array.isArray(afterStructure && afterStructure.issueCodes)
    ? afterStructure.issueCodes.map(readString).filter(Boolean)
    : [];
  if (afterIssueCodes.includes("duplicate_headings") ||
    afterIssueCodes.includes("semantic_duplicate_headings") ||
    afterIssueCodes.includes("body_after_final_section")) {
    return false;
  }
  const beforeWords = readPositiveInteger$o(beforeStats && beforeStats.words) || 0;
  const afterWords = readPositiveInteger$o(afterStats && afterStats.words) || 0;
  if (isRequestedLengthRegression({
    afterStats,
    beforeStats,
    requestedLength
  })) {
    return false;
  }
  if (beforeWords > 0 && afterWords < beforeWords * STRUCTURE_REPAIR_SHRINK_MIN_RATIO) return false;
  if (beforeWords >= STRUCTURE_REPAIR_SHRINK_MIN_WORDS && afterWords < STRUCTURE_REPAIR_SHRINK_MIN_WORDS) return false;
  return true;
}

function isRequestedLengthRegression({ afterStats, beforeStats, requestedLength }) {
  const requested = readPositiveInteger$o(requestedLength && requestedLength.value) || 0;
  const statsKey = readString(requestedLength && requestedLength.statsKey) || "words";
  if (!requested || !statsKey) return false;
  const before = readPositiveInteger$o(beforeStats && beforeStats[statsKey]) || 0;
  const after = readPositiveInteger$o(afterStats && afterStats[statsKey]) || 0;
  if (!before || !after) return false;
  const wasNearTarget = before >= Math.floor(requested * 0.95);
  if (!wasNearTarget) return false;
  return after < requested;
}

function detectRequestedLengthRegression(beforeStats, afterStats, requestedLength) {
  const requested = readPositiveInteger$o(requestedLength && requestedLength.value) || 0;
  const statsKey = readString(requestedLength && requestedLength.statsKey) || "words";
  if (!requested || !statsKey) return null;
  const before = readPositiveInteger$o(beforeStats && beforeStats[statsKey]) || 0;
  const after = readPositiveInteger$o(afterStats && afterStats[statsKey]) || 0;
  if (!before || !after) return null;
  const wasNearTarget = before >= Math.floor(requested * 0.95);
  const becameDeficit = after < requested;
  const materialDrop = after <= Math.floor(before * 0.9);
  if (!wasNearTarget || !becameDeficit || !materialDrop) return null;
  return {
    afterSize: after,
    beforeSize: before,
    ratio: Number((after / before).toFixed(3)),
    reason: "requested_length_regression",
    requestedLength: requested,
    statsKey
  };
}

function readRequestedLengthForWorkspace(runState, options = {}) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  const directPacket = loop && loop.acceptancePacket && typeof loop.acceptancePacket === "object"
    ? loop.acceptancePacket
    : null;
  const gateSignal = loop && loop.gateSignal && typeof loop.gateSignal === "object"
    ? loop.gateSignal
    : null;
  const gatedPacket = gateSignal && gateSignal.acceptancePacket && typeof gateSignal.acceptancePacket === "object"
    ? gateSignal.acceptancePacket
    : null;
  const packet = directPacket || gatedPacket;
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const value = readPositiveInteger$o(requested && requested.value) || 0;
  if (value) {
    const unit = readString(requested && requested.unit);
    const statsKey = readString(requested && requested.statsKey) ||
      (unit === "words" ? "words" : unit === "cjk_chars" ? "cjkChars" : unit === "chars" ? "chars" : "");
    return {
      statsKey: statsKey || "words",
      value
    };
  }
  const promptRequested = extractRequestedLengthContract(readString(options.prompt));
  if (!promptRequested) return null;
  return {
    statsKey: readString(promptRequested.statsKey) || "words",
    value: readPositiveInteger$o(promptRequested.value) || 0
  };
}

function insertAfterWorkspaceSection(runState, path, heading, content, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "insert_after_section",
      path: readString(path) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return invalidArgsResult({
      action: "insert_after_section",
      error: pathValidation.error,
      file: null,
      extra: { availableHeadings: [], requestedHeading: null }
    });
  }
  const filePath = pathValidation.path;
  const targetHeading = normalizeInsertableSectionText(heading);
  if (!targetHeading) {
    appendWorkspaceOperation(workspace, {
      action: "insert_after_section",
      path: filePath,
      status: "invalid_args",
      summary: options.summary || `heading is empty for ${filePath}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return invalidArgsResult({
      action: "insert_after_section",
      error: "non_empty_heading_required",
      message: "workspace_insert_after_section requires a non-empty heading",
      file: workspace.files[filePath] || null,
      extra: { availableHeadings: [], requestedHeading: null }
    });
  }
  const file = workspace.files[filePath] || createWorkspaceFile(filePath, "");
  const current = readString(file.content);
  const addition = readString(content);
  const insertResult = insertAfterMarkdownSection(current, targetHeading, addition, options);
  const beforeStructure = inspectWorkspaceCandidateStructure(current);
  const afterStructure = inspectWorkspaceCandidateStructure(insertResult.content);
  const finalCandidatePath = readString(workspace.quality && workspace.quality.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const structureRisk = insertResult.changed && filePath === finalCandidatePath && isStructureMaybeWorse(beforeStructure, afterStructure)
    ? "structure_maybe_worse"
    : null;
  const maxFileChars = readPositiveInteger$o(options.maxFileChars) || DEFAULT_MAX_FILE_CHARS$1;
  workspace.files[filePath] = {
    content: truncate$3(insertResult.content, maxFileChars),
    path: filePath,
    updatedAt: insertResult.changed ? new Date().toISOString() : file.updatedAt || null,
    version: insertResult.changed ? (readPositiveInteger$o(file.version) || 0) + 1 : readPositiveInteger$o(file.version) || 0
  };
  if (insertResult.changed) {
    workspace.version += 1;
  }
  appendWorkspaceOperation(workspace, {
    action: "insert_after_section",
    path: filePath,
    status: insertResult.changed
      ? "ok"
      : readString(insertResult.status) === "ambiguous" ? "ambiguous" : "not_found",
    summary: options.summary || (insertResult.changed
      ? `inserted after ${heading} in ${filePath}`
      : readString(insertResult.message) || `section not found in ${filePath}`),
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  if (insertResult.changed) {
    recordWorkspaceCandidateWrite(workspace, filePath, { action: "insert_after_section" });
  }
  refreshWorkspaceQuality(workspace);
  if (insertResult.changed) {
    syncWorkspaceLastReadToFile(workspace, workspace.files[filePath]);
  }
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return {
    changed: insertResult.changed,
    status: insertResult.changed ? "ok" : readString(insertResult.status) || "heading_not_found",
    availableHeadings: Array.isArray(insertResult.availableHeadings) ? insertResult.availableHeadings : [],
    requestedHeading: targetHeading,
    file: workspace.files[filePath],
    heading: targetHeading,
    matchCount: typeof insertResult.matchCount === "number" ? insertResult.matchCount : null,
    message: readString(insertResult.message) || null,
    structureRisk,
    structureAfter: summarizePatchStructure(afterStructure),
    structureBefore: summarizePatchStructure(beforeStructure)
  };
}

function removeWorkspaceFile(runState, path, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "remove",
      path: readString(path) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return {
      removed: false,
      status: "invalid_args",
      error: pathValidation.error,
      message: describeWorkspacePathError(pathValidation.error),
      file: { ...createWorkspaceFile(readString(path) || "", "") }
    };
  }
  const filePath = pathValidation.path;
  const file = workspace.files[filePath] || createWorkspaceFile(filePath, "");
  const hadContent = readString(file.content).length > 0;
  workspace.files[filePath] = createWorkspaceFile(filePath, "");
  if (hadContent) {
    workspace.version += 1;
  }
  appendWorkspaceOperation(workspace, {
    action: "remove",
    path: filePath,
    status: hadContent ? "ok" : "noop",
    summary: options.summary || (hadContent ? `removed ${filePath}` : `${filePath} already empty`),
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  refreshWorkspaceQuality(workspace);
  return { removed: hadContent, file: workspace.files[filePath] };
}

function moveWorkspaceFile(runState, from, to, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const fromValidation = validateWorkspacePathRecoverable(from);
  if (!fromValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "move",
      path: readString(from) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(fromValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return { moved: false, status: "invalid_args", error: fromValidation.error, message: describeWorkspacePathError(fromValidation.error), fromFile: null, toFile: null };
  }
  const toValidation = validateWorkspacePathRecoverable(to);
  if (!toValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "move",
      path: fromValidation.path,
      status: "invalid_args",
      summary: options.summary || `destination: ${describeWorkspacePathError(toValidation.error)}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return { moved: false, status: "invalid_args", error: toValidation.error, message: `destination: ${describeWorkspacePathError(toValidation.error)}`, fromFile: null, toFile: null };
  }
  const fromPath = fromValidation.path;
  const toPath = toValidation.path;
  if (fromPath === toPath) {
    appendWorkspaceOperation(workspace, {
      action: "move",
      path: fromPath,
      status: "same_path",
      summary: options.summary || `source and destination are the same: ${fromPath}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return { moved: false, status: "same_path", error: "same_path", message: `workspace_move source and destination are the same: ${fromPath}`, fromFile: workspace.files[fromPath] || null, toFile: null };
  }
  const fromFile = workspace.files[fromPath] || createWorkspaceFile(fromPath, "");
  const sourceContent = readString(fromFile.content);
  if (!sourceContent) {
    appendWorkspaceOperation(workspace, {
      action: "move",
      path: fromPath,
      status: "source_not_found",
      summary: options.summary || `source ${fromPath} has no content`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return { moved: false, status: "source_not_found", error: "source_not_found", message: `workspace_move source ${fromPath} has no content`, fromFile: workspace.files[fromPath] || null, toFile: null };
  }
  const toFile = workspace.files[toPath] || createWorkspaceFile(toPath, "");
  if (readString(toFile.content) && options.overwrite !== true) {
    appendWorkspaceOperation(workspace, {
      action: "move",
      path: fromPath,
      status: "target_exists",
      summary: options.summary || `target ${toPath} already has content`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return { moved: false, status: "target_exists", error: "target_exists", message: `workspace_move target ${toPath} already has content; pass overwrite:true to replace it`, fromFile: workspace.files[fromPath] || null, toFile: workspace.files[toPath] || null };
  }
  const now = new Date().toISOString();
  workspace.files[toPath] = {
    content: sourceContent,
    path: toPath,
    updatedAt: now,
    version: (readPositiveInteger$o(toFile.version) || 0) + 1
  };
  workspace.files[fromPath] = createWorkspaceFile(fromPath, "");
  workspace.version += 1;
  appendWorkspaceOperation(workspace, {
    action: "move",
    path: fromPath,
    status: "ok",
    summary: options.summary || `moved ${fromPath} → ${toPath}`,
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  recordWorkspaceCandidateWrite(workspace, toPath, { action: "move" });
  refreshWorkspaceQuality(workspace);
  syncWorkspaceLastReadToFile(workspace, workspace.files[toPath]);
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return { moved: true, status: "ok", fromFile: workspace.files[fromPath], toFile: workspace.files[toPath] };
}

function replaceWorkspaceFile(runState, path, find, replace, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "replace",
      path: readString(path) || "<unset>",
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return invalidArgsResult({
      action: "replace",
      error: pathValidation.error,
      file: null,
      extra: { matchCount: 0, fuzzyAttempted: [] }
    });
  }
  const filePath = pathValidation.path;
  // Use raw (un-trimmed) text for find / replacement / current so the
  // fuzzy fallback ladder below can detect trailing-whitespace and
  // smart-quote drift in AI-emitted find strings. readString trims by
  // contract, which would defeat fuzzy detection.
  const needle = typeof find === "string" ? find : "";
  if (!needle.trim()) {
    appendWorkspaceOperation(workspace, {
      action: "replace",
      path: filePath,
      status: "invalid_args",
      summary: options.summary || `find text is empty or whitespace-only for ${filePath}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return invalidArgsResult({
      action: "replace",
      error: "non_empty_find_text_required",
      message: "workspace_replace requires non-empty find text",
      file: workspace.files[filePath] || null,
      extra: { matchCount: 0, fuzzyAttempted: [] }
    });
  }
  const file = workspace.files[filePath] || createWorkspaceFile(filePath, "");
  const current = typeof file.content === "string" ? file.content : "";
  const replacement = typeof replace === "string" ? replace : "";
  const replaceAll = options.replaceAll === true;

  const fuzzy = locateWorkspaceFindText(current, needle);
  if (!fuzzy.found) {
    appendWorkspaceOperation(workspace, {
      action: "replace",
      path: filePath,
      status: "not_found",
      summary: options.summary || `find text not found in ${filePath}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    // Track repeated not_found on the same find string within one run. After
    // two failures with the same needle, missHints clearly was not enough —
    // escalate to a veto status so the executor can steer the AI to
    // workspace_propose_patch (diff channel) instead of guessing find again.
    const failureMap = workspace.replaceFindFailures = workspace.replaceFindFailures || {};
    const findKey = makeReplaceFindKey(needle, filePath);
    const prior = failureMap[findKey] || { count: 0, findPreview: needle.slice(0, 80) };
    prior.count += 1;
    prior.lastCycle = readPositiveInteger$o(runState && runState.cycleCount) || 0;
    failureMap[findKey] = prior;
    const status = prior.count >= 2 ? "repeated_find_vetoed" : "not_found";
    return {
      changed: false,
      status,
      matchCount: 0,
      fuzzyAttempted: fuzzy.attempted,
      missHints: computeReplaceMissHints(current, needle),
      repeatedFindCount: prior.count,
      file: workspace.files[filePath] || file
    };
  }

  if (fuzzy.matchCount > 1 && !replaceAll) {
    appendWorkspaceOperation(workspace, {
      action: "replace",
      path: filePath,
      status: "ambiguous",
      summary: options.summary || `find text matches ${fuzzy.matchCount} occurrences in ${filePath}`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return {
      changed: false,
      status: "ambiguous",
      matchCount: fuzzy.matchCount,
      fuzzyMatch: fuzzy.fallback || null,
      contextSnippets: extractMatchContextSnippets(current, fuzzy.needle, fuzzy.matchCount),
      file: workspace.files[filePath] || file
    };
  }

  const next = current.split(fuzzy.needle).join(replacement);
  const maxFileChars = readPositiveInteger$o(options.maxFileChars) || DEFAULT_MAX_FILE_CHARS$1;
  workspace.files[filePath] = {
    content: truncate$3(next, maxFileChars),
    path: filePath,
    updatedAt: new Date().toISOString(),
    version: (readPositiveInteger$o(file.version) || 0) + 1
  };
  workspace.version += 1;
  appendWorkspaceOperation(workspace, {
    action: "replace",
    path: filePath,
    status: "ok",
    summary: options.summary || (fuzzy.matchCount > 1
      ? `replaced ${fuzzy.matchCount} occurrences in ${filePath}`
      : `replaced text in ${filePath}`),
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  recordWorkspaceCandidateWrite(workspace, filePath, { action: "replace" });
  refreshWorkspaceQuality(workspace);
  syncWorkspaceLastReadToFile(workspace, workspace.files[filePath]);
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return {
    changed: true,
    status: "ok",
    matchCount: fuzzy.matchCount,
    replacedAll: fuzzy.matchCount > 1,
    fuzzyMatch: fuzzy.fallback || null,
    file: workspace.files[filePath]
  };
}

function proposeWorkspacePatch(runState, path, operations, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pathValidation = validateWorkspacePathRecoverable(path);
  if (!pathValidation.ok) {
    const patch = createInvalidPendingPatch({
      path: readString(path) || "",
      status: "invalid_args",
      riskFlags: ["not_found"],
      message: describeWorkspacePathError(pathValidation.error)
    });
    workspace.pendingPatch = patch;
    return { ...patch, beforeContent: "", afterContent: "" };
  }
  const filePath = pathValidation.path;
  const file = workspace.files[filePath] || createWorkspaceFile(filePath, "");
  const current = typeof file.content === "string" ? file.content : "";
  const operationList = normalizePatchOperations(operations);
  const preview = previewWorkspacePatchContent(current, operationList, options);
  const maxFileChars = readPositiveInteger$o(options.maxFileChars) || DEFAULT_MAX_FILE_CHARS$1;
  const afterContent = truncate$3(preview.content, maxFileChars);
  const beforeStats = summarizeTextStats$2(current);
  const afterStats = summarizeTextStats$2(afterContent);
  const beforeStructure = inspectWorkspaceCandidateStructure(current);
  const afterStructure = inspectWorkspaceCandidateStructure(afterContent);
  const structureImproved = isStructureImproved(beforeStructure, afterStructure);
  const structureRepairOperation = operationList.some((operation) => operation && operation.type === "normalize_headings");
  const headingOnlyStructureRepair = operationList.length > 0 &&
    operationList.every((operation) => operation && operation.type === "normalize_headings");
  const contentStructureIssueStillOpen = headingOnlyStructureRepair &&
    hasContentStructureIssue(beforeStructure) &&
    hasContentStructureIssue(afterStructure);
  const changed = current !== afterContent;
  const riskFlags = Array.from(new Set([
    ...preview.riskFlags,
    ...(changed ? [] : ["no_growth"]),
    ...(afterStats.words <= beforeStats.words && !(structureRepairOperation && structureImproved) ? ["no_growth"] : []),
    ...(afterStats.words < beforeStats.words ? ["shrinks_candidate"] : []),
    ...(contentStructureIssueStillOpen ? ["content_structure_not_repaired"] : []),
    ...(isStructureMaybeWorse(beforeStructure, afterStructure) ? ["structure_maybe_worse"] : [])
  ])).filter(Boolean);
  const valid = changed && !riskFlags.some((flag) => (
    flag === "not_found" ||
    flag === "ambiguous" ||
    flag === "no_growth" ||
    flag === "content_structure_not_repaired" ||
    flag === "structure_maybe_worse"
  ));
  const patch = {
    afterHash: hashText(afterContent),
    afterWords: afterStats.words,
    baseVersion: readPositiveInteger$o(file.version) || 0,
    beforeHash: hashText(current),
    beforeHashFuzzy: hashText(fuzzyNormalizeContent(current)),
    beforeWords: beforeStats.words,
    changed,
    createdAt: new Date().toISOString(),
    deltaWords: afterStats.words - beforeStats.words,
    kind: "virtual_workspace_pending_patch",
    operations: operationList.map(summarizePatchOperation),
    patchId: `patch-${Date.now()}-${Math.max(1, (workspace.operations || []).length + 1)}`,
    path: filePath,
    previewSummary: summarizePatchPreview(operationList, {
      afterStats,
      afterStructure,
      beforeStats,
      beforeStructure,
      changed,
      riskFlags
    }),
    riskFlags,
    structureAfter: summarizePatchStructure(afterStructure),
    structureBefore: summarizePatchStructure(beforeStructure),
    status: valid ? "preview_ready" : "preview_blocked",
    valid,
    version: 1,
    // Stored internally so apply is version-locked to the exact preview.
    afterContent
  };
  workspace.pendingPatch = patch;
  return { ...patch, beforeContent: current, afterContent };
}

function applyWorkspacePatch(runState, patchId, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const pending = normalizePendingPatch(workspace.pendingPatch);
  if (!pending) {
    return {
      changed: false,
      error: "pending_patch_missing",
      file: null,
      message: "workspace_apply_patch requires a valid pending patch from workspace_propose_patch.",
      patchId: readString(patchId) || null,
      status: "missing_pending_patch"
    };
  }
  const requestedPatchId = readString(patchId);
  if (requestedPatchId && requestedPatchId !== pending.patchId) {
    return {
      changed: false,
      error: "patch_id_mismatch",
      expectedPatchId: pending.patchId,
      file: null,
      message: `workspace_apply_patch patchId mismatch: latest pending patch is ${pending.patchId}.`,
      patchId: requestedPatchId,
      status: "patch_id_mismatch"
    };
  }
  if (pending.valid !== true) {
    return {
      changed: false,
      error: "pending_patch_invalid",
      file: null,
      message: "workspace_apply_patch refused because the pending preview has blocking riskFlags.",
      patchId: pending.patchId,
      riskFlags: pending.riskFlags,
      status: "pending_patch_invalid"
    };
  }
  const file = workspace.files[pending.path] || createWorkspaceFile(pending.path, "");
  const current = typeof file.content === "string" ? file.content : "";
  const currentVersion = readPositiveInteger$o(file.version) || 0;
  const exactMatch = currentVersion === pending.baseVersion && hashText(current) === pending.beforeHash;
  const fuzzyMatch = !exactMatch && typeof pending.beforeHashFuzzy === "string"
    && hashText(fuzzyNormalizeContent(current)) === pending.beforeHashFuzzy;
  if (!exactMatch && !fuzzyMatch) {
    return {
      baseVersion: pending.baseVersion,
      changed: false,
      currentVersion,
      error: "base_version_changed",
      file: addWorkspaceFileStats(file),
      message: `workspace_apply_patch refused because ${pending.path} changed after preview. Run workspace_propose_patch again against the latest file.`,
      patchId: pending.patchId,
      status: "base_version_changed"
    };
  }
  const afterContent = typeof pending.afterContent === "string" ? pending.afterContent : "";
  if (!afterContent || hashText(afterContent) !== pending.afterHash) {
    return {
      changed: false,
      error: "pending_patch_preview_invalid",
      file: addWorkspaceFileStats(file),
      message: "workspace_apply_patch refused because the stored preview is no longer valid.",
      patchId: pending.patchId,
      status: "pending_patch_preview_invalid"
    };
  }
  workspace.files[pending.path] = {
    content: afterContent,
    path: pending.path,
    updatedAt: new Date().toISOString(),
    version: currentVersion + 1
  };
  workspace.version += 1;
  appendWorkspaceOperation(workspace, {
    action: "apply_patch",
    path: pending.path,
    status: "ok",
    summary: options.summary || `applied ${pending.patchId} to ${pending.path}`,
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  recordWorkspaceCandidateWrite(workspace, pending.path, { action: "apply_patch" });
  workspace.pendingPatch = null;
  refreshWorkspaceQuality(workspace);
  syncWorkspaceLastReadToFile(workspace, workspace.files[pending.path]);
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return {
    baseVersion: pending.baseVersion,
    changed: true,
    file: workspace.files[pending.path],
    fuzzyApplied: fuzzyMatch === true,
    patchId: pending.patchId,
    riskFlags: pending.riskFlags,
    status: "ok"
  };
}

function publishWorkspaceEvent(runState, event) {
  const bus = runState && runState._workspaceBus;
  if (!bus || typeof bus.emit !== "function") return;
  bus.emit({
    ...event,
    timestamp: new Date().toISOString(),
    runId: (runState && typeof runState.runId === "string") ? runState.runId : undefined,
    sessionId: (runState && typeof runState.sessionId === "string") ? runState.sessionId : undefined
  });
}

// Per-path promise-chain mutex. Serializes concurrent mutations to the same
// workspace path. Returns a Promise that resolves to a release() function.
// Callers must call release() in a finally block after completing their write.
// The lock map lives on runState (stable across ensureVirtualWorkspace calls)
// under the non-enumerable _workspaceLocks key so it survives normalization.
function acquireWorkspaceMutex(runState, path) {
  if (!runState || typeof runState !== "object") {
    return Promise.resolve(() => undefined);
  }
  const key = typeof path === "string" ? path : "";
  if (!Object.prototype.hasOwnProperty.call(runState, "_workspaceLocks") || !(runState._workspaceLocks instanceof Map)) {
    runState._workspaceLocks = new Map();
  }
  const locks = runState._workspaceLocks;
  const tail = locks.get(key) || Promise.resolve();
  let release;
  const slot = new Promise((resolve) => { release = resolve; });
  locks.set(key, tail.then(() => slot));
  return tail.then(() => release);
}

function createInvalidPendingPatch(options = {}) {
  return {
    afterHash: hashText(""),
    afterWords: 0,
    baseVersion: 0,
    beforeHash: hashText(""),
    beforeWords: 0,
    changed: false,
    createdAt: new Date().toISOString(),
    deltaWords: 0,
    kind: "virtual_workspace_pending_patch",
    operations: [],
    patchId: `patch-${Date.now()}-invalid`,
    path: readString(options.path),
    previewSummary: readString(options.message) || "Patch preview could not be created.",
    riskFlags: Array.isArray(options.riskFlags) ? options.riskFlags.map(readString).filter(Boolean) : [],
    structureAfter: summarizePatchStructure(inspectWorkspaceCandidateStructure("")),
    structureBefore: summarizePatchStructure(inspectWorkspaceCandidateStructure("")),
    status: readString(options.status) || "preview_blocked",
    valid: false,
    version: 1,
    afterContent: ""
  };
}

function normalizeHeadingPatchEntries(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
      const lineNumber = readPositiveInteger$o(source.lineNumber || source.line || source.atLine);
      const text = typeof source.text === "string"
        ? source.text
        : (typeof source.heading === "string" ? source.heading : "");
      if (lineNumber == null || lineNumber <= 0 || !text.trim()) return null;
      return {
        lineNumber,
        text
      };
    })
    .filter(Boolean)
    .slice(0, 24);
}

function normalizePatchOperations(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((operation) => {
      const op = operation && typeof operation === "object" && !Array.isArray(operation) ? operation : {};
      const type = readString(op.type || op.operation || op.action);
      if (type === "replace") {
        return {
          type,
          find: typeof op.find === "string" ? op.find : "",
          replace: typeof op.replace === "string" ? op.replace : "",
          replace_all: op.replace_all === true
        };
      }
      if (type === "append") {
        return {
          type,
          content: typeof op.content === "string" ? op.content : "",
          separator: typeof op.separator === "string" ? op.separator : undefined
        };
      }
      if (type === "insert_after_section") {
        return {
          type,
          content: typeof op.content === "string" ? op.content : "",
          heading: typeof op.heading === "string" ? op.heading : "",
          separator: typeof op.separator === "string" ? op.separator : undefined
        };
      }
      if (type === "normalize_headings") {
        return {
          type,
          headings: normalizeHeadingPatchEntries(op.headings || op.changes || op.items)
        };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function previewWorkspacePatchContent(current, operations, options = {}) {
  let content = typeof current === "string" ? current : "";
  const riskFlags = [];
  const diagnostics = [];
  if (!Array.isArray(operations) || operations.length === 0) {
    return { content, riskFlags: ["not_found"], diagnostics: [{ status: "invalid_args", type: "none" }] };
  }
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue;
    if (operation.type === "replace") {
      const needle = typeof operation.find === "string" ? operation.find : "";
      if (!needle.trim()) {
        riskFlags.push("not_found");
        diagnostics.push({ status: "invalid_args", type: operation.type });
        continue;
      }
      const fuzzy = locateWorkspaceFindText(content, needle);
      if (!fuzzy.found) {
        riskFlags.push("not_found");
        diagnostics.push({ status: "not_found", type: operation.type, matchCount: 0 });
        continue;
      }
      if (fuzzy.matchCount > 1 && operation.replace_all !== true) {
        riskFlags.push("ambiguous");
        diagnostics.push({ status: "ambiguous", type: operation.type, matchCount: fuzzy.matchCount });
        continue;
      }
      content = content.split(fuzzy.needle).join(typeof operation.replace === "string" ? operation.replace : "");
      diagnostics.push({ status: "ok", type: operation.type, matchCount: fuzzy.matchCount });
      continue;
    }
    if (operation.type === "append") {
      const addition = readString(operation.content);
      if (!addition) {
        riskFlags.push("no_growth");
        diagnostics.push({ status: "empty_content", type: operation.type });
        continue;
      }
      const separator = readWorkspaceAppendSeparator(operation.separator);
      content = content && addition ? `${content}${separator}${addition}` : content || addition;
      diagnostics.push({ status: "ok", type: operation.type });
      continue;
    }
    if (operation.type === "insert_after_section") {
      const targetHeading = normalizeInsertableSectionText(operation.heading);
      const addition = readString(operation.content);
      if (!targetHeading || !addition) {
        riskFlags.push("not_found");
        diagnostics.push({ status: "invalid_args", type: operation.type });
        continue;
      }
      const headingMatches = collectMarkdownHeadings(content)
        .filter((heading) => heading && heading.text === targetHeading);
      if (headingMatches.length > 1) {
        riskFlags.push("ambiguous");
        diagnostics.push({ status: "ambiguous", type: operation.type, matchCount: headingMatches.length });
        continue;
      }
      const insertResult = insertAfterMarkdownSection(content, targetHeading, addition, options);
      if (!insertResult.changed) {
        riskFlags.push("not_found");
        diagnostics.push({ status: "heading_not_found", type: operation.type, matchCount: 0 });
        continue;
      }
      content = insertResult.content;
      diagnostics.push({ status: "ok", type: operation.type, matchCount: 1 });
      continue;
    }
    if (operation.type === "normalize_headings") {
      const normalizeResult = applyNormalizeHeadingsPatch(content, operation);
      if (!normalizeResult.changed) {
        riskFlags.push(normalizeResult.status === "not_found" ? "not_found" : "no_growth");
        diagnostics.push({
          status: normalizeResult.status,
          type: operation.type,
          changedCount: normalizeResult.changedCount
        });
        continue;
      }
      content = normalizeResult.content;
      diagnostics.push({
        status: "ok",
        type: operation.type,
        changedCount: normalizeResult.changedCount
      });
    }
  }
  return { content, diagnostics, riskFlags };
}

function summarizePatchOperation(operation) {
  if (!operation || typeof operation !== "object") return null;
  const type = readString(operation.type);
  if (!type) return null;
  if (type === "replace") {
    return {
      type,
      findChars: typeof operation.find === "string" ? operation.find.length : 0,
      replaceChars: typeof operation.replace === "string" ? operation.replace.length : 0,
      replace_all: operation.replace_all === true
    };
  }
  if (type === "append") {
    return {
      type,
      contentChars: typeof operation.content === "string" ? operation.content.length : 0
    };
  }
  if (type === "insert_after_section") {
    return {
      type,
      contentChars: typeof operation.content === "string" ? operation.content.length : 0,
      heading: normalizeInsertableSectionText(operation.heading)
    };
  }
  if (type === "normalize_headings") {
    return {
      type,
      headingCount: Array.isArray(operation.headings) ? operation.headings.length : 0,
      lineNumbers: Array.isArray(operation.headings)
        ? operation.headings.map((entry) => readPositiveInteger$o(entry && entry.lineNumber)).filter((lineNumber) => lineNumber != null).slice(0, 12)
        : []
    };
  }
  return { type };
}

function summarizePatchPreview(operations, facts) {
  const opTypes = (Array.isArray(operations) ? operations : []).map((operation) => readString(operation && operation.type)).filter(Boolean);
  const beforeWords = facts && facts.beforeStats ? facts.beforeStats.words : 0;
  const afterWords = facts && facts.afterStats ? facts.afterStats.words : 0;
  const riskFlags = Array.isArray(facts && facts.riskFlags) ? facts.riskFlags : [];
  const structure = facts && facts.afterStructure ? facts.afterStructure.status : "unknown";
  return [
    `operations=${opTypes.join("+") || "none"}`,
    `words=${beforeWords}->${afterWords}`,
    `deltaWords=${afterWords - beforeWords}`,
    `changed=${facts && facts.changed ? "yes" : "no"}`,
    `structure=${structure}`,
    `riskFlags=${riskFlags.length ? riskFlags.join(",") : "none"}`
  ].join("; ");
}

// Runtime-deterministic duplicate-section-number auto-fix. Composes a
// normalize_headings operation from inspectWorkspaceCandidateStructure's
// sectionNumberRepairHints (which already runs a next-available-number
// algorithm), then applies it via applyNormalizeHeadingsPatch. Returns
// { changed: false } when there's nothing to do or when the file has issues
// other than duplicate_section_numbers (those need AI repair).
function tryAutoNormalizeSectionNumbers(content, filePath) {
  const text = readString(content);
  if (!text) return { changed: false, changedCount: 0, content: text };
  const structure = inspectWorkspaceCandidateStructure(text);
  if (!structure || structure.ok === true) {
    return { changed: false, changedCount: 0, content: text };
  }
  const issueCodes = Array.isArray(structure.issueCodes) ? structure.issueCodes : [];
  // Auto-fixable codes (all pure AST renumber work). Mixing with anything
  // else (duplicate_headings — same title twice may be intentional,
  // raw_prompt_title — needs LLM) bails out
  // because the AI still has content work to do and we don't want to mask
  // that by mechanically renumbering and falsely flipping ok=true.
  const AUTO_FIXABLE = new Set([
    "duplicate_section_numbers",
    "non_monotonic_section_numbers",
    "gapped_section_numbers"
  ]);
  if (issueCodes.length === 0 || issueCodes.some((code) => !AUTO_FIXABLE.has(code))) {
    return { changed: false, changedCount: 0, content: text };
  }
  // Sequence repair (renumber to 1..N by document order) handles every
  // auto-fixable code. The legacy "next-available" duplicate path is only
  // reachable for the pathological duplicate-without-non-monotonic case,
  // which is provably impossible (any duplicate breaks strict ascent) —
  // kept defensively in case future inspector changes introduce it.
  const useSequenceHints = issueCodes.includes("non_monotonic_section_numbers")
    || issueCodes.includes("gapped_section_numbers");
  const hints = useSequenceHints
    ? (Array.isArray(structure.sectionSequenceRepairHints) ? structure.sectionSequenceRepairHints : [])
    : (Array.isArray(structure.sectionNumberRepairHints) ? structure.sectionNumberRepairHints : []);
  const changes = hints
    .filter((hint) => hint && hint.candidateNumber && hint.currentNumber && hint.candidateNumber !== hint.currentNumber)
    .map((hint) => {
      // Reconstruct full heading line text. raw is "<num>. title" without
      // leading `#`s. Replace leading number with candidateNumber, then
      // prefix with level `#`s. applyNormalizeHeadingsPatch uses the
      // existing line's level when text has no leading `#`, so we send the
      // bare "<newNum>. title" form to keep it level-agnostic.
      const raw = readString(hint.raw);
      const currentNumber = readString(hint.currentNumber);
      const candidateNumber = readString(hint.candidateNumber);
      const titlePart = raw.replace(new RegExp(`^${escapeRegExp$3(currentNumber)}\\.\\s*`), "");
      const newText = `${candidateNumber}. ${titlePart}`.trim();
      return { lineNumber: readPositiveInteger$o(hint.lineNumber), text: newText };
    })
    .filter((change) => change.lineNumber && change.text);
  if (changes.length === 0) {
    return { changed: false, changedCount: 0, content: text };
  }
  const result = applyNormalizeHeadingsPatch(text, { type: "normalize_headings", headings: changes });
  // Defensive: never make it worse. If the deterministic patch produced a
  // structure that still has issues (shouldn't happen given hints, but
  // belt-and-braces), drop the change.
  if (!result || result.status !== "ok" || result.changed !== true) {
    return { changed: false, changedCount: 0, content: text };
  }
  const afterStructure = inspectWorkspaceCandidateStructure(result.content);
  if (afterStructure && afterStructure.ok !== true) {
    return { changed: false, changedCount: 0, content: text };
  }
  return result;
}

function escapeRegExp$3(value) {
  return readString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyNormalizeHeadingsPatch(current, operation) {
  const content = typeof current === "string" ? current : "";
  const changes = Array.isArray(operation && operation.headings) ? operation.headings : [];
  if (!content || changes.length === 0) {
    return { changed: false, changedCount: 0, content, status: "not_found" };
  }
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  let changedCount = 0;
  for (const change of changes) {
    const lineNumber = readPositiveInteger$o(change && change.lineNumber);
    if (lineNumber == null || lineNumber <= 0 || seen.has(lineNumber)) continue;
    seen.add(lineNumber);
    const index = lineNumber - 1;
    if (index < 0 || index >= lines.length) {
      return { changed: false, changedCount, content, status: "not_found" };
    }
    const currentLine = lines[index];
    const level = readHeadingLevel(currentLine);
    if (level == null) {
      return { changed: false, changedCount, content, status: "not_found" };
    }
    const nextLine = formatNormalizedHeadingLine(currentLine, change.text);
    if (!nextLine) {
      return { changed: false, changedCount, content, status: "not_found" };
    }
    if (nextLine !== currentLine) {
      lines[index] = nextLine;
      changedCount += 1;
    }
  }
  return {
    changed: changedCount > 0,
    changedCount,
    content: lines.join("\n"),
    status: changedCount > 0 ? "ok" : "no_growth"
  };
}

function formatNormalizedHeadingLine(currentLine, replacement) {
  const current = readString(currentLine);
  const text = readString(replacement);
  if (!current || !text) return "";
  if (/^#{1,6}\s+\S/.test(text)) {
    return text.replace(/\s+#+\s*$/, "").trim();
  }
  const level = readHeadingLevel(current);
  if (level == null) return "";
  const cleanText = text.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
  return cleanText ? `${"#".repeat(level)} ${cleanText}` : "";
}

function summarizePatchStructure(value) {
  const structure = value && typeof value === "object" ? value : inspectWorkspaceCandidateStructure("");
  return {
    duplicateHeadingCount: readPositiveInteger$o(structure.duplicateHeadingCount) || 0,
    duplicateNumberCount: readPositiveInteger$o(structure.duplicateNumberCount) || 0,
    headingCount: readPositiveInteger$o(structure.headingCount) || 0,
    issueCodes: Array.isArray(structure.issueCodes) ? structure.issueCodes.map(readString).filter(Boolean).slice(0, 8) : [],
    ok: structure.ok === true,
    repeatedHeadingContexts: normalizeStructureContexts$1(structure.repeatedHeadingContexts, "heading"),
    repeatedHeadingSamples: normalizeRepeatedHeadingSamples(structure.repeatedHeadingSamples),
    repeatedNumberContexts: normalizeStructureContexts$1(structure.repeatedNumberContexts, "number"),
    repeatedNumberSamples: normalizeRepeatedNumberSamples(structure.repeatedNumberSamples),
    bodyAfterFinalSectionContexts: normalizeSimpleStructureContexts(structure.bodyAfterFinalSectionContexts),
    sectionNumberRepairHints: normalizeSectionNumberRepairHints$1(structure.sectionNumberRepairHints),
    sectionSequenceRepairHints: normalizeSectionNumberRepairHints$1(structure.sectionSequenceRepairHints),
    semanticDuplicateHeadingContexts: normalizeSemanticDuplicateHeadingContexts$3(structure.semanticDuplicateHeadingContexts),
    status: readString(structure.status) || "unknown"
  };
}

function hasContentStructureIssue(structure) {
  const issueCodes = Array.isArray(structure && structure.issueCodes)
    ? structure.issueCodes.map(readString).filter(Boolean)
    : [];
  return issueCodes.includes("semantic_duplicate_headings") ||
    issueCodes.includes("body_after_final_section");
}

function isStructureMaybeWorse(beforeStructure, afterStructure) {
  const before = beforeStructure && typeof beforeStructure === "object" ? beforeStructure : inspectWorkspaceCandidateStructure("");
  const after = afterStructure && typeof afterStructure === "object" ? afterStructure : inspectWorkspaceCandidateStructure("");
  if (before.ok && !after.ok) return true;
  const beforeIssueCount = Array.isArray(before.issueCodes) ? before.issueCodes.length : 0;
  const afterIssueCount = Array.isArray(after.issueCodes) ? after.issueCodes.length : 0;
  if (afterIssueCount > beforeIssueCount) return true;
  const beforeDuplicates = (readPositiveInteger$o(before.duplicateHeadingCount) || 0) + (readPositiveInteger$o(before.duplicateNumberCount) || 0);
  const afterDuplicates = (readPositiveInteger$o(after.duplicateHeadingCount) || 0) + (readPositiveInteger$o(after.duplicateNumberCount) || 0);
  return afterDuplicates > beforeDuplicates;
}

function isStructureImproved(beforeStructure, afterStructure) {
  const before = beforeStructure && typeof beforeStructure === "object" ? beforeStructure : inspectWorkspaceCandidateStructure("");
  const after = afterStructure && typeof afterStructure === "object" ? afterStructure : inspectWorkspaceCandidateStructure("");
  if (after.ok && !before.ok) return true;
  const beforeIssueCount = Array.isArray(before.issueCodes) ? before.issueCodes.length : 0;
  const afterIssueCount = Array.isArray(after.issueCodes) ? after.issueCodes.length : 0;
  if (afterIssueCount < beforeIssueCount) return true;
  const beforeDuplicates = (readPositiveInteger$o(before.duplicateHeadingCount) || 0) + (readPositiveInteger$o(before.duplicateNumberCount) || 0);
  const afterDuplicates = (readPositiveInteger$o(after.duplicateHeadingCount) || 0) + (readPositiveInteger$o(after.duplicateNumberCount) || 0);
  return afterDuplicates < beforeDuplicates;
}

function hashText(value) {
  const text = typeof value === "string" ? value : "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

// Try to locate `needle` in `current` with progressively lenient
// normalizers. Returns the literal substring as it appears in
// `current` (so callers can split/replace using it), plus how many
// times it occurred and which fallback (if any) matched. Pure read-only.
function locateWorkspaceFindText(current, needle) {
  const attempts = [];
  const passes = [
    { name: "exact", transform: (value) => value },
    { name: "trim_trailing_whitespace", transform: (value) => value.replace(/\s+$/, "") },
    { name: "trim_both_whitespace", transform: (value) => value.trim() },
    { name: "normalize_quotes", transform: normalizeWorkspaceQuotes },
    { name: "trim_and_normalize_quotes", transform: (value) => normalizeWorkspaceQuotes(value.trim()) },
    // Collapse runs of spaces/tabs within each line (not newlines) — catches AI
    // double-space or tab→space drift inside a line.
    { name: "normalize_whitespace", transform: (value) => value.replace(/[ \t]+/g, " ") },
    // Unescape literal \\n \\t \\r sequences the LLM sometimes emits instead of
    // real control characters — makes needle match source that uses real newlines.
    { name: "escape_normalized", transform: (value) => value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r") }
  ];
  for (const pass of passes) {
    const candidate = pass.transform(needle);
    if (!candidate || attempts.some((entry) => entry.candidate === candidate)) {
      attempts.push({ name: pass.name, candidate, skipped: true });
      continue;
    }
    attempts.push({ name: pass.name, candidate });
    if (current.includes(candidate)) {
      const matchCount = current.split(candidate).length - 1;
      return {
        found: true,
        matchCount,
        needle: candidate,
        fallback: pass.name === "exact" ? null : pass.name,
        attempted: attempts.map((entry) => entry.name)
      };
    }
  }
  // Per-line passes — handle multi-line indentation and typography drift.
  // Each pass trims/normalizes every line independently, then locates the
  // original content substring so current.split(original).join(replacement)
  // works without further transformation. Only runs when needle spans ≥2
  // non-empty lines; single-line drift is covered by the transform passes above.
  const needleHasMultipleLines = needle.split("\n").filter((line) => line.trim()).length >= 2;
  if (needleHasMultipleLines) {
    const linePasses = [
      { name: "line_trim", transformLine: (line) => line.trim() },
      { name: "line_trim_normalize", transformLine: (line) => normalizeWorkspaceQuotes(line.trim()) },
      // Per-line horizontal whitespace collapse + trim: catches AI that mixes
      // multiple spaces or tabs inside a line (e.g. column-aligned output).
      { name: "line_normalize_whitespace", transformLine: (line) => line.replace(/[ \t]+/g, " ").trim() }
    ];
    for (const pass of linePasses) {
      attempts.push({ name: pass.name });
      const original = locateByLineTrimMatch(current, needle, pass.transformLine);
      if (original) {
        const matchCount = current.split(original).length - 1;
        return {
          found: true,
          matchCount,
          needle: original,
          fallback: pass.name,
          attempted: attempts.map((entry) => entry.name)
        };
      }
    }
    // Block-anchor pass: use first+last non-empty needle lines as structural
    // anchors to locate a unique block in content. Catches interior-line drift
    // (minor wording changes, extra blank lines) without Levenshtein. Only
    // activates when the anchors are distinct and the block is unambiguous.
    attempts.push({ name: "block_anchor" });
    const blockAnchorMatch = locateByBlockAnchor(current, needle);
    if (blockAnchorMatch) {
      const matchCount = current.split(blockAnchorMatch).length - 1;
      return {
        found: true,
        matchCount,
        needle: blockAnchorMatch,
        fallback: "block_anchor",
        attempted: attempts.map((entry) => entry.name)
      };
    }
  }
  return { found: false, matchCount: 0, attempted: attempts.map((entry) => entry.name) };
}

// Find needle in content by matching each line after applying transformLine to both sides.
// Returns the original (untransformed) content substring at the matched position,
// or null if no match. Callers use the returned original as the split key so that
// current.split(original).join(replacement) performs a correct in-place substitution
// even when the LLM emitted different per-line indentation than the source.
function locateByLineTrimMatch(content, needle, transformLine) {
  const contentLines = content.split("\n");
  const needleLines = needle.split("\n");
  // Drop a trailing empty line LLMs often append after the last line.
  if (needleLines.length > 0 && needleLines[needleLines.length - 1] === "") {
    needleLines.pop();
  }
  if (needleLines.length < 2) return null;
  const transformedNeedle = needleLines.map(transformLine);
  for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
    let matches = true;
    for (let j = 0; j < needleLines.length; j++) {
      if (transformLine(contentLines[i + j]) !== transformedNeedle[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    // Reconstruct original content text at matched line positions.
    let startOffset = 0;
    for (let k = 0; k < i; k++) startOffset += contentLines[k].length + 1; // +1 for \n
    let endOffset = startOffset;
    for (let k = 0; k < needleLines.length; k++) {
      endOffset += contentLines[i + k].length;
      if (k < needleLines.length - 1) endOffset += 1; // +1 for \n between lines
    }
    return content.slice(startOffset, endOffset);
  }
  return null;
}

// Block-anchor replacer: identifies a unique content block by matching the
// first and last non-empty lines of the needle (after trim). If exactly one
// such block exists in content, returns the original content slice so callers
// can do current.split(slice).join(replacement). Returns null on no match or
// ambiguous match (safety: never silently clobber the wrong block).
function locateByBlockAnchor(content, needle) {
  const needleLines = needle.split("\n");
  if (needleLines.length > 0 && needleLines[needleLines.length - 1] === "") {
    needleLines.pop();
  }
  if (needleLines.length < 2) return null;

  const firstAnchor = needleLines.find((l) => l.trim());
  const lastAnchor = [...needleLines].reverse().find((l) => l.trim());
  if (!firstAnchor || !lastAnchor) return null;
  const firstNorm = firstAnchor.trim();
  const lastNorm = lastAnchor.trim();
  // Identical anchors produce ambiguous matches — skip to avoid false positives.
  if (firstNorm === lastNorm) return null;

  const contentLines = content.split("\n");
  const tolerance = Math.max(3, Math.ceil(needleLines.length * 0.5));
  const candidates = [];

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstNorm) continue;
    const windowEnd = Math.min(contentLines.length - 1, i + needleLines.length + tolerance);
    for (let j = i + 1; j <= windowEnd; j++) {
      if (contentLines[j].trim() !== lastNorm) continue;
      candidates.push({ start: i, end: j });
      break;
    }
  }

  if (candidates.length !== 1) return null;

  const { start, end } = candidates[0];
  let startOffset = 0;
  for (let k = 0; k < start; k++) startOffset += contentLines[k].length + 1;
  let endOffset = startOffset;
  for (let k = start; k <= end; k++) {
    endOffset += contentLines[k].length;
    if (k < end) endOffset += 1;
  }
  return content.slice(startOffset, endOffset);
}

function normalizeWorkspaceQuotes(value) {
  return readString(value)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-");
}

// 4-level Codex-style fuzzy normalization for base-content comparison.
// Level 1: strip trailing whitespace per line.
// Level 2: trim leading+trailing whitespace on the whole text.
// Level 3: normalize unicode quotes/dashes to ASCII.
// Level 4: collapse runs of horizontal whitespace within lines to a single space.
function fuzzyNormalizeContent(text) {
  const s = typeof text === "string" ? text : "";
  return normalizeWorkspaceQuotes(
    s.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd()).join("\n").trim()
  );
}

// On find_not_found, give the model verbatim file excerpts so it can self-correct
// the find string in one round-trip (instead of needing workspace_read, which is
// blocked by terminal_repair_hard_veto). Three layers, in order of information
// density: anchorMatches (verbatim surroundings around the first/last line of
// the needle), bracketLandmarks (real [..] / heading patterns when the needle
// looks like a placeholder hallucination), and documentOutline as fallback.
function computeReplaceMissHints(current, needle) {
  const hints = {};
  if (typeof current !== "string" || typeof needle !== "string" || !needle.trim() || !current.length) {
    return hints;
  }
  const SURROUND = 120;
  const MAX_ANCHORS = 3;

  const lines = needle.split("\n").map((line) => line.trim()).filter(Boolean);
  const anchorCandidates = [];
  if (lines.length) {
    anchorCandidates.push(lines[0]);
    if (lines.length > 1 && lines[lines.length - 1] !== lines[0]) {
      anchorCandidates.push(lines[lines.length - 1]);
    }
  }
  const anchors = [];
  const seenOffsets = new Set();
  for (const rawAnchor of anchorCandidates) {
    const anchor = rawAnchor.length > 80 ? rawAnchor.slice(0, 80) : rawAnchor;
    if (!anchor || anchor.length < 4) continue;
    let cursor = 0;
    while (anchors.length < MAX_ANCHORS) {
      const idx = current.indexOf(anchor, cursor);
      if (idx === -1) break;
      if (!seenOffsets.has(idx)) {
        seenOffsets.add(idx);
        const start = Math.max(0, idx - SURROUND);
        const end = Math.min(current.length, idx + anchor.length + SURROUND);
        const lineNumber = current.slice(0, idx).split(/\r?\n/).length;
        anchors.push({
          anchor,
          lineNumber,
          surroundingText: current.slice(start, end)
        });
      }
      cursor = idx + anchor.length;
    }
    if (anchors.length >= MAX_ANCHORS) break;
  }
  if (anchors.length) hints.anchorMatches = anchors;

  if (/\[[^\]\n]{1,80}\]/.test(needle)) {
    const brackets = [];
    const bracketRe = /\[[^\]\n]{1,80}\]/g;
    const seenBrackets = new Set();
    let match;
    while ((match = bracketRe.exec(current)) !== null && brackets.length < 8) {
      if (!seenBrackets.has(match[0])) {
        seenBrackets.add(match[0]);
        brackets.push(match[0]);
      }
    }
    if (brackets.length) hints.bracketLandmarks = brackets;
  }

  if (!anchors.length) {
    const headings = [];
    const headingRe = /^#{1,6}\s.+$/gm;
    let hm;
    while ((hm = headingRe.exec(current)) !== null && headings.length < 12) {
      headings.push(hm[0].trim());
    }
    hints.documentOutline = {
      headings,
      firstChars: current.slice(0, 240),
      totalChars: current.length
    };
  }

  return hints;
}

// Key for the per-run repeated-find-failure counter. Trim + truncate so trivial
// whitespace drift between identical guesses still collides; include file path
// because the same find string against different files is a separate attempt.
function makeReplaceFindKey(needle, filePath) {
  const compact = String(needle).trim().replace(/\s+/g, " ").slice(0, 240);
  return `${filePath || "<unset>"}::${compact}`;
}

function extractMatchContextSnippets(current, needle, matchCount) {
  const snippets = [];
  if (!needle) return snippets;
  const limit = Math.min(matchCount, 4);
  let cursor = 0;
  while (snippets.length < limit) {
    const index = current.indexOf(needle, cursor);
    if (index === -1) break;
    const lineNumber = current.slice(0, index).split(/\r?\n/).length;
    const beforeStart = Math.max(0, index - 40);
    const afterEnd = Math.min(current.length, index + needle.length + 40);
    snippets.push({
      lineNumber,
      offset: index,
      context: current.slice(beforeStart, afterEnd).replace(/\s+/g, " ").trim()
    });
    cursor = index + needle.length;
  }
  return snippets;
}

function finalizeWorkspaceCandidate(runState, path, options = {}) {
  const workspace = ensureVirtualWorkspace(runState, {
    config: options.config,
    force: true,
    prompt: options.prompt
  });
  const resolvedPath = readString(path) || DEFAULT_FINAL_CANDIDATE_PATH;
  const pathValidation = validateWorkspacePathRecoverable(resolvedPath);
  if (!pathValidation.ok) {
    appendWorkspaceOperation(workspace, {
      action: "finalize_candidate",
      path: resolvedPath,
      status: "invalid_args",
      summary: options.summary || describeWorkspacePathError(pathValidation.error),
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    refreshWorkspaceQuality(workspace);
    return {
      status: "invalid_args",
      error: pathValidation.error,
      message: describeWorkspacePathError(pathValidation.error),
      file: { ...createWorkspaceFile(resolvedPath, "") }
    };
  }
  const filePath = pathValidation.path;
  let file = workspace.files[filePath] || createWorkspaceFile(filePath, "");
  if (filePath === DEFAULT_FINAL_CANDIDATE_PATH && !readString(file.content)) {
    const draft = workspace.files["draft.md"] || createWorkspaceFile("draft.md", "");
    const draftContent = readString(draft.content);
    if (draftContent) {
      file = {
        content: draftContent,
        path: filePath,
        updatedAt: new Date().toISOString(),
        version: (readPositiveInteger$o(file.version) || 0) + 1
      };
      workspace.files[filePath] = file;
      workspace.version += 1;
      appendWorkspaceOperation(workspace, {
        action: "promote",
        path: filePath,
        status: "ok",
        summary: "promoted draft.md to final_candidate.md",
        cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
      }, options);
      recordWorkspaceCandidateWrite(workspace, filePath, { action: "promote" });
    }
  }
  // Deterministic auto-normalize on finalize. Research basis: heading
  // renumbering is regex/AST work, not LLM work (arXiv 2502.05111, RANLP 2025
  // "Hidden Cost of Constrained Decoding"). Weak models (flash-lite, haiku,
  // mini) can produce duplicate section numbers in long-form output and then
  // cannot reliably renumber them via prompt — the same find/replace fails
  // repeatedly. Runtime fixes the mechanical issue here, AI handles content.
  //
  // SCOPE: only `duplicate_section_numbers` is safe to auto-fix because the
  // existing inspectWorkspaceCandidateStructure already emits
  // sectionNumberRepairHints with a deterministic next-available-number
  // suggestion. Other issue codes (duplicate_headings — same title in two
  // places might be intentional; raw_prompt_title — needs LLM) are left to AI
  // repair via the existing signals.
  const autoNormalizeAttempt = tryAutoNormalizeSectionNumbers(file.content);
  if (autoNormalizeAttempt && autoNormalizeAttempt.changed) {
    const maxFileChars = readPositiveInteger$o(options.maxFileChars) || DEFAULT_MAX_FILE_CHARS$1;
    file = {
      content: truncate$3(autoNormalizeAttempt.content, maxFileChars),
      path: filePath,
      updatedAt: new Date().toISOString(),
      version: (readPositiveInteger$o(file.version) || 0) + 1
    };
    workspace.files[filePath] = file;
    workspace.version += 1;
    appendWorkspaceOperation(workspace, {
      action: "auto_normalize_headings",
      path: filePath,
      status: "ok",
      summary: `runtime auto-renumbered ${autoNormalizeAttempt.changedCount} duplicate section number(s) before finalize`,
      cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
    }, options);
    recordWorkspaceCandidateWrite(workspace, filePath, { action: "auto_normalize_headings" });
  }

  const ready = readString(file.content).length > 0;
  workspace.quality.finalCandidatePath = filePath;
  workspace.quality.finalCandidateReady = ready;
  refreshWorkspaceQuality(workspace, { prompt: options.prompt });
  appendWorkspaceOperation(workspace, {
    action: "finalize_candidate",
    path: filePath,
    status: ready ? "ok" : "empty",
    summary: options.summary || (ready ? `marked ${filePath} ready` : `${filePath} is empty`),
    cycle: readPositiveInteger$o(runState && runState.cycleCount) || 0
  }, options);
  recordWorkspaceCandidateFinalize(workspace, filePath, { action: "finalize_candidate" });
  syncRunStateCandidatePathMismatchSignal(runState, workspace);
  return cloneValue(workspace.quality);
}

function buildVirtualWorkspacePromptBlock(workspace, options = {}) {
  const source = normalizeVirtualWorkspace(workspace);
  if (!source || source.enabled !== true) return "";
  const opts = options && typeof options === "object" ? options : {};
  const maxFilePreviewChars = readPositiveInteger$o(opts.maxFilePreviewChars) || 1800;
  const maxFiles = readPositiveInteger$o(opts.maxFiles) || 5;
  const cyclesUsed = readPositiveInteger$o(opts.cyclesUsed);
  const cyclesMax = readPositiveInteger$o(opts.cyclesMax);
  const cyclesRemaining = cyclesMax != null && cyclesUsed != null
    ? Math.max(0, cyclesMax - cyclesUsed)
    : null;
  const publishBlockSignal = opts.publishBlockSignal && typeof opts.publishBlockSignal === "object"
    ? opts.publishBlockSignal
    : null;
  const terminalRepairState = opts.terminalRepairState && typeof opts.terminalRepairState === "object"
    ? opts.terminalRepairState
    : null;
  const terminalRepairActive = terminalRepairState && terminalRepairState.active === true;
  const terminalRepairAllowedActions = terminalRepairActive
    ? readStringArray$5(terminalRepairState.allowedActions)
    : [];
  const quality = source.quality && typeof source.quality === "object" ? source.quality : {};
  const finalCandidatePath = readFinalCandidatePath(source);
  const candidateProjection = projectWorkspaceCandidateLifecycle(source);
  const candidateLifecycle = candidateProjection.candidateLifecycle;
  const candidatePathMismatchSignal = opts.candidatePathMismatchSignal && typeof opts.candidatePathMismatchSignal === "object"
    ? opts.candidatePathMismatchSignal
    : candidateProjection.candidatePathMismatchSignal;
  const finalCandidateFile = source.files[finalCandidatePath] || null;
  const finalCandidateContent = readString(finalCandidateFile && finalCandidateFile.content);
  const finalCandidateStats = summarizeTextStats$2(finalCandidateContent);
  const finalCandidateStatus = readFinalCandidateStatus(source, finalCandidatePath, quality);
  const inspectedFinalCandidateStructure = inspectWorkspaceCandidateStructure(finalCandidateContent);
  const qualityFinalCandidateStructure = quality.finalCandidateStructure && typeof quality.finalCandidateStructure === "object"
    ? quality.finalCandidateStructure
    : null;
  const qualityStructureIsEmptyDefault = finalCandidateContent &&
    qualityFinalCandidateStructure &&
    Array.isArray(qualityFinalCandidateStructure.issueCodes) &&
    qualityFinalCandidateStructure.issueCodes.includes("candidate_empty");
  const finalCandidateStructure = qualityFinalCandidateStructure && !qualityStructureIsEmptyDefault
    ? qualityFinalCandidateStructure
    : inspectedFinalCandidateStructure;
  const publishProtocol = inspectWorkspacePublishProtocol(source, finalCandidatePath);
  const candidateReviewFreshness = inspectWorkspaceCandidateReviewFreshness(source, finalCandidatePath);
  const candidateReview = quality.candidateReview && typeof quality.candidateReview === "object"
    ? quality.candidateReview
    : null;
  const candidateQualitySignal = quality.candidateQualitySignal && typeof quality.candidateQualitySignal === "object"
    ? quality.candidateQualitySignal
    : null;
  const pendingPatch = source.pendingPatch && typeof source.pendingPatch === "object"
    ? source.pendingPatch
    : null;
  const checks = Array.isArray(quality.checks)
    ? quality.checks.map((check) => {
      const code = readString(check && check.code);
      const status = readString(check && check.status);
      const reason = readString(check && check.reason);
      return [code, status, reason].filter(Boolean).join("=");
    }).filter(Boolean).slice(0, 12)
    : [];
  // ADR-0015 PR 2 — render whichever filenames AI authored, sorted.
  // No more 5-file English-only nudge when empty.
  const promptFiles = selectWorkspacePromptFiles(source, {
    finalCandidatePath,
    maxFiles
  });
  const files = promptFiles
    .map((file) => {
      const stats = summarizeTextStats$2(file.content);
      return [
        `${file.path} v${file.version} stats=${formatTextStats$1(stats)}:`,
        truncate$3(file.content, maxFilePreviewChars)
      ].join("\n");
    });
  const contentFileCount = Object.keys(source.files)
    .filter((path) => readString(source.files[path] && source.files[path].content))
    .length;
  if (files.length === 0) {
    return "";
  }
  return [
    "Virtual workspace draft artifacts:",
    ...files,
    contentFileCount > files.length
      ? `${contentFileCount - files.length} earlier workspace artifact(s) omitted from this prompt projection. The selected final candidate is always included when it has content. Use workspace_list/workspace_read if you need exact content.`
      : null,
    finalCandidateContent
      ? [
        "Selected final candidate:",
        `path=${finalCandidatePath}`,
        `stats=${formatTextStats$1(finalCandidateStats)}`
      ].join("\n")
      : null,
    [
      "Virtual workspace advisory state:",
      `quality_status=${readString(quality.status) || "n/a"}`,
      `final_candidate_path=${finalCandidatePath}`,
      `candidate_lifecycle=activePath:${candidateLifecycle.activePath || "n/a"}, draftPaths:${candidateLifecycle.draftPaths.length > 0 ? candidateLifecycle.draftPaths.join(",") : "none"}, lastWrittenPath:${candidateLifecycle.lastWrittenPath || "none"}, lastReadPath:${candidateLifecycle.lastReadPath || "none"}, finalizedPath:${candidateLifecycle.finalizedPath || "none"}, publishedPath:${candidateLifecycle.publishedPath || "none"}, status:${candidateLifecycle.status || "n/a"}`,
      candidatePathMismatchSignal
        ? `candidate_path_mismatch_signal=${candidatePathMismatchSignal.mismatchKind} selectedPath=${candidatePathMismatchSignal.selectedPath || "n/a"} writtenPath=${candidatePathMismatchSignal.writtenPath || "none"} finalizedPath=${candidatePathMismatchSignal.finalizedPath || "none"} publishedPath=${candidatePathMismatchSignal.publishedPath || "none"}`
        : "candidate_path_mismatch_signal=none",
      `final_candidate_status=${finalCandidateStatus}`,
      `final_candidate_ready=${quality.finalCandidateReady === true ? "yes" : "no"}`,
      `final_candidate_chars=${finalCandidateStats.chars}`,
      `final_candidate_cjkChars=${finalCandidateStats.cjkChars}`,
      `final_candidate_words=${finalCandidateStats.words}`,
      `final_candidate_structure=${finalCandidateStructure.status || "unknown"}${Array.isArray(finalCandidateStructure.issueCodes) && finalCandidateStructure.issueCodes.length > 0 ? ` (${finalCandidateStructure.issueCodes.join(",")})` : ""}`,
      finalCandidateStructure.status === "fail"
        ? formatStructureRepairAdvisory(finalCandidateStructure, terminalRepairAllowedActions)
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.repeatedHeadingSamples) && finalCandidateStructure.repeatedHeadingSamples.length > 0
        ? `duplicate_heading_samples=${finalCandidateStructure.repeatedHeadingSamples.map((entry) => `${entry.heading} x${entry.count}`).join(" | ")}`
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.repeatedHeadingContexts) && finalCandidateStructure.repeatedHeadingContexts.length > 0
        ? `duplicate_heading_context=${formatStructureContextLine(finalCandidateStructure.repeatedHeadingContexts, "heading")}`
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.repeatedNumberSamples) && finalCandidateStructure.repeatedNumberSamples.length > 0
        ? `duplicate_section_number_samples=${finalCandidateStructure.repeatedNumberSamples.map((entry) => `${entry.number} x${entry.count}`).join(" | ")}`
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.repeatedNumberContexts) && finalCandidateStructure.repeatedNumberContexts.length > 0
        ? `duplicate_section_number_context=${formatStructureContextLine(finalCandidateStructure.repeatedNumberContexts, "number")}`
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.sectionNumberRepairHints) && finalCandidateStructure.sectionNumberRepairHints.length > 0
        ? `section_number_repair_context=${formatSectionNumberRepairHints(finalCandidateStructure.sectionNumberRepairHints)}`
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.semanticDuplicateHeadingContexts) && finalCandidateStructure.semanticDuplicateHeadingContexts.length > 0
        ? `semantic_duplicate_heading_context=${formatSemanticDuplicateHeadingContexts(finalCandidateStructure.semanticDuplicateHeadingContexts)}`
        : null,
      finalCandidateStructure.status === "fail" && Array.isArray(finalCandidateStructure.bodyAfterFinalSectionContexts) && finalCandidateStructure.bodyAfterFinalSectionContexts.length > 0
        ? `body_after_final_section_context=${formatSimpleStructureContexts(finalCandidateStructure.bodyAfterFinalSectionContexts)}`
        : null,
      `publish_protocol_state=finalized_after_write:${publishProtocol.finalizedAfterLatestWrite ? "yes" : "no"}, read_after_finalize:${publishProtocol.readAfterFinalize ? "yes" : "no"}`,
      candidateReview
        ? `candidate_review=path:${candidateReview.path || "n/a"}, readyToPublish:${candidateReview.readyToPublish === true ? "yes" : "no"}, issueCount:${readPositiveInteger$o(candidateReview.issueCount) || 0}, checklistCount:${Array.isArray(candidateReview.requirementsChecklist) ? candidateReview.requirementsChecklist.length : 0}, fileVersion:${readPositiveInteger$o(candidateReview.fileVersion) || 0}, freshForCurrentVersion:${candidateReviewFreshness.fresh ? "yes" : "no"}, finalSectionTitle:${candidateReview.finalSectionTitle || "none"}`
        : "candidate_review=none",
      candidateReview && Array.isArray(candidateReview.requirementsChecklist) && candidateReview.requirementsChecklist.length > 0
        ? `candidate_requirements_checklist=${formatCandidateRequirementsChecklist(candidateReview.requirementsChecklist)}`
        : null,
      candidateQualitySignal
        ? `candidate_quality_signal=status:${candidateQualitySignal.status || "unknown"}, blockingIssues:${Array.isArray(candidateQualitySignal.blockingIssueCodes) && candidateQualitySignal.blockingIssueCodes.length > 0 ? candidateQualitySignal.blockingIssueCodes.join(",") : "none"}, advisoryIssues:${Array.isArray(candidateQualitySignal.advisoryIssueCodes) && candidateQualitySignal.advisoryIssueCodes.length > 0 ? candidateQualitySignal.advisoryIssueCodes.join(",") : "none"}`
        : "candidate_quality_signal=none",
      formatCandidatePublishReadinessObservation(candidateQualitySignal),
      pendingPatch
        ? `pending_patch=patchId:${pendingPatch.patchId}, path:${pendingPatch.path}, status:${pendingPatch.status}, deltaWords:${pendingPatch.deltaWords}, riskFlags:${Array.isArray(pendingPatch.riskFlags) && pendingPatch.riskFlags.length > 0 ? pendingPatch.riskFlags.join(",") : "none"}`
        : "pending_patch=none",
      checks.length > 0 ? `quality_checks=${checks.join(" | ")}` : "quality_checks=none",
      cyclesUsed != null ? `cycles_used=${cyclesUsed}` : null,
      cyclesMax != null ? `cycles_max=${cyclesMax}` : null,
      cyclesRemaining != null
        ? `cycles_remaining=${cyclesRemaining}${cyclesRemaining <= lowCycleRemainingThreshold(cyclesMax) ? " (LOW BUDGET — runtime will not auto-extend; if you keep retrying without progress the run will hit maxSteps and force-stop with an error)" : ""}`
        : null,
      publishBlockSignal && publishBlockSignal.count > 0
        ? `publish_attempts_blocked=${publishBlockSignal.count} (lastStatus=${publishBlockSignal.lastStatus || "n/a"}, byStatus=${formatPublishBlockStatusCounts(publishBlockSignal.statusCounts)})${publishBlockSignal.count >= 3 ? " — META-PATTERN: you have been blocked 3+ times. Read the lastStatus and choose a corrected action sequence; do not repeat the same failing publish loop." : ""}`
        : null,
      terminalRepairActive
        ? `Facts above are read-only observations. Terminal repair is active; the next action must come from terminalRepairState.allowedActions only: ${terminalRepairAllowedActions.length > 0 ? terminalRepairAllowedActions.join(", ") : "(none)"}. Do not use workspace_read/list/write/replace/append/insert/finalize unless that exact action is listed there.`
        : "Facts above are read-only observations. AI owns the next move: workspace_read/list to review, web_search/read_url for evidence, workspace_write/append/insert_after_section/replace or workspace_propose_patch/apply_patch to improve, workspace_finalize_candidate when ready, workspace_publish_candidate to send the selected candidate verbatim, or finalize with limitations if you judge evidence is exhausted."
    ].filter(Boolean).join("\n"),
    "Use these artifacts as draft context only. Do not expose workspace operation logs or internal workspace headings in the final answer."
  ].filter(Boolean).join("\n\n");
}

// AGRUN-548 — publish-readiness coherence observation. When the candidate
// already clears every mechanical acceptance gate (length, structure, source)
// and the ONLY remaining publish blockers are the review→publish handshake, the
// bare `candidate_quality_signal=status:blocked` leaves the model with no
// coherent "you are done — just finish the handshake" signal. A
// perfectionist/weak model (deepseek-v4-flash high, live 2026-06-18) reads
// "blocked", keeps editing, and every edit makes its last review stale so
// missing_latest_candidate_review never clears — the run burns to maxSteps with
// a 100/100 candidate it never ships. This surfaces the FACT (gates pass) and
// the terminal handshake (review→publish, or limited publish) without forcing
// any action: the AI still owns the next move. Topic-agnostic — derived purely
// from the existing quality-signal issue codes, no section/topic names baked in.
const REVIEW_HANDSHAKE_BLOCKING_CODES = Object.freeze([
  "missing_latest_candidate_review",
  "ai_review_not_ready",
  "objective_requirement_unmet"
]);

const SOURCE_READINESS_ADVISORY_CODES = Object.freeze([
  "blocked_source_cited",
  "missing_required_cited_urls",
  "unread_cited_url"
]);

function formatCandidatePublishReadinessObservation(candidateQualitySignal) {
  if (!candidateQualitySignal || typeof candidateQualitySignal !== "object") return null;
  const blocking = Array.isArray(candidateQualitySignal.blockingIssueCodes)
    ? candidateQualitySignal.blockingIssueCodes.filter(Boolean)
    : [];
  if (blocking.length === 0) return null;
  // Fire only when EVERY blocker is review-handshake — any content/structure
  // blocker means the candidate is not actually complete, so do not claim it is.
  if (!blocking.every((code) => REVIEW_HANDSHAKE_BLOCKING_CODES.includes(code))) return null;
  // Never tell the model it is "complete" while length is still short.
  const advisory = Array.isArray(candidateQualitySignal.advisoryIssueCodes)
    ? candidateQualitySignal.advisoryIssueCodes
    : [];
  if (advisory.includes("external_word_count_below_target")) return null;
  const sourceAdvisories = advisory
    .filter((code) => SOURCE_READINESS_ADVISORY_CODES.includes(code));
  if (sourceAdvisories.length > 0) {
    return "candidate_publish_readiness=review-handshake blockers remain "
      + `(${blocking.join(",")}); source advisories are still present (${sourceAdvisories.join(",")}), `
      + "so source readiness is not asserted as pass. "
      + "A candidate review goes stale after any later content edit, which re-raises missing_latest_candidate_review. "
      + "A limited workspace_publish_candidate (finalReadiness.decision='limited' with concrete remainingGaps and "
      + "false flags for any unmet dimension) stays valid when the AI judges real gaps remain.";
  }
  // Fact-only, AI-first (AGRUN-246-C): state the coherence facts, do not
  // prescribe an action sequence. The model composes its own next move.
  return "candidate_publish_readiness=mechanical acceptance gates currently pass (length, structure, source); "
    + `the only remaining publish blockers are review-handshake state (${blocking.join(",")}), not content deficits. `
    + "A candidate review goes stale after any later content edit, which re-raises missing_latest_candidate_review. "
    + "A limited workspace_publish_candidate (finalReadiness.decision='limited' with concrete remainingGaps and "
    + "false flags for any unmet dimension) stays valid when the AI judges real gaps remain.";
}

function formatStructureRepairAdvisory(finalCandidateStructure, allowedActions) {
  const reason = readString(finalCandidateStructure && finalCandidateStructure.reason) || "structure_not_ready";
  const actions = Array.isArray(allowedActions) ? allowedActions : [];
  const canPatch = actions.includes(WORKSPACE_PROPOSE_PATCH_ACTION) || actions.includes(WORKSPACE_APPLY_PATCH_ACTION);
  const canRewrite = actions.includes(WORKSPACE_WRITE_ACTION) || actions.includes(WORKSPACE_REPLACE_ACTION);
  const issueCodes = Array.isArray(finalCandidateStructure && finalCandidateStructure.issueCodes)
    ? finalCandidateStructure.issueCodes.map(readString).filter(Boolean)
    : [];
  if (issueCodes.includes("semantic_duplicate_headings") || issueCodes.includes("body_after_final_section")) {
    return `structure_repair_required=${reason}. Semantic duplicate sections or body after the final section cannot be fixed by normalize_headings alone. Merge or remove duplicate-purpose section blocks with a targeted replace/patch, then read/review before publishing.`;
  }
  if (canPatch && !canRewrite) {
    return `structure_repair_required=${reason}. Use workspace_propose_patch first and workspace_apply_patch only for a valid preview. Do not append or insert new sections when length is already satisfied.`;
  }
  return `structure_repair_required=${reason}. Produce one coherent candidate with unique section headings before publishing. If the selected candidate text is already projected or was just read, do not repeat workspace_read; use workspace_write or workspace_replace for a full-outline repair.`;
}

function formatSemanticDuplicateHeadingContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : [])
    .map((context) => {
      const first = context && typeof context === "object" ? context.first : null;
      const second = context && typeof context === "object" ? context.second : null;
      const relation = readString(context && context.relation) || "similar";
      const firstLine = first && typeof first === "object"
        ? `lineNumber ${first.lineNumber} raw "${readString(first.raw)}"`
        : "";
      const secondLine = second && typeof second === "object"
        ? `lineNumber ${second.lineNumber} raw "${readString(second.raw)}"`
        : "";
      return firstLine && secondLine ? `${relation}: ${firstLine} <-> ${secondLine}` : null;
    })
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ");
}

function formatSimpleStructureContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : [])
    .map((context) => {
      const lineNumber = readPositiveInteger$o(context && context.lineNumber);
      const raw = readString(context && context.raw);
      return lineNumber && raw ? `lineNumber ${lineNumber} raw "${raw}"` : null;
    })
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ");
}

function formatStructureContextLine(contexts, key) {
  return (Array.isArray(contexts) ? contexts : [])
    .map((context) => {
      const label = readString(context && context[key]);
      const occurrences = (Array.isArray(context && context.occurrences) ? context.occurrences : [])
        .map((occurrence) => `lineNumber ${occurrence.lineNumber} raw "${readString(occurrence.raw)}"`)
        .filter(Boolean)
        .join(", ");
      return label && occurrences ? `${label} -> ${occurrences}` : null;
    })
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ");
}

function formatCandidateRequirementsChecklist(checklist) {
  return (Array.isArray(checklist) ? checklist : [])
    .map((item) => {
      const source = item && typeof item === "object" ? item : {};
      const id = readString(source.id) || "requirement";
      const kind = readString(source.kind) || "unknown";
      const status = readString(source.status) || "unknown";
      const requirement = readString(source.requirement).replace(/\s+/g, " ");
      const gap = readString(source.remainingGap).replace(/\s+/g, " ");
      const repair = readString(source.repairAction).replace(/\s+/g, " ");
      return [
        `${id}:${kind}:${status}`,
        requirement ? `requirement=${truncate$3(requirement, 120)}` : "",
        gap ? `gap=${truncate$3(gap, 120)}` : "",
        repair ? `repair=${truncate$3(repair, 120)}` : ""
      ].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .slice(0, 8)
    .join(" | ");
}

function formatSectionNumberRepairHints(hints) {
  return (Array.isArray(hints) ? hints : [])
    .map((hint) => {
      const lineNumber = readPositiveInteger$o(hint && hint.lineNumber);
      const currentNumber = readString(hint && hint.currentNumber);
      const candidateNumber = readString(hint && (hint.candidateNumber || hint.suggestedNumber));
      const raw = truncate$3(readString(hint && hint.raw), 160);
      if (lineNumber == null || !currentNumber || !candidateNumber || !raw) return null;
      return `lineNumber ${lineNumber} currentNumber ${currentNumber} candidateNumber ${candidateNumber} raw "${raw}"`;
    })
    .filter(Boolean)
    .slice(0, 12)
    .join(" | ");
}

function selectWorkspacePromptFiles(source, options = {}) {
  const finalCandidatePath = readString(options.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH;
  const maxFiles = readPositiveInteger$o(options.maxFiles) || 5;
  const files = Object.keys(source.files)
    .sort()
    .map((path) => source.files[path])
    .filter((file) => readString(file && file.content));
  const selected = files.slice(-maxFiles);
  const finalCandidate = files.find((file) => readString(file && file.path) === finalCandidatePath);
  if (!finalCandidate || selected.some((file) => readString(file && file.path) === finalCandidatePath)) {
    return selected;
  }
  return selected.length >= maxFiles
    ? [finalCandidate, ...selected.slice(1)]
    : [finalCandidate, ...selected];
}

function stripInternalVirtualWorkspaceSections(text, workspace) {
  if (!hasVirtualWorkspace(workspace) || typeof text !== "string" || !text.trim()) {
    return text;
  }
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (!INTERNAL_VIRTUAL_WORKSPACE_HEADING.test(line.trim())) {
      kept.push(line);
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextLine = lines[cursor] || "";
      const trimmed = nextLine.trim();
      if (trimmed && /^(?:#{1,6}\s+\S|(?:\*\*)?\s*(?:sources|summary|findings|recommendations|limitations|answer|source quality|evidence gaps)\b)/i.test(trimmed)) {
        break;
      }
      cursor += 1;
    }
    index = cursor - 1;
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


// AGRUN-223 / ADR-0015 PR 1 — `materializeVirtualWorkspaceFromFinalAnswer`
// was removed. Runtime no longer back-fills the virtual workspace from
// the final answer. Workspace files are AI-authored via workspace_write
// / workspace_replace; an empty workspace at finalize is the correct
// outcome when the AI did not use it. Internal helpers
// `materializeWorkspaceFile` and `buildMaterializedOutline` were the
// only consumers of `materializeVirtualWorkspaceFromFinalAnswer` and
// were deleted in the same PR. `buildMaterializedEvidence` and
// `buildMaterializedCritique` survive because the regex-gated veto
// path (`createWorkspaceRepairDecision`) still uses them; both go
// away in PR 2 alongside the rest of the push-mode prose templates.








function refreshWorkspaceQuality(workspace, options = {}) {
  const evaluation = evaluateWorkspaceQuality(workspace, options);
  workspace.quality.checks = evaluation.checks;
  workspace.quality.finalCandidateReady = evaluation.finalCandidateReady;
  workspace.quality.finalCandidatePath = evaluation.finalCandidatePath;
  workspace.quality.finalCandidateStats = evaluation.finalCandidateStats;
  workspace.quality.finalCandidateStructure = evaluation.finalCandidateStructure;
  workspace.quality.lastIssueCodes = evaluation.issueCodes;
  workspace.quality.status = evaluation.status;
  return evaluation;
}

// AGRUN-223 / ADR-0015 PR 1 — `materializeWorkspaceFile` and
// `buildMaterializedOutline` were deleted with
// `materializeVirtualWorkspaceFromFinalAnswer`. They had no other
// consumers. `buildMaterializedEvidence` and `buildMaterializedCritique`
// stay until PR 2 deletes the regex-gated veto path that still calls
// them.



function evaluateWorkspaceQuality(workspace, options = {}) {
  // ADR-0015 PR 2 — quality evaluator works on whatever AI authored.
  // Reserved-name checks survive as conventions: when AI uses
  // outline.md / draft.md / final_candidate.md the evaluator reports
  // structural status. blockingIssues was tied to the deleted
  // STRICT_RESEARCH_WORKSPACE_PROMPT_RE regex; quality is now
  // advisory-only and AI decides what to do with it.
  const fileContent = (path) => {
    const file = workspace.files && workspace.files[path];
    return readString(file && file.content);
  };
  const outline = fileContent("outline.md");
  const evidence = fileContent("evidence.json");
  const draft = fileContent("draft.md");
  const critique = fileContent("critique.md");
  const finalCandidatePath = readString(options.finalCandidatePath) || readFinalCandidatePath(workspace);
  const finalCandidate = fileContent(finalCandidatePath);
  const finalCandidateSameAsOutline = Boolean(outline && finalCandidate && normalizeComparableText$4(outline) === normalizeComparableText$4(finalCandidate));
  const draftSameAsOutline = Boolean(outline && draft && normalizeComparableText$4(outline) === normalizeComparableText$4(draft));
  const finalCandidateStructure = inspectWorkspaceCandidateStructure(finalCandidate);
  const checks = [
    createCheck("outline", outline ? "pass" : "missing", "outline.md"),
    createCheck("evidence", evidence ? "pass" : "missing", "evidence.json"),
    createCheck("draft", draft ? "pass" : "missing", "draft.md"),
    createCheck("draft_not_outline", draftSameAsOutline ? "fail" : draft ? "pass" : "missing", "draft.md must not duplicate outline.md"),
    createCheck("critique", critique ? "pass" : "missing", "critique.md"),
    createCheck("final_candidate", finalCandidate ? "pass" : "missing", finalCandidatePath),
    createCheck("final_candidate_not_outline", finalCandidateSameAsOutline ? "fail" : finalCandidate ? "pass" : "missing", `${finalCandidatePath} must not duplicate outline.md`),
    createCheck(
      "final_candidate_structure",
      finalCandidate ? finalCandidateStructure.status : "missing",
      finalCandidate ? finalCandidateStructure.reason : `${finalCandidatePath} missing`
    )
  ];
  const issueCodes = checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.name}_${check.status}`);
  return {
    blockingIssues: [],
    checks,
    finalCandidatePath,
    finalCandidateReady: Boolean(finalCandidate),
    finalCandidateStructure,
    finalCandidateStats: summarizeTextStats$2(finalCandidate),
    issueCodes,
    status: finalCandidate
      ? finalCandidateStructure.ok ? "ready" : "needs_structure_repair"
      : "needs_draft"
  };
}

function inspectWorkspaceCandidateStructure(text, options = {}) {
  const value = readString(text);
  const maxSamples = readPositiveInteger$o(options.maxSamples) || 5;
  if (!value) {
    return {
      duplicateHeadingCount: 0,
      duplicateNumberCount: 0,
      headingCount: 0,
      issueCodes: ["candidate_empty"],
      ok: false,
      reason: "candidate is empty",
      repeatedHeadingSamples: [],
      repeatedNumberSamples: [],
      status: "fail",
      title: ""
    };
  }
  const headings = collectMarkdownHeadingsDetailed(value);
  const headingCounts = new Map();
  const numberCounts = new Map();
  for (const heading of headings) {
    if (!heading.normalized) continue;
    const headingKey = heading.level <= 2 && heading.labelNormalized
      ? heading.labelNormalized
      : heading.normalized;
    headingCounts.set(headingKey, (headingCounts.get(headingKey) || 0) + 1);
    if (heading.number != null && heading.level <= 3) {
      numberCounts.set(heading.number, (numberCounts.get(heading.number) || 0) + 1);
    }
  }
  const repeatedHeadingSamples = [...headingCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([heading, count]) => ({ count, heading }))
    .sort((a, b) => b.count - a.count || a.heading.localeCompare(b.heading))
    .slice(0, maxSamples);
  const repeatedNumberSamples = [...numberCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([number, count]) => ({ count, number }))
    .sort((a, b) => Number(a.number) - Number(b.number))
    .slice(0, maxSamples);
  const repeatedHeadingContexts = repeatedHeadingSamples
    .map((sample) => ({
      count: sample.count,
      heading: sample.heading,
      occurrences: headings
        .filter((heading) => {
          const headingKey = heading.level <= 2 && heading.labelNormalized
            ? heading.labelNormalized
            : heading.normalized;
          return headingKey === sample.heading;
        })
        .map((heading) => ({
          lineNumber: heading.lineNumber,
          raw: truncate$3(heading.raw, 160)
        }))
        .slice(0, 8)
    }));
  const repeatedNumberContexts = repeatedNumberSamples
    .map((sample) => ({
      count: sample.count,
      number: sample.number,
      occurrences: headings
        .filter((heading) => heading.number === sample.number && heading.level <= 3)
        .map((heading) => ({
          lineNumber: heading.lineNumber,
          raw: truncate$3(heading.raw, 160)
        }))
        .slice(0, 8)
    }));
  const sectionNumberRepairHints = buildSectionNumberRepairHints(headings, repeatedNumberSamples, maxSamples);
  // Live evidence (TNO sess 4, 2026-05-27): flash-lite produced unique
  // section numbers but emitted them out of document order (1..6, 8..10, 7).
  // Inspector previously reported ok=true because no duplicates existed; the
  // user-visible report had broken numbering. Detect strictly-monotonic
  // top-level (level 2) ascent and flag non-monotonic as a separate issue
  // code so the deterministic auto-fix can renumber to 1..N by document
  // order without re-running duplicate logic.
  const nonMonotonic = isNonMonotonicTopLevelSectionSequence(headings);
  // Gap detection — monotonic but does not start at 1 or skips integers.
  // Independent signal from non_monotonic; same deterministic fix
  // (sequence repair to 1..N). Examples that flag: [1,2,4] (skip), [2,3,4]
  // (offset), [1,2,3,5,6] (interior skip). [1,2,3] passes; [1,2,4,3] fails
  // non_monotonic instead.
  const gapped = !nonMonotonic && hasGappedTopLevelSectionSequence(headings);
  const sectionSequenceRepairHints = nonMonotonic || gapped
    ? buildSectionSequenceRepairHints(headings)
    : [];
  const semanticDuplicateHeadingContexts = collectSemanticDuplicateHeadingContexts(headings, maxSamples);
  const bodyAfterFinalSectionContexts = collectBodyAfterFinalSectionContexts(headings, maxSamples);
  const firstHeading = headings[0] || null;
  const title = readString(firstHeading && firstHeading.raw);
  const normalizedTitle = readString(firstHeading && firstHeading.normalized);
  const rawPromptTitle = Boolean(
    title.length > 140
  );
  const issueCodes = [];
  if (rawPromptTitle) issueCodes.push("raw_prompt_title");
  if (repeatedHeadingSamples.length > 0) issueCodes.push("duplicate_headings");
  if (repeatedNumberSamples.length > 0) issueCodes.push("duplicate_section_numbers");
  if (nonMonotonic) issueCodes.push("non_monotonic_section_numbers");
  if (gapped) issueCodes.push("gapped_section_numbers");
  if (semanticDuplicateHeadingContexts.length > 0) issueCodes.push("semantic_duplicate_headings");
  if (bodyAfterFinalSectionContexts.length > 0) issueCodes.push("body_after_final_section");
  const ok = issueCodes.length === 0;
  return {
    bodyAfterFinalSectionContexts,
    duplicateHeadingCount: repeatedHeadingSamples.reduce((sum, entry) => sum + entry.count - 1, 0),
    duplicateNumberCount: repeatedNumberSamples.reduce((sum, entry) => sum + entry.count - 1, 0),
    headingCount: headings.length,
    issueCodes,
    ok,
    reason: ok
      ? "candidate structure is clean"
      : `candidate has structural issues: ${issueCodes.join(", ")}`,
    repeatedHeadingContexts,
    repeatedHeadingSamples,
    repeatedNumberContexts,
    repeatedNumberSamples,
    semanticDuplicateHeadingContexts,
    sectionNumberRepairHints,
    sectionSequenceRepairHints,
    status: ok ? "pass" : "fail",
    title: title || normalizedTitle
  };
}

// AGRUN-543 — mechanical post-mutation structure echo. After a content
// mutation the planner otherwise only sees length/diff stats; the current
// heading structure (and any duplicate / semantic-duplicate / body-after-final
// sections it JUST created) stays invisible until a separate workspace_read or
// finalize recomputes quality.finalCandidateStructure. Live evidence
// (gemini/gpt-5.4-mini/deepseek, 2026-06-17): models duplicate sections via
// repeated write/insert and never SEE it before publishing limited. This echo
// is a READ-ONLY observation attached to every content-mutation output: a
// mechanical heading scan plus the duplicate/semantic/body-after-final contexts
// with line numbers and a plain-language guidance line. It NEVER judges content
// quality or forces a repair — the AI owns the dedup decision (AGRUN-244:
// structure is an observable signal, not a forced-repair deficit). Returns null
// when the content is clean of content-level structure issues, so a healthy
// write adds no noise.
function buildWorkspaceStructureEcho(content) {
  const structure = inspectWorkspaceCandidateStructure(content);
  if (!structure || structure.ok === true) return null;
  const issueCodes = Array.isArray(structure.issueCodes) ? structure.issueCodes : [];
  const contentIssueCodes = issueCodes.filter((code) => (
    code === "duplicate_headings" ||
    code === "semantic_duplicate_headings" ||
    code === "body_after_final_section" ||
    code === "duplicate_section_numbers"
  ));
  if (contentIssueCodes.length === 0) return null;
  return {
    kind: "workspace_structure_echo",
    issueCodes: contentIssueCodes,
    headingCount: readPositiveInteger$o(structure.headingCount) || 0,
    repeatedHeadingSamples: Array.isArray(structure.repeatedHeadingSamples)
      ? structure.repeatedHeadingSamples.slice(0, 6)
      : [],
    semanticDuplicateHeadingContexts: Array.isArray(structure.semanticDuplicateHeadingContexts)
      ? structure.semanticDuplicateHeadingContexts.slice(0, 6)
      : [],
    bodyAfterFinalSectionContexts: Array.isArray(structure.bodyAfterFinalSectionContexts)
      ? structure.bodyAfterFinalSectionContexts.slice(0, 6)
      : [],
    guidance: buildWorkspaceStructureEchoGuidance(contentIssueCodes)
  };
}

function buildWorkspaceStructureEchoGuidance(codes) {
  const parts = ["Structure scan of the content you just wrote detected repeated sections."];
  if (codes.includes("semantic_duplicate_headings")) {
    parts.push("Two sections cover the same purpose (semantic duplicate), even if the heading text differs.");
  }
  if (codes.includes("duplicate_headings")) {
    parts.push("The same heading text appears more than once.");
  }
  if (codes.includes("body_after_final_section")) {
    parts.push("There is body content after what reads as the final/conclusion section.");
  }
  if (codes.includes("duplicate_section_numbers")) {
    parts.push("A section number repeats.");
  }
  parts.push("This is a read-only observation, not a block. If the repeat is unintended, merge or remove the duplicate block with workspace_replace/workspace_multi_edit before you finalize; otherwise continue.");
  return parts.join(" ");
}

function collectSemanticDuplicateHeadingContexts(headings, maxSamples) {
  const topLevel = (Array.isArray(headings) ? headings : [])
    .filter((heading) => heading && (heading.level === 2 || heading.level === 3))
    .map((heading) => ({
      heading,
      tokens: normalizeHeadingPurposeTokenSet(heading.raw)
    }))
    .filter((entry) => entry.tokens.size > 0);
  const contexts = [];
  for (let i = 0; i < topLevel.length; i += 1) {
    for (let j = i + 1; j < topLevel.length; j += 1) {
      const relation = readHeadingPurposeRelation(topLevel[i].tokens, topLevel[j].tokens);
      if (!relation) continue;
      contexts.push({
        first: {
          lineNumber: topLevel[i].heading.lineNumber,
          raw: truncate$3(topLevel[i].heading.raw, 160)
        },
        relation,
        second: {
          lineNumber: topLevel[j].heading.lineNumber,
          raw: truncate$3(topLevel[j].heading.raw, 160)
        }
      });
      if (contexts.length >= maxSamples) return contexts;
    }
  }
  return contexts;
}

function collectBodyAfterFinalSectionContexts(headings, maxSamples) {
  const topLevel = (Array.isArray(headings) ? headings : [])
    .filter((heading) => heading && heading.level === 2);
  const finalIndex = topLevel.findIndex((heading) => isFinalSectionHeading(heading.raw));
  if (finalIndex < 0 || finalIndex >= topLevel.length - 1) return [];
  return topLevel
    .slice(finalIndex + 1)
    .filter((heading) => !isBackMatterHeading(heading.raw))
    .map((heading) => ({
      lineNumber: heading.lineNumber,
      raw: truncate$3(heading.raw, 160)
    }))
    .slice(0, maxSamples);
}

const STRUCTURE_PURPOSE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "how", "in",
  "into", "is", "of", "on", "or", "the", "to", "with",
  "advanced", "additional", "common", "defining", "designing",
  "extra", "further", "instrumentation", "more", "section", "strategies", "the"
]);
const STRUCTURE_PURPOSE_NEGATION_RE = /^(?:anti|non|un|counter|dis)(?:-|$)|^(?:not|without|versus|vs)$/iu;

function normalizeHeadingPurposeTokenSet(rawHeading) {
  const value = readString(rawHeading)
    .toLowerCase()
    .replace(/^\d+(?:\.\d+)*[\s.)-]*/, "")
    .replace(/[^a-z0-9'-]+/g, " ")
    .trim();
  const tokens = value
    ? value.split(/\s+/)
      .map((token) => token.endsWith("ies") && token.length > 4
        ? `${token.slice(0, -3)}y`
        : token.endsWith("s") && token.length > 4
          ? token.slice(0, -1)
          : token)
      .filter((token) => token.length > 1 && !STRUCTURE_PURPOSE_STOPWORDS.has(token))
    : [];
  return new Set(tokens);
}

function readHeadingPurposeRelation(first, second) {
  if (!(first instanceof Set) || !(second instanceof Set) || first.size === 0 || second.size === 0) return null;
  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }
  const union = first.size + second.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  const [small, large] = first.size <= second.size ? [first, second] : [second, first];
  const diff = [...large].filter((token) => !small.has(token));
  const subsetDuplicate = small.size >= 1 &&
    small.size < large.size &&
    diff.length <= 2 &&
    !hasStructurePurposeNegationToken(diff) &&
    setIsSubset(small, large);
  if (subsetDuplicate) return "subset";
  return jaccard >= 0.6 ? "equivalent" : null;
}

function hasStructurePurposeNegationToken(tokens) {
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (STRUCTURE_PURPOSE_NEGATION_RE.test(token)) return true;
  }
  return false;
}

function setIsSubset(small, large) {
  for (const token of small) {
    if (!large.has(token)) return false;
  }
  return true;
}

function isFinalSectionHeading(rawHeading) {
  const tokens = normalizeHeadingPurposeTokenSet(rawHeading);
  const label = readString(rawHeading).toLowerCase().replace(/^\d+(?:\.\d+)*[\s.)-]*/, "");
  return tokens.has("conclusion") ||
    /\b(final thoughts?|closing thoughts?)\b/.test(label) ||
    /^\s*(summary|final summary)\s*$/.test(label);
}

function isBackMatterHeading(rawHeading) {
  const label = readString(rawHeading).toLowerCase().replace(/^\d+(?:\.\d+)*[\s.)-]*/, "");
  return /\b(references?|sources?|bibliography|appendix|appendices)\b/.test(label);
}

// Returns true when the top-level numbered headings (## level 2 with a
// leading int.int... section number) do not strictly ascend in document order.
// Sub-section (### level 3) numbers and unnumbered headings are ignored — we
// only care that the top-level reading flow is monotonic. Empty or single
// section docs are vacuously monotonic.
function isNonMonotonicTopLevelSectionSequence(headings) {
  const list = collectTopLevelNumberedHeadings(headings);
  if (list.length < 2) return false;
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].parsedNumber <= list[i - 1].parsedNumber) return true;
  }
  return false;
}

// Strict sequential check: positions in document order must read 1, 2, ..., N.
// Catches gaps ([1, 2, 4]) and offsets ([2, 3, 4]). Caller is expected to skip
// this when non-monotonic already fires — same fix path handles both, no need
// to flag the same content twice.
function hasGappedTopLevelSectionSequence(headings) {
  const list = collectTopLevelNumberedHeadings(headings);
  if (list.length === 0) return false;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].parsedNumber !== i + 1) return true;
  }
  return false;
}

function collectTopLevelNumberedHeadings(headings) {
  if (!Array.isArray(headings)) return [];
  const out = [];
  for (const heading of headings) {
    if (!heading || heading.level !== 2) continue;
    const number = readString(heading.number);
    if (!number) continue;
    // AGRUN-545 — a dotted number (## 2.1) is a SUB-section authored at H2
    // depth, not a top-level sequence entry. extractMarkdownSectionNumber
    // strips the trailing dot, so a genuine top-level heading is a bare
    // integer ("2") while a sub-section keeps its dot ("2.1"). Folding "2.1"
    // to a top-level "2" made [1, 2, 2.1, 2.2, 3] read as [1, 2, 2, 2, 3] and
    // mis-fired non_monotonic/gapped, trapping weak models in an unfixable
    // renumber loop (gemini-3.1-flash-lite live, 2026-06-18). Only bare
    // integers participate in the top-level sequence; sub-sections are ignored.
    if (number.includes(".")) continue;
    const parsed = Number.parseInt(number, 10);
    if (!Number.isFinite(parsed)) continue;
    out.push({ ...heading, parsedNumber: parsed });
  }
  return out;
}

// Produce one hint per top-level numbered heading reassigning its number to
// its position in document order (1-based). Only emits hints where the new
// number differs from the existing one — same shape as
// buildSectionNumberRepairHints so applyNormalizeHeadingsPatch consumes both.
function buildSectionSequenceRepairHints(headings) {
  const topLevel = collectTopLevelNumberedHeadings(headings);
  const hints = [];
  for (let i = 0; i < topLevel.length; i += 1) {
    const heading = topLevel[i];
    const candidateNumber = String(i + 1);
    if (candidateNumber === heading.number) continue;
    hints.push({
      candidateNumber,
      currentNumber: heading.number,
      level: heading.level,
      lineNumber: heading.lineNumber,
      occurrenceIndex: 1,
      raw: truncate$3(heading.raw, 160)
    });
  }
  return hints;
}

function buildSectionNumberRepairHints(headings, repeatedNumberSamples, maxSamples) {
  const repeatedNumbers = new Set((Array.isArray(repeatedNumberSamples) ? repeatedNumberSamples : [])
    .map((entry) => readString(entry && entry.number))
    .filter(Boolean));
  if (repeatedNumbers.size === 0) return [];
  const occupiedNumbers = new Set((Array.isArray(headings) ? headings : [])
    .map((heading) => readString(heading && heading.number))
    .filter(Boolean));
  const repeatedOccurrences = new Map();
  return (Array.isArray(headings) ? headings : [])
    .filter((heading) => heading && heading.number != null && heading.level <= 3)
    .map((heading) => {
      const currentNumber = readString(heading.number);
      if (!repeatedNumbers.has(currentNumber)) return null;
      const occurrenceIndex = (repeatedOccurrences.get(currentNumber) || 0) + 1;
      repeatedOccurrences.set(currentNumber, occurrenceIndex);
      const suggestedNumber = occurrenceIndex <= 1
        ? currentNumber
        : suggestNextSectionNumber(currentNumber, occupiedNumbers);
      if (suggestedNumber && suggestedNumber !== currentNumber) {
        occupiedNumbers.add(suggestedNumber);
      }
      return {
        candidateNumber: suggestedNumber,
        currentNumber,
        level: readPositiveInteger$o(heading.level) || 0,
        lineNumber: heading.lineNumber,
        occurrenceIndex,
        raw: truncate$3(heading.raw, 160)
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, readPositiveInteger$o(maxSamples) || 5) * 3);
}

function suggestNextSectionNumber(currentNumber, occupiedNumbers) {
  const value = readString(currentNumber);
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return value;
  }
  const nextParts = parts.slice();
  const lastIndex = nextParts.length - 1;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    nextParts[lastIndex] += 1;
    const candidate = nextParts.join(".");
    if (!occupiedNumbers || !occupiedNumbers.has(candidate)) {
      return candidate;
    }
  }
  return value;
}

function readFinalCandidatePath(workspace) {
  const quality = workspace && typeof workspace === "object" && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : {};
  const path = readString(quality.finalCandidatePath);
  if (!path || path.startsWith("/") || path.includes("..") || /[\\]/.test(path)) {
    return DEFAULT_FINAL_CANDIDATE_PATH;
  }
  return path;
}

function createCheck(name, status, reason) {
  return { name, reason, status };
}

function normalizeComparableText$4(value) {
  return readString(value)
    .toLowerCase()
    .replace(/[`*_#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Keep `workspace.quality.lastRead` in sync with the post-mutation
// state of the file so the read-before-mutate preflight gate (in the
// action layer) does not block legitimate chain mutations. AI knows
// the new content because runtime returned it as the mutation result
// and the next planner prompt projects the file under the workspace
// block. The gate's purpose is to catch mutations against content the
// AI has not seen (stale cycles, divergent state) — successive AI-
// driven mutations are not that case.
function syncWorkspaceLastReadToFile(workspace, file) {
  if (!workspace || typeof workspace !== "object") return;
  if (!file || typeof file !== "object") return;
  if (!workspace.quality || typeof workspace.quality !== "object") {
    workspace.quality = createWorkspaceQuality();
  }
  workspace.quality.lastRead = {
    observedAt: readString(file.updatedAt) || new Date().toISOString(),
    path: readString(file.path),
    textStats: summarizeTextStats$2(file.content)
  };
}

// Pure observation: extract insertable section anchors from `text`.
// Returns `{ level, text, lineNumber }` triples in document order.
// Used by `insertAfterWorkspaceSection` to surface
// `availableHeadings` to the AI when the requested heading is not
// found. Markdown headings are preferred; simple standalone title lines
// are included because weak live models often draft long reports with
// bare section labels such as `Definition` or `**Conclusion**`.
function collectMarkdownHeadings(text) {
  const value = readString(text);
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const level = readInsertableSectionLevel(lines, index);
    if (level == null) continue;
    headings.push({
      level,
      lineNumber: index + 1,
      text: normalizeInsertableSectionText(lines[index])
    });
  }
  return headings;
}

function collectMarkdownHeadingsDetailed(text) {
  const value = readString(text);
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const level = readHeadingLevel(lines[index]);
    if (level == null) continue;
    const raw = readString(lines[index]).replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim();
    const normalized = normalizeHeadingText$1(lines[index]);
    headings.push({
      labelNormalized: normalizeHeadingLabelText(raw),
      level,
      lineNumber: index + 1,
      normalized,
      number: extractMarkdownSectionNumber(raw),
      raw
    });
  }
  return headings;
}

function extractMarkdownSectionNumber(rawHeadingText) {
  const value = readString(rawHeadingText);
  const match = value.match(/^(\d{1,3}(?:\.\d{1,3})*)\.?(?=\s|$)/);
  return match ? match[1] : null;
}

function createWorkspaceQuality() {
  return {
    candidateQualitySignal: null,
    candidateReview: null,
    checks: [],
    finalCandidatePath: DEFAULT_FINAL_CANDIDATE_PATH,
    finalCandidateReady: false,
    finalCandidateStructure: inspectWorkspaceCandidateStructure(""),
    finalCandidateStats: summarizeTextStats$2(""),
    lastRead: null,
    lastIssueCodes: [],
    status: "needs_draft"
  };
}

function createWorkspaceFile(path, content) {
  return {
    content: readString(content),
    path,
    updatedAt: null,
    version: 0
  };
}

function appendWorkspaceOperation(workspace, operation, options = {}) {
  const maxOperations = readPositiveInteger$o(options.maxOperations) || DEFAULT_MAX_OPERATIONS;
  const next = {
    action: readString(operation.action) || "workspace",
    createdAt: new Date().toISOString(),
    cycle: readPositiveInteger$o(operation.cycle) || 0,
    id: `vw-${Date.now()}-${workspace.operations.length + 1}`,
    path: readString(operation.path) || null,
    status: readString(operation.status) || "ok",
    summary: truncate$3(readString(operation.summary), DEFAULT_MAX_OPERATION_CHARS)
  };
  workspace.operations = normalizeOperations(workspace.operations).concat(next).slice(-maxOperations);
}

function summarizeWorkspaceFile(file) {
  const content = readString(file && file.content);
  return {
    hasContent: content.length > 0,
    path: readString(file && file.path),
    size: content.length,
    textStats: summarizeTextStats$2(content),
    updatedAt: readString(file && file.updatedAt) || null,
    version: readPositiveInteger$o(file && file.version) || 0
  };
}

function addWorkspaceFileStats(file) {
  const source = file && typeof file === "object" ? file : createWorkspaceFile("", "");
  return {
    ...source,
    textStats: summarizeTextStats$2(source.content)
  };
}

function normalizeOperations(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      return {
        action: readString(entry.action) || "workspace",
        createdAt: readString(entry.createdAt) || null,
        cycle: readPositiveInteger$o(entry.cycle) || 0,
        id: readString(entry.id) || `vw-${index + 1}`,
        path: readString(entry.path) || null,
        status: readString(entry.status) || "ok",
        summary: truncate$3(readString(entry.summary), DEFAULT_MAX_OPERATION_CHARS)
      };
    })
    .filter(Boolean)
    .slice(-DEFAULT_MAX_OPERATIONS);
}

function normalizePendingPatch(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const pathValidation = validateWorkspacePathRecoverable(source.path);
  if (!pathValidation.ok) return null;
  const patchId = readString(source.patchId);
  if (!patchId) return null;
  return {
    afterContent: typeof source.afterContent === "string" ? source.afterContent : "",
    afterHash: readString(source.afterHash),
    afterWords: readPositiveInteger$o(source.afterWords) || 0,
    baseVersion: readPositiveInteger$o(source.baseVersion) || 0,
    beforeHash: readString(source.beforeHash),
    beforeHashFuzzy: readString(source.beforeHashFuzzy) || null,
    beforeWords: readPositiveInteger$o(source.beforeWords) || 0,
    changed: source.changed === true,
    createdAt: readString(source.createdAt) || null,
    deltaWords: typeof source.deltaWords === "number" && Number.isFinite(source.deltaWords) ? source.deltaWords : 0,
    kind: "virtual_workspace_pending_patch",
    operations: Array.isArray(source.operations) ? source.operations.map(summarizePatchOperation).filter(Boolean).slice(0, 8) : [],
    patchId,
    path: pathValidation.path,
    previewSummary: readString(source.previewSummary),
    riskFlags: Array.isArray(source.riskFlags) ? source.riskFlags.map(readString).filter(Boolean).slice(0, 8) : [],
    structureAfter: summarizePatchStructure(source.structureAfter),
    structureBefore: summarizePatchStructure(source.structureBefore),
    status: readString(source.status) || "preview_blocked",
    valid: source.valid === true,
    version: readPositiveInteger$o(source.version) || 1
  };
}

function normalizeWorkspaceQuality(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    candidateQualitySignal: normalizeStoredCandidateQualitySignal(source.candidateQualitySignal),
    candidateReview: normalizeCandidateReview(source.candidateReview),
    checks: (Array.isArray(source.checks) ? source.checks : [])
      .map((check) => {
        if (!check || typeof check !== "object") return null;
        return {
          name: readString(check.name) || "check",
          reason: readString(check.reason) || "n/a",
          status: readString(check.status) || "unknown"
        };
      })
      .filter(Boolean),
    finalCandidatePath: readString(source.finalCandidatePath) || DEFAULT_FINAL_CANDIDATE_PATH,
    finalCandidateReady: source.finalCandidateReady === true,
    finalCandidateStructure: normalizeWorkspaceCandidateStructure(source.finalCandidateStructure),
    finalCandidateStats: normalizeTextStats$3(source.finalCandidateStats),
    lastRead: normalizeWorkspaceLastRead(source.lastRead),
    lastIssueCodes: Array.isArray(source.lastIssueCodes)
      ? source.lastIssueCodes.map(readString).filter(Boolean)
      : [],
    status: readString(source.status) || "needs_draft"
  };
}

function normalizeWorkspaceLastRead(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const path = readString(source.path);
  if (!path || path.startsWith("/") || path.includes("..") || /[\\]/.test(path)) return null;
  return {
    observedAt: readString(source.observedAt) || null,
    path,
    textStats: normalizeTextStats$3(source.textStats)
  };
}

function normalizeCandidateReview(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const path = readString(source.path);
  if (!path || path.startsWith("/") || path.includes("..") || /[\\]/.test(path)) return null;
  return {
    fileUpdatedAt: readString(source.fileUpdatedAt) || null,
    fileVersion: readPositiveInteger$o(source.fileVersion) || 0,
    finalSectionTitle: readString(source.finalSectionTitle) || null,
    issueCount: readPositiveInteger$o(source.issueCount) || 0,
    issues: Array.isArray(source.issues)
      ? source.issues.map(normalizeCandidateReviewIssue).filter(Boolean).slice(0, 24)
      : [],
    path,
    readyToPublish: source.readyToPublish === true,
    repairPlan: readString(source.repairPlan) || null,
    requirementsChecklist: normalizeCandidateRequirementsChecklist(source.requirementsChecklist),
    reviewedAt: readString(source.reviewedAt) || null,
    summary: readString(source.summary) || null,
    textStats: normalizeTextStats$3(source.textStats)
  };
}

function normalizeCandidateReviewIssue(value) {
  if (typeof value === "string") {
    const text = readString(value);
    return text ? { code: "ai_review_issue", severity: "advisory", summary: truncate$3(text, 240) } : null;
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const summary = readString(source.summary || source.message || source.issue);
  const code = readString(source.code) || "ai_review_issue";
  return {
    code,
    severity: readString(source.severity) === "blocking" ? "blocking" : "advisory",
    summary: truncate$3(summary || code, 240)
  };
}

function normalizeCandidateRequirementsChecklist(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeCandidateRequirement(entry, index))
    .filter(Boolean)
    .slice(0, 24);
}

function normalizeCandidateRequirement(value, index) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const requirement = readString(source.requirement || source.summary || source.text);
  if (!requirement) return null;
  const id = readString(source.id) || `requirement_${index + 1}`;
  const kind = normalizeCandidateRequirementKind(source.kind || source.type);
  const status = normalizeCandidateRequirementStatus(source.status || source.result);
  return {
    evidence: truncate$3(readString(source.evidence), 360) || null,
    id: truncate$3(id, 80),
    kind,
    remainingGap: truncate$3(readString(source.remainingGap || source.gap), 360) || null,
    repairAction: truncate$3(readString(source.repairAction || source.repairPlan), 360) || null,
    requirement: truncate$3(requirement, 360),
    status
  };
}

function normalizeCandidateRequirementKind(value) {
  const text = readString(value).toLowerCase();
  if (text === "objective" || text === "fact" || text === "measurable") return "objective";
  if (text === "subjective" || text === "editorial" || text === "quality") return "subjective";
  return "unknown";
}

function normalizeCandidateRequirementStatus(value) {
  const text = readString(value).toLowerCase();
  if (text === "met" || text === "pass" || text === "passed" || text === "done") return "met";
  if (text === "partial" || text === "partially_met" || text === "partly_met") return "partial";
  if (text === "unmet" || text === "fail" || text === "failed" || text === "missing") return "unmet";
  return "unknown";
}

function normalizeStoredCandidateQualitySignal(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const issues = Array.isArray(source.issues)
    ? source.issues.map((issue) => {
        const item = issue && typeof issue === "object" && !Array.isArray(issue) ? issue : {};
        const code = readString(item.code);
        if (!code) return null;
        return {
          code,
          message: readString(item.message) || code,
          severity: readString(item.severity) === "advisory" ? "advisory" : "blocking",
          path: readString(item.path) || null,
          requirementId: readString(item.requirementId) || null,
          status: readString(item.status) || null,
          url: readString(item.url) || null
        };
      }).filter(Boolean).slice(0, 24)
    : [];
  const blockingIssueCodes = Array.isArray(source.blockingIssueCodes)
    ? source.blockingIssueCodes.map(readString).filter(Boolean).slice(0, 24)
    : issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code);
  return {
    advisoryIssueCodes: Array.isArray(source.advisoryIssueCodes)
      ? source.advisoryIssueCodes.map(readString).filter(Boolean).slice(0, 24)
      : issues.filter((issue) => issue.severity !== "blocking").map((issue) => issue.code),
    blockingIssueCodes,
    hasBlockingIssues: blockingIssueCodes.length > 0,
    issueCodes: Array.isArray(source.issueCodes)
      ? source.issueCodes.map(readString).filter(Boolean).slice(0, 24)
      : issues.map((issue) => issue.code),
    issues,
    kind: "candidate_quality_signal",
    ok: source.ok === true && blockingIssueCodes.length === 0,
    path: readString(source.path) || null,
    requirementsChecklist: normalizeCandidateRequirementsChecklist(source.requirementsChecklist),
    reviewRequired: source.reviewRequired === true,
    status: readString(source.status) || (blockingIssueCodes.length > 0 ? "blocked" : "pass"),
    version: 1
  };
}

function normalizeWorkspaceCandidateStructure(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return inspectWorkspaceCandidateStructure("");
  return {
    bodyAfterFinalSectionContexts: normalizeSimpleStructureContexts(source.bodyAfterFinalSectionContexts),
    duplicateHeadingCount: readPositiveInteger$o(source.duplicateHeadingCount) || 0,
    duplicateNumberCount: readPositiveInteger$o(source.duplicateNumberCount) || 0,
    headingCount: readPositiveInteger$o(source.headingCount) || 0,
    issueCodes: Array.isArray(source.issueCodes)
      ? source.issueCodes.map(readString).filter(Boolean).slice(0, 12)
      : [],
    ok: source.ok === true,
    reason: readString(source.reason) || "n/a",
    repeatedHeadingContexts: normalizeStructureContexts$1(source.repeatedHeadingContexts, "heading"),
    repeatedHeadingSamples: normalizeRepeatedHeadingSamples(source.repeatedHeadingSamples),
    repeatedNumberContexts: normalizeStructureContexts$1(source.repeatedNumberContexts, "number"),
    repeatedNumberSamples: normalizeRepeatedNumberSamples(source.repeatedNumberSamples),
    semanticDuplicateHeadingContexts: normalizeSemanticDuplicateHeadingContexts$3(source.semanticDuplicateHeadingContexts),
    sectionNumberRepairHints: normalizeSectionNumberRepairHints$1(source.sectionNumberRepairHints),
    sectionSequenceRepairHints: normalizeSectionNumberRepairHints$1(source.sectionSequenceRepairHints),
    status: readString(source.status) || "unknown",
    title: truncate$3(readString(source.title), 200)
  };
}

function normalizeSemanticDuplicateHeadingContexts$3(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : null;
      const first = source && source.first && typeof source.first === "object" ? source.first : null;
      const second = source && source.second && typeof source.second === "object" ? source.second : null;
      const firstRaw = readString(first && first.raw);
      const secondRaw = readString(second && second.raw);
      if (!firstRaw || !secondRaw) return null;
      return {
        first: {
          lineNumber: readPositiveInteger$o(first && first.lineNumber) || 0,
          raw: truncate$3(firstRaw, 160)
        },
        relation: readString(source && source.relation) || "similar",
        second: {
          lineNumber: readPositiveInteger$o(second && second.lineNumber) || 0,
          raw: truncate$3(secondRaw, 160)
        }
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeSimpleStructureContexts(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = entry && typeof entry === "object" ? entry : null;
      const raw = readString(source && source.raw);
      if (!raw) return null;
      return {
        lineNumber: readPositiveInteger$o(source && source.lineNumber) || 0,
        raw: truncate$3(raw, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeSectionNumberRepairHints$1(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const lineNumber = readPositiveInteger$o(entry.lineNumber);
      const candidateNumber = readString(entry.candidateNumber || entry.suggestedNumber);
      const currentNumber = readString(entry.currentNumber);
      const raw = readString(entry.raw);
      if (lineNumber == null || !candidateNumber || !currentNumber || !raw) return null;
      return {
        candidateNumber,
        currentNumber,
        level: readPositiveInteger$o(entry.level) || 0,
        lineNumber,
        raw: truncate$3(raw, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeRepeatedHeadingSamples(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const heading = readString(entry.heading);
      if (!heading) return null;
      return {
        count: readPositiveInteger$o(entry.count) || 1,
        heading: truncate$3(heading, 120)
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeRepeatedNumberSamples(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const number = readString(entry.number);
      if (!number) return null;
      return {
        count: readPositiveInteger$o(entry.count) || 1,
        number
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeStructureContexts$1(value, key) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const label = readString(entry[key]);
      if (!label) return null;
      const occurrences = (Array.isArray(entry.occurrences) ? entry.occurrences : [])
        .map((occurrence) => {
          if (!occurrence || typeof occurrence !== "object") return null;
          const lineNumber = readPositiveInteger$o(occurrence.lineNumber);
          const raw = readString(occurrence.raw);
          if (lineNumber == null || !raw) return null;
          return {
            lineNumber,
            raw: truncate$3(raw, 160)
          };
        })
        .filter(Boolean)
        .slice(0, 8);
      return {
        count: readPositiveInteger$o(entry.count) || occurrences.length || 1,
        [key]: key === "number" ? label : truncate$3(label, 120),
        occurrences
      };
    })
    .filter(Boolean)
    .slice(0, 5);
}

function hasVirtualWorkspace(workspace) {
  const source = normalizeVirtualWorkspace(workspace);
  if (!source || source.enabled !== true) return false;
  if (Array.isArray(source.operations) && source.operations.length > 0) return true;
  return Object.values(source.files || {}).some((file) => (
    file && typeof file === "object" && readString(file.content)
  ));
}

function truncate$3(value, maxChars) {
  const text = readString(value);
  const limit = readPositiveInteger$o(maxChars) || DEFAULT_MAX_FILE_CHARS$1;
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function readWorkspaceAppendSeparator(value) {
  if (typeof value !== "string") return "\n\n";
  return value.length > 0 ? value : "\n\n";
}

// AGRUN-547 — strip EVERY heading in insert content that duplicates the target
// section or an existing heading, turning a duplicate-creating "expand a section"
// insert into a clean in-section append. A weak model repeats the section heading
// not only on the first line but also after a lead-in sentence or several times
// over, so we scan the whole addition, not just the leading line. Only the
// DUPLICATE heading lines (and one trailing blank each) are dropped; all body
// text and any genuinely NEW section heading are preserved. Never returns empty
// (falls back to the original content if stripping would erase everything).
function stripDuplicateHeadingsForInsert(addition, normalizedTargetHeading, currentLines) {
  const lines = readString(addition).split(/\r?\n/);
  const existingHeadings = new Set([normalizedTargetHeading]);
  for (let index = 0; index < currentLines.length; index += 1) {
    if (readInsertableSectionLevel(currentLines, index) != null) {
      const normalized = normalizeInsertableSectionText(currentLines[index]);
      if (normalized) existingHeadings.add(normalized);
    }
  }
  const out = [];
  let removed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (readInsertableSectionLevel(lines, index) != null) {
      const normalized = normalizeInsertableSectionText(lines[index]);
      if (normalized && existingHeadings.has(normalized)) {
        removed = true;
        if (index + 1 < lines.length && lines[index + 1].trim() === "") index += 1;
        continue;
      }
      if (normalized) existingHeadings.add(normalized);
    }
    out.push(lines[index]);
  }
  if (!removed) return addition;
  const result = out.join("\n").replace(/^\n+/, "");
  return result.trim() ? result : addition;
}

function insertAfterMarkdownSection(text, targetHeading, addition, options = {}) {
  const current = readString(text);
  let insertText = readString(addition);
  if (!current || !insertText) {
    return { changed: false, content: current, availableHeadings: collectMarkdownHeadings(current), status: "heading_not_found" };
  }
  const lines = current.split(/\r?\n/);
  const availableHeadings = collectMarkdownHeadings(current);
  const headingMatches = availableHeadings.filter((heading) => heading && heading.text === targetHeading);
  if (headingMatches.length > 1) {
    return {
      changed: false,
      content: current,
      availableHeadings,
      matchCount: headingMatches.length,
      message: `Heading "${targetHeading}" is ambiguous; ${headingMatches.length} matching sections exist.`,
      status: "ambiguous"
    };
  }
  if (headingMatches.length === 0) {
    return { changed: false, content: current, availableHeadings, status: "heading_not_found" };
  }
  const headingIndex = headingMatches[0].lineNumber - 1;
  // AGRUN-547 — a weak model "expands a section" by passing content that repeats
  // the section's own heading. insert_after_section already located section X, so
  // a leading "## X" in the body only manufactures a duplicate heading and traps
  // the model in an endless insert->duplicate->merge loop (gemini-3.1-flash-lite
  // live, 2026-06-18). Treat a leading heading that duplicates the target section
  // OR any existing heading as an in-section append: strip that heading line and
  // keep the body. A genuinely NEW section heading (not already in the document)
  // is preserved, so legitimate new-section inserts are unaffected.
  insertText = stripDuplicateHeadingsForInsert(insertText, targetHeading, lines);
  const headingLevel = readInsertableSectionLevel(lines, headingIndex);
  let insertIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const nextLevel = readInsertableSectionLevel(lines, index);
    if (nextLevel != null && (headingLevel == null || nextLevel <= headingLevel)) {
      insertIndex = index;
      break;
    }
  }
  const before = lines.slice(0, insertIndex).join("\n").trimEnd();
  const after = lines.slice(insertIndex).join("\n").trimStart();
  const separator = readWorkspaceAppendSeparator(options.separator);
  const next = after
    ? `${before}${separator}${insertText}\n\n${after}`
    : `${before}${separator}${insertText}`;
  return { changed: true, content: next };
}

function readHeadingLevel(value) {
  const match = readString(value).match(/^(#{1,6})\s+\S/);
  return match ? match[1].length : null;
}

function readInsertableSectionLevel(lines, index) {
  const line = readString(Array.isArray(lines) ? lines[index] : "");
  if (!line) return null;
  const markdownLevel = readHeadingLevel(line);
  if (markdownLevel != null) return markdownLevel;
  if (!isStandaloneSectionLine(lines, index)) return null;
  return 2;
}

function isStandaloneSectionLine(lines, index) {
  const line = readString(Array.isArray(lines) ? lines[index] : "");
  if (!line || line.length > 120) return false;
  if (/^(?:[-*+]|\d+[.)])\s+/.test(line)) return false;
  if (/^https?:\/\//i.test(line)) return false;
  if (/[.!?。？！]$/.test(line)) return false;
  const normalized = normalizeInsertableSectionText(line);
  if (!normalized) return false;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount > 10) return false;
  const previous = index > 0 ? readString(lines[index - 1]) : "";
  const next = index < lines.length - 1 ? readString(lines[index + 1]) : "";
  return (!previous || readHeadingLevel(lines[index - 1]) != null)
    && (!next || readHeadingLevel(lines[index + 1]) == null);
}

function normalizeHeadingText$1(value) {
  return readString(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHeadingLabelText(value) {
  return normalizeHeadingText$1(value)
    .replace(/^\d{1,3}(?:\.\d{1,3})*\.?\s+/, "")
    .trim();
}

function normalizeInsertableSectionText(value) {
  return normalizeHeadingLabelText(value)
    .replace(/^[-–—]+\s*/, "")
    .replace(/\s*:\s*$/, "")
    .trim();
}

/**
 * Inspect the workspace operations log to derive whether the publish
 * protocol invariants (finalize-after-write, read-after-finalize) are
 * currently satisfied for `path`. Pure read-only — never throws and
 * never mutates state. Used by both the publish action (to record the
 * audit on its terminal payload) and the planner prompt block (to
 * surface the protocol state as a read-only observation so AI can
 * decide its next move).
 */
function inspectWorkspacePublishProtocol(workspace, path) {
  // Read-only inspector — invalid path returns a neutral protocol view
  // so the planner block stays observable without throwing. Callers that
  // care about validity (publish action) check filePath themselves.
  const resolvedPath = readString(path) || DEFAULT_FINAL_CANDIDATE_PATH;
  const pathValidation = validateWorkspacePathRecoverable(resolvedPath);
  const filePath = pathValidation.ok ? pathValidation.path : resolvedPath;
  const source = normalizeVirtualWorkspace(workspace);
  const operations = source && Array.isArray(source.operations) ? source.operations : [];
  let latestWriteIndex = -1;
  let latestFinalizeIndex = -1;
  let latestReadIndex = -1;
  let latestReviewIndex = -1;
  operations.forEach((operation, index) => {
    if (!operation || operation.path !== filePath) return;
    const status = readString(operation.status);
    const contentChanged = !status || status === "ok";
    if (
      contentChanged &&
      (
        operation.action === "apply_patch" ||
        operation.action === "write" ||
        operation.action === "replace" ||
        operation.action === "append" ||
        operation.action === "insert_after_section" ||
        operation.action === "promote" ||
        operation.action === "auto_normalize_headings"
      )
    ) {
      latestWriteIndex = index;
    }
    if (operation.action === "finalize_candidate") {
      latestFinalizeIndex = index;
    }
    if (operation.action === "read") {
      latestReadIndex = index;
    }
    if (operation.action === "review_candidate") {
      latestReviewIndex = index;
    }
  });
  return {
    finalizedAfterLatestWrite: latestFinalizeIndex > -1 && latestFinalizeIndex > latestWriteIndex,
    latestFinalizeIndex,
    latestReadIndex,
    latestReviewIndex,
    latestWriteIndex,
    path: filePath,
    readAfterLatestContentChange: latestReadIndex > -1 && latestReadIndex > latestWriteIndex,
    readAfterFinalize: latestReadIndex > -1 && latestReadIndex > latestFinalizeIndex,
    reviewAfterLatestContentChange: latestReviewIndex > -1 && latestReviewIndex > latestWriteIndex,
    reviewAfterRead: latestReviewIndex > -1 && latestReviewIndex > latestReadIndex
  };
}

function inspectWorkspaceCandidateReviewFreshness(workspace, path) {
  const resolvedPath = readString(path) || DEFAULT_FINAL_CANDIDATE_PATH;
  const pathValidation = validateWorkspacePathRecoverable(resolvedPath);
  const filePath = pathValidation.ok ? pathValidation.path : resolvedPath;
  const source = normalizeVirtualWorkspace(workspace);
  const quality = source && source.quality && typeof source.quality === "object"
    ? source.quality
    : {};
  const file = source && source.files && source.files[filePath] && typeof source.files[filePath] === "object"
    ? source.files[filePath]
    : null;
  const review = quality.candidateReview && typeof quality.candidateReview === "object"
    ? quality.candidateReview
    : null;
  const fileVersion = readPositiveInteger$o(file && file.version) || 0;
  const reviewedFileVersion = readPositiveInteger$o(review && review.fileVersion) || 0;
  const protocol = inspectWorkspacePublishProtocol(source, filePath);
  const reviewPathMatches = Boolean(review && readString(review.path) === filePath);
  const versionMatches = Boolean(reviewPathMatches && reviewedFileVersion === fileVersion && fileVersion > 0);
  const protocolFresh = Boolean(
    protocol.reviewAfterLatestContentChange === true &&
    protocol.reviewAfterRead === true
  );
  const fresh = Boolean(versionMatches && protocolFresh);
  let reason = "review_missing";
  if (fresh) {
    reason = "fresh_review_exists";
  } else if (review && !reviewPathMatches) {
    reason = "review_path_mismatch";
  } else if (reviewPathMatches && !versionMatches) {
    reason = "review_version_stale";
  } else if (reviewPathMatches && !protocolFresh) {
    reason = "review_protocol_stale";
  }
  return {
    fileVersion,
    fresh,
    kind: "workspace_candidate_review_freshness",
    path: filePath,
    protocol,
    reason,
    reviewedAt: readString(review && review.reviewedAt) || null,
    reviewedFileVersion,
    status: fresh ? "fresh" : "stale"
  };
}

function readFinalCandidateStatus(source, finalCandidatePath, quality) {
  const file = source && source.files ? source.files[finalCandidatePath] : null;
  if (!file) return "missing";
  const content = readString(file && file.content);
  if (!content) return "empty";
  if (quality && quality.finalCandidateReady === true) return "ready";
  return "drafted";
}

function summarizeTextStats$2(value) {
  const text = readString(value);
  const latinWords = text.match(/[A-Za-z0-9]+(?:[.'_-][A-Za-z0-9]+)*/g) || [];
  const cjkChars = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g) || [];
  return {
    chars: text.length,
    cjkChars: cjkChars.length,
    nonWhitespaceChars: text.replace(/\s/g, "").length,
    words: latinWords.length
  };
}

function normalizeTextStats$3(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    chars: readPositiveInteger$o(source.chars) || 0,
    cjkChars: readPositiveInteger$o(source.cjkChars) || 0,
    nonWhitespaceChars: readPositiveInteger$o(source.nonWhitespaceChars) || 0,
    words: readPositiveInteger$o(source.words) || 0
  };
}

function formatTextStats$1(stats) {
  const value = normalizeTextStats$3(stats);
  return `chars:${value.chars},nonWhitespace:${value.nonWhitespaceChars},cjk:${value.cjkChars},words:${value.words}`;
}

function formatPublishBlockStatusCounts(value) {
  if (!value || typeof value !== "object") return "{}";
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${key}:${value[key]}`);
  return entries.length > 0 ? `{${entries.join(",")}}` : "{}";
}

function readStringArray$5(value) {
  return Array.isArray(value)
    ? value.map(readString).filter(Boolean)
    : [];
}

function readPositiveInteger$o(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export { acquireWorkspaceMutex, applyWorkspacePatch, buildVirtualWorkspacePromptBlock, buildWorkspaceStructureEcho, createEmptyVirtualWorkspace, createVirtualWorkspace, ensureVirtualWorkspace, finalizeWorkspaceCandidate, insertAfterWorkspaceSection, inspectWorkspaceCandidateReviewFreshness, inspectWorkspaceCandidateStructure, inspectWorkspacePublishProtocol, listWorkspaceFiles, moveWorkspaceFile, normalizeVirtualWorkspace, normalizeVirtualWorkspaceConfig, projectWorkspaceCandidateLifecycle, proposeWorkspacePatch, publishWorkspaceEvent, readWorkspaceFile, readWorkspaceFinalCandidate, recordWorkspaceCandidateReview, recordWorkspacePublishCandidateLifecycle, recordWorkspaceRead, removeWorkspaceFile, replaceWorkspaceFile, shouldEnableVirtualWorkspace, stripInternalVirtualWorkspaceSections, validateWorkspacePath, validateWorkspacePathRecoverable, writeWorkspaceFile };
