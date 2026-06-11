import { normalizeResearchSlice } from '../runtime/research-thread-sync.js';
import { normalizeTodoState } from '../runtime/todo-state.js';

const DEFAULT_THREAD_ID$1 = "default";
const THREAD_STATUSES = ["active", "paused", "closed"];
const MAX_RECENT_USER_TEXTS = 3;
const DEFAULT_MAX_THREADS = 8;

/**
 * Create a fresh Thread record. All fields are initialised to empty /
 * defaults; callers patch topic / goalAnchor after routing the first turn.
 */
function createThread(options) {
  const source = options && typeof options === "object" ? options : {};
  const now = typeof source.now === "number" ? source.now : Date.now();
  const id = readString$1_(source.id) || generateThreadId(now);
  return {
    budget: source.budget && typeof source.budget === "object" ? { ...source.budget } : null,
    createdAt: now,
    goalAnchor: normalizeGoalAnchor(source.goalAnchor),
    id,
    knowledgeState: normalizeKnowledgeState(source.knowledgeState),
    lastActiveAt: typeof source.lastActiveAt === "number" ? source.lastActiveAt : now,
    recentUserTexts: normalizeRecentUserTexts(source.recentUserTexts),
    research: normalizeResearchSlice(source.research),
    researchContext: normalizeResearchContext(source.researchContext),
    status: normalizeThreadStatus(source.status),
    // AGRUN-212a Phase B — TodoState is thread-scoped. `null` is the
    // canonical "no plan yet" value; `normalizeTodoState` returns null
    // for missing / malformed input so legacy threads (saved before
    // 212a) hydrate cleanly without a migration step.
    todoState: normalizeTodoState(source.todoState),
    toolContext: normalizeToolContext$1(source.toolContext),
    topic: readString$1_(source.topic)
  };
}

/**
 * Normalize an arbitrary value into a well-formed Thread record. Unknown
 * fields are dropped; missing fields default to empty. Legacy persisted
 * threads (from older sessions) flow through this normalizer so consumers
 * can assume the canonical shape.
 */
function normalizeThread(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createThread({});
  }
  return createThread(value);
}

/**
 * Normalize a list of threads. Input may be array or undefined; output is
 * always an array of canonical Thread records, de-duplicated by id (later
 * entries win). When the list is empty, the caller should seed a default
 * thread via `createDefaultThread()`.
 */
function normalizeThreadList(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Map();
  for (const entry of list) {
    const normalized = normalizeThread(entry);
    seen.set(normalized.id, normalized);
  }
  return Array.from(seen.values());
}

/**
 * Create the default "pre-threading" thread used when legacy sessions or
 * flag-disabled runtimes hydrate. Its id is always DEFAULT_THREAD_ID so
 * evidence whose `threadId` is `"default"` aligns with it.
 */
function createDefaultThread(overrides) {
  const base = {};
  return createThread({ ...base, id: DEFAULT_THREAD_ID$1 });
}

/**
 * Find a thread by id. Returns null when missing / input is malformed.
 */
function findThreadById(threads, threadId) {
  const list = Array.isArray(threads) ? threads : [];
  const target = readString$1_(threadId);
  if (!target) return null;
  return list.find((thread) => thread && thread.id === target) || null;
}

/**
 * Push a user text snippet onto a thread's rolling recent-texts window.
 * Returns a new array; does not mutate. Most recent entry is at the end.
 */
function appendRecentUserText(thread, text) {
  const existing = Array.isArray(thread && thread.recentUserTexts) ? thread.recentUserTexts : [];
  const trimmed = readString$1_(text);
  if (!trimmed) return existing.slice();
  const updated = existing.concat([trimmed]);
  if (updated.length <= MAX_RECENT_USER_TEXTS) return updated;
  return updated.slice(-MAX_RECENT_USER_TEXTS);
}

/**
 * Read (or seed) the thread state attached to a session record. Returns a
 * canonical `{threads, activeThreadId}` tuple; if the record has no thread
 * fields yet, it receives a single default thread. Always returns at least
 * one thread so downstream code can assume a non-empty list.
 *
 * This never mutates the input record directly — the caller decides whether
 * to persist. Returned `threads` is a fresh normalized array.
 */
function readThreadsState(sessionRecord) {
  const record = sessionRecord && typeof sessionRecord === "object" ? sessionRecord : {};
  const normalizedList = normalizeThreadList(record.threads);
  const threads = normalizedList.length > 0 ? normalizedList : [createDefaultThread()];
  const requestedActive = readString$1_(record.activeThreadId);
  const activeThreadId = findThreadById(threads, requestedActive)
    ? requestedActive
    : threads[0].id;
  return { threads, activeThreadId };
}

