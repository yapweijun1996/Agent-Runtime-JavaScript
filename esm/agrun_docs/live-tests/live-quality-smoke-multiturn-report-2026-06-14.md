# Live Quality Smoke, Multi-turn, and 1500-word Report Test - 2026-06-14

## Result first

| Test | Provider/model | Result | Main finding |
|---|---|---|---|
| Direct single-shot greeting/date | OpenAI `gpt-5-mini` | Completed, but observe invariant failed by design | 8.5s, 1 LLM request, no tool/action. Good for latency baseline; `live-observe` currently treats no-tool direct answers as invariant failures. |
| Tool single-shot | OpenAI `gpt-5-mini` | Passed observe invariants | 24.9s, 4 provider/fetch boundary events, 1 `web_search` action. A simple "search once then answer" is not one API call. |
| Multi-turn direct chat | OpenAI `gpt-5-mini` | Completed, but exposed overhead and one factual error | 4 turns in 38.5s, 8 LLM requests. Each direct turn used answer call + memory extraction call returning `{"entries":[]}`. Time question returned `00:00:00` while local time was `2026-06-14 19:25:10 +08`. |
| 1500-word report | Gemini `gemini-3.1-flash-lite` thinking low | Completed but failed quality gate | 3.2 min, 1008 steps, 46 LLM usage calls, 2 web_search, 5 read_url, 1556 candidate words, qScore 75, source gate failed, red flag `cited-unread-urls(3)`. |

This run confirms the runtime is observable enough to diagnose behavior from raw JSONL, but current simple-chat and long-report behavior still has avoidable overhead and quality gaps.

## Commands

```bash
npm run build

node test/live-observe.mjs \
  --provider openai \
  --maxSteps 4 \
  --timeoutMs 120000 \
  --systemPrompt "You are agrun.js in a speed test. Answer directly unless a tool is needed. Keep answers under 30 words." \
  --prompt "Hello. Reply with one short greeting and today's date in Asia/Kuala_Lumpur. Do not use web_search or read_url."

node test/live-observe.mjs \
  --provider openai \
  --maxSteps 8 \
  --timeoutMs 120000 \
  --systemPrompt "You are agrun.js in a live observability test. If the user requests web_search, use it once, then answer briefly with the source URL." \
  --prompt "Use web_search once to check the current Node.js LTS major version, then answer in one sentence with the source URL. Do not use read_url."

BENCH_CONCURRENCY=1 BENCH_OBSERVE=1 \
  node test/live-standard.mjs --tier long --only gemini-3.1-flash-lite-low
```

The multi-turn session used an inline Node script with `runtime.createSession()`, `createObserver()`, and the OpenAI provider config from `.env.local`. The script wrote the ordered JSONL and summary artifacts listed below.

## Artifacts

| Artifact | Path |
|---|---|
| Direct single-shot JSONL | `test/live-observe-out/observe-quick-openai-2026-06-14T11-22-26-264Z.jsonl` |
| Direct single-shot trace | `test/live-observe-out/observe-quick-openai-2026-06-14T11-22-26-264Z.trace.v1.json` |
| Tool single-shot JSONL | `test/live-observe-out/observe-quick-openai-2026-06-14T11-22-58-890Z.jsonl` |
| Tool single-shot trace | `test/live-observe-out/observe-quick-openai-2026-06-14T11-22-58-890Z.trace.v1.json` |
| Multi-turn JSONL | `test/live-observe-out/multiturn-openai-2026-06-14T11-23-57-256Z.jsonl` |
| Multi-turn report | `test/live-observe-out/multiturn-openai-2026-06-14T11-23-57-256Z.md` |
| Multi-turn summary | `test/live-observe-out/multiturn-openai-2026-06-14T11-23-57-256Z.summary.json` |
| Long report scorecard | `test/live-standard-out/SCORECARD.md` |
| Long report metrics | `test/live-standard-out/metrics-long-gemini-3.1-flash-lite-low.json` |
| Long report progress JSONL | `test/live-standard-out/progress-long-gemini-3.1-flash-lite-low.jsonl` |
| Long report output | `test/live-standard-out/report-long-gemini-3.1-flash-lite-low.md` |
| Long report trace | `test/live-standard-out/trace-long-gemini-3.1-flash-lite-low.v1.json` |

Do not paste the full progress JSONL into docs. With `BENCH_OBSERVE=1`, it contains large model response excerpts and Gemini `thoughtSignature` fields. Use it as raw local evidence, not as copied documentation text.

## Observations

### Direct single-shot

The direct greeting/date run completed in 8.5s with one real LLM request and a final answer:

```text
Hi. 2026-06-14 (Asia/Kuala_Lumpur).
```

The `live-observe` invariant check failed two checks:

- model emitted structured action decisions
- runtime executed observable actions

That failure is expected for direct-answer tests because the harness invariants assume at least one tool/action. This should be treated as a testing-harness classification gap, not a runtime failure.

### Tool single-shot

The web-search run completed in 24.9s:

- status: `completed`
- LLM requests / provider boundary events: 4
- tool picks: `web_search`
- observable actions: 1
- all live-observe invariants passed

Raw sequence:

```text
llm_request -> action:web_search -> provider/search boundary -> action-executed:web_search -> llm_request -> finalize -> final text generation
```

This is important for latency expectations: even "search once then answer" is not a single API call in the current harness. The runtime is doing OODAE-style observe/orient/decide/act/evaluate around the tool action.

