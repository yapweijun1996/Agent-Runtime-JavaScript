import { stableStringify } from './content.js';
import { summarizeReadSourceForDirection } from './context-snapshot-fields.js';
import { toTargetTokens } from './context-window-policy.js';
import { createCompressedSummaryVariants, estimateStructuredSummaryTokens } from './context-window-summary.js';
import { renderTurns, buildAnchoredRecentTurns } from './context-window-turns.js';
import { readString } from '../runtime/semantic-json.js';

function buildContextWindowPlan(options) {
  const policy = options.policy && options.policy.compaction;
  const inputBudgetTokens = readPositiveInteger$4(options.inputBudgetTokens, 1);
  const charsPerToken = readPositiveInteger$4(options.policy && options.policy.charsPerToken, 4);
  const working = createWorkingContext(options, inputBudgetTokens, charsPerToken);
  let stage = readString(options.stage) || "initial";

  if (options.fitEvaluator(working.sessionContext)) {
    return finalizePlan(working, stage === "initial" ? "fit" : stage, false, options);
  }

  for (const step of policy.degradationOrder) {
    if (step === "other_memory") {
      stage = "drop_other_memory";
      working.sessionContext.memory = "";
      working.droppedSegments.add("other_memory");
      working.degradedFields.add("memory");
    } else if (step === "history") {
      stage = "drop_history";
      working.sessionContext.history = "";
      working.droppedSegments.add("history");
      working.degradedFields.add("history");
    } else if (step === "recent_turns") {
      stage = "trim_recent_turns";
      if (!trimRecentTurns(working, options)) {
        working.droppedSegments.add("recent_turns");
      }
    } else if (step === "summary") {
      stage = "compress_summary";
      if (!compressSummary(working, options, charsPerToken)) {
        working.degradedFields.add("summary");
      }
    }

    if (options.fitEvaluator(working.sessionContext)) {
      return finalizePlan(working, stage, true, options);
    }
  }

  return finalizePlan(working, "error", true, options);
}

function createWorkingContext(options, inputBudgetTokens, charsPerToken) {
  const inquiryContext = options.contextSnapshot && options.contextSnapshot.inquiryContext
    ? options.contextSnapshot.inquiryContext
    : {};
  const sessionMemory = options.contextSnapshot && options.contextSnapshot.sessionMemory
    ? options.contextSnapshot.sessionMemory
    : {};
  const compaction = options.policy.compaction;
  const direction = {
    activeGoal: readString(inquiryContext.activeGoal),
    activeQuery: readString(inquiryContext.activeQuery),
    activeTopic: readString(inquiryContext.activeTopic),
    lastReadSource: cloneNullable$1(inquiryContext.lastReadSource),
    lastResolution: cloneNullable$1(inquiryContext.lastClarificationResolution),
    pendingClarification: cloneNullable$1(inquiryContext.pendingClarification),
    selectedSource: cloneNullable$1(inquiryContext.selectedSource)
  };
  const summaryText = readString(sessionMemory.compactedContext || sessionMemory.summary);
  const memoryItems = Array.isArray(sessionMemory.items) ? sessionMemory.items.slice() : [];
  const confirmedMemory = selectConfirmedMemory(
    memoryItems,
    compaction.tiers.confirmedMemory.itemPriority,
    toTargetTokens(inputBudgetTokens, compaction.tiers.confirmedMemory.maxShare, 0),
    charsPerToken
  );
  const sessionContext = {
    activeQuery: direction.activeQuery,
    clarificationStatus: direction.pendingClarification ? "pending" : "none",
    compactedContext: summaryText,
    currentGoal: direction.activeGoal,
    currentTopic: direction.activeTopic,
    decisions: confirmedMemory.decisions,
    facts: confirmedMemory.facts,
    history: compaction.tiers.history.enabled === true
      ? trimNumberedBlock(readString(sessionMemory.history), toTargetTokens(inputBudgetTokens, compaction.tiers.history.maxShare, 0), charsPerToken)
      : "",
    items: memoryItems,
    lastReadSource: direction.lastReadSource,
    lastResolution: direction.lastResolution,
    memory: trimNumberedBlock(readString(sessionMemory.memory), toTargetTokens(inputBudgetTokens, compaction.tiers.otherMemory.maxShare, 0), charsPerToken),
    openAmbiguity: direction.pendingClarification && typeof direction.pendingClarification.question === "string"
      ? direction.pendingClarification.question
      : "",
    pendingClarification: direction.pendingClarification,
    preferences: confirmedMemory.preferences,
    recentTurns: renderTurns(buildAnchoredRecentTurns(
      options.messages,
      inquiryContext,
      compaction.tiers.recentTurns
    )),
    selectedSource: direction.selectedSource,
    summary: summaryText
  };

  return {
    degradedFields: new Set(),
    droppedSegments: new Set(compaction.tiers.history.enabled === true ? [] : ["history"]),
    inputBudgetTokens,
    sessionContext,
    sessionMemory,
    summaryText
  };
}

