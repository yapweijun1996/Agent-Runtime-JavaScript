# ADR 0002: Long-Running & Multi-Topic Task Architecture (Apr 2026)

## Context

End-user reports and a codebase review surfaced three failure modes on long
and complex conversations:

1. **Information loss / wrong answers** after many cycles — the finalizer
   cites evidence the planner never saw and hallucinates conclusions.
2. **Infinite retry loops** — planner repeats failing tools or oscillates
   between tools; `MAX_CONSECUTIVE_ACTION_FAILURES=2` in
   [action-loop-session-loop.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js)
   keys on `actionName`, so alternating two failing tools never trips the
   guard.
3. **Cross-topic contamination** — on multi-topic chats (A → B → back to A)
   tool history, research sources, and compacted summaries from topic A leak
   into topic B answers, because [evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js)
   and [compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js) are thread-blind.

The four failing design assumptions:

- Retry will naturally converge (no global failure budget).
- Context compaction is lossless (trims `messages` but not
  `runState.toolContext.history` / `researchContext.readSources`).
- Planner and finalizer share the same view of "what we know" (they don't
  — planner sees compacted window, finalizer reads raw `runState`).
- Session is a single linear thread (all state in
  [state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) is global; no `threadId`).

Affected modules:
[src/runtime/action-loop-session-loop.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js),
[src/runtime/runtime-finalize.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-finalize.js),
[src/runtime/planner-prompt.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js),
[src/runtime/state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js),
[src/runtime/evidence-state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/evidence-state.js),
[src/session/evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js),
[src/session/compaction.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/compaction.js),
[src/session/prompt-anchors.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/prompt-anchors.js),
[src/session/store-memory.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-memory.js),
[src/session/store-indexeddb.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/store-indexeddb.js).

Design document: [agrun_docs/long-running-multi-topic-tasks.md](../long-running-multi-topic-tasks.md).

## Decision

Adopt a three-layer state model (GoalAnchor / KnowledgeState / Transcript)
with thread-scoped isolation, and roll it out in six additive phases
(AGRUN-141 … AGRUN-146). All phases preserve backward compatibility: new
fields default to safe values, old sessions fall onto `threadId = "default"`,
no migration is required.

### 1. Three-layer state

- **L1 GoalAnchor** — immutable, per-thread. Holds the verbatim original
  query, subgoal decomposition, success criteria, and user constraints.
  Injected into every planner cycle. Never summarized or compacted.
- **L2 KnowledgeState** — structured facts with provenance
  (`turnId`, `threadId`, `source`, `confidence`, `supersededBy`). Extends
  existing [evidence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/session/evidence.js). Compaction may
  prune superseded entries but never touches active ones.
- **L3 Transcript + ToolHistory** — working memory. Compressible. Scoped
  by `threadId`; tool/research context is trimmed in lockstep with the
  message window so the timelines cannot drift apart.

The finalizer reads L1 + L2 only. Claims without a backing fact in L2 are
rejected by the scrubber.

### 2. Thread model

A session becomes a tree of threads. A new `topic-router.js` classifies each
incoming user message against active and paused threads
(`continue_thread` / `new_thread` / `pivot_back` / `ambiguous`). Ambiguous
routing reuses the existing [clarification-state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/clarification-state.js)
to ask the user.

Per-thread scope: `GoalAnchor`, `KnowledgeState.facts`, `toolContext.history`,
`researchContext.readSources`, `SessionBudget`, default `semantic-recall`
scope. Session-wide scope: `globalMemory` (user profile, preferences).

### 3. Multi-dimensional session budget

Replace the single consecutive-failure counter with a per-thread
`SessionBudget` tracking `totalFailures`, `invalidDecisions`,
`sameFingerprintRepeats`, `cyclesSinceProgress`, `wallClockMs`,
`tokensBurned`. Breach sequence: `force_replan` → `ask_user` → honest
finalize. A new `action-fingerprint.js` hashes `name + stableStringify(args)`
so the same tool with identical arguments cannot repeat silently.

### 4. Cycle commit contract

Each cycle must produce a structured commit
(`factsAdded`, `factsSuperseded`, `subgoalProgress`, `nextIntent`,
`confidence`). Cycles without a commit count against `cyclesSinceProgress`,
preventing "spinning without progress" failures.

### 5. Drift detection

Every N cycles (default 5), compare embedding of recent action summary
against `GoalAnchor.goal`. Severe drift (cosine < 0.4) triggers replan;
mild drift (0.4–0.7) injects a reminder into the next planner prompt.

### 6. Planner prompt shape

