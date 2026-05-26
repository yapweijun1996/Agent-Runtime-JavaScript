# ADR-0039: Compaction as a Real Session Turn (opencode adoption)

## Context

agrun's planner prompt grows monotonically across cycles. Every cycle
loads the full `runState.loopFields` projection (terminalRepairState,
actionPatternConvergence, researchReportLoop, requirementRecoveryEvaluator,
sources ledger, etc.). Empirical measurement 2026-05-26: by cycle 10 the
prompt is 30-40 KB; by cycle 21 it has hit 40+ KB. Past ~50 cycles, any
provider's effective context (Gemini Flash ~128k tokens / OpenAI
gpt-5-mini ~200k tokens) starts to get tight, and the planner suffers
"needle in a haystack" degradation as the model loses track of older
instructions.

opencode's `session/compaction.ts` solves this with a real session turn
pair:

- `isOverflow({tokens, model})` returns whether
  `input + cache.read + output > model.limit.input || (context -
  min(output, OUTPUT_TOKEN_MAX))`. Pure function.
- `prune({sessionID})` walks messages backwards and marks the `output`
  of old tool calls as `compacted` (with timestamp), preserving
  `PRUNE_PROTECT = 40_000` tokens of recent tool calls verbatim. Stops
  on a prior compaction boundary or after 2 user turns.
- Compaction trigger: if `isOverflow` OR a pending `CompactionPart`
  exists, the processor invokes the hidden `compaction` agent with
  "provide a detailed prompt for continuing our conversation". The
  reply becomes a real assistant message that the next planner turn
  reads as the conversation prefix.
- Subsequent loops hide prior completed compaction pairs from the
  planner prompt but keep them on disk for replay/audit.

agrun has **none** of this today. Long sessions just keep growing
until provider context overflows and the run fails ugly.

Affected modules / contracts:
- [src/runtime/state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) — `runState.tokenUsage`
  needs an upgraded shape so `isOverflow` can read input/cache/output
  separately.
- [src/runtime/planner-prompt-builder.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt-builder.js)
  (or equivalent) — must consume the latest compaction summary as the
  conversation prefix instead of the full history.
- [src/runtime/session-message-store.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/session-message-store.js)
  (from ADR-0038) — compaction reads + writes message parts; cannot
  function without per-part storage. **Hard prerequisite.**
- Provider adapters (OpenAI, Gemini, AI SDK) — must surface model
  context window limits per request.
- KB cross-references: `kb_recall "opencode compaction"` returns the
  differential memo + the opencode-side procedural memo.

## Decision

Add `src/runtime/session-compaction.js` exposing three pure-ish
functions:

```js
isOverflow({ tokenUsage, modelLimit })
  → { overflow: boolean, ratio: number, breakdown: { input, cache, output, usable } }

selectCompactionTargets({ messages, parts, protectTokens = 40000 })
  → { compactablePartIDs: Array<string>, preservedTailMessages: Array<msgID> }

runCompactionTurn({ runtime, sessionID, compactionPromptOverride? })
  → { compactPart, summaryMessage } — both persisted via storage
```

And one runtime-loop integration point in
`action-loop-session-loop.js`:

```js
// at top of each cycle, before building planner prompt:
const limit = providerAdapter.getModelLimit(model);
const usage = runState.tokenUsage;
if (isOverflow({ tokenUsage: usage, modelLimit: limit }).overflow) {
  await runCompactionTurn({ runtime, sessionID });
  // next iteration's prompt builder will use the new summary
  continue;
}
```

### Token usage shape

`runState.tokenUsage` becomes:

```js
{
  input: number,           // tokens sent to model in last call
  cache: { read: number }, // prompt-cache read tokens (Anthropic, etc)
  output: number,          // tokens received from model in last call
  cumulative: {            // running totals across all cycles
    input: number,
    output: number,
    cache: { read: number },
  },
}
```

Provider adapters fill the per-call fields. Cumulative is maintained
by the cost ledger ([cost-ledger.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/cost-ledger.js))
which already tracks token totals — minor extension.

### Provider model limit shape

Provider adapters expose:

```js
adapter.getModelLimit(model)
  → { context: number, input?: number, output: number }
```

