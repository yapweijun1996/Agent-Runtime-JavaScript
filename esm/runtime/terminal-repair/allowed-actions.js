import { CANDIDATE_QUALITY_BLOCKED_REASON } from '../kernel-terminal-actions.js';
import { PUBLISH_DIRECT_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, TODO_ADVANCE_ACTION, TODO_RUN_NEXT_ACTION, TODO_CANCEL_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_MULTI_EDIT_ACTION, FINALIZE_CANDIDATE_ACTION, WORKSPACE_REVIEW_CANDIDATE_ACTION, WEB_SEARCH_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_APPLY_PATCH_ACTION } from '../action-names.js';
import { readEvidenceRecoveryActions } from '../evidence-policy.js';
import { readString, observableDeficitsRecord, readOnlyPlanningHardVetoForbiddenActions, workspaceMutationGrowthHardVetoForbiddenActions, readRecord, normalizeUrlKey, readCandidateUrl, readSearchPassItems, readStringArray, readFinalCandidatePathFromWorkspace, readNumber, readCurrentPublishProtocol } from './internal-utils.js';
import { isBudgetConstrainedForLimitedPublish, resolvePublishProtocolActionContract, isPublishProtocolRepairReason } from './publish-contract.js';
import { readCandidateQualitySignal, buildCandidateQualityCitationDeficit } from './facts.js';
import { shouldSurfaceMultiWriteIterationNudge, shouldRequireWorkspaceRepairInspection } from './signals.js';
import { isContentStructureForcedPublish, hasContentLevelStructureIssue } from './content-structure-exit.js';

// H10 split, Step 5 (AGRUN-507) — terminal-repair allowed-action whitelist.
// VERBATIM moves from terminal-repair-state.js (see
// agrun_docs/terminal-repair-split-design-2026-06-12.md). buildAllowedActions
// is ~356 lines of ORDER-LOAD-BEARING branches (hard-veto before budget before
// protocol before deficit combos) — it moved as ONE untouched block, per the
// design doc's hazard note. Its orbit helpers (evidence recovery, patch
// surface, churn filters, multi-write/inspection nudges, unread-candidate
// predicates) moved with it. No public exports.

