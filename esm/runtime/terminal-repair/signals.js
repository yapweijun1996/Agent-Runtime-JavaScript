import { countSuccessfulReadUrlArtifacts } from '../final-readiness.js';
import { WORKSPACE_REPLACE_ACTION, WORKSPACE_WRITE_ACTION, WORKSPACE_MULTI_EDIT_ACTION, WORKSPACE_PROPOSE_PATCH_ACTION, WORKSPACE_READ_ACTION, WORKSPACE_INSERT_AFTER_SECTION_ACTION, WORKSPACE_APPLY_PATCH_ACTION, READ_URL_ACTION, WORKSPACE_REVIEW_CANDIDATE_ACTION, TODO_ADVANCE_ACTION, TODO_RUN_NEXT_ACTION, TODO_CANCEL_ACTION, FINALIZE_CANDIDATE_ACTION, PUBLISH_DIRECT_ACTION } from '../action-names.js';
import { CANDIDATE_QUALITY_BLOCKED_REASON } from '../kernel-terminal-actions.js';
import { inspectWorkspaceCandidateStructure } from '../virtual-workspace.js';
import { DEFAULT_TERMINAL_REPAIR_THRESHOLDS, observableDeficitsRecord, readNumber, readString, readRecord, readFinalCandidatePathFromWorkspace, summarizeTextStats, workspaceMutationGrowthHardVetoForbiddenActions, readStringArray, readCurrentPublishProtocol, normalizeSectionNumberRepairHints, normalizeStructureContexts, normalizeStructureSamples, hasSelectedFinalCandidateContent } from './internal-utils.js';
import { readAcceptancePacket, readSourceMinimum } from './facts.js';

// H10 split, Step 4 (AGRUN-506) — terminal-repair planner-facing signals.
// VERBATIM moves from terminal-repair-state.js (see
// agrun_docs/terminal-repair-split-design-2026-06-12.md). Workspace repair
// signal (diagnostics + recommended action order), length-expansion signal
// (per-section deltas), advisory-persistence signal, and action-ordering
// nudges, plus the shared inspection/multi-write predicates that
// allowed-actions also imports. No public exports — everything here is
// consumed by core/allowed-actions and surfaced through state fields.

function buildLengthExpansionSignal(runState, observableDeficits) {
  const length = observableDeficitsRecord(observableDeficits, "length");
  if (!length) return null;
  const observed = readNumber(length.observed);
  const requested = readNumber(length.requested);
  if (!requested || observed >= requested) return null;
  const unit = readString(length.unit) || "words";
  const content = readFinalCandidateContent$1(runState);
  const perSectionDelta = buildPerSectionLengthDeltas(content, {
    requested,
    unit
  });
  return {
    kind: "lengthExpansionSignal",
    observed,
    requested,
    unit,
    gap: Math.max(requested - observed, 0),
    perSectionDelta,
    averageSectionGap: averagePositiveGap(perSectionDelta, Math.max(requested - observed, 0)),
    iterationCount: countWorkspaceExpansionIterations(runState)
  };
}

