import { stringifySessionContent, stableStringify } from './content.js';
import { readContextSnapshot } from './context-snapshot-normalize.js';
import { projectSessionContextFromSnapshot } from './context-snapshot-projection.js';

const EVIDENCE_KINDS = ["fact", "preference", "decision"];
const DEFAULT_THREAD_ID = "default";
const DEFAULT_CONFIDENCE = 0.5;

function buildSessionEvidenceSnapshot(options) {
  const completedMessages = Array.isArray(options.messages) ? options.messages : [];
  const policy = options.policy && typeof options.policy === "object" ? options.policy : {};
  const summary = options.summary && typeof options.summary === "object" ? options.summary : null;
  const includeOtherMemory = options.includeOtherMemory !== false;
  const scopedEntries = filterMemoryEntriesByThread(options.memoryEntries, options.threadScope);
  const classified = classifySessionMemoryEntries(scopedEntries);
  const recentMessageCount = readPositiveInteger$n(policy.recentMessages, 6);
  const recentTurnCount = Math.max(2, Math.ceil(recentMessageCount / 2));
  const allTurns = buildRecentTurns(completedMessages);
  const compactedContext = summary && typeof summary.text === "string" ? summary.text.trim() : "";
  const baseContext = readBaseContext(options.contextSnapshot);
  const recentTurns = compactTurnsForContext(allTurns, recentTurnCount, {
    currentGoal: baseContext.currentGoal,
    currentTopic: baseContext.currentTopic
  });
  const context = {
    activeQuery: baseContext.activeQuery,
    clarificationStatus: baseContext.clarificationStatus,
    compactedContext,
    currentGoal: baseContext.currentGoal,
    currentTopic: baseContext.currentTopic,
    decisions: renderEvidenceBlock(classified.decisions),
    facts: renderEvidenceBlock(classified.facts),
    history: renderRecentTurnsBlock(recentTurns),
    items: classified.items,
    lastResolution: baseContext.lastResolution,
    memory: includeOtherMemory ? renderMemoryBlock(classified.other) : "",
    openAmbiguity: baseContext.openAmbiguity,
    pendingClarification: baseContext.pendingClarification,
    preferences: renderEvidenceBlock(classified.preferences),
    recentTurns: renderRecentTurnsBlock(recentTurns),
    summary: compactedContext
  };

  return {
    ...context,
    estimatedTokens: estimateContextTokens(context, readPositiveInteger$n(policy.charsPerToken, 4))
  };
}

function classifySessionMemoryEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const latestByKey = new Map();
  const byId = new Map();
  const supersededIds = new Set();
  const other = [];

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    const item = normalizeEvidenceItem(entry, index);

    if (!item) {
      other.push(entry);
      continue;
    }

    byId.set(item.id, item);
    if (item.supersededBy) {
      // Explicit supersede — mark the referenced slot/id as stale.
      supersededIds.add(item.supersededBy);
    }

    const key = `${item.kind}:${item.slot || normalizeText(item.text)}`;
    const previous = latestByKey.get(key);

    if (!previous || compareEvidenceItems(previous, item) <= 0) {
      if (previous) {
        // Implicit supersede — newer item for the same slot.
        supersededIds.add(previous.id);
      }
      latestByKey.set(key, item);
    } else {
      supersededIds.add(item.id);
    }
  }

  const items = Array.from(latestByKey.values())
    .filter((item) => !supersededIds.has(item.id))
    .sort(compareEvidenceItems);
  return {
    decisions: items.filter((item) => item.kind === "decision"),
    facts: items.filter((item) => item.kind === "fact"),
    items,
    other,
    preferences: items.filter((item) => item.kind === "preference")
  };
}

/**
 * Build the evidence URL allow-list for the active thread. Returns either:
 *   - `null` — when thread scoping is disabled or no memory entries exist;
 *     downstream `filterSourcesByEvidence(..., null)` behaves as passthrough.
 *   - `string[]` — unique URLs harvested from evidence items whose
 *     `threadId` matches (or whose threadId is the default legacy bucket
 *     that the active thread claims, i.e. `"default"`).
 *
 * The harvest walks metadata fields that plausibly carry a URL
 * (`metadata.url`, `metadata.sourceUrl`, `metadata.sources[].url`). Empty
 * / invalid URLs are dropped. Order is stable (first occurrence wins).
 */
