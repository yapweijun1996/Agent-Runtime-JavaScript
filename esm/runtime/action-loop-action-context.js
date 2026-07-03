import { readString } from './semantic-json.js';
import { READ_URL_ACTION, WEB_SEARCH_ACTION, WORKSPACE_READ_ACTION, FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION, WORKSPACE_APPLY_PATCH_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_REPLACE_ACTION } from './action-names.js';
import { explainReadSourceQuality, isReadableEvidenceSource } from './read-source-quality.js';
import { createSearchInquirySources } from './search-research-context.js';
import { normalizeInquiryContext, createContextSnapshot } from '../session/context-snapshot-normalize.js';
import { normalizeReadSource, normalizeCandidateSource } from '../session/context-snapshot-fields.js';

function pushReadUrlRequestedStep(actionName, actionArgs, pushStep) {
  if (actionName !== READ_URL_ACTION) {
    return;
  }

  pushStep("read-url-requested", {
    maxBytes: typeof actionArgs?.maxBytes === "number" ? actionArgs.maxBytes : null,
    method: readString(actionArgs && actionArgs.method) || "GET",
    mode: readString(actionArgs && actionArgs.mode) || "auto",
    textLength: typeof actionArgs?.textLength === "number" ? actionArgs.textLength : null,
    textStart: typeof actionArgs?.textStart === "number" ? actionArgs.textStart : null,
    timeoutMs: typeof actionArgs?.timeoutMs === "number" ? actionArgs.timeoutMs : null,
    url: readString(actionArgs && actionArgs.url)
  });
}

function pushReadUrlCompletedStep(actionName, output, query, pushStep) {
  if (actionName !== READ_URL_ACTION || !output || typeof output !== "object") {
    return;
  }

  if (output.ok === false) {
    pushStep("read-url-failed", {
      error: readString(output.error),
      message: readString(output.message),
      originStatus: typeof output.originStatus === "number" ? output.originStatus : null,
      reason: readString(output.reason),
      status: typeof output.status === "number" ? output.status : null,
      url: readString(output.url)
    });
    return;
  }

  const quality = explainReadSourceQuality(output, { query });
  pushStep("read-url-completed", {
    bytes: typeof output.bytes === "number" ? output.bytes : 0,
    contentType: readString(output.contentType),
    mode: readString(output.mode),
    originStatus: typeof output.originStatus === "number" ? output.originStatus : null,
    qualityReason: quality.reason,
    qualitySignals: quality.signals,
    status: typeof output.status === "number" ? output.status : null,
    textRange: normalizeTextRange$3(output.textRange),
    tier: quality.tier,
    truncated: output.truncated === true,
    url: readString(output.url)
  });
}

function createResearchReadSource(output, query) {
  const source = output && typeof output === "object" ? output : {};
  const sourceQualityDetail = explainReadSourceQuality(source, { query });
  const tier = sourceQualityDetail.tier;

  return {
    bytes: typeof source.bytes === "number" ? source.bytes : 0,
    contentType: readString(source.contentType),
    error: readString(source.error),
    message: readString(source.message),
    mode: readString(source.mode),
    ok: source.ok !== false,
    originStatus: typeof source.originStatus === "number" ? source.originStatus : null,
    platform: readString(source.platform),
    reason: readString(source.reason),
    screenshotDataUrl: readString(source.screenshotDataUrl),
    screenshotMimeType: readString(source.screenshotMimeType),
    sourceQualityDetail,
    status: typeof source.status === "number" ? source.status : null,
    text: readString(source.text),
    textRange: normalizeTextRange$3(source.textRange),
    tier,
    title: readString(source.title),
    truncated: source.truncated === true,
    url: readString(source.url)
  };
}

function normalizeTextRange$3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    end: readNonNegativeNumber(value.end),
    hasAfter: value.hasAfter === true,
    hasBefore: value.hasBefore === true,
    nextTextStart: readNonNegativeNumber(value.nextTextStart),
    requestedLength: readPositiveNumber(value.requestedLength),
    start: readNonNegativeNumber(value.start) || 0,
    totalChars: readNonNegativeNumber(value.totalChars) || 0
  };
}

