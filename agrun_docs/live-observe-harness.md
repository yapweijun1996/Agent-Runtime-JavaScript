# Live Observe Harness — standard run → observe → debug → rerun loop

File: `test/live-observe.mjs` · Output: `test/live-observe-out/observe-<provider>-<ts>.jsonl`
Date: 2026-06-05

## What it is

A reusable **live-only** (real API key, no mock) observation harness for agrun. It streams, in real time, **both sides of every step** so you can see *why* the model picked a tool and *how* the harness reacted — then asserts structural invariants so it doubles as a test.

- **MODEL side** (redacted `fetch` interception): `llm_request` (what the model saw) + `llm_response` (the action it chose).
- **HARNESS side** (SSOT `runtime.subscribeEvents({visibility:"debug"})`): lifecycle, `action_executing`/`action_executed`, `read-url-requested/completed`, terminal audit, stuck/convergence signals.

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
node test/live-observe.mjs --src                  # observe src/ instead of dist/
```

### Scenarios
- **`quick`** (default): fast factual web lookup, `maxSteps=12`, ~25-50s. The day-to-day debug loop.
- **`report`**: 3000-word in-browser-LLM research report, `maxSteps=120`, timeout 15min. Use this to **live-watch the terminal-repair / publish convergence loop** (the gpt-low non-convergence class) — the `no stuck/repeat convergence signals` invariant trips if the loop reproduces. Can run 10-40min on real API.

`--maxSteps` / `--timeoutMs` / `--prompt` / `--systemPrompt` override the scenario defaults.
Requires a real key in `.env.local` (`OPENAI_API_KEY` / `GEMINI_API_KEY`). It reuses `test/live-helpers.mjs` (`loadLocalSecrets`, `createBrowserRuntime`, `parseCliArgs`) — SSOT, no duplicated infra.

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
2. **SSOT event vocabulary uses underscores** for actions: `action_executing` / `action_executed` (not the hyphenated `action-executed` that the `onStep` callback surfaces). `subscribeEvents({visibility:"debug"})` also emits `agent-workflow-packet`, `read-url-requested/completed`, `terminal-final-contract-audited`, `todo-state-terminal-observed`.
3. **The runtime event stream carries decisions and sizes, not payloads.** `prompt_payload` debug events record only char counts + loop-signal counts; `planner_decision` records the chosen `actionName`/`args`/`decisionType` — but **not** the raw request messages or model reasoning. To explain tool choice you must capture the `fetch` boundary (this harness does). This is the concrete basis for the AGRUN-306 "inspector reason-capture" ask.

## Invariants asserted (structural, live-robust — not exact matches)

- run reached a terminal status (not threw)
- ≥1 real LLM request happened
- model emitted structured action decisions (tool-choice observed)
- runtime executed observable actions on the SSOT stream
- no stuck/repeat convergence signals
- produced a non-empty final answer

These hold across non-deterministic live runs and still catch real regressions (e.g. a publish/terminal-repair loop trips the stuck-signal invariant — the gpt-low non-convergence class).

## Next harness step

Promote `emitProgress`-style capture out of `bench-one.mjs` into a shared module so `bench-one`, the browser Inspector panel, and this harness all consume one SSOT stream (OpenHands EventStream pattern, see `agrun_docs/open-source-agent-projects-study.md`).
