# Harness Engineering Principles

> Companion to [agent-harness-runtime-patterns.md](./agent-harness-runtime-patterns.md). The pattern index there enumerates the WHAT (concrete patterns shipped in agrun.js). This document captures the HOW — methodology, decision rules, and load-bearing principles distilled from 2024-2026 research and from agrun's own ADR-0033 investigation cycle (2026-05-19 to 2026-05-20).

Last reviewed: 2026-05-20. Sources: Anthropic ("Building Effective Agents", "How We Built Our Multi-Agent Research System"), Manus context-engineering blog, arxiv 2510.18254 (Illusions of Reflection), arxiv 2504.03846 (Self-Preference Bias), plus the empirical findings of the ADR-0033 B1/B2/B4/X1/X1.5 fix cycle.

## Why this document exists

Engineers reading agrun's ADRs see DECISIONS. They don't see the METHOD by which those decisions were reached — and that method is most of what "good harness engineering" actually means. Specifically: the difference between a productive 24-hour debug cycle (B1/B2/B4 shipping with +140% improvement on the failing test) and an unproductive one (the ~5 days that would have been spent on the abandoned Tier B Reflect+Act if the PoC hadn't falsified the hypothesis first) is purely methodology.

When you next face an agent-runtime bug, read this BEFORE writing any code.

## Part 1 — Methodology principles (HOW to debug a harness)

### M1. Raw data before architecture decisions

**Rule**: before proposing any tier/protocol change, read the raw emission JSONL of a failing run. Compute action counts, decision contents, observation messages directly from the bytes the AI emitted. Do not work from summary metrics.

**Why**: aggregate metrics lie. ADR-0033 v16 report concluded "flash-lite has a 6-15 words/step per-step ceiling" by dividing total candidateWords by total cycles. The raw data showed AI actually wrote 67-73 words per successful workspace_write — the misleading average mixed productive cycles with hard_veto-wasted cycles. That single wrong number drove three subsequent days of misdirected proposals (Tier B, Alternative 5 maxTargetWords). Reading the raw data took ten minutes and invalidated all of them.

**Anti-pattern**: "AI is failing → must be a capability problem → let's add more LLM calls." This skips the diagnostic step where you discover the AI was already capable but the runtime was vetoing its valid actions.

### M2. Falsifiable PoC before production buildout

**Rule**: a tier/protocol proposal is not credible until a 1-2 day PoC is run against the failing live case. Only after the PoC clears a pre-stated threshold does production work begin.

**Why**: Tier B (Reflect+Act) had an approved 5-6 day implementation plan, 9 decisions resolved, and an ADR section before any code was written. The PoC took 1 hour to implement and produced **fewer** candidateWords than the simpler B1+B4 fix (941 vs 1048) at higher LLM cost. The full 5-day buildout would have been wasted. Empirical falsification > architectural argument > academic citation.

**Cost**: PoC scaffolding is cheap. ~1 hour to wire a new planner mode, ~5 minutes to launch a single live e2e, ~10 minutes to analyze the result. Total ~1.5 hours protected ~5 days of work.

### M3. Isolated request simulator (the 300x iteration win)

**Rule**: maintain a script that takes a synthetic runState and replays it as a SINGLE LLM call. Use it for prompt tuning. Reserve full live-e2e runs for end-to-end validation only.

**Why**: a full live e2e on `gemini-3.1-flash-lite × 90 maxSteps` takes 3-5 minutes. An isolated single-call simulator returns in ~1 second. When iterating on prompt content (system lines, argsExample, deficit hints), use the simulator. See `scripts/simulate-planner-call.mjs` for the working implementation.

**Discovery enabled by simulator (otherwise missed)**: in the ADR-0033 X1 investigation, the simulator showed AI behaved RATIONALLY in isolation under terminal_repair state — it picked `workspace_read` or `web_search`, not the stuck `finalize` loop the live run produced. This rerouted the diagnosis from "AI is stuck in pattern" to "live-run conversation history must differ from synthetic". The actual fix (X1.5.b — concrete argsExample remainingGaps strings) was found in 20 minutes of simulator iteration.

**Concrete instance**: under X1 fix, AI emitted `decision="limited"` correctly but `remainingGaps: []` (empty). The simulator-printed argsExample showed my placeholder strings contained "replace this with..." — AI parsed those as instructions to remove, not content to copy. Changing the strings to concrete sentences ("Length is still short: observed 1048 / requested 3000 words.") made AI emit non-empty arrays in the next live run (47/47 filled).

### M4. Verify each fix actually appears in the prompt AI sees

**Rule**: after any prompt change, write a quick `node --import virtual-stubs-loader -e '...'` test that builds the prompt and asserts the new text appears (and absent text doesn't). Do this BEFORE the live test, not after.

**Why**: ADR-0033 Tier A added `compactSystemPrompt: true` for lite-tier and shipped — but the change accidentally DROPPED the load-bearing `workspace_write` vs `workspace_append` guidance because that block was gated on `!compactSystemPrompt`. The lite-tier model lost the very guidance it needed most. The bug shipped because the change was validated only by unit-test pass count, not by inspecting the actual lite-tier prompt content.

**Cheap fix**: 3 lines of verification code per prompt change.

### M5. When metrics regress numerically but business goal advances, trust the goal

**Rule**: a fix can make hard_veto count go UP while candidateWords goes UP too. Numerical regression on one metric is acceptable when it reflects AI doing more productive work.

**Example**: B1+B4 ran 90 cycles with 72 hard_vetos (vs Tier A's 56). At first glance this is regression. But candidateWords went from 566 (Tier A) to 1048 (+85%) — AI was now writing real content, which triggered more structure checks at the boundary. The hard_veto increase was a *consequence* of AI being more productive, not a regression in harness quality.

**Diagnostic flag**: if exactly ONE metric got worse and EVERY other metric improved, the worse metric is probably a side effect of progress. Investigate before reverting.

## Part 2 — Confirmed principles (Anthropic + Manus + research)

### P1. Workflows ≠ Agents

Workflows are predefined code paths orchestrating LLM steps. Agents are LLMs dynamically directing their own tools. **Use workflows wherever the task structure is known; reserve agents for tasks where the path cannot be predicted in advance.** Most "agent" applications should actually be workflows.

Source: Anthropic, Building Effective Agents.

### P2. Cache hit rate is the #1 metric for long-running agents

Keep prompt prefix **byte-stable** across turns. Append-only context. Deterministic serialization (sorted keys, fixed timestamp format). When you mutate the visible state, you invalidate the cache for that turn AND every subsequent turn until eviction.

Source: Manus context-engineering. Practical impact: cache misses cost ~10x more than hits.

### P3. Mask, don't remove tools

**Never mutate the visible action surface mid-trajectory.** Even if a tool is currently inappropriate (terminal repair, policy denial), keep the tool listed and gate it via state-machine logit masking or runtime preflight rejection. Removing the tool breaks two things: (1) KV cache, (2) the AI's mental model — prior steps in the conversation reference tools that "no longer exist" and AI gets confused.

Source: Manus + agrun's own action-pattern-convergence design.

### P4. Errors-in-context outperform clean retries

When a tool call fails, return the structured error to the AI — do not retry silently, do not sanitize the error message, do not start a fresh conversation. The model adapts FROM the error.

Source: Anthropic multi-agent research system, Manus. Empirical: agrun's existing `actionFailureSignal` + `terminalRepairState.requiredRepair` are direct instances of this principle.

### P5. Reflection alone cannot enforce rules

Self-reflection ("look at your previous answer and check it follows the rules") produces ~0 net improvement on rule-constrained tasks. The model frequently REPEATS the same violation with more confidence. For any rule the agent MUST obey, enforce in the runtime — do NOT rely on AI self-checking.

Source: arxiv 2510.18254 "Illusions of Reflection". 8 frontier models tested; gains came from chance, not principled repair. "Reasoning-marketed" models showed no advantage.

**Applied to agrun**: this is why ADR-0033 Tier B (Reflect+Act split) cannot fix B1/B2/B4. AI declaring `next_intent: finalize` in the Reflect call and then choosing `finalize` in the Act call produces the same hard_veto twice. The runtime veto is the enforcement; the reflection step is decorative.

### P6. Self-preference bias is worst in capable models

When a single LLM both generates AND judges, the strongest model in your stack is the worst candidate for the judge role on its own output. It exhibits the MOST harmful self-preference bias.

Source: arxiv 2504.03846. Implication: for any "gating" judgment (publish-readiness, content quality, factuality), use either external validation (deterministic checks), a smaller cheaper model as judge, or a diverse panel.

### P7. Tool descriptions are critical infrastructure

A study from Anthropic's multi-agent research system reported that rewriting bad tool descriptions cut task completion time by **40%**. This is a higher leverage point than most prompt engineering. Treat `description`, `argsSchema`, and `argsExample` as production code — review them like you'd review API documentation.

Source: Anthropic engineering.

### P8. argsExample is in-context few-shot — every word matters

The `argsExample` of an action is, for lite-tier models, the strongest behavioral signal in the entire prompt. AI literally copies the example. Two consequences:

- **Avoid template language** ("replace this with X", "list the missing slots", "fill in concrete values"). The model takes these as instructions to remove the field, then leaves it empty. See ADR-0033 X1.5.b for the canonical instance of this bug.
- **Vary examples lightly** when used repeatedly to avoid "lock-in drift" where the model overfits to the exact example values. (Manus "Don't get few-shotted".)

## Part 3 — Implementation rules (a checklist)

| When... | Do... | Avoid... |
|---|---|---|
| Adding a new runtime rule | Enforce via preflight veto + clear observation message | Trusting AI to read the rule and obey it |
| Adding a new prompt line | Run a 3-line "appears in compact mode?" assertion test | Assuming the line lands where you intended |
| Changing argsExample | Use concrete realistic values, no template placeholders | "replace this with..." style strings |
| Stripping a section in compact mode | Audit each line as load-bearing vs verbose first | Wholesale `!compactSystemPrompt &&` gates |
| Proposing a tier/protocol change | Write a 1-2 day PoC + live-e2e validator | 5-day production buildout before any data |
| Diagnosing a failing live run | Read the raw JSONL, compute action counts + decision args | Reading the summary report only |
| Iterating on prompt content | Use isolated single-call simulator | Re-running full 90-cycle live e2e |
| One metric regressed, others improved | Investigate the regressed metric as side-effect of progress | Reverting based on the one bad number |
| AI repeats same constraint violation | Tighten runtime enforcement, not the prompt | Adding more "remember to follow the rule" lines |
| Reflection / chain-of-thought proposed as fix | Demand a PoC that beats baseline empirically | Citing academic papers as proof |
| Single model judging its own output | Add external validation or smaller-model judge | Trusting the capable model's self-assessment |
| Need a hard ceiling on a behavior | Bounded fail-safe (e.g. circuit breaker) at the runtime layer | Prose telling AI "don't loop forever" |
| Tool error path | Return rich, actionable error verbatim to AI | Sanitize, suppress, or silently retry |

## Part 4 — Anti-patterns specifically observed in agrun

### A1. The "compact mode strips guidance" cliff

Tier A's `compactSystemPrompt: true` for lite-tier looked safe (just remove verbose explainers) but removed the workspace_write/workspace_append decomposition rule. Lite tier lost 140% potential candidateWords improvement. Lesson: when designing a "compact" variant, treat every removed line as load-bearing-until-proven-noise, not the reverse.

Fix shipped: B1 (unconditional rules for workspace_write/append + canonical path + structure cleanliness, regardless of compact flag).

### A2. The "deficit hint pushes terminal action" trap

The pre-B2 hard_veto observation message told AI "you MUST publish workspace_publish_candidate NOW with decision=limited" regardless of budgetState. AI ignored this because publishing a 437-word "limited" result felt wrong when budget was still "enough" to write more. Lite tier kept retrying finalize for 60+ cycles instead.

Fix shipped: B2 (deficit-aware observation that recommends the deficit-clearing action when budget is healthy; only falls back to "publish limited" when budget is exhausted).

### A3. The "canonical path dropped" cliff

Workspace path guidance ("if you drafted in a custom path, publish that path or copy to final_candidate.md") was gated on `!compactSystemPrompt`. Lite tier wrote 579 words to `report.md`, never copied or published, and scored only the 428 words in the empty `final_candidate.md`.

Fix shipped: B4 (unconditional canonical publish rule in compact mode).

### A4. The "argsExample template language" trap

X1.5 changed `workspace_publish_candidate` argsExample from `decision="ready"` to `decision="limited"`. AI now used `decision="limited"` correctly. But remainingGaps was `[]` because the example strings contained "replace this with..." — AI parsed those as instructions to omit. 47 of 47 publish attempts in the X1 live run failed validation.

Fix shipped: X1.5.b (concrete realistic strings: "Length is still short: observed 1048 / requested 3000 words.", "Source minimum unmet: 2 of 3 successful read_url required for clean ready.", "Structure repair pending: duplicate headings and section numbers detected in final_candidate.md."). Result: 47/47 publish attempts in the X1.5.b live run had filled remainingGaps.

### A5. The "abstract rule vs concrete example" gap

In compact mode, the prompt said "use workspace_publish_candidate with decision=limited and concrete remainingGaps" SIX TIMES. But the example string for the action was `args={}` (empty) until X1.5 added a proper example. Lite tier follows examples more reliably than rules. Six abstract repetitions of the rule do not substitute for ONE concrete example.

Lesson: when designing for lite-tier, ratio of examples-to-rules should be inverted from the capable-tier default.

## Part 5 — When to break each rule

This section exists to prevent the document from becoming dogma.

**Break M1 (raw data first)** when the failure is so simple it's faster to read the code than read the data (e.g. a clear stack trace pointing at a specific line). Don't waste 20 minutes on data analysis for a 2-minute fix.

**Break M2 (PoC first)** when the change is purely additive and reversible (e.g. adding a new prompt line). Reserve PoC discipline for protocol/architecture changes that would be expensive to revert.

**Break P3 (mask, don't remove)** when the tool would cause irreversible harm (e.g. policy-denied destructive action). Removing it from the visible surface is acceptable when the deny is sticky for the rest of the session.

**Break P5 (no reflection)** when you have an EXTERNAL validator that catches reflection's blind spots — e.g. a deterministic syntax check that fires after the reflection step. The reflection alone is decorative; reflection + external validator is harness engineering.

**Break P8 (vary examples)** when consistency matters more than diversity — e.g. a contract example where the exact field set must be reproduced. Lock the example then.

## Sources

- [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic — How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- [Manus — Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- [arxiv 2510.18254 — Illusions of Reflection](https://arxiv.org/abs/2510.18254)
- [arxiv 2504.03846 — Self-Preference Bias](https://arxiv.org/abs/2504.03846)
- [arxiv 2509.25370 — Where LLM Agents Fail](https://arxiv.org/pdf/2509.25370)
- agrun ADR-0033 Part 4 + Tier B abandonment + X1/X1.5.b fixes (this repo, 2026-05-20)
- agrun live test artifacts at `agrun_docs/live-tests/b1-b4-fix-2026-05-20/`, `tier-b-poc-2026-05-20/`, `x1-fix-2026-05-20/`, `x1-5b-fix-2026-05-20/`
