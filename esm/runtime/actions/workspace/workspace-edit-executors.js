import { listWorkspaceFiles, readWorkspaceFile, recordWorkspaceRead, acquireWorkspaceMutex, writeWorkspaceFile, publishWorkspaceEvent, buildWorkspaceStructureEcho, replaceWorkspaceFile, proposeWorkspacePatch, applyWorkspacePatch, insertAfterWorkspaceSection, removeWorkspaceFile, moveWorkspaceFile, readWorkspaceFinalCandidate } from '../../virtual-workspace.js';
import { readString } from '../../semantic-json.js';
import { formatTextStats, summarizeWorkspaceRead, summarizeLengthProgress, summarizeFile, summarizeWorkspaceMutation, summarizeMutationStats, summarizeWorkspacePathsStats, summarizeAggregateMutationStats } from './workspace-stats.js';
import { buildReplaceVetoedSuggestion, buildReplaceNotFoundSuggestion, canAutoApplyWorkspacePatch, suggestWorkspacePatchNextStep } from './patch-suggestions.js';
import { checkWorkspaceReadRequirement, captureMultiEditSnapshot, restoreMultiEditSnapshot, checkMultiEditReadRequirement } from './multi-edit-snapshot.js';
import { ensureWorkspace } from './workspace-preflight.js';

// Edit/mutation action executors (workspace_list / read / write / replace /
// propose_patch / apply_patch / insert_after_section / remove / move /
// multi_edit), extracted from virtual-workspace-actions.js (AGRUN-451 slice 11,
// the thematic split part 2/2). These implement the workspace file mutators,
// delegating to the virtual-workspace.js core + the extracted workspace/ helper
// modules. The action defs stay in virtual-workspace-actions.js and import these
// ten back for their `execute:` fields; the god file also re-exports them so the
// public surface (action-registry + workspace-actions.test.js) is unchanged.


async function executeWorkspaceListAction(context) {
  const workspace = ensureWorkspace(context);
  return {
    control: "continue",
    output: {
      candidateLifecycle: workspace.candidateLifecycle || null,
      candidatePathMismatchSignal: context.runState && context.runState.candidatePathMismatchSignal || workspace.candidatePathMismatchSignal || null,
      enabled: workspace.enabled === true,
      files: listWorkspaceFiles(workspace),
      kind: "virtual_workspace_list",
      mode: workspace.mode,
      quality: workspace.quality
    },
    summary: `workspace_list(files=${Object.keys(workspace.files || {}).length})`
  };
}

async function executeWorkspaceReadAction(context, args) {
  const workspace = ensureWorkspace(context);
  const file = readWorkspaceFile(workspace, args && args.path);
  recordWorkspaceRead(context.runState, file.path, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: `reviewed ${file.path} (${formatTextStats(file.textStats)})`
  });
  return {
    control: "continue",
    output: {
      candidateLifecycle: context.runState.virtualWorkspace && context.runState.virtualWorkspace.candidateLifecycle || null,
      candidatePathMismatchSignal: context.runState.candidatePathMismatchSignal || null,
      file,
      kind: "virtual_workspace_read",
      lengthProgress: summarizeLengthProgress(context, file)
    },
    summary: summarizeWorkspaceRead(file, context)
  };
}

async function executeWorkspaceWriteAction(context, args) {
  const workspace = ensureWorkspace(context);
  const beforeFile = readWorkspaceFile(workspace, args && args.path);
  const readError = checkWorkspaceReadRequirement(workspace, args && args.path);
  if (readError) {
    return {
      control: "continue",
      output: {
        candidateLifecycle: workspace.candidateLifecycle || null,
        candidatePathMismatchSignal: context.runState && context.runState.candidatePathMismatchSignal || null,
        file: summarizeFile(beforeFile),
        kind: "virtual_workspace_write",
        lengthProgress: null,
        message: readError,
        mutationStats: null,
        quality: workspace.quality,
        shrinkRisk: null,
        status: "read_required"
      },
      summary: `workspace_write(${beforeFile.path || "?"}, status=read_required)`
    };
  }
  const release = await acquireWorkspaceMutex(context.runState, args && args.path);
  try {
    const file = writeWorkspaceFile(context.runState, args && args.path, args && args.content, {
      config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
      maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
      maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
      prompt: context.request && context.request.prompt,
      summary: args && args.summary
    });
    publishWorkspaceEvent(context.runState, { type: "workspace_write", path: file && file.path, status: file && file.status || "ok" });
    return {
      control: "continue",
      output: {
        candidateLifecycle: context.runState.virtualWorkspace && context.runState.virtualWorkspace.candidateLifecycle || null,
        candidatePathMismatchSignal: context.runState.candidatePathMismatchSignal || null,
        file: summarizeFile(file),
        kind: "virtual_workspace_write",
        lengthProgress: summarizeLengthProgress(context, file),
        message: file && file.message || null,
        mutationStats: summarizeMutationStats(beforeFile, file, args && args.content),
        quality: context.runState.virtualWorkspace.quality,
        shrinkRisk: file && file.shrinkRisk || null,
        status: file && file.status || "ok",
        structureEcho: buildWorkspaceStructureEcho(file && file.content)
      },
      summary: summarizeWorkspaceMutation("workspace_write", file, context)
    };
  } finally {
    release();
  }
}

