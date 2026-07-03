# AGRUN-533 Live E2E - 1500-word Loop Engineering report (2026-06-17)

## Result

The live E2E run completed, but the generated report is **not production-ready quality**. The runtime did produce a final answer and the internal acceptance gates reported 100/100, yet human review and trace review found four production blockers:

1. The report has duplicated/redundant sections and several reference sections.
2. The source gate is inconsistent: `qualityScore.gates.source=true`, but `sourceMinimumPassed=false`.
3. The trace metadata dropped the effective Gemini low-thinking configuration.
4. The run is too slow and token-heavy for a normal 1500-word production report.

## Commands

```bash
npm run build && npm run test:live:multiturn-standard

AGRUN_DEBUG=1 NODE_AGRUN_LIVE_DEBUG=1 \
AGRUN_DEBUG_RUN_ID=loop-engineering-1500-gemini-low-20260617T030658Z \
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=low \
NODE_AGRUN_LIVE_WORDS=1500 \
NODE_AGRUN_LIVE_MAX_STEPS=70 \
NODE_AGRUN_LIVE_TIMEOUT_MS=240000 \
NODE_AGRUN_LIVE_MIN_CITATIONS=3 \
NODE_AGRUN_LIVE_PROMPT='Write a 1500-word production-focused research report on "Loop Engineering and Harness Engineering for general AI agent runtimes". Use web_search and read_url to ground every section in real sources. Cite at least 3 authoritative URLs. Focus on runtime loop design, monitoring, traces, performance, accuracy, failure modes, and production readiness. Structure: Definition, Core Principles, Loop Architecture, Monitoring and Traces, Performance Engineering, Accuracy and Source Grounding, Anti-patterns, Production Readiness Checklist, Conclusion.' \
node test/node-agrun-3000-live.mjs
```

## 5-turn monitor rerun

| Provider | Model / knobs | Result | Wall time | LLM requests | Tokens | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| OpenAI | `gpt-5.4-mini`, Responses API, `reasoningEffort=low` | PASS | 16.0s | 5 | 17,227 | Direct final-answer path, no runtime actions |
| Gemini | `gemini-3.1-flash-lite`, `thinkingLevel=low` | PASS | 8.6s | 5 | 19,297 | Direct final-answer path, no runtime actions |

Artifacts:

- `test/live-observe-out/multiturn-standard-openai-2026-06-17T03-06-08-104Z.md`
- `test/live-observe-out/multiturn-standard-openai-2026-06-17T03-06-08-104Z.jsonl`
- `test/live-observe-out/multiturn-standard-gemini-2026-06-17T03-06-24-161Z.md`
- `test/live-observe-out/multiturn-standard-gemini-2026-06-17T03-06-24-161Z.jsonl`

## 1500-word live report metrics

| Metric | Value | Production reading |
| --- | ---: | --- |
| Status | completed | Completion only; not quality acceptance |
| Duration | 251.0s | Too slow for a standard 1500-word report |
| Provider calls | 64 | Excessive loop churn |
| Total trace steps | 1,540-1,541 | High orchestration overhead |
| Observed action time | 7.946s | Tools are not the bottleneck |
| Provider latency | 241.116s in summary, 208.338s in trace | LLM loop dominates wall time |
| Input tokens | 1,046,699 | Too high for this deliverable |
| Output tokens | 48,376 | High repair/rewrite cost |
| Total tokens | 1,095,075 | Not production efficient |
| Final report words | 1,751 by `wc -w` | Length OK |
| Successful `read_url` | 3 | Minimum raw count met |
| `sourceMinimumPassed` | false | Conflicts with score gate |
| Acceptance score | 100/100 | False positive against human review |

Artifacts:

- `agrun_debug_runs/loop-engineering-1500-gemini-low-20260617T030658Z.md`
- `agrun_debug_runs/loop-engineering-1500-gemini-low-20260617T030658Z.jsonl`
- `agrun_debug_runs/loop-engineering-1500-gemini-low-20260617T030658Z-report.md`
- `agrun_debug_runs/loop-engineering-1500-gemini-low-20260617T030658Z.trace.v1.json`

## Step timing finding

The slow part is not web search or read URL. Timed actions total only 7.946s:

| Action | Count | Total | Max |
| --- | ---: | ---: | ---: |
| `web_search` | 1 | 3.194s | 3.194s |
| `read_url` | 3 | 4.603s | 2.158s |
| `workspace_propose_patch` | 15 | 0.039s | 0.005s |
| `workspace_insert_after_section` | 10 | 0.036s | 0.013s |
| `workspace_read` | 9 | 0.009s | 0.001s |
| `workspace_publish_candidate` | 2 | 0.032s | 0.029s |

Root cause: provider/planner loop latency and repeated repair cycles dominate. The trace shows 64 planner cycles, 7 planner repair requests, 12 repeated action fingerprints, and 86 terminal repair refreshes. The main repeated failure shape was `duplicate_headings`, especially around references and post-finalization structure repair.

## Report quality review

The final report is readable but not production-ready:

- It contains overlapping sections such as `Monitoring and Traces` plus `Advanced Monitoring and Traces`.
- It contains overlapping performance sections such as `Performance Engineering` plus `Performance Engineering in Production`.
- It contains many reference/resource sections: `References`, `Additional References`, `Additional Resources`, `References Cited`, and `Further Reading`.
- It appends a core-principles paragraph after the reference/further-reading area.
- It cites only secondary/blog-style pages in the final references, not primary OpenAI/Anthropic/provider documentation.

This means the harness gate is still too shallow for long-form production writing. A completed run with 100/100 internal quality score can still be unacceptable after human review.

## Trace observability issue

The run started with Gemini low thinking:

```json
{"geminiThinkingConfig":{"thinkingLevel":"low"}}
```

But `trace.v1.json` metadata records:

```json
{
  "geminiThinkingConfig": null,
  "thinkingLevel": null,
  "thinkingBudget": null
}
```

This blocks reliable production monitoring because the trace cannot prove what provider thinking/effort setting was used.

## Production verdict

| Surface | Verdict |
| --- | --- |
| Simple 5-turn chat runtime | Ready for the current standard monitor |
| Long 1500-word report runtime | Not ready to call production-grade |
| Trace timing visibility | Useful but incomplete |
| Report quality gate | Not strict enough |
| Source grounding gate | Inconsistent and needs SSOT repair |

## Follow-up tickets

- `AGRUN-533`: This live report record and production-readiness verdict.
- `AGRUN-534`: Fix source gate SSOT mismatch between `qualityScore.gates.source` and `sourceMinimumPassed`.
- `AGRUN-535`: Strengthen long-report structure gate for duplicate reference/resource sections and post-reference content.
- `AGRUN-536`: Preserve provider thinking/effort configuration in trace v1 metadata.
- `AGRUN-537`: Add a performance SLO and loop-churn guard for 1500-word report runs.

## Recommended SLO for the next run

For a 1500-word production report on low-thinking fast models:

- Wall time: <= 90s.
- Provider calls: <= 25.
- Total tokens: <= 300k.
- `read_url`: >= 3 successful, and final citations must come from the successful read ledger.
- No duplicate reference/resource sections.
- No body content after final references.
- Trace must include effective model, API variant, reasoning effort, and Gemini thinking config.

## Post-fix rerun (AGRUN-534..537)

After adding stricter source/structure gates, trace provider-knob capture, and an opt-in performance SLO, the same live E2E was rerun with:

```bash
NODE_AGRUN_LIVE_PERFORMANCE_SLO=1
NODE_AGRUN_LIVE_PROVIDER=gemini
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite
NODE_AGRUN_GEMINI_THINKING_LEVEL=low
NODE_AGRUN_LIVE_WORDS=1500
NODE_AGRUN_LIVE_MAX_STEPS=70
NODE_AGRUN_LIVE_TIMEOUT_MS=240000
NODE_AGRUN_LIVE_MIN_CITATIONS=3
```

Result: the run completed and published, but the harness correctly failed it.

| Metric | Before | After | Reading |
| --- | ---: | ---: | --- |
| Wall time | 251.0s | 154.9s | Better, still fails 90s SLO |
| Provider calls | 64 | 28 | Better, still fails 25-call SLO |
| Total tokens | 1,095,075 | 450,239 | Better, still fails 300k SLO |
| Total steps | ~1,541 | 676 | Better |
| `action-fingerprint-repeat` | 12 | 1 | Better |
| Quality score | 100/100 false positive | 75/100 | Correctly fails structure |
| Report red flags | missed | `semantic-duplicate-sections(2)` | Correctly detected |
| Trace thinking config | null | `{"thinkingLevel":"low"}` | Fixed |

Artifacts:

- `agrun_debug_runs/loop-engineering-1500-gemini-low-slo-20260617T035424Z.md`
- `agrun_debug_runs/loop-engineering-1500-gemini-low-slo-20260617T035424Z.jsonl`
- `agrun_debug_runs/loop-engineering-1500-gemini-low-slo-20260617T035424Z-report.md`
- `agrun_debug_runs/loop-engineering-1500-gemini-low-slo-20260617T035424Z.trace.v1.json`

New verdict:

- `AGRUN-534` fixed: explicit `sourceMinimumPassed=false` no longer gets overridden by cited-readable fallback. This rerun had `sourceMinimumPassed=null`, `citedReadableUrlCount=3`, and source gate passed consistently.
- `AGRUN-535` fixed: report-quality red flags now fail the structure gate. The report had repeated Architecture/Monitoring/Performance sections and failed with `semantic-duplicate-sections(2)`.
- `AGRUN-536` fixed: trace v1 now preserves `geminiThinkingConfig.thinkingLevel=low`.
- `AGRUN-537` fixed as a harness gate: SLO is recorded and enforced when enabled. The run failed because duration, provider calls, and tokens exceeded thresholds.

Remaining production work:

- `AGRUN-538`: optimize the long-report workflow so the runtime actually meets the SLO and avoids semantic duplicate section expansion, instead of merely detecting the failure after publish.