function buildAllowedActions(deficits, budgetState, reason, observableDeficits, runState, escalation, runtimeConfig) {
  const actions = new Set();
  // AGRUN-542 — content-structure exit forced publish: the single content-
  // changing repair attempt budget is used (or the repair contract was
  // repeatedly ignored) while length + sources are satisfied, and the content-
  // level structure issue remains. Every further repair/finalize cycle is out
  // of contract — the honest limited publish is the ONLY action. This is the
  // FIRST branch on purpose: both dispatch doors (single-action preflight
  // allowlist and plan-batch planner-action-surface filter) consume the
  // resulting allowedActions, so collapsing here enforces the exit on both.
  // evaluateTerminalRepairState updates runState.contentStructureExitState
  // immediately before calling this builder.
  if (isContentStructureForcedPublish(runState)) {
    return [PUBLISH_DIRECT_ACTION];
  }
  // ADR-0033 Tier A.8 (X1 fix) — treat hard_veto state as a budget-constrained
  // exit condition for the structure-deficit branch, so AI can publish a
  // limited candidate (with structure in remainingGaps) instead of being
  // pinned into an unfixable repair loop.
    const hardVetoActive = readString(escalation) === "hard_veto";
    const lowBudget = budgetState === "low" || budgetState === "exhausted" || hardVetoActive;
    const todoLimitedPublishAllowed = isBudgetConstrainedForLimitedPublish({
      budgetState,
      escalation
    });
    const hasSource = deficits.includes("source");
    const hasLength = deficits.includes("length");
    const hasStructure = deficits.includes("structure");
    const hasTodo = deficits.includes("todo");
    const hasReadiness = deficits.includes("readiness");
    const hasReadinessOrTerminalLoop = hasReadiness || deficits.includes("terminal_loop");
    const hasObservableLengthDeficit = Boolean(observableDeficitsRecord(observableDeficits, "length"));
    const hasObservableStructureDeficit = Boolean(observableDeficitsRecord(observableDeficits, "structure"));
    const hasStructureRepairSignal = hasStructure || hasObservableStructureDeficit;
    const hasProductDeficit = hasSource || hasLength || hasStructureRepairSignal;
  const terminalLoopOnly = deficits.includes("terminal_loop") &&
    !deficits.some((name) => name === "source" || name === "length" || name === "structure" || name === "todo");
  const publishProtocolReason = readString(reason);
  const readOnlyPlanningForbiddenActions = readOnlyPlanningHardVetoForbiddenActions(runState);
  const readOnlyPlanningHardVeto = readOnlyPlanningForbiddenActions.size > 0;
  const workspaceMutationGrowthForbiddenActions = workspaceMutationGrowthHardVetoForbiddenActions(runState);
  const workspaceMutationGrowthHardVeto = workspaceMutationGrowthForbiddenActions.size > 0;
  const lengthLimitedPublishAllowed = shouldExposeLimitedPublishForBudget({
    budgetState,
    hardVetoActive,
    hasLengthDeficit: hasLength || hasObservableLengthDeficit,
    readOnlyPlanningHardVeto,
    workspaceMutationGrowthHardVeto
  });
  const workspacePatchSurface = resolveWorkspacePatchRepairSurface(runState, reason);
  const contentStructureRepairRequired = shouldPreferFullRewriteForStructureRepair(observableDeficits, runState);
  const sourceHasUnreadCandidates = hasUnreadSourceCandidates(runState) ||
    hasUnreadCitedUrlDeficit(runState) ||
    hasUnreadCitationDeficit(observableDeficits);
  const publishProtocolContract = resolvePublishProtocolActionContract(runState);
  const protocolRecoveryAction = readString(publishProtocolContract && publishProtocolContract.requiredAction);
  const protocolRequiredAction = isPublishProtocolRepairReason(publishProtocolReason)
    ? protocolRecoveryAction
    : "";
  const emptyFinalCandidate = hasEmptyFinalCandidateDeficit(observableDeficits, runState);

  if (publishProtocolReason === CANDIDATE_QUALITY_BLOCKED_REASON) {
    return buildCandidateQualityRepairActions({
      actions,
      budgetState,
      deficits,
      escalation,
      forbiddenActions: readOnlyPlanningForbiddenActions,
      protocolRequiredAction,
      runtimeConfig,
      runState,
      sourceHasUnreadCandidates,
      workspacePatchSurface
    }).slice(0, 16);
  }

  if (hardVetoActive && (hasProductDeficit || hasReadinessOrTerminalLoop || terminalLoopOnly)) {
    if (protocolRequiredAction) {
      return [protocolRequiredAction];
    }
    if (emptyFinalCandidate) {
      if (hasSource || (hasReadinessOrTerminalLoop && !hasLength && !hasTodo)) {
        addEvidenceRecoveryActions(actions, {
          forbiddenActions: readOnlyPlanningForbiddenActions,
          runtimeConfig,
          sourceHasUnreadCandidates
        });
      }
      actions.add(WORKSPACE_WRITE_ACTION);
      actions.add(WORKSPACE_REPLACE_ACTION);
      if (hasLength) {
        actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
      }
      addCandidateReviewRepairAction(actions, runState);
      if (hasTodo) {
        actions.add(TODO_ADVANCE_ACTION);
        actions.add(TODO_RUN_NEXT_ACTION);
        actions.add(TODO_CANCEL_ACTION);
      }
      return filterReadOnlyPlanningChurnActions(
        Array.from(actions),
        {
          deficits,
          forbiddenActions: readOnlyPlanningForbiddenActions,
          protocolRequiredAction,
          sourceHasUnreadCandidates
        }
      ).slice(0, 16);
    }
      if (hasStructureRepairSignal && !hasSource && !hasLength && hasTodo) {
        if (contentStructureRepairRequired) {
          actions.add(WORKSPACE_REPLACE_ACTION);
          actions.add(WORKSPACE_WRITE_ACTION);
        } else {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
          if (workspacePatchSurface === "blocked_preview") {
            actions.add(WORKSPACE_REPLACE_ACTION);
            actions.add(WORKSPACE_WRITE_ACTION);
          }
        }
        addCandidateReviewRepairAction(actions, runState);
        actions.add(TODO_ADVANCE_ACTION);
        actions.add(TODO_RUN_NEXT_ACTION);
        actions.add(TODO_CANCEL_ACTION);
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
        return applyMultiWriteIterationNudge(Array.from(actions), {
          activeDeficits: deficits,
          budgetState,
          observableDeficits,
          runState
        }).slice(0, 16);
      }
      if (hasSource || hasLength || hasObservableLengthDeficit || hasTodo || (hasReadinessOrTerminalLoop && hasObservableLengthDeficit)) {
      if (hasSource) {
        addEvidenceRecoveryActions(actions, {
          forbiddenActions: readOnlyPlanningForbiddenActions,
          runtimeConfig,
          sourceHasUnreadCandidates
        });
      }
      if (hasStructureRepairSignal && !hasLength && !hasObservableLengthDeficit) {
        if (contentStructureRepairRequired) {
          actions.add(WORKSPACE_REPLACE_ACTION);
          actions.add(WORKSPACE_WRITE_ACTION);
        } else {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
          if (workspacePatchSurface === "blocked_preview") {
            actions.add(WORKSPACE_REPLACE_ACTION);
          }
        }
      }
      if (hasLength || hasObservableLengthDeficit) {
        if (workspaceMutationGrowthHardVeto) {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        }
        actions.add(WORKSPACE_READ_ACTION);
        actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
        actions.add(WORKSPACE_MULTI_EDIT_ACTION);
        if (!workspaceMutationGrowthHardVeto) {
          actions.add(WORKSPACE_REPLACE_ACTION);
        }
        addCandidateReviewRepairAction(actions, runState);
      }
      if (hasTodo) {
        actions.add(TODO_ADVANCE_ACTION);
        actions.add(TODO_RUN_NEXT_ACTION);
        actions.add(TODO_CANCEL_ACTION);
      }
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
        return filterReadOnlyPlanningChurnActions(
          applyMultiWriteIterationNudge(Array.from(actions), {
            activeDeficits: deficits,
            budgetState,
            observableDeficits,
            runState
          }),
          {
            deficits,
            forbiddenActions: readOnlyPlanningForbiddenActions,
            protocolRequiredAction,
            sourceHasUnreadCandidates
          }
        ).slice(0, 16);
      }
      return [PUBLISH_DIRECT_ACTION];
    }

    if (hasTodo && !hasProductDeficit) {
      if (lowBudget) {
        actions.add(TODO_CANCEL_ACTION);
      }
      actions.add(TODO_ADVANCE_ACTION);
      actions.add(TODO_RUN_NEXT_ACTION);
      actions.add(TODO_CANCEL_ACTION);
      if (todoLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
      return applyMultiWriteIterationNudge(Array.from(actions), {
        activeDeficits: deficits,
        budgetState,
        observableDeficits,
        runState
      }).slice(0, 16);
    }

  if (!hasSource && !hasLength && !hasStructure && !hasTodo && publishProtocolReason === "missing_finalize_after_latest_write") {
    return [
      FINALIZE_CANDIDATE_ACTION
    ];
  }
  if (!hasSource && !hasLength && !hasStructure && !hasTodo && publishProtocolReason === "missing_latest_workspace_read") {
    return [
      WORKSPACE_READ_ACTION
    ];
  }
  if (!hasSource && !hasLength && !hasStructure && !hasTodo && publishProtocolReason === "missing_latest_candidate_review") {
    actions.add(WORKSPACE_REVIEW_CANDIDATE_ACTION);
    if (hasObservableLengthDeficit) {
      actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
      actions.add(WORKSPACE_MULTI_EDIT_ACTION);
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
    }
    return applyMultiWriteIterationNudge(Array.from(actions), {
      activeDeficits: deficits,
      budgetState,
      observableDeficits,
      runState
    }).slice(0, 16);
  }
  const readinessOnly = hasReadiness &&
    !hasSource &&
    !hasLength &&
    !hasObservableLengthDeficit &&
    !hasStructureRepairSignal &&
    !hasTodo &&
    !terminalLoopOnly;
  if (readinessOnly) {
    if (protocolRequiredAction || protocolRecoveryAction) {
      return [protocolRequiredAction || protocolRecoveryAction];
    }
    return [PUBLISH_DIRECT_ACTION];
  }

    if (hasSource || (hasReadinessOrTerminalLoop && !hasLength && !hasStructureRepairSignal && !hasTodo)) {
    addEvidenceRecoveryActions(actions, {
      forbiddenActions: readOnlyPlanningForbiddenActions,
      runtimeConfig,
      sourceHasUnreadCandidates
    });
    if (hasObservableLengthDeficit && isSourceReadQuotaSatisfied(observableDeficits)) {
      actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
      if (!lowBudget) {
        actions.add(WORKSPACE_WRITE_ACTION);
        actions.add(WORKSPACE_REPLACE_ACTION);
      }
    }
  }
    if (hasStructureRepairSignal) {
      const structureOnly = !hasSource && !hasLength && !hasObservableLengthDeficit;
      if (structureOnly) {
        if (contentStructureRepairRequired) {
          actions.add(WORKSPACE_REPLACE_ACTION);
          actions.add(WORKSPACE_WRITE_ACTION);
        } else {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface, {
            allowBlockedRetry: true
          });
        }
      if (hasTodo) {
        actions.add(TODO_ADVANCE_ACTION);
        actions.add(TODO_RUN_NEXT_ACTION);
        actions.add(TODO_CANCEL_ACTION);
      }
      addCandidateReviewRepairAction(actions, runState);
        if (lowBudget) {
          if (protocolRequiredAction || protocolRecoveryAction) {
            actions.add(protocolRequiredAction || protocolRecoveryAction);
          } else {
            if (lengthLimitedPublishAllowed) {
              actions.add(PUBLISH_DIRECT_ACTION);
            }
          }
        }
    } else {
      if (workspaceMutationGrowthHardVeto) {
        if (!contentStructureRepairRequired) {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        }
        actions.add(WORKSPACE_MULTI_EDIT_ACTION);
      } else {
        if (!contentStructureRepairRequired && !hasSource && workspacePatchSurface !== "blocked_preview") {
          addWorkspacePatchRepairActions(actions, workspacePatchSurface);
        }
        actions.add(WORKSPACE_WRITE_ACTION);
        actions.add(WORKSPACE_REPLACE_ACTION);
      }
      if (hasLength || hasObservableLengthDeficit) {
        actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
      }
      addCandidateReviewRepairAction(actions, runState);
      if (lowBudget) {
        if (protocolRequiredAction || protocolRecoveryAction) {
          actions.add(protocolRequiredAction || protocolRecoveryAction);
        } else {
          actions.add(PUBLISH_DIRECT_ACTION);
        }
      }
    }
  } else if (hasLength) {
    const length = observableDeficits && observableDeficits.length && typeof observableDeficits.length === "object"
      ? observableDeficits.length
      : null;
    const alternativeCandidate = length && length.alternativeCandidate && typeof length.alternativeCandidate === "object"
      ? length.alternativeCandidate
      : null;
    if (alternativeCandidate && alternativeCandidate.path) {
      actions.add(FINALIZE_CANDIDATE_ACTION);
      actions.add(WORKSPACE_READ_ACTION);
      actions.add(PUBLISH_DIRECT_ACTION);
    } else {
      if (lowBudget) {
        if (protocolRequiredAction || protocolRecoveryAction) {
          actions.add(protocolRequiredAction || protocolRecoveryAction);
        }
      }
      if (workspaceMutationGrowthHardVeto) {
        addWorkspacePatchRepairActions(actions, workspacePatchSurface);
      }
      actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
      actions.add(WORKSPACE_MULTI_EDIT_ACTION);
      addCandidateReviewRepairAction(actions, runState);
      if (!lowBudget) {
        actions.add(WORKSPACE_READ_ACTION);
        if (!workspaceMutationGrowthHardVeto) {
          actions.add(WORKSPACE_WRITE_ACTION);
          actions.add(WORKSPACE_REPLACE_ACTION);
        }
      }
    }
  } else if (terminalLoopOnly && !lowBudget) {
    actions.add(WORKSPACE_READ_ACTION);
    if (workspaceMutationGrowthHardVeto) {
      addWorkspacePatchRepairActions(actions, workspacePatchSurface);
      actions.add(WORKSPACE_MULTI_EDIT_ACTION);
    } else {
      actions.add(WORKSPACE_WRITE_ACTION);
      actions.add(WORKSPACE_REPLACE_ACTION);
    }
    actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
    addCandidateReviewRepairAction(actions, runState);
  }
    if (hasTodo && !hasSource && !hasLength && !hasStructureRepairSignal) {
    actions.add(TODO_ADVANCE_ACTION);
    actions.add(TODO_RUN_NEXT_ACTION);
    actions.add(TODO_CANCEL_ACTION);
  }
    if (hasObservableLengthDeficit && hasReadinessOrTerminalLoop) {
      actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
      addCandidateReviewRepairAction(actions, runState);
      if (lengthLimitedPublishAllowed) {
        actions.add(PUBLISH_DIRECT_ACTION);
      }
    }
    if (
      !hasStructureRepairSignal &&
      lowBudget &&
      !protocolRequiredAction &&
      lengthLimitedPublishAllowed
    ) {
      actions.add(PUBLISH_DIRECT_ACTION);
    }
    return filterReadOnlyPlanningChurnActions(
      applyMultiWriteIterationNudge(Array.from(actions), {
        activeDeficits: deficits,
        budgetState,
        observableDeficits,
        runState
      }),
      {
        deficits,
      forbiddenActions: readOnlyPlanningForbiddenActions,
      protocolRequiredAction,
      sourceHasUnreadCandidates
    }
    ).slice(0, 16);
}