function readPositiveNumber(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonNegativeNumber(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function syncSearchInquiryContext(runState, output) {
  const snapshot = ensureContextSnapshot(runState);
  const inquiryContext = normalizeInquiryContext(snapshot.inquiryContext);
  const candidateSources = createSearchInquirySources(output);

  inquiryContext.activeQuery = readString(output && output.query) || inquiryContext.activeQuery;
  inquiryContext.candidateSources = candidateSources;
  inquiryContext.lastSearchResults = candidateSources.slice();

  if (candidateSources.length === 1 && !inquiryContext.selectedSource) {
    inquiryContext.selectedSource = candidateSources[0];
  }

  runState.contextSnapshot = createContextSnapshot({
    ...snapshot,
    inquiryContext
  });
}

function syncReadInquiryContext(runState, readSource) {
  const snapshot = ensureContextSnapshot(runState);
  const inquiryContext = normalizeInquiryContext(snapshot.inquiryContext);
  const normalizedReadSource = normalizeReadSource(readSource);

  if (!normalizedReadSource) {
    return;
  }

  inquiryContext.lastReadSource = normalizedReadSource;
  if (isReadableEvidenceSource(normalizedReadSource)) {
    inquiryContext.selectedSource = findCandidateSource(
      inquiryContext.candidateSources,
      normalizedReadSource.url
    ) || normalizeCandidateSource(normalizedReadSource);
  }

  runState.contextSnapshot = createContextSnapshot({
    ...snapshot,
    inquiryContext
  });
}

function readResearchQuery(runState, request) {
  const inquiryContext = runState &&
    runState.contextSnapshot &&
    runState.contextSnapshot.inquiryContext &&
    typeof runState.contextSnapshot.inquiryContext === "object"
      ? runState.contextSnapshot.inquiryContext
      : null;

  return readString(inquiryContext && inquiryContext.activeQuery)
    || readString(runState && runState.researchContext && runState.researchContext.lastQuery)
    || readString(request && request.prompt);
}

// AGRUN-479 (audit M4 / H3) — SSOT for the long-run requirement-recovery gate,
// shared by BOTH dispatch paths (single action in action-loop-action.js, plan
// batch in action-loop-plan-actions.js). The two paths previously held diverged
// copies: the plan path was missing `workspace_apply_patch` /
// `workspace_propose_patch`, so the recovery evaluator was never refreshed for
// those actions on the plan path. Extracting it here (the existing shared
// helper module both paths already import) makes the action set a single edit
// instead of two — the divergence is structurally impossible to reintroduce.
function shouldRefreshLongRunRequirementRecovery(actionName, status) {
  if (actionName === WEB_SEARCH_ACTION) return status === "after_web_search";
  if (actionName === READ_URL_ACTION) return status === "after_read_url";
  return [
    WORKSPACE_READ_ACTION,
    FINALIZE_CANDIDATE_ACTION,
    PUBLISH_DIRECT_ACTION,
    WORKSPACE_APPLY_PATCH_ACTION,
    WORKSPACE_PROPOSE_PATCH_ACTION,
    WORKSPACE_WRITE_ACTION,
    WORKSPACE_INSERT_AFTER_SECTION_ACTION,
    WORKSPACE_REPLACE_ACTION
  ].includes(actionName);
}

function syncPendingClarification(runState, output) {
  const snapshot = ensureContextSnapshot(runState);
  const inquiryContext = normalizeInquiryContext(snapshot.inquiryContext);
  const question = readString(output && output.question) || readString(output && output.text);

  if (!question) {
    return;
  }

  inquiryContext.pendingClarification = {
    id: `clarify:${question.toLowerCase()}`,
    kind: "clarification",
    options: [],
    question,
    source: "action_output",
    sourceTurn: "current_input"
  };
  inquiryContext.lastClarificationResolution = null;

  runState.contextSnapshot = createContextSnapshot({
    ...snapshot,
    inquiryContext
  });
}

function ensureContextSnapshot(runState) {
  if (runState.contextSnapshot) {
    return createContextSnapshot(runState.contextSnapshot);
  }

  const snapshot = createContextSnapshot({});
  runState.contextSnapshot = snapshot;
  return snapshot;
}

function findCandidateSource(candidateSources, url) {
  const normalizedUrl = readString(url);

  if (!normalizedUrl) {
    return null;
  }

  return (Array.isArray(candidateSources) ? candidateSources : []).find((item) => (
    item &&
    typeof item === "object" &&
    readString(item.url) === normalizedUrl
  )) || null;
}

export { createResearchReadSource, pushReadUrlCompletedStep, pushReadUrlRequestedStep, readResearchQuery, shouldRefreshLongRunRequirementRecovery, syncPendingClarification, syncReadInquiryContext, syncSearchInquiryContext };
