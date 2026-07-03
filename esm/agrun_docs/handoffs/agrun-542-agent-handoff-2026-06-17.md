# AGRUN-542 Agent Handoff

Date: 2026-06-17

## Current Result

AGRUN-541 was implemented and committed as `cf8bfe1ed Harden length-preserving terminal repair`.

Latest live E2E result is still not production-ready:

| Metric | Latest result |
| --- | ---: |
| Artifact | `agrun_debug_runs/2026-06-17T08-05-00-854Z.*` |
| Exit code | 1 |
| Duration | 183.8s |
| Provider calls | 23 |
| Total tokens | 378,428 |
| Action fingerprint repeats | 2 |
| Candidate length | 1739 words |
| Quality score | 50/100 |
| Gates | length pass, structure fail, source/citation fail |

The run improved materially versus the previous 340.9s / 70 calls / 1.239M tokens run, but it still fails SLO and quality.

## What AGRUN-541 Fixed

- Candidate progress detects material candidate/length regression.
- Workspace mutation growth convergence escalates repeated candidate regression.
- Requirement recovery tracks length regression.
- `workspace_write` blocks destructive final-candidate rewrites that reopen a requested length deficit.
- Requested length is read from direct acceptance packet, gated acceptance packet, and prompt-derived length contract.
- `inspectWorkspacePublishProtocol` now treats only content-changing mutation statuses as writes. Blocked/no-op operations like `destructive_shrink_blocked` and `replace not_found` no longer stale finalize/read/review protocol.

Verification:

- `npm run build` passed.
- `npm test` passed with all 227 discovered tests.
- Focused workspace/protocol tests pass.

## Remaining Root Cause

The remaining issue is content-level structure repair under terminal repair:

1. The model reaches a valid length and reads enough sources.
2. It creates duplicate/semantic duplicate sections and body after final section.
3. The runtime blocks destructive shrink rewrites, preserving length.
4. The AI review admits the candidate is not ready.
5. The planner still attempts direct `finalize` repeatedly under terminal repair before hard veto.
6. It eventually publishes limited, but quality remains failed.

Tool time is not the slow path. Latest observed action time was 2.292s out of 183.756s. The slow path is provider/planner loop churn and oversized prompt context after failed repair turns.

## Next Task: AGRUN-542

Make content-level structure repair a hard terminal contract.

Required behavior:

- During terminal repair hard veto, direct `finalize` / `final_answer` must not be a usable escape when a workspace candidate exists and `workspace_publish_candidate` is the correct terminal path.
- If `semantic_duplicate_headings` or `body_after_final_section` remains while length/source are satisfied, allow exactly one content-changing repair attempt.
- That repair must merge/remove duplicate blocks or remove body-after-final content. Heading rename alone is not enough.
- If the one repair cannot pass structure, immediately publish `limited` with concrete `remainingGaps`.
- Do not count blocked/no-op repair observations as content progress.
- Do not hardcode the Loop Engineering topic or section names in runtime logic.

Acceptance command:

```bash
AGRUN_DEBUG=1 \
NODE_AGRUN_LIVE_DEBUG=1 \
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_LIVE_WORDS=1500 \
NODE_AGRUN_LIVE_MAX_STEPS=70 \
NODE_AGRUN_LIVE_TIMEOUT_MS=300000 \
NODE_AGRUN_LIVE_PERFORMANCE_SLO=1 \
NODE_AGRUN_LIVE_REPORT_QUALITY_GUARDRAIL=0 \
GEMINI_THINKING_LEVEL=low \
NODE_AGRUN_LIVE_PROMPT='Write a 1500-word production-focused research report on "Loop Engineering and Harness Engineering for general AI agent runtimes". Use web_search and read_url to ground every section in real sources. Cite at least 3 authoritative URLs. Focus on runtime loop design, monitoring, traces, performance, accuracy, failure modes, and production readiness. Structure: Definition, Core Principles, Loop Architecture, Monitoring and Traces, Performance Engineering, Accuracy and Source Grounding, Anti-patterns, Production Readiness Checklist, Conclusion.' \
npm run test:live:node-3000
```