/**
 * Apply a router verdict to a thread list. Returns a new
 * `{threads, activeThreadId, activeThread, verdict}` tuple — does not
 * mutate input. Handles all 4 verdicts:
 *   - continue_thread : bump `lastActiveAt`; push user text to active thread
 *   - pivot_back      : switch active; bump target thread
 *   - new_thread      : append a new thread (up to `maxThreads` FIFO cap),
 *                       seed `topic` from verdict; switch active
 *   - ambiguous       : keep current active, still push user text so the
 *                       next turn can re-route with more signal
 *
 * When the resulting list exceeds `maxThreads`, the oldest-by-`lastActiveAt`
 * non-active thread is dropped (FIFO eviction).
 */
function applyRouterVerdict(options) {
  const source = options && typeof options === "object" ? options : {};
  const state = readThreadsState(source.sessionRecord);
  const verdict = source.verdict && typeof source.verdict === "object" ? source.verdict : null;
  const userText = readString$1_(source.userText);
  const turnId = readString$1_(source.turnId) || null;
  const now = typeof source.now === "number" ? source.now : Date.now();
  const maxThreads = Number.isInteger(source.maxThreads) && source.maxThreads > 0
    ? source.maxThreads
    : DEFAULT_MAX_THREADS;

  if (!verdict) {
    return { threads: state.threads, activeThreadId: state.activeThreadId, activeThread: findThreadById(state.threads, state.activeThreadId), verdict: null };
  }

  let threads = state.threads.slice();
  let activeThreadId = state.activeThreadId;

  if (verdict.action === "new_thread") {
    // AGRUN-142 — seed goalAnchor from the first user message of this thread
    // so planner-prompt / finalizer can inject it every cycle. Immutable
    // thereafter (seedGoalAnchor refuses to rewrite non-empty text).
    const newThread = createThread({
      lastActiveAt: now,
      recentUserTexts: userText ? [userText] : [],
      topic: readString$1_(verdict.topic),
      goalAnchor: userText
        ? { createdAt: now, text: userText, turnId }
        : undefined
    });
    threads.push(newThread);
    activeThreadId = newThread.id;
  } else if (verdict.action === "pivot_back") {
    const target = readString$1_(verdict.threadId);
    if (target && findThreadById(threads, target)) {
      activeThreadId = target;
    }
    threads = bumpThread(threads, activeThreadId, userText, now, turnId);
  } else if (verdict.action === "continue_thread") {
    const target = readString$1_(verdict.threadId);
    if (target && findThreadById(threads, target)) {
      activeThreadId = target;
    }
    threads = bumpThread(threads, activeThreadId, userText, now, turnId);
  } else if (verdict.action === "ambiguous") {
    threads = bumpThread(threads, activeThreadId, userText, now, turnId);
  }

  threads = evictIfNeeded(threads, activeThreadId, maxThreads);
  return {
    threads,
    activeThreadId,
    activeThread: findThreadById(threads, activeThreadId),
    verdict
  };
}

/**
 * Extract the user-visible text from a raw run input. Handles string,
 * `{prompt}`, `{messages:[...{content}]}`, and normalized-input shapes.
 * Returns an empty string when nothing meaningful is found (e.g. image-
 * only turns) so callers can skip routing gracefully.
 */
function extractUserMessageText(input) {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object") return "";
  if (typeof input.text === "string" && input.text.trim()) return input.text.trim();
  if (typeof input.prompt === "string" && input.prompt.trim()) return input.prompt.trim();
  if (Array.isArray(input.messages)) {
    for (let i = input.messages.length - 1; i >= 0; i -= 1) {
      const message = input.messages[i];
      if (!message || message.role !== "user") continue;
      const text = readMessageText$2(message);
      if (text) return text;
    }
  }
  return "";
}

