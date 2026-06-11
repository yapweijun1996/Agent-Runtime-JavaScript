# Live test #2: gemini-3.1-flash-lite + thinkingLevel=high (3000-word) — hard_veto observation baseline

**Date**: 2026-05-24
**Run ID**: `2026-05-24T05-29-27-376Z`
**Artifacts**: `agrun_debug_runs/2026-05-24T05-29-27-376Z.{jsonl,md,-report.md}`
**Purpose**: AGRUN-249 baseline #2 — verify which hard_veto path actually fires under repeated flash-lite finalize attempts.

## Run Config (identical to baseline #1)

| field | value |
|---|---|
| provider | gemini |
| model | gemini-3.1-flash-lite |
| thinkingLevel | high |
| plannerMode | envelope |
| maxSteps | 60 |
| requestedWords | 3000 |
| timeoutMs | 300000 |

## Outcome (compared to baseline #1)

| dimension | baseline #1 | baseline #2 | delta |
|---|---|---|---|
| Node test acceptance | PASS | PASS | = |
| runStatus | completed | completed | = |
| terminalizedBy | workspace_publish_candidate | workspace_publish_candidate | = |
| candidateWords | 599 | **564** | -35 (~6%) |
| finalCandidateStructureOk | false | **true** | ✅ |
| structureIssueCodes | duplicate_headings, duplicate_section_numbers | (empty) | ✅ |
| sourceMinimum.passed | true (16/5) | true (13/9) | = |
| successfulReadUrlCount | 11 | 11 | = |
| durationMs | 547143 | **337228** | -38% (faster) |
| decision | limited | limited | = |
| finalize attempts | 8 | 7 | -1 |
| **hard_veto fires** | 0 | **2** (cycles 23, 30) | ⚡ first observation |
| plannerInvalidCount | 0 | 0 | = |

## Action distribution

| action | baseline #1 | baseline #2 |
|---|---|---|
| finalize | 8 | 7 |
| read_url | 6 | 6 |
| web_search | 4 | 2 |
| workspace_publish_candidate | 3 | 2 |
| workspace_write | 1 | 2 |
| plan | 2 | 0 |
| workspace_finalize_candidate | 2 | 1 |
| workspace_read | 2 | 1 |
| workspace_insert_after_section | 1 | 0 |
| todo_plan | 1 | 1 |
| todo_run_next | 1 | 1 |

