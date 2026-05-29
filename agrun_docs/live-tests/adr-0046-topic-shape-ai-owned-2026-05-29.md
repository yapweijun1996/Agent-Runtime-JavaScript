# Live test — ADR-0046 prompt-shape intent is turnKind/AI-owned (2026-05-29)

Ticket: AGRUN-246-D C2.2. Validates that after removing the English question-word
lexicon (A2) + the `/\?$/` regex (A1) + the digit regex (C) from
`topic-like-task.js`, and threading `turnIntent.kind` into `task-state`
`classifyPromptSignal` + `goal-quality`, real multi-turn behavior does not
regress on clarification, goal-quality gating, follow_up_command continuity, or
the 3000-word research loop.

Real `.env.local` keys; real `search.yapweijun1996.com` + `readurl.yapweijun1996.com`.
Weak = `gemini-3.1-flash-lite`; strong = `gpt-5-mini` (reasoningEffort=low).

## Scenarios

- (i) clarification / (ii) goal-quality / (iii) continuity — `node test/node-topic-intent-live.mjs` (multi-turn, threads enabled). Captures first-cycle `promptSignal` tier, `goalQuality`, `turnKind`, `activeTopic`, and action names.
  - clear specific task → proceeds (goalQuality `stable`, no clarify).
  - follow-up COMMAND on same topic → prior topic anchor preserved (not reset to the bare command words).
  - genuinely ambiguous prompt (fresh session) → machinery healthy (ask_clarification fires OR model answers; no crash/stall).
- (iv) 3000-word loop regression — `npm run test:live:node-3000`. Pass = completes (ready or honest-limited), NOT `terminalizedBy: max_steps`.

## Results

| Scenario | Model (tier) | Result | Key evidence |
|---|---|---|---|
| (ii) clear task | gemini-3.1-flash-lite (weak) | ✅ | promptSignal `high`, goalQuality `stable`, turnKind `new_task`; proceeded |
| (iii) follow-up command | gemini-3.1-flash-lite (weak) | ✅ | turnKind `follow_up` (LLM classifier populated it cross-turn); activeTopic still "Summarize the GoPro Hero 13 Black battery life…" — NOT reset to "Find more details…"; goal-quality follow_up→stable branch exercised |
| (i) ambiguous "Tell me about Mercury" | gemini-3.1-flash-lite (weak) | ✅ | machinery healthy; model answered directly (AI-owned), no crash |
| (ii) clear task | gpt-5-mini (strong) | ✅ | promptSignal `high`, goalQuality `stable`, turnKind `new_task`; proceeded |
| (iii) follow-up command | gpt-5-mini (strong) | ✅ | turnKind `follow_up`; activeTopic preserved (continuity OK) |
| (i) ambiguous | gpt-5-mini (strong) | ✅ | machinery healthy; answered directly |
| (iv) 3000-word loop | gpt-5-mini (strong) | ✅ completed | `terminalizedBy: workspace_publish_candidate`, candidateWords **3155**, `userGoalSatisfied: true`, 0 fail events |
| (iv) 3000-word loop | gemini-3.1-flash-lite (weak) run 1 | ⚠️ max_steps (weak-model variance) | 848/3000 words, `duplicate_headings` non-convergence, `terminalizedBy: max_steps_continuation`. NOT a C2.2 regression — see deterministic proof below. |
| (iv) 3000-word loop | gemini-3.1-flash-lite (weak) run 2 | ⚠️ max_steps | 1419/3000 words |
| (iv) 3000-word loop | gemini-3.1-flash-lite (weak) run 3 | ⚠️ max_steps | 2003/3000 words |
| (iv) 3000-word loop | gemini-3.1-flash-lite (weak) **CLEAN HEAD (C2.2 reverted)** | ✅ PASS | **2937/3000 words** (ratio 0.979), `node_agrun_live_pass`, published — A/B control |

`node test/node-topic-intent-live.mjs` printed `ALL C2.2 LIVE CHECKS OK` for both
weak and strong tiers (EXIT 0).

## Analysis

- **(iii) is the load-bearing continuity result.** The follow-up command
  ("Find more details about its waterproof depth rating.") did NOT become the
  new topic anchor — the prior GoPro topic was preserved, on both tiers. The LLM
  turn-intent classifier populated `turnIntent.kind = "follow_up"` cross-turn
  (threads enabled), which is exactly what the C2.2 goal-quality migration
  reads. Continuity is AI-owned, not lexicon-owned.
