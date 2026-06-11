import { stampProvenance } from '../runtime/memory-entry.js';
import { requestSemanticMemoryExtraction } from '../runtime/semantic-memory.js';

const MEMORY_KINDS = new Set(["decision", "fact", "preference"]);

async function extractSessionMemoryEntries(options) {
  if (!options || !options.request) {
    return [];
  }

  const judged = await requestSemanticMemoryExtraction(options.request, {
    assistantMessage: options.assistantMessage,
    sessionContext: options.sessionContext,
    userMessage: options.userMessage
  });

  const provenance = normalizeProvenance(options.provenance);
  return judged.value.entries.map((entry) => createEntry(entry, provenance)).filter(Boolean);
}

function createEntry(entry, provenance) {
  const kind = readKind(entry && entry.kind);
  const slot = normalizeSlot(entry && entry.slot);
  const text = readString$4(entry && entry.text);

  if (!kind || !slot || !text) {
    return null;
  }

  const metadata = {
    confidence: clampConfidence(entry && entry.confidence),
    kind,
    slot,
    source: "auto_extract",
    status: "confirmed"
  };

  stampProvenance(metadata, provenance);

  return {
    input: { text, type: "text" },
    metadata,
    output: { text },
    skill: "session-memory-extractor",
    timestamp: new Date().toISOString()
  };
}

/**
 * Normalize caller-supplied provenance. Accepts `{threadId, turnId, readSources}`
 * where `readSources` is an array of `{url}` / strings collected from
 * `researchContext.readSources`. Returns a `{threadId, turnId, sources}` shape
 * that stampProvenance understands, or null when nothing usable is provided.
 */
function normalizeProvenance(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  if (typeof value.threadId === "string" && value.threadId.trim()) {
    out.threadId = value.threadId.trim();
  }
  if (typeof value.turnId === "string" && value.turnId.trim()) {
    out.turnId = value.turnId.trim();
  }
  if (typeof value.source === "string" && value.source.trim()) {
    out.source = value.source.trim();
  }
  const readSources = Array.isArray(value.readSources) ? value.readSources : [];
  const sources = [];
  for (const entry of readSources) {
    if (typeof entry === "string" && entry.trim()) {
      sources.push({ url: entry.trim() });
      continue;
    }
    if (entry && typeof entry === "object") {
      const url = typeof entry.url === "string" && entry.url.trim()
        ? entry.url.trim()
        : (typeof entry.href === "string" && entry.href.trim() ? entry.href.trim() : "");
      if (url) sources.push({ url });
    }
  }
  if (sources.length > 0) out.sources = sources;
  return Object.keys(out).length > 0 ? out : null;
}

function readKind(value) {
  const kind = readString$4(value);
  return MEMORY_KINDS.has(kind) ? kind : "";
}

function normalizeSlot(value) {
  return readString$4(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clampConfidence(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.8;
}

function readString$4(value) {
  return typeof value === "string" ? value.trim() : "";
}

export { extractSessionMemoryEntries };
