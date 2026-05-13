# Context and Continuity Model

## Purpose

This document describes how agrun.js manages context across OODAE cycles and across multi-turn sessions. It covers semantic input resolution, context snapshots, inquiry context, and research continuity.

For the session store and persistence layer, see `agrun_docs/runtime-state-and-memory-architecture.md`.
For the full execution flow, see `agrun_docs/agentic-execution-flow.md`.

## Context Layers

agrun.js maintains context at three distinct layers:

```text
Layer 1: RunState (per-run, ephemeral)
 └ Current cycle state, research context, tool context

Layer 2: Context Snapshot (per-turn, derived)
 └ sessionMemory, inquiryContext, continuityResolution

Layer 3: Session (cross-run, persistent)
 └ Message history, semantic memory, compacted context
```

## Semantic Input Resolution

At the start of each OODAE cycle's ORIENT phase, `createSemanticInputResolution()` classifies the input:

### Intent State

Extracts structured intent from the user prompt:

- `goal`: What the user wants to achieve
- `topic`: The subject area
- `query`: A searchable query form of the request

### Ambiguity State

Classifies how ambiguous the request is:

- `clear`: Unambiguous, can proceed directly
- `moderate`: Some interpretation needed
- `high`: Multiple valid interpretations exist

### Evidence State

Classifies what evidence exists from prior cycles:

- `none`: No research has been done
- `partial`: Some evidence exists but may be insufficient
- `sufficient`: Enough evidence to produce a final answer

### Direct Tool Candidate

Identifies if a bundled tool can handle the request directly:

- `skillName`: The skill containing the tool
- `toolName`: The specific tool
- `args`: Pre-built arguments
- `reason`: Why this is a valid candidate

### Clarification Status

Tracks clarification state:

- `none`: No clarification needed or pending
- `pending`: Clarification was requested, awaiting user response
- `resolved`: User provided a clarification response

## Context Snapshot

The `contextSnapshot` is assembled each cycle and provides the planner with full conversational context:

```text
ContextSnapshot
 ├ sessionMemory
 │  ├ facts[]         — extracted facts from prior turns
 │  ├ preferences[]   — user preferences observed
 │  └ decisions[]     — decisions made in the session
 │
 ├ inquiryContext
 │  ├ activeGoal      — current goal (from intent state)
 │  ├ activeTopic     — current topic
 │  ├ activeQuery     — current search query
 │  ├ pendingClarification — structured clarification object
 │  ├ lastClarificationResolution — how the last clarification was resolved
 │  └ lastResolution  — last intent resolution details
 │
 └ continuityResolution
    ├ decision         — simple/legacy pre-built action decision, or null
    ├ kind             — resolution type (auto_read, finalize, continue, etc.)
    ├ confidence       — numeric confidence score
    ├ source           — what triggered the resolution
    ├ selectedUrl      — URL selected for auto-read
    ├ autoReadAttemptCount — how many auto-reads have been attempted
    ├ autoReadStoppedReason — why auto-reading stopped
    └ usedSummarizeLimits — whether summarize limits were applied
```

### Snapshot Construction Flow

```text
Prior contextSnapshot (from runState)
        ↓
Merge with input resolution (goal, topic, query, clarification)
        ↓
buildTurnContextSnapshot()
        ↓
Add continuity resolution
        ↓
createContextSnapshot()
        ↓
Final contextSnapshot for this cycle
```

## Inquiry Context

The inquiry context tracks the evolving understanding of what the user wants:

### Goal Tracking

- Goals are extracted from input resolution each cycle
- Goal quality is assessed: `stable` (consistent across cycles) or `unstable` (changing)
- Unstable goals may trigger guardrails that prevent premature finalization

### Topic Tracking

- Topics are extracted alongside goals
- Used for context projection to the planner
- Help the planner understand the domain area

### Query Tracking

- The active query is the most search-friendly form of the user's request
- Updated each cycle based on input resolution
- Used by continuity resolution as a state input; ADR-0012 long-research action
  choice belongs to the planner/skill, not to this runtime layer

