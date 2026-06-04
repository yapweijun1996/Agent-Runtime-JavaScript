# Context Attention Budget and Subagents

**Date**: 2026-05-26
**Status**: Research note + design rationale for `spawn_subagent` (ADR-0037 / AGRUN-254 / AGRUN-255)
**Audience**: agrun.js maintainers + anyone choosing between "one big prompt" vs "delegate to a worker"

## TL;DR

The user's intuition is correct and is supported by 2024-2025 primary research:

> When the LLM's context (system prompt + tool schemas + memory + conversation history) grows large, the LLM's effective attention budget for actually solving the user's current query shrinks. Subagents — workers spawned to handle a focused sub-task in their own context window — restore attention budget because the parent's context stays slim and the worker only sees the task it needs.

This is **not** about running out of context window. It is about attention being a **finite, soft** resource that has to be split across every token in the prompt. Adding more tokens (long system prompt, large tool schema, dense memory, prior turns) takes attention mass away from the user's current query, even if the model still nominally "fits" everything in its window.

`spawn_subagent` in agrun is exactly the mechanism to restore attention by running a focused sub-task in its own runLoop with its own clean context, returning only the final answer to the parent.

## The Mechanism — what actually degrades and why

### "Lost in the Middle" (Liu et al., TACL 2024)

Liu et al. (Stanford, paper arXiv:2307.03172) evaluated GPT-3.5-turbo, Claude, Longchat, MPT on multi-document QA and key-value retrieval with contexts up to ~30K tokens. Performance follows a **U-shaped curve**: highest when the relevant document is at position 1 or position 20, lowest in the middle.

The damning data point: when the gold (correct) document is placed in the middle of a 20-document context, **GPT-3.5-turbo scores below its own closed-book baseline (56.1%)**. In plain words: giving the model the correct answer in the middle of a long context is *worse than not giving it the document at all*. The drop from "gold at position 1" to "gold at position 10" is **more than 30 percentage points**.

Attributed mechanism: (a) positional bias inherited from training data (early and late tokens absorb more attention mass) plus (b) decoder-only attention dilution over long sequences.

### "Context Rot" (Chroma, July 2025)

Chroma re-tested the same hypothesis across **18 frontier models in 2025** — Claude Opus 4 / Sonnet 4 / 3.7 / 3.5 / Haiku 3.5, OpenAI o3, GPT-4.1 + mini/nano, GPT-4o, GPT-4-Turbo, GPT-3.5, Gemini 2.5 Pro / Flash / 2.0 Flash, Qwen3-235B / 32B / 8B.

Headline quote (Chroma):
> "LLMs do not maintain consistent performance across input lengths. Even on tasks as simple as non-lexical retrieval or text replication, we see increasing non-uniformity in performance as input length grows."

Degradation appears at **every length increment tested (from ~25 words up to 10K)**, not just near the stated limit. Gemini 2.5's nominal 1M-token window shows rot well before 1M. Four amplifiers:

1. **Low semantic similarity** between needle and question — degrades faster.
2. **Distractors** — even a single distractor hurts measurably, non-uniformly worse at longer length.
3. **Haystack structure** — paradoxically, models do *better* on a shuffled haystack than a coherent one (attention picks up on local coherence and gets misled).
4. **Position effects** consistent with Liu et al.

### Why this matters for agrun

Every long agrun turn pays this tax:

| Context source | Typical tokens | Steals attention from |
|---|---|---|
| System prompt (planner instructions + envelope schema) | 2-6K | The user's actual question |
| Tool schema list (action catalog) | 1-3K | Which tool to pick *this turn* |
| Memory / TodoState / workspace projection | 1-10K | What to do *next* |
| Prior turns history | 0-50K | Current intent |
| Tool outputs from previous cycles | 0-30K | This step's reasoning |
| **User's current question** | 0.05-1K | (this is what we want the LLM to focus on) |

A 50K-token planner prompt for a 200-token user question means the user's question is **0.4% of the total tokens** — and that 0.4% is what we actually need the model to attend to.

## Anthropic's Own Reasoning for Subagents

From Anthropic's June 2025 engineering post *How we built our multi-agent research system* (https://www.anthropic.com/engineering/multi-agent-research-system):