### Multi-turn direct chat

Four direct turns completed in 38.5s. The raw JSONL had 8 LLM requests and 8 LLM responses:

| Turn | Prompt class | Wall time | Behavior |
|---|---:|---:|---|
| 1 | greeting | 7.1s | final answer call + memory extraction call |
| 2 | date/time | 13.5s | final answer call + memory extraction call; returned wrong time |
| 3 | Harness Engineering explanation | 7.2s | final answer call + memory extraction call |
| 4 | Transformer explanation | 9.8s | final answer call + memory extraction call |

The memory extraction responses were all:

```json
{"entries":[]}
```

This is the clearest simple-chat performance issue found in this run: a direct, no-tool chat turn pays an extra LLM call for memory extraction even when no memory is extracted. This is a good candidate for opt-in, async, batched, or host-policy controlled memory behavior.

The date/time answer was also wrong:

```text
The current date and time in Asia/Kuala_Lumpur is 2026-06-14 00:00:00 (MYT).
```

Local clock during the test:

```text
2026-06-14 19:25:10 +08
```

For general frontend use, time-sensitive questions need a trustworthy host time context/tool, not model guessing.

### 1500-word report

The standard long cell completed but failed the monitoring quality gate:

| Metric | Value |
|---|---:|
| status | `completed` |
| wall time | 3.2 min |
| step count | 1008 |
| event count | 1009 |
| LLM usage calls | 46 |
| total tokens | 778,605 |
| cache-hit tokens | 302,465 |
| cost | `$0.14022` |
| web_search/read_url | 2 / 5 |
| candidate words | 1556 |
| qScore | 75 |
| gates | length pass, structure pass, source fail |
| scorecard pass | false |
| red flag | `cited-unread-urls(3)` |

The report has enough length, but it is not a good deliverable:

- Source gate failed even though `workspace_publish_candidate` completed.
- The final Sources list cites 4 URLs, but 3 were not in the successful read ledger.
- The report repeats semantically similar sections: `Core Principles`, `Core Principles of Harness Engineering`, `Anti-patterns`, `Common Anti-patterns`, `Real-World Examples`, and `Case Studies`.
- The text is plausible but generic. It does not consistently connect claims to the sources it actually read.

The read ledger:

| URL | Tier |
|---|---|
| `https://www.mindstudio.ai/blog/what-is-harness-engineering` | strong |
| `https://martinfowler.com/articles/harness-engineering.html` | strong |
| `https://github.com/ai-boost/awesome-harness-engineering` | blocked |
| `https://milvus.io/blog/harness-engineering-ai-agents.md` | blocked |
| `https://atlan.com/know/what-is-harness-engineering/` | strong |

The final report cited:

| URL | Problem |
|---|---|
| `https://www.nxcode.io/resources/news/what-is-harness-engineering-complete-guide-2026` | cited but not read |
| `https://atlan.com/know/what-is-harness-engineering/` | read |
| `https://harness-engineering.ai/blog/agent-harness-complete-guide/` | cited but not read |
| `https://www.reddit.com/r/ArtificialInteligence/comments/1sc3m1t/harness_engineering_turning_ai_agents_into/` | cited but not read; fetched page is verification shell, not useful article content |

## Activity log diagnosis

The raw progress stream shows the long report did not fail because the model refused to work. It did a lot of work:

- action occurrences in runtime steps included `web_search`, `read_url`, `workspace_write`, `workspace_insert_after_section`, `workspace_read`, `workspace_propose_patch`, `workspace_review_candidate`, `workspace_finalize_candidate`, and `workspace_publish_candidate`.
- It reached a 1556-word `final_candidate.md` with structure pass.
- It repeatedly tried to satisfy review/publish rules.

The inefficient part is the tail of the loop:

- At one point the candidate was already 1556 words and structure-ready.
- Runtime state still showed `candidate_quality_signal=status:blocked, blockingIssues:missing_latest_candidate_review`.
- The model executed `workspace_review_candidate` multiple times, but prompt state later still showed `candidate_review=none` / `missing_latest_candidate_review`.
- It attempted a multi-action plan containing `workspace_review_candidate`; plan validation rejected it because review mutates planner state and cannot appear inside a plan.
- It then continued with more read/review/publish work before finally publishing.

This is high observability and low efficiency: the harness exposes the problem clearly, but the workflow still burns many steps after the report is already mostly ready.

## Follow-up tasks filed

- `AGRUN-517`: Optimize session memory extraction for simple multi-turn chat.
- `AGRUN-518`: Provide trustworthy host time context/tool for time-sensitive prompts.
- `AGRUN-519`: Fix long-report evidence/citation mismatch and publish quality gate.
- `AGRUN-520`: Detect semantic duplicate report sections beyond exact repeated headings.
- `AGRUN-521`: Adjust live-observe direct-answer invariants so no-tool smoke tests are classified honestly.

## Conclusion

The general runtime is improving in observability: raw JSONL, trace v1, scorecard, metrics, and report artifacts give enough information to explain behavior. The main regression risks are now quality and efficiency:

1. Direct chat has avoidable memory extraction overhead.
2. Time-sensitive questions can hallucinate time without host context.
3. Long reports can complete/publish while source gate fails and citations do not match read evidence.
4. The long-report loop can spend many cycles on review/plan/publish protocol even after a usable draft exists.

The next work should focus on reducing unnecessary calls while keeping AI-first behavior and source-backed quality gates.
