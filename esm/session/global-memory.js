import { normalizeThrownError } from '../runtime/errors.js';

const GLOBAL_MEMORY_MAX_ENTRIES = 100;
const GLOBAL_MEMORY_MIN_CONFIDENCE = 0.7;

const KIND_TO_CATEGORY = {
  preference: "user_preference",
  fact: "learned_fact",
  decision: "project_context"
};

const SENSITIVE_PATTERNS = [
  // Generic keyword labels
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /\btoken\b/i,
  /bearer\s+/i,
  /\bauthorization\s*[:=]/i,
  /x[_-]api[_-]key/i,
  /aws[_-]?secret[_-]?access[_-]?key/i,

  // Provider-specific API key shapes
  /\bsk-[a-zA-Z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bya29\.[0-9A-Za-z_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,

  // Private keys and JWTs
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
];

const SENSITIVE_KEY_NAMES = /(^|[_-])(?:api[_-]?key|apikey|secret|password|passwd|token|authorization|bearer|private[_-]?key|client[_-]?secret|access[_-]?key)($|[_-])/i;

function mapSessionMemoryKindToGlobalCategory(kind) {
  return KIND_TO_CATEGORY[kind] || null;
}

function isGlobalMemoryCandidate(entry, options) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const kind = readNestedString(entry, "metadata", "kind");
  const category = mapSessionMemoryKindToGlobalCategory(kind);

  if (!category) {
    return false;
  }

  const minConfidence = typeof options?.minConfidence === "number" ? options.minConfidence : GLOBAL_MEMORY_MIN_CONFIDENCE;
  const confidence = typeof entry.metadata?.confidence === "number" ? entry.metadata.confidence : 0;
  if (confidence < minConfidence) {
    return false;
  }

  const text = readEntryText(entry);
  if (!text) {
    return false;
  }

  if (containsSensitiveContent(text) || containsSensitiveContent(entry)) {
    return false;
  }

  return true;
}

function containsSensitiveContent(value, seen) {
  if (value == null) {
    return false;
  }

  if (typeof value === "string") {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
  }

  if (typeof value !== "object") {
    return false;
  }

  const visited = seen || new WeakSet();
  if (visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveContent(item, visited));
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof key === "string" && SENSITIVE_KEY_NAMES.test(key)) {
      return true;
    }
    if (containsSensitiveContent(child, visited)) {
      return true;
    }
  }

  return false;
}

function createGlobalMemoryEntry(options) {
  const now = Date.now();

  return {
    id: options.id || `${now}-${Math.random().toString(36).slice(2, 10)}`,
    category: options.category || "learned_fact",
    text: options.text || "",
    slot: options.slot || "",
    confidence: typeof options.confidence === "number" ? options.confidence : 0.7,
    source: options.source || "auto_extract",
    createdAt: typeof options.createdAt === "number" ? options.createdAt : now,
    updatedAt: now
  };
}

function mergeGlobalIntoSessionMemory(sessionEntries, globalEntries) {
  const sessionArray = Array.isArray(sessionEntries) ? sessionEntries : [];
  const globalArray = Array.isArray(globalEntries) ? globalEntries : [];

  if (globalArray.length === 0) {
    return sessionArray;
  }

  const sessionSlots = new Set();

  for (const entry of sessionArray) {
    const slot = readNestedString(entry, "metadata", "slot");
    const kind = readNestedString(entry, "metadata", "kind");
    if (slot) {
      sessionSlots.add(`${kind}:${slot}`);
    }
  }

  const converted = [];

  for (const global of globalArray) {
    const kind = categoryToKind(global.category);
    const slot = typeof global.slot === "string" ? global.slot : "";
    const dedupeKey = `${kind}:${slot}`;

    if (slot && sessionSlots.has(dedupeKey)) {
      continue;
    }

    converted.push({
      timestamp: typeof global.createdAt === "number" ? new Date(global.createdAt).toISOString() : new Date().toISOString(),
      skill: null,
      input: {},
      output: { text: global.text || "" },
      metadata: {
        kind,
        slot,
        confidence: typeof global.confidence === "number" ? global.confidence : 0.7,
        source: global.source || "global_memory",
        status: "confirmed"
      }
    });
  }

  return [...converted, ...sessionArray];
}

