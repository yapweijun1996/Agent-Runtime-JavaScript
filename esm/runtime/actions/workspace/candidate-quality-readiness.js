import { CANDIDATE_QUALITY_BLOCKED_REASON } from '../../kernel-terminal-actions.js';
import { normalizeCandidateQualitySignal, buildCandidateQualitySignal } from '../../candidate-quality-signal.js';
import { readNumber } from './workspace-stats.js';

// Candidate-quality signal builder + publish-readiness inspector, extracted from
// virtual-workspace-actions.js (AGRUN-451 slice 7 — component E of the
// publish-readiness cluster). buildAndStoreCandidateQualitySignal normalizes and
// caches the candidateQualitySignal on runState/workspace (called by both the
// review and publish executors); inspectCandidateQualityPublishReadiness maps a
// signal's blocking issue codes to a publish allow/block verdict. The two are
// independent leaves — neither calls the other, and nothing here calls back into
// virtual-workspace-actions.js. The review + publish executors import both back.
//
// NOTE: readNumber here is workspace-stats's 1-arg non-finite -> 0 reader (catch
// B), matching the original god-file binding; both call sites pass one arg.


function buildAndStoreCandidateQualitySignal(context, workspace, file, finalReadiness, options = {}) {
  const signal = normalizeCandidateQualitySignal(buildCandidateQualitySignal({
    context,
    file,
    finalReadiness,
    reviewRequired: options.reviewRequired === true,
    runState: context && context.runState,
    runtimeConfig: context && context.runtimeConfig,
    workspace
  }));
  if (context && context.runState && typeof context.runState === "object") {
    context.runState.candidateQualitySignal = signal;
    const runWorkspace = context.runState.virtualWorkspace && typeof context.runState.virtualWorkspace === "object"
      ? context.runState.virtualWorkspace
      : null;
    if (runWorkspace && runWorkspace.quality && typeof runWorkspace.quality === "object") {
      runWorkspace.quality.candidateQualitySignal = signal;
    }
  }
  if (workspace && workspace.quality && typeof workspace.quality === "object") {
    workspace.quality.candidateQualitySignal = signal;
  }
  return signal;
}

function inspectCandidateQualityPublishReadiness(signal, finalReadiness, options = {}) {
  const quality = normalizeCandidateQualitySignal(signal);
  if (!quality || quality.hasBlockingIssues !== true) return { ok: true };
  const codes = Array.isArray(quality.blockingIssueCodes) ? quality.blockingIssueCodes : [];
  if (codes.includes("missing_latest_candidate_review")) {
    return {
      ok: false,
      status: "missing_latest_candidate_review",
      message: "workspace_publish_candidate requires workspace_review_candidate after the latest workspace_read/content change before publishing this long-form candidate."
    };
  }
  const hardContentCodes = codes.filter((code) => (
    code === "blocked_source_cited" ||
    code === "unread_cited_url" ||
    code === "content_after_final_section"
  ));
  if (hardContentCodes.length > 0) {
    if (
      options.limitedPublishAllowed === true &&
      finalReadiness &&
      finalReadiness.decision === "limited"
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      status: CANDIDATE_QUALITY_BLOCKED_REASON,
      message: `workspace_publish_candidate blocked by candidateQualitySignal issues: ${hardContentCodes.join(", ")}. Read/review the candidate and repair the content or publish limited only after removing invalid citations/structure blockers.`
    };
  }
  // Citation minimum: "limited" is an HONEST escape only when the model could
  // not obtain the sources. If it already READ enough readable sources but cited
  // fewer than the minimum, "limited" is evasion, not honesty — block regardless
  // of decision and tell it to cite the sources it already has.
  if (codes.includes("missing_required_cited_urls")) {
    const audit = quality.citationAudit;
    const minUrls = readNumber(quality.requestedCitations && quality.requestedCitations.minUrlCount);
    const readableSources = audit ? readNumber(audit.readableEvidenceUrlCount) : 0;
    if (minUrls > 0 && readableSources >= minUrls) {
      return {
        ok: false,
        status: CANDIDATE_QUALITY_BLOCKED_REASON,
        message: `workspace_publish_candidate blocked: candidate cites too few URLs but you already read ${readableSources} readable source(s) (minimum ${minUrls}). Add inline citations to the sources you read before publishing — "limited" is not allowed when the sources are available.`
      };
    }
  }
  if (finalReadiness && finalReadiness.decision === "ready") {
    return {
      ok: false,
      status: CANDIDATE_QUALITY_BLOCKED_REASON,
      message: `workspace_publish_candidate ready publish blocked by candidateQualitySignal issues: ${codes.join(", ")}. Repair the candidate or publish limited with concrete remainingGaps when the blocker is an honest unmet requirement.`
    };
  }
  return { ok: true };
}

export { buildAndStoreCandidateQualitySignal, inspectCandidateQualityPublishReadiness };