function buildWorkspaceRepairSignal(runState, observableDeficits, activeDeficits, allowedActions, reason, budgetState, escalation) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  if (!workspace) return null;
  const path = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : null;
  const file = files && path ? files[path] : null;
  const content = readString(file && file.content);
  const fileStats = readRecord(file && file.textStats) || summarizeTextStats(content);
  const length = observableDeficitsRecord(observableDeficits, "length");
  const requestedLength = readRequestedLengthForWorkspaceRepair(runState);
  const requestedLengthValue = length ? readNumber(length.requested) : readNumber(requestedLength && requestedLength.value);
  const requestedLengthUnit = length ? (readString(length.unit) || "words") : (readString(requestedLength && requestedLength.unit) || null);
  const candidateObservedLength = requestedLength && requestedLength.statsKey
    ? readNumber(fileStats && fileStats[requestedLength.statsKey])
    : 0;
  const lengthDeficit = length
    ? readNumber(length.deficit)
    : requestedLengthValue > 0 && candidateObservedLength > 0
      ? Math.max(0, requestedLengthValue - candidateObservedLength)
      : 0;
  const source = observableDeficitsRecord(observableDeficits, "source");
  const structureFact = observableDeficitsRecord(observableDeficits, "structure");
  const inspectedStructure = content ? inspectWorkspaceCandidateStructure(content) : null;
  const structure = mergeWorkspaceStructureFacts(structureFact, inspectedStructure);
  const hasLengthGap = Boolean(length && readNumber(length.requested) > readNumber(length.observed));
  const hasCitationGap = Boolean(source && Array.isArray(source.citationIssues) && source.citationIssues.length > 0);
  const hasStructureGap = Boolean(structure && structure.status === "fail");
  const active = hasLengthGap || hasCitationGap || hasStructureGap || readString(reason).includes("workspace") || readString(reason).includes("structure") || readString(reason) === CANDIDATE_QUALITY_BLOCKED_REASON;
  if (!active) return null;
  const forbiddenByWorkspaceMutationGrowth = workspaceMutationGrowthHardVetoForbiddenActions(runState);
  const actions = readStringArray(allowedActions)
    .filter((actionName) => !forbiddenByWorkspaceMutationGrowth.has(actionName));
  const protocol = readCurrentPublishProtocol(runState);
  const mustInspectCandidate = shouldRequireWorkspaceRepairInspection({
    activeDeficits,
    allowedActions: actions,
    observableDeficits,
    runState
  });
  const sourceSummary = buildWorkspaceRepairSourceSummary(runState, observableDeficits);
  const fullRewriteAllowed = Boolean(
    (actions.includes(WORKSPACE_REPLACE_ACTION) || actions.includes(WORKSPACE_WRITE_ACTION)) &&
    (hasStructureGap || (hasLengthGap && sourceSummary.successfulReadUrlCount > 0))
  );
  return {
    kind: "workspace_repair_signal",
    path,
    reason: readString(reason) || "workspace_repair_required",
    budgetState: readString(budgetState) || "unknown",
    escalation: readString(escalation) === "hard_veto" ? "hard_veto" : "advisory",
    latestReadStatus: {
      latestWriteIndex: readNumber(protocol && protocol.latestWriteIndex),
      latestFinalizeIndex: readNumber(protocol && protocol.latestFinalizeIndex),
      latestReadIndex: readNumber(protocol && protocol.latestReadIndex),
      readAfterLatestContentChange: Boolean(protocol && protocol.readAfterLatestContentChange),
      readAfterFinalize: Boolean(protocol && protocol.readAfterFinalize)
    },
    mustInspectCandidate,
    destructiveMutationRequiresInspection: Boolean(
      hasSelectedFinalCandidateContent(runState) &&
      protocol &&
      protocol.readAfterLatestContentChange !== true &&
      actions.some((actionName) => (
        actionName === WORKSPACE_REPLACE_ACTION ||
        actionName === WORKSPACE_WRITE_ACTION ||
        actionName === WORKSPACE_MULTI_EDIT_ACTION ||
        actionName === WORKSPACE_PROPOSE_PATCH_ACTION
      ))
    ),
    candidate: {
      path,
      textStats: {
        chars: readNumber(fileStats && fileStats.chars),
        cjkChars: readNumber(fileStats && fileStats.cjkChars),
        words: readNumber(fileStats && fileStats.words)
      },
      requestedLength: requestedLengthValue || null,
      requestedLengthUnit,
      lengthDeficit,
      headingOutline: buildHeadingOutline(content)
    },
    sectionPurposeSignal: buildSectionPurposeSignal(content, {
      active: hasLengthGap || hasStructureGap,
      hasLengthGap,
      hasStructureGap
    }),
    structure: structure ? {
      issueCodes: readStringArray(structure.issueCodes).slice(0, 8),
      reason: readString(structure.reason) || null,
      status: readString(structure.status) || "unknown",
      repeatedHeadingSamples: normalizeStructureSamples(structure.repeatedHeadingSamples, "heading"),
      repeatedNumberSamples: normalizeStructureSamples(structure.repeatedNumberSamples, "number"),
      repeatedHeadingContexts: normalizeStructureContexts(structure.repeatedHeadingContexts, "heading"),
      repeatedNumberContexts: normalizeStructureContexts(structure.repeatedNumberContexts, "number"),
      semanticDuplicateHeadingContexts: normalizeSemanticDuplicateHeadingContexts$1(structure.semanticDuplicateHeadingContexts),
      bodyAfterFinalSectionContexts: normalizeBodyAfterFinalSectionContexts$1(structure.bodyAfterFinalSectionContexts),
      sectionNumberRepairHints: normalizeSectionNumberRepairHints(structure.sectionNumberRepairHints),
      sectionSequenceRepairHints: normalizeSectionNumberRepairHints(structure.sectionSequenceRepairHints)
    } : null,
    citation: hasCitationGap ? {
      issueCodes: readStringArray(source.issueCodes).slice(0, 8),
      issues: Array.isArray(source.citationIssues)
        ? source.citationIssues.map((issue) => ({
            code: readString(issue.code),
            qualityReason: readString(issue.qualityReason) || null,
            qualityTier: readString(issue.qualityTier) || null,
            url: readString(issue.url)
          })).filter((issue) => issue.code && issue.url).slice(0, 8)
        : [],
      unreadCitedUrls: readStringArray(source.unreadCitedUrls).slice(0, 8),
      blockedCitedUrls: readStringArray(source.blockedCitedUrls).slice(0, 8)
    } : null,
    sourceSummary,
    recommendedActionOrder: buildWorkspaceRepairRecommendedActions({
      allowedActions: actions,
      forbiddenActions: Array.from(forbiddenByWorkspaceMutationGrowth),
      fullRewriteAllowed,
      hasCitationGap,
      hasLengthGap,
      hasStructureGap,
      mustInspectCandidate,
      structureIssueCodes: structure && structure.issueCodes
    })
  };
}

