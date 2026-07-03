import { stableStringify, stringifySessionContent } from './content.js';
import { summarizeReadSourceForDirection } from './context-snapshot-fields.js';
import { readString } from '../runtime/semantic-json.js';
import { normalizeThreadId } from './summary-key.js';

function hasSessionContext(sessionContext) {
  return Boolean(
    sessionContext &&
    typeof sessionContext === "object" &&
    [
      sessionContext.activeQuery,
      sessionContext.currentTopic,
      sessionContext.currentGoal,
      sessionContext.openAmbiguity,
      readClarificationStatus$1(sessionContext.clarificationStatus),
      serializeStructuredValue(sessionContext.pendingClarification),
      serializeStructuredValue(sessionContext.selectedSource),
      serializeStructuredValue(sessionContext.lastReadSource),
      serializeStructuredValue(sessionContext.lastResolution),
      sessionContext.compactedContext,
      sessionContext.recentTurns,
      sessionContext.summary,
      sessionContext.facts,
      sessionContext.preferences,
      sessionContext.decisions,
      sessionContext.memory,
      sessionContext.history
    ].some((value) => typeof value === "string" && value.trim().length > 0)
  );
}

function summarizeSessionContextMeta(sessionContext) {
  const context = sessionContext && typeof sessionContext === "object" ? sessionContext : null;
  const items = Array.isArray(context && context.items) ? context.items : [];

  return {
    decisionsCount: countEvidenceItems(items, "decision"),
    ambiguityPresent: hasText(context && context.openAmbiguity),
    clarificationStatus: readString(context && context.clarificationStatus) || "none",
    factsCount: countEvidenceItems(items, "fact"),
    goalPresent: hasText(context && context.currentGoal),
    historyCount: countHistoryMessages((context && (context.recentTurns || context.history)) || ""),
    memoryCount: countNumberedLines(context && context.memory),
    preferencesCount: countEvidenceItems(items, "preference"),
    present: hasSessionContext(context),
    summaryPresent: hasText(context && (context.compactedContext || context.summary)),
    topicPresent: hasText(context && context.currentTopic)
  };
}

function buildSessionContextSystemPrompt(sessionContext) {
  return buildSessionContextPromptBlock(
    sessionContext,
    "Conversation context for the current agrun.js session:"
  );
}

function buildSessionContextPromptBlock(sessionContext, heading) {
  if (!hasSessionContext(sessionContext)) {
    return "";
  }

  return [
    readString(heading) || "Session evidence:",
    renderSection("Current goal", sessionContext.currentGoal),
    renderSection("Current topic", sessionContext.currentTopic),
    renderSection("Active query", sessionContext.activeQuery),
    renderStructuredSection("Pending clarification", sessionContext.pendingClarification),
    renderStructuredSection("Last resolution", sessionContext.lastResolution),
    renderStructuredSection("Selected source", sessionContext.selectedSource),
    renderStructuredSection("Last read source", summarizeReadSourceForDirection(sessionContext.lastReadSource)),
    renderSection("Open ambiguity", sessionContext.openAmbiguity),
    renderSection("Clarification status", readClarificationStatus$1(sessionContext.clarificationStatus)),
    renderConfirmedMemorySection(sessionContext),
    renderSection("Compacted context", sessionContext.compactedContext || sessionContext.summary),
    renderSection("Recent turns", sessionContext.recentTurns),
    renderSection("Session Memory", sessionContext.memory),
    renderSection("History", sessionContext.history)
  ].filter(Boolean).join("\n\n");
}

function buildCompactionPrompt(options) {
  const lines = [
    "Summarize the session context below for a future turn.",
    "Use these exact headings:",
    "Current goal:",
    "Current topic:",
    "Constraints:",
    "Confirmed facts:",
    "Decisions:",
    "Open questions:",
    "Next step:",
    "Keep goals, confirmed facts, constraints, decisions, and unresolved work.",
    // AGRUN-424 — preservation rules: fold the prior summary forward, keep
    // concrete identifiers exact, and never silently resolve an open question.
    "Fold the existing summary below into your output; do not drop anything from it that is still relevant.",
    "Preserve concrete identifiers verbatim: names, numbers, dates, amounts, currencies, URLs, file paths, and IDs.",
    "Keep every still-open question under Open questions.",
    "Omit greetings, filler, and duplicated details.",
    "Return plain text only."
  ];

  // AGRUN-145 Slice C — When the caller scopes compaction to a single
  // conversation thread, prefix a Thread marker so the model knows the
  // messages below represent one topic (not a cross-thread digest) and
  // keeps cross-thread facts out of the summary. Omit when threadId is
  // unset/default, preserving the pre-Slice-C prompt byte-for-byte for
  // threads-disabled sessions.
  const threadId = typeof options.threadId === "string" ? options.threadId.trim() : "";
  if (threadId && threadId !== "default") {
    lines.push(`Thread: ${threadId}`);
    lines.push("Only summarize messages belonging to this thread.");
  }

  const previousSummary = typeof options.previousSummary === "string"
    ? options.previousSummary.trim()
    : "";
  const messageBlock = renderHistoryBlock(options.messages);

  if (previousSummary) {
    lines.push("");
    lines.push("Existing summary:");
    lines.push(previousSummary);
  }

  lines.push("");
  lines.push("Messages to compact:");
  lines.push(messageBlock || "None");
  return lines.join("\n");
}

