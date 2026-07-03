import { readString, readNumber } from '../semantic-json.js';
import { ASK_CLARIFICATION_ACTION, WEB_SEARCH_ACTION } from '../action-names.js';
import { isResearchQualityGateRequired } from '../convergence-activation.js';

// Long-research preflight block gates, extracted from action-loop-action.js
// (AGRUN-450 slice 1). These two gates fire only while a long-research harness
// is active: they stop an `ask_clarification` that has no recorded open
// ambiguity, and a repeated `web_search` that should hand off to read_url.
//
// The cluster is self-contained: every helper below is private to these two
// gates. The only outside-the-cluster dependency is the workspace length-deficit
// reader, which still lives in action-loop-action.js (it is shared by several
// other gates). Rather than re-import it (which would create a circular edge
// back into the god file), the orchestrator INJECTS it through the options bag.


// Local non-negative number reader: non-finite -> 0. This deliberately differs
// from semantic-json's readFiniteNumber (which returns null); the Math.max math
// in readResearchSourceFacts relies on the 0 fallback. readNumber(value, 0) is
// the canonical SSOT for exactly this "-> 0" semantic.
function readFiniteNumber$8(value) {
  return readNumber(value, 0);
}

function maybeBlockUnnecessaryLongResearchClarification(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== ASK_CLARIFICATION_ACTION) return null;
  const runState = options && options.runState;
  if (!isLongResearchHarnessActive(runState, {
    prompt: readString(options && options.request && options.request.prompt)
  })) {
    return null;
  }
  if (hasOpenClarificationNeed(runState)) return null;
  if (!hasResearchProgressSignal(runState)) return null;
  const sourceFacts = readResearchSourceFacts(runState);
  const candidateCount = countResearchCandidateUrls(runState);
  const message = [
    "Long research clarification guard: no open ambiguity is recorded for this run.",
    "Missing terminology coverage, thin search results, or weak source confidence are research limitations, not user ambiguity.",
    "Continue with read_url on an unread candidate, write/update the workspace with visible limitations, or publish limited only with concrete remainingGaps if evidence is exhausted."
  ].join(" ");
  const output = {
    ok: false,
    control: "continue",
    kind: "evidence_convergence_clarification_preflight_block",
    status: "blocked",
    reason: "clarification_without_open_ambiguity",
    actionName,
    forbiddenMove: "ask_clarification_without_open_ambiguity",
    allowedNextMoves: buildLongResearchAllowedNextMoves(runState, {
      preferReadUrl: candidateCount > 0 && sourceFacts.successfulReadUrlCount === 0,
      readWorkspaceLengthDeficit: options && options.readWorkspaceLengthDeficit
    }),
    researchFacts: {
      candidateUrlCount: candidateCount,
      searchPassCount: countSearchPasses(runState),
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount,
      sourceMinimum: sourceFacts.sourceMinimum
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("long-research-clarification-blocked", {
      candidateUrlCount: candidateCount,
      reason: output.reason,
      searchPassCount: output.researchFacts.searchPassCount,
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount
    });
  }
  return { message, output };
}