function buildThreadScopedEvidenceUrls(memoryEntries, activeThreadId) {
  const threadId = readString$1O(activeThreadId);
  if (!threadId) return null;
  const list = Array.isArray(memoryEntries) ? memoryEntries : [];
  if (list.length === 0) return null;
  const urls = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    const entryThread = readString$1O(metadata.threadId) || DEFAULT_THREAD_ID;
    if (entryThread !== threadId) continue;
    collectUrlsFromMetadata(metadata, urls);
  }
  return Array.from(urls);
}

/**
 * Filter raw session memory entries by a thread scope. When `scope` is empty,
 * crossThread is true, or the scope lacks a threadId, the entries pass through
 * unchanged. When a `threadId` is set, only entries whose `metadata.threadId`
 * matches (or legacy entries with no threadId that fall into the DEFAULT
 * bucket matching the active thread) survive. This is the choke point the
 * semantic-recall path flows through: everything downstream —
 * classifySessionMemoryEntries / buildSessionMemorySnapshot /
 * requestSemanticRecall — sees only entries tagged for the active thread.
 */
function filterMemoryEntriesByThread(entries, scope) {
  const list = Array.isArray(entries) ? entries : [];
  if (!scope || typeof scope !== "object") return list.slice();
  if (scope.crossThread === true) return list.slice();
  const threadId = readString$1O(scope.threadId);
  if (!threadId) return list.slice();
  return list.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    const entryThread = readString$1O(metadata.threadId) || DEFAULT_THREAD_ID;
    return entryThread === threadId;
  });
}

function collectUrlsFromMetadata(metadata, sink) {
  const direct = readString$1O(metadata.url) || readString$1O(metadata.sourceUrl);
  if (direct) sink.add(direct);
  if (Array.isArray(metadata.sources)) {
    for (const source of metadata.sources) {
      if (source && typeof source === "object") {
        const url = readString$1O(source.url);
        if (url) sink.add(url);
      }
    }
  }
}

function readBaseContext(value) {
  const snapshot = readContextSnapshot(value);
  if (!snapshot) {
    return {
      activeQuery: "",
      clarificationStatus: "none",
      currentGoal: "",
      currentTopic: "",
      lastResolution: null,
      openAmbiguity: "",
      pendingClarification: null
    };
  }

  const context = projectSessionContextFromSnapshot(snapshot);
  return {
    activeQuery: readString$1O(context && context.activeQuery),
    clarificationStatus: readString$1O(context && context.clarificationStatus) || "none",
    currentGoal: readString$1O(context && context.currentGoal),
    currentTopic: readString$1O(context && context.currentTopic),
    lastResolution: context && context.lastResolution ? stableClone(context.lastResolution) : null,
    openAmbiguity: readString$1O(context && context.openAmbiguity),
    pendingClarification: context && context.pendingClarification ? stableClone(context.pendingClarification) : null
  };
}

function normalizeEvidenceItem(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  const kind = readEvidenceKind(metadata.kind);
  const status = readString$1O(metadata.status) || "confirmed";
  const text = readEntryText$1(entry);

  if (!kind || status !== "confirmed" || !text) {
    return null;
  }

  const slot = normalizeSlot$1(metadata.slot);
  const threadId = readString$1O(metadata.threadId) || DEFAULT_THREAD_ID;
  const turnId = readString$1O(metadata.turnId) || null;
  const source = readString$1O(metadata.source) || null;
  const supersededBy = readString$1O(metadata.supersededBy) || null;
  const confidence = typeof metadata.confidence === "number"
    ? clampConfidence$2(metadata.confidence)
    : DEFAULT_CONFIDENCE;
  const id = readString$1O(metadata.id)
    || `${threadId}|${kind}|${slot || normalizeText(text)}|${index}`;

  return {
    confidence,
    createdAt: readEntryTimestamp(entry),
    id,
    index,
    kind,
    slot,
    source,
    status,
    supersededBy,
    text,
    threadId,
    turnId
  };
}

function buildRecentTurns(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const turns = [];

  for (const message of list) {
    const role = typeof message.role === "string" ? message.role : "";
    const text = stringifySessionContent(message.content).trim();

    if (!text || (role !== "user" && role !== "assistant")) {
      continue;
    }

    if (role === "user" || turns.length === 0) {
      turns.push({
        assistant: role === "assistant" ? [text] : [],
        user: role === "user" ? text : ""
      });
      continue;
    }

    turns[turns.length - 1].assistant.push(text);
  }

  return turns.filter((turn) => turn.user || turn.assistant.length > 0);
}

