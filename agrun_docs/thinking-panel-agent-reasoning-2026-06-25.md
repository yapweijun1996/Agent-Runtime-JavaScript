# AGRUN-549 — ChatGPT-style "Thinking" panel: surface the agent's reasoning

Date: 2026-06-25

## Goal

Let the browser show what the AI agent is *thinking*, ChatGPT-style, during a run.

## Two sources of "thinking" — and which one is reliable

1. **Agent reasoning (the planner's `reasoning` field).** Every planner decision
   carries the model's own stated justification (e.g. *"User asked for a story;
   no external evidence needed, I'll write it directly"*), parsed from the
   envelope in `planner-repair.js`. This is **model-agnostic** and present for
   every decision — no provider chain-of-thought dependency. **This is the
   reliable source and the one the panel uses.**

2. **Model chain-of-thought (provider `reasoning-delta` stream).** The ai-SDK
   `fullStream` exposes `reasoning-delta` parts (gemini thoughts / openai
   reasoning summary). Wired end-to-end but **provider-dependent**: a provider
   emits reasoning *text* only when the reasoning summary is explicitly requested
   (`includeThoughts:true` for gemini, `reasoningSummary:"auto"`+
   `apiVariant:"responses"` for openai) AND on a prose/finalize call. During the
   forced-tool-calling planner phase (`toolChoice:"required"`, which simple
   direct-answer prompts hit via `planner_final`) the providers tested emit only
   empty `reasoning-start`/`reasoning-end` markers. So this path populates on
   reasoning-heavy/finalize flows but not on simple one-shot answers. Kept in the
   tree (harmless, tested) but NOT the primary surface.

## What shipped

### Agent-reasoning surfacing (primary)
- `src/runtime/action-loop-planner.js` — the `planner-responded` step now carries
  `reasoning` (the decision's `reasoning`, trimmed to 800 chars).
- `examples/browser/.../agent-activity-planner-mappers.ts` — `createPlannerRespondedActivity`
  emits a `thinking` activity ("Deciding how to answer" / "Planning the next
  step") whose content is the real reasoning.

### Inline collapsible panel (ChatGPT-style)
- `ActivityPanel.tsx` — was a modal drawer; now an **inline collapsible** region.
- `ActivitySummaryButton.tsx` — toggle with rotating chevron; shows the live
  activity while streaming and **"Thought for Ns"** collapsed when done.
- `ActivityDrawer.tsx` + `useAutoFollowScroll` are now unused (left in place).

### Model-CoT plumbing (secondary, provider-dependent)
- `src/skills/providers/provider-stream-pump.js` (new, SSOT) routes ai v6
  `fullStream` parts: `text-delta`→`onToken`, `reasoning-delta`→`onReasoning`.
  NB: ai v6 `TextStreamPart` carries the chunk on `.text`, not `.delta`.
- `onReasoning` threaded through every dispatch door (see Dispatch-Path Parity in
  CLAUDE.md): `runtime.run`, `session.run` + `session.runStream`,
  `runtime-finalize.js`, both planner doors (`planner.js`
  `requestPlannerProviderResponse`), `action-loop-session.js`,
  `default-run-options` HOOK_KEYS, and the subagent strip-list.
- Browser: `ModelThinkingPanel.tsx` + `metadata.thinking` (chat-turns
  `handleReasoning` → streaming/completed message builders). gemini
  `includeThoughts:true` / openai `reasoningSummary:"auto"` requested in
  `agent.ts`.

## Verification
- 1994 lib smoke tests pass; browser example typecheck + smoke pass.
- Node probes: model reasoning streams before the first answer token
  (planner_final = 9 chunks, runtime_finalize = 69 chunks).
- Live browser (gemini, "write me 1500 word of story"): the inline "Thought for
  Ns" panel shows the OODAE timeline with the real agent reasoning — *"Provided
  an original story of approximately 1500 words in English, directly answering
  the user's request without needing tools."*

## Lesson
For an agent runtime, surface the planner's structured `reasoning` field to show
the agent's thought — do not depend on provider chain-of-thought streaming, which
is inconsistent across providers and tool-calling phases.