Acceptance result must be:

- exit 0
- duration <= 90s
- provider calls <= 25
- total tokens <= 300k
- no report quality red flags
- length, structure, and source/citation gates true
- cited readable URL count >= 3
- no repeated direct finalize after terminal repair hard veto
- no broad rewrite compression after candidate is near/above requested length

## Copy-Paste Message For The Next Agent

Please continue AGRUN-542 in `/Users/yapweijun/Documents/GitHub/agrun/0_development`.

Follow `AGENTS.md`: use KB-MCP first, review `task.jsonl`, inspect `agrun_docs/live-tests/agrun-541-length-preserving-repair-2026-06-17.md`, and use Agentic Harness Engineering. Do not call partial live failure successful.

Current state:

- Latest commit: `cf8bfe1ed Harden length-preserving terminal repair`.
- Working tree should start clean.
- AGRUN-541 is implemented but not live-accepted.
- Latest live artifact: `agrun_debug_runs/2026-06-17T08-05-00-854Z.*`.
- Latest live failed: 183.8s, 23 provider calls, 378,428 tokens, action repeats 2, candidate 1739 words, quality 50/100, structure/source failed.
- Tool execution was only 2.292s, so the slow path is provider/planner loop churn, not web_search/read_url/workspace action latency.

What was already fixed:

- `workspace_write` now blocks destructive shrink rewrites after the candidate is near/above requested length.
- Requested length is read from direct acceptance packet, gated packet, and prompt.
- Blocked/no-op workspace mutations no longer stale publish protocol.
- `npm run build` and `npm test` passed.

Remaining root cause:

- Content-level structure repair is still too advisory. When semantic duplicate sections/body-after-final-section remain, the model can admit the candidate is not ready, then repeat direct `finalize` under terminal repair before hard veto, then publish limited with failed structure/source quality.

Your task:

Implement AGRUN-542 as a general runtime fix, not report-topic hardcoding. During terminal repair hard veto, prevent repeated direct `finalize` / `final_answer` when workspace publish is the valid terminal path. For `semantic_duplicate_headings` / `body_after_final_section`, allow exactly one content-changing merge/remove repair attempt; if still failing, immediately publish limited with concrete structure gaps. Heading rename alone must not count as content-level structure repair.

Verification:

1. Run focused tests around terminal repair, planner action surface, workspace publish/protocol, and action convergence.
2. Run `npm run build`.
3. Run `npm test`.
4. Run the real-key Gemini low-thinking benchmark:

```bash
AGRUN_DEBUG=1 NODE_AGRUN_LIVE_DEBUG=1 NODE_AGRUN_LIVE_PROVIDER=gemini NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite NODE_AGRUN_LIVE_WORDS=1500 NODE_AGRUN_LIVE_MAX_STEPS=70 NODE_AGRUN_LIVE_TIMEOUT_MS=300000 NODE_AGRUN_LIVE_PERFORMANCE_SLO=1 NODE_AGRUN_LIVE_REPORT_QUALITY_GUARDRAIL=0 GEMINI_THINKING_LEVEL=low NODE_AGRUN_LIVE_PROMPT='Write a 1500-word production-focused research report on "Loop Engineering and Harness Engineering for general AI agent runtimes". Use web_search and read_url to ground every section in real sources. Cite at least 3 authoritative URLs. Focus on runtime loop design, monitoring, traces, performance, accuracy, failure modes, and production readiness. Structure: Definition, Core Principles, Loop Architecture, Monitoring and Traces, Performance Engineering, Accuracy and Source Grounding, Anti-patterns, Production Readiness Checklist, Conclusion.' npm run test:live:node-3000
```

Acceptance must be exit 0, <=90s, <=25 provider calls, <=300k tokens, all quality gates true, citedReadableUrlCount>=3, no report red flags, and no repeated direct finalize after terminal repair hard veto.
