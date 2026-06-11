import { classifyReadSourceTier, explainReadSourceQuality } from './read-source-quality.js';
import { isEvidenceConvergenceRun } from './convergence-activation.js';

// AGRUN-313 P2c — the hardcoded LONG_RESEARCH_SKILL_IDS name list is removed.
// The kernel activates the evidence-convergence gate from the generic
// `requiresEvidenceConvergence` capability declared on the engaged skill, not
// from a skill name. (A second name list still exists in planner-prompt.js and
// is removed in P2e; the kernel is not yet fully name-free.)
const DEFAULT_MAX_QUALITY_VETOES = 2;
const MIN_RELEVANT_SOURCES = 2;

function refreshResearchState(runState, options = {}) {
  if (!runState || typeof runState !== "object") {
    return createResearchState();
  }

  const previous = runState.researchState && typeof runState.researchState === "object"
    ? runState.researchState
    : {};
  const recoveryMode = detectContinuedResearchThread(runState, options)
    ? "continued_research_thread"
    : null;
  const required = isEvidenceConvergenceRun(runState, options);
  const topic = extractResearchTopic(runState, options);
  const readSources = Array.isArray(runState.researchContext && runState.researchContext.readSources)
    ? runState.researchContext.readSources
    : [];
  const searchResults = collectSearchResults(runState);
  const sourceQuality = summarizeSourceQuality(readSources);
  const gaps = required
    ? detectEvidenceGaps({ readSources, searchResults, sourceQuality })
    : [];
  const finalAllowed = !required || gaps.length === 0;
  const previousPhase = readString$1y(previous.phase);
  const phase = readString$1y(options.phase)
    || (finalAllowed ? "ready_to_finalize" : inferResearchPhase({ readSources, searchResults, previousPhase }));
  const finalReason = finalAllowed
    ? (required ? "evidence_quality_gate_passed" : "evidence_convergence_inactive")
    : `evidence_gaps:${gaps.join(",")}`;

  runState.researchState = {
    finalAllowed,
    finalReason,
    gaps,
    iteration: Number.isInteger(previous.iteration) && previous.iteration >= 0
      ? previous.iteration
      : 0,
    maxQualityVetoes: readPositiveInteger$i(previous.maxQualityVetoes) || DEFAULT_MAX_QUALITY_VETOES,
    phase,
    qualityGateRequired: required,
    questions: Array.isArray(previous.questions) ? previous.questions.slice(0, 12) : [],
    queries: collectQueries(runState),
    recoveryMode,
    sourceQuality,
    topic,
    vetoCount: Number.isInteger(previous.vetoCount) && previous.vetoCount >= 0
      ? previous.vetoCount
      : 0
  };
  runState.researchWorkspace = createResearchWorkspace(runState, options);

  return runState.researchState;
}

// 2026-05-09 — `maybeCreateResearchQualityVeto` deleted. Function was a
// phantom (no production caller, only unit tests imported it) but its
// shape was the most explicit push-mode site I have seen in this
// codebase: returned `{ continue: true, decision: { type:
// "planner_guidance", name: "research_evidence_gap_next_step", args: {
// guidance: "Choose the next research action ... Use web_search ... Use
// read_url ... Do not repeat attemptedQueries ..." }}}` — runtime
// authored a synthetic decision AND a hardcoded English directive
// telling AI exactly what to do next. Same anti-pattern as the deleted
// `notePlanValidationFailure` loop-breaker, the deleted
// `stripSynthesizePerActionIfSafe` auto-strip, and the deleted
// `maybeCreateResearchReportLoopVeto` (action-loop-session-terminals
// callsite). Deletion completes the zero-residual push-mode invariant
// for the research/finalize path.

