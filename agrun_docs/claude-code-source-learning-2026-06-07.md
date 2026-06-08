# Claude Code — 源码级学习笔记 (v2 Synthesis)

**Date:** 2026-06-07
**Source:** `sample project for study logic/claude-code-source-code-main/`
**Type:** Decompiled/bundled TypeScript source
**Tag:** `claude-code`, `source-level`, `harness-engineering`, `synthesis-v2`

---

## Executive Summary

Claude Code's source code reveals the most architecturally mature agent runtime currently available for study. This v2 synthesis aggregates eight independent deep-dive analyses (Core Agent Loop, Tool Orchestration, Hook System, Compaction Pipeline, Context & Memory, Task & Subagent, Permission System, Error Recovery & Fallback) into a single cross-referenced document.

**15 convergent patterns** appear across multiple subsystems, with the AsyncGenerator streaming primitive present in **4 of 8** subsystems. The architectural philosophy is remarkably consistent: fail-closed defaults, circuit-breaker-protected escalation chains, immutable state with typed transitions, and streaming-first event delivery.

**6 architectural contradictions** exist between subsystems (compaction vs memory extraction, permission cascade vs tool concurrency, hook interception vs silent trimming). Each has a clean resolution in Claude Code's source that agrun should adopt.

**Top-5 implementation sketches** provide concrete JavaScript code that agrun can adopt this week: circuit breaker for terminal repair (closing AGRUN-307/309 loop-churn), AsyncGenerator agent loop with typed transition reasons, streaming tool execution with concurrency-safe batching, error watermark / cursor-based incremental processing, and fail-closed action defaults.

---

## 1. Convergent Patterns (Cross-Subsystem Analysis)

### 1.1 AsyncGenerator as Universal Streaming Primitive

**Appears in:** Core Agent Loop, Tool Orchestration, Hook System, Error Recovery (4/8 subsystems)

This is THE strongest signal in the entire codebase. Every subsystem that produces a sequence of events uses `async function*` to yield typed results to a consumer that iterates at its own pace:

```
Core Agent Loop:   async function* queryLoop() -> yields Message, returns Terminal
Tool Orchestration: async function* runTools() -> yields ToolResult
Hook System:       async function* executeHooks() -> yields HookResult
Error Recovery:    async function* withRetry() -> yields APIResponse | RetryEvent
```

**Why it matters:** The caller controls iteration rate. Progress is yielded before completion (streaming-first). Abort is natural (break/return exits the generator). No callback hell, no event emitter spaghetti.

**For agrun:** Replace the current callback-phase model in action-loop.js with an async function* runLoop(). Each yield is a typed event (phase transition, tool start, tool result, budget warning, repair attempt). The consumer (React component, CLI, test harness) iterates at its own pace.

### 1.2 Yield Progress Before Results

**Appears in:** Core Agent Loop (stream_request_start), Tool Orchestration (tool progress messages), Hook System (hook progress), Error Recovery (retry countdown) — 4/8

Every async generator yields status indicators BEFORE the main result. This enables streaming UI, progress bars, and early error detection without waiting for completion.

### 1.3 Circuit Breaker / Max-Consecutive-Failures Guard

**Appears in:** Compaction Pipeline (MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3), Permission System (consecutive denials = 3, total = 20) — 2/8

Two independent subsystems converged on the same pattern: track consecutive failures in a counter, trip a hard circuit breaker when the counter exceeds a small constant (3), and provide an escape hatch (graceful finalize, auto-deny, agent abort).

**For agrun:** Directly applicable to terminal repair (AGRUN-307/309). The existing convergence tracking needs a hard cutoff.

### 1.4 Dependency Injection for Testability

**Appears in:** Core Agent Loop (deps.ts with 4 functions), Error Recovery (error sinks as deps), Tool Execution (tools passed as deps) — 3/8

A tiny dependency-injection object (not a framework) is passed into the production function. Tests inject fakes for callModel, compact, uuid, logError. This eliminates the need for sprawling spyOn calls across test files.

### 1.5 Fail-Closed Defaults

**Appears in:** Tool Orchestration (buildTool defaults isConcurrencySafe:false, isReadOnly:false), Permission System (default behavior is deny) — 2/8

