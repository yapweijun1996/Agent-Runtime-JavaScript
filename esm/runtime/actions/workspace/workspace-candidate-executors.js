import { PUBLISH_DIRECT_ACTION } from '../../action-names.js';
import { DEFAULT_FINAL_CANDIDATE_PATH } from '../../workspace-candidate-lifecycle.js';
import { appendSourcesSection } from '../../final-response-sources.js';
import { applyTerminalFinalContract } from '../../terminal-final-contract.js';
import { buildCitationCoverageAudit } from '../../candidate-quality-signal.js';
import { normalizeFinalReadiness, createFinalReadinessAssessment } from '../../final-readiness.js';
import { finalizeWorkspaceCandidate, inspectWorkspacePublishProtocol, readWorkspaceFinalCandidate, inspectWorkspaceCandidateReviewFreshness, recordWorkspaceCandidateReview, publishWorkspaceEvent, recordWorkspacePublishCandidateLifecycle } from '../../virtual-workspace.js';
import { readString, readNumber } from '../../semantic-json.js';
import { buildAndStoreCandidateQualitySignal, inspectCandidateQualityPublishReadiness } from './candidate-quality-readiness.js';
import { createWorkspacePublishBlockedResult, runOutputGuardrails, collectCandidateAuditTrail } from './publish-blocking.js';
import { isPublishLoopEscapeGranted, collectWorkspacePublishSources } from './publish-sources.js';
import { isResearchPublishReadinessRequired, inspectPublishReadiness, canPublishLimitedWithTerminalRepair } from './publish-readiness.js';
import { inspectPublishTodoStateSync } from './publish-todo-sync.js';
import { ensureWorkspace } from './workspace-preflight.js';
import { summarizeFile } from './workspace-stats.js';

// Candidate-lifecycle action executors (workspace_finalize_candidate /
// workspace_review_candidate / workspace_publish_candidate), extracted from
// virtual-workspace-actions.js (AGRUN-451 slice 10). These are the heaviest
// executors — they orchestrate the whole publish-readiness pipeline via the
// extracted workspace/ helper modules. The action defs stay in
// virtual-workspace-actions.js and import these three back for their `execute:`
// fields; action-registry.js is unaffected.


