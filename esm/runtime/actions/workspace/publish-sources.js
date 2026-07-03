import { filterSourcesByEvidence, collectFinalResponseSources, collectResearchEvidenceUrls, isDirectEvidenceUrl } from '../../final-response-sources.js';
import { readFinalSourcePrompt } from '../../final-source-prompt.js';
import { isReadableEvidenceSource } from '../../read-source-quality.js';
import { isResearchQualityGateRequired } from '../../convergence-activation.js';
import { resolveGrantedTerminalEscape } from '../../terminal-repair/escape-rules.js';
import { readString } from '../../semantic-json.js';

// Publish source-collection helpers + the publish-loop-escape read, extracted
// from virtual-workspace-actions.js (AGRUN-451 slice 8 — component A of the
// publish-readiness cluster, the LAST component; this closes the cluster split).
// collectWorkspacePublishSources gathers the cited/read sources for a publish
// (evidence-filtered final-response sources, with a read-source fallback);
// isPublishLoopEscapeGranted is the standalone terminal-repair escape read the
// publish executor checks. The cluster is closed: intra edges are
// collectWorkspacePublishSources -> {readWorkspacePublishScopedEvidenceUrls,
// collectWorkspacePublishReadSourceFallback} and
// readWorkspacePublishScopedEvidenceUrls -> isResearchEvidenceLoopActive; nothing
// here calls back into virtual-workspace-actions.js. The publish executor imports
// collectWorkspacePublishSources / isPublishLoopEscapeGranted back.


function collectWorkspacePublishSources(context) {
  const runState = context && context.runState;
  const request = context && context.request;
  const scopedEvidenceUrls = readWorkspacePublishScopedEvidenceUrls(runState);
  const sourceLimit = Array.isArray(scopedEvidenceUrls)
    ? Math.max(3, scopedEvidenceUrls.length)
    : undefined;
  const payload = filterSourcesByEvidence(
    collectFinalResponseSources(runState && runState.researchContext, sourceLimit, {
      prompt: readFinalSourcePrompt(runState, request),
      requireReadEvidence: isResearchQualityGateRequired(runState)
    }),
    scopedEvidenceUrls
  );
  if (payload.sources.length > 0) return payload;
  return collectWorkspacePublishReadSourceFallback(runState, sourceLimit);
}

function collectWorkspacePublishReadSourceFallback(runState, limit) {
  const readSources = Array.isArray(runState && runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  const max = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;
  const sources = [];
  const seenUrls = new Set();
  for (const item of readSources) {
    if (!isReadableEvidenceSource(item)) continue;
    const url = readString(item && item.url);
    if (!url || seenUrls.has(url) || !isDirectEvidenceUrl(url)) continue;
    seenUrls.add(url);
    sources.push({
      kind: "read_url",
      title: readString(item && item.title) || url,
      url
    });
    if (sources.length >= max) break;
  }
  return {
    citations: sources.map((item) => item.url),
    sources
  };
}

function readWorkspacePublishScopedEvidenceUrls(runState) {
  if (!runState || typeof runState !== "object") return null;
  const scopedUrls = Array.isArray(runState.scopedEvidenceUrls) ? runState.scopedEvidenceUrls : null;
  const researchUrls = collectResearchEvidenceUrls(runState.researchContext);

  if (scopedUrls && scopedUrls.length === 0 && !isResearchEvidenceLoopActive(runState)) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  if (!scopedUrls) {
    return researchUrls.length > 0 ? researchUrls : null;
  }
  return scopedUrls;
}

function isResearchEvidenceLoopActive(runState) {
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  if (!loop) return false;
  const status = readString(loop.status);
  return loop.enabled === true || Boolean(readString(loop.finalMode)) || Boolean(status && status !== "idle");
}

function isPublishLoopEscapeGranted(runState) {
  // AGRUN-559 — resolved via the shared escape-rule descriptors (opensPublish)
  // instead of hardcoding the flag name, so every publish-side door reads the
  // same first-match escape resolution as core.js grants it.
  const escape = resolveGrantedTerminalEscape(
    runState && runState.terminalRepairState && typeof runState.terminalRepairState === "object"
      ? runState.terminalRepairState
      : null
  );
  return Boolean(escape && escape.opensPublish);
}

export { collectWorkspacePublishReadSourceFallback, collectWorkspacePublishSources, isPublishLoopEscapeGranted, isResearchEvidenceLoopActive, readWorkspacePublishScopedEvidenceUrls };
