import { readString } from './semantic-json.js';

// AGRUN-426 — Working Memory: a structured JSON consolidation of the durable
// memory the AI extracted (semantic-memory.js / session extractor emits
// { metadata:{ kind, slot }, output:{ text } } entries with kind in
// fact|preference|decision and a snake_case slot key).
//
// AI-FIRST: the AI decides WHAT is durable (the extraction LLM produces the
// entries); this is a pure mechanical projection that GROUPS them — it never
// invents, judges, or rewrites a fact. JSON because it is the standard, host-
// friendly shape (maintainer decision 2026-06-14).
//
// Shape: { facts: {slot: text}, preferences: {slot: text}, decisions: {slot: text} }
// keyed by slot, LAST-WINS — re-extracting the same slot overwrites it, which is
// the cross-turn deep-merge semantics (a host accumulating entries across turns
// and projecting gets a consolidated working memory; the runtime result exposes
// the current run's projection, read-only).

const KIND_TO_BUCKET = Object.freeze({
  fact: "facts",
  preference: "preferences",
  decision: "decisions"
});

function readEntryText$1(entry) {
  if (entry && entry.output && typeof entry.output === "object") {
    const out = readString(entry.output.text);
    if (out) return out;
  }
  if (entry && entry.input && typeof entry.input === "object") {
    const inp = readString(entry.input.text);
    if (inp) return inp;
  }
  return readString(entry && entry.text);
}

function createWorkingMemory() {
  return { facts: {}, preferences: {}, decisions: {} };
}

function projectWorkingMemory(entries) {
  const working = createWorkingMemory();
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    const kind = readString(metadata.kind);
    const bucket = KIND_TO_BUCKET[kind];
    if (!bucket) continue;
    const slot = readString(metadata.slot);
    if (!slot) continue;
    const text = readEntryText$1(entry);
    if (!text) continue;
    working[bucket][slot] = text;
  }
  return working;
}

export { createWorkingMemory, projectWorkingMemory };
