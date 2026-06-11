# Live Observe Harness — standard run → observe → debug → rerun loop

File: `test/live-observe.mjs` · Output: `test/live-observe-out/observe-<provider>-<ts>.jsonl`
Date: 2026-06-05

## What it is

A reusable **live-only** (real API key, no mock) observation harness for agrun. It streams, in real time, **both sides of every step** so you can see *why* the model picked a tool and *how* the harness reacted — then asserts structural invariants so it doubles as a test.

- **MODEL side** (redacted `fetch` interception): `llm_request` (what the model saw) + `llm_response` (the action it chose).
- **HARNESS side** (SSOT `runtime.subscribeEvents({visibility:"debug"})`): lifecycle, `action-executing`/`action-executed` (stream-mode twins of the step events, kebab-case since ADR-0055), `read-url-requested/completed`, terminal audit, stuck/convergence signals.

Both merge into one ordered stdout stream **and** a JSONL file (replayable SSOT).

## Why live-only

Mock runs cannot reveal real tool selection or provider behavior. Production debugging needs real-API data. To keep the loop fast the default scenario is **small** (a quick factual web lookup, ~25–50s), not the 3000-word report.

## Run

```bash
npm run build                                    # observes dist/agrun.js
node test/live-observe.mjs                        # quick scenario (default), openai, ~25-50s
node test/live-observe.mjs --scenario report      # 3000-word report — LIVE-watch the publish loop
node test/live-observe.mjs --provider gemini
node test/live-observe.mjs --maxSteps 8 --prompt "..."
node test/live-observe.mjs --reasoningEffort high
node test/live-observe.mjs --provider deepseek --native   # observe the NATIVE provider:"deepseek" path (default is OpenAI-compatible)
node test/live-observe.mjs --src                  # observe src/ instead of dist/
```

### Scenarios
- **`quick`** (default): fast factual web lookup, `maxSteps=12`, ~25-50s. The day-to-day debug loop.
- **`report`**: 3000-word in-browser-LLM research report, `maxSteps=120`, timeout 15min. Use this to **live-watch the terminal-repair / publish convergence loop** (the gpt-low non-convergence class) — the `no stuck/repeat convergence signals` invariant trips if the loop reproduces. Can run 10-40min on real API.