function readRequestedLengthForWorkspaceRepair(runState) {
  const packet = readAcceptancePacket(runState);
  const requested = packet && packet.requestedLength && typeof packet.requestedLength === "object"
    ? packet.requestedLength
    : null;
  const value = readNumber(requested && requested.value);
  if (!value) return null;
  const unit = readString(requested && requested.unit) || "words";
  const statsKey = readString(requested && requested.statsKey) ||
    (unit === "words" ? "words" : unit === "cjk_chars" ? "cjkChars" : "chars");
  return {
    statsKey,
    unit,
    value
  };
}

function mergeWorkspaceStructureFacts(primary, inspected) {
  const first = readRecord(primary);
  const second = readRecord(inspected);
  if (!first) return second;
  if (!second) return first;
  return {
    ...second,
    ...first,
    issueCodes: readStringArray(first.issueCodes).length > 0 ? first.issueCodes : second.issueCodes,
    repeatedHeadingContexts: Array.isArray(first.repeatedHeadingContexts) && first.repeatedHeadingContexts.length > 0
      ? first.repeatedHeadingContexts
      : second.repeatedHeadingContexts,
    repeatedHeadingSamples: Array.isArray(first.repeatedHeadingSamples) && first.repeatedHeadingSamples.length > 0
      ? first.repeatedHeadingSamples
      : second.repeatedHeadingSamples,
    repeatedNumberContexts: Array.isArray(first.repeatedNumberContexts) && first.repeatedNumberContexts.length > 0
      ? first.repeatedNumberContexts
      : second.repeatedNumberContexts,
    repeatedNumberSamples: Array.isArray(first.repeatedNumberSamples) && first.repeatedNumberSamples.length > 0
      ? first.repeatedNumberSamples
      : second.repeatedNumberSamples,
    semanticDuplicateHeadingContexts: Array.isArray(first.semanticDuplicateHeadingContexts) && first.semanticDuplicateHeadingContexts.length > 0
      ? first.semanticDuplicateHeadingContexts
      : second.semanticDuplicateHeadingContexts,
    bodyAfterFinalSectionContexts: Array.isArray(first.bodyAfterFinalSectionContexts) && first.bodyAfterFinalSectionContexts.length > 0
      ? first.bodyAfterFinalSectionContexts
      : second.bodyAfterFinalSectionContexts,
    sectionNumberRepairHints: Array.isArray(first.sectionNumberRepairHints) && first.sectionNumberRepairHints.length > 0
      ? first.sectionNumberRepairHints
      : second.sectionNumberRepairHints,
    sectionSequenceRepairHints: Array.isArray(first.sectionSequenceRepairHints) && first.sectionSequenceRepairHints.length > 0
      ? first.sectionSequenceRepairHints
      : second.sectionSequenceRepairHints
  };
}