- > "Subagents facilitate compression by operating in parallel with their own context windows, exploring different aspects of the question simultaneously"
- > "Multi-agent architectures effectively scale token usage for tasks that exceed the limits of single agents."
- > "separation of concerns — distinct tools, prompts, and exploration trajectories — which reduces path dependency and enables thorough, independent investigations."

The headline result they published:
- > "multi-agent system with Claude Opus 4 as the lead agent and Claude Sonnet 4 subagents outperformed single-agent Claude Opus 4 by **90.2%**" on their internal research evaluation.
- > "upgrading to Claude Sonnet 4 is a larger performance gain than doubling the token budget on Claude Sonnet 3.7"

That last quote is the cleanest empirical confirmation of the user's intuition: at a fixed model, doubling the context window gives diminishing returns; the win comes from **letting attention focus on less, not more**.

Cost note Anthropic publishes honestly: their multi-agent system costs **~15× the tokens of plain chat** and **~4× the tokens of single-agent**. So this is not free — you trade tokens for attention quality.

## The Counter-Argument (Cognition: "Don't Build Multi-Agents")

Walden Yan (Cognition, 2025) argues two principles:

1. > "Share context, and share full agent traces, not just individual messages."
2. > "Actions carry implicit decisions, and conflicting decisions carry bad results."

His Flappy Bird example: one subagent builds a Super Mario-style background, another builds a bird that doesn't match, the coordinator can't reconcile because it never saw the implicit style decisions each subagent made. Generalizing: parallel subagents produce dispersed decision-making, no shared context, and compounding errors over long horizons. Cognition's recommended architecture: a single-threaded linear agent with a dedicated *compression model* that distills history when the window fills.

**What's actually true about this critique** — and where it doesn't conflict with Anthropic:

| Subagents work well for | Subagents work badly for |
|---|---|
| Read-mostly, genuinely independent sub-tasks (search, retrieval, fact lookup, parallel investigation) | Tasks that share latent design decisions a coordinator can't reconstruct from summaries (most code generation) |
| Anthropic's research use case | Cognition's Devin use case |

Anthropic essentially concedes this:
> "most coding tasks involve fewer truly parallelizable tasks than research."

So the two camps don't disagree on the *mechanism*; they disagree on which workload dominates. **For agrun's typical use case — browser chatbox that does research, web_search, read_url, summarize — Anthropic's reading is the right one**. For agrun's deep-research-writer skill (one coherent long report), Cognition's caution applies and is why ADR-0037 chose depth=1 and `tools: [...]` as an explicit narrowing contract.

## How agrun's `spawn_subagent` Implements This

ADR-0037 (`agrun_docs/adr/0037-spawn-subagent-orchestrator-worker.md`) and AGRUN-254/255 make this concrete:

1. **Child gets a clean prompt**. `buildChildRawInput` builds a fresh rawInput with only `prompt = task` plus the provider/network config; it does not inherit the parent's prior turns, recent observations, or memory state. The child's planner sees the focused sub-question, not the parent's history.
2. **Child surface is narrowed**. `tools: ["web_search"]` (AGRUN-255 Option C) means the child sees only the tools it needs; the rest are disabled at the child's action registry. Less tool schema in the prompt = more attention for the actual task.
3. **Child returns one envelope to the parent**. `subagent_result` carries `finalResponse`, `cycleCount`, `usage`, and optional `error`. The parent's history does *not* get flooded with the child's intermediate planner cycles. Event isolation (Decision 5 in ADR-0037) is the same idea applied to telemetry: the parent's UI does not re-render the child's trace.
4. **Depth=1 hard cap**. Anthropic-style swarms can recurse and blow up cost; agrun's `spawn_subagent` is always disabled inside a child run. This bounds the worst case to one level of context isolation, matching the workload (browser chatbox, not autonomous research agency).

The honest summary: **agrun's spawn_subagent is built precisely to convert the user's "100% attention" framing into a real harness primitive.** When the planner sees that the user's question has a self-contained, read-mostly sub-question (e.g. "look up X then summarize"), spawning a worker keeps the parent's attention budget for the *coordination and final response*, while the worker spends its own fresh budget on the lookup.

## Concrete Numbers (cite when persuading)