async function executeWorkspaceReplaceAction(context, args) {
  const workspace = ensureWorkspace(context);
  const beforeFile = readWorkspaceFile(workspace, args && args.path);
  const readError = checkWorkspaceReadRequirement(workspace, args && args.path);
  if (readError) {
    return {
      control: "continue",
      output: {
        changed: false,
        contextSnippets: [],
        file: summarizeFile(beforeFile),
        fuzzyAttempted: [],
        fuzzyMatch: null,
        kind: "virtual_workspace_replace",
        lengthProgress: null,
        matchCount: null,
        missHints: null,
        mutationStats: null,
        quality: workspace.quality,
        repeatedFindCount: null,
        replacedAll: false,
        status: "read_required",
        suggestion: readError,
        error: null,
        message: readError
      },
      summary: `workspace_replace(${beforeFile.path || "?"}, status=read_required)`
    };
  }
  const release = await acquireWorkspaceMutex(context.runState, args && args.path);
  try {
    const result = replaceWorkspaceFile(context.runState, args && args.path, args && args.find, args && args.replace, {
      config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
      maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
      maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
      prompt: context.request && context.request.prompt,
      replaceAll: args && args.replace_all === true,
      summary: args && args.summary
    });
    const status = readString(result.status) || (result.changed ? "ok" : "not_found");
    publishWorkspaceEvent(context.runState, { type: "workspace_replace", path: result.file && result.file.path, status });
    const summaryParts = [`workspace_replace(${result.file.path}, status=${status}`];
    if (typeof result.matchCount === "number") summaryParts.push(`matches=${result.matchCount}`);
    if (result.fuzzyMatch) summaryParts.push(`fuzzy=${result.fuzzyMatch}`);
    return {
      control: "continue",
      output: {
        changed: result.changed,
        contextSnippets: Array.isArray(result.contextSnippets) ? result.contextSnippets : [],
        file: summarizeFile(result.file),
        fuzzyAttempted: Array.isArray(result.fuzzyAttempted) ? result.fuzzyAttempted : [],
        fuzzyMatch: result.fuzzyMatch || null,
        kind: "virtual_workspace_replace",
        lengthProgress: summarizeLengthProgress(context, result.file),
        matchCount: typeof result.matchCount === "number" ? result.matchCount : null,
        missHints: result.missHints || null,
        mutationStats: summarizeMutationStats(beforeFile, result.file, args && args.replace),
        quality: context.runState.virtualWorkspace.quality,
        repeatedFindCount: typeof result.repeatedFindCount === "number" ? result.repeatedFindCount : null,
        replacedAll: result.replacedAll === true,
        status,
        structureEcho: buildWorkspaceStructureEcho(result.file && result.file.content),
        suggestion: status === "ambiguous"
          ? "Widen the find text with surrounding context until it is unique, or call workspace_replace again with replace_all:true to replace every occurrence."
          : status === "repeated_find_vetoed"
            ? buildReplaceVetoedSuggestion(result.missHints, result.repeatedFindCount)
            : status === "not_found"
              ? buildReplaceNotFoundSuggestion(result.missHints)
              : status === "invalid_args"
                ? "Provide a non-empty find string and a valid workspace path (no absolute, no '..', no backslash), then retry."
                : null,
        error: result.error || null,
        message: result.message || null
      },
      summary: `${summaryParts.join(", ")})`
    };
  } finally {
    release();
  }
}

