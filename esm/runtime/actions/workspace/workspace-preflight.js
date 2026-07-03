import { validateWorkspacePath, ensureVirtualWorkspace } from '../../virtual-workspace.js';
import { readString } from '../../semantic-json.js';

// Workspace action preflight helpers, extracted from virtual-workspace-actions.js
// (AGRUN-451 slice 9 — the finishing slice; after this the god file is just the
// action defs + the 14 executors). These run before/at action dispatch:
//   - ensureWorkspace: materialize (force) the runState virtual workspace.
//   - preflightWorkspacePath: validate the target path is workspace-relative.
//   - preflightWorkspaceMutationRequiresRead: the read-before-mutate gate (study
//     from claude-code FileEditTool's readFileState invariant) — only enforced
//     when there IS existing non-empty content the AI could be mutating blind.
// Three independent helpers (none calls another); nothing here calls back into
// virtual-workspace-actions.js. The executors import all three back.


function ensureWorkspace(context) {
  if (!context || !context.runState) {
    throw new Error("workspace action requires runState");
  }
  return ensureVirtualWorkspace(context.runState, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    force: true,
    prompt: context.request && context.request.prompt
  });
}

function preflightWorkspacePath(_context, args) {
  validateWorkspacePath(args && args.path);
}

// Read-before-mutate gate (study from claude-code FileEditTool — the
// readFileState invariant). Pure observation: only enforces the gate
// when there IS existing non-empty content the AI could be mutating
// without seeing. New files (no existing content) skip the check
// because writing into an empty slot is unambiguous. Missing runState
// (preflight unit tests pass {} as context) also skips the check; the
// gate runs at action execute time with full context.

function preflightWorkspaceMutationRequiresRead(context, args) {
  validateWorkspacePath(args && args.path);
  const runState = context && context.runState;
  if (!runState || typeof runState !== "object") return;
  const workspace = runState.virtualWorkspace;
  if (!workspace || typeof workspace !== "object") return;
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : {};
  const file = files[args.path];
  const currentContent = file && typeof file.content === "string" ? file.content : "";
  if (!currentContent.trim()) return;
  const lastRead = workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== args.path) {
    throw new Error(`workspace mutation on ${args.path}: workspace_read this file first so you see the current ${currentContent.length}-char content before editing.`);
  }
  const readAt = readString(lastRead.observedAt);
  const updatedAt = readString(file && file.updatedAt);
  if (readAt && updatedAt && readAt < updatedAt) {
    throw new Error(`workspace mutation on ${args.path}: file changed since last workspace_read (read=${readAt}, updated=${updatedAt}); workspace_read it again before editing.`);
  }
}

export { ensureWorkspace, preflightWorkspaceMutationRequiresRead, preflightWorkspacePath };