Every safety property defaults to the RESTRICTIVE option. Tool authors must explicitly opt OUT of safety (declare isReadOnly: true), not opt in.

### 1.6 Structured Discriminated Unions

**Appears in:** Core Agent Loop (Continue type with reason field), Error Recovery (error discriminator tag: rate_limit | invalid_request | ...), Permission System (PermissionDecision: allow | deny | ask), Task System (TaskType union) — 4/8

Every cross-boundary message is a named discriminated union. Never a bare string, never a boolean with implicit meaning.

### 1.7 Single State Struct / Atomic Replacement

**Appears in:** Core Agent Loop (state = next entire struct replacement), Task System (updateTaskState with immutable patterns) — 2/8

Mutable state is packed into a single struct and replaced atomically at each continuation point. Prevents stale closure references and enables trivial state snapshots for debugging.

### 1.8 Named Threshold Constants

**Appears in:** Compaction Pipeline (AUTOCOMPACT_BUFFER_TOKENS = 13000, WARNING_THRESHOLD_BUFFER = 20000), Permission Denial (CONSECUTIVE_ESCALATION = 3, TOTAL_ABORT = 20) — 2/8

All tuning values are named CONSTANT_CASE exports from their module, never magic numbers.

### 1.9 Time-Aware / Cooldown-Based Operations

**Appears in:** Compaction Pipeline (time-based microcompact after 60-min cache TTL), Error Recovery (rate-limit retry-after header honor) — 2/8

Both detect "the environment is cold" and adapt strategy at zero API cost.

### 1.10 Fire-and-Forget with Structured Cleanup

**Appears in:** Context & Memory (void recordTranscript, using keyword for memory prefetch), Task System (cleanup registry, registerCleanup) — 2/8

Non-blocking side effects that must eventually complete are launched with void promise or using and tracked for cleanup on exit.

### 1.11 Cursor-Based Incremental Processing

**Appears in:** Context & Memory (lastMemoryMessageUuid in extractMemories), Error Recovery (errorLogWatermark — ring buffer position snapshot) — 2/8

Track "where I left off" with a simple cursor value. Process only deltas. Prevents re-processing of stale data on every turn.

### 1.12 Foreground-to-Background Transition

**Appears in:** Task System (Promise-based backgroundSignalResolvers Map), Context & Memory (SessionMemory runs as post-sampling background task) — 2/8

Same operation starts visible/blocking (user sees progress) and transitions to fire-and-forget after delivering initial feedback.

### 1.13 Fail-Stop Recovery with Fallback Chain

**Appears in:** Core Agent Loop (max_output_tokens_escalate), Error Recovery (model fallback on FallbackTriggeredError), Compaction Pipeline (reactive compact on 413 PromptTooLong) — 3/8

Three-tier recovery with explicit fallback: try cheap fix -> escalate to expensive fix -> fail cleanly. Each layer is independent and composable.

### 1.14 Cache-Aware Context Design

**Appears in:** Context & Memory (pre-compute age strings at attachment creation, use path patterns instead of date literals), Compaction Pipeline (time-based microcompact respects cache TTL), Core Agent Loop (prompt cache co-location attempts) — 3/8

Every decision about context layout considers the prompt cache boundaries.

### 1.15 Schema Validation Before Permission Check

**Appears in:** Tool Orchestration (validateInput runs BEFORE checkPermissions), Permission System (general pipeline calls tool.checkPermissions only after structural validation passes) — 2/8

Clean layer separation: structural validation first, security second.

---

## 2. Subsystem Summaries

### 2.1 Core Agent Loop (query.ts, QueryEngine.ts)

The beating heart: an AsyncGenerator + while(true) loop driving every turn. Key patterns:
- **Single State struct** replaced atomically with transition: { reason }
- **4-function deps object** (callModel, microcompact, autocompact, uuid) for injection
- **Flat recovery decision tree** (if/else chain, not nested switch)
- **Runtime gates hoisted before stream loop** (snapshot once, use twice)

### 2.2 Tool Orchestration (toolOrchestration.ts, toolExecution.ts, StreamingToolExecutor.ts)

