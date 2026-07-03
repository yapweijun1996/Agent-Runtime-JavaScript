# ADR-0058: native_tools becomes the default planner mode (auto → native_tools)

Date: 2026-07-02
Status: Accepted (maintainer approved 2026-07-02)
Supersedes: ADR-0031 (envelope is the default planner mode)

## Context

- ADR-0031 (2026-05-16) made envelope the default after sustained native-tools
  requests against `gemini-3-pro-preview` produced timeouts and signal kills.
  The maintainer's instruction explicitly left the door open: "see future can
  resolve or not then we try again." This ADR is that revisit, driven by data.
- The 2026-07-02 research pass (agrun_docs/audits/why-other-agents-feel-fast-2026-07-02.md,
  AGRUN-572) verified that every surveyed fast framework (OpenAI Agents SDK,
  Claude Agent SDK, Vercel AI SDK, LangGraph, Mastra) uses the same loop
  shape: native tool calling where a response either contains tool calls or
  IS the user answer — no separate decide/answer calls on the hot path.
- Two implementation gaps that made agrun's native mode lose were fixed the
  same day: AGRUN-574 (C3a: `toolChoice:"auto"` + a no-tool text response is
  the final answer; previously `"required"` forced a tool call every cycle and
  looped tools to maxSteps failure) and AGRUN-575 (C3b: the whole toolCalls
  array is consumed; parallel action calls batch into a standard plan decision
  through the existing plan door; previously all but toolCalls[0] were
  silently dropped).
- Affected modules: `src/runtime/provider-capabilities.js` (resolvePlannerMode),
  `test/unit/provider-capabilities.test.js`, `test/concerns/native-tools.test.js`,
  `agrun_docs/planner-architecture.md`, `agrun_docs/public-runtime-api.md`.

## Evidence (all live, resolved mode + fallback events asserted from telemetry)

Short-task A/B after C3a+C3b (AGRUN-574/575/576; native fallbacks = 0 in every cell):

| Provider | Tier | envelope | native_tools | Δ |
|---|---|---|---|---|
| openai gpt-5-mini (N=3) | minimal | 4431ms | 3533ms | -20% |
| openai gpt-5-mini (N=3) | agentic | 17658ms (3 calls) | 13692ms (2 calls) | -23% |
| gemini 2.5-flash (N=2) | minimal | 1099ms | 887ms | -19% |
| gemini 2.5-flash (N=2) | agentic | 3174ms | 2221ms | -30% |
| deepseek v4-flash (N=2) | minimal | 1665ms | 1681ms | tie |
| deepseek v4-flash (N=2) | agentic | 8756ms (3 calls) | 4556ms (2 calls) | -48% |

Correctness 100% in every native cell. ADR-0031's original blocker (Gemini
native instability) did not reproduce — gemini native was the fastest cell in
the matrix.

Long-report gate (AGRUN-577, 1500-word tier, N=1 per cell):

- openai native: **34.6s, 1543 words, 1 planner call, completed cleanly** vs
  envelope 171.7s, 7 calls, 1231 words — native 5x faster with better length.
- deepseek native (AGRUN-578, wire-observed): **172.9s / 1691 words** vs
  envelope 282.1s / 817 words — native 39% faster with the best length
  compliance of any cell; zero fallbacks. Wire-level payload capture
  confirmed every native request carries `tool_choice:"auto"` + tools, and
  the terminal-repair allowedActions filter narrows the native tool surface
  live (29 → 21 → 4 → 28 tools across cycles) — the convergence machinery
  composes correctly with native mode on the wire, not just in step telemetry.
- gemini (2.5-flash): both modes showed the SAME failure signature
  (budget_exhaustion_salvage at maxSteps, short output, heavy terminal
  repair) — a pre-existing model capability-floor behavior (same family as
  AGRUN-547), mode-independent. The convergence machinery (terminal repair,
  AGRUN-553 never-return-empty salvage) engaged identically under native —
  no native-specific regression.

## Decision

- `plannerMode: "auto"` and omitted/unknown values resolve to
  `effectiveMode: "native_tools"` with `reason: "default_native_tools"`.
- `nativeToolsFailurePolicy` default stays `"fallback_to_envelope"` — every
  native planner failure still falls back to envelope per call, so the
  envelope path remains the always-available safety net.
- `plannerMode: "envelope"` remains fully supported as the explicit opt-out
  for weak models or hosts that prefer the deliberate JSON-decision mode.
- The resolver stays provider/model-agnostic (no hardcoded model lists —
  same no-patch principle ADR-0031 applied).
- Live fixtures follow the new default; `NODE_AGRUN_LIVE_PLANNER_MODE`
  overrides remain for diagnostics.

## Alternatives

1. Keep envelope default, document native as a recommended opt-in. Rejected:
   every measured cell shows native equal-or-faster with equal-or-better
   correctness; defaults should be the measured-best path (the same evidence
   standard ADR-0031 itself used, now pointing the other way).
2. Per-provider defaults (native for openai/gemini/deepseek, envelope
   otherwise). Rejected: brittle provider-specific branching — the exact
   shape ADR-0031 removed; fallback_to_envelope already handles unknown
   providers gracefully.
3. Flip only after C3c (terminal token streaming) lands. Rejected as a
   blocker: C3c is a perceived-latency improvement orthogonal to mode
   correctness; the one-shot onToken at answer-ready (AGRUN-568/574) already
   works in native mode.

## Consequences

- Pros: default turns complete in 1-2 LLM calls instead of 2-4+ (agentic
  measured -23% to -48% wall-clock; long-report openai 5x); zero separate
  finalize calls on the direct-answer path; parallel tool calls collapse
  round trips; aligns agrun's default with the loop shape of every surveyed
  production agent framework.
- Cons: the envelope repair cascade (a maturity asset) sits off the default
  hot path; weak/unknown models rely on fallback_to_envelope rather than
  starting in envelope.
- Migration note: ADR-0035 prompt-override section keys for envelope mode
  (basePlannerDirectives, compactPlannerDirectives, researchDirectives, ...)
  apply only when the effective mode is envelope; hosts relying on them must
  either set `plannerMode: "envelope"` or move overrides to the
  `nativePlannerDirectives` key. Tests that pin envelope mechanics (namespace
  upstream interception, unknown_action_name diagnostics, scripted envelope
  response sequences, the ADR-0035 wiring repro) now opt in explicitly.
- Risks: providers whose tool-calling API is unreliable pay one failed native
  attempt before the per-call fallback; long-form convergence on lite-tier
  models remains model-limited in BOTH modes (not a regression, verified).

## Rollback

- Single-line revert in `resolvePlannerMode()` (auto → envelope) restores
  ADR-0031 behavior; `plannerMode: "envelope"` config gives any host the old
  behavior immediately without a code change. Keep ADR-0031 in the repo as
  the reverted-state reference.
