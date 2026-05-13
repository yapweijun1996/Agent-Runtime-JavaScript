# Long-Running & Multi-Topic Task Architecture

**Status:** Design proposal (tracked as AGRUN-141 through AGRUN-146)
**Date:** 2026-04-22
**Related:** [ADR 0002](./adr/0002-long-running-multi-topic-architecture.md), [context-and-continuity-model.md](./context-and-continuity-model.md), [evidence-graph-memory-architecture.md](./evidence-graph-memory-architecture.md), [planner-architecture.md](./planner-architecture.md)

## Problem Statement

End users report two failure modes on long, complex conversations:

1. **Information loss / wrong information.** Across many cycles agrun loses earlier context and the finalizer returns hallucinated or incorrect answers.
2. **Infinite retry loops.** The planner repeats failing actions (or self-corrections) until `maxSteps`.

A third failure mode appears on **multi-topic conversations** (user pivots A → B → back to A):

3. **Cross-topic contamination.** Evidence, tool history, and compaction summaries from topic A bleed into answers about topic B.

The root causes are architectural — not individual bugs. Four design assumptions do not hold on long, multi-topic sessions:

| Assumption | Fails because |
|---|---|
| Retry will naturally converge | No global failure budget; `MAX_CONSECUTIVE_ACTION_FAILURES` counts per-`actionName` only ([action-loop-session-loop.js:446](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js#L446)) |
| Context window compaction is lossless | [compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) trims `messages` but leaves `runState.toolContext.history` and `researchContext.readSources` untouched — the two timelines drift apart |
| Planner always sees the full context | Planner sees compacted window; finalizer reads raw `runState`. They disagree about "what we know now" |
| Session is a single linear thread | All state in [state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) is global; no concept of `threadId` or per-topic isolation |

## Symptom → Root Cause Map

| Symptom | Root Cause | File |
|---|---|---|
| Infinite loop on alternating failing tools | `countConsecutiveActionFailures` keyed by `actionName` only | [action-loop-session-loop.js:446-470](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js#L446) |
| Infinite loop on invalid planner decisions | `planner_invalid_action` branch only increments counter, no forced exit | [action-loop-session-loop.js:97-102](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js#L97) |
| Same tool + same args repeated forever | No action fingerprint / dedup | — (new) |
| Finalizer cites evidence planner never saw | `runtime-finalize.js` passes un-synced `toolContext` + compacted `projectedSessionContext` | [runtime-finalize.js:32-51](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-finalize.js#L32) |
| Evidence from topic A cited in topic B answer | `evidence.js` items lack `threadId` + `turnId` provenance | [evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js) |
| Planner drifts from original query after N cycles | `rawInput.text` is not re-injected verbatim each cycle | [planner-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js) |
| Compaction mixes unrelated topics into one summary | `compaction.js` groups by sessionId, not threadId | [compaction.js:58](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js#L58) |

## Target Architecture — Three-Layer State

The core design shift: separate **goal**, **knowledge**, and **transcript** into three layers with different lifecycle rules.

```
┌─────────────────────────────────────────────────┐
│ L1. GoalAnchor (immutable, per-thread)          │
│     - originalQuery (verbatim, never rewritten)  │
│     - decomposedSubgoals[]                        │
│     - successCriteria                             │
│     - userConstraints                             │
├─────────────────────────────────────────────────┤
│ L2. KnowledgeState (structured, versioned)       │
│     - facts[]  { value, source, turnId,         │
│                  threadId, confidence,           │
│                  supersededBy }                  │
│     - assumptions[]                               │
│     - openQuestions[]                             │
│     - dismissedPaths[]                            │
├─────────────────────────────────────────────────┤
│ L3. Transcript + ToolHistory (compressible)     │
│     - working memory, not source of truth        │
│     - per-thread; compaction safe                │
└─────────────────────────────────────────────────┘
```

Compaction contract:

| Layer | Compressible? | Rule |
|---|---|---|
| L1 GoalAnchor | Never | Injected verbatim every planner cycle |
| L2 facts | Only `supersededBy` entries may be pruned | Active facts survive compaction |
| L3 messages | Yes | Summarized per-thread, never cross-thread |
| L3 tool/research context | Yes | Trimmed in lockstep with L3 messages; scoped by `threadId` |

**Finalizer reads L1 + L2 only.** If a claim has no fact in L2 with provenance, the scrubber rejects it.

## Multi-Topic: Thread Model

A session becomes a tree of threads rather than a single line:

```
Session
 ├─ Thread A (Python debug)       ← own GoalAnchor + KnowledgeState
 │   turns [1, 3, 5, 8]
 ├─ Thread B (cooking)            ← own GoalAnchor + KnowledgeState
 │   turns [2, 4]
 └─ ThreadRouter (classifies each incoming turn)
```

Per-turn flow:

1. **Topic router** classifies the incoming user message against active/paused threads.
2. Decision is `continue_thread`, `new_thread`, `pivot_back`, or `ambiguous` → raise clarification.
3. Active thread is hydrated: its `GoalAnchor`, `KnowledgeState`, `toolContext`, `researchContext` are loaded into runState.
4. Other threads stay paused — their titles may be listed to the planner, but their content is not injected.

Isolation matrix:

| Resource | Scope |
|---|---|
| `GoalAnchor` | per-thread |
| `KnowledgeState.facts` | per-thread (`fact.threadId`) |
| `toolContext.history` | per-thread |
| `researchContext.readSources` | per-thread |
| `SessionBudget` (failures, cycles) | per-thread |
| `semantic-recall` queries | per-thread by default, cross-thread with explicit opt-in |
| `globalMemory` (user profile, prefs) | session-wide (unchanged) |

## Loop Convergence — Multi-Dimensional Budget

Replace the single `MAX_CONSECUTIVE_ACTION_FAILURES = 2` with a per-thread budget object:

```js
SessionBudget {
  totalFailures,           // cap 5 across all actions
  invalidDecisions,        // cap 3
  sameFingerprintRepeats,  // cap 2 (tool+args hash)
  cyclesSinceProgress,     // cap 5 (no new fact, no subgoal advance)
  wallClockMs,             // cap 5 min per thread
  tokensBurned             // cap from runtimeConfig
}
```

On any cap breach the flow is:

1. First breach → `force_replan` (planner prompted with the specific failure mode).
2. Replan also breaches → `ask_user` (use existing [clarification-state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/clarification-state.js)).
3. User does not resolve → honest finalize ("I'm stuck, here is what I know: …").

## Drift Detection

Every N cycles (default 5), compare embedding of recent action summary against `GoalAnchor.goal`:

| Cosine similarity | Action |
|---|---|
| ≥ 0.7 | none |
| 0.4 – 0.7 | inject reminder into next planner prompt |
| < 0.4 | force replan (severe drift) |

This is a cheap safeguard that catches cases where planner has semantically left the topic even though no single rule was violated.

## Planner Prompt Shape

Every cycle injects four blocks in a fixed order:

```
[ANCHOR]     original query (verbatim) + subgoal tree
[KNOWN]      KnowledgeState.facts with provenance
[UNKNOWN]    openQuestions
[ATTEMPTED]  dismissedPaths (avoid revisiting)
[NEXT]       current subgoal + available tools + budget remaining
```

This makes it explicit to the model what is established, what is still open, and what has been tried — the three things most likely to drift on long tasks.

## Cycle Commit Contract

Each cycle must produce a structured commit before advancing:

```js
cycleCommit = {
  factsAdded: Fact[],
  factsSuperseded: string[],        // fact ids
  subgoalProgress: { id, status },  // done | blocked | ongoing
  nextIntent: string,
  confidence: number
}
```

No commit → cycle is not marked complete and counts against `cyclesSinceProgress`. This forces the agent to produce observable progress rather than spinning.

## Mapping to Existing Scaffolding

Much of the machinery is already present; the refactor is largely extension + wiring, not new invention.

| Concept | Existing | Gap |
|---|---|---|
| Topic detection | [topic-like-task.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/topic-like-task.js), `inquiryContext.activeTopic` | No `threadId`, no routing |
| Goal anchor | [prompt-anchors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/prompt-anchors.js) `derivePromptAnchors()` | Not re-injected every cycle |
| Structured facts | [evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js) `EVIDENCE_KINDS` | No `turnId` / `threadId` / `confidence` |
| Clarification | [clarification-state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/clarification-state.js) | Works — reuse for topic ambiguity |
| Budget counters | [state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) `cycleCount`, `plannerInvalidCount` | No composite budget, no breach action |
| Compaction | [compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) | Not thread-aware; doesn't trim `toolContext` |
| Semantic recall | [semantic-recall.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/semantic-recall.js) | Global scope; no thread filter |
| Session store | [store-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-memory.js), [store-indexeddb.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-indexeddb.js) | Flat message list; add optional `threadId` field |
| Drift detection | — | None |
| Topic router | — | None |

## Rollout Plan (Six Phases)

All phases are additive: new fields default to safe values and old sessions fall onto `threadId = "default"`. No migration.

| Phase | Ticket | Scope | Files Touched | Effect |
|---|---|---|---|---|
| P0 | AGRUN-141 ✓ | Loop convergence (fingerprint + composite budget) | `action-loop-session-loop.js`, new `action-fingerprint.js` | Infinite loops ~90% gone |
| P1 | AGRUN-142 ✓ | Three-layer goal anchor (run-scope + thread-scope) injected verbatim into planner + finalizer system prompts | new `runtime/goal-anchor.js`, new `runtime/goal-anchor-config.js`, `state.js`, `action-loop-session.js`, `session/thread.js`, `session/handle.js`, `run-state-thread.js`, `planner-prompt.js`, `planner.js`, `action-loop-planner.js`, `runtime-finalize.js`, 5 `executeRuntimeFinalize` callsites | Planner + finalizer stay on verbatim query across cycles / compaction / follow-up turns |
| P2 | AGRUN-143 ✓ | Evidence provenance (`turnId`/`threadId`/`confidence`) + finalizer scoping | `evidence.js`, `final-response-sources.js`, `runtime-finalize.js` | Hallucination drop |
| P3 | AGRUN-144 ✓ | Topic Router + thread-scoped runState | new `topic-router.js`, new `thread.js`, `handle-turn.js`, stores | Multi-topic isolation |
| P4 | AGRUN-145 ✓ | Thread-aware compaction — per-thread summary store + `filterMessagesByThread` + `filterByThreadWindow` + hydration auto-trim | new `session/summary-key.js`, new `runtime/thread-provenance.js`, new `runtime/run-state-thread.js`, `compaction.js`, `session/prompt.js`, `session/handle.js`, `session/approval-resume.js`, all session stores | Long dialogs stable; cross-thread summary bleed eliminated |
| P5 | AGRUN-146 ✓ | Drift detector — Jaccard on tokenized goal vs trajectory + pluggable `similarityFn` + one-shot `runState.driftSignal` → `plannerDirectives` reminder | new `runtime/drift-detector.js`, new `runtime/drift-detection-config.js`, `action-loop-session-cycle.js`, `action-loop-planner.js`, `state.js`, `config.js` | Self-correction on long-running drift |

**AGRUN-145 shipped 2026-04-22** across 5 slices (A provenance stamping / B per-thread summary store / C thread-aware grouping / D post-compaction trim harness / E browser live smoke + docs). See [context-and-continuity-model.md § Thread-Aware Compaction](./context-and-continuity-model.md#thread-aware-compaction-agrun-145) for the harness matrix and [live-tests/agrun-145-slice-d-browser-smoke.md](./live-tests/agrun-145-slice-d-browser-smoke.md) for Chromium evidence.

**AGRUN-146 shipped 2026-04-22** across 3 slices (A drift-detector pure-function harness + 8 unit cases / B `beginActionLoopCycle` + planner-directives wiring + 6 wiring-unit cases / C docs + 8/8 browser smoke + doc sync). See [context-and-continuity-model.md § Goal-Drift Detector](./context-and-continuity-model.md#goal-drift-detector-agrun-146) for the lifecycle + config table and [live-tests/agrun-146-drift-detector-browser-smoke.md](./live-tests/agrun-146-drift-detector-browser-smoke.md) for Chromium evidence.

**AGRUN-142 shipped 2026-04-22** across 3 slices (A config normalizer + pure harness + 22 unit cases / B session-ctor capture + thread-anchor seeding + hydration mirror + planner/finalizer injection + 9 wiring-unit cases / C docs + browser smoke + doc sync). See [context-and-continuity-model.md § Goal Anchor Injection](./context-and-continuity-model.md#goal-anchor-injection-agrun-142) for the layer matrix + config table and [live-tests/agrun-142-goal-anchor-browser-smoke.md](./live-tests/agrun-142-goal-anchor-browser-smoke.md) for Chromium evidence.

## Out of Scope (for now)

- **Fully separate runtime per thread.** One runState with a per-thread view layer is simpler and enough.
- **Cross-thread evidence sharing UI.** User profile / global memory remains the only cross-thread channel.
- **Automatic thread closure.** Manual + inactivity-based, not LLM-judged.
- **Persistent subgoal tree UI.** Internal data structure only for v1.

## References

- [context-and-continuity-model.md](./context-and-continuity-model.md) — existing continuity model (single thread)
- [evidence-graph-memory-architecture.md](./evidence-graph-memory-architecture.md) — evidence system foundation
- [planner-architecture.md](./planner-architecture.md) — planner decision loop
- [runtime-state-and-memory-architecture.md](./runtime-state-and-memory-architecture.md) — runState shape
- [ADR 0002](./adr/0002-long-running-multi-topic-architecture.md) — decision record
