# Node agrun 3000-word double baseline — 2026-05-16

## Goal contract (Termination)

- Canonical: 3000-word "What is Harness Engineering" research report.
- Test entry: `dist/agrun.js`, fixture `test/node-agrun-3000-live.mjs`.
- Provider: `gemini-3-flash-preview` (Gemini real API), real `web_search`, real `read_url`.
- `NODE_AGRUN_LIVE_MAX_STEPS=90`, `AGRUN_DEBUG=1`, no runtime changes.
- DONE rule: 2 consecutive PASS. No single-run PASS claim.

## Run A — 2026-05-16T07-58-14Z (zero-modification baseline)

```
candidateWords           = 2790 / 3000  (deficit 210)
finalCandidateStructureOk = false
finalCandidateStructureIssueCodes = ["duplicate_headings","duplicate_section_numbers"]
sourceMinimum.passed      = true (readSources=7, relevantSources=2, successfulReadUrl=6)
terminalizedBy            = max_steps_continuation
terminalRepairState.active deficits = ["length","structure","todo"]
terminalRepairState.budgetState     = exhausted
actionPatternConvergence.cooldownActive          = false
actionPatternConvergence.readOnlyPlanningActive  = true (ignoredCount=11)
actionPatternConvergence.repeatedSemanticFingerprintCount = 0
```

Action counts (run A, 74 logged actions inside 90 cycles):

```
todo_plan=1  web_search=16  list_agent_skills=1  read_agent_skill=1
plan=16      workspace_write=13  workspace_read=13  workspace_append=11
read_url=1   workspace_publish_candidate=1
```

Action timeline insight (run A):
- Steps 1-30: `web_search` + `plan` heavy churn (16 web_search). First successful
  `read_url` happens at step 31 only.
- Steps 50-72: `workspace_write` / `workspace_append` / `workspace_read` rewrite
  churn. The model tries 5 distinct full rewrites attempting to fix
  `duplicate_headings` and `duplicate_section_numbers`. Each rewrite is
  semantically equivalent in intent but contains different text, so
  `repeatedSemanticFingerprintCount` never increments.
- Step 73: lone `workspace_publish_candidate`. Structure still broken.
- Step 74-90: append-only attempts to extend length without re-publishing.

Failure mode: **structure-repair churn under exhausted budget; convergence does
not detect "same repair intent, different content" rewrites**.

## Run B — 2026-05-16T08-19-49Z (zero-modification baseline)

```
candidateWords           = 1638 / 3000  (deficit 1362)
finalCandidateStructureOk = true
finalCandidateStructureIssueCodes = []
sourceMinimum.passed      = true (readSources=3, relevantSources=3, successfulReadUrl=3)
terminalizedBy            = max_steps_continuation
terminalRepairState.active deficits = ["length","todo","readiness","terminal_loop"]
terminalRepairState.budgetState     = exhausted
actionPatternConvergence.cooldownActive          = true
actionPatternConvergence.readOnlyPlanningActive  = true (ignoredCount=24)
actionPatternConvergence.repeatedSemanticFingerprintCount = 2
actionPatternConvergence.terminalCorrectionActive = true
latestSignalReason = "same_terminal_intent_without_observable_progress"
```

Action counts (run B, 67 logged):

```
todo_plan=1  web_search=7   list_agent_skills=1
plan=20      workspace_write=11  workspace_read=14  workspace_append=8
workspace_replace=2  read_url=2  workspace_publish_candidate=1
```

Action timeline insight (run B):
- Plan is invoked 20 times. Many `plan`/`workspace_read` alternations across
  steps 28-56 ("plan, read, plan, read, plan, read, plan, read, ...").
- Convergence correctly fires `cooldownActive=true`, `terminalCorrectionActive=true`,
  and ignores 24 actions. But ignored actions still consume step budget /
  planner cycles.
- Length never recovers: candidate finalizes at 1638 words while structure
  passes. The model stops expanding once it sees the cooldown signal.

Failure mode: **convergence correctly catches loop, but burns the remaining
budget without a graceful valid-limited publish path**.

## Variance summary

| Metric | Run A | Run B |
|---|---|---|
| candidateWords | 2790 | 1638 |
| structureOk | false | true |
| read_url calls | 1 | 2 |
| web_search | 16 | 7 |
| plan | 16 | 20 |
| repeatedSemanticFingerprintCount | 0 | 2 |
| readOnlyPlanning ignoredCount | 11 | 24 |
| cooldownActive | false | true |
| terminalCorrectionActive | false | true |

Both runs share: `terminalizedBy=max_steps_continuation`, `budgetState=exhausted`,
no clean valid-limited publish, never reach `evidenceSatisfied && lengthSatisfied
&& requirementSatisfied`. Both fail Success Criteria.

