# Session Compaction Study — agrun vs openai-agents-js

**Date:** 2026-05-27  
**Ticket:** AGRUN-288  
**Type:** Spike / Research only — no code changes

---

## 1. What openai-agents-js does

### Interface
```typescript
// session.ts
interface OpenAIResponsesCompactionAwareSession extends Session {
  runCompaction(args?: {
    responseId?: string;
    compactionMode?: 'previous_response_id' | 'input' | 'auto';
    store?: boolean;
    force?: boolean;
  }): Promise<{ usage: RequestUsage } | null>
}
```

### When triggered
After every `persistRunItemsToSession()` call — meaning after each turn completes. `sessionPersistence.ts:runCompactionOnSession()` is the trigger point.

### What it actually does
**Server-side context replacement.** Calls OpenAI Responses API with `previous_response_id` — the OpenAI server replaces the full conversation history with a compressed summary on their side. The client only sends `{ previous_response_id: "..." }` instead of the full history in the next call.

### Key parameters
- `responseId` — ID of the last model response (server looks it up)
- `store: true/false` — whether OpenAI stores the conversation server-side
- `compactionMode: 'auto'` — let OpenAI decide when to compact

### Token cost
Compaction itself uses tokens (summarization). Usage is added to `RunContext.usage` so it's tracked in billing.

---

## 2. What agrun already has

### `filterByThreadWindow()` — `src/runtime/thread-provenance.js`
```javascript
filterByThreadWindow(entries, { thread, oldestPreservedTurnId })
  → trims toolContext.history + researchContext.readSources
```
- Triggered by `hydrateRunStateWithThread()` at each turn start
- Controlled by `hydration.compactionWindow.oldestPreservedTurnId`
- Client-side sliding window — no server involved, no extra tokens
- Provider-agnostic — works with OpenAI, Gemini, any provider

### `compactSystemPrompt` — `src/runtime/planner.js`
Different concept: lite models get a shorter system prompt. Not conversation compaction.

### `compactedAt` — `src/runtime/run-identity.js`
Session-level metadata timestamp. Not compaction logic itself.

---

## 3. Can agrun implement openai-agents-js's compaction?

**No — and it shouldn't.**

openai-agents-js compaction is tightly coupled to OpenAI Responses API:
- Requires `responseId` from the OpenAI server
- Requires server-side storage (`store: true`)
- Gemini, Anthropic, and other providers have no equivalent API
- agrun runs in the browser with no server — can't make server-side context replacements

**agrun's `filterByThreadWindow` IS the equivalent** — it's the client-side, provider-agnostic version of compaction. It solves the same problem (token explosion in long runs) without server dependency.

---

## 4. compactionPolicy hook (implemented in AGRUN-290)

openai-agents-js's design strength is that compaction is **pluggable** — hosts implement `Session.runCompaction()` and inject custom logic. agrun's `filterByThreadWindow` is hardcoded in `thread-provenance.js` — hosts cannot customize the trimming strategy.

### Recommended future addition (AGRUN-290)
```javascript
createRuntime({
  compactionPolicy: {
    maxTurns: 20,                       // slide window when history > 20 turns
    onCompact: async (history) => {     // host replaces default sliding window
      return history.slice(-10);        // keep last 10 turns
    }
  }
})
```

This lets hosts inject summarization (e.g., call an LLM to summarize old turns instead of discarding them), while the default behavior stays as the current sliding window.

AGRUN-290 implementation note:
- `compactionPolicy.maxTurns` trims in-flight provider history by turn-id groups before prompt construction.
- `compactionPolicy.onCompact(history, context)` receives a cloned history array and returns the replacement history.
- The hook affects only the current prompt/session-context view; it does not rewrite persisted session messages.
- Existing summary compaction and `filterByThreadWindow` still protect durable summaries and run-state evidence windows.

---

## 5. Conclusion

| Question | Answer |
|----------|--------|
| Can agrun implement openai-agents-js's compaction? | No — it's OpenAI Responses API specific |
| Does agrun need compaction? | It already has it (`filterByThreadWindow`) |
| Is agrun's compaction structurally compatible? | It's a different mechanism solving the same problem |
| What should agrun add? | A `compactionPolicy` host hook (AGRUN-290) to make trimming pluggable |
| Any code change needed in this ticket? | Completed in AGRUN-290 |

**agrun's current compaction is production-ready for multi-provider browser deployments. The only improvement is making the policy injectable (AGRUN-290).**