function readMessageText$2(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (Array.isArray(message.content)) {
    const chunks = [];
    for (const part of message.content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
    return chunks.join(" ").trim();
  }
  if (message.content && typeof message.content === "object") {
    if (typeof message.content.text === "string") return message.content.text.trim();
  }
  return "";
}

function bumpThread(threads, activeThreadId, userText, now, turnId) {
  return threads.map((thread) => {
    if (thread.id !== activeThreadId) return thread;
    // AGRUN-142 — lazy-seed goalAnchor for legacy / pre-routed threads whose
    // first user message was never captured. Never rewrites existing text.
    const existingAnchor = thread.goalAnchor && typeof thread.goalAnchor === "object"
      ? thread.goalAnchor
      : null;
    const hasText = Boolean(existingAnchor && readString$1_(existingAnchor.text));
    const nextGoalAnchor = !hasText && userText
      ? { createdAt: now, text: userText, turnId: turnId || null }
      : existingAnchor;
    return {
      ...thread,
      goalAnchor: normalizeGoalAnchor(nextGoalAnchor),
      lastActiveAt: now,
      recentUserTexts: appendRecentUserText(thread, userText)
    };
  });
}

function evictIfNeeded(threads, activeThreadId, maxThreads) {
  if (!Array.isArray(threads) || threads.length <= maxThreads) return threads;
  // Keep active + most recently-used up to maxThreads.
  const sorted = threads.slice().sort((a, b) => {
    if (a.id === activeThreadId) return -1;
    if (b.id === activeThreadId) return 1;
    const aAt = typeof a.lastActiveAt === "number" ? a.lastActiveAt : 0;
    const bAt = typeof b.lastActiveAt === "number" ? b.lastActiveAt : 0;
    return bAt - aAt;
  });
  return sorted.slice(0, maxThreads);
}

/**
 * Tokenize a free-form string into lowercase word tokens, filtering stop
 * words and short noise. Exposed for topic-router scoring + tests.
 */
function tokenizeTopicText(value) {
  const text = readString$1_(value).toLowerCase();
  if (!text) return [];
  const raw = text.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const filtered = [];
  for (const token of raw) {
    if (token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    filtered.push(token);
  }
  return filtered;
}

function normalizeGoalAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { createdAt: null, text: "", turnId: null };
  }
  return {
    createdAt: typeof value.createdAt === "number" ? value.createdAt : null,
    text: readString$1_(value.text),
    turnId: readString$1_(value.turnId) || null
  };
}

function normalizeKnowledgeState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    decisions: Array.isArray(source.decisions) ? source.decisions.slice() : [],
    facts: Array.isArray(source.facts) ? source.facts.slice() : [],
    preferences: Array.isArray(source.preferences) ? source.preferences.slice() : []
  };
}

function normalizeToolContext$1(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    history: Array.isArray(source.history) ? source.history.slice() : [],
    lastResult: source.lastResult || null
  };
}

function normalizeResearchContext(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    aggregatedSearchResults: Array.isArray(source.aggregatedSearchResults) ? source.aggregatedSearchResults.slice() : [],
    lastQuery: readString$1_(source.lastQuery) || null,
    readSources: Array.isArray(source.readSources) ? source.readSources.slice() : [],
    searchPasses: Array.isArray(source.searchPasses) ? source.searchPasses.slice() : [],
    searchResults: Array.isArray(source.searchResults) ? source.searchResults.slice() : []
  };
}

function normalizeRecentUserTexts(value) {
  if (!Array.isArray(value)) return [];
  const cleaned = value.map((item) => readString$1_(item)).filter(Boolean);
  if (cleaned.length <= MAX_RECENT_USER_TEXTS) return cleaned;
  return cleaned.slice(-MAX_RECENT_USER_TEXTS);
}

function normalizeThreadStatus(value) {
  const candidate = readString$1_(value).toLowerCase();
  return THREAD_STATUSES.includes(candidate) ? candidate : "active";
}

function generateThreadId(seed) {
  const seedPart = Number.isFinite(seed) ? Math.abs(seed).toString(36) : "0";
  const randomPart = Math.floor(Math.random() * 1e9).toString(36);
  return `t-${seedPart.slice(-4)}${randomPart.slice(-4)}`;
}

function readString$1_(value) {
  return typeof value === "string" ? value.trim() : "";
}

const STOP_WORDS = new Set([
  "the", "and", "for", "you", "your", "are", "with", "was", "were", "this",
  "that", "these", "those", "what", "when", "where", "which", "who", "whom",
  "why", "how", "can", "could", "would", "should", "may", "might", "will",
  "not", "but", "about", "from", "into", "onto", "per", "via", "also",
  "just", "than", "then", "there", "here", "now", "any", "all", "some",
  "one", "two", "three", "yes", "please", "thanks", "thank",
  "\u6211", "\u7684", "\u662f", "\u5728", "\u4e86", "\u548c", "\u4e0e",
  "\u5c31", "\u90fd", "\u4e5f", "\u8fd8", "\u53c8", "\u8fd9", "\u90a3"
]);

export { DEFAULT_THREAD_ID$1 as DEFAULT_THREAD_ID, appendRecentUserText, applyRouterVerdict, createDefaultThread, createThread, extractUserMessageText, findThreadById, normalizeThread, normalizeThreadList, readThreadsState, tokenizeTopicText };
