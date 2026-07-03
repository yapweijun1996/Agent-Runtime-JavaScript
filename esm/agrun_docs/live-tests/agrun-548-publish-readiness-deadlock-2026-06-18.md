# AGRUN-548 — Publish-readiness coherence observation breaks deepseek terminal-handshake deadlock

**Date:** 2026-06-18
**Model under test:** deepseek-v4-flash, reasoning_effort=high
**Benchmark:** `test/node-agrun-3000-live.mjs` (3000-word deep research report, maxSteps=90)
**Baseline for production:** gemini-3.5-flash low (stable 100, ≤25 calls)

## Symptom

deepseek-v4-flash high burned all 90 steps and FAILED with `MAX_STEPS_EXCEEDED`
while holding a **100/100 candidate it never shipped** (length ✓, structure ✓,
source ✓, 3255 words). It was not writing bad content — it could not execute the
terminal publish handshake.

## Root cause — SSOT incoherence between two readiness auditors

Two independent signals disagreed and the model was never given a coherent
"you are done" message:

- `acceptanceGateScore` (mechanical: length/structure/source) = **100 / pass**.
- `candidateQualitySignal` = **blocked**, because `missing_latest_candidate_review`
  (and the AI self-review codes `ai_review_not_ready` / `objective_requirement_unmet`)
  **re-fire on every edit made after the last review**
  (`src/runtime/candidate-quality-signal.js:113-153`).

The model read `status:blocked`, kept editing to "fix" it, every edit re-staled
its own review, and `missing_latest_candidate_review` never cleared — an
edit→review→edit loop. The only hard clamp, terminal-repair `hard_veto`, is
effectively budget-exhausted-bound
(`src/runtime/terminal-repair/core.js:204-209` × `src/runtime/cycle-budget.js:33-40`,
`exhausted` only at `remaining===0`), so it fired at step 90 — too late.

## Fix — fact-only AI-first observation (no forced action)

`src/runtime/virtual-workspace.js` `formatCandidatePublishReadinessObservation()`,
rendered in the shared, path-agnostic `buildVirtualWorkspacePromptBlock` so it
covers **both** dispatch doors automatically (the signal is stored symmetrically
by `buildAndStoreCandidateQualitySignal`). It fires only when:

- every blocking code ∈ {`missing_latest_candidate_review`, `ai_review_not_ready`,
  `objective_requirement_unmet`} (handshake-only), **and**
- no `external_word_count_below_target` advisory (length is met).

It surfaces **facts only** (AGRUN-246-C), never an imperative action sequence:
gates pass; the remaining blockers are review-handshake state, not content
deficits; a review goes stale after later edits; a limited
`workspace_publish_candidate` (`decision='limited'`) stays valid when real gaps
remain. The first draft was imperative ("To finish: run X then Y") and was
rewritten after it broke the fact-only contract (readiness-prompt test #12).

## Validation — 4 live runs (deepseek high), 1 pre-change baseline

| Run | Entered deadlock? | Escaped? | Outcome | Notes |
|-----|-------------------|----------|---------|-------|
| pre-change | yes (step 34) | **no** | FAIL | 90/maxStep, 100/100 candidate never published |
| verify | no (natural) | — | **PASS** | 25 steps |
| trial 1 | yes (step 22) | yes → publish step 47 | **PASS** | |
| trial 2 | yes (step 6) | yes → publish step 52 | **PASS** | |
| trial 3 | yes | yes → published | FAIL | **orthogonal**: cited a blocked URL (`dangling-citations[5]`, acceptanceGate structure=false), not the deadlock |

**Deadlock-escape rate: 0/1 → 3/3.** Overall pass-rate 3/4 (75%).

## Honest caveats

- **Causation is strong but not airtight.** The behavior shift (deadlock→publish)
  is consistent and mechanism-explained, and the unit test proves the observation
  renders in exactly the deadlock state — but `trace.v1` stores only a projected
  summary, not full prompt text, so the observation string cannot be grepped from
  live traces to prove it was read on the deciding step. n is small (1 pre vs 3 post).
- **trial 3's failure is out of scope.** It escaped the deadlock and published;
  it failed a separate content gate by citing a blocked/unreadable URL. That is
  deepseek content variance, a separate follow-up, not AGRUN-548.
- **Production guidance unchanged:** gemini-3.5-flash low for this task class
  (stable 100, ≤25 calls). deepseek high now escapes the maxStep deadlock but
  still carries content variance.

## Determinism

New test `test/unit/agrun-548-publish-readiness-observation.test.js` 6/6; full
unit suite 332/332; `npm run build:lib` green; observation string confirmed in
`dist/agrun.js`. The single pre-existing smoke failure
(`test/livekit/repro-workspace-publish-loop.mjs`) was confirmed unrelated by
stashing this change and reproducing it on the clean tree.