async function executeWorkspaceFinalizeCandidateAction(context, args) {
  const candidatePath = args && args.path || DEFAULT_FINAL_CANDIDATE_PATH;
  const quality = finalizeWorkspaceCandidate(context.runState, args && args.path || DEFAULT_FINAL_CANDIDATE_PATH, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const workspace = context && context.runState && context.runState.virtualWorkspace;
  // Source-gate steering (2026-06-10) — finalize is the moment the model
  // declares "done writing" but can still edit cheaply. State the
  // read-but-uncited diff here, while adding citations is one insert away.
  const candidateFile = workspace && workspace.files && workspace.files[candidatePath];
  const citationCoverage = buildCitationCoverageAudit(
    candidateFile && typeof candidateFile.content === "string" ? candidateFile.content : "",
    context.runState
  );
  const uncitedCount = citationCoverage.uncitedReadUrls.length;
  return {
    control: "continue",
    output: {
      candidateLifecycle: workspace && workspace.candidateLifecycle || null,
      candidatePathMismatchSignal: context.runState.candidatePathMismatchSignal || null,
      citationCoverage,
      kind: "virtual_workspace_finalize_candidate",
      message: citationCoverage.message,
      publishProtocol: inspectWorkspacePublishProtocol(workspace, candidatePath),
      quality
    },
    summary: `workspace_finalize_candidate(ready=${quality.finalCandidateReady ? "yes" : "no"}${uncitedCount > 0 ? `, read_but_uncited_sources=${uncitedCount}` : ""})`
  };
}

async function executeWorkspaceReviewCandidateAction(context, args) {
  const workspace = ensureWorkspace(context);
  const file = readWorkspaceFinalCandidate(workspace, args && args.path);
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, file.path);
  const lastRead = workspace && workspace.quality && workspace.quality.lastRead;
  if (!lastRead || lastRead.path !== file.path || publishProtocol.readAfterLatestContentChange !== true) {
    const signal = buildAndStoreCandidateQualitySignal(context, workspace, file, null, {
      reviewRequired: true
    });
    return {
      control: "continue",
      output: {
        candidateQualitySignal: signal,
        file: summarizeFile(file),
        kind: "virtual_workspace_review_candidate",
        message: `workspace_review_candidate requires workspace_read of ${file.path} after the latest content change before self-review.`,
        publishProtocol,
        status: "read_required"
      },
      summary: `workspace_review_candidate(${file.path}, status=read_required)`
    };
  }
  const reviewFreshness = inspectWorkspaceCandidateReviewFreshness(workspace, file.path);
  if (reviewFreshness.fresh === true) {
    const signal = buildAndStoreCandidateQualitySignal(context, workspace, file, null, {
      reviewRequired: true
    });
    return {
      control: "continue",
      output: {
        candidateQualitySignal: signal,
        candidateReview: workspace.quality && workspace.quality.candidateReview || null,
        file: summarizeFile(file),
        kind: "virtual_workspace_review_candidate",
        message: `workspace_review_candidate already has a fresh review for ${file.path} v${reviewFreshness.fileVersion}. Do not repeat review without changing candidate content; publish if ready, or repair the candidate content if not ready.`,
        publishProtocol,
        reviewFreshness,
        status: "fresh_review_exists"
      },
      summary: `workspace_review_candidate(${file.path}, status=fresh_review_exists)`
    };
  }
  const reviewWorkspace = recordWorkspaceCandidateReview(context.runState, file.path, {
    finalSectionTitle: args && args.finalSectionTitle,
    issues: args && args.issues,
    readyToPublish: args && args.readyToPublish === true,
    repairPlan: args && args.repairPlan,
    requirementsChecklist: args && args.requirementsChecklist,
    summary: args && args.summary
  }, {
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    maxOperations: context.runtimeConfig && context.runtimeConfig.virtualWorkspace && context.runtimeConfig.virtualWorkspace.maxOperations,
    prompt: context.request && context.request.prompt,
    summary: args && args.summary
  });
  const reviewedFile = readWorkspaceFinalCandidate(reviewWorkspace, file.path);
  const signal = buildAndStoreCandidateQualitySignal(context, reviewWorkspace, reviewedFile, null, {
    reviewRequired: true
  });
  publishWorkspaceEvent(context.runState, { type: "workspace_review_candidate", path: file.path, status: "ok" });
  return {
    control: "continue",
    output: {
      candidateQualitySignal: signal,
      candidateReview: reviewWorkspace.quality && reviewWorkspace.quality.candidateReview || null,
      // Source-gate steering parity — the citation-verify live run showed a
      // model can reach publish via review WITHOUT ever calling finalize, so
      // the audit must sit on BOTH self-check moments.
      citationCoverage: buildCitationCoverageAudit(readString(reviewedFile.content), context.runState),
      file: summarizeFile(reviewedFile),
      kind: "virtual_workspace_review_candidate",
      publishProtocol: inspectWorkspacePublishProtocol(reviewWorkspace, file.path),
      status: "ok"
    },
    summary: `workspace_review_candidate(${file.path}, status=ok, blockingIssues=${signal.blockingIssueCodes.length})`
  };
}