function createResearchWorkspace(runState, options = {}) {
  const state = runState && runState.researchState && typeof runState.researchState === "object"
    ? runState.researchState
    : createResearchState();
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const recoveryMode = readString$1y(options && options.recoveryMode)
    || readString$1y(state.recoveryMode);
  const prompt = recoveryMode === "continued_research_thread"
    ? readString$1y(runState && runState.threadGoalAnchorText)
      || readString$1y(runState && runState.contextSnapshot && runState.contextSnapshot.inquiryContext && runState.contextSnapshot.inquiryContext.activeGoal)
      || readString$1y(runState && runState.originalQuery)
      || readString$1y(options && options.prompt)
      || readString$1y(runState && runState.observationSummary && runState.observationSummary.prompt)
    : readString$1y(options && options.prompt)
      || readString$1y(runState && runState.originalQuery)
      || readString$1y(runState && runState.observationSummary && runState.observationSummary.prompt);
  const topic = readString$1y(state.topic) || extractResearchTopic(runState, options);
  const queries = Array.isArray(state.queries) && state.queries.length > 0
    ? state.queries
    : collectQueries(runState);
  const searchLog = collectSearchLog(context);
  const sourceNotes = collectSourceNotes(context);
  const gaps = Array.isArray(state.gaps) ? state.gaps.map(readString$1y).filter(Boolean) : [];
  const reportLoop = runState && runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};

  return {
    brief: {
      goal: prompt || topic,
      reportShape: "source-backed final report with limitations and Sources",
      topic
    },
    draft: {
      outline: createDraftOutline(topic),
      status: state.finalAllowed === true ? "ready_for_finalizer" : "not_ready",
      synthesisNotes: createSynthesisNotes({ gaps, sourceNotes, state })
    },
    evidenceTable: sourceNotes.map((note, index) => ({
      id: `source-${index + 1}`,
      quality: note.quality,
      status: note.status,
      title: note.title,
      url: note.url
    })),
    claimEvidence: Array.isArray(reportLoop.claimEvidence) ? reportLoop.claimEvidence.slice(0, 12) : [],
    finalReadiness: {
      allowed: state.finalAllowed === true,
      reason: readString$1y(state.finalReason) || "n/a",
      remainingGaps: gaps
    },
    gaps,
    plan: {
      questions: createResearchQuestions(topic),
      searchStrategy: "start broad, read promising sources, then retry for official or primary sources when evidence is weak"
    },
    progress: {
      phase: readString$1y(state.phase) || "idle",
      qualityGateRequired: state.qualityGateRequired === true,
      vetoCount: Number.isInteger(state.vetoCount) && state.vetoCount >= 0 ? state.vetoCount : 0
    },
    reportLoop: reportLoop && readString$1y(reportLoop.status) ? {
      finalMode: readString$1y(reportLoop.finalMode) || null,
      sourceMinimum: reportLoop.sourceMinimum && typeof reportLoop.sourceMinimum === "object" ? reportLoop.sourceMinimum : null,
      status: readString$1y(reportLoop.status),
      vetoCount: Number.isInteger(reportLoop.vetoCount) && reportLoop.vetoCount >= 0 ? reportLoop.vetoCount : 0
    } : null,
    queries,
    searchLog,
    sourceNotes,
    timeline: createWorkspaceTimeline({ searchLog, sourceNotes, state })
  };
}

function createResearchState() {
  return {
    finalAllowed: true,
    finalReason: "not_started",
    gaps: [],
    iteration: 0,
    maxQualityVetoes: DEFAULT_MAX_QUALITY_VETOES,
    phase: "idle",
    qualityGateRequired: false,
    questions: [],
    queries: [],
    recoveryMode: null,
    sourceQuality: {
      blocked: 0,
      medium: 0,
      rejected: 0,
      strong: 0,
      thin: 0,
      total: 0,
      weak: 0
    },
    topic: "",
    vetoCount: 0
  };
}