### Clarification Lifecycle

```text
No clarification needed
    ↓ (ambiguity detected)
pendingClarification created
    ↓ (clarify decision returned to host)
Host provides clarification response
    ↓ (next run)
lastClarificationResolution recorded
    ↓
Continue with resolved context
```

## Research Continuity

`resolveResearchContinuation()` summarizes whether prior search/read state
suggests more evidence work or finalization. Older/simple research flows may
still use it as a direct-action shortcut. ADR-0012 long-research flows must use
it only as state/gate context until AGRUN-217 removes the remaining shortcut
behavior.

### Inputs

- Current search results and read sources
- Verification state
- Direct tool candidate
- Execution class
- Last action taken
- Active query and pending clarification

### Decision Types

| Kind | Meaning |
|------|---------|
| `auto_read` | Legacy/simple shortcut that reads the next promising URL from search results; not the ADR-0012 long-research policy path |
| `finalize` | Sufficient evidence exists, produce final answer |
| `continue` | Continue to planner for next decision |
| `clarify` | Research revealed need for clarification |

### Auto-Read Logic

The current code can still automatically read URLs from search results without
asking the planner:

1. Check if search results contain unread URLs
2. Filter by quality signals (domain relevance, result ranking)
3. Track `autoReadAttemptCount` to prevent infinite reading
4. Stop when: max attempts reached, sufficient strong sources found, or all URLs attempted

AGRUN-217 treats this as a migration point for long research. If the run is
explicitly in long-research mode, the runtime should expose the candidate URL and
coverage state as structured context, then the planner/skill should choose
whether to call `read_url`.

### Stopping Conditions

Auto-reading stops when:

- `autoReadAttemptCount` exceeds the limit
- Sufficient `strong` or `usable` read sources exist
- All search result URLs have been attempted
- A `usedSummarizeLimits` flag is set

## Execution Class Routing

`classifyExecutionClass()` uses the input resolution and context snapshot to determine the execution path:

### `direct_tool`

A bundled tool can handle this request directly. Bypasses the planner.

Criteria:
- `directToolCandidate` exists in input resolution
- The candidate tool hasn't already been executed this cycle

### `clarification_gate`

Required information is missing and there's no safe default.

Criteria:
- `pendingClarification` exists in the context snapshot
- The clarification has a concrete question

### `normal`

Default path. Full planner request.

## Session Context Integration

When a session handle is used, the context snapshot is enriched with session-level data:

```text
Session Store
    ↓
Session messages + semantic memory
    ↓
Context window policy (token budgeting)
    ↓
Compacted context
    ↓
Injected into provider request as sessionContext
    ↓
Available to planner via session context projection
```

### Session Memory Extraction

After successful runs, the runtime extracts semantic memory:

- **Facts**: Objective information discovered during the run
- **Preferences**: User preferences expressed or inferred
- **Decisions**: Choices made during the conversation

These are stored in the session and replayed into future context snapshots.

### Context Window Management

The session layer manages token budgets through:

- `context-window-policy.js`: Compaction policies (when to compact)
- `context-window-summary.js`: Summarization of old context
- `context-window-turns.js`: Recent turn filtering
- `context-window-plan.js`: Token budget planning

This ensures the planner always receives relevant context within provider token limits.

### Thread-Aware Compaction (AGRUN-145)

When `threadScope` is active, compaction runs **per thread** instead of per session — two topics in one session get two independent summaries that never cross-contaminate.

| Slice | Change | Harness |
|-------|--------|---------|
| A | Stamp `_provenance: { threadId, turnId }` on every pushed tool entry, research source, and message | `stampThreadProvenance()` in `runtime/thread-provenance.js` |
| B | Session store summaries keyed by `${sessionId}::${threadId}` (legacy single-slot collapses to `default`) | `composeSummaryKey()` in `session/summary-key.js`; `listSummaries(sessionId)` on store |
| C | `selectCompactionMessages` / `sliceAfterSummary` / `buildCompactionPrompt` all consume thread-scoped message lists | `filterMessagesByThread()` in `session/prompt.js` |
| D | Compaction emits `oldestPreservedTurnId`; hydration auto-trims runState `toolContext.history` + `researchContext.readSources` outside that window | `filterByThreadWindow()` + `trimRunStateForThreadWindow()` + `hydrateRunStateWithThread({ compactionWindow })` |