- Liu et al.: GPT-3.5-turbo multi-doc QA, gold doc at position 10 of 20 → **below 56.1% closed-book baseline**; **>30 percentage point** drop from position 1 to position 10.
- Chroma 2025: every one of 18 frontier models degrades at every length tested; degradation begins well before stated context limits (Gemini 2.5 1M shows rot by ~50K).
- Anthropic 2025: multi-agent Opus + Sonnet beats single Opus by **+90.2%** on research eval; costs ~15× plain chat tokens; *"upgrading to Claude Sonnet 4 is a larger performance gain than doubling the token budget on Claude Sonnet 3.7"*.

## Practical Guidance for agrun Users / AI Authors

When should the planner spawn a subagent rather than do the work inline?

**Spawn when** all are true:
- The sub-task is self-contained: input is a string, output is a string.
- The sub-task is read-mostly: web_search, read_url, fact lookup, "what is the current X."
- The parent's context already contains a lot (long prior turns, dense memory, large workspace).
- The sub-task does not need to see parent's TodoState, workspace, or research context.

**Do NOT spawn when**:
- The sub-task is one tool call and you can call it inline — the spawn overhead is real (Anthropic's ~4× single-agent token cost).
- The sub-task needs to write into the parent's workspace.
- The sub-task is part of a coherent long-form writing/coding task where every paragraph's decisions affect the next (Cognition's critique applies).

## Honest Bad Result Disclosure

- The current `spawn_subagent` adds latency (each spawn is a fresh full runLoop including its own LLM round-trips) and token cost (Anthropic measured ~4×). It is a *quality* lever, not a *speed* or *cost* lever.
- Child returning empty `finalResponse` was surfaced by AGRUN-261 (2026-05-27, strategy B: demote the empty success to `status:"failed"` + `SUBAGENT_EMPTY_RESPONSE` so the parent AI can react) and was originally attributed to "Gemini grounding returned nothing." **AGRUN-296 (2026-06-04, [ADR-0049](./adr/0049-spawn-subagent-empty-finalresponse-root-cause.md)) found the real, deterministic root cause: a result-envelope extraction bug.** `normalizeChildResult` read the child answer with `readString(childResult.output)`, but `runLoop` returns `output` as a terminal **object** `{ kind, text, … }` — `readString` of an object is `""` — so every `finalize`-path child's answer (and every short `final`-path answer) was discarded and demoted to `SUBAGENT_EMPTY_RESPONSE` regardless of what the finalizer actually produced. Fix: extract `output.text` for the `final_response`/`planner_final` terminal kinds (kind-guarded so a blocked child's `approval_required.text` cannot leak), with string and `lastPlannerFinalText` fallbacks. AGRUN-261's demotion is preserved for genuinely empty children; the parent-side contract for `SUBAGENT_EMPTY_RESPONSE` (re-delegate / answer inline / report the gap — never fabricate) is documented. No hardcoded fallback text (runtime must not invent the child's answer). Verified by deterministic unit tests + `gemini-3.1-flash-lite` real-LLM e2e (parent relayed the worker's `PONG`).
- agrun does not yet expose the child's trace to the host UI. This is intentional (event isolation prevents React re-render storms) but it means debugging child failures requires reading the action-history summary, not a full trace view. Follow-up ticket: child-trace inspector tab.

## References (primary sources opened)

- Anthropic Engineering, *How we built our multi-agent research system* (June 2025) — https://www.anthropic.com/engineering/multi-agent-research-system
- Cognition (Walden Yan), *Don't Build Multi-Agents* (2025) — https://cognition.ai/blog/dont-build-multi-agents
- Liu et al., *Lost in the Middle: How Language Models Use Long Contexts* (TACL 2024, arXiv:2307.03172) — https://arxiv.org/abs/2307.03172
- Chroma Research, *Context Rot* (July 2025) — https://www.trychroma.com/research/context-rot

## Cross-references in this repo

- `agrun_docs/adr/0037-spawn-subagent-orchestrator-worker.md` — the runtime ADR for `spawn_subagent`.
- `src/runtime/spawn-subagent-capability.js` — the capability implementation (depth=1, tool narrowing, request backfill, action-policy pre-approval).
- `src/runtime/actions/spawn-subagent-action.js` — the action handler.
- `task.md` AGRUN-254 / AGRUN-255 — delivery history including the four sequential approval-resume bugs caught in live e2e.