Engine that receives tool_use blocks, validates, resolves permissions, executes (possibly in parallel), and feeds results back. Key patterns:
- **buildTool() with fail-closed defaults** (isConcurrencySafe:false, isReadOnly:false)
- **partitionToolCalls** merges adjacent concurrent-safe tools into batches
- **StreamingToolExecutor order preservation** — results yield in insertion order despite out-of-order execution
- **Sibling abort** via child AbortController chains

### 2.3 Hook System (hooks.ts, sessionHooks.ts, useCanUseTool.tsx)

Central lifecycle interception layer for every significant event. Key patterns:
- **Async Generator Pipeline** — executeHooks yields progress before results
- **Permission Behavior Precedence** — deny > ask > allow
- **Lazy-Once Shared Serialization** — stringify once, share across parallel hooks
- **StructuredOutput Enforcement via Function Hook** — zero prompt overhead

### 2.4 Compaction Pipeline (autoCompact.ts, compact.ts, microCompact.ts, sessionMemoryCompact.ts, reactiveCompact.js)

5-tier context management system invoked on every main-loop turn. Key patterns:
- **Priority-ordered strategy chain with circuit breaker** — cheapest first, stop at 3 failures
- **Threshold math with named buffer constants** (13K compact, 20K warning, 3K blocking)
- **Post-compact invariant repair** — fix broken tool_use/tool_result pairs
- **Time-based microcompact** — if gap > 60min (cache cold), compact at zero cost
- **"try and check" fallback chain** for session memory compact

### 2.5 Context & Memory Management (context.ts, attachments.ts, claudemd.ts, sessionMemory.ts, extractMemories.ts)

Layered context injection running at three scopes (system, per-session, per-turn). Key patterns:
- **Layered attachment system** with maybe() timeout wrapper (1s timeout per sub-computation)
- **Non-blocking memory prefetch** — using pendingMemoryPrefetch consumed after tools
- **Background forked extraction with cursor** — lastMemoryMessageUuid tracks progress
- **Two-tier file memory system** — MEMORY.md as bounded index pointing to topic files
- **Cache-aware prompt design** — pre-compute age strings, avoid date literals in cached prefixes

### 2.6 Task & Subagent System (Task.ts, tasks.ts)

Foundation for all background execution with 7 task types. Key patterns:
- **Promise-based foreground-to-background signal** (backgroundSignalResolvers Map)
- **Task state union with type guards** (isLocalAgentTask, isInProcessTeammateTask)
- **Notification deduplication via atomic notified flag** (check-and-set inside updateTaskState)
- **Agent-owned subprocess cleanup** (killShellTasksForAgent)

### 2.7 Permission System (permissions.ts, hasPermissionsToUseTool)

Security chokepoint with a cascading 13-step decision pipeline. Key patterns:
- **Cascading decision pipeline with passthrough delegation** — each layer can allow/deny/ask or passthrough
- **Three-rule-bucket design** — alwaysAllow/alwaysDeny/alwaysAsk per source
- **Denial tracking escalation** — consecutive=3, total=20
- **Tool.checkPermissions dual-layer design** — tool-specific safety vs agent-runtime governance
- **Three behavioral outcomes with structured decisionReason** attached to every decision

### 2.8 Error Recovery & Fallback (getAssistantMessageFromError, withRetry, logError)

Categorize -> Retry -> Log pipeline spanning three layers. Key patterns:
- **Generator-based retry yielding through same stream** — errors are stream citizens, not exceptions
- **Single error classifier** producing typed discriminated payload
- **CannotRetryError wrapper** preserving original error + accumulated retry context
- **Exponential backoff + jitter + retry-after header** with source-aware 529 gating
- **Sink-based error logging** with queue-drain during startup and in-memory ring buffer

---

## 3. Prioritized Action Items for agrun

Ranked by (impact on agrun runtime quality / performance) x (feasibility in browser runtime).