`--maxSteps` / `--timeoutMs` / `--prompt` / `--systemPrompt` override the scenario defaults.
Requires a real key in `.env.local` (`OPENAI_API_KEY` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`). It reuses `test/live-helpers.mjs` (`loadLocalSecrets`, `createBrowserRuntime`, `parseCliArgs`) — SSOT, no duplicated infra.

## Two standard tools — monitor vs root-cause

The project's standard live observability is **two complementary harnesses**; pick by intent:

| intent | tool | what it answers |
|--------|------|-----------------|
| **monitor** (is output good? cost? time?) | `npm run test:live:standard` ([live-standard-test.md](./live-standard-test.md)) | a scorecard across providers × short/long tasks, with text red-flags |
| **root-cause** (why did it behave that way?) | `npm run test:live:observe` (this harness) | step-by-step model request / decision / thinking + harness SSOT events |

Use the scorecard to **spot** a failing/suspicious cell, then `live-observe` to **explain** it.

### Faithfully tracing the heavy config (`BENCH_OBSERVE`)

`live-observe`'s runtime is lightweight (no research-skill pack loaded), so it does **not** reproduce failures that only appear under the standard matrix's heavy config (research skills + `requiresEvidenceConvergence` source gate + native provider). To trace **that exact config** step-by-step, run `test/bench-one.mjs` with `BENCH_OBSERVE=1` — it adds per-call model-I/O capture (the freshest prompt the model saw, carrying the terminal-repair **deficit** text, plus the model's chosen action + reasoning) to its progress JSONL, on top of the config it already runs:

```bash
BENCH_OBSERVE=1 BENCH_CONFIG='{"id":"obs","provider":"deepseek","model":"deepseek-v4-flash","apiKeyEnv":"DEEPSEEK_API_KEY","priceKey":"deepseek-v4-flash","loadSkills":true,"research":true,"requestedWords":1500,"maxSteps":90,"runDeadlineMs":1200000,"extra":{"reasoningEffort":"high"},"prompt":"<task>"}' \
  node test/bench-one.mjs
# then grep the progress JSONL for type:"observe_io" and the "Source deficit" promptTail
```

`BENCH_OBSERVE` is **off by default** (zero cost otherwise). This is how the deepseek-v4-flash-high long-task source-deficit loop was root-caused.

## Sample live output

```
→ LLM_REQ   gpt-5-mini  tools=[]                       # agrun sends NO native tools
← TOOL_PICK web_search({"query":"Node.js LTS 2026..."})# model's chosen action (parsed from text)
⚙ ACTION    web_search                                  # runtime executes it (SSOT event)
← DECISION  final                                       # terminal decision
── invariants ── (all PASS): terminal status, ≥1 LLM request, tool-choice observed,
   observable actions on SSOT stream, no stuck signals, non-empty answer.
```

## Verified architecture facts (found via this harness on 2026-06-05)

1. **agrun does NOT use provider-native tool-calling.** Every request carries `tools=[]`; the model returns its decision as a **JSON object inside the message content**, e.g. `{"type":"action","name":"web_search","args":{...}}` / `{"type":"final",...}`. The tool catalog lives in the prompt, not the API `tools` field. → Any observer that looks for `tool_calls` will see nothing; parse the **content** instead.
2. **One kebab-case event vocabulary across both surfaces** (ADR-0055): stream events use the same spelling as their step twins — `action-executing` / `action-executed` — and the event `mode` field (`"stream"` vs `"step"`) tells them apart. (Before ADR-0055 the stream surface used `action_executing` / `action_executed`; readers of old traces must accept both.) `subscribeEvents({visibility:"debug"})` also emits `agent-workflow-packet`, `read-url-requested/completed`, `terminal-final-contract-audited`, `todo-state-terminal-observed`.
3. **The runtime event stream carries decisions and sizes, not payloads.** `prompt_payload` debug events record only char counts + loop-signal counts; `planner_decision` records the chosen `actionName`/`args`/`decisionType` — but **not** the raw request messages or model reasoning. To explain tool choice you must capture the `fetch` boundary (this harness does). This is the concrete basis for the AGRUN-306 "inspector reason-capture" ask.

## Invariants asserted (structural, live-robust — not exact matches)

- run reached a terminal status (not threw)
- ≥1 real LLM request happened
- model emitted structured action decisions (tool-choice observed)
- runtime executed observable actions on the SSOT stream
- no stuck/repeat convergence signals
- produced a non-empty final answer

These hold across non-deterministic live runs and still catch real regressions (e.g. a publish/terminal-repair loop trips the stuck-signal invariant — the gpt-low non-convergence class).

## CLI live traces → `agrun.trace.v1` (Chunk 1 adoption)

The single-run `node-*-live.mjs` e2e scripts now emit the canonical **`agrun.trace.v1`**
contract — the same SSOT (`buildLiveTraceContract`, `src/runtime/live-trace.js`) that the
browser Inspector's `InspectorLiveTraceSection` renders. The recipe is uniform: collect
runtime steps via `onStep(step, snapshot) => traceSteps.push({ step, snapshot })`, then call
the `emitTraceV1(...)` helper (`test/helpers/emit-trace-v1.mjs`) after the run. Emission is
**additive** (it never replaces a script's existing jsonl/summary output) and wrapped in
try/catch so a trace failure can never break the e2e.

Output lands in the gitignored `agrun_debug_runs/` dir (override with `AGRUN_DEBUG_DIR`).
One trace file per logical run; multi-run scripts disambiguate by label in the filename:

| script | trace file pattern | one per |
|--------|--------------------|---------|
| `node-host-evidence-live.mjs` | `<runId>.trace.v1.json` | run |
| `node-agrun-publish-gate-live.mjs` | `publish-gate-<ts>.trace.v1.json` | run |
| `node-deepseek-live.mjs` | `deepseek-<ts>-<idx>-<model>.trace.v1.json` | scenario |
| `node-research-followup-live.mjs` | `research-followup-<ts>-<scenario>-turn{1,2}.trace.v1.json` | turn |
| `node-topic-intent-live.mjs` | `topic-intent-<ts>-<event>.trace.v1.json` | turn |
| `node-workspace-multi-edit-live.mjs` | `workspace-multi-edit-<ts>-<variant>.trace.v1.json` | variant |

(Also: `node-agrun-3000-live.mjs`, `bench-one.mjs`, and `live-observe.mjs` emit it.)

### Inspecting a CLI trace

The trace is **shape-compatible with the Inspector by construction** (identical
`buildLiveTraceContract` SSOT), so its `{ meta, input, output, trace[], otel.spans[] }`
fields match what `InspectorLiveTraceSection` already renders. To sanity-check a produced
trace from the CLI — the non-lossy gate every chunk verifies — assert the structured fetch
boundary survived:

```bash
node -e 'const t=require(process.argv[1]); const tr=t.trace||[];
  console.log("schema",t.meta.schemaVersion,"trace",tr.length,
  "req",tr.filter(x=>x.providerRequest).length,
  "resp",tr.filter(x=>x.providerResponse).length,
  "spans",(t.otel?.spans||[]).length,"status",t.meta.status)' \
  "$(pwd)/agrun_debug_runs/<file>.trace.v1.json"
# expect: schemaVersion=agrun.trace.v1, trace>0, req>=1 AND resp>=1, spans>0, status=completed
```

### Load a CLI trace into the Inspector (Chunk 1 acceptance #3 — DONE)

The shipped Inspector now ingests an external CLI trace directly. Open the browser example
with debug enabled (`?debug_yn=y`), and the Inspector's **Load Trace File** section (top of
the panel, visible even with no in-browser turn) takes a `.trace.v1.json` via
`Choose .trace.v1.json` and renders it through the **same** `InspectorLiveTraceSection`
view used for in-browser runs (metric tiles, Trace Health, Step Timeline, provider
request/response summaries, OTel span tree). It validates `meta.schemaVersion ===
"agrun.trace.v1"` and a non-empty `trace[]` before rendering; a bad file shows an inline
error instead. Components: `InspectorTraceFileLoader.tsx` (the loader) +
`InspectorLiveTraceSection.tsx` (now accepts an optional `liveTrace` override prop).

Verified live (chrome-devtools, 2026-06-09): loaded a host-evidence CLI trace; the panel
rendered status=completed, requests=5, responses=5, spans=41 — **identical to the CLI
non-lossy gate** for that file. The shipped Inspector is now the universal viewer for both
production and CLI test traces.

## Next harness step

Promote `emitProgress`-style capture out of `bench-one.mjs` into a shared module so `bench-one`, the browser Inspector panel, and this harness all consume one SSOT stream (OpenHands EventStream pattern, see `agrun_docs/open-source-agent-projects-study.md`).