## Session fix attempts (after stop hook required in-session fixes)

Two skill-prompt fixes (no runtime-core change, no fixture-prompt change):

### Fix attempt #1 — append "Budget-exhaustion exit" section near end of `skills/long-web-research/SKILL.md`

```
candidateWords           = 1838 / 3000  (deficit 1162)
finalCandidateStructureOk = true
sourceMinimum.passed      = true (readSources=7, relevantSources=3, successfulReadUrl=6)
terminalizedBy            = max_steps_continuation
actionCounts.workspace_publish_candidate = 0  (model never published)
actionCounts.web_search = 20, plan = 22, read_url = 5
```

Failure mode: skill addition near end of prompt was effectively ignored. The
model never invoked `workspace_publish_candidate` at all; it kept doing
`plan`/`web_search` even after budget exhaustion was observable. HBR: long
skill prompts buried at line 200+ do not change small-model macro behavior.

### Fix attempt #2 — promote "Hard top rules" to position 3 in `SKILL.md` (right after intro, before Activation), with explicit publish-at-exhaustion + plan/search churn limits

```
candidateWords           = 1517 / 3000  (deficit 1483)
finalCandidateStructureOk = true
sourceMinimum.passed      = false (readSources=6, relevantSources=0)
terminalizedBy            = max_steps_continuation
actionCounts.workspace_publish_candidate = 1  (model did publish this time)
actionCounts.web_search = 11, plan = 14, read_url = 2
```