function createEmptyResearchWorkspace() {
  return {
    brief: {
      goal: "",
      reportShape: "source-backed final report with limitations and Sources",
      topic: ""
    },
    draft: {
      outline: [],
      status: "not_started",
      synthesisNotes: []
    },
    evidenceTable: [],
    claimEvidence: [],
    finalReadiness: {
      allowed: true,
      reason: "not_started",
      remainingGaps: []
    },
    gaps: [],
    plan: {
      questions: [],
      searchStrategy: ""
    },
    progress: {
      phase: "idle",
      qualityGateRequired: false,
      vetoCount: 0
    },
    reportLoop: null,
    queries: [],
    searchLog: [],
    sourceNotes: [],
    timeline: []
  };
}


// AGRUN-246-E/J — fact-based, NO prompt regex. The runtime exposes the
// FACT that this turn continues a research thread already carrying
// evidence; the AI's planner owns the finalize-vs-more-research choice
// by picking its next action (finalize/final_answer vs web_search/read_url).
//
// What was deleted: three English-only regex helpers
// (`hasFinalizeExistingEvidenceIntent` / `hasExplicitMoreResearchIntent`
// /`hasExplicitNewTopicIntent`) that scanned the follow-up prompt to
// decide "user wants finalize" and armed a force-finalize bypass
// (`maybeCreateFinalizeOnlyResearchRecoveryFinal` in
// action-loop-session-loop.js, also deleted). That was push-mode disguised
// as recovery: runtime classified intent before the AI saw the prompt, then
// finalized for it. Per the 2026-05-23 non-ai-first audit §C2 + the
// ai-first-push-deletion contract, intent classification belongs to the AI.
//
// The remaining signal is a fact only: existing artifacts + a continued
// thread (follow-up turn or a stable cross-turn topic) + not a declared new
// topic. It re-keys the workspace topic/goal source to the thread anchor and
// is surfaced read-only to the planner; it never forces an action.
function detectContinuedResearchThread(runState, options = {}) {
  if (!hasExistingResearchArtifacts(runState)) return false;
  if (isNewResearchTopicTurn(runState, options)) return false;
  return isFollowUpTurn(runState, options) || Boolean(readStableResearchTopic(runState, options));
}

function readStableResearchTopic(runState, options = {}) {
  const candidates = [
    runState && runState.researchState && runState.researchState.topic,
    runState && runState.researchEvidenceGraph && runState.researchEvidenceGraph.topic,
    runState && runState.researchWorkspace && runState.researchWorkspace.brief && runState.researchWorkspace.brief.topic,
    // AGRUN-214m — thread-scope research slice carries the canonical
    // topic across turns. Read it before the run-scope originalQuery
    // fallback so a finalize-only follow-up does not re-extract from
    // the recovery prompt.
    runState && runState.researchThreadSlice && runState.researchThreadSlice.topic,
    runState && runState.contextSnapshot && runState.contextSnapshot.inquiryContext && runState.contextSnapshot.inquiryContext.activeTopic,
    extractTopicFromPrompt(readString$1y(runState && runState.threadGoalAnchorText)),
    extractTopicFromPrompt(readString$1y(runState && runState.contextSnapshot && runState.contextSnapshot.inquiryContext && runState.contextSnapshot.inquiryContext.activeGoal)),
    runState && runState.turnState && runState.turnState.topicAnchorText,
    runState && runState.inputResolution && runState.inputResolution.intentState && runState.inputResolution.intentState.topic,
    extractTopicFromPrompt(readString$1y(runState && runState.originalQuery)),
    extractTopicFromPrompt(readString$1y(runState && runState.observationSummary && runState.observationSummary.prompt)),
    runState && runState.researchReportLoop && runState.researchReportLoop.lastTopic
  ];
  for (const candidate of candidates) {
    const topic = readString$1y(candidate);
    if (isUsableStableTopic(topic, options)) return topic;
  }
  return "";
}