function addEvidenceRecoveryActions(actions, options = {}) {
  const recoveryActions = readEvidenceRecoveryActions(options.runtimeConfig);
  const forbiddenActions = options.forbiddenActions instanceof Set
    ? options.forbiddenActions
    : new Set();
  for (const actionName of recoveryActions) {
    if (!actionName || forbiddenActions.has(actionName)) continue;
    if (actionName === WEB_SEARCH_ACTION && options.sourceHasUnreadCandidates) continue;
    actions.add(actionName);
  }
}

function buildCandidateQualityRepairActions(options = {}) {
  const actions = options.actions instanceof Set ? options.actions : new Set();
  const protocol = readCurrentPublishProtocol(options.runState);
  if (!protocol || protocol.readAfterLatestContentChange !== true) {
    actions.add(WORKSPACE_READ_ACTION);
  }
  if (!protocol || protocol.reviewAfterLatestContentChange !== true || protocol.reviewAfterRead !== true) {
    actions.add(WORKSPACE_REVIEW_CANDIDATE_ACTION);
  }
  addEvidenceRecoveryActions(actions, {
    forbiddenActions: options.forbiddenActions,
    runtimeConfig: options.runtimeConfig,
    sourceHasUnreadCandidates: options.sourceHasUnreadCandidates
  });
  addWorkspacePatchRepairActions(actions, options.workspacePatchSurface, {
    allowBlockedRetry: true
  });
  actions.add(WORKSPACE_REPLACE_ACTION);
  actions.add(WORKSPACE_MULTI_EDIT_ACTION);
  actions.add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
  actions.add(WORKSPACE_WRITE_ACTION);
  if (Array.isArray(options.deficits) && options.deficits.includes("source") && isBudgetConstrainedForLimitedPublish({
    budgetState: options.budgetState,
    escalation: options.escalation
  })) {
    actions.add(PUBLISH_DIRECT_ACTION);
  }
  return filterReadOnlyPlanningChurnActions(Array.from(actions), {
    deficits: options.deficits,
    forbiddenActions: options.forbiddenActions,
    protocolRequiredAction: options.protocolRequiredAction,
    sourceHasUnreadCandidates: options.sourceHasUnreadCandidates
  });
}

