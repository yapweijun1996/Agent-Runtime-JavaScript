# Release notes — the 2026-07-02 performance arc: native tool calling becomes the default

One day, sixteen tasks (AGRUN-568 → 583), every number below measured live
(real API keys, all three providers, wire-level payload capture). The theme:
agrun was slow because of its loop SHAPE, not its harness features — and the
shape is now fixed.

## Headline numbers

| Metric (agentic 2-tool turn unless noted) | Morning | Now | Change |
|---|---|---|---|
| Wall clock (gpt-5-mini) | 28.8s | ~11-14s | **2-2.5x faster** |
| Wall clock (gemini-2.5-flash) | — | **2.2-2.4s** | beats OpenAI Agents SDK (5.9s) on the same task |
| Wall clock (deepseek-v4-flash) | — | 3.9-5.8s | beats OpenAI Agents SDK |
| LLM calls per turn | 4 (3 planner + 1 finalize) | **2** | half the round trips |
| 1500-word report (openai) | 171.7s / 7 calls | **34.6s / 1 call** | **5x faster** |
| Minimal-turn prompt cost | 5130 tokens | 2318 (envelope w/ deferred) | **-54.8%** |
| Native request size | 45.7KB | 37.4KB | -18% (C5) |
| Native input tokens (3 providers) | 7.7-10.7K | 6.4-8.8K | -17~19% (C5) |
| Uncached repeat-cycle tokens (openai) | 2709 | 1685 | -38% (C4) |
| First visible output (simple Q&A) | never (bug) | at answer-ready via onToken | fixed (AGRUN-568) |

Correctness: 100% across every verification cell; convergence machinery
(terminal repair, budget salvage, approval, todo) verified working under the
new default, including on the wire (terminal repair live-narrows the native
tool surface 29→21→4→28 across cycles).

## What changed

1. **ADR-0058 (supersedes ADR-0031): `native_tools` is the default planner
   mode.** A response either contains tool calls (loop continues) or IS the
   user answer (loop ends) — the loop shape every surveyed framework uses
   (OpenAI Agents SDK, Claude Agent SDK, Vercel AI SDK, LangGraph, Mastra).
   `nativeToolsFailurePolicy: "fallback_to_envelope"` remains the per-call
   safety net; `plannerMode: "envelope"` remains the explicit opt-out.
2. **C3a**: `toolChoice: "auto"` + a no-tool text response is the final
   answer. Kills the forced-tool loop AND the separate finalize round trip
   (measured at 40% of a turn).
3. **C3b**: the whole `toolCalls` array is consumed — parallel tool calls
   batch through the existing plan door (bounded concurrency, validation,
   timeouts). Agentic turns: 3 planner calls → 2.
4. **Prompt cost work**: B1 signal-gated advisory directives, B2 loopState
   pruning, C5a skill-gated plan tool, C5b slimmed readiness schema,
   C4 cache-aligned layout (stable head → append-only middle → volatile tail).
5. **Streaming fixes**: `planner_final` now surfaces text through `onToken`
   (AGRUN-568); native fallback errors are secret-scrubbed before reaching
   steps/ledger (found by the flip, fixed same day).

## Breaking / migration notes

- Hosts using ADR-0035 envelope prompt-override keys
  (`basePlannerDirectives`, `compactPlannerDirectives`, `researchDirectives`,
  …) must set `plannerMode: "envelope"` or move to `nativePlannerDirectives`.
- The native `plan` tool is offered only when a skill/research flow can use
  it (bundled skills, discovered catalog, active skill, or research loop);
  plain tool runs rely on native parallel tool calls instead.
- Rollback is one line (`resolvePlannerMode` auto → envelope) or per-host
  config (`plannerMode: "envelope"`).

## Recommendations for hosts

- Latency-sensitive chat UIs: pair the new default with a fast tool-calling
  model — gemini-2.5-flash / deepseek-v4-flash class models deliver 2-4s
  agentic turns today.
- Consume the streaming surfaces (`onReasoning`, `tool_start`/phase events,
  `onToken`) — the runtime emits first events within ~5ms.
- `deferredNamespaces: ["workspace"]` composes with native mode (30→19
  tools) for further cuts on non-authoring workloads.

## Evidence trail

- agrun_docs/audits/why-other-agents-feel-fast-2026-07-02.md (§1-10: the
  5-framework survey, spike, fixes, cross-provider/long-report/wire gates)
- agrun_docs/adr/0058-native-tools-default-planner-mode.md
- agrun_docs/ROADMAP.md (Phase A/B/C checklists with per-step numbers)
- task.jsonl AGRUN-568 … AGRUN-583
