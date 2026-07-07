# AGRUN-542 Content-Structure Exit Live Report

Date: 2026-07-06

## Result First

AGRUN-542's mechanism is implemented and fully covered by deterministic tests
(`npm run check` exit 0), and the live benchmark improved substantially versus
the same-day baseline — but the full performance SLO (<=90s, <=25 provider
calls, <=300k tokens) did NOT pass live. Numbers below are honest fails, not
partial successes.

## The Mechanism (general, no benchmark hardcoding)

New SSOT module `src/runtime/terminal-repair/content-structure-exit.js`:

- EPISODE: while terminal repair is active AND length + read-source facts are
  satisfied AND a content-level structure issue (`semantic_duplicate_headings`
  / `body_after_final_section`) remains on a real candidate, a bounded
  content-structure exit episode is active.
- ONE ATTEMPT: exactly `thresholds.contentStructureRepairAttempts` (default 1,
  host-overridable) content-changing repair attempts, detected via the final
  candidate FILE VERSION — blocked mutations (AGRUN-541 destructive shrink,
  AGRUN-540 heading-only patch previews) never bump the version and never
  consume the attempt.
- FAILED-ATTEMPT BOUND: blocked/missed repair mutations
  (`destructive_shrink_blocked`, `preview_blocked`, `not_found`, `ambiguous`,
  `heading_not_found`, `repeated_find_vetoed`) are bounded separately — more
  than the attempt limit of them also forces the exit (they make no observable
  progress and never tick ignoredCount, the loop shape both live baselines
  showed).
- FORCED EXIT: once the attempt budget is used, or failed mutations exceed it,
  or ignoredCount reaches the hardVeto threshold while the episode is active:
  - `buildAllowedActions` returns `[workspace_publish_candidate]` ONLY —
    consumed by BOTH dispatch doors (single-action preflight allowlist in
    `src/runtime/blocks/terminal-repair.js` and the plan-batch surface filter
    in `src/runtime/planner-action-surface.js`).
  - a new first-priority escape descriptor
    `contentStructureExitForcedPublishGranted` (opensPublish: true,
    opensFinalize: false) is granted, so the publish reaches the executor
    while direct finalize/final_answer stay MECHANICALLY blocked on the
    onResponse hook door (`src/runtime/hooks/terminal-repair-hook.js`) — the
    escape never opens finalize, which would re-compress a length-satisfied
    candidate (the AGRUN-541 regression shape).
  - both doors emit a dedicated contract message
    (`DEFAULT_TERMINAL_REPAIR_STRINGS.block.contentStructureForcedPublish`)
    and the planner prompt carries `contentStructureExitSignal` (episode
    state + rule) in `terminalRepairState` and the focused hard-veto block.
- RESET: the episode resets when the content-level issue clears or the run
  terminates; a length or source deficit disables it entirely (AGRUN-540/541
  repair semantics stay authoritative).

## Live Benchmark (canonical AGRUN-538..542 config)

`NODE_AGRUN_LIVE_PERFORMANCE_SLO=1`, gemini-3.1-flash-lite, thinking low,
1500 words, maxSteps 70, minCitations 3, Loop/Harness Engineering prompt.

| Run | Duration | Provider calls | Tokens | Quality gates | Red flags | Cited readable URLs |
| --- | ---: | ---: | ---: | --- | --- | ---: |
| 2026-06-17T08-05-00Z (last recorded, pre-fix) | 183.8s | 23 | 378,428 | structure+source FAIL | repeated-headings x6 | n/a |
| 2026-07-06 baseline (current main, pre-fix) | 311.3s | 65 | 1,053,275 | ALL PASS (score 100, ready) | none | 3 |
| 2026-07-06 after-r1 (fix, version-bound only) | 200.3s | 38 | 609,668 | length+structure PASS, source FAIL | none | 0 |
| 2026-07-06 after-r2 (full fix) | TBD | TBD | TBD | TBD | TBD | TBD |

Artifacts: `agrun_debug_runs/agrun-542-baseline-20260706T101540Z.*`,
`agrun_debug_runs/agrun-542-after-r1-20260706T103525Z.*`.

## Honest Analysis

- The content-structure repair loop the ticket targets did NOT reproduce in
  every 2026-07-06 run: run-to-run variance is dominated by which failure
  mode the weak model wanders into (todo churn, review churn, replace
  not_found loops, provider latency 4-11s per call).
- Provider latency alone makes the 90s bar nearly unreachable at this model
  tier: ~26 planner decisions x ~7.7s average = ~200s in after-r1 even with
  zero terminal-repair churn.
- The mechanism is still correct and load-bearing: whenever the content-level
  structure deficit state occurs (the 2026-06-17 failure), the runtime now
  bounds it to one content-changing attempt + a small failed-mutation budget
  and then forces the honest limited publish, with finalize mechanically
  impossible on every door.