function addCandidateReviewRepairAction(actions, runState) {
  if (!actions || typeof actions.add !== "function") return;
  if (shouldExposeCandidateReviewAction(runState)) {
    actions.add(WORKSPACE_REVIEW_CANDIDATE_ACTION);
  }
}

function shouldExposeCandidateReviewAction(runState) {
  const protocol = readCurrentPublishProtocol(runState);
  if (!protocol) return true;
  return !(protocol.reviewAfterLatestContentChange === true && protocol.reviewAfterRead === true);
}

function shouldExposeLimitedPublishForBudget({
  budgetState,
  hardVetoActive,
  hasLengthDeficit,
  readOnlyPlanningHardVeto,
  workspaceMutationGrowthHardVeto
}) {
  if (budgetState === "exhausted") return true;
  if (hardVetoActive && budgetState === "low") return true;
  if (hardVetoActive && !hasLengthDeficit) return true;
  if (readOnlyPlanningHardVeto === true && hasLengthDeficit) return true;
  if (workspaceMutationGrowthHardVeto === true && hasLengthDeficit) return true;
  if (budgetState !== "low") return false;
  if (!hasLengthDeficit) return true;
  return false;
}

// AGRUN-542 — delegates to the shared content-structure predicate
// (content-structure-exit.js) so the repair-surface choice and the exit
// episode can never disagree about what counts as a content-level issue.
function shouldPreferFullRewriteForStructureRepair(observableDeficits, runState) {
  return hasContentLevelStructureIssue(observableDeficits, runState);
}

