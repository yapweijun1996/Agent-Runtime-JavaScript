# Sample Project Inspector Payload/Response Review - 2026-05-10

## Goal

Review `sample project for study logic/` for a better `agrun.js` Inspector
solution around LLM request payloads, model responses, source evidence windows,
and payload optimization.

The current pain point is:

- Inspector can show high-level LLM trace numbers, but deep debugging still
  requires guessing which part of the request or response caused growth.
- `read_url` evidence can be deliberately bounded, but the AI and engineer need
  a visible way to continue reading later windows.
- Long, multi-turn agent workflows need request/response observability without
  turning runtime into a content judge or leaking secrets.

## Samples Checked

| Sample | Files checked | Relevant pattern |
| --- | --- | --- |
| `agents-js` | `utils/agent-trace.js`, `agents.js` | Event collector records typed turn/tool/state events, redacts sensitive keys, keeps bounded event history, exports a session trace with summary plus normalized events. |
| `codex-main` | `codex-rs/core/src/rollout/list.rs`, `codex-rs/core/tests/common/responses.rs`, `codex-rs/core/tests/suite/prompt_caching.rs` | Rollout/session records are pageable by cursor; tests inspect exact captured request bodies via request logs; prompt caching tests compare request payload stability across turns. |
| `claude-code-source-code-main` | `src/remote/sdkMessageAdapter.ts` | Compaction is represented as an explicit `compact_boundary` system message; unknown/SDK-only events are ignored safely but logged for debugging. |
| `open-webui-main` | `backend/open_webui/tasks.py`, `backend/open_webui/socket/main.py`, `src/routes/+layout.svelte` | Active task IDs, cancellation, socket event routing, and streamed completion chunks are first-class lifecycle signals, not inferred from final text. |
| `goose-1.27.2` | `crates/goose/src/conversation/mod.rs`, `crates/goose/src/conversation/tool_result_serde.rs` | Agent-visible and user-visible messages are separated; tool results use validated success/error envelopes and log malformed originals for debugging. |
| `openclaw-2026.3.8` | `src/context-engine/types.ts` | Context engine exposes assemble/compact contracts with token budgets, token before/after metrics, and compaction reasons. |
| `langgraph-cli-0.4.14` | `libs/langgraph/langgraph/pregel/main.py`, `libs/langgraph/langgraph/pregel/debug.py` | Stream modes split values, updates, custom events, messages, checkpoints, tasks, and debug; state history can be queried through checkpoint-backed APIs. |
| `swarm-main` | `swarm/core.py`, `README.md` | Minimal loop and tool result handoff are easy to trace, but durable state is caller-owned. Useful baseline, not enough for deep Inspector debugging. |

## Answer: Got Solution?

Yes. The best solution is a **Trace Capsule + Windowed Payload Inspector**
pattern.

It should not be a raw full-payload dump by default. Full dumps are too large,
hard to scan, risky for secrets, and bad for browser performance.

The harness should keep two layers:

1. **Summary layer**: always visible and small.
   - request id / cycle / phase / provider / model
   - request char budget split: system, messages, session context, tool schema
   - response split: text, reasoning, tool calls, finish reason, error
   - delta from previous request and `topGrowthSource`
   - compaction/window signals

2. **Window layer**: explicit, pageable, and redacted.
   - request windows: `requestId`, `section`, `start`, `length`, `nextStart`
   - response windows: `requestId`, `section`, `start`, `length`, `nextStart`
   - evidence windows: `url`, `textStart`, `textLength`, `nextTextStart`
   - copyable next arguments for the AI/engineer to inspect more only when
     needed

This matches the sample-project lesson:

- `agents-js` keeps a bounded redacted event trace instead of unbounded raw logs.
- `codex-main` makes transcript/request records pageable and test-inspectable.
- `claude-code` treats compaction as an explicit visible boundary.
- `open-webui` treats streaming/task lifecycle as event data.
- `goose` validates envelopes and keeps debug visibility separate from
  agent-visible messages.
- `openclaw` tracks context token before/after and compaction reason.

## Proposed agrun Pattern

Name: `windowed_trace_capsule`.

Runtime/Browser responsibilities:

- Keep `runtime_steps` as the SSOT event ledger.
- Add a browser-side Inspector projection that builds trace capsules from
  runtime/provider events.
- Store raw request/response windows only in local debug state, behind redaction
  and size limits.
- Show summaries by default; reveal windows only by explicit user/AI action.
- Use the same window idea for `read_url`, prompt payloads, response text, and
  finalizer source context.

Trace capsule shape:

```json
{
  "requestId": "planner:run-3:cycle-2",
  "phase": "decide",
  "provider": "openai",
  "model": "gpt-*",
  "summary": {
    "systemChars": 1200,
    "messageChars": 9400,
    "sessionContextChars": 2200,
    "toolSchemaChars": 4800,
    "responseTextChars": 700,
    "toolCallCount": 1,
    "topGrowthSource": "message"
  },
  "windows": [
    {
      "section": "messages",
      "start": 0,
      "length": 1800,
      "nextStart": 1800,
      "hasAfter": true
    }
  ],
  "redaction": {
    "applied": true,
    "sensitiveKeyCount": 2
  }
}
```

## Proposed Inspector Event Schema

The sample projects point to a better event taxonomy than one large debug blob.
`agrun.js` can keep `runtime_steps` as the SSOT, but Inspector should project
events into five stable classes:

| Event class | Purpose | Sample reference | agrun projection |
| --- | --- | --- | --- |
| `stream_event` | model/provider streaming chunks, finish, errors, response ids | LangGraph stream modes, Goose SSE, Claude SDK stream messages | LLM Trace response stream, finalizer stream |
| `tool_event` | tool call request, begin, result, error, approval, frontend tool | Goose tool request/response, agents-js tool events, Swarm tool result messages | Runtime Lifecycle, Action Result Envelopes, Evidence |
| `checkpoint_event` | context/session state boundary, resume/fork, compaction | LangGraph checkpoint history, Codex rollout compacted item, Claude compact boundary | Session context projection, compaction marker, finalizer source window |
| `debug_event` | non-agent-visible diagnostics, redaction stats, top growth source | agents-js trace collector, Codex request-log tests, Claude debug/dump prompts | Debug Index, Support Bundle, LLM Trace deltas |
| `window_event` | partial source/request/response view with next window cursor | Goose shell preview + temp full output, Codex cursor pagination, read_url windows | Read URL Windows, request window, response window |

Recommended event envelope:

```json
{
  "eventId": "run-3:cycle-2:llm-request",
  "runId": "run-3",
  "cycleId": "cycle-2",
  "class": "window_event",
  "phase": "decide",
  "visibility": "debug_only",
  "agentVisible": false,
  "userVisible": true,
  "payload": {
    "requestId": "planner:run-3:cycle-2",
    "section": "messages",
    "start": 0,
    "length": 1800,
    "nextStart": 1800,
    "hasAfter": true
  }
}
```

Visibility rule:

- `debug_only`: Inspector/support export only; never injected into model context.
- `agent_projection`: compact mechanical fact intentionally passed to AI.
- `user_visible`: safe UI summary.

This prevents raw debug data from silently becoming prompt context.

## Six SSOT Modules To Implement Later

The sample research suggests six small observability modules rather than one
large Inspector-specific subsystem:

1. `llm_request_trace`: captures provider/model/requestId and size split.
2. `llm_response_trace`: captures stream chunks, response ids, finish/error,
   usage, and response windows.
3. `session_transcript`: stores user/assistant/tool/compaction transcript
   boundaries in browser-safe local storage.
4. `compaction_marker`: records before/after budget, reason, and preserved
   state shape.
5. `redaction_policy`: shared redaction for support bundle, LLM Trace, windows,
   export, and tests.
6. `inspector_event_stream`: typed projection over `runtime_steps` that feeds
   visible Inspector sections.

The implementation should stay browser-first. The samples' backend socket
servers, JSONL files, and database checkpoints are references, not required
runtime dependencies.

## Why This Is AI-First

The runtime does not decide whether a report is good, long enough, or has enough
sources. It only makes the request/response/evidence path visible and
continuable.

The AI or engineer can then decide:

- read the next source window;
- inspect the next request window;
- reduce duplicated session context;
- compact tool schemas;
- continue the workflow;
- finalize with limitations.

This is harness engineering: observe, preserve, expose, and route. The harness
does not perform the AI's reasoning work.

## Mapping To Current agrun

Already close:

- `LLM Trace` shows system/message/session/schema deltas and top growth source.
- `Read URL Windows` shows range/next/more and copyable next args.
- `OODAE Cycles`, `Runtime Lifecycle`, `AI Workflow`, and `Debug Index` are
  projections over runtime events.

Recommended next improvements:

1. Keep expanding actual backing window retrieval for sources whose safe preview
   is shorter than the original section.
2. Add compaction-specific event detail when runtime starts recording explicit
   before/after compaction budgets.
3. Add more sample-backed UI affordances for comparing two selected request
   windows side by side.

## Implemented Follow-Up - 2026-05-10

Implemented the first production slice of `windowed_trace_capsule` in the
browser Inspector:

- `buildLlmTraceLedger` now attaches `windows`, `redactionStats`, and
  `payloadOptimizationHints` to each request/response trace row.
- `InspectorLlmTraceSection` shows request/response windows, range/total,
  available preview chars, `nextStart`, source hash, redaction policy, and
  copyable next-window args.
- `buildInspectorEventStream` projects `runtime_steps` into
  `debug_event`, `stream_event`, `tool_event`, `checkpoint_event`, and
  `window_event` rows.
- Support Bundle, Debug Index, Debug Report, and Raw tabs now expose
  `inspectorEventStream`, checkpoint counts, window counts, hint counts, and
  redaction marker counts.
- `payloadOptimizationHints` are mechanical only: large payload/schema/session
  signals, request delta growth/reduction, slow/high-token/empty/tool-call
  response signals. No final-answer quality or source sufficiency judgment was
  added.

Important constraint: current request/response windows are built from the
existing safe trace summaries, not full raw provider payloads. If a source
summary only retained a 1200-char preview for a 6400-char message, Inspector
can show `nextStart=1800` and copy the next-window args, but a later retrieval
hook still needs an original backing source to materialize chars after the
stored preview. This keeps secrets/performance safe while making the missing
window explicit.

Verification:

- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run test:smoke -- inspector-debug-report`
- `npm --prefix examples/browser run build`
- Chrome DevTools live UI check at `http://localhost:3001/?debug_yn=y` with a
  synthetic LLM trace session. Inspector rendered `WINDOWS=3`, `HINTS=1`,
  `window:messages[0]`, `range:0-1800/6400`, `next:1800`, `copy_next_args`,
  and no console errors.

## Non-Goals

- No full raw payload always visible in the UI.
- No secret-bearing payload export by default.
- No runtime word-count/source-count/content-quality gate.
- No copied sample architecture, backend socket server, or persistent transcript
  database in the browser runtime core.

## HBR

The sample projects do not provide a single ready-made browser Inspector for
LLM payload optimization. They provide building blocks. The safe agrun solution
is a small harness projection: summary first, explicit windows on demand,
redacted payload slices, and request/response/evidence all using the same
pagination idea.