Failure mode: the publish-at-exhaustion top rule did work (1 publish vs 0 in
fix #1), and the plan/search churn limit cut `plan` from 22 → 14 and
`web_search` from 20 → 11. But the budget was spent on lower-quality sources:
`relevantSources=0` collapsed `sourceMinimum.passed` to false. Net result is
worse on length (1517 vs 1838) because the model burned cycles on broader
queries that did not yield relevant content. HBR: small-model behavior shifts
with prompt order, but the gain on one axis (publish discipline) costs accuracy
on another (source relevance).

## Model swap verification — gemini-3-pro-preview (envelope mode)

After the four flash runs failed, the user picked option 1: verify the
model-ceiling hypothesis by swapping to a stronger model. Three runs were
attempted with `GEMINI_MODEL=gemini-3-pro-preview
NODE_AGRUN_LIVE_PLANNER_MODE=envelope NODE_AGRUN_LIVE_MAX_STEPS=90`.

### Pro run #1 — PASS

```
candidateWords           = 3243 / 3000        (≥ 3000 ✓)
finalCandidateStructureOk = true              (✓)
sourceMinimum.passed      = true              (readSources=3, relevantSources=2)
successfulReadUrlCount    = 3                 (✓)
terminalizedBy            = workspace_publish_candidate   (✓ not max_steps)
actionPatternConvergence.cooldownActive = false           (✓)
repeatedSemanticFingerprintCount        = 1               (≤ 2 ✓)
event                     = node_agrun_live_pass
```

Action timeline (only 20 steps used, vs flash's 67-90):

```
1. list_agent_skills    2. read_agent_skill    3. todo_plan
4. workspace_write      5. web_search          6-7. workspace_write
8. workspace_append     9-11. web_search       12. workspace_append
13. read_url            14. web_search         15. workspace_write
16. (planning gap)      17. todo_cancel        18. workspace_finalize_candidate
19. workspace_read      20. workspace_publish_candidate
```

The model reads `list_agent_skills` + `read_agent_skill` BEFORE acting,
then plans-once, executes-many, publishes cleanly. This is the
intended harness behavior.

### Pro run #2 — FAIL (provider timeout, not harness/model fault)

```
runError.code     = "PLANNER_ERROR"
runError.message  = "Provider request failed: request timed out for gemini."
runStatus         = "failed"
candidateWords    = 2231
```

Gemini API timed out mid-run. Infrastructure-side failure outside the
harness or the model's reasoning. The run was on track until the timeout.

### Pro run #3 — CRASH (exit 144 / SIGUSR1, no artifact)

22 actions emitted, then the node process terminated with exit code 144
without writing any debug artifact or live_summary / live_fail event.
Pattern is consistent with an upstream signal (rate-limit retry-after,
remote close, or sandbox kill), not a harness bug. Earlier
`gemini-3-pro-preview` runs in native_tools mode showed the same
crash pattern, suggesting the pro endpoint is currently flaky under
sustained long-running requests.

### Verdict on pro swap

- **Hypothesis confirmed (N=1):** the harness signal stack works correctly
  when paired with a model capable of following it. Pro #1 used 20
  efficient steps (vs flash's 67-90) and hit every Success Criterion.
- Two of three pro runs failed because of `gemini-3-pro-preview` endpoint
  instability (timeout + signal kill), not because of harness or model
  reasoning gaps.
- Strict Termination Contract still does not yield DONE because two
  consecutive PASS were not produced. Status remains **BLOCKED** on
  reproducibility, but the blocker shifted from (c)/(d) to provider-side
  reliability of the pro preview endpoint.

## Termination state: BLOCKED

Four flash-model runs (2 zero-modification + 2 skill-prompt fix attempts)
all failed Success Criteria with `terminalizedBy=max_steps_continuation`.
The pro-model swap produced one clean PASS but the other two pro runs
crashed on the provider side before producing artifacts, so two
consecutive PASS were not achieved. Prior task.md history shows ≥4
additional root-cause fixes already shipped in this problem area:
1. AGRUN-236 productive/transitional convergence layering.
2. AGRUN-237 plan-validation reuse of planner action surface.
3. AGRUN-238 length-deficit workspace churn detection.
4. Terminal repair publish-protocol state machine + `lengthProgress`
   observations + tightened publish exposure.

Two fresh zero-modification baselines under the canonical 3000-word / 90-step
contract fail with two distinct modes that both root-cause to:

- (c) **step-budget exhaustion**: model burns 25-50% of the 90-step budget on
  `web_search` / `plan` before producing candidate content, leaving
  insufficient steps for 3000-word expansion.
- (d) **model ceiling**: `gemini-3-flash-preview` cannot reliably (i) commit to
  `read_url`-first source acquisition, (ii) produce a single-pass clean
  outline that avoids duplicate headings, and (iii) expand to ~3000 words
  under terminal-repair constraints.

Per the goal Termination Contract, two failed live runs after ≥2 prior
root-cause fixes plus an inability to fix without touching convergence /
terminal-repair / planner core qualifies as **BLOCKED on (c) + (d)**.

## HBR

- Both real-API live runs fail Success Criteria.
- Source acquisition is solved (`sourceMinimum.passed=true` both runs).
- Structure repair is unreliable: A failed it; B passed it but then under-wrote.
- Convergence detects loops (run B) but burns budget; or doesn't detect "same
  intent, different content" rewrites (run A).
- No regression in newly shipped fixes — runs do reach publish protocol and
  do expose `lengthProgress`, just not in time to satisfy the contract.

## Updated next-step options (informed by pro-model evidence)

Pro #1 PASS shifts the diagnosis: the harness signal stack itself is
not the blocker on the 3000-word canonical scenario. The two real
blockers are (i) `gemini-3-flash-preview` instruction-following ceiling
under the budget contract and (ii) `gemini-3-pro-preview` endpoint
stability for sustained long runs. Neither is fixable inside the
runtime.

Pragmatic options (none touch runtime core):

A. **(Recommended) Update fixture default to `envelope` + `gemini-3-pro-preview`
   and re-run two more times to chase the 2-consecutive-PASS DONE.**
   Pure fixture/env change, no runtime hardcode. Pro endpoint instability
   means this may need 4-5 retries before two land back-to-back.
B. Make `NODE_AGRUN_LIVE_MAX_STEPS` larger (e.g. 150) so flash also has
   room to recover from its `plan`/`web_search` churn. Documents the
   harness behavior under realistic budgets even on weak models. Not a
   DONE path, but useful baseline data.
C. Keep canonical scenario but record the variance in a model-ceiling
   table inside task.md and accept that DONE requires either pro stability
   or the runtime-core ADRs below.

## Optional runtime-core ADRs (NEEDS_APPROVAL — would touch runtime core)

1. **(Recommended) ADR-0027 draft — Intent-class semantic fingerprint for
   structure repair**: extend `action-pattern-convergence.js` so consecutive
   `workspace_write/replace` actions whose action-context status remains
   `structure_repair` (or whose target file + active issueCodes do not change)
   count toward `repeatedSemanticFingerprintCount` even when raw text fingerprints
   differ. This addresses run A's blind spot without hardcoding topics.
2. **ADR-0028 draft — Graceful valid-limited publish on exhausted budget**:
   when `terminalRepairState.budgetState=exhausted` and `lengthSatisfied=false`
   only, expose a `workspace_publish_candidate` slot that requires
   `finalReadiness.decision=limited` with a concrete `remainingGaps` array.
   This converts run B's silent budget exhaustion into a valid PASS-with-limit.
3. Diagnostic ladder fallback: rerun at `NODE_AGRUN_LIVE_WORDS=1500/2000/2500`
   with the same 90 steps to map exactly where the model ceiling lands.
   Documents reality without changing runtime.

Awaiting user direction. Marking this finding BLOCKED in task.md.