function hasEmptyFinalCandidateDeficit(observableDeficits, runState) {
  const structure = observableDeficitsRecord(observableDeficits, "structure");
  const issueCodes = readStringArray(structure && structure.issueCodes);
  if (issueCodes.some((code) => code === "candidate_empty" || code === "missing_candidate_content")) {
    return true;
  }
  const workspace = readRecord(runState && runState.virtualWorkspace);
  if (!workspace) return false;
  const quality = readRecord(workspace && workspace.quality);
  const finalCandidateStatus = readString(quality && quality.finalCandidateStatus);
  if (finalCandidateStatus === "candidate_empty" || finalCandidateStatus === "missing_candidate_content") {
    return true;
  }
  const path = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && path ? files[path] : null;
  if (file && typeof file === "object") {
    const content = typeof file.content === "string" ? file.content : "";
    const stats = readRecord(file && file.textStats);
    const chars = readNumber(stats && stats.chars);
    const words = readNumber(stats && stats.words);
    return content.trim().length === 0 && chars === 0 && words === 0;
  }
  return issueCodes.includes("candidate_empty");
}

function addWorkspacePatchRepairActions(actions, surface, options = {}) {
  if (!actions || typeof actions.add !== "function") return;
  if (surface === "stale_preview") {
    actions.add(WORKSPACE_PROPOSE_PATCH_ACTION);
    return;
  }
  if (surface === "blocked_preview") {
    if (options.allowBlockedRetry === true) {
      actions.add(WORKSPACE_PROPOSE_PATCH_ACTION);
    }
    return;
  }
  if (surface === "apply_ready") {
    actions.add(WORKSPACE_APPLY_PATCH_ACTION);
    return;
  }
  actions.add(WORKSPACE_PROPOSE_PATCH_ACTION);
  actions.add(WORKSPACE_APPLY_PATCH_ACTION);
}