function selectCompactionMessages(messages, summary, recentMessages) {
  const completedMessages = Array.isArray(messages) ? messages : [];
  const recentCount = Number.isInteger(recentMessages) && recentMessages > 0 ? recentMessages : 0;
  const unsummarized = sliceAfterSummary(completedMessages, summary);

  if (unsummarized.length <= recentCount) {
    return [];
  }

  return unsummarized.slice(0, unsummarized.length - recentCount);
}

function sliceAfterSummary(messages, summary) {
  const list = Array.isArray(messages) ? messages : [];

  if (!summary || !summary.uptoMessageId) {
    return list.slice();
  }

  const index = list.findIndex((message) => message && message.id === summary.uptoMessageId);
  return index === -1 ? list.slice() : list.slice(index + 1);
}

/**
 * AGRUN-145 Slice C — Filter a message list down to one conversation
 * thread. A no-op when threadId is empty (pre-145 call sites) so legacy
 * compaction keeps its whole-session semantics. Legacy messages that
 * predate Slice A have no `threadId` field; we collapse those to
 * DEFAULT_THREAD_ID via `normalizeThreadId`, matching how the summary
 * store auto-buckets legacy records. This keeps a single harness
 * definition of "which thread does this message belong to" instead of
 * scattering `message.threadId || "default"` checks through the
 * compaction pipeline.
 */
function filterMessagesByThread(messages, threadId) {
  const list = Array.isArray(messages) ? messages : [];
  const target = typeof threadId === "string" ? threadId.trim() : "";
  if (!target) return list.slice();
  return list.filter((message) => {
    if (!message || typeof message !== "object") return false;
    return normalizeThreadId(message.threadId) === target;
  });
}

function renderHistoryBlock(messages) {
  const list = Array.isArray(messages) ? messages : [];

  return list
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : "assistant";
      const text = stringifySessionContent(message.content);
      return text ? `${capitalize$1(role)}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderConfirmedMemorySection(sessionContext) {
  const lines = [
    renderSection("Confirmed Decisions", sessionContext.decisions),
    renderSection("Confirmed Session Facts", sessionContext.facts),
    renderSection("Confirmed Preferences", sessionContext.preferences)
  ].filter(Boolean);

  if (lines.length === 0) {
    return "";
  }

  return ["Confirmed memory:", ...lines].join("\n\n");
}

function renderSection(title, value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? `${title}:\n${text}` : "";
}

function renderStructuredSection(title, value) {
  const text = serializeStructuredValue(value);
  return text ? `${title}:\n${text}` : "";
}

function serializeStructuredValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  return stableStringify(value);
}

function readClarificationStatus$1(value) {
  const text = readString(value);
  return text && text !== "none" ? text : "";
}

function hasText(value) {
  return readString(value).length > 0;
}

function countEvidenceItems(items, kind) {
  return items.filter((item) => (
    item &&
    typeof item === "object" &&
    item.kind === kind &&
    typeof item.text === "string" &&
    item.text.trim().length > 0
  )).length;
}

function countHistoryMessages(value) {
  const text = readString(value);

  if (!text) {
    return 0;
  }

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(User|Assistant):\s+/i.test(line))
    .length;
}

function countNumberedLines(value) {
  const text = readString(value);

  if (!text) {
    return 0;
  }

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .length;
}

function capitalize$1(value) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

export { buildCompactionPrompt, buildSessionContextPromptBlock, buildSessionContextSystemPrompt, filterMessagesByThread, hasSessionContext, selectCompactionMessages, sliceAfterSummary, summarizeSessionContextMeta };
