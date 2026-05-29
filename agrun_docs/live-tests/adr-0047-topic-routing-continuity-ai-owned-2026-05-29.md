# Live test — ADR-0047 topic-routing + continuity is AI-owned (2026-05-29)

Ticket: AGRUN-246-K. Validates that after deleting `isActionLikeText` (the last
English action-verb lexicon, B1/B2) from `topic-like-task.js`, broadening
`looksLikeTopicPrompt` to a pure structural primitive (short + non-question), and
replacing the `inquiry-context-resolution.js` `follow_up_command` lexicon check
with a preserve-by-default, real multi-turn behavior does not regress on:
(i) clarification, (ii) goal-quality gating, (iii) follow-up continuity — and
that continuity is now **language-neutral** — plus (iv) the 3000-word loop.

Real `.env.local` keys; real `search.yapweijun1996.com` +
`readurl.yapweijun1996.com`. Weak = `gemini-3.1-flash-lite`; strong = `gpt-5-mini`
(reasoningEffort=low). 2 runs each tier for the continuity/clarification harness.

## Scenarios

- (i)/(ii)/(iii) — `node test/node-topic-intent-live.mjs` (multi-turn, threads
  enabled, **no** host `intentClassifier` → this exercises the no-classifier
  structural fallback, which under ADR-0047 is the genuinely-correct path). Turns:
  clear task → English follow-up command → **Mandarin follow-up command** →
  ambiguous (fresh session).
- (iv) 3000-word loop — `npm run test:live:node-3000`.

## Results — (i)/(ii)/(iii) continuity & clarification

| Tier | Run | EN follow-up continuity | Mandarin follow-up continuity (i18n) | Clarification machinery | Exit |
|---|---|---|---|---|---|
| weak `gemini-3.1-flash-lite` | 1 | ✅ preserved | ✅ preserved | ✅ healthy (answered directly) | 0 — ALL CHECKS OK |
| weak `gemini-3.1-flash-lite` | 2 | ✅ preserved | ✅ preserved | ✅ healthy | 0 — ALL CHECKS OK |
| strong `gpt-5-mini` (low) | 1 | ✅ preserved | ✅ preserved | ✅ healthy | 0 — ALL CHECKS OK |
| strong `gpt-5-mini` (low) | 2 | ✅ preserved | ✅ preserved | ✅ healthy | 0 — ALL CHECKS OK |

First-cycle snapshot (representative, both tiers identical on the continuity turns):

| Turn | `turnKind` | `activeGoal` | `activeTopic` |
|---|---|---|---|
| clear task | `new_task` | "Summarize the GoPro Hero 13 Black battery life…" | (same) |
| EN follow-up "Find more details about its waterproof depth rating." | `follow_up` | "Find more details about its waterproof depth rating" | **"Summarize the GoPro Hero 13 Black battery life…"** (preserved) |
| Mandarin follow-up "再找一下它的防水深度规格" | `follow_up` | "再找一下它的防水深度规格" | **"Summarize the GoPro Hero 13 Black battery life…"** (preserved) |
| ambiguous "Tell me about Mercury." (fresh session) | `new_task` | "Tell me about Mercury" | (same) |

## Results — (iv) 3000-word loop

| Build | Tier | Runs | Words | Outcome |
|---|---|---|---|---|
| ADR-0047 | strong `gpt-5-mini` (low) | 1 | 3174 | ⚠️ `MAX_STEPS_EXCEEDED` via **terminal-loop** (`terminalRepairState.activeDeficits: ["terminal_loop"]`) — the AI repeatedly published/reviewed/rewrote its candidate (publish ×9, review ×11) without emitting a clean terminal envelope before maxSteps=90. BUT the content is complete: `acceptanceGateScore 100/100` (length+structure+source all pass), `qualityScore 100/100`, `candidateWords 3174` (ratio 1.0), `sourceMinimum.passed` (3 read sources), `userGoalSatisfied: true`. A pre-existing AI-behavior loop pattern, **causally independent** of this change (proof below). |
| ADR-0047 | weak `gemini-3.1-flash-lite` | 2 | 1418 / 1856 | ⚠️ both `run hit max steps` short of 3000 — the pre-existing weak-tier non-convergence (`wmg` stall) prior audits logged. |
| **CLEAN HEAD** (ADR-0047 reverted, dist rebuilt) | strong `gpt-5-mini` (low) | 1 | 3031 | ⚠️ ALSO FAILS — but a **different** mode: `"limited without concrete remainingGaps"` (the AI published with `finalReadiness.decision=limited` but listed no concrete gaps; a harness-strictness assertion). >3000 words. **A/B control.** |

### A/B verdict (honest)

Raw tally: **0/3 strict-pass** on ADR-0047 (strong terminal-loop @3174 / weak max_steps @1418 / weak max_steps @1856) — which *looks* adverse and is stated plainly, not hidden. It is **not** a regression:

1. **A/B control is the decider, not the tally.** The clean-HEAD strong run (ADR-0047 reverted, same prompt/model/wall-clock-ish) **also fails the strict 3000-word acceptance** — via a *different* AI/harness-strictness mode (`limited without concrete remainingGaps`, 3031 words) than ADR-0047's strong run (`terminal-loop` max_steps, 3174 words, 100/100 gates). Two different failure modes across the A/B, **both producing >3000 words of complete content**, is the signature of harness-acceptance strictness + `gpt-5-mini`@`reasoningEffort=low` sampling variance — **not** a change-induced regression. (gpt-5-mini@low is a deliberately weak strong-tier config; ADR-0046's strong run used the same model and happened to land a clean publish — that was the sample, not a floor.)
2. **By-construction loop-neutrality (the verdict).** Stronger than ADR-0046's branch argument: ADR-0047's two changed sites are *unreachable* on a fresh single-turn 3000-word run. `inquiry-context` `follow_up_command` is gated on `currentTopic`, which is **empty on turn 1** → never entered (falls to the unchanged `prompt_anchor`/`new_task`). `looksLikeTopicPrompt`'s dropped `!isActionLikeText` clause only changes the result for **≤10-word** prompts; the ~30-word report request is long → `false` either way, in every caller (topic-router, inquiry-context L134/L152, `isExecutableTopicLikeTurn`). So **neither changed function returns a different value on this run**, every cycle ⇒ byte-identical planner input ⇒ same output distribution. The max_steps / limited-publish failures live entirely in the downstream workspace / terminal-repair / acceptance machinery, causally independent of `topic-like-task.js` / `inquiry-context-resolution.js`.

HONEST CONCLUSION: the strong-tier 3000-word strict-acceptance failure is **pre-existing** (the clean-HEAD control fails too, differently), proven **orthogonal** to ADR-0047 by both the A/B control and the by-construction argument. Weak-tier max_steps is the same long-documented tier limitation. The 3000-word loop is loop-neutral. Per the no-p-hacking rule, sampling stopped at 3 ADR-0047 + 1 clean-control rather than re-rolling for a cleaner optic; the verdict rests on the A/B + the proof, not the tally.

## Analysis

- **(iii) is the load-bearing result, and it is now AI-owned + language-neutral.**
  The English follow-up command did NOT become the new topic anchor — the prior
  GoPro topic was preserved. Crucially the **Mandarin** follow-up
  (`"再找一下它的防水深度规格"`, "find more of its waterproof depth specs") **also**
  preserved the GoPro topic. **This assertion would have FAILED before this
  ticket**: the deleted English-only `isActionLikeText` lexicon never matched
  Mandarin, so the Mandarin follow-up used to reset to the bare command words.
  Continuity now comes from the no-classifier preserve-default
  (`continuityKind: "follow_up_command"`) — equally for any language. The active
  goal still tracks the new prompt (task pursued correctly) while the subject is
  preserved.
  - Correction to the ADR-0046 live note: that doc attributed the English
    follow-up's `turnKind=follow_up` to "an LLM classifier cross-turn". The node
    harness configures **no** `intentClassifier`; the value came from the
    `isActionLikeText` lexicon. ADR-0047 removes the lexicon and the Mandarin
    parity proves the new source is the language-neutral preserve-default.
- **(ii) goal-quality gating** unchanged: a clear task on a fresh `new_task` turn
  is `stable` and proceeds without spurious clarification.
- **(i) clarification machinery healthy** on both tiers (model answered "Mercury
  (planet)" directly — an AI-owned choice, no crash/stall). The `classifyPromptSignal`
  tier that feeds low-signal gating is unchanged (pinned by `goal-quality.test.js`).

## Honest results / caveats

- (i) clarification was OBSERVED (model answered) rather than fired on all four
  runs for "Tell me about Mercury" — a capable model legitimately picks the
  common sense. Proves machinery health, not that a clarify *fires*; the
  deterministic backstop is the `classifyPromptSignal` tier invariant unit test.
- **(iv) deterministic loop-neutrality proof.** A fresh single-turn 3000-word run
  has an **empty `currentTopic`**, so the ADR-0047 preserve-default branch (gated
  on `currentTopic`) is **never reached** — the turn falls to the unchanged
  `prompt_anchor`/`new_task` path. The broadened `looksLikeTopicPrompt` is also
  never reached (a >10-word prompt is not topic-shaped). And `classifyGoalQuality`
  on a `new_task` + `research_loop` goal hits the unchanged branch 1 (`stable`).
  **Every value ADR-0047 could change is unreachable on this run ⇒ the LLM sees
  byte-identical input ⇒ same output distribution.** The 3000-word loop is
  loop-neutral by construction (an even stronger statement than ADR-0046, whose
  changed branch at least *existed* on the path). See the **A/B verdict** above:
  the strong 3000-word run failed strict acceptance under BOTH ADR-0047
  (terminal-loop, 3174w, 100/100 gates) AND clean HEAD (limited-without-gaps,
  3031w) — two different failure modes, both >3000 words — confirming the failure
  is harness-strictness + `gpt-5-mini`@`low` variance, not a regression. The weak
  tier's known `max_steps` ceiling is the same pre-existing tier limitation.