function normalizeSemanticDuplicateHeadingContexts$1(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = readRecord(entry);
      const first = readRecord(source && source.first);
      const second = readRecord(source && source.second);
      const firstRaw = readString(first && first.raw);
      const secondRaw = readString(second && second.raw);
      if (!firstRaw || !secondRaw) return null;
      return {
        first: { lineNumber: readNumber(first && first.lineNumber), raw: firstRaw.slice(0, 160) },
        relation: readString(source && source.relation) || "similar",
        second: { lineNumber: readNumber(second && second.lineNumber), raw: secondRaw.slice(0, 160) }
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeBodyAfterFinalSectionContexts$1(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = readRecord(entry);
      const raw = readString(source && source.raw);
      if (!raw) return null;
      return {
        lineNumber: readNumber(source && source.lineNumber),
        raw: raw.slice(0, 160)
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildWorkspaceRepairSourceSummary(runState, observableDeficits) {
  const context = readRecord(runState && runState.researchContext);
  const readSources = Array.isArray(context && context.readSources) ? context.readSources : [];
  const source = observableDeficitsRecord(observableDeficits, "source");
  const packet = readAcceptancePacket(runState);
  const sourceMinimum = readSourceMinimum(runState, packet);
  return {
    readSources: source ? readNumber(source.readSources) : Math.max(readNumber(sourceMinimum && sourceMinimum.readSources), readSources.length),
    relevantSources: source ? readNumber(source.relevantSources) : readNumber(sourceMinimum && sourceMinimum.relevantSources),
    minReadSources: source ? readNumber(source.minReadSources) : readNumber(sourceMinimum && sourceMinimum.minReadSources),
    minRelevantSources: source ? readNumber(source.minRelevantSources) : readNumber(sourceMinimum && sourceMinimum.minRelevantSources),
    successfulReadUrlCount: source ? readNumber(source.successfulReadUrlCount) : countSuccessfulReadUrlArtifacts(runState),
    samples: readSources
      .map((entry) => {
        const item = readRecord(entry);
        if (!item) return null;
        const title = readString(item.title) || readString(item.name) || readString(item.url);
        return title ? {
          title: title.slice(0, 120),
          url: readString(item.url).slice(0, 200) || null
        } : null;
      })
      .filter(Boolean)
      .slice(0, 5)
  };
}

function buildWorkspaceRepairRecommendedActions(options = {}) {
  const allowed = new Set(readStringArray(options.allowedActions));
  const forbidden = new Set(readStringArray(options.forbiddenActions));
  const recommended = [];
  const add = (actionName) => {
    if (forbidden.has(actionName)) return;
    if (allowed.has(actionName) && !recommended.includes(actionName)) recommended.push(actionName);
  };
  const contentStructureRepair = options.hasStructureGap &&
    options.fullRewriteAllowed &&
    hasContentStructureRepairIssue(options.structureIssueCodes);
  if (options.mustInspectCandidate) add(WORKSPACE_READ_ACTION);
  add(WORKSPACE_REVIEW_CANDIDATE_ACTION);
  if (options.hasCitationGap) {
    add(READ_URL_ACTION);
  }
  if (contentStructureRepair) {
    add(WORKSPACE_REPLACE_ACTION);
    add(WORKSPACE_WRITE_ACTION);
  }
  if (options.hasCitationGap) {
    add(WORKSPACE_PROPOSE_PATCH_ACTION);
    add(WORKSPACE_APPLY_PATCH_ACTION);
    add(WORKSPACE_MULTI_EDIT_ACTION);
    add(WORKSPACE_REPLACE_ACTION);
  }
  if (options.hasStructureGap && !contentStructureRepair) {
    add(WORKSPACE_PROPOSE_PATCH_ACTION);
    add(WORKSPACE_APPLY_PATCH_ACTION);
  }
  if (options.hasLengthGap) {
    add(WORKSPACE_INSERT_AFTER_SECTION_ACTION);
    add(WORKSPACE_MULTI_EDIT_ACTION);
  }
  if (options.fullRewriteAllowed) {
    add(WORKSPACE_REPLACE_ACTION);
    add(WORKSPACE_WRITE_ACTION);
  }
  add(FINALIZE_CANDIDATE_ACTION);
  add(PUBLISH_DIRECT_ACTION);
  return recommended.slice(0, 10);
}

function hasContentStructureRepairIssue(issueCodes) {
  const codes = new Set(readStringArray(issueCodes));
  return codes.has("semantic_duplicate_headings") ||
    codes.has("body_after_final_section");
}

function buildHeadingOutline(content) {
  const lines = readString(content).split(/\r?\n/);
  const outline = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] || "";
    const match = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const text = readString(match[2]);
    const numberMatch = text.match(/^(\d+(?:\.\d+)*)\b/);
    outline.push({
      level: match[1].length,
      lineNumber: index + 1,
      number: numberMatch ? numberMatch[1] : null,
      text: text.slice(0, 160)
    });
    if (outline.length >= 24) break;
  }
  return outline;
}

function buildSectionPurposeSignal(content, options = {}) {
  const outline = buildHeadingOutline(content);
  if (!options.active && outline.length < 2) return null;
  const nearDuplicateHeadingPairs = detectNearDuplicateHeadingPurposes(outline);
  if (nearDuplicateHeadingPairs.length === 0 && !options.hasLengthGap && !options.hasStructureGap) return null;
  return {
    kind: "section_purpose_signal",
    status: nearDuplicateHeadingPairs.length > 0 ? "near_duplicate_risk" : "ok",
    nearDuplicateHeadingPairs,
    guidance: nearDuplicateHeadingPairs.length > 0
      ? "Do not expand by adding renamed duplicate sections. Merge or replace duplicate-purpose sections, then deepen existing thin or missing required sections."
      : "When expanding for length, deepen existing thin sections and missing required purposes. Do not add renamed duplicate sections to inflate length."
  };
}

function detectNearDuplicateHeadingPurposes(outline) {
  const headings = (Array.isArray(outline) ? outline : [])
    .map((entry) => {
      const text = readString(entry && entry.text);
      const tokens = normalizeHeadingPurposeTokens(text);
      return text && tokens.length > 0 ? {
        lineNumber: readNumber(entry && entry.lineNumber),
        text,
        tokens
      } : null;
    })
    .filter(Boolean);
  const pairs = [];
  for (let i = 0; i < headings.length; i += 1) {
    for (let j = i + 1; j < headings.length; j += 1) {
      const score = headingPurposeSimilarity(headings[i].tokens, headings[j].tokens);
      if (score < 0.72) continue;
      pairs.push({
        first: { lineNumber: headings[i].lineNumber, text: headings[i].text },
        second: { lineNumber: headings[j].lineNumber, text: headings[j].text },
        similarity: Number(score.toFixed(2))
      });
      if (pairs.length >= 6) return pairs;
    }
  }
  return pairs;
}

const HEADING_PURPOSE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "how", "in",
  "into", "is", "of", "on", "or", "the", "to", "with",
  "advanced", "additional", "appendix", "deep", "deeper", "extended",
  "extra", "further", "more", "section"
]);