| Rank | Pattern | Impact | Feasibility | Priority | AGRUN Mapping |
|------|---------|--------|-------------|----------|---------------|
| 1 | **Circuit breaker + threshold constants** | HIGH: kills publish-loop churn | HIGH: tracking exists, add hard cap | **P0** | AGRUN-307, AGRUN-309 |
| 2 | **Discriminated union State + typed transition reasons** | HIGH: testable, auditable loop | HIGH: mechanical refactor of runState | **P0** | AGRUN-248-E |
| 3 | **AsyncGenerator agent loop** | HIGH: streaming UI, abort integration | MEDIUM: restructure action-loop.js | **P1** | AGRUN-248-E, AGRUN-248-C |
| 4 | **Yield progress before results** | HIGH: browser UX | HIGH: already emits _started/_completed | **P1** | AGRUN-248-B, AGRUN-248-C |
| 5 | **Streaming tool execution with concurrency batching** | MED-HIGH: 30-60% wall-clock reduction | MEDIUM: concurrency-safe annotation needed | **P1** | AGRUN-118 |
| 6 | **Background extraction with cursor** | HIGH: persistent cross-session memory | MEDIUM: IndexedDB + cursor tracking | **P1** | AGRUN-246-J |
| 7 | **Fail-closed action defaults** | MEDIUM: prevent accidental destructive ops | HIGH: mechanical addition to buildAction() | **P2** | new |
| 8 | **Error watermark (ring-buffer snapshot)** | MEDIUM: clean diagnostic output | HIGH: two-line pattern | **P2** | AGRUN-308 |
| 9 | **Cache-aware context design** | HIGH: reduce API costs (#1 expense) | LOW: needs provider-level cache control | **P2** | AGRUN-214 series |
| 10 | **Cascading permission pipeline** | MEDIUM: clean governance separation | LOW: net-new subsystem | **P3** | AGRUN-247 |
| 11 | **Foreground-to-background transition** | MEDIUM: long-run UX | MEDIUM: Promise-based signaling | **P3** | AGRUN-252 |
| 12 | **Deferred tool loading** | LOW: marginal benefit at current scale | LOW: complex schema injection | **P3** | new |

---

## 4. Implementation Sketches (Top 5)

### 4.1 Circuit Breaker + Threshold Constants (P0, AGRUN-307/309)

Adds hard cutoffs to agrun's existing terminal repair convergence tracking. Three layers: per-iteration counter, cumulative run-level counter (survives state reset), and bounded constant.

```javascript
// src/runtime/terminal-repair-state.js — add to existing module

// --- Named threshold constants (Pattern: 1.8) ---
const MAX_CONSECUTIVE_REPAIR_FAILURES = 3  // circuit breaker: stop after 3
const MAX_CUMULATIVE_REPAIR_IGNORED = 8    // run-level cap (AGRUN-307)
const CONSECUTIVE_DENIAL_ESCALATION = 3    // permission denial: auto-deny after 3
const TOTAL_DENIAL_ABORT = 20              // total denials: abort agent

export function createCircuitBreaker() {
  return {
    consecutiveFailures: 0,
    cumulativeIgnored: 0,
    // Run-level counter that survives clearTerminalRepairState
    // Only resets on completedTerminal via resetCumulative()
    isTripped() {
      return this.consecutiveFailures >= MAX_CONSECUTIVE_REPAIR_FAILURES
         || this.cumulativeIgnored >= MAX_CUMULATIVE_REPAIR_IGNORED
    },
    recordFailure() { this.consecutiveFailures++ },
    recordIgnored() { this.cumulativeIgnored++ },
    resetConsecutive() { this.consecutiveFailures = 0 },
    resetCumulative() { this.cumulativeIgnored = 0; this.consecutiveFailures = 0 }
  }
}

// --- Usage inside repair build function ---
function buildRepairActions(runState, context) {
  const breaker = runState._circuitBreaker ?? createCircuitBreaker()
  runState._circuitBreaker = breaker

  if (breaker.isTripped()) {
    // Circuit is open — force finalize or limited-publish
    // (Pattern 1.3: circuit breaker, Pattern 1.13: fail-stop recovery)
    return buildGracefulDegradationActions(context)
  }
  // ... normal repair logic ...
  if (!repairSucceeded) { breaker.recordFailure() }
  else { breaker.resetConsecutive() }
}
```

### 4.2 AsyncGenerator Agent Loop with Typed Transition Reasons (P0)

Replace agrun's callback-phase model with an async generator. Each yield is a typed AgentEvent; each continue site records a typed transition.

```javascript
// src/runtime/action-loop.js — refactored core loop

// --- Discriminated union types (Pattern: 1.6) ---
/** @typedef {'next_turn'|'max_turns_reached'|'budget_exhausted'|'prompt_too_long'|'candidate_quality_unresolvable'|'completed'|'error_fatal'} TransitionReason */
/** @typedef {{ reason: TransitionReason, detail?:string, turnCount?:number }} Continue */

/** @typedef {{ type:'phase', phase:'observe'|'orient'|'decide'|'act'|'evaluate', turn:number }
 *         |{ type:'tool_start', toolName:string, input:unknown }
 *         |{ type:'tool_result', toolName:string, elapsed:number, error?:string }
 *         |{ type:'budget_warning', remaining:number, unit:string }
 *         |{ type:'repair_attempt', reason:string, attempt:number }
 *         |{ type:'circuit_breaker_tripped', consecutiveFailures:number, fallbackAction:string }
 *         |{ type:'completed', turnCount:number }
 *       } AgentEvent */

// --- The loop (Pattern: 1.1 AsyncGenerator) ---
export async function* runLoop(initialState) {
  let state = {
    ...initialState, turnCount: 0, transition: undefined,
    circuitBreaker: createCircuitBreaker(),
    budgetTracker: createBudgetTracker(initialState.budget)
  }

  while (true) {
    const { messages, planner, toolContext, turnCount, circuitBreaker, budgetTracker } = state

    // 1. YIELD phase start (Pattern 1.2: yield progress before results)
    yield { type: 'phase', phase: 'observe', turn: turnCount }

    // 2. BUILD query
    const query = await buildQuery(messages, turnCount)

    // 3. BUDGET CHECK (named constants — Pattern 1.8)
    if (budgetTracker.isExhausted()) {
      yield { type: 'budget_warning', remaining: 0, unit: 'usd' }
      return { reason: 'budget_exhausted', turnCount }
    }

    // 4. MODEL CALL + STREAMING TOOL EXECUTION
    const toolExecutor = createToolExecutor(toolContext)
    for await (const event of callModelWithTools(query, toolExecutor)) {
      yield event  // tool_start, tool_result events streamed immediately
    }

    // 5. EVALUATE RESULTS
    const outcome = await evaluateTurn(toolExecutor.getResults())

    // 6. REPAIR CHECK — circuit breaker (Pattern 1.3)
    if (outcome.needsRepair) {
      yield { type: 'repair_attempt', reason: outcome.issue, attempt: circuitBreaker.consecutiveFailures + 1 }
      const repairResult = await executeRepair(outcome, toolExecutor)
      if (!repairResult.succeeded) {
        circuitBreaker.recordFailure()
        if (circuitBreaker.isTripped()) {
          yield { type: 'circuit_breaker_tripped', consecutiveFailures: circuitBreaker.consecutiveFailures, fallbackAction: 'finalize' }
          const finalizeResult = await executeGracefulFinalize(state)
          yield finalizeResult
          return { reason: 'candidate_quality_unresolvable', turnCount }
        }
      } else { circuitBreaker.resetConsecutive() }
    }

    // 7. MAX TURNS CHECK
    const nextTurnCount = turnCount + 1
    if (state.maxTurns && nextTurnCount > state.maxTurns) {
      return { reason: 'max_turns_reached', turnCount: nextTurnCount }
    }

    // 8. ATOMIC STATE UPDATE (Pattern 1.7)
    state = {
      ...state,
      turnCount: nextTurnCount,
      transition: outcome.isComplete
        ? undefined  // terminal
        : { reason: 'next_turn', turnCount: nextTurnCount },
      messages: outcome.updatedMessages, circuitBreaker, budgetTracker
    }

    // 9. CHECK FOR COMPLETION
    if (outcome.isComplete) { return { reason: 'completed', turnCount: nextTurnCount } }
  }
}

// --- Consumer pattern (React component, Inspector, CLI) ---
async function consumeRunLoop(config) {
  const events = []
  const terminal = await (async () => {
    for await (const event of runLoop(config)) {
      events.push(event)
      dispatchEvent(event)  // React: setState, Inspector: append
    }
  })()
  return { events, terminal }
}
```

### 4.3 Streaming Tool Execution with Concurrency-Safe Batching (P1)

Partition tools into concurrent-safe batches, execute in parallel, preserve insertion order for results.

```javascript
// src/runtime/action-streaming-executor.js (Pattern: Tool Orchestration)

// Fail-closed defaults (Pattern 1.5): every action defaults to non-concurrent
const ACTION_CONCURRENCY_DEFAULTS = {
  read_url:           { isConcurrencySafe: true,  isReadOnly: true },
  web_search:         { isConcurrencySafe: true,  isReadOnly: true },
  workspace_read:     { isConcurrencySafe: true,  isReadOnly: true },
  workspace_diff:     { isConcurrencySafe: false, isReadOnly: true },
  workspace_publish:  { isConcurrencySafe: false, isReadOnly: false },
  todo_write:         { isConcurrencySafe: false, isReadOnly: false },
  planner_finalize:   { isConcurrencySafe: false, isReadOnly: false },
}
function getActionDefaults(name) {
  return ACTION_CONCURRENCY_DEFAULTS[name] ?? { isConcurrencySafe: false, isReadOnly: false }
}

export class StreamingActionExecutor {
  #tracked = []         // TrackedAction[] — insertion order
  #pending = []         // Promise[]
  #completed = new Set()
  #yieldedUpTo = 0
  #abort = new AbortController()

  addTool(actionName, input, actionId) {
    const index = this.#tracked.length
    const def = getActionDefaults(actionName)
    this.#tracked.push({ index, actionName, actionId, input, ...def, status: 'queued' })

    // Concurrent-safe tools start immediately (Pattern: partitionToolCalls)
    if (def.isConcurrencySafe) this.#startExecution(index)
  }

  #startExecution(index) {
    const entry = this.#tracked[index]
    entry.status = 'executing'
    const p = executeAction(entry.actionName, entry.input, { signal: this.#abort.signal })
      .then(r => { entry.status = 'completed'; entry.result = r; this.#completed.add(index) })
      .catch(e => {
        entry.status = 'failed'; entry.error = e; this.#completed.add(index)
        // Sibling abort: non-readonly action failure aborts all siblings (Pattern: sibling abort)
        if (!entry.isReadOnly) this.#abort.abort()
      })
    this.#pending.push(p)
  }

  async *getCompletedResults() {
    while (this.#yieldedUpTo < this.#tracked.length) {
      const entry = this.#tracked[this.#yieldedUpTo]
      // Non-concurrent tool: start it now, blocking all later results
      if (!entry.isConcurrencySafe && entry.status === 'queued') this.#startExecution(this.#yieldedUpTo)
      if (this.#completed.has(this.#yieldedUpTo)) { yield entry; this.#yieldedUpTo++; continue }
      if (this.#pending.length > 0) { await Promise.race(this.#pending); continue }
      break
    }
  }

  async *getRemainingResults() {
    await Promise.allSettled(this.#pending)
    yield* this.getCompletedResults()
  }

  discard() { this.#abort.abort(); this.#pending = [] }
}
```

### 4.4 Error Watermark / Cursor-Based Incremental Processing (P2)

Two applications: (a) error reporting watermark that snapshots ring buffer position, (b) event-ledger incremental extraction with cursor tracking.

```javascript
// src/runtime/error-watermark.js (Pattern: Error Recovery, Context & Memory)

const ERROR_RING_SIZE = 200
const errorRing = []

export function pushError(error) {
  errorRing.push(error)
  if (errorRing.length > ERROR_RING_SIZE) errorRing.shift()
}

export function getInMemoryErrors() { return errorRing }

/**
 * Snapshot ring buffer position before a block.
 * Report only errors added during that block.
 * Prevents dumping 100 stale errors into diagnostics.
 * (Pattern 1.11: cursor-based incremental processing)
 */
export function createErrorWatermark() {
  const watermark = errorRing.length > 0 ? errorRing[errorRing.length - 1] : null
  return {
    getErrorsSince() {
      if (!watermark) return getInMemoryErrors()
      const all = getInMemoryErrors()
      return all.slice(all.lastIndexOf(watermark) + 1)
    }
  }
}

/**
 * Generic incremental processor. Tracks last-processed cursor.
 * Used for: event ledger extraction, memory extraction.
 * (Pattern 1.11: cursor-based incremental, Pattern 2.5: background extraction)
 */
export function createIncrementalProcessor({ processItem }) {
  let lastCursor = null
  let processing = false

  return {
    async processNewItems(items, getCursor) {
      if (processing) { this._pending = items; return }  // coalesce
      processing = true
      try {
        const startIdx = lastCursor
          ? items.findIndex(item => getCursor(item) === lastCursor) + 1
          : 0
        for (let i = startIdx; i < items.length; i++) {
          await processItem(items[i])
          lastCursor = getCursor(items[i])
        }
      } finally {
        processing = false
        if (this._pending) { const p = this._pending; this._pending = null; await this.processNewItems(p, getCursor) }
      }
    },
    reset() { lastCursor = null }
  }
}
```

### 4.5 Fail-Closed Action Defaults (P2, Action Registry)

Wrap agrun's action registration with fail-closed defaults. Every new action starts as non-concurrent and read-write-unless-declared-readonly.

```javascript
// src/runtime/action-registry.js (Pattern: Tool Orchestration, Permission System)

/**
 * Safe defaults for every action.
 * Pattern from buildTool(): every safety property defaults to the
 * RESTRICTIVE option, not the permissive one.
 * (Pattern 1.5: fail-closed defaults)
 */
const ACTION_SAFETY_DEFAULTS = {
  isConcurrencySafe: false,  // default: NOT safe to run in parallel
  isReadOnly: false,         // default: MAY write/mutate state
  isDestructive: false,      // default: NOT destructive
  needsApproval: () => false,
  validateInput: () => null,
}

/**
 * @param {ActionDef} def
 * @returns {ResolvedAction}
 * - Merges def with ACTION_SAFETY_DEFAULTS
 * - All safety methods always exist — consumer never needs ?.()
 * - Two-phase execution: validateInput BEFORE permission check (Pattern 1.15)
 */
export function buildAction(def) {
  const resolved = {
    ...ACTION_SAFETY_DEFAULTS,
    ...def,
    isConcurrencySafe: def.isConcurrencySafe ?? false,
    isReadOnly: def.isReadOnly ?? false,
    isDestructive: def.isDestructive ?? false,
  }

  resolved.execute = async (input, context) => {
    // Phase 1: structural validation (Pattern 1.15: validate before permission)
    const validationError = resolved.validateInput(input)
    if (validationError) return { success: false, error: validationError, phase: 'validation' }

    // Phase 2: permission check
    if (resolved.needsApproval(input) && context?.canUseTool) {
      const permission = await context.canUseTool(resolved, input)
      if (permission !== 'allow') return { success: false, error: 'permission_denied', phase: 'permission' }
    }

    // Phase 3: execute
    return def.execute(input, context)
  }

  return resolved
}
```

---

## 5. Architectural Contradictions

Six contradictions exist between subsystems. Each has a clean resolution in Claude Code's source.

| # | Subsystem A | Subsystem B | Conflict | Claude Code Resolution | agrun Adoption |
|---|------------|------------|----------|------------------------|----------------|
| 1 | Compaction Pipeline (prune messages) | Context & Memory Extraction (analyze history) | Compaction removes messages extraction needs | Extraction runs DURING streaming (pre-compaction) using cursor-based tracking | Run memory/event extraction as streaming post-sampling hook BEFORE compaction |
| 2 | Permission System (13-step sequential cascade) | Tool Orchestration (concurrent execution) | Sequential permission blocks parallel execution | Permission check is per-tool; sequential gate + parallel exec is compatible | Validate+permit per-tool, then execute batch |
| 3 | Hook System (intercepts every event) | Compaction Pipeline (needs silent trimming) | Hooks fire on every message change, compaction batch-deletes | Compaction bypasses hooks entirely (system-level operation) | System operations bypass the event/hook system |
| 4 | Task State Machine (pending->running->terminal) | Error Recovery (complex retry with backoff) | Task kills on terminal, error recovery wants retry | Task delegates retry to execution layer; task changes only when retries exhausted | Keep retry invisible to task state (error recovery wraps inside "running") |
| 5 | Permission auto-classifier (main agent) | Task System (subagent autonomy) | Auto-classifier runs in main agent; subagents have different permission mode | Task carries its own permission context; each agent type gets a mode | Subagents inherit permission snapshot from parent at spawn, have own escalation counters |
| 6 | Context Collapse (projection view) | Memory Extraction (writes notes files) | Collapse might compact area extraction targets | Extraction runs first (streaming), collapse is read-time concern | Extraction is streaming side-effect; collapse is read-side concern. They don't interact |

---

## 6. Task Mapping

| AGRUN Task | Best-Matching Patterns | Implementation Priority |
|-----------|------------------------|------------------------|
| **AGRUN-307** (publish-loop stuck detection) | Circuit breaker, threshold constants | P0: add cumulative cap surviving clearTerminalRepairState |
| **AGRUN-309** (candidate-quality convergence) | Circuit breaker, graceful degradation escape | P0: candidateQualityUnresolvable + finalize at hard_veto |
| **AGRUN-310** (ghost terminal-repair-state-refreshed) | State atomic replacement, guard discipline | P0: fix guard at three sites |
| **AGRUN-306** (gpt-low nonconvergence) | Threshold constants, fail-stop recovery chain | P1: named threshold exports for cross-model tuning |
| **AGRUN-248-E** (run-state-projections) | AsyncGenerator, State struct, typed transitions | P1: yield typed AgentEvent to enable streaming consumers |
| **AGRUN-248-C** (inspector event ledger) | Yield progress before results, cursor-based incremental | P1: typed event stream feeds event ledger |
| **AGRUN-248-B** (action-output-envelope) | Discriminated unions, schema validation before permission | P1: typed result envelope + fail-closed defaults |
| **AGRUN-308** (TNO observability) | Error watermark, sink-based logging | P2: ring-buffer watermark for diagnostic output |
| **AGRUN-247** (config-permission-lifecycle) | Cascading permission pipeline, three-rule-bucket | P2: permission system architecture |
| **AGRUN-252** (todo-publish-readiness-churn) | Foreground-to-background transition | P3: Promise-based background signaling |
| **AGRUN-118** (phase 5 mocked fetch) | Streaming tool execution | P1: replace sequential execution with concurrent batches |

---

## 7. Differences from Previous Learning Doc (v1)

This v2 doc adds cross-subsystem synthesis not present in v1:

| v1 Had | v2 Adds |
|--------|---------|
| 5-topic listing of subsystems | 15 convergent patterns across all 8 subsystems |
| P0/P1/P2 suggestions | Prioritized rank (impact x feasibility) with AGRUN task mappings |
| No code sketches | 5 implementation sketches with concrete JS |
| No contradictions | 6 identified contradictions with resolutions |
| Compaction pipeline details | Extended with 4 more subsystem analyses (Hook, Permission, Task, Error) |
| Brief task references | Full AGRUN task mapping table |
| — | AsyncGenerator convergence (4/8 subsystems) |
| — | Fail-closed defaults appearing in BOTH Tool + Permission |
| — | deps.ts injection pattern for testability |
| — | Error watermark / ring-buffer position snapshot |
| — | 15 numbered convergent patterns |

---

## References

- `src/query.ts` — Core agent loop, compaction pipeline, streaming execution
- `src/QueryEngine.ts` — Main engine class, budget enforcement, permission wrapping
- `src/Tool.ts` — Tool type system, buildTool(), safe defaults, two-phase validation
- `src/Task.ts` — Task lifecycle, status machine, crypto IDs
- `src/context.ts` — System/user context, CLAUDE.md injection
- `src/attachments.ts` — Per-turn dynamic context, memory prefetch, relevant memories
- `src/hooks.ts` — Hook execution engine, permission integration
- `src/services/compact/autoCompact.ts` — Autocompact threshold, circuit breaker
- `src/services/tools/StreamingToolExecutor.ts` — Concurrent tool execution
- `src/services/tools/toolOrchestration.ts` — Tool partitioning, batch merging
- `src/services/tools/toolExecution.ts` — checkPermissionsAndCallTool
- `src/services/extractMemeries/extractMemeries.ts` — Cursor-based incremental extraction
- `src/permissions.ts` — Cascading decision pipeline
