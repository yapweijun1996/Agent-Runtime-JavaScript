import { stampProvenance } from '../memory-entry.js';
import { readString } from '../semantic-json.js';

// Model-initiated durable memory (standing-instruction fix, 2026-07-03).
//
// WHY AN ACTION: the only other judgment point for "is this worth remembering"
// is the per-turn extraction LLM call, which hosts may disable for cost
// (memoryExtractionPolicy, AGRUN-517) and which only runs AFTER the turn.
// Giving the planner a tier-0 memory action moves that judgment into the
// model's own in-loop reasoning — zero extra LLM calls, no keyword matching,
// language-agnostic. The runtime stays pure plumbing: it stores exactly what
// the AI decided to store, in the same entry shape the extractor produces, so
// everything downstream (evidence classification, Confirmed Preferences
// prompt injection, last-wins slot supersede, global-memory promotion) works
// unchanged.
//
// Memory persistence is a session capability: entries pushed here ride
// result.memoryEntriesAdded, which session.run appends to the session store.
// Under plain runtime.run the entry still reaches the host on the result, but
// nothing persists it — same contract as extractor output.

const MEMORY_KINDS$2 = new Set(["decision", "fact", "preference"]);

const rememberAction = Object.freeze({
  description: "Store a durable user preference, fact, or decision in session memory so future turns and topics honor it.",
  name: "remember",
  planner: {
    aliases: ["remember_preference", "save_memory"],
    argsExample: { kind: "preference", slot: "reply_language", text: "User wants every reply written in Mandarin Chinese." },
    argsSchema: {
      kind: {
        description: "Memory category: 'preference' (a standing instruction or taste about how to behave — applies to every future topic), 'fact' (a stable statement about the user or their world), or 'decision' (a settled choice for the current work).",
        required: true,
        type: "string"
      },
      slot: {
        description: "Short snake_case topic key (e.g. 'reply_language', 'user_name'). Reusing a slot replaces the previous value, so use the same slot to update or revoke an earlier memory.",
        required: true,
        type: "string"
      },
      text: {
        description: "The durable statement to remember, written as a complete standalone sentence about the user (e.g. 'User wants every reply written in Mandarin Chinese.').",
        required: true,
        type: "string"
      }
    },
    guidance: "When the user states something meant to persist beyond the current turn — a standing instruction ('always reply in Mandarin', 'keep answers short'), a stable fact about themselves, or an explicit 'remember ...' request — call remember to store it, then continue with the answer in the same turn. Preferences apply to every future topic until the user changes them; store an update to the same slot to revise or revoke. Do not use remember for one-off task details that only matter this turn."
  },
  tier: 0,
  execute: executeRememberAction,
  outputSchema: {
    controls: ["continue"],
    kinds: ["memory_saved", "memory_rejected"],
    metrics: {}
  }
});

async function executeRememberAction(context, args) {
  const text = readString(args && args.text);
  const requestedKind = readString(args && args.kind);
  const slot = normalizeSlot$1(args && args.slot);

  if (!text || !slot) {
    return {
      control: "continue",
      output: {
        kind: "memory_rejected",
        reason: !text ? "missing_text" : "missing_slot",
        text: "Nothing was stored: remember requires a non-empty text and a snake_case slot."
      },
      summary: "remember rejected: missing text or slot"
    };
  }

  // Unknown categories default to preference — the standing-instruction case
  // this action exists for — and the summary tells the model about the
  // normalization so it can correct the category next time if it disagrees.
  const kind = MEMORY_KINDS$2.has(requestedKind) ? requestedKind : "preference";
  const metadata = {
    confidence: 0.9,
    kind,
    slot,
    source: "model_initiated",
    status: "confirmed"
  };
  stampProvenance(metadata, readProvenance(context));

  const entry = {
    input: { text, type: "text" },
    metadata,
    output: { text },
    skill: "session-memory",
    timestamp: new Date().toISOString()
  };

  const sink = context && Array.isArray(context.memoryEntriesAdded) ? context.memoryEntriesAdded : null;
  if (sink) {
    sink.push(entry);
  }

  return {
    control: "continue",
    output: {
      kind: "memory_saved",
      memoryKind: kind,
      persisted: Boolean(sink),
      slot,
      text: `Stored ${kind} '${slot}': ${text}`
    },
    summary: kind === requestedKind
      ? `remember stored ${kind} '${slot}'`
      : `remember stored '${slot}' as ${kind} (unrecognized kind '${requestedKind}' normalized)`
  };
}

function readProvenance(context) {
  const runState = context && context.runState && typeof context.runState === "object" ? context.runState : {};
  const out = { source: "model_initiated" };
  const threadId = readString(runState.threadId);
  if (threadId) out.threadId = threadId;
  const runId = readString(runState.runId);
  if (runId) out.turnId = runId;
  return out;
}

function normalizeSlot$1(value) {
  return readString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export { executeRememberAction, rememberAction };