function finalizePlan(working, stage, compacted, options) {
  const evaluated = options.evaluate(working.sessionContext);

  return {
    compacted,
    degradedFields: [...working.degradedFields],
    droppedSegments: [...working.droppedSegments],
    budget: {
      compactAtTokens: evaluated.compactAtTokens,
      contextWindowTokens: evaluated.contextWindowTokens,
      estimatedPromptTokensAfter: evaluated.estimatedPromptTokens,
      estimatedPromptTokensBefore: options.initialBudget.estimatedPromptTokens,
      inputBudgetTokens: evaluated.inputBudgetTokens
    },
    segments: buildSegments(working, options),
    sessionContext: working.sessionContext,
    stage,
    strategy: "priority_preserve_v1"
  };
}

function buildSegments(working, options) {
  const policy = options.policy.compaction;
  const inputBudgetTokens = working.inputBudgetTokens;
  const charsPerToken = readPositiveInteger$4(options.policy && options.policy.charsPerToken, 4);

  return [
    createSegment("direction", 1, policy.tiers.direction.pinned, toTargetTokens(inputBudgetTokens, policy.tiers.direction.maxShare, 0), estimateObjectTokens(readDirectionObject(working.sessionContext), charsPerToken), readDirectionObject(working.sessionContext), false, false),
    createSegment("confirmed_memory", 2, policy.tiers.confirmedMemory.pinned, toTargetTokens(inputBudgetTokens, policy.tiers.confirmedMemory.maxShare, 0), estimateTextTokens([working.sessionContext.decisions, working.sessionContext.facts, working.sessionContext.preferences].filter(Boolean).join("\n\n"), charsPerToken), {
      decisions: working.sessionContext.decisions,
      facts: working.sessionContext.facts,
      preferences: working.sessionContext.preferences
    }, false, false),
    createSegment("summary", 3, policy.tiers.summary.pinned, toTargetTokens(inputBudgetTokens, policy.tiers.summary.maxShare, policy.tiers.summary.minTokens), estimateStructuredSummaryTokens(working.sessionContext.summary, charsPerToken), working.sessionContext.summary || null, !working.sessionContext.summary, working.degradedFields.has("summary")),
    createSegment("recent_turns", 4, policy.tiers.recentTurns.pinned, toTargetTokens(inputBudgetTokens, policy.tiers.recentTurns.maxShare, 0), estimateTextTokens(working.sessionContext.recentTurns, charsPerToken), working.sessionContext.recentTurns || null, !working.sessionContext.recentTurns, working.degradedFields.has("recent_turns")),
    createSegment("other_memory", 5, policy.tiers.otherMemory.pinned, toTargetTokens(inputBudgetTokens, policy.tiers.otherMemory.maxShare, 0), estimateTextTokens(working.sessionContext.memory, charsPerToken), working.sessionContext.memory || null, !working.sessionContext.memory, working.degradedFields.has("memory")),
    createSegment("history", 6, policy.tiers.history.pinned, toTargetTokens(inputBudgetTokens, policy.tiers.history.maxShare, 0), estimateTextTokens(working.sessionContext.history, charsPerToken), working.sessionContext.history || null, !working.sessionContext.history, working.degradedFields.has("history"))
  ];
}

function createSegment(key, priority, pinned, targetTokens, estimatedTokens, content, dropped, truncated) {
  return {
    content: dropped ? null : cloneNullable$1(content),
    dropped,
    estimatedTokens,
    key,
    pinned,
    priority,
    targetTokens,
    truncated
  };
}

function trimRecentTurns(working, options) {
  const recentTurnsTier = options.policy.compaction.tiers.recentTurns;
  const inquiryContext = options.contextSnapshot && options.contextSnapshot.inquiryContext
    ? options.contextSnapshot.inquiryContext
    : {};
  const currentCount = countRenderedTurns(working.sessionContext.recentTurns);

  for (let nextCount = Math.max(recentTurnsTier.minTurns, currentCount - 1); nextCount >= recentTurnsTier.minTurns; nextCount -= 1) {
    const nextTurns = renderTurns(buildAnchoredRecentTurns(options.messages, inquiryContext, {
      ...recentTurnsTier,
      maxTurns: nextCount
    }));

    if (nextTurns !== working.sessionContext.recentTurns) {
      working.sessionContext.recentTurns = nextTurns;
      working.degradedFields.add("recent_turns");
      return true;
    }
  }

  working.sessionContext.recentTurns = "";
  working.degradedFields.add("recent_turns");
  return false;
}