Defaults if a provider doesn't surface limits: `context = 128_000,
output = 8_192`. Conservative; can be tuned per provider.

### Compaction agent

The compaction agent is a special invocation that:

1. Receives the session's existing summary (if any) as a prefix.
2. Receives the new conversation segment to compact (oldest to
   most-recent-compactable).
3. Returns a concise summary that becomes the next session's
   conversation prefix.

It can be:
- The same model as the parent run (opencode default — simpler).
- A user-selected cheaper model
  (`runtime.options.compactionModel = "gemini-flash-lite"`).

Default: parent's model. ADR-0039 implementation slice 1 ships with
this default; user override is a small follow-up.

### What gets compacted vs preserved

Compactable:
- `tool` parts with `state.output` older than `protectTokens` from the
  tail.
- `reasoning` parts older than 2 prior user turns.
- Provider-text-delta accumulated text from old assistant turns.

Preserved (never compacted, even if old):
- Active workspace candidate state (`workspaceDiagnostics`).
- Active terminal-repair signal.
- Active source ledger entries that are still cited in the latest
  candidate.
- The most recent assistant turn (current in-flight cycle).
- The most recent user prompt and any clarification responses.

This is the agrun-specific guardrail: compaction must not destroy the
readinessAudit chain. Conservative whitelist; verify with
`test/unit/session-compaction-preserve-list.test.js`.

### Bus events

- `compaction.started { sessionID, reason: "overflow" | "manual",
  inputTokens, ratio }` — emitted just before `runCompactionTurn`.
- `compaction.completed { sessionID, summaryMessageID, compactedPartIDs:
  Array<id>, durationMs, savedTokensEstimate }` — emitted on completion.

Both flow through `runtime.subscribeEvents` (ADR-0036). External
inspectors see compaction as a first-class lifecycle event.

### Out of scope

- Cross-session memory ingestion (running compactions could feed a
  long-term memory store; orthogonal to this ADR).
- Compaction over branch / fork sessions (assumes linear session).
- Re-expansion of compacted content (read-only after compaction).

## Alternatives

1. **Sliding-window prompt truncation only**. Drop oldest history when
   prompt exceeds N tokens. Rejected: loses tool-call provenance the
   model needs for follow-up reasoning. opencode's pattern preserves a
   summary, not the raw old history — better information density.

2. **No compaction, hard-cap session at 50 cycles**. Forces hosts to
   restart sessions. Rejected: agrun's strength is long-form runs;
   capping them at 50 cycles is a regression vs the current
   convergence loop.

3. **Compact via a non-LLM rule-based summarizer**. Deterministic
   summaries are too lossy. Rejected: an LLM summary of a long
   session is information-dense in a way a regex extraction cannot
   match.

4. **Compact silently inside the prompt builder, not as a session
   turn**. Tempting because it's fewer messages. Rejected: opencode's
   key insight — compaction as a real turn pair lets you REPLAY a
   session by reading messages in order; a silent in-prompt
   compaction destroys replay.

## Consequences

- Pros:
  - Sessions can run to 100+ cycles without provider context overflow.
  - Replayable: a future debugger reading per-message JSON sees the
    compaction summary as a normal turn.
  - External inspectors get a clear `compaction.started/completed`
    signal on the bus.
  - Token cost can drop substantially per long run — old verbose tool
    outputs are summarized into ~500 tokens of useful prior-context.

- Cons:
  - One extra LLM call per compaction event (rare, 1-2 per long run
    typical).
  - Compaction agent adds latency to the cycle in which it runs.
  - Adds non-trivial logic (~250 lines + tests).

- Risks:
  - **Preserved-list bugs**. If compaction drops a source ledger
    entry that's still cited, the source-density gate fails the
    next cycle. Mitigation: ship with conservative preservation +
    `test/unit/session-compaction-preserve-list.test.js`. Live e2e
    smoke before promoting to default-on.
  - Provider adapters lacking accurate `getModelLimit` cause
    `isOverflow` to under-trigger or over-trigger. Mitigation:
    conservative defaults + per-provider unit tests.
  - User confusion: a compacted session might "lose context" the user
    expected. Mitigation: bus event surface lets the host UI display
    "agent compacted older history" with what was kept.

## Rollback

- Delete `src/runtime/session-compaction.js`.
- Remove `isOverflow` check from `action-loop-session-loop.js`.
- Remove `compactionModel` option from `createRuntime`.
- Existing sessions that ran with compaction enabled remain readable;
  the compaction summary message is just a normal assistant message
  in storage. No migration needed.
- The `compaction.started/completed` bus events stop firing; no
  consumer should crash on their absence (they're discoverable, not
  required).

## Verification (when implemented)

- **Unit (isOverflow)**: `test/unit/session-compaction-is-overflow.test.js`
  — input/output/cache combinations × provider limits; assert
  `overflow: true` only when `input + cache.read + output > usable`.

- **Unit (selectCompactionTargets)**: synthetic 20-message session;
  assert tail messages are preserved; assert workspace + source ledger
  + terminal-repair refs survive; assert older tool outputs are flagged
  compactable.

- **Unit (runCompactionTurn)**: mock provider returning a fixed
  summary; assert summary message is persisted; assert
  `compaction.started/completed` events fire via mock event ledger.

- **Smoke**: long-form 60-cycle run with compaction enabled; assert
  no provider context overflow; assert at least one compaction event
  fires; assert final readinessAudit gates still pass.

- **Live e2e**: extend
  [test/node-agrun-3000-live.mjs](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/node-agrun-3000-live.mjs)
  with `--simulate-overflow` flag that artificially shrinks the
  provider context to force compaction; assert run reaches 3000
  words anyway.

- **Replay smoke**: with ADR-0038 storage enabled, replay a compacted
  session and assert the per-message reconstruction includes the
  compaction summary correctly.