function getWorkspacePatchRepairSurface(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const pendingPatch = readRecord(workspace && workspace.pendingPatch);
  if (!pendingPatch) return "fresh";
  const file = readRecord(workspace && workspace.files && workspace.files[pendingPatch.path]);
  const currentVersion = readNumber(file && file.version);
  const baseVersion = readNumber(pendingPatch && pendingPatch.baseVersion);
  if (file && currentVersion !== baseVersion) {
    return "stale_preview";
  }
  const status = readString(pendingPatch.status);
  if (pendingPatch.valid === true && status === "preview_ready") {
    return "apply_ready";
  }
  if (status === "preview_blocked") {
    return "blocked_preview";
  }
  return "fresh";
}

function resolveWorkspacePatchRepairSurface(runState, reason) {
  const surface = getWorkspacePatchRepairSurface(runState);
  if (surface !== "fresh") return surface;
  return readString(reason) === "preview_blocked" ? "blocked_preview" : surface;
}

function filterReadOnlyPlanningChurnActions(actions, options = {}) {
  const source = Array.isArray(actions) ? actions : [];
  const forbidden = options.forbiddenActions instanceof Set ? options.forbiddenActions : new Set();
  if (forbidden.size === 0) return source;
  const deficits = Array.isArray(options.deficits) ? options.deficits : [];
  const remove = new Set();
  if (deficits.includes("source") && options.sourceHasUnreadCandidates === true) {
    remove.add(WEB_SEARCH_ACTION);
  }
  if (deficits.includes("length") && !deficits.includes("structure")) {
    for (const actionName of [WORKSPACE_READ_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_REPLACE_ACTION]) {
      remove.add(actionName);
    }
  }
  if (remove.size === 0) return source;
  const filtered = source.filter((actionName) => {
    if (!remove.has(actionName)) return true;
    if (actionName === readString(options.protocolRequiredAction)) return true;
    return !forbidden.has(actionName);
  });
  return filtered.length > 0 ? filtered : source;
}