Every cycle injects a fixed block order:
`[ANCHOR] [KNOWN] [UNKNOWN] [ATTEMPTED] [NEXT]`. This makes established
facts, open questions, and dismissed paths explicit so the model does not
silently revise any of them.

## Alternatives

1. **Bigger context window instead of thread isolation.** Rejected: token
   cost grows linearly and cross-topic contamination is a structural issue,
   not a capacity issue. A million-token window still lets evidence from
   topic A be cited when answering topic B.
2. **Separate runtime per thread.** Rejected for v1: doubles state
   management complexity and complicates the session store. A single
   runState with a per-thread projection layer gives the same isolation
   with far fewer moving parts.
3. **LLM-judged thread boundaries only (no structured `threadId`).**
   Rejected: the judge itself is a context consumer and its decisions are
   not auditable. Structured `threadId` lets compaction, finalizer, and
   semantic recall all agree on scope deterministically.
4. **Raise `MAX_CONSECUTIVE_ACTION_FAILURES` and hope for the best.**
   Rejected: does not address alternating-tool loops or invalid-decision
   loops, and does nothing for contamination or drift.

## Consequences

- **Pros:**
  - Infinite loops eliminated by composite budget + fingerprint dedup.
  - Finalizer hallucination reduced by provenance-gated evidence.
  - Multi-topic chats become first-class rather than a known bad case.
  - Existing sessions continue to work (`threadId = "default"`).
  - Most scaffolding (`topic-like-task.js`, `evidence.js`,
    `clarification-state.js`, `prompt-anchors.js`) already exists — the
    change is largely wiring and extension.

- **Cons:**
  - Six tickets of work across runtime and session layers.
  - Planner prompt grows by the anchor + facts blocks (net token cost
    offset by better convergence — fewer wasted cycles).
  - Topic router adds one classifier call per user turn.

- **Risks:**
  - Topic router misclassification → raise `ambiguous` early to let the
    user decide; never silently open a new thread.
  - Provenance on synthesized facts is fuzzy (LLM-inferred assumptions);
    mark them `kind: "inferred"` with lower default confidence.
  - Drift detector false positives on legitimate topic refinements; tuned
    by cycle-interval + two-tier threshold (mild vs severe).

## Rollback

Each phase (AGRUN-141 … AGRUN-146) ships behind a config flag so individual
features can be disabled without redeploy:

- `runtimeConfig.budget.*` — fall back to current single-counter guard.
- `runtimeConfig.goalAnchor.enabled` — disable per-cycle anchor injection.
- `runtimeConfig.threads.enabled` — collapse all turns to `"default"`
  thread; router and routing classifier become no-ops.
- `runtimeConfig.driftDetection.enabled` — skip drift checks.

Rollback files to restore: none — additive only. No schema migration, no
contract change. Worst case: revert the PRs in reverse order.

## Implementation Status (2026-04-22)

| Phase | Ticket | Status | Notes |
|-------|--------|--------|-------|
| P0 | AGRUN-141 | ✓ Shipped | Composite budget + `action-fingerprint.js` |
| P1 | AGRUN-142 | ✓ Shipped | Three-layer goal-anchor injection (run-scope `runState.originalQuery` + thread-scope `thread.goalAnchor.text` mirrored via hydration); planner + finalizer system-prompt injection; enabled by default |
| P2 | AGRUN-143 | ✓ Shipped | Evidence provenance + finalizer scope filter |
| P3 | AGRUN-144 | ✓ Shipped | Topic router, thread-scoped runState, chat divider + Inspector Threading index |
| P4 | AGRUN-145 | ✓ Shipped | Thread-aware compaction (5 slices A/B/C/D/E) |
| P5 | AGRUN-146 | ✓ Shipped | Drift detector (3 slices A harness / B wiring / C docs + browser smoke); default Jaccard + pluggable `similarityFn`; disabled by default |