function detectEvidenceGaps({ readSources, searchResults, sourceQuality }) {
  const gaps = [];
  const relevant = sourceQuality.strong + sourceQuality.medium;
  if (searchResults.length === 0) gaps.push("no_search_results");
  if (readSources.length === 0) gaps.push("no_read_sources");
  if (relevant < MIN_RELEVANT_SOURCES) gaps.push("insufficient_relevant_sources");
  if (sourceQuality.strong < 1 && sourceQuality.medium < MIN_RELEVANT_SOURCES) gaps.push("no_strong_source");
  if (readSources.length > 0 && relevant === 0) gaps.push("weak_sources_only");
  return Array.from(new Set(gaps));
}

function summarizeSourceQuality(readSources) {
  const summary = {
    blocked: 0,
    medium: 0,
    rejected: 0,
    strong: 0,
    thin: 0,
    total: 0,
    weak: 0
  };

  for (const source of readSources) {
    const tier = classifyReadSourceTier(source);
    summary.total += 1;
    if (tier === "strong") {
      summary.strong += 1;
    } else if (tier === "usable") {
      summary.medium += 1;
    } else if (tier === "weak") {
      summary.weak += 1;
    } else if (tier === "thin") {
      summary.thin += 1;
    } else if (tier === "blocked") {
      summary.blocked += 1;
      summary.rejected += 1;
    }
  }

  return summary;
}

function collectSearchLog(context) {
  const passes = Array.isArray(context && context.searchPasses) ? context.searchPasses : [];
  return passes.slice(-8).map((pass, index) => {
    const items = Array.isArray(pass && pass.items)
      ? pass.items
      : Array.isArray(pass && pass.results)
        ? pass.results
        : Array.isArray(pass && pass.rankedItems)
          ? pass.rankedItems
          : [];
    return {
      id: `search-${index + 1}`,
      query: readString$1y(pass && (pass.query || pass.lastExecutedQuery)) || "n/a",
      resultCount: items.length,
      strategy: readString$1y(pass && pass.strategy) || readString$1y(pass && pass.kind) || "search"
    };
  });
}

function collectSourceNotes(context) {
  const readSources = Array.isArray(context && context.readSources) ? context.readSources : [];
  return readSources.slice(-12).map((source, index) => {
    const qualityDetail = explainReadSourceQuality(source);
    const tier = qualityDetail.tier;
    return {
      id: `read-${index + 1}`,
      ok: source && source.ok !== false,
      quality: tier === "usable" ? "medium" : tier,
      qualityDetail,
      status: source && typeof source.status === "number" ? source.status : null,
      title: readString$1y(source && source.title) || readString$1y(source && source.url) || `Read source ${index + 1}`,
      url: readString$1y(source && source.url)
    };
  });
}

function createDraftOutline(topic) {
  const label = readString$1y(topic) || "the research topic";
  return [
    `What is publicly verifiable about ${label}`,
    "Key supporting evidence",
    "Evidence gaps and limitations",
    "Concise conclusion with Sources"
  ];
}

function createResearchQuestions(topic) {
  const label = readString$1y(topic) || "the topic";
  return [
    `What direct public sources mention ${label}?`,
    `Which sources are primary, official, or otherwise strong for ${label}?`,
    `What claims can be supported without overreaching?`,
    `What evidence gaps must be disclosed in the final report?`
  ];
}

function createSynthesisNotes({ gaps, sourceNotes, state }) {
  const notes = [];
  if (sourceNotes.length === 0) {
    notes.push("No read_url source has been added to the workspace yet.");
  } else {
    notes.push(`${sourceNotes.length} read_url source(s) available for synthesis.`);
  }
  if (gaps.length > 0) {
    notes.push(`Evidence gaps remain: ${gaps.join(", ")}.`);
  }
  if (readString$1y(state.finalReason)) {
    notes.push(`Final readiness reason: ${readString$1y(state.finalReason)}.`);
  }
  return notes;
}

