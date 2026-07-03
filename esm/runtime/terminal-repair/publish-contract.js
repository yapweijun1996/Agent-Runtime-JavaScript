import { cloneValue } from '../utils.js';
import { FINALIZE_CANDIDATE_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_REVIEW_CANDIDATE_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_APPLY_PATCH_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_REPLACE_ACTION, TODO_ADVANCE_ACTION, TODO_RUN_NEXT_ACTION, TODO_CANCEL_ACTION, PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { CANDIDATE_QUALITY_BLOCKED_REASON } from '../kernel-terminal-actions.js';
import { formatEvidenceRecoveryActions } from '../evidence-policy.js';
import { readString, readCurrentPublishProtocol, DEFAULT_VALID_PUBLISH_EXCEPTION, readStringArray, createTerminalRepairState, mentionsStructureGap, mentionsGap, readNumber, readWorkspaceFileStats, readRecord } from './internal-utils.js';

// H10 split, Step 2 (AGRUN-504) — terminal-repair publish protocol + contract.
// VERBATIM moves from terminal-repair-state.js (see
// agrun_docs/terminal-repair-split-design-2026-06-12.md). Publish protocol
// state machine (finalize -> read -> review -> publish), publish-args
// validation/explanation, the valid-publish contract + args examples, and the
// human-readable required-repair text. Seven functions here are PUBLIC API,
// re-exported through the terminal-repair-state.js barrel.

function isValidTerminalRepairPublishArgs(args, terminalRepairState, options = {}) {
  return explainTerminalRepairPublishArgs(args, terminalRepairState, options).valid;
}

function explainTerminalRepairPublishArgs(args, terminalRepairState, options = {}) {
  const state = createTerminalRepairState(terminalRepairState);
  const source = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const readiness = source.finalReadiness && typeof source.finalReadiness === "object"
    ? source.finalReadiness
    : {};
  const reasons = [];
  const hints = [];
  if (readString(readiness.decision) !== "limited") {
    reasons.push("missing_limited_decision");
  }
  const assessment = readiness.requirementsAssessment && typeof readiness.requirementsAssessment === "object"
    ? readiness.requirementsAssessment
    : {};
  if (!readiness.requirementsAssessment || typeof readiness.requirementsAssessment !== "object") {
    reasons.push("missing_requirements_assessment");
  }
  const gaps = readTerminalRepairGaps(assessment, readiness);
  if (gaps.length === 0) {
    reasons.push("missing_remaining_gaps");
  }
  const deficits = state.activeDeficits;
  const effectiveDeficits = resolvePublishValidationDeficits(deficits, source, state, options);
  const hasDeficit = effectiveDeficits.length > 0 || state.active === true;
  if (hasDeficit && assessment.requirementSatisfied !== false) {
    reasons.push("requirement_satisfied_must_be_false");
  }
  if (effectiveDeficits.includes("source") && assessment.evidenceSatisfied !== false) {
    reasons.push("evidence_satisfied_must_be_false_for_source_deficit");
  }
  if (effectiveDeficits.includes("length") && assessment.lengthSatisfied !== false) {
    reasons.push("length_satisfied_must_be_false_for_length_deficit");
  }
  if (effectiveDeficits.includes("structure")) {
    if (!isBudgetConstrainedForLimitedPublish(state)) {
      reasons.push("structure_deficit_must_be_repaired_before_publish");
      } else if (!mentionsStructureGap(gaps)) {
        // AGRUN-249-F: English keyword matching is language-biased, so missing
        // structure words in remainingGaps stays advisory. Protocol-shape
        // reasons above remain blocking.
        hints.push("gap_description_may_omit_structure_deficit");
      }
    }
    if (effectiveDeficits.includes("todo") && !isBudgetConstrainedForLimitedPublish(state)) {
      reasons.push("todo_deficit_must_be_synchronized_before_publish");
    }
    if (effectiveDeficits.includes("todo") && !mentionsGap(gaps, ["todo", "task", "progress", "plan"])) {
      // AGRUN-249-F: same Mandarin/non-English risk as structure gap text.
      // Keep the observable hint, but do not reject a valid limited contract
      // only because the model named the Todo gap without these English tokens.
      hints.push("gap_description_may_omit_todo_deficit");
    }
  return {
    activeDeficits: deficits.slice(0, 8),
    effectiveDeficits: effectiveDeficits.slice(0, 8),
    valid: reasons.length === 0,
    reasons,
    hints
  };
}

function getPublishProtocolRequiredActionForReason(reason) {
  const value = readString(reason);
  if (value === "missing_finalize_after_latest_write") return FINALIZE_CANDIDATE_ACTION;
  if (value === "missing_latest_workspace_read") return WORKSPACE_READ_ACTION;
  if (value === "missing_latest_candidate_review") return WORKSPACE_REVIEW_CANDIDATE_ACTION;
  return "";
}

function isPublishProtocolRequiredActionForRepair(terminalRepairState, actionName) {
  const state = terminalRepairState && typeof terminalRepairState === "object" && !Array.isArray(terminalRepairState)
    ? terminalRepairState
    : {};
  const requiredAction = getPublishProtocolRequiredActionForReason(state.reason);
  return Boolean(requiredAction && requiredAction === readString(actionName));
}

function isWorkspaceRepairInspectionActionForRepair(terminalRepairState, actionName) {
  const state = terminalRepairState && typeof terminalRepairState === "object" && !Array.isArray(terminalRepairState)
    ? terminalRepairState
    : {};
  const signal = state.workspaceRepairSignal && typeof state.workspaceRepairSignal === "object"
    ? state.workspaceRepairSignal
    : null;
  return Boolean(
    state.active === true &&
    readString(actionName) === WORKSPACE_READ_ACTION &&
    signal &&
    signal.mustInspectCandidate === true
  );
}

function resolvePublishProtocolActionContract(runState) {
  const publishProtocol = readCurrentPublishProtocol(runState);
  if (!publishProtocol) return null;
  if (publishProtocol.finalizedAfterLatestWrite !== true) {
    return {
      allowedActions: [FINALIZE_CANDIDATE_ACTION],
      protocol: publishProtocol,
      reason: "missing_finalize_after_latest_write",
      requiredAction: FINALIZE_CANDIDATE_ACTION,
      ready: false
    };
  }
  if (publishProtocol.readAfterLatestContentChange !== true) {
    return {
      allowedActions: [WORKSPACE_READ_ACTION],
      protocol: publishProtocol,
      reason: "missing_latest_workspace_read",
      requiredAction: WORKSPACE_READ_ACTION,
      ready: false
    };
  }
  return {
    allowedActions: [PUBLISH_DIRECT_ACTION],
    protocol: publishProtocol,
    reason: "publish_protocol_ready",
    requiredAction: "",
    ready: true
  };
}

function resolvePublishValidationDeficits(deficits, actionArgs, terminalRepairState, options) {
  const sourceDeficits = Array.isArray(deficits) ? deficits : [];
  if (!sourceDeficits.includes("length")) return sourceDeficits.slice();
  const length = terminalRepairState &&
    terminalRepairState.observableDeficits &&
    terminalRepairState.observableDeficits.length &&
    typeof terminalRepairState.observableDeficits.length === "object"
    ? terminalRepairState.observableDeficits.length
    : null;
  const requested = readNumber(length && length.requested);
  const unit = readString(length && length.unit) || "words";
  const path = readString(actionArgs && actionArgs.path);
  if (!path || !requested) return sourceDeficits.slice();
  const stats = readWorkspaceFileStats(options && options.runState, path);
  const observed = readNumber(stats && stats[unit]);
  if (observed >= requested) {
    return sourceDeficits.filter((name) => name !== "length");
  }
  return sourceDeficits.slice();
}

function readTerminalRepairGaps(assessment, readiness) {
  const gaps = readStringArray(assessment && assessment.remainingGaps);
  if (gaps.length > 0) return gaps;
  const fallback = readString(
    readiness && (readiness.limitations || readiness.limitation || readiness.remainingGap)
  ) || readString(
    assessment && (assessment.limitations || assessment.limitation || assessment.remainingGap)
  );
  return fallback ? [fallback] : [];
}

function isBudgetConstrainedForLimitedPublish(terminalRepairState) {
  const budgetState = readString(terminalRepairState && terminalRepairState.budgetState);
  // ADR-0033 Tier A.8 (X1 fix) — hard_veto means AI has hit the wall on
  // structure repair (ignoredCount past the high-water mark). Even on
  // "enough" budget the rational next move is publish_limited with structure
  // noted in remainingGaps. Treat hard_veto state as constrained for the
  // purpose of allowing a limited publish contract.
  const escalation = readString(terminalRepairState && terminalRepairState.escalation);
  return budgetState === "low" || budgetState === "exhausted" || escalation === "hard_veto";
}

function isReadinessOnlyDeficits(deficits) {
  const active = Array.isArray(deficits) ? deficits.map(readString).filter(Boolean) : [];
  return active.length === 1 && active[0] === "readiness";
}

function isCandidateQualityRepairReason(value) {
  return readString(value) === CANDIDATE_QUALITY_BLOCKED_REASON;
}

function isInvalidTerminalRepairPublishBlock(output) {
  const value = readRecord(output);
  if (!value) return false;
  return readString(value.kind) === "terminal_repair_preflight_block" &&
    readString(value.reason) === "terminal_repair_invalid_publish";
}

function isPublishProtocolRepairReason(value) {
  const reason = readString(value);
  return reason === "missing_finalize_after_latest_write" ||
    reason === "missing_latest_workspace_read" ||
    reason === "missing_latest_candidate_review";
}

function isPublishProtocolStillBlockedForReason(runState, reason) {
  const protocol = readCurrentPublishProtocol(runState);
  if (!protocol) return false;
  const value = readString(reason);
  if (value === "missing_finalize_after_latest_write") {
    return protocol.finalizedAfterLatestWrite !== true;
  }
  if (value === "missing_latest_workspace_read") {
    return protocol.readAfterLatestContentChange !== true;
  }
  if (value === "missing_latest_candidate_review") {
    return protocol.reviewAfterLatestContentChange !== true;
  }
  return false;
}

function isPublishProtocolRequiredActionCompleted(reason, actionName, output, status) {
  const repairReason = readString(reason);
  const name = readString(actionName);
  const outputKind = readString(output && output.kind);
  const phase = readString(status);
  if (repairReason === "missing_finalize_after_latest_write") {
    return name === FINALIZE_CANDIDATE_ACTION &&
      (outputKind === "virtual_workspace_finalize_candidate" || phase === "after_workspace_finalize_candidate");
  }
  if (repairReason === "missing_latest_workspace_read") {
    return name === WORKSPACE_READ_ACTION &&
      (outputKind === "virtual_workspace_read" || phase === "after_workspace_read");
  }
  if (repairReason === "missing_latest_candidate_review") {
    return name === WORKSPACE_REVIEW_CANDIDATE_ACTION &&
      (outputKind === "virtual_workspace_review_candidate" || phase === "after_workspace_review_candidate");
  }
  return false;
}

function buildValidPublishContract(deficits, observableDeficits, budgetState, escalation) {
  if (isReadinessOnlyDeficits(deficits)) {
    return {
      decision: "ready_or_limited_with_corrected_finalReadiness_facts",
      remainingGaps: "empty or omitted for ready; non-empty concrete blockers for limited",
      evidenceSatisfied: "match observed evidence facts",
      lengthSatisfied: "match observed candidate stats",
      requirementSatisfied: "match observed facts",
      structureRequirement: "not blocking",
      budgetState: budgetState || "unknown",
      observableDeficits: cloneValue(observableDeficits),
      requiredArgsExample: buildReadinessRetryArgsExample(observableDeficits),
      validTerminalException: "workspace_publish_candidate with corrected finalReadiness.requirementsAssessment fields matching latest workspace_read and read_url facts"
    };
  }
  const requiresEvidenceFalse = deficits.includes("source");
  // ADR-0033 Tier A.8 (X1 fix) — hard_veto state counts as constrained so the
  // contract surface stops insisting on structure repair when AI can't make
  // progress. AI must still mention structure in remainingGaps to publish.
  const hardVetoActive = readString(escalation) === "hard_veto";
  const constrained = budgetState === "low" || budgetState === "exhausted" || hardVetoActive;
  const todoRequiresSyncFirst = deficits.includes("todo") && !constrained;
  return {
    decision: "limited",
    remainingGaps: "non-empty string array with concrete blockers",
    evidenceSatisfied: requiresEvidenceFalse
      ? false
      : "match observed evidence facts",
    lengthSatisfied: deficits.includes("length") ? false : "match observed candidate stats",
    requirementSatisfied: deficits.length > 0 ? false : "match observed facts",
    structureRequirement: deficits.includes("structure")
      ? (constrained
        ? "low/exhausted budget may publish limited only with concrete structure remainingGaps"
        : "must repair structure before terminal publish")
      : "not blocking",
    todoRequirement: deficits.includes("todo")
      ? (todoRequiresSyncFirst
        ? "must sync TodoState with todo_advance/todo_run_next/todo_cancel before publish while budget remains"
        : "budget-constrained terminal repair may publish limited only with concrete TodoState remainingGaps")
      : "not blocking",
    budgetState: budgetState || "unknown",
    observableDeficits: cloneValue(observableDeficits),
    requiredArgsExample: todoRequiresSyncFirst ? null : buildValidLimitedArgsExample(deficits, observableDeficits),
    validTerminalException: todoRequiresSyncFirst
      ? "not available until TodoState is synchronized or terminal repair is budget-constrained"
      : DEFAULT_VALID_PUBLISH_EXCEPTION
  };
}

function buildReadinessRetryArgsExample(observableDeficits) {
  const readiness = observableDeficits && observableDeficits.readiness && typeof observableDeficits.readiness === "object"
    ? observableDeficits.readiness
    : null;
  const issues = Array.isArray(readiness && readiness.issues) ? readiness.issues : [];
  const observedLengthIssue = issues.find((issue) => readString(issue && issue.code) === "observed_length_mismatch");
  const sourceCountIssue = issues.find((issue) => readString(issue && issue.code) === "successful_read_url_count_mismatch");
  return {
    finalReadiness: {
      decision: "ready",
      evidenceMode: "read_sources",
      requirementsAssessment: {
        checkedReadinessAgainstUserRequest: true,
        checkedReadUrlEvidence: true,
        checkedWorkspaceStats: true,
        evidenceSatisfied: "match observed evidence facts",
        lengthSatisfied: "match latest workspace_read stats",
        observedLength: observedLengthIssue ? observedLengthIssue.observed : "latest workspace_read textStats value",
        observedLengthUnit: observedLengthIssue ? observedLengthIssue.unit : "latest workspace_read unit",
        remainingGaps: [],
        requirementSatisfied: "match observed facts",
        successfulReadUrlCount: sourceCountIssue ? sourceCountIssue.observed : "observed successful read_url count"
      }
    }
  };
}

function buildValidLimitedArgsExample(deficits, observableDeficits) {
  const length = observableDeficits && observableDeficits.length && typeof observableDeficits.length === "object"
    ? observableDeficits.length
    : null;
  const source = observableDeficits && observableDeficits.source && typeof observableDeficits.source === "object"
    ? observableDeficits.source
    : null;
  const todo = observableDeficits && observableDeficits.todo && typeof observableDeficits.todo === "object"
    ? observableDeficits.todo
    : null;
  const structure = observableDeficits && observableDeficits.structure && typeof observableDeficits.structure === "object"
    ? observableDeficits.structure
    : null;
  const remainingGaps = [];
  if (source) {
    const citationIssues = Array.isArray(source.citationIssues) ? source.citationIssues : [];
    if (citationIssues.length > 0) {
      const unread = readStringArray(source.unreadCitedUrls);
      const blocked = readStringArray(source.blockedCitedUrls);
      remainingGaps.push([
        `Citation evidence is still blocked: ${citationIssues.length} cited URL(s) lack usable evidence.`,
        unread.length > 0 ? `unread=${unread.join(",")}` : "",
        blocked.length > 0 ? `blocked=${blocked.join(",")}` : ""
      ].filter(Boolean).join(" "));
    } else {
      remainingGaps.push(`Source evidence is still short: readSources=${source.readSources}/${source.minReadSources}, relevantSources=${source.relevantSources}/${source.minRelevantSources}.`);
    }
  }
  if (length) {
    remainingGaps.push(`Length is still short: observed ${length.observed}/${length.requested} ${length.unit}.`);
  }
  if (structure) {
    const issueCodes = Array.isArray(structure.issueCodes) && structure.issueCodes.length > 0
      ? structure.issueCodes.join(",")
      : (readString(structure.reason) || "structure_not_ready");
    remainingGaps.push(`Structure is still not ready: ${issueCodes}.`);
  }
  if (todo) {
    remainingGaps.push(`TodoState is not fully synchronized: ${todo.unfinishedCount || 0} unfinished task(s) remain.`);
  }
  if (deficits.includes("readiness")) {
    remainingGaps.push("Previous publish readiness payload did not match observable runtime facts.");
  }
  if (deficits.includes("terminal_loop")) {
    remainingGaps.push("Repeated terminal attempts did not produce observable progress before budget ended.");
  }
  if (remainingGaps.length === 0) {
    remainingGaps.push("Terminal repair requires limited publish because observable facts still block clean ready.");
  }
  return {
    finalReadiness: {
      decision: "limited",
      evidenceMode: "read_sources",
      requirementsAssessment: {
        checkedReadinessAgainstUserRequest: true,
        checkedReadUrlEvidence: true,
        checkedWorkspaceStats: true,
        evidenceSatisfied: deficits.includes("source") ? false : true,
        lengthSatisfied: deficits.includes("length") ? false : true,
        observedLength: length ? length.observed : null,
        observedLengthUnit: length ? length.unit : null,
        remainingGaps,
        requestedLength: length ? length.requested : null,
        requirementSatisfied: false,
        successfulReadUrlCount: source ? source.successfulReadUrlCount : null,
        summary: "Limited publish because terminal repair facts show remaining observable deficits."
      }
    }
  };
}

function buildRequiredRepair(deficits, observableDeficits, allowedActions, budgetState, reason, runtimeConfig) {
  const parts = [];
  const readiness = observableDeficits && observableDeficits.readiness && typeof observableDeficits.readiness === "object"
    ? observableDeficits.readiness
    : null;
  const structure = observableDeficits && observableDeficits.structure && typeof observableDeficits.structure === "object"
    ? observableDeficits.structure
    : null;
  const length = observableDeficits && observableDeficits.length && typeof observableDeficits.length === "object"
    ? observableDeficits.length
    : null;
  const source = observableDeficits && observableDeficits.source && typeof observableDeficits.source === "object"
    ? observableDeficits.source
    : null;
  const todo = observableDeficits && observableDeficits.todo && typeof observableDeficits.todo === "object"
    ? observableDeficits.todo
    : null;
  const protocolReason = readString(reason);
  if (protocolReason === "missing_finalize_after_latest_write") {
    parts.push("Publish protocol deficit: workspace content changed after the last finalized candidate; run workspace_finalize_candidate for the selected path before publishing.");
  } else if (protocolReason === "missing_latest_workspace_read") {
    parts.push("Publish protocol deficit: candidate content changed after the latest workspace_read; run workspace_read on the selected path before publishing.");
  }
  if (deficits.includes("source") && source) {
    const exhausted = budgetState === "exhausted";
    const recoveryActions = formatEvidenceRecoveryActions(runtimeConfig);
    const citationIssues = Array.isArray(source.citationIssues) ? source.citationIssues : [];
    if (citationIssues.length > 0) {
      const unread = readStringArray(source.unreadCitedUrls);
      const blocked = readStringArray(source.blockedCitedUrls);
      parts.push([
        `Citation evidence deficit: candidateQualitySignal found ${citationIssues.length} cited URL(s) without usable evidence.`,
        unread.length > 0 ? `Unread cited URLs: ${unread.join(", ")}. Use read_url on these exact URL(s) or remove/replace the unsupported citation with workspace patch/edit actions.` : "",
        blocked.length > 0 ? `Blocked cited URLs: ${blocked.join(", ")}. Remove or replace these citations with readable evidence before clean publish.` : "",
        exhausted ? "Budget is exhausted: if the exact URLs still cannot be verified immediately, publish only valid limited finalReadiness now with decision=limited, evidenceSatisfied=false, requirementSatisfied=false, and remainingGaps naming the citation evidence gap." : ""
      ].filter(Boolean).join(" "));
    } else {
      parts.push(`Evidence deficit: need ${source.readSourceDeficit || 0} more evidence artifact(s) and ${source.relevantSourceDeficit || 0} more relevant evidence artifact(s); use ${recoveryActions} before clean publish.${exhausted ? " Budget is exhausted: if you cannot improve evidence relevance immediately, publish only valid limited finalReadiness now with decision=limited, evidenceSatisfied=false, requirementSatisfied=false, and remainingGaps naming the evidence relevance gap." : ""}`);
    }
  }
    if ((deficits.includes("structure") || structure) && structure) {
      const constrained = budgetState === "low" || budgetState === "exhausted";
      const canPatch = Array.isArray(allowedActions) &&
        (allowedActions.includes(WORKSPACE_PROPOSE_PATCH_ACTION) || allowedActions.includes(WORKSPACE_APPLY_PATCH_ACTION));
      const canRewrite = Array.isArray(allowedActions) &&
        (allowedActions.includes(WORKSPACE_WRITE_ACTION) || allowedActions.includes(WORKSPACE_REPLACE_ACTION));
      const repairVerb = canPatch && !canRewrite
        ? "Structure signal: workspace_propose_patch can carry a normalize_headings operation against exact heading line numbers; inspect deltaWords/riskFlags, then use workspace_apply_patch only for a valid preview."
        : "Structure signal: repair the current candidate with AI-authored headings/section choices; avoid repeated read-only structure loops.";
    const headingSamples = Array.isArray(structure.repeatedHeadingSamples)
      ? structure.repeatedHeadingSamples.map((entry) => `${entry.heading} x${entry.count}`).join(" | ")
      : "";
    const numberSamples = Array.isArray(structure.repeatedNumberSamples)
      ? structure.repeatedNumberSamples.map((entry) => `${entry.number} x${entry.count}`).join(" | ")
      : "";
    parts.push([
      repairVerb,
      Array.isArray(structure.issueCodes) && structure.issueCodes.length > 0 ? `issueCodes=${structure.issueCodes.join(",")}.` : "",
      headingSamples ? `duplicateHeadings=${headingSamples}.` : "",
      numberSamples ? `duplicateNumbers=${numberSamples}.` : "",
      constrained ? "Budget is constrained: if one coherent rewrite cannot repair structure immediately, publish only valid limited finalReadiness now with decision=limited, requirementSatisfied=false, and remainingGaps naming the concrete structure/heading/section issue." : ""
    ].filter(Boolean).join(" "));
  }
  if (deficits.includes("length") && length) {
    const alternative = length.alternativeCandidate && typeof length.alternativeCandidate === "object"
      ? length.alternativeCandidate
      : null;
    if (alternative && alternative.path) {
      parts.push(`Length deficit: selected final candidate has ${length.observed}/${length.requested} ${length.unit}, but workspace file ${alternative.path} has ${alternative.observed}/${alternative.requested} ${alternative.unit}; use workspace_finalize_candidate with that path, then workspace_read it before publishing.`);
    } else {
      const constrained = budgetState === "low" || budgetState === "exhausted";
      parts.push(`Length deficit: observed ${length.observed}/${length.requested} ${length.unit}; the next workspace mutation must add enough user-facing material to close the ${length.deficit} ${length.unit} gap.${constrained ? " Budget is constrained: if the gap cannot be closed immediately with the allowed workspace action, publish only valid limited finalReadiness now with decision=limited, lengthSatisfied=false, requirementSatisfied=false, and remainingGaps naming the length gap." : ""}`);
    }
  }
  if (deficits.includes("todo") && todo) {
    const hasProductDeficit = deficits.some((name) => name === "source" || name === "length" || name === "structure");
    const onlyStructureProductDeficit = deficits.includes("structure") &&
      !deficits.includes("source") &&
      !deficits.includes("length");
    const todoActionsVisible = Array.isArray(allowedActions) &&
      (allowedActions.includes(TODO_ADVANCE_ACTION) || allowedActions.includes(TODO_RUN_NEXT_ACTION) || allowedActions.includes(TODO_CANCEL_ACTION));
    if (hasProductDeficit && onlyStructureProductDeficit && todoActionsVisible) {
      parts.push(`Todo deficit: ${todo.unfinishedCount || 0} unfinished item(s) remain after source/length gates are satisfied; keep structure repair AI-owned with the patch surface and sync stale TodoState with todo_advance/todo_run_next, or use todo_cancel if the remaining plan is obsolete.`);
    } else if (hasProductDeficit) {
      parts.push(`Todo deficit: ${todo.unfinishedCount || 0} unfinished item(s), but Todo actions are transitional until source/length/structure product deficits are resolved.`);
    } else {
      parts.push(`Todo deficit: ${todo.unfinishedCount || 0} unfinished item(s) remain after source/length/structure gates are resolved; sync TodoState with todo_advance/todo_run_next, or use todo_cancel if the remaining plan is stale, before a clean ready publish.`);
    }
  }
  if (deficits.includes("readiness") && readiness) {
    const issueSummary = Array.isArray(readiness.issues) && readiness.issues.length > 0
      ? readiness.issues.map((issue) => {
          const field = readString(issue.field);
          const code = readString(issue.code) || "readiness_payload_mismatch";
          const declared = issue.declared != null ? ` declared=${issue.declared}` : "";
          const observed = issue.observed != null ? ` observed=${issue.observed}` : "";
          return `${code}${field ? ` field=${field}` : ""}${declared}${observed}`;
        }).join(" | ")
      : readString(readiness.message) || "readiness payload mismatch";
    parts.push(`Readiness payload deficit: prior finalReadiness did not match observable runtime facts (${issueSummary}). Correct only the listed finalReadiness fields and retry with the allowed actions; do not add source or workspace work unless source, length, structure, or Todo deficits are also active.`);
  }
  if (Array.isArray(allowedActions) && allowedActions.length > 0) {
    parts.push(`Allowed recovery actions now: ${allowedActions.join(", ")}.`);
  }
  return parts.join(" ");
}

export { buildReadinessRetryArgsExample, buildRequiredRepair, buildValidLimitedArgsExample, buildValidPublishContract, explainTerminalRepairPublishArgs, getPublishProtocolRequiredActionForReason, isBudgetConstrainedForLimitedPublish, isCandidateQualityRepairReason, isInvalidTerminalRepairPublishBlock, isPublishProtocolRepairReason, isPublishProtocolRequiredActionCompleted, isPublishProtocolRequiredActionForRepair, isPublishProtocolStillBlockedForReason, isReadinessOnlyDeficits, isValidTerminalRepairPublishArgs, isWorkspaceRepairInspectionActionForRepair, readTerminalRepairGaps, resolvePublishProtocolActionContract, resolvePublishValidationDeficits };