function normalizeHeadingPurposeTokens(text) {
  const normalized = readString(text)
    .toLowerCase()
    .replace(/^#+\s*/, "")
    .replace(/^\d+(?:\.\d+)*[\s.)-]*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return [];
  return Array.from(new Set(normalized
    .split(/\s+/)
    .map((token) => token.endsWith("ies") && token.length > 4
      ? `${token.slice(0, -3)}y`
      : token.endsWith("s") && token.length > 4
        ? token.slice(0, -1)
        : token)
    .filter((token) => token.length > 1 && !HEADING_PURPOSE_STOPWORDS.has(token))
  )).slice(0, 8);
}

function headingPurposeSimilarity(firstTokens, secondTokens) {
  const first = new Set(Array.isArray(firstTokens) ? firstTokens : []);
  const second = new Set(Array.isArray(secondTokens) ? secondTokens : []);
  if (first.size === 0 || second.size === 0) return 0;
  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }
  const minSize = Math.min(first.size, second.size);
  const maxSize = Math.max(first.size, second.size);
  const containment = minSize > 0 ? intersection / minSize : 0;
  const balance = maxSize > 0 ? minSize / maxSize : 0;
  return containment >= 0.8 ? containment * balance : intersection / (first.size + second.size - intersection);
}

function buildAdvisoryPersistenceSignal(ignoredCount, escalation, thresholds = DEFAULT_TERMINAL_REPAIR_THRESHOLDS) {
  const count = readNumber(ignoredCount);
  if (readString(escalation) !== "advisory") return null;
  if (count < thresholds.advisorySignal) return null;
  return {
    kind: "terminal_repair_advisory_persistence_signal",
    ignoredCount: count,
    vetoThreshold: thresholds.highWaterMark,
    stepsRemainingBeforeHardVeto: Math.max(thresholds.highWaterMark - count, 0),
    // Set by evaluateTerminalRepairState from the previous-cycle signal presence.
    // Defaults false; the dispatch paths only emit when it is true.
    advisoryThresholdFirstCrossed: false
  };
}

