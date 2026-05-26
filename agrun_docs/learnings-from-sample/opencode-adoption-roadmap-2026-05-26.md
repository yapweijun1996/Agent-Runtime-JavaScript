# opencode Adoption Roadmap (2026-05-26)

Companion to
[opencode-vs-agrun-2026-05-25.md](./opencode-vs-agrun-2026-05-25.md).
That doc captures the side-by-side study; this one is the actionable
backlog: which opencode patterns agrun should adopt, in what order,
under which ticket id, with which prerequisite.

Anchor question: "we just learned opencode's strengths — which do we
port and which do we skip?". User-stated list (2026-05-26):

1. Speed (opencode 1m44s vs agrun anomaly 50min — typical 2m40s, so
   true ratio is ~1.5-2× not 30×, see KB correction memo).
2. Observability (opencode SSE `/event` + per-message JSON storage +
   `opencode debug` CLI commands).
3. Subagent / task spawning (opencode TaskTool + parentID lineage).
4. Compaction (opencode `isOverflow` + `prune` + real-turn pair).
5. Academic / survey format (Abstract + References + Self-Verification +
   ASCII art).
6. Engineering-blog format (already agrun's strength — preserve).

Plus one item promoted from the original differential: speed is not
about "borrow opencode logic"; it's an internal agrun question (5
LLM evaluators per cycle is the cost of agrun's gate architecture).
Separate item.

## TL;DR

| # | Item | Adopt path | Ticket | Status | Effort | Dep |
|---|---|---|---|---|---|---|
| A | Typed event bus + SSE subscription | port | AGRUN-255 | OPEN | M | ADR-0036 drafted |
| B | Per-message JSON storage | port | AGRUN-256 | OPEN | M | none |
| C | Compaction as real session turn | port | AGRUN-257 | OPEN | L | B |
| D | `agrun debug` CLI command family | port | AGRUN-258 | OPEN | S | A or B |
| E | Subagent maturity gap-closing | extend AGRUN-254 | AGRUN-259 | OPEN | S | AGRUN-254 |
| F | Speed: collapse LLM evaluators | agrun-internal | AGRUN-260 | OPEN | M | none |
| G | Survey-paper-format skill | skill-side | AGRUN-261 | OPEN | S | none |
| H | Engineering-blog format | preserve | n/a | KEEP | 0 | none |

Recommended execution order: A → B → D → C → E → F → G. Rationale
below.

## Per-item design notes

### A. Typed event bus + SSE subscription

**Source**: opencode `bus/index.ts` + `/event` SSE endpoint. agrun's
`runtime-event-ledger.js` already emits v1 typed events
(AGRUN-248-C); what's missing is the cross-process subscription
surface.

**Plan** (drafted in
[ADR-0036](../adr/0036-typed-event-bus-sse-projection.md)):

1. Add `runtime.subscribeEvents(cb, opts)` in core
   `runtime-event-ledger.js`. Backed by a small in-process emitter
   that also powers the existing `onStep`. No third-party
   EventEmitter dep.
2. Add opt-in `node/runtime-sse-adapter.js` that takes a runtime
   instance and returns a request handler compatible with Node `http`,
   Express, Fastify, Hono, and Web Streams `Response`. No HTTP server
   in core; host wires the handler to their own server.
3. Same v1 event schema — no migration. Multiple projections, one
   source of truth.

**Why first**: unblocks live debugging of every subsequent item.
Without SSE we can't watch compaction or subagent runs from outside
the JS runtime; we're back to log scraping.

**Ticket**: AGRUN-255.

### B. Per-message JSON storage

**Source**: opencode
`~/.local/share/opencode/storage/message/ses_X/msg_Y.json` and
`storage/part/<msg>/<prt>.json`. Per-message persistence enables
post-mortem replay, message-level diffs, and is a hard prerequisite
for opencode-style compaction (compaction needs to identify and mark
old tool outputs as compacted at message granularity).

**Plan** (will be drafted in ADR-0038):

1. Define `Message` and `Part` schemas. Reuse the planner-decision /
   action-result / observation entities already in agrun's event
   ledger. Each cycle in agrun maps to one user-prompted message and
   one assistant turn with multiple parts (text / tool_call /
   tool_result / readinessAudit_observation / planner_decision).
2. Add a sink module (e.g.
   `src/runtime/session-message-store.js`) that subscribes to the
   event ledger (uses Item A's `subscribeEvents`) and writes per-message
   JSON to a host-supplied storage adapter. Browser: IndexedDB.
   Node host with disk: directory path. No persistence in core unless
   host opts in.
3. Optional reverse projection: given a saved message tree, rebuild
   the v1 event sequence for replay / inspector boot. This is the
   "post-mortem debug" workflow opencode users rely on.

**Why second**: prerequisite for C (compaction) and D (debug CLI).
Storage is the hard dependency.

**Ticket**: AGRUN-256.

### C. Compaction as real session turn

**Source**: opencode `session/compaction.ts`. `isOverflow({tokens,
model})` compares input+cache+output against model limit; `prune`
walks messages backwards marking old tool outputs as compacted while
preserving `PRUNE_PROTECT` (~40k tokens) of recent tool calls; a
hidden compaction agent produces a "compact" user part + assistant
summary message pair that the next planner turn treats as the
conversation prefix.

**Plan** (will be drafted in ADR-0039 — depends on AGRUN-256):

1. Add `src/runtime/session-compaction.js` with `isOverflow` +
   `selectCompactionTargets` (the agrun-flavored prune walk) +
   `runCompactionTurn` (the hidden agent invocation).
2. Token counter abstraction per provider — opencode uses
   `model.limit.{input,output,context}`. agrun's `runState.tokenUsage`
   needs an analogous structure; provider adapters
   (OpenAI / Gemini / AI SDK) need to surface model limits.
3. Compaction respects agrun's readinessAudit state — must not prune
   the active workspace candidate, the terminal-repair signal, or
   the source ledger. Conservative whitelist.
4. Compaction is a real session turn: write a `compact` user message
   + `summary` assistant message pair via Item B's storage layer.
   Subsequent planner prompts include the summary in place of the
   compacted history. Replayable.
5. Bus events `compaction.started` / `compaction.completed` via
   Item A's subscription surface.

**Why third**: closes the "agrun fails ugly past provider context
limit" risk. Today every cycle's prompt grows to 30-40 KB by
mid-run; a 50-cycle run would blow past Gemini Flash's effective
context. Compaction is the only path to true >50k-token sessions.

**Risk**: large work. Don't do it before B; the compact+summary pair
needs to live somewhere replayable.

**Ticket**: AGRUN-257.

### D. `agrun debug` CLI command family

**Source**: opencode `cli/cmd/debug/` — `config`, `skill`, `agent`,
`snapshot`, `paths`, `scrap`, `wait`. Each is a tiny inspector
into runtime state. Together they form a debugging Swiss Army knife
no inspector UI replaces.

**Plan**:

1. Add `node/cmd/debug.js` (or extend existing CLI entrypoint with
   a `debug` subcommand router).
2. First slice — three commands:
   - `agrun debug paths` — print resolved storage / cache / config
     directories (mirrors opencode's `debug paths`).
   - `agrun debug skill` — list registered skills with metadata.
   - `agrun debug events --since <seq> --types <glob>` — replay events
     from per-message storage (depends on AGRUN-256) or live via
     `subscribeEvents` (depends on AGRUN-255). Print one JSON line per
     event.
3. Future slices (each its own ticket): `debug config`,
   `debug snapshot`, `debug agent <name>`, `debug scrap`.

**Why fourth**: depends on either A or B being shipped. Even A alone
gives `debug events` value.

**Ticket**: AGRUN-258.

### E. Subagent maturity gap-closing (post AGRUN-254)

**Source**: opencode `tool/task.ts` `TaskTool` (KB memo on subagent
permission inheritance + background subagent pattern). agrun shipped
`spawn_subagent` under AGRUN-254 / ADR-0037 on 2026-05-26 — depth=1
enforcement, shared abort, result envelope. Gaps vs opencode TaskTool:

| Capability | opencode TaskTool | agrun spawn_subagent (AGRUN-254) |
|---|---|---|
| Child session has parentSessionId | yes | yes |
| Resumable task_id | yes (later parent turn resumes same child) | no |
| Permission inheritance from parent agent ruleset | yes (`deriveSubagentSessionPermission`) | partial (depth=1 disabledActions only) |
| Background mode | yes (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`) | no |
| UI: task-tree rendering in inspector | yes (KB memo G5) | no (deferred) |
| Live e2e dogfood | yes | partial — chat UI hangs from event flood |

**Plan**:

1. Resumable `task_id` — extend the v1 result envelope to include a
   stable `task_id`; on a future parent turn, the same id should
   resume the child runState rather than starting fresh.
2. Permission inheritance — apply parent agent's
   denylist + workspace external_directory allowlist to child by
   construction. Matches opencode pattern (KB memo on subagent
   permission inheritance).
3. Inspector task-tree — render parent/child session lineage from
   the event ledger (lineage already on every event from
   AGRUN-240-followup). Defer until A ships SSE so external
   inspectors can subscribe.
4. UI hang fix — investigate the chat-UI re-render storm from child
   events flooding parent's `onStep`. Likely orthogonal to runtime.

**Why fifth**: AGRUN-254 already shipped the core; this is polish.
Depends on A (inspector subscribe) for task-tree rendering.

**Ticket**: AGRUN-259.

### F. Speed: collapse LLM evaluators to rule-based fast-paths

**Note**: this is NOT "adopt from opencode". opencode is faster
because it does ONE planner call per step. agrun is slower because
it does 3-5 LLM evaluators per cycle (planner +
researchAcceptanceEvaluator + requirementRecoveryEvaluator +
readinessAudit + terminalRepairState). Adopting opencode would mean
deleting agrun's gates — the wrong move because gates are agrun's
production advantage.

The right adoption: keep the gates, but make most of them
**rule-based fast-paths** with LLM only as fallback when the rule
returns "uncertain".

**Plan** (will be drafted as a separate audit):

1. Audit each LLM evaluator: identify what fact it's verifying. For
   length: deterministic `len(text.split())` is sufficient — no LLM
   needed. For structure: regex on `^##` headings + duplicate detection
   is sufficient. For source-density: count read_url calls / token
   ratio is sufficient.
2. Replace LLM-only evaluator paths with `if (rule_check_certain) {
   return rule_result } else { fallback_to_llm }`.
3. Measure pre/post: target is 3-5 LLM calls/cycle → 1-2 LLM
   calls/cycle, giving an estimated 2× speedup → agrun ~2-3× faster on
   long-form, closing most of the gap to opencode without losing trust.

**Why sixth**: the speed gap is real but not blocking. Trust /
target-alignment / quality wins are agrun's differentiators; speed
is a secondary optimization.

**Ticket**: AGRUN-260.

### G. Survey-paper-format skill template

**Source**: opencode's flash-3.5 run (oc7) produced an
academic-style report with Abstract + References + Self-Verification
block + ASCII art. agrun's same run produced an engineering-blog
report with named tools + real industry citations.

**Plan**:

1. Add `src/skills/templates/survey-paper.md` (skill template) that
   prompts the model toward academic structure: Abstract → numbered
   sections → References with author/year/title → optional ASCII
   diagram for system comparison → no Self-Verification block (agrun
   verifies independently — model's self-attestation is forbidden).
2. Allow the user to choose at planner time:
   "format: survey-paper" → load this skill. "format:
   engineering-blog" (default) → existing behavior.
3. Both formats use agrun's runtime gates unchanged — only the
   skill-side prompt differs.

**Why seventh / last**: pure skill-side change, no runtime
implications, can ship after any of the others. Optional capability,
not a missing feature.

**Ticket**: AGRUN-261.

### H. Engineering-blog format (preserve)

agrun's default output style — named tools, real citations, no
self-attestation, runtime-verified metrics. Documented in
[opencode-vs-agrun-2026-05-25.md §6 ("Quality is
multi-dimensional")](./opencode-vs-agrun-2026-05-25.md#5-quality-is-multi-dimensional-agrun-and-opencode-are-complementary).
No ticket — preserve.

## Recommended execution order rationale

A first (event subscribe + SSE) — unblocks all debugging for
subsequent work. Without A, every later item is debugged via log
scraping.

B second (per-message JSON storage) — prerequisite for C and D.
Standalone value: post-mortem replay.

D third (debug CLI commands) — small, low-risk, high developer
ergonomics win. Ships independently.

C fourth (compaction) — depends on B. Larger work. Without C,
agrun caps at ~50 cycles before hitting Gemini Flash's effective
context.

E fifth (subagent polish) — depends on A for task-tree rendering.
AGRUN-254 already shipped the core.

F sixth (speed) — internal, no dependencies on opencode patterns.
Ship anytime after the others.

G seventh (survey skill) — pure prompt-side, ships standalone.

Total estimated effort: A=M, B=M, C=L, D=S, E=S, F=M, G=S. If S=2d,
M=5d, L=10d (calendar work weeks for one engineer), total ≈ 32 days
= 6.5 calendar weeks if serial. Realistically A+B+D as a sprint
(~12 days), then C as its own sprint (~10 days), then E+F+G in
parallel (~7 days).

## How this updates other docs

* [task.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/task.md) — new entries AGRUN-255 through AGRUN-261
  under `## Active Roadmap`. Each links back to this doc and to its
  ADR if any.
* [agrun_docs/adr/0036-typed-event-bus-sse-projection.md](../adr/0036-typed-event-bus-sse-projection.md)
  — already drafted. Becomes AGRUN-255 implementation.
* [agrun_docs/adr/0038-per-message-json-storage.md](../adr/0038-per-message-json-storage.md)
  — to be drafted under AGRUN-256.
* [agrun_docs/adr/0039-compaction-as-real-session-turn.md](../adr/0039-compaction-as-real-session-turn.md)
  — to be drafted under AGRUN-257; prerequisite ADR-0038.
* KB MCP — synthesis memo saved 2026-05-26 indexing this roadmap.

## Open questions

1. **Storage adapter contract**: should agrun ship a default Node-FS
   adapter and IndexedDB adapter in core, or only the interface? Per
   "Keep runtime simple" probably only the interface + an example
   adapter in `node/`. Same model as the ADR-0036 SSE adapter.
2. **Compaction model**: should the hidden compaction agent be
   user-selectable, or always use the run's primary model? opencode
   uses the same model. agrun could let `tinyfast model` handle
   compaction cheaper. Decision point in ADR-0039.
3. **Subagent depth>1**: AGRUN-254 hard-locked depth=1. Production
   use case for depth=2+ exists (orchestrator → researcher → fact-checker).
   Defer decision until E ships and we have inspector visibility.
4. **Speed item F priority**: should it jump to first? Argument for:
   user experience improvement. Argument against: agrun's
   differentiator is trust, not speed, and the speed gap is only
   1.5-2× typical. Current ordering (sixth) reflects "trust first,
   speed later."
5. **Survey skill item G interaction with readinessAudit**: a
   model writing in Abstract + Self-Verification format may include
   a `WORD_COUNT:` line. agrun's readinessAudit must ignore that
   line (it's already runtime-measured). Verify no regression.

## How to use this doc

If you're starting work on any item, do:

1. `kb_recall "AGRUN-255"` (or 256, 257, etc) — pulls the synthesis
   memo + linked KB context.
2. Read the relevant ADR.
3. Check `task.md` for current status.
4. Build, ship, update `task.md` ticket row to DONE with evidence.
5. `kb_remember` with `kind: completed-work` linking the commit hash.
