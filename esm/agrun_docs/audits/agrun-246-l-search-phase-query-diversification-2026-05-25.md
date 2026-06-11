# AGRUN-246-L — Search-Phase Query Diversification (REJECTED 2026-05-25)

> **Status: REJECTED — wrong-shape signal.** Implementation was built,
> unit-tested (8/8 PASS), simulator-verified (3/3 PASS on the
> `same-angle-repeat` variant), and live-verified across two batches.
>
> - v1 (optional `queryAngle`): 1/3 strict pass; AI skipped optional
>   field in 4 of 5 production web_search calls; signal stayed dormant.
> - v2 (`required: true`): 0/3 strict pass; AI declared narrow
>   single-token angles (`definition`, `technical`) that matched the
>   topic name, locking the misinterpretation faster. Score 0 was the
>   worst trace in the entire AGRUN-246 series.
>
> Rolled back via `git reset --hard af6f105ba`; both commits unpushed.
> See
> `agrun_docs/live-tests/agrun-246-l-verify-rejected-2026-05-25.md`
> for the rejection evidence + the lesson that **required structured
> fields with no semantic-orthogonality constraint can amplify the bias
> they were meant to catch**. Replacement ticket AGRUN-246-N (research)
> needs orthogonality, not just diversity-count.

## Scope

Replacement ticket for AGRUN-246-K after the read-phase convergence signal
was live-rejected
(`agrun_docs/live-tests/agrun-246-k-verify-rejected-2026-05-25.md`). The
correct intervention point is the search phase, not the read phase.

This is a research doc. No code change yet. Goal: define the issue at the
right intervention point, propose a harness-correct lever, and document the
acceptance shape and anti-patterns BEFORE any implementation attempt.

## Issue (re-stated from the right angle)

`gemini-3.1-flash-lite` on the canonical Mandarin Harness Engineering prompt
issues 1-3 `web_search` queries at the start of every run, BEFORE any
`read_url`. In failing runs, those initial queries cluster around a single
misinterpretation of the user's topic (e.g. "Harness Engineering = LLM
evaluation harness / test harness / framework architecture"). Once the
candidate URLs from those search hits are queued, the read phase commits to
that cluster and a post-hoc read-phase signal cannot pull the model back.

From AGRUN-246-K 7-trace distribution sampling:

| Run | First 1-3 web_search queries | Outcome |
|---|---|---|
| Baseline / PASS / PASS / PASS | At least one query contained `control patterns` / `guardrails` / `orchestration` / `architecture components` / `sensors` / `case studies` | Source PASS |
| FAIL #1, #2, #3 | All initial queries clustered on `evaluation framework` / `test harness` / `framework architecture` | Source FAIL with 16-18 reads / 1 relevant |

The diagnostic distinguishing factor is concentrated in the **first 3
queries**. After those, the cluster is locked.

## Existing harness pieces (re-survey)

- `src/skills/providers/web-search-planner.js` — already guides the AI on
  query crafting, but it is one-shot at search time. No feedback loop on
  observed query overlap or cluster homogeneity.
- `src/skills/providers/web-search-ranking.js` — ranks search hits; runs at
  hit time. Does not surface "your queries are clustered" signals.
- `src/runtime/research-state.js` — tracks `searchPasses` and search results
  but does not score the query set itself for homogeneity.
- `src/runtime/action-pattern-convergence.js` — has `consecutiveProductive`
  counters but no `search_query_cluster_homogeneity` signal.
- `src/runtime/read-url-recovery-signal.js` — exposed read-phase recovery;
  the AGRUN-246-K attempt extended this to read-relevance streak. Confirmed
  too late.

The gap: the runtime never tells the AI "your last N search queries share a
high-overlap token cluster; your topic interpretation may be too narrow."

## Proposed direction (research only, not yet implemented)

Smallest harness-side surface respecting AI-first / no-hardcode:

1. After each `web_search`, compute a homogeneity score on the last N
   queries (N = 3). Two simple measures:
   - **Token-overlap ratio**: the share of distinctive tokens (lowercased,
     stop-word-filtered) that appear in ≥ 2 of the last N queries.
   - **Topic-drift count**: number of distinctive token clusters across the
     N queries.