function buildActionOrderingSignals(runState, observableDeficits, budgetState, activeDeficits, allowedActions) {
  const signals = [];
  if (shouldRequireWorkspaceRepairInspection({
    activeDeficits,
    allowedActions,
    observableDeficits,
    runState
  })) {
    signals.push({
      kind: "workspace_repair_inspection_nudge",
      preferredActions: [WORKSPACE_READ_ACTION],
      reason: "candidate_not_read_after_latest_content_change",
      workspaceWriteCount: countWorkspaceWriteOperations(runState)
    });
  }
  const todoSignal = buildTodoSyncNotSufficientSignal(observableDeficits, activeDeficits, allowedActions, runState);
  if (todoSignal) signals.push(todoSignal);
  if (!shouldSurfaceMultiWriteIterationNudge({
    activeDeficits,
    budgetState,
    observableDeficits,
    runState
  })) {
    return signals;
  }
  const actions = readStringArray(allowedActions);
  const preferredActions = [
    WORKSPACE_INSERT_AFTER_SECTION_ACTION,
    WORKSPACE_MULTI_EDIT_ACTION,
    WORKSPACE_WRITE_ACTION
  ].filter((actionName) => actions.includes(actionName));
  signals.push({
    kind: "multi_write_iteration_nudge",
    preferredActions,
    reason: "length_deficit_with_budget_remaining_and_few_workspace_writes",
    workspaceWriteCount: countWorkspaceWriteOperations(runState)
  });
  return signals;
}

function buildTodoSyncNotSufficientSignal(observableDeficits, activeDeficits, allowedActions, runState) {
  const active = Array.isArray(activeDeficits) ? activeDeficits : [];
  if (!active.includes("todo")) return null;
  const hasProductDeficit = Boolean(observableDeficitsRecord(observableDeficits, "length")) ||
    Boolean(observableDeficitsRecord(observableDeficits, "source")) ||
    Boolean(observableDeficitsRecord(observableDeficits, "structure")) ||
    Boolean(observableDeficitsRecord(observableDeficits, "readiness")) ||
    active.some((name) => name === "source" || name === "structure" || name === "readiness" || name === "terminal_loop");
  if (!hasProductDeficit) return null;
  const todoActions = new Set([TODO_ADVANCE_ACTION, TODO_RUN_NEXT_ACTION, TODO_CANCEL_ACTION]);
  const actions = readStringArray(allowedActions);
  const preferredActions = [
    READ_URL_ACTION,
    WORKSPACE_READ_ACTION,
    WORKSPACE_REVIEW_CANDIDATE_ACTION,
    WORKSPACE_PROPOSE_PATCH_ACTION,
    WORKSPACE_APPLY_PATCH_ACTION,
    WORKSPACE_INSERT_AFTER_SECTION_ACTION,
    WORKSPACE_MULTI_EDIT_ACTION,
    WORKSPACE_REPLACE_ACTION,
    WORKSPACE_WRITE_ACTION
  ].filter((actionName) => actions.includes(actionName) && !todoActions.has(actionName));
  return {
    kind: "todo_sync_not_sufficient",
    preferredActions,
    reason: "todo_state_sync_does_not_repair_source_length_structure_or_readiness_deficits",
    workspaceWriteCount: countWorkspaceWriteOperations(runState)
  };
}

function buildPerSectionLengthDeltas(content, options = {}) {
  const text = readString(content);
  if (!text) return [];
  const requested = readNumber(options.requested);
  if (!requested) return [];
  const unit = readString(options.unit) || "words";
  const sections = splitMarkdownSections(text);
  if (sections.length === 0) return [];
  const target = Math.ceil(requested / sections.length);
  return sections.map((section) => {
    const stats = summarizeTextStats(section.content);
    const observed = readNumber(stats[unit]);
    return {
      heading: section.heading.slice(0, 120),
      observed,
      target,
      gap: Math.max(target - observed, 0)
    };
  }).slice(0, 8);
}

function splitMarkdownSections(text) {
  const lines = readString(text).split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        heading: headingMatch[2],
        content: ""
      };
      continue;
    }
    if (current) {
      current.content += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections;
}