function compressSummary(working, options, charsPerToken) {
  const variants = createCompressedSummaryVariants(working.sessionContext.summary);

  for (const candidate of variants) {
    if (candidate !== working.sessionContext.summary) {
      working.sessionContext.summary = candidate;
      working.sessionContext.compactedContext = candidate;
      working.degradedFields.add("summary");
      return true;
    }
  }

  const minSummary = trimTextByTokens(
    working.sessionContext.summary,
    options.policy.compaction.tiers.summary.minTokens,
    charsPerToken
  );

  if (minSummary !== working.sessionContext.summary) {
    working.sessionContext.summary = minSummary;
    working.sessionContext.compactedContext = minSummary;
    working.degradedFields.add("summary");
    return true;
  }

  return false;
}

function selectConfirmedMemory(items, priorityOrder, tokenBudget, charsPerToken) {
  const ordered = Array.isArray(priorityOrder) ? priorityOrder : [];
  const grouped = {
    decision: [],
    fact: [],
    preference: []
  };
  let remaining = tokenBudget;

  for (const kind of ordered) {
    const matches = (Array.isArray(items) ? items : [])
      .filter((item) => item && item.kind === kind && typeof item.text === "string" && item.text.trim())
      .slice()
      .reverse();

    for (const item of matches) {
      const line = `${grouped[kind].length + 1}. ${item.text.trim()}`;
      const tokens = estimateTextTokens(line, charsPerToken);

      if ((grouped.decision.length + grouped.fact.length + grouped.preference.length) > 0 && tokens > remaining) {
        continue;
      }

      grouped[kind].push(item.text.trim());
      remaining -= tokens;
    }
  }

  return {
    decisions: grouped.decision.map((text, index) => `${index + 1}. ${text}`).join("\n"),
    facts: grouped.fact.map((text, index) => `${index + 1}. ${text}`).join("\n"),
    preferences: grouped.preference.map((text, index) => `${index + 1}. ${text}`).join("\n")
  };
}

function trimNumberedBlock(text, tokenBudget, charsPerToken) {
  const lines = readString(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const kept = [];
  let remaining = tokenBudget;

  for (const line of lines) {
    const tokens = estimateTextTokens(line, charsPerToken);

    if (kept.length > 0 && tokens > remaining) {
      break;
    }

    kept.push(line);
    remaining -= tokens;
  }

  return kept.join("\n");
}

function trimTextByTokens(text, tokenBudget, charsPerToken) {
  const normalized = readString(text);

  if (!normalized) {
    return "";
  }

  const maxChars = tokenBudget * charsPerToken;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...` : normalized;
}

function countRenderedTurns(value) {
  const text = readString(value);
  return text ? text.split(/\n\s*\n/).filter(Boolean).length : 0;
}

function readDirectionObject(sessionContext) {
  // The direction segment is `pinned: true` and never droppable, so any
  // unbounded long-form field here will overflow the input budget and
  // make the runtime unable to call the LLM at all (observed live:
  // 52K-token direction vs 32K budget on Gemini 2.5 Flash). Project
  // `lastReadSource` through a summarizer that caps text/snippet/
  // message/error to a small char budget, while keeping url/title/
  // status/ok/contentType verbatim so the planner still knows what
  // was read. Full canonical content remains in inquiryContext.
  return {
    activeGoal: sessionContext.currentGoal || null,
    activeQuery: sessionContext.activeQuery || null,
    activeTopic: sessionContext.currentTopic || null,
    lastReadSource: summarizeReadSourceForDirection(sessionContext.lastReadSource),
    lastResolution: cloneNullable$1(sessionContext.lastResolution),
    pendingClarification: cloneNullable$1(sessionContext.pendingClarification),
    selectedSource: cloneNullable$1(sessionContext.selectedSource)
  };
}

function estimateObjectTokens(value, charsPerToken) {
  return Math.ceil(stableStringify(value).length / charsPerToken);
}

function estimateTextTokens(value, charsPerToken) {
  return Math.ceil(readString(value).length / charsPerToken);
}

function readPositiveInteger$4(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function cloneNullable$1(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

export { buildContextWindowPlan };