function maybeBlockLongResearchSearchWithoutRead(options) {
  const actionName = readString(options && options.actionName);
  if (actionName !== WEB_SEARCH_ACTION) return null;
  const runState = options && options.runState;
  if (!isLongResearchHarnessActive(runState, {
    prompt: readString(options && options.request && options.request.prompt)
  })) return null;
  const searchPassCount = countSearchPasses(runState);
  if (searchPassCount < 2) return null;
  const sourceFacts = readResearchSourceFacts(runState);
  const candidateCount = countResearchCandidateUrls(runState);
  if (candidateCount === 0) return null;
  const sourceMinimum = sourceFacts.sourceMinimum;
  const readSources = readFiniteNumber$8(sourceMinimum && sourceMinimum.readSources);
  const minReadSources = readFiniteNumber$8(sourceMinimum && sourceMinimum.minReadSources);
  const relevantSources = readFiniteNumber$8(sourceMinimum && sourceMinimum.relevantSources);
  const minRelevantSources = readFiniteNumber$8(sourceMinimum && sourceMinimum.minRelevantSources);
  const sourceMinimumUnmet = Boolean(
    sourceMinimum &&
    sourceMinimum.passed !== true &&
    (
      (minReadSources > 0 && readSources < minReadSources) ||
      (minRelevantSources > 0 && relevantSources < minRelevantSources)
    )
  );
  const unreadCandidatesAvailable = candidateCount > sourceFacts.successfulReadUrlCount;
  if (sourceFacts.successfulReadUrlCount > 0 && (!sourceMinimumUnmet || !unreadCandidatesAvailable)) {
    return null;
  }
  const hasNoSuccessfulRead = sourceFacts.successfulReadUrlCount === 0;
  const message = [
    hasNoSuccessfulRead
      ? `Long research evidence handoff is active: ${searchPassCount} search pass(es) already produced ${candidateCount} candidate URL(s), but no successful read_url evidence exists.`
      : `Long research source minimum is still unmet: ${readSources}/${minReadSources} read source(s), ${relevantSources}/${minRelevantSources} relevant source(s), and ${candidateCount} candidate URL(s) are available.`,
    "More broad web_search calls are lower-value than reading an unread candidate or documenting a concrete source blocker.",
    "Use read_url on an unread candidate, or publish limited only if the remaining source blockers are concrete."
  ].join(" ");
  const output = {
    ok: false,
    control: "continue",
    kind: "evidence_convergence_search_read_handoff_block",
    status: "blocked",
    reason: hasNoSuccessfulRead
      ? "search_candidates_exist_without_read_url"
      : "source_minimum_unmet_with_unread_candidates",
    actionName,
    forbiddenMove: hasNoSuccessfulRead
      ? "repeat_web_search_before_reading_candidates"
      : "repeat_web_search_before_meeting_source_minimum",
    allowedNextMoves: buildLongResearchAllowedNextMoves(runState, {
      preferReadUrl: true,
      readWorkspaceLengthDeficit: options && options.readWorkspaceLengthDeficit
    }),
    researchFacts: {
      candidateUrlCount: candidateCount,
      searchPassCount,
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount,
      sourceMinimum: sourceFacts.sourceMinimum
    },
    message
  };
  if (typeof (options && options.pushStep) === "function") {
    options.pushStep("long-research-search-read-handoff-blocked", {
      candidateUrlCount: candidateCount,
      reason: output.reason,
      searchPassCount,
      successfulReadUrlCount: sourceFacts.successfulReadUrlCount
    });
  }
  return { message, output };
}

function isLongResearchHarnessActive(runState, options = {}) {
  if (isResearchQualityGateRequired(runState, options)) return true;
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : null;
  if (!loop) return false;
  if (loop.enabled === true) return true;
  const status = readString(loop.status);
  if (status && status !== "idle" && status !== "none") return true;
  return Boolean(
    loop.gateSignal &&
    loop.gateSignal.acceptancePacket &&
    typeof loop.gateSignal.acceptancePacket === "object"
  );
}

function hasOpenClarificationNeed(runState) {
  const plannerState = runState && runState.plannerState && typeof runState.plannerState === "object"
    ? runState.plannerState
    : {};
  const inquiryContext = runState && runState.inquiryContext && typeof runState.inquiryContext === "object"
    ? runState.inquiryContext
    : {};
  if (plannerState.hasOpenAmbiguity === true) return true;
  if (readString(plannerState.openAmbiguity)) return true;
  if (plannerState.pendingClarification && typeof plannerState.pendingClarification === "object") return true;
  if (inquiryContext.pendingClarification && typeof inquiryContext.pendingClarification === "object") return true;
  if (readString(inquiryContext.openAmbiguity)) return true;
  return false;
}