function averagePositiveGap(perSectionDelta, fallbackGap) {
  const gaps = (Array.isArray(perSectionDelta) ? perSectionDelta : [])
    .map((entry) => readNumber(entry && entry.gap))
    .filter((gap) => gap > 0);
  if (gaps.length === 0) return readNumber(fallbackGap);
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
}

function readFinalCandidateContent$1(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const finalPath = readFinalCandidatePathFromWorkspace(runState);
  const files = workspace && workspace.files && typeof workspace.files === "object"
    ? workspace.files
    : null;
  const file = files && finalPath ? files[finalPath] : null;
  return readString(file && file.content);
}

function countWorkspaceWriteOperations(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const operations = Array.isArray(workspace && workspace.operations) ? workspace.operations : [];
  return operations.filter((operation) => readString(operation && operation.action) === "write").length;
}

function countWorkspaceExpansionIterations(runState) {
  const workspace = readRecord(runState && runState.virtualWorkspace);
  const operations = Array.isArray(workspace && workspace.operations) ? workspace.operations : [];
  const expansionActions = new Set([
    "apply_patch",
    "insert_after_section",
    "multi_edit",
    "replace",
    "write"
  ]);
  return operations.filter((operation) => expansionActions.has(readString(operation && operation.action))).length;
}

function shouldRequireWorkspaceRepairInspection(options = {}) {
  const actions = readStringArray(options.allowedActions);
  const hasRepairMutation = actions.some((actionName) => (
    actionName === WORKSPACE_APPLY_PATCH_ACTION ||
    actionName === WORKSPACE_INSERT_AFTER_SECTION_ACTION ||
    actionName === WORKSPACE_MULTI_EDIT_ACTION ||
    actionName === WORKSPACE_PROPOSE_PATCH_ACTION ||
    actionName === WORKSPACE_REPLACE_ACTION ||
    actionName === WORKSPACE_WRITE_ACTION
  ));
  if (!hasRepairMutation) return false;
  const hasCandidate = hasSelectedFinalCandidateContent(options.runState);
  if (!hasCandidate) return false;
  const protocol = readCurrentPublishProtocol(options.runState);
  if (!protocol) return false;
  if (protocol.readAfterLatestContentChange === true) return false;
  const hasObservableRepairFact = Boolean(observableDeficitsRecord(options.observableDeficits, "length")) ||
    Boolean(observableDeficitsRecord(options.observableDeficits, "structure"));
  const activeDeficits = Array.isArray(options.activeDeficits) ? options.activeDeficits : [];
  return hasObservableRepairFact || activeDeficits.includes("terminal_loop") || activeDeficits.includes("readiness");
}

function shouldSurfaceMultiWriteIterationNudge(options = {}) {
  const budgetState = readString(options.budgetState);
  if (budgetState === "exhausted") return false;
  const activeDeficits = Array.isArray(options.activeDeficits) ? options.activeDeficits : [];
  if (activeDeficits.includes("source")) return false;
  const length = observableDeficitsRecord(options.observableDeficits, "length");
  if (!length) return false;
  const observed = readNumber(length.observed);
  const requested = readNumber(length.requested);
  if (!requested || observed >= requested) return false;
  return countWorkspaceWriteOperations(options.runState) < 3;
}

export { averagePositiveGap, buildActionOrderingSignals, buildAdvisoryPersistenceSignal, buildHeadingOutline, buildLengthExpansionSignal, buildPerSectionLengthDeltas, buildSectionPurposeSignal, buildTodoSyncNotSufficientSignal, buildWorkspaceRepairRecommendedActions, buildWorkspaceRepairSignal, buildWorkspaceRepairSourceSummary, countWorkspaceExpansionIterations, countWorkspaceWriteOperations, detectNearDuplicateHeadingPurposes, headingPurposeSimilarity, mergeWorkspaceStructureFacts, normalizeBodyAfterFinalSectionContexts$1 as normalizeBodyAfterFinalSectionContexts, normalizeHeadingPurposeTokens, normalizeSemanticDuplicateHeadingContexts$1 as normalizeSemanticDuplicateHeadingContexts, readFinalCandidateContent$1 as readFinalCandidateContent, shouldRequireWorkspaceRepairInspection, shouldSurfaceMultiWriteIterationNudge, splitMarkdownSections };