function createWorkspaceTimeline({ searchLog, sourceNotes, state }) {
  const timeline = [];
  if (state.qualityGateRequired === true) {
    timeline.push({
      label: "Research workspace initialized",
      phase: "planning",
      status: "done"
    });
  }
  for (const entry of searchLog) {
    timeline.push({
      label: `Search: ${entry.query}`,
      phase: "searching",
      status: "done"
    });
  }
  for (const entry of sourceNotes) {
    timeline.push({
      label: `Read: ${entry.title}`,
      phase: "reading",
      status: "done"
    });
  }
  if (state.qualityGateRequired === true) {
    timeline.push({
      label: readString$1y(state.finalReason) || "Evidence checked",
      phase: readString$1y(state.phase) || "gap_check",
      status: state.finalAllowed === true ? "done" : "blocked"
    });
  }
  return timeline.slice(-16);
}

function extractResearchTopic(runState, options) {
  if (detectContinuedResearchThread(runState, options)) {
    const stableTopic = readStableResearchTopic(runState, options);
    if (stableTopic) return stableTopic;
  }
  const prompt = readString$1y(options && options.prompt)
    || readString$1y(runState && runState.originalQuery)
    || readString$1y(runState && runState.observationSummary && runState.observationSummary.prompt);
  return extractTopicFromPrompt(prompt);
}

// 2026-05-09 — `extractEntityFromVerbatimPrompt` and
// `looksLikeVerbatimResearchPrompt` deleted (were AGRUN-214o P4).
// Both were hardcoded English regex heuristics that "helped small
// models" by collapsing verbose research prompts down to a guessed
// entity name. They never matched Mandarin / non-English prompts,
// silently rewrote what the planner saw under "Current topic:",
// and were runtime making semantic decisions about user intent —
// push-mode-shaped. AI now sees raw `intentState.topic` /
// `inquiryContext.activeTopic` (or `researchState.topic` when AI
// has populated it via tool calls). Hosts using lite-tier models
// against verbose research prompts should configure model selection
// or compress prompts at the application layer, not in runtime.