- **(ii) goal-quality gating** works on the new turnKind path: a clear task on a
  fresh `new_task` turn is `stable` and proceeds without spurious clarification.
- **(i) clarification machinery healthy**: the prompt-signal tier (which feeds
  clarification low-signal gating) is unchanged — both tiers ran without crash;
  the model's choice to answer "Mercury (planet)" directly is an AI-owned
  decision, not a harness failure. The structural guarantee that low-signal
  gating is unchanged is also pinned by `goal-quality.test.js`
  (classifyPromptSignal tier invariant, incl. a CJK prompt → `"high"`).

## Honest results / caveats

- (i) clarification was OBSERVED (model answered) rather than triggered on both
  tiers for "Tell me about Mercury" — a capable model legitimately picks the
  common sense. This proves the machinery is healthy and not that a clarify
  *fires*; the deterministic backstop is the `classifyPromptSignal` tier
  invariant unit test (low-signal gating input provably unchanged by C2.2).
- The C2.2 source diff cannot change this single-turn 3000-word run's behavior
  (the directive prompt does not end with `?`, the tier is `high` either way,
  and a single-turn `new_task`+research_loop goal is `stable` via the unchanged
  branch 1) — so (iv) is a pure loop-regression smoke, recorded below.

### (iv) 3000-word loop — deterministic loop-neutrality proof + weak-model variance

**Full honest A/B tally (no cherry-picking):**

| Build | Runs | Words | Outcome |
|---|---|---|---|
| C2.2 (this change) | 3 | 848 / 1419 / 2003 | all `max_steps_continuation` (short of 3000) |
| CLEAN HEAD (C2.2 reverted, rebuilt dist) | 1 | 2937 | `node_agrun_live_pass`, published |
| strong gpt-5-mini (C2.2) | 1 | 3155 | passed, `workspace_publish_candidate` |

So on the weak tier the raw tally is **0/3 (C2.2) vs 1/1 (clean)** — which *looks*
adverse and is stated here plainly rather than hidden. It is **not** evidence of a
regression, and the reason is a proof, not a vote:

1. **Deterministic loop-neutrality proof (the verdict).** The weak failure mode
   (length deficit + duplicate headings + max_steps) lives entirely in the
   report-expansion / structure-repair loop. C2.2 cannot reach it: for the exact
   3000-word prompt, on a fresh single-turn research session,
   `turnIntent.kind === "new_task"` (fresh prompt → `prompt_anchor` fallback;
   confirmed empirically — the C2.2 harness clear-task turn reported turnKind
   `new_task`) and `executionClass === "research_loop"`, so `classifyGoalQuality`
   hits **branch 1** (`research_loop && new_task → stable`) — the branch C2.2 did
   **not** touch. The action-like branch C2.2 *did* change sits *after* branch 1
   and is never evaluated. `classifyPromptSignal === "high"` and
   `isQuestionLikeText(prompt) === false` both pre/post. **Every value C2.2 feeds
   the planner is identical, every cycle ⇒ the LLM sees byte-identical input ⇒
   same output distribution.** Identical input cannot be out-voted by samples.
   (Caveat that would break the proof: if the run's kind were `follow_up`/
   `drill_down`, clean→`topic_only` but C2.2→`stable` would diverge — but a fresh
   single-turn research run is `new_task`, so it holds.)
2. **n is far too small to distinguish, by design.** 848 / 1419 / 2003 / 2937 is
   a 3.5× spread on a tier the push-deletion skill already documents at 3.7×
   cycle / 7.6× token variance, and the 2026-05-24 after-G retrace recorded this
   model producing a 563-char / 14-word draft. 1 clean vs 3 C2.2 runs, on
   different wall-clock with different SearXNG/readurl responses and sampling
   seeds, has zero statistical power to separate two distributions the proof
   already says are identical. The C2.2 word counts trending up (848→1419→2003)
   is itself sampling noise, not a floor.
3. **Strong tier confirms the loop machinery is healthy under C2.2** (3155 words,
   clean publish).

HONEST CONCLUSION: the weak-tier `max_steps` on a 3000-word report is a real,
**pre-existing** tier limitation (the same one prior audits logged), proven
**orthogonal** to C2.2 by the deterministic argument. Per the no-p-hacking rule,
sampling was stopped at 3 C2.2 + 1 clean rather than re-rolling for a cleaner
optic. The verdict rests on the proof, not the tally.
