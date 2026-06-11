import { cloneValue } from './utils.js';

const DEFAULT_CANDIDATE_PATH = "final_candidate.md";

function createWorkspaceCandidateLifecycle(options = {}) {
  const activePath = normalizeWorkspacePath(options.activePath) || DEFAULT_CANDIDATE_PATH;
  return {
    activePath,
    draftPaths: normalizeDraftPaths(options.draftPaths, activePath),
    lastWrittenPath: normalizeWorkspacePath(options.lastWrittenPath) || null,
    lastReadPath: normalizeWorkspacePath(options.lastReadPath) || null,
    finalizedPath: normalizeWorkspacePath(options.finalizedPath) || null,
    publishedPath: normalizeWorkspacePath(options.publishedPath) || null,
    status: normalizeLifecycleStatus(options.status) || "idle"
  };
}

function normalizeWorkspaceCandidateLifecycle(value, options = {}) {
  const selectedPath = normalizeWorkspacePath(options.activePath) || DEFAULT_CANDIDATE_PATH;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const activePath = normalizeWorkspacePath(source.activePath) || selectedPath;
  return createWorkspaceCandidateLifecycle({
    activePath,
    draftPaths: source.draftPaths,
    lastWrittenPath: source.lastWrittenPath,
    lastReadPath: source.lastReadPath,
    finalizedPath: source.finalizedPath,
    publishedPath: source.publishedPath,
    status: source.status
  });
}

function normalizeCandidatePathMismatchSignal(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const mismatchKind = readString$1D(source.mismatchKind);
  const selectedPath = normalizeWorkspacePath(source.selectedPath);
  if (!mismatchKind || !selectedPath) return null;
  return {
    action: readString$1D(source.action) || null,
    activePath: normalizeWorkspacePath(source.activePath) || selectedPath,
    finalizedPath: normalizeWorkspacePath(source.finalizedPath) || null,
    kind: "candidate_path_mismatch_signal",
    lastWrittenPath: normalizeWorkspacePath(source.lastWrittenPath) || null,
    mismatchKind,
    observedAt: readString$1D(source.observedAt) || null,
    publishedPath: normalizeWorkspacePath(source.publishedPath) || null,
    selectedPath,
    status: readString$1D(source.status) || "observed",
    writtenPath: normalizeWorkspacePath(source.writtenPath) || null
  };
}

function projectWorkspaceCandidateLifecycle(workspace) {
  const source = workspace && typeof workspace === "object" && !Array.isArray(workspace) ? workspace : {};
  const selectedPath = readWorkspaceSelectedCandidatePath(source);
  return {
    candidateLifecycle: normalizeWorkspaceCandidateLifecycle(source.candidateLifecycle, { activePath: selectedPath }),
    candidatePathMismatchSignal: normalizeCandidatePathMismatchSignal(source.candidatePathMismatchSignal)
  };
}

function recordWorkspaceCandidateWrite(workspace, path, options = {}) {
  const filePath = normalizeWorkspacePath(path);
  if (!workspace || typeof workspace !== "object" || !filePath) return null;
  const lifecycle = ensureWorkspaceCandidateLifecycle(workspace);
  const selectedPath = readWorkspaceSelectedCandidatePath(workspace, lifecycle.activePath);
  lifecycle.activePath = selectedPath;
  lifecycle.lastWrittenPath = filePath;
  lifecycle.status = "drafting";

  let signal = null;
  if (filePath !== selectedPath) {
    lifecycle.draftPaths = addDraftPath(lifecycle.draftPaths, filePath, selectedPath);
    lifecycle.status = "mismatch_observed";
    signal = createCandidatePathMismatchSignal({
      action: options.action || "write",
      lifecycle,
      mismatchKind: "write_to_non_selected_path",
      selectedPath,
      writtenPath: filePath
    });
  } else {
    lifecycle.draftPaths = removeDraftPath(lifecycle.draftPaths, filePath);
  }
  workspace.candidatePathMismatchSignal = signal;
  return signal;
}

function recordWorkspaceCandidateRead(workspace, path, options = {}) {
  const filePath = normalizeWorkspacePath(path);
  if (!workspace || typeof workspace !== "object" || !filePath) return null;
  const lifecycle = ensureWorkspaceCandidateLifecycle(workspace);
  lifecycle.activePath = readWorkspaceSelectedCandidatePath(workspace, lifecycle.activePath);
  lifecycle.lastReadPath = filePath;
  if (!workspace.candidatePathMismatchSignal) {
    lifecycle.status = "reviewed";
  }
  return normalizeCandidatePathMismatchSignal(workspace.candidatePathMismatchSignal);
}

function recordWorkspaceCandidateFinalize(workspace, path, options = {}) {
  const filePath = normalizeWorkspacePath(path);
  if (!workspace || typeof workspace !== "object" || !filePath) return null;
  const lifecycle = ensureWorkspaceCandidateLifecycle(workspace);
  const hadPriorWrite = options.hadPriorWrite === true || hasPriorWriteToPath(workspace, filePath, lifecycle);
  lifecycle.activePath = filePath;
  lifecycle.finalizedPath = filePath;
  lifecycle.draftPaths = removeDraftPath(lifecycle.draftPaths, filePath);
  lifecycle.status = hadPriorWrite ? "finalized" : "mismatch_observed";

  const signal = hadPriorWrite
    ? null
    : createCandidatePathMismatchSignal({
      action: options.action || "finalize_candidate",
      finalizedPath: filePath,
      lifecycle,
      mismatchKind: "finalize_without_prior_write",
      selectedPath: filePath,
      writtenPath: lifecycle.lastWrittenPath
    });
  workspace.candidatePathMismatchSignal = signal;
  return signal;
}

