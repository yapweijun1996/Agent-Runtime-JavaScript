// AGRUN-419-followup — shared fullStream pump for every browser provider.
// The ai-SDK `streamText` result exposes a `fullStream` whose parts include
// `text-delta` (the answer) AND `reasoning-delta` (the model's live thinking,
// e.g. gemini thoughts / openai reasoning summary). Providers used to iterate
// `result.textStream`, which drops reasoning on the floor — so the long
// time-to-first-token wait looked frozen. Routing through `fullStream` lets the
// runtime surface reasoning as provider-reasoning-delta stream events while the
// model is still thinking.
//
// SSOT: openai / gemini / deepseek all import this one pump so the part-type
// dispatch can never drift between providers (CLAUDE.md "shared module, not
// copy-paste" rule). A provider/model that emits no reasoning parts simply
// never triggers the onReasoning branch — graceful degradation, no error.
async function pumpProviderFullStream(result, { onToken, onReasoning } = {}) {
  const emitToken = typeof onToken === "function" ? onToken : null;
  const emitReasoning = typeof onReasoning === "function" ? onReasoning : null;
  // No consumer for either channel: skip iteration. The caller still awaits
  // result.text / result.usage afterwards, which drains the stream internally.
  if (!emitToken && !emitReasoning) return;

  for await (const part of result.fullStream) {
    if (!part || typeof part !== "object") continue;
    // ai v6 `fullStream` (TextStreamPart) carries the chunk on `text`; older /
    // lower-level part shapes use `delta`. Read text first, fall back to delta.
    const chunk = typeof part.text === "string"
      ? part.text
      : (typeof part.delta === "string" ? part.delta : "");
    if (!chunk) continue;
    if (part.type === "text-delta") {
      if (emitToken) {
        try { emitToken(chunk); } catch (_ignored) { /* consumer error */ }
      }
    } else if (part.type === "reasoning-delta") {
      if (emitReasoning) {
        try { emitReasoning(chunk); } catch (_ignored) { /* consumer error */ }
      }
    }
  }
}

export { pumpProviderFullStream };