2. When the homogeneity score crosses a threshold (e.g. token-overlap ratio
   ≥ 0.6 across the last 3 queries), expose a NEW signal
   (`search_query_diversification_signal` or similar) on the runState. Fields:
   - `recentQueries[]` (the last N with their distinctive tokens)
   - `sharedTokens[]` (the high-overlap tokens that suggest a single
     interpretation)
   - `diversificationHint` (NL message naming the shared cluster and asking
     for a different angle)
   - `recommendedNextMoves: ["web_search_alternate_angle"]` — but NOT
     auto-issued. The AI still chooses.
3. Surface through the existing planner-prompt path. Inject BEFORE the
   `readUrlRecoverySignal` block so the AI sees it during the early query
   phase, when the lever still has effect.

Thresholds need a calibration pass against the 7-trace AGRUN-246-K data
BEFORE implementation. The query lists are already captured.

## Offline Calibration Result

Completed in
`agrun_docs/audits/agrun-246-l-offline-calibration-2026-05-25.md` with:

```bash
node scripts/calibrate-agrun-246-l-query-diversification.mjs
```

Result:

- Pure token-overlap is rejected. It cannot catch all 3 source-fail query
  sets without colliding with at least one strict-pass run.
- A topic-anchor lexical rule can explain this small corpus, but it would
  hardcode tokens such as `guardrails`, `orchestration`, `evaluation`, and
  `framework`; do not ship that as runtime logic.
- Calibrated direction: add an AI-authored `queryAngle` / `queryIntent`
  declaration to `web_search`, then let runtime expose a signal when the
  first 2-3 searches repeat one declared angle or show too few distinct
  angles. Runtime observes declarations and query facts only.

This keeps 246-L in research/design. No runtime code is unlocked until a
replay fixture exists for the captured query sets.

## Anti-patterns to AVOID (per CLAUDE.md, learned from 246-K)

- Do NOT auto-block `web_search` or auto-issue a different query — runtime
  decides nothing the AI should decide.
- Do NOT modify the user's prompt to "expand" the topic — that hides what
  the AI is doing.
- Do NOT implement before calibrating the threshold on the captured 246-K
  6-trace query data. The 246-K mistake was calibrating threshold on read
  streaks (where the distribution was clean) and assuming behavioral lift
  would follow — only to discover the lever was post-hoc. The 246-L
  threshold must be calibrated on the **right** distribution: the 3 failing
  vs 4 passing initial-query sets from 246-K.
- Do NOT skip the live verification gate. Any code change in this area
  MUST be verified with ≥3 canonical reruns BEFORE the commit lands. The
  246-K series cost ~9 live runs and a rollback; the harness-engineering
  cost of skipping live verification is high.

## Acceptance shape

When implementation lands:

- ≥3 canonical Mandarin reruns on the post-fix HEAD must show ≥3/3 strict
  pass rate (vs the current 3/7 = 43% baseline).
- No regression in AGRUN-246-J `applyIfValid:true` propose+apply collapse
  pattern.
- Diversification signal must elevate in the failing-case query sets from
  the 246-K capture but NOT in the passing-case query sets — measurable on
  the captured fixture data without running new live tests.

## Open questions (pre-implementation)

- What exact queryAngle/queryIntent contract should `web_search` expose so
  the AI can declare search angle without runtime choosing one?
- What replay fixture should guard the 7 captured query sets before runtime
  code lands?
- Should the signal also include the original user prompt's distinctive
  tokens as a comparison baseline? That would help the AI see "your queries
  drifted from these source tokens."

## HBR

- This is research, not implementation. The 246-K series showed that
  jumping from research to implementation without live calibration is
  expensive.
- Calibration against the captured 6-trace data is the next step BEFORE
  any code change.
- The captured failing-run query sets are an offline calibration corpus:
  no new live runs needed for the calibration pass.

## Evidence anchors

- 246-K verify rejection: `agrun_docs/live-tests/agrun-246-k-verify-rejected-2026-05-25.md`.
- 246-K 6-trace distribution + raw query sets: `agrun_docs/live-tests/agrun-246-k-distribution-sampling-2026-05-25.md`.
- Failing-run query trace evidence: `agrun_debug_runs/2026-05-25T01-21-38-039Z.{md,jsonl}`,
  `2026-05-25T01-57-34-790Z.{md,jsonl}`, `2026-05-25T01-57-43-502Z.{md,jsonl}`.
- task.jsonl id: `AGRUN-246-L-SEARCH-PHASE-QUERY-DIVERSIFICATION-2026-05-25`.