**Semantics of `filterByThreadWindow(entries, { threadId?, oldestPreservedTurnId? })`:**
- Cross-thread entries → dropped.
- `turnId < oldestPreservedTurnId` (lexicographic) → dropped.
- Legacy entries with no `_provenance` → **kept** (migration-safe; old persisted data is not yet stamped).
- `turnId === null` (entry with no runId coordinate at stamp time) → **kept** (window cannot decide).
- Both `threadId` and `oldestPreservedTurnId` missing → shallow-copy passthrough.

**Why `oldestPreservedTurnId` persists on the summary record:** when a cold-start run rehydrates a per-thread summary, the window floor travels with it — future hydration trims cannot be bypassed by losing the in-flight value.

**Fallback when threads are disabled:** `scopeThreadId = ""` (empty string) takes a pass-through branch distinct from `DEFAULT_THREAD_ID` — pre-145 sessions produce byte-identical compaction prompts.

### Goal-Drift Detector (AGRUN-146)

A cycle-cadence guardrail that compares the running trajectory against the immutable `turnState.goalAnchorText` and injects a one-shot reminder into the planner when the two diverge. Disabled by default (`runtimeConfig.driftDetection.enabled === false`) — opt-in per deployment.

**Lifecycle (per cycle):**

1. `beginActionLoopCycle` computes the current `goalAnchorText` from `turnState` and a `trajectoryText` from the last N `toolContext.history` entries (`actionName: summary\n…`).
2. `detectDrift` (in `runtime/drift-detector.js`) runs only on interval cycles (`cycleCount % cycleInterval === 0`). Similarity < `severeThreshold` → `drift="severe"`, `action="force_replan"`. Between severe and `mildThreshold` → `drift="mild"`, `action="inject_reminder"`. Otherwise no verdict.
3. Verdict stashed on `runState.driftSignal = { drift, action, similarity, method, reminder, ... }` and a `drift-detected` step is emitted.
4. On the next planner call, `action-loop-planner.js` calls `mergeDriftReminderIntoDirectives()` — the reminder line is appended **last** in `plannerDirectives` (override-by-recency), then `runState.driftSignal` is cleared.

**Similarity is pluggable:**

| Method | Where | When it runs |
|--------|-------|--------------|
| `jaccard` (default) | `jaccard()` from `runtime/topic-scoring.js` over `tokenizeTopicText()` token sets | Whenever `runtimeConfig.driftDetection.similarityFn` is not a function |
| `custom` | Host-provided `similarityFn(goalText, trajectoryText) → number` | When config supplies a function; return is clamped to `[0,1]`; thrown errors degrade to `null` verdict |

**Config shape (`runtimeConfig.driftDetection`):**

| Field | Default | Semantics |
|-------|---------|-----------|
| `enabled` | `false` | Master switch — off by default, zero behaviour change for existing callers |
| `cycleInterval` | `5` | Only check every Nth cycle (cheap) |
| `severeThreshold` | `0.4` | `similarity < severeThreshold` → force_replan |
| `mildThreshold` | `0.7` | `severe ≤ similarity < mild` → inject_reminder |
| `maxTrajectoryEntries` | `5` | How many recent `actionHistory` entries feed the signal |
| `similarityFn` | `null` | Pluggable similarity hook; `null` ⇒ default Jaccard |

Invalid values fall back to defaults rather than throwing — inverted thresholds (`severe > mild`) collapse to the default band so the detector never emits an incoherent verdict.