Total steps: 31 (#1) vs 24 (#2).

## Hard_veto fire detail (KEY FINDING)

Two `hard_veto_fired` events captured (cycles 23 and 30):

```json
{
  "actionName": "finalize",
  "stepType": "terminal-repair-hard-veto-blocked",
  "budgetState": "enough",
  "ignoredCount": 6,
  "cycleCount": 23,
  "candidateWords": 0
}
```

```json
{
  "actionName": "finalize",
  "stepType": "terminal-repair-hard-veto-blocked",
  "budgetState": "enough",
  "ignoredCount": 7,
  "cycleCount": 30,
  "candidateWords": 0
}
```

**Critical implication for AGRUN-249 prioritization**:

- `stepType=terminal-repair-hard-veto-blocked` — this is `maybeBlockTerminalRepairAction` (src/runtime/action-loop-action.js:922), NOT `maybeBlockReadOnlyPlanningLoop` (L1443).
- The prose template that fired is `hardVetoActionNotAllowed` in `src/runtime/terminal-repair-strings.js:54-83`.
- `budgetState=enough` — AI still had budget, yet hard_veto fired because finalize was being repeated. The prose template's `budgetExhausted ? ... : firstAllowed` branch took the non-exhausted path and offered "Take an allowed next action (e.g. X, or Y)" but AI continued to retry finalize 6 more times.
- `candidateWords=0` at first hard_veto fire — AI had not yet written a draft when it kept calling finalize. The deficitHint was non-specific about magnitude.

This **REVERSES** the prior YELLOW-deep-review verdict:

| AGRUN-249 ticket | Pre-trace#2 priority | Post-trace#2 priority |
|---|---|---|
| AGRUN-249-G (`hardVetoActionNotAllowed` prose) | P2 cleanup | **P0 — direct cause of observed finalize loop** |
| AGRUN-249-H (`maybeBlockReadOnlyPlanningLoop` MUST + fallback) | P0 | **P2 defensive — not observed firing** |

## Wins

1. **structureOk=true** for first time — duplicate_headings issue did NOT recur in baseline #2. Structural fix may already be subtle (or trace variance).
2. **38% faster** (337s vs 547s) — fewer cycles, faster completion despite same budget.
3. **Source quality higher** (9 relevant vs 5) — `thinkingLevel=high` shows stable source acquisition behaviour.
4. **hard_veto debug event surfaces** — confirms AGRUN-DEBUG-01 instrumentation (cycleCount, candidateWords, ignoredCount inline on the event) is useful for hot-path identification.

## Issues confirmed by trace #2

### Issue #G (HIGHEST — direct hard_veto loop cause)
`hardVetoActionNotAllowed` non-exhausted-budget prose at terminal-repair-strings.js:73-78:
```
"Continue recovery work before any further finalize. ${deficitHint} Take an allowed next action (e.g. ${firstAllowed}...)."
```
Fired 6 times consecutively with `candidateWords=0` and `budgetState=enough`, AI still attempted finalize 6 more times. Either prose is not specific enough about magnitude (no "0 vs 3000 words gap" facts), or the "e.g. X" listing distracts more than the structured `allowedActions[]` array.

### Issue #A (still relevant)
No `lengthExpansionSignal` exists. AI sees `candidateWords=0` against `requested=3000` only through observable workspace stats; no per-section delta projection.

### Issue #1 from baseline #1 (length expansion) still applies
Final 564 words ≠ requested 3000. AI did 2× workspace_write (vs 1× in #1) and 0× insert_after_section (vs 1× in #1) — same incomplete iteration pattern.

## Issues NOT confirmed (deprioritize)

### Issue #H (`maybeBlockReadOnlyPlanningLoop`)
Did not fire in either trace #1 or #2. The "You MUST" wording + hardcoded fallback array remain in code as a defensive risk but are not the observed real-world failure path. Demote AGRUN-249-H from P0 to P2.

### Issue #B (structure repair tool naming)
Structure was OK in trace #2; not the observed bottleneck on this prompt. Keep on backlog.

## Re-prioritized AGRUN-249 implementation order

| Order | Subtask | Trace evidence |
|---|---|---|
| 1 | AGRUN-249-G + new deficit-magnitude signal | hard_veto fires 2× in trace #2 |
| 2 | AGRUN-249-A length expansion signal | candidate=564/3000 in both traces |
| 3 | AGRUN-249-F English-keyword demotion | defensive (Mandarin not yet tested with new config) |
| 4 | AGRUN-249-B structure repair naming | trace #2 structure OK; lower urgency |
| 5 | AGRUN-249-C finalize loop pivot | may be subsumed by G + A |
| 6 | AGRUN-249-E userGoalSatisfied | tooling, parallel |
| 7 | AGRUN-249-H read_only_planning fix | defensive; not observed |
| 8 | AGRUN-249-D unused evidence | exploratory |
| 9 | AGRUN-249-I PLANNER_INVALID_ACTION | optional |

## HBR

- Sample size n=2 is insufficient — `candidateWords` varied 599↔564 (~6%) and `structureOk` flipped false↔true. Trace #3 in flight to establish if hard_veto fire rate is consistent.
- Trace #2 PASS at Node test gate but produced 564/3000 words = 19% delivery — `userGoalSatisfied` flag (AGRUN-249-E) would surface this honest-but-incomplete result for CI regression detection.
- AGRUN-249-H was incorrectly P0 in the YELLOW deep review; trace #2 corrects this — code-review without runtime evidence misranked priority.

## Tracked under

[AGRUN-249](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/task.md) subtask table — see updated priority column reflecting trace #2 evidence.
