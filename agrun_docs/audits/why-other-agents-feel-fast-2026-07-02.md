# Why other agent frameworks feel fast — and where agrun's remaining latency lives (2026-07-02)

Research pass (AGRUN-572): external web verification of 5 frameworks' loop
architecture + an internal audit of agrun's native-tools planner mode.
Follows the AGRUN-571 timeline measurement (28.8s agentic turn: tools 0.9%,
LLM round trips 99%).

## 1. The surveyed frameworks all share ONE loop shape

OpenAI Agents SDK, Claude Code / Claude Agent SDK, Vercel AI SDK
(`streamText`+tools), LangGraph (`create_react_agent`), Mastra — verified
against current docs (sources at bottom):

| Property | All five frameworks | agrun (envelope mode, default) |
|---|---|---|
| Decide vs answer | ONE call — a response either contains tool calls (loop continues) or IS the user answer (loop ends) | Planner call returns JSON envelope (never user text); `finalize` triggers a SEPARATE full LLM call |
| User-visible text starts | At TTFT of the last call (~0.3-0.8s), streamed token-by-token | After the last call COMPLETES (envelope JSON can't stream to users) |
| Parallel tool calls | Yes — one assistant message carries N tool calls = 1 round trip | No — envelope plans exist but model rarely uses them; native mode consumes only `toolCalls[0]` (planner-tools.js:132-140) |
| Extra LLM calls on hot path | None (guardrails/hooks/budgets are runtime code around the single call) | Finalize call; terminal-repair calls on weak models |
| Prompt caching | Automatic via append-only history + static prefix (up to 85% TTFT cut) | Stable prefix partially structured (goalAnchorBlock), no explicit cache_control, volatile loopState mid-prompt |

Calls per 2-tool turn: OpenAI SDK 2-3 (2 if parallel); agrun measured 4
(3 planner + 1 finalize), none of them user-streamable.

## 2. Ranked reasons "others are fast"

1. **No finalize round trip** — "done" costs zero extra calls; the terminal
   response IS the answer. agrun pays 11.6s/40% (AGRUN-571 measurement).
2. **Terminal answer streams from the same call** — perceived latency = TTFT,
   not completion. agrun's user stares at nothing through the final planner
   call AND the finalize call.
3. **Cache-aligned prompt layout** — static-first prefix + append-only history
   hits provider caches every cycle. agrun re-serializes volatile loopState
   into the middle of the prompt each cycle, forfeiting prefix caching.
   (AGRUN-570's pruning cut tokens; caching additionally needs *layout* stability.)
4. **Parallel tool calls** — N independent tools in 1 round trip.
5. **Nothing else on the hot path** — no planner/critic/validator LLM calls;
   harness logic is local code wrapped around the model call.

## 3. agrun's native mode: exists, but three gaps + one stale ADR

Internal audit (file:line evidence):

- Mode SSOT `provider-capabilities.js:17-34`: `auto` → `envelope`
  (ADR-0031, 2026-05-16 — decided on Gemini-native instability observed
  **13 months of model generations ago**; OpenAI native passed even then).
- Native path `planner.js:146-259` is ONE call with native tools, BUT:
  (a) only `toolCalls[0]` consumed — parallel calls silently dropped;
  (b) text deltas deliberately not routed to onToken (planner.js:38-46);
  (c) `finalize` decision still triggers the separate runtime-finalize call —
  native mode does NOT have an answer-inline terminal for tool-evidence turns
  (only `final` does).
- Failure policy already exists: `nativeToolsFailurePolicy` default
  `fallback_to_envelope` (planner.js:103-133) — a safe rollout lever.

## 4. Key conclusion

**agrun 慢不是因为 harness 功能多，而是因为默认循环形状把"决定"和"回答"拆成
两次不可流式的调用。** The fast frameworks keep todo state, permissions,
budgets, hooks — all as runtime-side code. None of agrun's harness features
(TodoState, convergence, guardrails, budget, approval) is architecturally
coupled to the JSON envelope.

## 5. Adoption path (feeds ROADMAP Phase C)

1. **C2 (highest, 40% measured)**: answer-inline terminal — in native mode let
   "response with no tool calls" BE the answer (stop_reason branch, Claude SDK
   pattern); in envelope mode prefer `final` over `finalize` for short
   tool-evidence answers. A/B convergence quality first (finalize is partly a
   weak-model second pass).
2. **C3 (new)**: re-evaluate ADR-0031 — native_tools as default for capable
   models (OpenAI first), `fallback_to_envelope` as the safety net; fix the
   three native gaps (parallel toolCalls, terminal text → onToken, answer-inline).
3. **C4 (new)**: cache-aligned prompt layout — static prefix (role + tool
   schemas + directives) → append-only history → volatile loopState/todo at
   the TAIL; add provider cache_control where supported.
4. **C1b**: parallel tool adoption (native multi-tool_calls or plan envelope).
5. Keep envelope as the opt-in deliberate mode for weak models (LangGraph
   precedent: extra formatting call only in an optional mode).

## 6. C3 spike result (same day, AGRUN-573): do NOT flip the default yet — fix the gaps first

Live A/B (gpt-5-mini, N=3/cell, src imports):

| Tier | envelope (default) | native_tools (as-is) | verdict |
|---|---|---|---|
| minimal | 5776ms, 3/3 correct | 9651ms, 3/3 correct | native 1.7x SLOWER |
| agentic | 20805ms, 2/3 correct | 60706ms, 1/3 correct | native 2.9x slower, worse |

Root cause (timeline probe): in native mode the run called `lookup_order`
**8 consecutive times until maxSteps exhausted (status: failed)** — the
documented gap combination biting in practice: `toolChoice: "required"`
(planner.js:188-195) forbids a no-tool answer every cycle, and
`parseToolCallDecision` consumes only `toolCalls[0]` (planner-tools.js:132-140),
so a model emitting parallel lookups gets one result, re-emits, and loops.

**Conclusion**: ADR-0031 (envelope default) is CONFIRMED by fresh data — but
for the implementation-gap reason, not the 2026-05 Gemini-instability reason.
The AGRUN-572 architecture analysis stands: the fast-loop shape requires
fixing agrun's native mode first, in this order:
1. `toolChoice: "auto"` + stop_reason branch — a no-tool response IS the
   answer (kills both the forced-tool loop AND the separate finalize call);
2. consume ALL toolCalls from one response (parallel execution, read-only
   concurrent / mutating serialized);
3. route the terminal text to onToken (stream at TTFT).
Then re-run this A/B; only flip the default if native wins on BOTH speed and
correctness. `fallback_to_envelope` stays as the rollout net.

## 7. Cross-provider A/B after C3a+C3b (AGRUN-576) — native wins or ties everywhere

Live, N=2/cell (gemini-2.5-flash, deepseek-v4-flash), resolved mode + fallback
events asserted from telemetry (nativeFallbacks=0 in every cell):

| Provider | Tier | envelope | native_tools | Δ | notes |
|---|---|---|---|---|---|
| gemini | minimal | 1099ms | 887ms | -19% | 2/2 correct both |
| gemini | agentic | 3174ms (2 calls) | 2221ms (2 calls) | -30% | 2/2 correct both |
| deepseek | minimal | 1665ms | 1681ms | tie | 2/2 correct both |
| deepseek | agentic | 8756ms (3 calls) | **4556ms (2 calls)** | **-48%** | parallel batch fired 2/2 |
| openai (gpt-5-mini, N=3) | minimal | 4431ms | 3533ms | -20% | 3/3 correct both |
| openai (gpt-5-mini, N=3) | agentic | 17658ms (3 calls) | 13692ms (2 calls) | -23% | 3/3, 0 finalize calls |

ADR-0031's original blocker ("Gemini native unstable under sustained
requests", 2026-05-16) did not reproduce: gemini native completed every run,
fastest of all cells, zero fallbacks.

**Recommendation**: flip `auto` → resolve to `native_tools` (new ADR
superseding ADR-0031), keeping `nativeToolsFailurePolicy: "fallback_to_envelope"`
as the per-call safety net and `plannerMode: "envelope"` as the explicit
opt-out for weak models. Remaining nice-to-have (not a blocker): C3c terminal
token streaming. Caveats: N=2-3 spikes on short tasks; before flipping,
run one long-report live test (e.g. the 1500-word benchmark) in native mode
to check convergence machinery (terminal repair / workspace flows) end-to-end.

## 8. Long-report gate (AGRUN-577) — no flip blocker; ADR-0058 drafted

1500-word tier, N=1/cell, maxSteps 15, no research tools:

| Cell | result |
|---|---|
| openai native | **34.6s, 1543 words, 1 planner call, completed** |
| openai envelope | 171.7s, 7 planner calls, 1231 words — native is 5x faster |
| gemini native | budget_exhaustion_salvage, 516w, 15 calls, terminal repair engaged |
| gemini envelope | budget_exhaustion_salvage, 721w, 15 calls, 32 terminal-repair steps |

The gemini failure signature is IDENTICAL in both modes — a pre-existing
lite-tier length/convergence capability floor (AGRUN-547 family), not a
native regression; the AGRUN-553 never-return-empty salvage fired correctly
under native. Verdict: no blocker. **ADR-0058 (PROPOSED) drafted:
agrun_docs/adr/0058-native-tools-default-planner-mode.md — auto → native_tools,
fallback_to_envelope stays the per-call net.** Maintainer decision pending.

## 9. DeepSeek long-report gate + wire-level payload observation (AGRUN-578)

Requested follow-up: deepseek was missing from the long-report gate, and the
prior evidence was step-telemetry only. This pass intercepted fetch and
recorded every REAL request/response body (redacted).

| deepseek long1500 | envelope | native |
|---|---|---|
| wall clock | 282.1s (16 HTTP calls) | **172.9s (15 calls, -39%)** |
| words (target 1500) | 817 | **1691 — best length compliance of any cell** |
| fallbacks | n/a | 0 |

Wire observations (payloads inspected call-by-call):
- Every native request carries `tool_choice:"auto"` + the tools array;
  toolsCount varies 29 → 21 → **4** → 28 across cycles — the terminal-repair
  `allowedActions` filter narrows the NATIVE tool surface live. Convergence
  machinery and native mode compose correctly on the wire.
- The last hop is a no-tools `finish:"stop"` synthesis call (deepseek chose
  `finalize` for the long report — the legitimate second-pass path; C3a's
  direct answer replaces finalize only when the model answers directly).
- OpenAI agentic native wire capture (same pass): call 1 = `tool_choice:"auto"`,
  30 tools, response = TWO parallel `lookup_order` tool_calls
  (`finish_reason:"tool_calls"`); call 2 = no tool_calls, `finish:"stop"`,
  148-char direct answer. Exactly 2 HTTP calls end-to-end.
- Note for ADR-0058: the native tool surface is ~30 tool definitions per
  request; ADR-0057 `deferredNamespaces` narrows availableActions upstream of
  buildOpenAITools/buildGeminiTools, so deferred loading also shrinks the
  native tools array.

## 10. Wire comparison after the flip (AGRUN-581): 3 providers vs OpenAI Agents SDK — where the next speed lives

Agentic tier, native default, fetch-intercepted payloads (redacted archives in
session scratchpad), provider-reported cache hits:

| Runtime | wall | LLM calls | req bytes/call | tools bytes | input tok (c2) | cached tok (c2) |
|---|---|---|---|---|---|---|
| agrun+gemini | **2.4s** | 2 | ~45-50KB | 26.7KB | 11638 | 8084 (implicit) |
| agrun+deepseek | **3.9s** | 2 | ~45-51KB | 27.9KB | 12227 | **12160 (99%)** |
| agrun+openai | 13.2s | 2 | ~45-51KB | 27.9KB | 8982 | 6784 (75%) |
| openai-agents-sdk | 5.9s | 3 | **0.7-1.7KB** | 0.3KB | 340 | 0 (below cache min) |

Findings:
1. **Provider prompt caches absorb most of agrun's size**: 75-99% of cycle-2
   input tokens come from cache on all three providers (stable system+tools
   prefix). The raw 26-36x token gap vs the SDK overstates the real cost.
2. **Per-call latency is model-dominated, not runtime-dominated**: identical
   ~45KB requests take ~1s on gemini, ~1.9s on deepseek, 4-9s on gpt-5-mini.
   agrun+gemini (2.4s) and agrun+deepseek (3.9s) BEAT the OpenAI SDK's 5.9s
   on the same task — cross-provider freedom is agrun's structural advantage.
3. **Native tool surface = 28.2KB, and 56% of it is 4 tools**: plan 7105B
   (25% — largely redundant in native mode now that C3b consumes parallel
   tool_calls natively; only synthesize_per_action stitching is unique),
   final_answer 3206B + finalize 3114B + workspace_publish_candidate 2430B —
   all embedding the ~2KB finalReadiness/requirementsAssessment schema
   repeatedly. deferredNamespaces already composes (30→19 tools,
   7687→6167 input tok measured).
4. The uncached tail (openai c2: 2198 tok) is the rebuilt volatile part of the
   user blob — C4's target (loopState to the end, append-only history).

Ranked next improvements (C5 added to ROADMAP):
- **C5a** suppress the `plan` tool in native mode (parallel tool_calls
  supersede it) — instant -7.1KB/-25% of tools, zero capability loss.
- **C5b** deduplicate/slim the finalReadiness schema (terse descriptions,
  single embedding strategy) — est. -4-6KB.
- **C4** volatile-tail prompt layout — extends the cache boundary into the
  user blob (uncached c2 tail measured at ~2.2K tok on openai).
- Model guidance for hosts: on latency-sensitive UIs, gemini-2.5-flash /
  deepseek-v4-flash class models give 2-4s agentic turns TODAY.

## Sources

- OpenAI Agents SDK run loop / streaming: https://openai.github.io/openai-agents-python/running_agents/ , https://openai.github.io/openai-agents-python/streaming/
- Claude Agent SDK agent loop: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Vercel AI SDK tool calling / parallel tools: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling , https://sdk.vercel.ai/cookbook/next/call-tools-in-parallel
- LangGraph create_react_agent: https://reference.langchain.com/python/langgraph.prebuilt/chat_agent_executor/create_react_agent
- Mastra orchestration / tool streaming: https://mastra.ai/blog/announcing-mastra-improved-agent-orchestration-ai-sdk-v5-support , https://mastra.ai/docs/streaming/tool-streaming
- OpenAI latency optimization guide: https://developers.openai.com/api/docs/guides/latency-optimization
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- "Don't Break the Cache" (agentic caching study): https://arxiv.org/abs/2601.06007
- Internal: agrun_docs/adr/0031-envelope-is-default-planner-mode.md, src/runtime/planner.js:146-259, src/runtime/planner-tools.js:132-140, AGRUN-571 timeline.