**Why one-shot consumption:** `runState.driftSignal` is written once per cycle and cleared the moment the planner consumes it. This prevents the reminder from snowballing across cycles and means a single detector miss only costs one cycle of planner-directive weight, not a permanent prompt bloat.

**Why not an embedding default:** agrun ships zero embedding dependencies in v1. Jaccard over `tokenizeTopicText` reuses the lexicon-free tokenizer already used by the topic router (AGRUN-144) — same similarity primitive across detection layers. Hosts who already run an embedding API wire it through `similarityFn` without touching detector internals.

### Goal Anchor Injection (AGRUN-142)

A three-layer anchor model keeps the planner and finalizer pointed at the user's original framing even after many cycles, compaction, or follow-up turns. Enabled by default (`runtimeConfig.goalAnchor.enabled === true`); the block collapses to an empty string when disabled so legacy prompts are byte-identical.

**The three layers:**

| Layer | Field | Scope | Lifetime | Seeded by |
|-------|-------|-------|----------|-----------|
| L1 Run | `runState.originalQuery` | Current `runtime.run()` invocation | Cycle 1 … end of run (immutable after seeding) | `captureOriginalQuery()` in `runtime/goal-anchor.js`, called once from `createActionLoopSession` |
| L2 Thread | `thread.goalAnchor.text` (session store) · mirrored to `runState.threadGoalAnchorText` on hydration | Active thread, persists across runs | First user text on the thread · immutable thereafter | `applyRouterVerdict` seeds on `new_thread`; `bumpThread` lazy-seeds legacy threads whose anchor was never captured |
| L3 Turn | `turnState.goalAnchorText` | Current cycle only | Recomputed per `beginActionLoopCycle` | Upstream `turnIntent.kind === "new_task"` anchors to the current prompt/original query; otherwise `createTurnState()` derives from `intentState.goal` ∪ `inquiryContext.activeGoal` for follow-up continuity |

**LLM turn-intent override:** hosts can wire `threads.intentClassifier` to return `kind: "new_task"` when the current user request should not inherit the previous goal. The runtime normalizes that result into the same `turnIntent` object consumed by the topic router, inquiry context resolver, and turn-state goal anchor. This keeps weak token overlap (for example shared words or years) from hardcoding follow-up behavior while preserving legacy fallback behavior when no classifier is configured.

**Injection shape (planner + finalizer system prompt):**

```
[ORIGINAL USER QUERY — DO NOT REINTERPRET]
<verbatim run-scope text>

[GOAL ANCHOR]
<verbatim thread-scope text>
```

When both layers hold the same text (single-turn session), the `[GOAL ANCHOR]` block is skipped to avoid duplicate injection. Each block is capped by `maxAnchorChars` (default `4000`) with `…` suffix on truncation.

**Injection point (planner):** right after `roleBlock` in `buildPlannerSystemPrompt`, before `dynamicSystemPrompt` and `BASE_SYSTEM_LINES`. Stable across cycles → Anthropic/OpenAI system prompt cache hits → near-zero token cost after cycle 1.

**Injection point (finalizer):** between `buildRoleSystemPromptBlock` and `buildFinalResponseSystemPrompt` in `executeRuntimeFinalize`. The finalizer re-reads the same `runState.originalQuery` + `runState.threadGoalAnchorText` that the planner saw, so the final answer cannot drift from the user's question even when the planner compacted earlier cycles out of working memory.

**Config shape (`runtimeConfig.goalAnchor`):**

| Field | Default | Semantics |
|-------|---------|-----------|
| `enabled` | `true` | Master switch — block becomes `""` when false |
| `maxAnchorChars` | `4000` | Per-layer truncation cap (headers never truncated) |
| `includeThreadAnchor` | `true` | When false, only the L1 run-scope block is emitted |

**Immutability contract:** both `captureOriginalQuery` and `applyRouterVerdict`/`bumpThread` refuse to overwrite an existing anchor. Later turns cannot mutate the verbatim record the planner was instructed to preserve. Rollback is safe — disable the flag and the block returns `""` everywhere without schema migration.