function recordWorkspaceCandidatePublish(workspace, path, options = {}) {
  const filePath = normalizeWorkspacePath(path);
  if (!workspace || typeof workspace !== "object" || !filePath) return null;
  const lifecycle = ensureWorkspaceCandidateLifecycle(workspace);
  const selectedPath = readWorkspaceSelectedCandidatePath(workspace, lifecycle.activePath);
  lifecycle.activePath = selectedPath;

  let signal = null;
  const latestWrittenPath = normalizeWorkspacePath(options.lastWrittenPath) || lifecycle.lastWrittenPath;
  if (latestWrittenPath && latestWrittenPath !== filePath) {
    signal = createCandidatePathMismatchSignal({
      action: options.action || "publish_candidate",
      lifecycle,
      mismatchKind: "publish_stale_path",
      publishedPath: filePath,
      selectedPath,
      writtenPath: latestWrittenPath
    });
  } else if (lifecycle.finalizedPath && lifecycle.finalizedPath !== filePath) {
    signal = createCandidatePathMismatchSignal({
      action: options.action || "publish_candidate",
      finalizedPath: lifecycle.finalizedPath,
      lifecycle,
      mismatchKind: "publish_non_finalized_path",
      publishedPath: filePath,
      selectedPath,
      writtenPath: latestWrittenPath
    });
  }

  if (options.completed === true) {
    lifecycle.publishedPath = filePath;
    lifecycle.status = signal ? "mismatch_observed" : "published";
  } else if (signal) {
    lifecycle.status = "mismatch_observed";
  } else if (!workspace.candidatePathMismatchSignal) {
    lifecycle.status = "publish_attempted";
  }

  workspace.candidatePathMismatchSignal = signal;
  return signal;
}

function syncRunStateCandidatePathMismatchSignal(runState, workspace) {
  if (!runState || typeof runState !== "object") return null;
  const projection = projectWorkspaceCandidateLifecycle(workspace);
  runState.candidatePathMismatchSignal = cloneValue(projection.candidatePathMismatchSignal);
  return runState.candidatePathMismatchSignal;
}

function ensureWorkspaceCandidateLifecycle(workspace) {
  const selectedPath = readWorkspaceSelectedCandidatePath(workspace);
  workspace.candidateLifecycle = normalizeWorkspaceCandidateLifecycle(workspace.candidateLifecycle, {
    activePath: selectedPath
  });
  return workspace.candidateLifecycle;
}

function createCandidatePathMismatchSignal(options) {
  const lifecycle = options.lifecycle && typeof options.lifecycle === "object"
    ? options.lifecycle
    : createWorkspaceCandidateLifecycle();
  return normalizeCandidatePathMismatchSignal({
    action: options.action,
    activePath: lifecycle.activePath,
    finalizedPath: options.finalizedPath || lifecycle.finalizedPath,
    kind: "candidate_path_mismatch_signal",
    lastWrittenPath: lifecycle.lastWrittenPath,
    mismatchKind: options.mismatchKind,
    observedAt: new Date().toISOString(),
    publishedPath: options.publishedPath || lifecycle.publishedPath,
    selectedPath: options.selectedPath,
    status: "observed",
    writtenPath: options.writtenPath
  });
}

function hasPriorWriteToPath(workspace, filePath, lifecycle) {
  if (lifecycle && lifecycle.lastWrittenPath === filePath) return true;
  const operations = Array.isArray(workspace && workspace.operations) ? workspace.operations : [];
  return operations.some((operation) => (
    operation &&
    operation.path === filePath &&
    operation.status === "ok" &&
    isContentWriteAction(operation.action)
  ));
}

function isContentWriteAction(action) {
  const value = readString$1D(action);
  return value === "write" ||
    value === "replace" ||
    value === "append" ||
    value === "insert_after_section" ||
    value === "apply_patch" ||
    value === "move" ||
    value === "promote";
}

function readWorkspaceSelectedCandidatePath(workspace, fallback = DEFAULT_CANDIDATE_PATH) {
  const quality = workspace && workspace.quality && typeof workspace.quality === "object"
    ? workspace.quality
    : {};
  return normalizeWorkspacePath(quality.finalCandidatePath) || normalizeWorkspacePath(fallback) || DEFAULT_CANDIDATE_PATH;
}

function normalizeDraftPaths(value, activePath) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map(normalizeWorkspacePath)
    .filter((path) => {
      if (!path || path === activePath || seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .slice(-12);
}

function addDraftPath(paths, path, activePath) {
  return normalizeDraftPaths([...(Array.isArray(paths) ? paths : []), path], activePath);
}

function removeDraftPath(paths, path) {
  const filePath = normalizeWorkspacePath(path);
  return normalizeDraftPaths(Array.isArray(paths) ? paths.filter((entry) => entry !== filePath) : []);
}

function normalizeLifecycleStatus(value) {
  const status = readString$1D(value);
  if (!status) return "";
  if (
    status === "idle" ||
    status === "drafting" ||
    status === "reviewed" ||
    status === "finalized" ||
    status === "publish_attempted" ||
    status === "published" ||
    status === "mismatch_observed"
  ) {
    return status;
  }
  return "";
}

function normalizeWorkspacePath(value) {
  const path = readString$1D(value);
  if (!path || path.startsWith("/") || path.includes("..") || /[\\]/.test(path)) return "";
  return path;
}

function readString$1D(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createWorkspaceCandidateLifecycle, normalizeCandidatePathMismatchSignal, normalizeWorkspaceCandidateLifecycle, projectWorkspaceCandidateLifecycle, recordWorkspaceCandidateFinalize, recordWorkspaceCandidatePublish, recordWorkspaceCandidateRead, recordWorkspaceCandidateWrite, syncRunStateCandidatePathMismatchSignal };
