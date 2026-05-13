# Sample Project Workflow Review - 2026-05-10

## Goal

Review `sample project for study logic/` for a reusable solution to the current agrun workflow problem:

- the AI can see weak evidence, short workspace output, or `finalReadiness=limited`;
- the AI can still choose `finalize`;
- Inspector must make that decision path debuggable;
- runtime must stay AI-first and avoid hardcoded report-length/source-count judgment.

## Quality Gate

A borrowed pattern is acceptable only when it:

- keeps `agrun.js` browser-first and small;
- preserves AI-owned task judgment;
- improves visible OODAE/workflow debugging;
- avoids prompt-specific hardcoded checks such as "3000 Chinese chars";
- can be verified by trace, Support Bundle, and targeted smoke tests.

## Samples Checked

| Sample | Files checked | Relevant finding |
| --- | --- | --- |
| `swarm-main` | `swarm/core.py` | Simple loop: model decides, tool results are appended, loop ends when no tool calls appear. Useful for loop clarity, too weak for readiness debugging. |
| `ai-ai-6.0.119` | `content/docs/07-reference/01-ai-sdk-core/16-tool-loop-agent.mdx`, `content/cookbook/05-node/56-web-search-agent.mdx`, `content/cookbook/05-node/101-knowledge-base-agent.mdx` | ToolLoopAgent exposes `stopWhen`, per-step callbacks, `prepareStep`, `experimental_context`, and tool result logging. Useful model for visible multi-step continuation. |
| `agents-js` | `docs/state-min-spec.md`, `docs/evaluator-min-spec.md`, `utils/agent-turn-state.js`, `utils/agent-evaluator.js`, `utils/agent-step-runtime.js` | Minimal `TurnState` + evaluator can detect no evidence, repeated patterns, and tool errors; it emits a hint rather than building a full workflow engine. Adapt the shape, not its hardcoded completion rules. |
| `goose-1.27.2` | `conversation/mod.rs`, `conversation/tool_result_serde.rs` | Provider-visible conversation repair and validated tool result envelopes prevent malformed state from becoming invisible model context. |
| `openclaw-2026.3.8` | `docs/concepts/system-prompt.md`, `src/context-engine/types.ts` | Context/prompt assembly is explicit and inspectable. `/context list` style visibility maps well to Inspector payload and context-budget debugging. |
| `langgraph-cli-0.4.14` | `README.md` | Strong reference for durable state and visual trajectory debugging. Too heavy for agrun MVP; borrow state-transition observability, not graph architecture. |

## Answer: Is There A Solution In Samples?

Yes, but it is a combined harness pattern, not a single copied feature.

The best fit is:

1. Keep the AI as the owner of readiness and finalization.
2. Treat AI-declared unmet readiness as a first-class continuation signal.
3. Feed that signal back to the next planner cycle as an observation/hint, not as a runtime content verdict.
4. Record the exact signal in Inspector: finalReadiness, workspace stats, read_url evidence, source mismatch, and OODAE cycle.
5. Let the AI decide whether to continue tools/workspace or finalize with limitations.

This is closest to:

- AI SDK `ToolLoopAgent`: visible step callbacks + stop condition concept.
- agents-js: small turn-state/evaluator loop with hints.
- Goose: stable tool/result envelope validation.
- Swarm: simple model -> tool -> observation -> model loop.

## Proposed agrun Pattern

Name: `AI-owned readiness continuation signal`.

Behavior:

- When the AI calls `finalize` with `finalReadiness.decision=limited` or declares `requirementSatisfied=false` / `lengthSatisfied=false`, runtime records the declaration.
- Runtime does not decide whether the answer is long enough or sufficiently sourced.
- If step budget remains and the run is not explicitly forced terminal, runtime can return a structured observation to the planner:
  - `kind: "readiness_continuation_signal"`
  - `source: "ai_final_readiness"`
  - `decision: "limited"`
  - `declaredUnsatisfied: ["requirement", "length"]`
  - `observedSignals: { readUrlCount, finalCandidateStats, researchGapCodes }`
  - `instruction: "You declared this is not fully satisfied. Continue with tools/workspace if you can improve it, or finalize only if limitations are intentionally acceptable."`
- The next decision is still AI-owned. The AI may:
  - call `web_search` / `read_url`;
  - call `workspace_read` / `workspace_replace`;
  - call `todo_advance`;
  - call `finalize` again with explicit limitations.

This differs from the removed hardcoded gates:

- no regex for requested length;
- no runtime source minimum judgment;
- no named fallback product mode;
- no automatic report compiler;
- no runtime rewriting final answer.

## Why This Fits Harness Engineering

This is a harness-level loop contract:

- runtime observes declarations;
- runtime preserves state;
- runtime makes the state visible to AI and Inspector;
- AI chooses the next action.

The harness is not doing the research or judging content quality. It is preventing the AI's own "not satisfied" declaration from being silently terminal without another visible decision point.

## Inspector Implications

Inspector should keep showing:

- Debug Index first bad signal;
- Research Gate finalAllowed/finalReason;
- AI Workflow readiness warning;
- OODAE cycle where `finalize` was selected;
- workspace `final_candidate` stats;
- read_url observed count vs AI-declared count;
- LLM Trace request/response sizes.

Potential addition:

- a small `Readiness Continuation` row showing whether a limited final was returned to AI for one more decision cycle.

## Recommended Next Engineering Ticket

`AI-READINESS-CONTINUATION-SIGNAL-2026-05-10`

Acceptance:

- If AI declares limited/unsatisfied readiness on a research/workspace run and budget remains, runtime emits a non-content-judging continuation observation once.
- AI can still finalize after receiving the signal, but Inspector shows both finalize attempts and the continuation signal.
- No hardcoded word count, language, topic, or source threshold.
- Unit fixture: limited finalReadiness triggers signal; ready finalReadiness does not.
- Browser smoke: Support Bundle / Debug Index / OODAE Cycles expose the signal.
- Real QA: Chinese 3000-character AI-browser prompt either continues work or clearly shows the AI intentionally finalized after receiving the readiness signal.

## HBR

The sample projects do not provide a magic fix for weak-model judgment. AI SDK and agents-js both use thresholds/stop policies, but copying their completion rules into agrun would violate the current AI-first direction. The useful solution is narrower: make AI-declared insufficiency visible and reusable as a continuation observation.