function extractTopicFromPrompt(prompt) {
  // ADR-0017 — language-neutral topic extraction. Two structural
  // cues survive: `topic: "..."` keyword (any-language quote chars)
  // and any quoted phrase. Fallback truncates the prompt to 160
  // chars without English-specific filler stripping.
  const topicPhrase = prompt.match(/\btopic\s*[:=]?\s*["'“”‘’`]([^"'“”‘’`]{2,160})["'“”‘’`]/i);
  if (topicPhrase) return topicPhrase[1].trim();
  const quoted = prompt.match(/["'“”‘’`]([^"'“”‘’`]{2,120})["'“”‘’`]/);
  if (quoted) return quoted[1].trim();
  return prompt.trim().slice(0, 160);
}

function hasExistingResearchArtifacts(runState) {
  if (!runState || typeof runState !== "object") return false;
  const context = runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  if (Array.isArray(context.readSources) && context.readSources.length > 0) return true;
  if (Array.isArray(context.searchPasses) && context.searchPasses.length > 0) return true;
  if (Array.isArray(context.aggregatedSearchResults) && context.aggregatedSearchResults.length > 0) return true;
  const workspace = runState.virtualWorkspace && typeof runState.virtualWorkspace === "object"
    ? runState.virtualWorkspace
    : {};
  const files = workspace.files && typeof workspace.files === "object" ? workspace.files : {};
  if (Object.values(files).some((file) => file && typeof file === "object" && readString$1y(file.content))) return true;
  const graph = runState.researchEvidenceGraph && typeof runState.researchEvidenceGraph === "object"
    ? runState.researchEvidenceGraph
    : {};
  if (Array.isArray(graph.sourceArtifacts) && graph.sourceArtifacts.length > 0) return true;
  if (Array.isArray(graph.observations) && graph.observations.length > 0) return true;
  const researchWorkspace = runState.researchWorkspace && typeof runState.researchWorkspace === "object"
    ? runState.researchWorkspace
    : {};
  if (readString$1y(researchWorkspace.brief && researchWorkspace.brief.topic)) return true;
  const loop = runState.researchReportLoop && typeof runState.researchReportLoop === "object"
    ? runState.researchReportLoop
    : {};
  if (loop.enabled === true || Boolean(readString$1y(loop.status) && readString$1y(loop.status) !== "idle")) return true;
  // AGRUN-214m — a hydrated thread research slice (topic + evidence
  // from a previous turn) counts as existing artefacts even when the
  // current run has not yet touched researchContext.
  const slice = runState.researchThreadSlice && typeof runState.researchThreadSlice === "object"
    ? runState.researchThreadSlice
    : null;
  return Boolean(slice && readString$1y(slice.topic));
}

function isFollowUpTurn(runState, options) {
  const kinds = [
    options && options.turnIntent && options.turnIntent.kind,
    runState && runState.turnState && runState.turnState.turnIntentKind,
    runState && runState.inputResolution && runState.inputResolution.turnIntent && runState.inputResolution.turnIntent.kind,
    runState && runState.contextSnapshot && runState.contextSnapshot.turnIntent && runState.contextSnapshot.turnIntent.kind
  ].map(readString$1y);
  return kinds.includes("follow_up") || kinds.includes("continuation");
}

// AGRUN-246-E/J — fact-based "new topic" signal. Reads only the AI/router-
// declared `turnIntent.kind === "new_task"`; no prompt regex, no stable-vs-
// prompt topic-token comparison. A genuine pivot to a new research topic is
// the turn-intent layer's call (turn-intent-planner.js), not a runtime
// lexical guess.
function isNewResearchTopicTurn(runState, options) {
  const kind = readString$1y(options && options.turnIntent && options.turnIntent.kind)
    || readString$1y(runState && runState.inputResolution && runState.inputResolution.turnIntent && runState.inputResolution.turnIntent.kind)
    || readString$1y(runState && runState.contextSnapshot && runState.contextSnapshot.turnIntent && runState.contextSnapshot.turnIntent.kind)
    || readString$1y(runState && runState.turnState && runState.turnState.turnIntentKind);
  return kind === "new_task";
}

function isUsableStableTopic(topic, options) {
  if (!topic) return false;
  if (options && options.skipPromptTopic && topic === extractTopicFromPrompt(readString$1y(options.prompt))) return false;
  if (/^(?:research topic|n\/a)$/i.test(topic)) return false;
  return true;
}

function collectSearchResults(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const primary = Array.isArray(context.aggregatedSearchResults)
    ? context.aggregatedSearchResults
    : [];
  const fallback = Array.isArray(context.searchResults) ? context.searchResults : [];
  return primary.length > 0 ? primary : fallback;
}

function collectQueries(runState) {
  const context = runState && runState.researchContext && typeof runState.researchContext === "object"
    ? runState.researchContext
    : {};
  const queries = [];
  const push = (value) => {
    const normalized = readString$1y(value);
    if (normalized && !queries.includes(normalized)) queries.push(normalized);
  };
  push(context.lastQuery);
  const passes = Array.isArray(context.searchPasses) ? context.searchPasses : [];
  for (const pass of passes) {
    push(pass && pass.query);
    push(pass && pass.lastExecutedQuery);
  }
  return queries.slice(-8);
}

function inferResearchPhase({ readSources, searchResults, previousPhase }) {
  if (readSources.length > 0) return "evaluating";
  if (searchResults.length > 0) return "reading";
  if (previousPhase) return previousPhase;
  return "planning";
}

function readPositiveInteger$i(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readString$1y(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { createEmptyResearchWorkspace, createResearchState, createResearchWorkspace, detectContinuedResearchThread, readStableResearchTopic, refreshResearchState };