function compactTurnsForContext(turns, maxTurns, anchors) {
  const list = Array.isArray(turns) ? turns : [];
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    return list;
  }

  const recent = list.slice(-maxTurns);
  const anchored = anchorTurns(list, recent, anchors);
  return anchored.length > 0 ? anchored : recent;
}

function anchorTurns(compacted, recentTurns, anchors) {
  const allTurns = Array.isArray(compacted) ? compacted : [];
  const recent = Array.isArray(recentTurns) ? recentTurns : [];
  const currentGoal = readString$1O(anchors && anchors.currentGoal);
  const currentTopic = readString$1O(anchors && anchors.currentTopic);
  const selected = new Set(recent.map((turn) => allTurns.indexOf(turn)).filter((index) => index >= 0));
  const goalIndex = findAnchorTurnIndex(allTurns, currentGoal);
  const topicIndex = findAnchorTurnIndex(allTurns, currentTopic);

  if (goalIndex >= 0) {
    selected.add(goalIndex);
  }

  if (topicIndex >= 0) {
    selected.add(topicIndex);
  }

  return Array.from(selected)
    .sort((left, right) => left - right)
    .map((index) => allTurns[index]);
}

function renderRecentTurnsBlock(turns) {
  return (Array.isArray(turns) ? turns : [])
    .map((turn, index) => {
      const lines = [`Turn ${index + 1}:`];
      if (turn.user) {
        lines.push(`User: ${turn.user}`);
      }
      for (const assistantMessage of Array.isArray(turn.assistant) ? turn.assistant : []) {
        lines.push(`Assistant: ${assistantMessage}`);
      }
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function renderEvidenceBlock(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => `${index + 1}. ${item.text}`)
    .join("\n");
}

function renderMemoryBlock(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const text = readEntryText$1(entry);
      return `${index + 1}. ${text || stableStringify(entry)}`;
    })
    .join("\n");
}

function estimateContextTokens(context, charsPerToken) {
  const text = [
    context.activeQuery,
    context.currentTopic,
    context.currentGoal,
    context.openAmbiguity,
    stableStringify(context.pendingClarification),
    stableStringify(context.lastResolution),
    context.compactedContext,
    context.summary,
    context.facts,
    context.preferences,
    context.decisions,
    context.memory,
    context.recentTurns,
    context.history
  ].filter(Boolean).join("\n\n");

  return Math.ceil(text.length / charsPerToken);
}

function readEntryText$1(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  if (entry.output && typeof entry.output === "object" && typeof entry.output.text === "string") {
    return entry.output.text.trim();
  }

  if (entry.output != null) {
    return stringifySessionContent({ type: "json", value: entry.output }).replace(/^"|"$/g, "");
  }

  return "";
}

function readEntryTimestamp(entry) {
  if (typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)) {
    return entry.createdAt;
  }

  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function compareEvidenceItems(left, right) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }

  return left.index - right.index;
}

function findAnchorTurnIndex(turns, anchorText) {
  const normalizedAnchor = normalizeAnchorText$1(anchorText);
  if (!normalizedAnchor) {
    return -1;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const userText = readString$1O(turns[index] && turns[index].user);
    const normalizedUser = normalizeAnchorText$1(userText);
    if (!normalizedUser) {
      continue;
    }

    if (
      normalizedUser === normalizedAnchor ||
      normalizedUser.includes(normalizedAnchor) ||
      normalizedAnchor.includes(normalizedUser)
    ) {
      return index;
    }
  }

  return -1;
}

function stableClone(value) {
  return JSON.parse(stableStringify(value));
}

function readEvidenceKind(value) {
  const normalized = readString$1O(value);
  return EVIDENCE_KINDS.includes(normalized) ? normalized : "";
}

function readPositiveInteger$n(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeSlot$1(value) {
  return normalizeText(value) || "";
}

function clampConfidence$2(value) {
  if (!Number.isFinite(value)) return DEFAULT_CONFIDENCE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeText(value) {
  return readString$1O(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeAnchorText$1(value) {
  return readString$1O(value).toLowerCase().replace(/[.?!]+$/g, "").replace(/\s+/g, " ").trim();
}

function readString$1O(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { buildSessionEvidenceSnapshot, buildThreadScopedEvidenceUrls, classifySessionMemoryEntries, filterMemoryEntriesByThread };