// AGRUN-478 (audit M16) — the read-all → decide → write sequence in
// promoteToGlobalMemory is a read-modify-write that is NOT atomic across
// concurrent promotions sharing one store. Global memory is cross-session by
// design, so two concurrent session.run calls against the same store interleave
// their readAllGlobalMemory and appendGlobalMemory: both miss the slot-dedup
// match and both insert → duplicate slot rows (breaking the slot-uniqueness
// invariant mergeGlobalIntoSessionMemory and the upsert path rely on); at the
// cap they also double-evict / overflow maxEntries. We serialize the critical
// section per store with a promise-chain mutex keyed on the store instance.
const GLOBAL_MEMORY_WRITE_LOCKS = new WeakMap();

function runExclusiveGlobalMemoryWrite(store, critical) {
  // WeakMap needs an object key; if the store isn't one (defensive), run
  // unserialized rather than throw — correctness degrades to the prior
  // behavior only for that pathological case.
  if (!store || typeof store !== "object") {
    return critical();
  }
  const prev = GLOBAL_MEMORY_WRITE_LOCKS.get(store) || Promise.resolve();
  // `prev` is always a resolved tail (errors swallowed below), so `critical`
  // runs exactly once after the previous critical section drains. The returned
  // promise carries critical's real result/throw to THIS caller; the stored
  // tail swallows so one failing promotion never wedges the next.
  const result = prev.then(critical, critical);
  GLOBAL_MEMORY_WRITE_LOCKS.set(store, result.then(NOOP, NOOP));
  return result;
}

async function promoteToGlobalMemory(sessionStore, entry, options) {
  const kind = readNestedString(entry, "metadata", "kind");
  const category = mapSessionMemoryKindToGlobalCategory(kind);

  if (!category) {
    return;
  }

  const maxEntries = typeof options?.maxEntries === "number" && options.maxEntries > 0
    ? options.maxEntries
    : GLOBAL_MEMORY_MAX_ENTRIES;
  const onTelemetry = typeof options?.onTelemetry === "function" ? options.onTelemetry : null;
  const sensitivityFilter = typeof options?.sensitivityFilter === "function" ? options.sensitivityFilter : null;
  const promotionValidator = typeof options?.promotionValidator === "function" ? options.promotionValidator : null;
  const hookTimeoutMs = typeof options?.hookTimeoutMs === "number" && options.hookTimeoutMs > 0 ? options.hookTimeoutMs : 2000;

  const text = readEntryText(entry);
  const slot = readNestedString(entry, "metadata", "slot") || "";
  const source = readNestedString(entry, "metadata", "source") || "auto_extract";
  const confidence = typeof entry.metadata?.confidence === "number" ? entry.metadata.confidence : GLOBAL_MEMORY_MIN_CONFIDENCE;

  const hookContext = {
    sessionId: options?.sessionId || null,
    sessionStore,
    kind,
    category,
    slot,
    source,
    sourceTurn: options?.sourceTurn || { user: "", assistant: "" }
  };

  if (sensitivityFilter) {
    const outcome = await runHook(sensitivityFilter, entry, hookContext, hookTimeoutMs);
    // sensitivityFilter: true => sensitive => block. fail-closed: error/timeout => block.
    const blocked = !outcome.ok || outcome.value === true;
    if (blocked) {
      if (onTelemetry) onTelemetry({
        type: "global-memory-filtered",
        id: null,
        category,
        slot,
        reason: !outcome.ok ? (outcome.timedOut ? "hook_timeout" : "hook_error") : "sensitivity_blocked",
        hook: "sensitivityFilter",
        message: !outcome.ok ? (outcome.message || "hook error") : null
      });
      return;
    }
  }

  if (promotionValidator) {
    const outcome = await runHook(promotionValidator, entry, hookContext, hookTimeoutMs);
    // promotionValidator: true => valid => allow. false/error/timeout => block.
    const blocked = !outcome.ok || outcome.value !== true;
    if (blocked) {
      if (onTelemetry) onTelemetry({
        type: "global-memory-filtered",
        id: null,
        category,
        slot,
        reason: !outcome.ok ? (outcome.timedOut ? "hook_timeout" : "hook_error") : "validator_blocked",
        hook: "promotionValidator",
        message: !outcome.ok ? (outcome.message || "hook error") : null
      });
      return;
    }
  }

  // Serialized per store so the read-all → decide → write below is atomic
  // against concurrent promotions (see runExclusiveGlobalMemoryWrite). The
  // slow hooks above intentionally stay OUTSIDE the lock — they touch no
  // global-memory state and would otherwise hold the lock for up to hookTimeoutMs.
  return runExclusiveGlobalMemoryWrite(sessionStore, async () => {
    const existing = await sessionStore.readAllGlobalMemory();
    const match = slot ? existing.find((e) => e.slot === slot && e.category === category) : null;

    if (match) {
      if (confidence > (match.confidence || 0)) {
        match.text = text;
        match.confidence = confidence;
        match.updatedAt = Date.now();
        await sessionStore.appendGlobalMemory(match);
        if (onTelemetry) onTelemetry({ type: "global-memory-written", id: match.id, category, slot, confidence, reason: "upsert" });
      }
      return;
    }

    if (existing.length >= maxEntries) {
      const sorted = existing
        .slice()
        .sort((a, b) => (a.confidence || 0) - (b.confidence || 0) || (a.createdAt || 0) - (b.createdAt || 0));
      const victim = sorted[0];

      if (victim && confidence > (victim.confidence || 0)) {
        await sessionStore.deleteGlobalMemory(victim.id);
        if (onTelemetry) onTelemetry({ type: "global-memory-purged", id: victim.id, reason: "lru_evict" });
      } else {
        return;
      }
    }

    const created = await sessionStore.appendGlobalMemory(createGlobalMemoryEntry({
      category,
      confidence,
      slot,
      source: readNestedString(entry, "metadata", "source") || "auto_extract",
      text
    }));
    if (onTelemetry) onTelemetry({ type: "global-memory-written", id: created?.id, category, slot, confidence, reason: "insert" });
  });
}