function applyMultiWriteIterationNudge(actions, options = {}) {
  const hasStructureRepairSignal = Boolean(observableDeficitsRecord(options.observableDeficits, "structure"));
  const forbiddenByWorkspaceMutationGrowth = workspaceMutationGrowthHardVetoForbiddenActions(options.runState);
  const preserveMultiEditForWorkspaceMutationGrowth = forbiddenByWorkspaceMutationGrowth.size > 0;
  const source = applyWorkspaceRepairInspectionNudge(
    readStringArray(actions).filter((actionName) => (
      (!hasStructureRepairSignal || preserveMultiEditForWorkspaceMutationGrowth || actionName !== WORKSPACE_MULTI_EDIT_ACTION) &&
      !forbiddenByWorkspaceMutationGrowth.has(actionName)
    )),
    options
  );
  if (!shouldSurfaceMultiWriteIterationNudge(options)) return source;
  const workspace = readRecord(options.runState && options.runState.virtualWorkspace);
  const finalPath = readFinalCandidatePathFromWorkspace(options.runState);
  const finalFile = readRecord(workspace && workspace.files && workspace.files[finalPath]);
  const hasCandidateContent = readString(finalFile && finalFile.content).length > 0 ||
    readNumber(finalFile && finalFile.textStats && finalFile.textStats.words) > 0 ||
    readNumber(finalFile && finalFile.textStats && finalFile.textStats.chars) > 0;
  const preferred = hasCandidateContent
    ? (hasStructureRepairSignal
        ? [WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_WRITE_ACTION]
        : [WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_REPLACE_ACTION, WORKSPACE_WRITE_ACTION])
    : [WORKSPACE_WRITE_ACTION];
  const withPreferred = source.slice();
  for (const actionName of preferred.filter((name) => !forbiddenByWorkspaceMutationGrowth.has(name))) {
    if (!withPreferred.includes(actionName)) withPreferred.push(actionName);
  }
  const inspectedPreferred = applyWorkspaceRepairInspectionNudge(withPreferred, options);
  const preferredSet = new Set(preferred);
  return [
    ...inspectedPreferred.filter((actionName) => actionName === WORKSPACE_READ_ACTION),
    ...preferred.filter((actionName) => inspectedPreferred.includes(actionName)),
    ...inspectedPreferred.filter((actionName) => actionName !== WORKSPACE_READ_ACTION && !preferredSet.has(actionName))
  ];
}

