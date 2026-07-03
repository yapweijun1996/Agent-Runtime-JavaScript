// Layer-0 multi-edit snapshot + read-requirement helpers, extracted from
// virtual-workspace-actions.js (AGRUN-451 slice 3). Pure runState/workspace
// readers and mutators with ZERO imports — the cluster is closed (the only
// intra-cluster edge is checkMultiEditReadRequirement -> checkWorkspaceReadRequirement;
// nothing here calls back into virtual-workspace-actions.js).
//
//   - captureMultiEditSnapshot / restoreMultiEditSnapshot: atomic multi-edit
//     all-or-nothing rollback (snapshot the touched files before, restore on abort).
//   - checkWorkspaceReadRequirement: enforce "workspace_read before mutating a
//     non-empty file" (and re-read after an external change). Consumed by the
//     write, replace, and multi-edit executors.
//   - checkMultiEditReadRequirement: thin per-op alias used by the multi-edit loop.

function captureMultiEditSnapshot(runState, operations) {
  const workspace = runState && runState.virtualWorkspace;
  if (!workspace) return null;
  const snapshot = {};
  for (const op of operations) {
    const p = op && typeof op.path === "string" ? op.path.trim() : "";
    if (p && !(p in snapshot)) {
      const f = workspace.files && workspace.files[p];
      snapshot[p] = f ? { ...f } : null;
    }
  }
  return snapshot;
}

function restoreMultiEditSnapshot(runState, snapshot) {
  const workspace = runState && runState.virtualWorkspace;
  if (!workspace || !snapshot) return;
  for (const [p, file] of Object.entries(snapshot)) {
    if (file) {
      workspace.files[p] = { ...file };
    } else {
      delete workspace.files[p];
    }
  }
}

function checkWorkspaceReadRequirement(workspace, path) {
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : {};
  const file = files[path];
  const currentContent = file && typeof file.content === "string" ? file.content : "";
  if (!currentContent.trim()) return null;
  const lastRead = workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== path) {
    return `workspace mutation on ${path}: workspace_read this file first (${currentContent.length} chars of existing content).`;
  }
  const readAt = typeof lastRead.observedAt === "string" ? lastRead.observedAt.trim() : "";
  const updatedAt = typeof file.updatedAt === "string" ? file.updatedAt.trim() : "";
  if (readAt && updatedAt && readAt < updatedAt) {
    return `workspace mutation on ${path}: file changed since last workspace_read (read=${readAt}, updated=${updatedAt}); workspace_read it again.`;
  }
  return null;
}

function checkMultiEditReadRequirement(workspace, path) {
  return checkWorkspaceReadRequirement(workspace, path);
}

export { captureMultiEditSnapshot, checkMultiEditReadRequirement, checkWorkspaceReadRequirement, restoreMultiEditSnapshot };
