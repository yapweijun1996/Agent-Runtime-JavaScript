import { stringifySessionContent } from '../session/content.js';
import { requestSemanticJudge } from './semantic-judge.js';
import { readArray, readObject, readString, readNumber } from './semantic-json.js';

const MEMORY_KINDS$1 = new Set(["decision", "fact", "preference"]);

async function requestSemanticMemoryExtraction(request, options) {
  const systemPrompt = [
    "You extract semantic memory for agrun.js.",
    "Scope: cross-session long-term memory. Only extract items that are still true and useful the NEXT time the user starts a session.",
    "Return JSON only.",
    'Output shape: {"entries":[{"kind":"fact|preference|decision","slot":"...","text":"...","confidence":0.0}]}',
    "",
    "Kind definitions:",
    '- "preference": user-declared durable choice ("I prefer SGD", "call me by first name"). Must be first-person or a clear user statement.',
    '- "fact": a durable real-world fact about the user, their role, their organization, or a long-lived artifact. Must remain true across sessions.',
    '- "decision": a deliberate forward-looking choice the user or team has committed to ("we will standardize on X"). Must be durable, not a one-time action.',
    "If an item does not clearly fit one of the three, DO NOT emit it.",
    "",
    "Hard rejection rules. Emit NOTHING for entries that match any of these:",
    "- Transient intent or one-shot goal (e.g. 'user wants to view top 10 invoices today').",
    "- Time-scoped result that will go stale (e.g. 'no sales invoices for April 2026', 'item X was out of stock today').",
    "- Negative search result ('item not found', 'no records for ...'). These flip to true the moment the data is added.",
    "- Speculative, contradictory, or hedged restatement of something already uncertain.",
    "- Tabular or list-shaped data dumps (amounts by location, top-N lists, category breakdowns). These are query outputs, not memory.",
    "- A value that is primarily a specific business identifier (document number, invoice number, order code, stock code, part number, lot number). Identifiers are rarely stable durable facts and are a common hallucination surface.",
    "- A value that reads like a short opaque code with no natural-language content, is mostly digits/punctuation/separators, is a UUID, or would not be meaningful read aloud as a preference or fact.",
    "- Entries whose INFORMATION VALUE is primarily a specific business identifier, even when the identifier is wrapped in natural-language sentences (e.g. 'POM-9999 is the most important order', 'SIV-2025-001 is the key invoice'). Strip the identifier mentally — if nothing durable remains, do not emit. This applies EVEN WHEN the user explicitly says 'remember this', 'mark as important', or 'note down': such identifiers are session context, not durable cross-session memory, and they go stale quickly. They belong in chat history, not global memory.",
    "- Entries whose specifics do not actually appear in the user message or assistant answer above (do not invent identifiers, amounts, dates, or names).",
    "",
    "Confidence rubric. Report a CONTINUOUS value in [0, 1] that reflects your own certainty. Do not default to 1.0; 1.0 means 'cannot be wrong' and is almost never appropriate for extracted memory. Use the following anchors:",
    "- 0.90-0.99: user explicitly stated the item in this turn in unambiguous first-person terms. Even very short, obvious preferences ('I prefer Chinese', 'I like SGD') should not reach 1.0 — reserve 1.0 for items where you can justify 'this cannot be wrong.' Short or obvious does not mean certain.",
    "- 0.75-0.89: strongly implied by the user, or stated by the assistant and confirmed by the user in the same turn.",
    "- 0.55-0.74: inferred from context, plausible but not directly stated.",
    "- below 0.55: weak inference. Do NOT emit; drop the entry instead.",
    "Different entries in the same response should typically have different confidence values. If every entry you produce has confidence 1.0, you are almost certainly over-confident and should recalibrate before returning.",
    "",
    "Slot naming: short snake_case noun describing the category of the memory (e.g. 'preferred_currency', 'reporting_cadence'). Do not put values, dates, amounts, or tenant data into the slot.",
    "",
    "If nothing qualifies, return {\"entries\":[]}. Empty output is correct and preferred over speculation."
  ].join("\n");
  const prompt = buildMemoryPrompt(options);
  const { response, text, value } = await requestSemanticJudge(request, {
    prompt,
    systemPrompt
  });

  return {
    response,
    text,
    value: normalizeExtractionValue(value)
  };
}

function buildMemoryPrompt(options) {
  return [
    "User message:",
    readMessageText$1(options && options.userMessage) || "None",
    "",
    "Assistant final answer:",
    readMessageText$1(options && options.assistantMessage) || "None",
    "",
    "Session context summary:",
    JSON.stringify(options && options.sessionContext ? options.sessionContext : null, null, 2)
  ].join("\n");
}

function normalizeExtractionValue(value) {
  const record = readObject(value) || {};
  return {
    entries: readArray(record.entries)
      .map((item) => normalizeEntry(item))
      .filter(Boolean)
  };
}

function normalizeEntry(value) {
  const record = readObject(value);

  if (!record) {
    return null;
  }

  const kind = readString(record.kind);
  const slot = readString(record.slot);
  const text = readString(record.text);

  if (!MEMORY_KINDS$1.has(kind) || !slot || !text) {
    return null;
  }

  return {
    confidence: clampConfidence$1(readNumber(record.confidence, 0.8)),
    kind,
    slot,
    text
  };
}

function readMessageText$1(message) {
  return message && message.content ? stringifySessionContent(message.content) : "";
}

function clampConfidence$1(value) {
  if (!Number.isFinite(value)) {
    return 0.8;
  }

  return Math.max(0, Math.min(1, value));
}

export { requestSemanticMemoryExtraction };