function applyWorkspaceRepairInspectionNudge(actions, options = {}) {
  const source = readStringArray(actions);
  if (source.includes(WORKSPACE_READ_ACTION)) return source;
  if (!shouldRequireWorkspaceRepairInspection({
    activeDeficits: options.activeDeficits,
    allowedActions: source,
    observableDeficits: options.observableDeficits,
    runState: options.runState
  })) {
    return source;
  }
  return [WORKSPACE_READ_ACTION, ...source];
}

function hasUnreadSourceCandidates(runState) {
  const context = readRecord(runState && runState.researchContext);
  const readSources = Array.isArray(context && context.readSources) ? context.readSources : [];
  const readUrls = new Set(readSources.map((source) => normalizeUrlKey(readCandidateUrl(source))).filter(Boolean));
  const candidates = [
    ...(Array.isArray(runState && runState.readUrlRecoverySignal && runState.readUrlRecoverySignal.alternateSourceCandidates)
      ? runState.readUrlRecoverySignal.alternateSourceCandidates
      : []),
    ...(Array.isArray(context && context.aggregatedSearchResults) ? context.aggregatedSearchResults : []),
    ...(Array.isArray(context && context.searchResults) ? context.searchResults : []),
    ...readSearchPassItems(context && context.searchPasses)
  ];
  return candidates.some((candidate) => {
    const url = normalizeUrlKey(readCandidateUrl(candidate));
    return Boolean(url && !readUrls.has(url));
  });
}

function hasUnreadCitedUrlDeficit(runState) {
  const signal = readCandidateQualitySignal(runState, null);
  const deficit = buildCandidateQualityCitationDeficit(signal, runState);
  return Boolean(deficit && Array.isArray(deficit.unreadCitedUrls) && deficit.unreadCitedUrls.length > 0);
}

function hasUnreadCitationDeficit(observableDeficits) {
  const source = observableDeficitsRecord(observableDeficits, "source");
  return Boolean(source && Array.isArray(source.unreadCitedUrls) && source.unreadCitedUrls.length > 0);
}

function isSourceReadQuotaSatisfied(observableDeficits) {
  const source = observableDeficitsRecord(observableDeficits, "source");
  if (!source) return false;
  const minReadSources = readNumber(source.minReadSources);
  if (!minReadSources) return false;
  return readNumber(source.readSources) >= minReadSources;
}

export { addCandidateReviewRepairAction, addEvidenceRecoveryActions, addWorkspacePatchRepairActions, applyMultiWriteIterationNudge, applyWorkspaceRepairInspectionNudge, buildAllowedActions, buildCandidateQualityRepairActions, filterReadOnlyPlanningChurnActions, getWorkspacePatchRepairSurface, hasEmptyFinalCandidateDeficit, hasUnreadCitationDeficit, hasUnreadCitedUrlDeficit, hasUnreadSourceCandidates, isSourceReadQuotaSatisfied, resolveWorkspacePatchRepairSurface, shouldExposeCandidateReviewAction, shouldExposeLimitedPublishForBudget, shouldPreferFullRewriteForStructureRepair };