function hasResearchProgressSignal(runState) {
  if (!runState || typeof runState !== "object") return false;
  if (countSearchPasses(runState) > 0) return true;
  if (countResearchCandidateUrls(runState) > 0) return true;
  const facts = readResearchSourceFacts(runState);
  if (facts.successfulReadUrlCount > 0) return true;
  const workspace = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : null;
  if (!workspace) return false;
  const files = workspace.files && typeof workspace.files === "object" && !Array.isArray(workspace.files)
    ? workspace.files
    : {};
  return Object.values(files).some((file) => readString(file && file.content));
}

function countSearchPasses(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  return Array.isArray(context.searchPasses) ? context.searchPasses.length : 0;
}

function countResearchCandidateUrls(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const candidates = [];
  for (const key of ["aggregatedSearchResults", "searchResults"]) {
    const items = Array.isArray(context[key]) ? context[key] : [];
    candidates.push(...items);
  }
  const passes = Array.isArray(context.searchPasses) ? context.searchPasses : [];
  for (const pass of passes) {
    if (!pass || typeof pass !== "object") continue;
    const items = Array.isArray(pass.items)
      ? pass.items
      : Array.isArray(pass.results)
        ? pass.results
        : Array.isArray(pass.rankedItems)
          ? pass.rankedItems
          : [];
    candidates.push(...items);
  }
  const urls = new Set();
  for (const item of candidates) {
    const url = readString(item && item.url);
    if (url) urls.add(url);
  }
  return urls.size;
}

function readResearchSourceFacts(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const readSources = Array.isArray(context.readSources) ? context.readSources : [];
  const successfulReadUrlCount = readSources.filter((source) => source && source.ok !== false).length;
  const loop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  const packet = loop.gateSignal &&
    loop.gateSignal.acceptancePacket &&
    typeof loop.gateSignal.acceptancePacket === "object"
    ? loop.gateSignal.acceptancePacket
    : {};
  const sourceMinimum = packet.evidence &&
    packet.evidence.sourceMinimum &&
    typeof packet.evidence.sourceMinimum === "object"
    ? packet.evidence.sourceMinimum
    : loop.sourceMinimum && typeof loop.sourceMinimum === "object"
      ? loop.sourceMinimum
      : null;
  const packetSuccessful = readFiniteNumber$8(packet.evidence && packet.evidence.successfulReadUrlCount);
  return {
    successfulReadUrlCount: Math.max(successfulReadUrlCount, packetSuccessful),
    sourceMinimum: sourceMinimum ? {
      minReadSources: readFiniteNumber$8(sourceMinimum.minReadSources) || readFiniteNumber$8(sourceMinimum.minReads),
      minRelevantSources: readFiniteNumber$8(sourceMinimum.minRelevantSources) || readFiniteNumber$8(sourceMinimum.minRelevant),
      passed: sourceMinimum.passed === true,
      readSources: readFiniteNumber$8(sourceMinimum.readSources) || readFiniteNumber$8(sourceMinimum.reads),
      relevantSources: readFiniteNumber$8(sourceMinimum.relevantSources) || readFiniteNumber$8(sourceMinimum.relevant)
    } : null
  };
}

function buildLongResearchAllowedNextMoves(runState, options = {}) {
  const moves = [];
  if (options.preferReadUrl === true) moves.push("read_url");
  const readWorkspaceLengthDeficit = typeof options.readWorkspaceLengthDeficit === "function"
    ? options.readWorkspaceLengthDeficit
    : () => null;
  const workspaceDeficit = readWorkspaceLengthDeficit(runState);
  if (workspaceDeficit) {
    moves.push("workspace_insert_after_section");
  } else {
    moves.push("workspace_write", "workspace_insert_after_section");
  }
  moves.push("workspace_publish_candidate_limited_with_remainingGaps");
  return Array.from(new Set(moves));
}

export { buildLongResearchAllowedNextMoves, maybeBlockLongResearchSearchWithoutRead, maybeBlockUnnecessaryLongResearchClarification };