async function executeWorkspacePublishCandidateAction(context, args) {
  const workspace = ensureWorkspace(context);
  const file = readWorkspaceFinalCandidate(workspace, args && args.path);
  const candidateText = readString(file.content);
  const publishProtocol = inspectWorkspacePublishProtocol(workspace, file.path);
  const candidatePathMismatchSignal = recordWorkspacePublishCandidateLifecycle(context.runState, file.path, {
    completed: false,
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    prompt: context.request && context.request.prompt
  });
  const finalReadiness = normalizeFinalReadiness(args && (args.finalReadiness || args.readiness));
  const researchPublishRequired = isResearchPublishReadinessRequired(context);
  // Empty content is a legitimate I/O guard, not a behavioral push:
  // there is literally nothing to publish. AI-first decisions about
  // WHEN to publish (finalize protocol, read-after-finalize, readiness
  // self-audit) are surfaced as read-only observations on the planner
  // prompt and on this action's terminal output, never as runtime
  // throws that erase prior cycles. See
  // agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md for
  // the live e2e that documented the previous push-mode behavior.
  if (!candidateText) {
    return createWorkspacePublishBlockedResult({
      context,
      file,
      finalReadiness,
      message: `workspace_publish_candidate cannot publish ${file.path || "final candidate"} because it is empty. Draft user-facing content with workspace_write, or pass the non-empty draft path to workspace_finalize_candidate and workspace_publish_candidate before publishing.`,
      publishProtocol,
      readinessAudit: null,
      researchPublishRequired,
      status: "missing_candidate_content"
    });
  }
  const readinessAudit = inspectPublishReadiness(context, workspace, file, finalReadiness);
  const candidateQualitySignal = buildAndStoreCandidateQualitySignal(context, workspace, file, finalReadiness, {
    reviewRequired: researchPublishRequired
  });
  // AGRUN publish-loop escape: terminal-repair grants publishLoopEscapeGranted
  // once the run hits hard_veto with a real drafted candidate (the AI has
  // failed the brittle write->finalize->read->review->publish protocol past the
  // high-water mark). Rather than block forever and return the maxSteps "paused"
  // stub, publish the candidate ARTIFACT as-is: skip the protocol / readiness /
  // candidate-quality / todo-sync gates below (their unmet facts remain
  // observable on this output's publishProtocol + readinessAudit) so the full
  // report the AI already wrote is delivered with honest limitations. Narrow:
  // requires the hard_veto escape flag AND non-empty candidate content (checked
  // above), so it never fires on a convergeable publish.
  const publishLoopEscape = isPublishLoopEscapeGranted(context && context.runState);
  if (!publishLoopEscape && !publishProtocol.finalizedAfterLatestWrite) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: `workspace_publish_candidate requires workspace_finalize_candidate after the latest write to ${file.path}. Call workspace_finalize_candidate, read the latest candidate textStats, sync TodoState, and publish again.`,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "missing_finalize_after_latest_write"
    });
  }
  if (!publishLoopEscape && !publishProtocol.readAfterLatestContentChange) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      // Counted message is computed inside createWorkspacePublishBlockedResult
      // so the `(N-th attempt)` prefix is consistent with publishBlockHistory.
      message: `workspace_publish_candidate requires workspace_read of the latest candidate content for ${file.path} AFTER the most recent workspace_write/append/insert_after_section/replace. If you just revised the candidate, your next action should be workspace_read on the same path; then sync TodoState and publish.`,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "missing_latest_workspace_read"
    });
  }
  if (!publishLoopEscape && !readinessAudit.ok) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: readinessAudit.message,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "readiness_audit_failed"
    });
  }
  const candidateQualityBlock = inspectCandidateQualityPublishReadiness(candidateQualitySignal, finalReadiness, {
    limitedPublishAllowed: canPublishLimitedWithTerminalRepair(context, finalReadiness, file.path)
  });
  if (!publishLoopEscape && !candidateQualityBlock.ok) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: candidateQualityBlock.message,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: candidateQualityBlock.status
    });
  }
  const todoSyncAudit = inspectPublishTodoStateSync(context, finalReadiness, file.path);
  if (!publishLoopEscape && !todoSyncAudit.ok) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: todoSyncAudit.message,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: todoSyncAudit.status
    });
  }
  // ADR-0051 — host-defined output guardrails run as the LAST check before
  // terminalizing. Validation-only: a host guardrail may BLOCK (returns a
  // re-plan observation to the AI) but never authors content. It remains
  // authoritative even during publishLoopEscape; the escape prevents infinite
  // protocol/readiness repair loops, not host policy bypass.
  const guardrailBlock = await runOutputGuardrails(context, {
    candidateQualitySignal,
    file,
    finalReadiness
  });
  if (guardrailBlock) {
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: `Output guardrail "${guardrailBlock.name}" blocked publish: ${guardrailBlock.reason}`,
      outputGuardrailBlock: guardrailBlock,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "output_guardrail_blocked"
    });
  }
  // AGRUN-543 — even when the publish-loop escape is granted, preserve the
  // read-after-latest-write TRUTH anchor. The escape exists to bypass the
  // brittle finalize/review/readiness/quality/todo gates a weak model cannot
  // satisfy (AGRUN-307/309/310), NOT to let the model ship a candidate it has
  // never looked at since its last edit. Live evidence (gemini/gpt-5.4-mini/
  // deepseek, 2026-06-17): every model reached this escape by spamming
  // workspace_publish_candidate WITHOUT ever calling workspace_read, so the
  // structure observation (duplicate / semantic-duplicate sections) never
  // reached the planner. Force exactly ONE workspace_read so the model SEES the
  // current candidate (its structureEcho + citation coverage) before the
  // limited publish. Runs AFTER the host output guardrail so guardrail policy
  // stays authoritative (ADR-0051). Bounded to a single forced read per run
  // (publishEscapeForcedReadCount) so a model that still ignores it terminalizes
  // anyway — the no-infinite-loop guarantee holds. Mechanical timestamp check,
  // never a content-quality judgment.
  if (
    publishLoopEscape &&
    !publishProtocol.readAfterLatestContentChange &&
    readNumber(context.runState && context.runState.publishEscapeForcedReadCount, 0) < 1
  ) {
    if (context.runState && typeof context.runState === "object") {
      context.runState.publishEscapeForcedReadCount =
        readNumber(context.runState.publishEscapeForcedReadCount, 0) + 1;
    }
    return createWorkspacePublishBlockedResult({
      candidateQualitySignal,
      context,
      file,
      finalReadiness,
      message: `Before publishing limited, read the current candidate once: run workspace_read on ${file.path} to see its latest content and structure (you have not read it since your last edit). If the structure scan reports duplicate or semantic-duplicate sections, merge or remove the repeated block with workspace_replace/workspace_multi_edit; otherwise publish limited again.`,
      publishProtocol,
      readinessAudit,
      researchPublishRequired,
      status: "missing_latest_workspace_read"
    });
  }
  const sourcePayload = collectWorkspacePublishSources(context);
  const candidateTextWithSources = appendSourcesSection(candidateText, sourcePayload.sources);
  const terminalContract = applyTerminalFinalContract({
    finalReadiness,
    pushStep: context.pushStep,
    request: context.request,
    runState: context.runState,
    source: PUBLISH_DIRECT_ACTION,
    text: candidateTextWithSources
  });
  const text = terminalContract.text;
  const publishedCandidatePathMismatchSignal = recordWorkspacePublishCandidateLifecycle(context.runState, file.path, {
    completed: true,
    config: context.runtimeConfig && context.runtimeConfig.virtualWorkspace,
    prompt: context.request && context.request.prompt
  }) || candidatePathMismatchSignal;
  if (finalReadiness) {
    context.runState.researchFinalizeContract = {
      aiDeclaredReady: true,
      finalReadiness,
      finalReadinessAssessment: createFinalReadinessAssessment({
        finalReadiness,
        request: context.request,
        runtimeConfig: context.runtimeConfig,
        runState: context.runState
      }),
      kind: "ai_first_research_contract_observation",
      publishProtocol,
      readinessAudit,
      required: researchPublishRequired,
      source: PUBLISH_DIRECT_ACTION,
      status: "observed",
      successfulReadUrlCount: finalReadiness.requirementsAssessment && typeof finalReadiness.requirementsAssessment.successfulReadUrlCount === "number"
        ? finalReadiness.requirementsAssessment.successfulReadUrlCount
        : null
    };
  }
  return {
    control: "complete",
    output: {
      candidateAuditTrail: collectCandidateAuditTrail(workspace, file.path),
      candidateQualitySignal,
      candidatePathMismatchSignal: publishedCandidatePathMismatchSignal,
      citations: sourcePayload.citations,
      finalReadiness,
      finalReadinessAssessment: finalReadiness
        ? createFinalReadinessAssessment({
          finalReadiness,
          request: context.request,
          runtimeConfig: context.runtimeConfig,
          runState: context.runState
        })
        : null,
      kind: "final_response",
      model: context.request && context.request.model || null,
      provider: context.request && context.request.provider || null,
      publishProtocol,
      readinessAudit,
      researchPublishReadinessRequired: researchPublishRequired,
      terminalContractAudit: terminalContract.audit,
      text,
      workspaceCandidate: {
        path: file.path,
        size: text.length,
        textStats: file.textStats,
        updatedAt: file.updatedAt || null,
        version: file.version
      }
    },
    summary: `workspace_publish_candidate(${file.path}, chars=${text.length}, finalize_after_write=${publishProtocol.finalizedAfterLatestWrite ? "yes" : "no"}, read_after_finalize=${publishProtocol.readAfterFinalize ? "yes" : "no"}, readiness_ok=${readinessAudit.ok ? "yes" : "no"}, suffix_normalized=${terminalContract.audit && terminalContract.audit.suffixAudit && terminalContract.audit.suffixAudit.normalized ? "yes" : "no"})`
  };
}

export { executeWorkspaceFinalizeCandidateAction, executeWorkspacePublishCandidateAction, executeWorkspaceReviewCandidateAction };