async function executeWorkspaceProposePatchAction(context, args) {
  const beforeFile = readWorkspaceFile(ensureWorkspace(context), args && args.path);
  const result = proposeWorkspacePatch(context.runState, args && args.path, args && args.operations, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const autoApply = args && args.applyIfValid === true;
  const autoApplyEligible = autoApply && canAutoApplyWorkspacePatch(result);
  const applied = autoApplyEligible && result.valid === true
    ? applyWorkspacePatch(context.runState, result.patchId, {
        config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
        maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
        prompt: context.request && context.request.prompt,
        summary: args && args.summary
      })
    : null;
  const appliedFile = applied && applied.file && typeof applied.file === "object" ? applied.file : null;
  return {
    control: "continue",
    output: {
      applied: Boolean(applied && applied.changed === true),
      applyStatus: applied ? applied.status : autoApply
        ? autoApplyEligible
          ? "not_applied"
          : "skipped_requires_heading_only_patch"
        : null,
      afterWords: result.afterWords,
      baseVersion: result.baseVersion,
      beforeWords: result.beforeWords,
      changed: result.changed,
      deltaWords: result.deltaWords,
      file: summarizeFile(beforeFile),
      kind: "virtual_workspace_propose_patch",
      operations: Array.isArray(result.operations) ? result.operations : [],
      patchId: result.patchId,
      path: result.path,
      previewSummary: result.previewSummary,
      riskFlags: Array.isArray(result.riskFlags) ? result.riskFlags : [],
      file: appliedFile ? summarizeFile(appliedFile) : summarizeFile(beforeFile),
      lengthProgress: appliedFile ? summarizeLengthProgress(context, appliedFile) : null,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      status: applied && applied.changed === true ? "applied" : result.status,
      structureAfter: result.structureAfter || null,
      structureBefore: result.structureBefore || null,
      suggestion: suggestWorkspacePatchNextStep(result, { applied, autoApply, autoApplyEligible }),
      valid: result.valid === true
    },
    summary: `workspace_propose_patch(${result.path || "<invalid>"}, status=${applied && applied.changed === true ? "applied" : result.status}, deltaWords=${result.deltaWords}, riskFlags=${Array.isArray(result.riskFlags) && result.riskFlags.length ? result.riskFlags.join("|") : "none"})`
  };
}

async function executeWorkspaceApplyPatchAction(context, args) {
  const result = applyWorkspacePatch(context.runState, args && args.patchId, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const file = result.file && typeof result.file === "object" ? result.file : null;
  publishWorkspaceEvent(context.runState, { type: "workspace_apply_patch", path: file && file.path || null, status: result.status });
  return {
    control: "continue",
    output: {
      baseVersion: result.baseVersion,
      changed: result.changed === true,
      currentVersion: result.currentVersion,
      error: result.error || null,
      expectedPatchId: result.expectedPatchId || null,
      file: file ? summarizeFile(file) : null,
      kind: "virtual_workspace_apply_patch",
      lengthProgress: file ? summarizeLengthProgress(context, file) : null,
      message: result.message || null,
      patchId: result.patchId || null,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      riskFlags: Array.isArray(result.riskFlags) ? result.riskFlags : [],
      status: result.status
    },
    summary: `workspace_apply_patch(${result.patchId || "<none>"}, status=${result.status}, changed=${result.changed ? "yes" : "no"})`
  };
}

async function executeWorkspaceInsertAfterSectionAction(context, args) {
  const beforeFile = readWorkspaceFile(ensureWorkspace(context), args && args.path);
  const result = insertAfterWorkspaceSection(context.runState, args && args.path, args && args.heading, args && args.content, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    separator: args && args.separator,
    summary: args && args.summary
  });
  const status = readString(result.status) || (result.changed ? "ok" : "heading_not_found");
  const availableHeadings = Array.isArray(result.availableHeadings) ? result.availableHeadings : [];
  publishWorkspaceEvent(context.runState, { type: "workspace_insert_after_section", path: args && args.path || null, status });
  return {
    control: "continue",
    output: {
      availableHeadings,
      changed: result.changed,
      file: summarizeFile(result.file),
      heading: result.heading,
      kind: "virtual_workspace_insert_after_section",
      lengthProgress: summarizeLengthProgress(context, result.file),
      mutationStats: summarizeMutationStats(beforeFile, result.file, args && args.content),
      quality: context.runState.virtualWorkspace.quality,
      requestedHeading: result.requestedHeading || result.heading,
      status,
      structureEcho: buildWorkspaceStructureEcho(result.file && result.file.content),
      structureRisk: result.structureRisk || null,
      suggestion: status === "heading_not_found"
        ? availableHeadings.length > 0
          ? `Heading "${result.requestedHeading || result.heading}" not found. Available headings: ${availableHeadings.map((entry) => entry.text).join(" | ")}. Pick one of these (case/punctuation will be normalized) to expand an existing section.`
          : `Heading "${result.requestedHeading || result.heading}" not found and the file has no Markdown headings yet. Write the file with workspace_write first so it has section headings to anchor to.`
        : status === "ambiguous"
          ? `Heading "${result.requestedHeading || result.heading}" is ambiguous because multiple matching sections exist. Use workspace_read to inspect the duplicated headings, then merge/remove duplicates or choose a unique heading before retrying.`
        : status === "invalid_args"
          ? "Provide a non-empty heading and a valid workspace path (no absolute, no '..', no backslash), then retry."
          : result.structureRisk === "structure_maybe_worse"
            ? "Insertion succeeded but worsened final candidate structure. Continue length growth if needed, then use workspace_propose_patch normalize_headings with section_number_repair_context before publishing ready."
            : null,
      structureAfter: result.structureAfter || null,
      structureBefore: result.structureBefore || null,
      error: result.error || null,
      message: result.message || null
    },
    summary: `${summarizeWorkspaceMutation("workspace_insert_after_section", result.file, context)}, status=${status}, availableHeadings=${availableHeadings.length}`
  };
}

async function executeWorkspaceRemoveAction(context, args) {
  const result = removeWorkspaceFile(context.runState, args && args.path, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  publishWorkspaceEvent(context.runState, { type: "workspace_remove", path: result.file && result.file.path || null, status: result.removed ? "ok" : "not_found" });
  return {
    control: "continue",
    output: {
      file: summarizeFile(result.file),
      kind: "virtual_workspace_remove",
      quality: context.runState.virtualWorkspace.quality,
      removed: result.removed
    },
    summary: `workspace_remove(${result.file.path}, removed=${result.removed ? "yes" : "no"})`
  };
}

async function executeWorkspaceMoveAction(context, args) {
  const result = moveWorkspaceFile(context.runState, args && args.from, args && args.to, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    overwrite: args && args.overwrite === true,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  publishWorkspaceEvent(context.runState, { type: "workspace_move", path: result.toFile && result.toFile.path || readString(args && args.to) || null, status: result.status });
  return {
    control: "continue",
    output: {
      error: result.error || null,
      fromFile: result.fromFile ? summarizeFile(result.fromFile) : null,
      kind: "virtual_workspace_move",
      message: result.message || null,
      moved: result.moved === true,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      status: result.status,
      toFile: result.toFile ? summarizeFile(result.toFile) : null
    },
    summary: `workspace_move(${readString(args && args.from)} → ${readString(args && args.to)}, status=${result.status})`
  };
}

async function executeWorkspaceMultiEditAction(context, args) {
  const workspace = ensureWorkspace(context);
  const operations = Array.isArray(args && args.operations) ? args.operations : [];
  const atomic = (args && args.atomic) === true;
  const summary = readString(args && args.summary);
  const touchedPaths = Array.from(new Set(
    operations.map((op) => readString(op && op.path)).filter(Boolean)
  ));
  const beforeStats = summarizeWorkspacePathsStats(workspace, touchedPaths);

  if (operations.length === 0) {
    return {
      control: "continue",
      output: {
        atomic,
        failedCount: 0,
        kind: "virtual_workspace_multi_edit",
        message: "workspace_multi_edit requires at least one operation",
        operationCount: 0,
        results: [],
        status: "no_operations",
        succeededCount: 0
      },
      summary: "workspace_multi_edit(ops=0, status=no_operations)"
    };
  }

  // Snapshot is keyed by path and captured from runState so restore always
  // targets the current runState.virtualWorkspace (ensureVirtualWorkspace
  // replaces the reference on each primitive call, making a stale local
  // `workspace` variable unsafe for rollback).
  const snapshot = atomic ? captureMultiEditSnapshot(context.runState, operations) : null;
  const results = [];
  let aborted = false;

  for (let i = 0; i < operations.length; i++) {
    if (aborted) {
      results.push({ index: i, status: "aborted", message: "atomic batch aborted due to earlier failure" });
      continue;
    }
    const op = operations[i];
    if (!op || typeof op !== "object") {
      const entry = { index: i, status: "invalid_args", message: "operation must be an object" };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
      continue;
    }
    const action = readString(op.action || op.type);
    const opPath = readString(op.path);
    if (!opPath) {
      const entry = { index: i, status: "invalid_args", message: "operation requires path" };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
      continue;
    }
    // Always check against the current workspace — primitive functions replace
    // runState.virtualWorkspace with a new normalized object on each call, so
    // re-dereference here instead of using the initial `workspace` local.
    const currentWorkspace = context.runState.virtualWorkspace;
    const readError = checkMultiEditReadRequirement(currentWorkspace, opPath);
    if (readError) {
      const entry = { index: i, status: "read_required", path: opPath, message: readError };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
      continue;
    }
    if (action === "replace") {
      const opResult = replaceWorkspaceFile(context.runState, opPath, op.find, op.replace, {
        config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
        maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
        maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
        prompt: context.request && context.request.prompt,
        replaceAll: op.replace_all === true,
        summary: summary || `multi_edit[${i}] replace in ${opPath}`
      });
      const opStatus = readString(opResult.status) || (opResult.changed ? "ok" : "not_found");
      const entry = { index: i, status: opStatus, path: opPath, file: opResult.file ? summarizeFile(opResult.file) : null, contextSnippets: Array.isArray(opResult.contextSnippets) ? opResult.contextSnippets : [] };
      if (typeof opResult.matchCount === "number") entry.matchCount = opResult.matchCount;
      results.push(entry);
      if (opStatus !== "ok" && atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
    } else if (action === "insert_after_section") {
      const opResult = insertAfterWorkspaceSection(context.runState, opPath, op.heading, op.content, {
        config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
        maxFileChars: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxFileChars,
        maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
        prompt: context.request && context.request.prompt,
        separator: op.separator,
        summary: summary || `multi_edit[${i}] insert_after_section in ${opPath}`
      });
      const opStatus = readString(opResult.status) || (opResult.changed ? "ok" : "heading_not_found");
      const entry = { index: i, status: opStatus, path: opPath, file: opResult.file ? summarizeFile(opResult.file) : null, availableHeadings: Array.isArray(opResult.availableHeadings) ? opResult.availableHeadings : [] };
      results.push(entry);
      if (opStatus !== "ok" && atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
    } else {
      const entry = { index: i, status: "invalid_args", path: opPath, message: `unknown action "${action}"; supported: replace, insert_after_section` };
      results.push(entry);
      if (atomic) { aborted = true; restoreMultiEditSnapshot(context.runState, snapshot); }
    }
  }

  const failedCount = results.filter((r) => r.status !== "ok" && r.status !== "aborted").length;
  const succeededCount = results.filter((r) => r.status === "ok").length;
  const overallStatus = aborted ? "aborted" : failedCount === 0 ? "ok" : "partial";
  const afterStats = summarizeWorkspacePathsStats(context.runState && context.runState.virtualWorkspace, touchedPaths);
  publishWorkspaceEvent(context.runState, { type: "workspace_multi_edit", path: touchedPaths.join(",") || null, status: overallStatus });
  const multiEditCandidate = readWorkspaceFinalCandidate(context.runState && context.runState.virtualWorkspace, null);
  return {
    control: "continue",
    output: {
      atomic,
      failedCount,
      kind: "virtual_workspace_multi_edit",
      mutationStats: summarizeAggregateMutationStats(beforeStats, afterStats),
      operationCount: operations.length,
      quality: context.runState.virtualWorkspace && context.runState.virtualWorkspace.quality,
      results,
      status: overallStatus,
      structureEcho: buildWorkspaceStructureEcho(multiEditCandidate && multiEditCandidate.content),
      succeededCount
    },
    summary: `workspace_multi_edit(ops=${operations.length}, ok=${succeededCount}, failed=${failedCount}, status=${overallStatus})`
  };
}

export { executeWorkspaceApplyPatchAction, executeWorkspaceInsertAfterSectionAction, executeWorkspaceListAction, executeWorkspaceMoveAction, executeWorkspaceMultiEditAction, executeWorkspaceProposePatchAction, executeWorkspaceReadAction, executeWorkspaceRemoveAction, executeWorkspaceReplaceAction, executeWorkspaceWriteAction };