**AGRUN-142 harness summary** (for future auditors):
- `src/runtime/goal-anchor.js` — `captureOriginalQuery`, `readGoalAnchorView`, `formatGoalAnchorBlock`, `seedThreadGoalAnchor`, `GOAL_ANCHOR_BLOCK_HEADERS`. Pure functions; immutability contract enforced by "if existing, return existing" (no `Object.freeze`). Same-text L1/L2 dedupe avoids double-injection.
- `src/runtime/goal-anchor-config.js` — `normalizeGoalAnchorConfig` (default `{enabled: true, maxAnchorChars: 4000, includeThreadAnchor: true}`); extracted to bypass `virtual:` bundler aliases in unit tests.
- `src/runtime/state.js` — `originalQuery: ""` + `threadGoalAnchorText: ""` first-class fields on initial runState.
- `src/runtime/action-loop-session.js` — `captureOriginalQuery(runState, {inputText, requestPrompt})` called at session ctor.
- `src/session/thread.js` — `applyRouterVerdict` seeds `goalAnchor` on `new_thread`; `bumpThread` lazy-seeds legacy threads without overwriting existing text.
- `src/session/handle.js` — hydration payload now carries `goalAnchorText` pulled from `applied.activeThread.goalAnchor.text`.
- `src/runtime/run-state-thread.js` — `hydrateRunStateWithThread` mirrors `hydration.goalAnchorText → runState.threadGoalAnchorText` (trimmed).
- `src/runtime/planner-prompt.js` — `buildPlannerSystemPrompt` accepts `opts.goalAnchorBlock`, emits it between `roleBlock` and `dynamicSystemPrompt` (cache-friendly position).
- `src/runtime/planner.js` — both `buildPlannerSystemPrompt` callsites thread `goalAnchorBlock` through.
- `src/runtime/action-loop-planner.js` — `buildGoalAnchorBlockForCycle(runState, options)` composes the block; disabled config → `""`.
- `src/runtime/runtime-finalize.js` — matching `buildGoalAnchorBlockForFinalize` injects between role and final-response system prompts. All 5 `executeRuntimeFinalize` callsites carry `runtimeConfig: session.runtimeConfig`.
- 22 new unit cases across `test/unit/goal-anchor.test.js` (config normalizer + harness) + 9 wiring cases in `test/unit/goal-anchor-wiring.test.js` (`applyRouterVerdict` × 5 verdicts + `hydrateRunStateWithThread` × 4 branches). MCP Chrome browser smoke validates planner prompt shape + rollback (disabled flag returns byte-identical prompts).
- Enabled-by-default path: seed originalQuery every run; empty thread.goalAnchor → no `[GOAL ANCHOR]` block; both missing → empty string (no injection).

**AGRUN-146 harness summary** (for future auditors):
- `src/runtime/drift-detector.js` — `detectDrift`, `computeTrajectorySignal`, `formatDriftReminder`, `DRIFT_DETECTOR_DEFAULTS`. Pure functions; default similarity is Jaccard over `tokenizeTopicText` (reused from topic-scoring). `similarityFn` host hook clamps to `[0,1]` and silently degrades on throw.
- `src/runtime/drift-detection-config.js` — `normalizeDriftDetectionConfig` extracted so unit tests bypass the `virtual:` bundler aliases in `config.js`.
- `src/runtime/action-loop-session-cycle.js` — `evaluateCycleDrift` runs after `turnState` assembly in `beginActionLoopCycle`; writes `runState.driftSignal` and emits a `drift-detected` step.
- `src/runtime/action-loop-planner.js` — `mergeDriftReminderIntoDirectives` appends the reminder last in `plannerDirectives`, then clears `runState.driftSignal`. One-shot consumption prevents snowballing.
- `src/runtime/state.js` — `driftSignal: null` first-class field on initial runState.
- 15 new unit cases across `drift-detector.test.js` + `drift-wiring.test.js`; MCP Chrome browser smoke passes 8/8 via Vite `@fs` ESM direct-import of source modules.
- Disabled-by-default path: `runtimeConfig.driftDetection.enabled === false` skips `evaluateCycleDrift` entirely — byte-identical pre-146 planner prompts.

**AGRUN-145 harness summary** (for future auditors):
- `src/session/summary-key.js` — `composeSummaryKey(sessionId, threadId) → "${sessionId}::${threadId}"` with `normalizeThreadId` legacy collapse to `DEFAULT_THREAD_ID`.
- `src/runtime/thread-provenance.js` — `stampThreadProvenance`, `filterByThreadWindow` (keep-by-default for legacy + `turnId=null`), `trimRunStateForThreadWindow`.
- `src/runtime/run-state-thread.js` — `hydrateRunStateWithThread({ compactionWindow })` triggers trim automatically.
- `src/session/compaction.js` — computes `oldestPreservedTurnId`, persists on summary record, surfaces on `prepared.compactionWindow`.
- 14 new unit cases across `summary-store-per-thread`, `compaction-thread-scoped`, `compaction-window-trim`; MCP Chrome browser smoke passes 5/5 via Vite `@fs` ESM direct-import of source modules.
- Threads-disabled path: `scopeThreadId = ""` (distinct from `DEFAULT_THREAD_ID`) preserves byte-identical pre-145 compaction prompts.