async function runHook(hook, entry, context, timeoutMs) {
  let timer = null;
  // Pass an AbortSignal so well-behaved hooks can cancel their work when the
  // timeout wins. Falls back gracefully on runtimes without AbortController.
  const abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
  const hookContext = abortController ? { ...context, signal: abortController.signal } : context;
  const hookCall = Promise.resolve().then(() => hook(entry, hookContext));

  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
    });
    const raced = await Promise.race([hookCall, timeout]);
    if (raced && raced.__timeout === true) {
      if (abortController) abortController.abort();
      // The hook promise is still pending. Attach a no-op handler so that a
      // late rejection doesn't leak as an unhandled promise rejection, and a
      // late success can't accidentally touch caller state (we've already
      // returned). Without this, slow hooks that throw after the timeout
      // surface as "UnhandledPromiseRejection" in logs and their side
      // effects race with the next turn's state.
      hookCall.then(NOOP, NOOP);
      return { ok: false, timedOut: true, value: null, message: `hook exceeded ${timeoutMs}ms` };
    }
    return { ok: true, timedOut: false, value: raced === true, message: null };
  } catch (error) {
    return {
      ok: false,
      timedOut: false,
      value: null,
      message: normalizeThrownError(error).message
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function NOOP() {}

function categoryToKind(category) {
  if (category === "user_preference") return "preference";
  if (category === "project_context") return "decision";
  return "fact";
}

function readEntryText(entry) {
  if (entry.output && typeof entry.output.text === "string" && entry.output.text.trim()) {
    return entry.output.text.trim();
  }
  if (entry.metadata && typeof entry.metadata.text === "string" && entry.metadata.text.trim()) {
    return entry.metadata.text.trim();
  }
  if (typeof entry.text === "string" && entry.text.trim()) {
    return entry.text.trim();
  }
  return "";
}

function readNestedString(obj, ...keys) {
  let current = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") return "";
    current = current[key];
  }
  return typeof current === "string" ? current.trim() : "";
}

export { GLOBAL_MEMORY_MAX_ENTRIES, GLOBAL_MEMORY_MIN_CONFIDENCE, containsSensitiveContent, createGlobalMemoryEntry, isGlobalMemoryCandidate, mapSessionMemoryKindToGlobalCategory, mergeGlobalIntoSessionMemory, promoteToGlobalMemory };
