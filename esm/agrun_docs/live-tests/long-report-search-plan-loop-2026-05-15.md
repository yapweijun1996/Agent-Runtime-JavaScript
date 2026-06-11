# Long-Report Search/Plan Loop — Convergence Gap & Fix (2026-05-15)

## Goal

Verify on a node live test (real Gemini API, no browser/IndexedDB layer) that
the 3000-word long-form report flow can actually converge under harness
guards. Prior to this session, only browser smoke
(`examples/browser/test/read-url-live-smoke.mjs --mode=long-report`) and
manual Chrome MCP runs exercised the long-form path, and both required
multi-minute startup. Switching to `test/node-agrun-3000-live.mjs` cuts the
iteration loop and exposes the OODAE decision stream directly to stdout via
`onPlannerDecision` JSON lines.

## Findings

### 35-step search/plan death loop (pre-fix)

Live trace under `gemini-3-flash-preview`, real API, `maxSteps=90`:

```
{"actionName":"list_agent_skills","event":"planner_decision","index":1}
{"actionName":"web_search",         "event":"planner_decision","index":2}
{"actionName":"todo_plan",          "event":"planner_decision","index":3}
{"actionName":"web_search",         "event":"planner_decision","index":5}
{"actionName":"web_search",         "event":"planner_decision","index":6}
{"actionName":"todo_plan",          "event":"planner_decision","index":7}
... (continued web_search ↔ todo_plan exclusively) ...
{"actionName":"todo_plan",          "event":"planner_decision","index":34}
{"actionName":"web_search",         "event":"planner_decision","index":35}
```

35 / 90 step budget consumed. Counters:

| Action | Count |
|---|---|
| `list_agent_skills` | 1 |
| `web_search` | ~16 |
| `todo_plan` | ~14 |
| filtered (planner finalize attempts etc.) | ~4 |
| **`read_url`** | **0** |
| **`workspace_*`** (write / append / replace) | **0** |
| Final candidate words | **0** |

`actionPatternConvergence.stepsWithoutObservableProgress` stayed at 0
throughout — no cooldown / correction signal ever fired.

### Root cause — productive vs transitional progress conflation

`src/runtime/action-pattern-convergence.js` `diffProgress` (pre-fix) treated
every progress dimension as equally valid:

```js
if (after.searchPassCount > before.searchPassCount ||
    after.searchResultUrlCount > before.searchResultUrlCount) {
  dimensions.push("search");
}
if (after.todo.done > before.todo.done ||
    after.todo.completed > before.todo.completed) {
  dimensions.push("todo");
}
// ...
return { dimensions, hasProgress: dimensions.length > 0 };
```

Each `web_search` increased `searchPassCount` / `searchResultUrlCount`. Each
`todo_plan` toggled todo counts. Both pushed `dimensions.length > 0` → 
`hasProgress = true` → `stepsWithoutObservableProgress = 0` → no signal.

Net result: AI could indefinitely alternate `web_search` ↔ `todo_plan`
without ever being told "you are not actually producing the deliverable",
because the harness `progress` metric counted *means* (search, plan) as
equivalent to *product* (workspace candidate, sources read).

This is not a model weakness — gemini-3-flash-preview is not a lite tier.
The same bug would punish any model that takes the visible "progress" feedback
at face value.

## Fix (2026-05-15)

`src/runtime/action-pattern-convergence.js`:

1. **Classify progress dimensions**. `diffProgress` now returns
   `productiveDimensions` (workspace, source) vs `transitionalDimensions`
   (search, todo, memory_or_skill), plus
   `hasProductiveProgress` / `hasTransitionalOnlyProgress` booleans.
   `hasProgress` (the existing union) is preserved for short-task callers.

2. **Mode-aware progress accounting**. `evaluateActionPatternConvergence`
   calls `isLongResearchRun(runState)` (newly exported from
   `research-state.js`) and uses `hasProductiveProgress` as the reset
   criterion for `stepsWithoutObservableProgress` only in long-form mode.
   Short tasks keep the original `hasProgress` semantics.

3. **`transitional_only_progress` convergence signal**. New branch in
   `buildConvergenceSignal`: when long-form mode is active, no productive
   progress has been observed, but transitional dimensions did grow, and
   `stepsWithoutObservableProgress >= 3`, emit a structured signal with
   `forbiddenMove: another_search_or_plan_without_workspace_or_read_url`
   and `allowedNextMoves` including `read_url`, `workspace_write`,
   `workspace_append`, `workspace_replace`. The required-correction text
   explicitly tells the planner that *"search and planning are means, not
   deliverables"*.

4. **`readAllowedNextMoves` long-form variant**. When `longFormMode: true`,
   the move list is seeded with `read_url` + `workspace_*` so the planner
   prompt sees concrete next steps, not just a generic "choose different
   action" string.

## Tests

`test/unit/action-pattern-convergence.test.js` adds three cases:

1. **`transitional_only_progress triggers in long-form mode`** —
   `researchActivation = "long_research"`, three `web_search`/`todo_plan`
   steps with growing `searchPasses`, no workspace growth →
   `convergenceSignal.patternKind === "transitional_only_progress"`,
   `allowedNextMoves` contains `read_url` + `workspace_*`,
   `stepsWithoutObservableProgress >= 3`.
2. **`transitional_only_progress does NOT trigger in short-task mode`** —
   identical action sequence without long-form activation → no signal,
   `stepsWithoutObservableProgress === 0` (transitional counts as progress).
3. **`productive workspace growth resets long-form counter`** — long-form
   mode, two transitional steps, then `workspace_append` with
   `virtualWorkspace.version` bump → counter resets to 0 and no signal
   surfaces. Proves an AI that actually starts writing is not punished.

All three new cases plus the pre-existing 30+ cases pass under
`node test/unit/action-pattern-convergence.test.js`.

`npm test` (full smoke) passes with no regression in any concern suite.

## E2E (post-fix)

Live re-run via `npm run test:live:node-3000` after rebuild + prompt nudge
(`gemini-3-flash-preview`, real API, 90 steps, 12.6 min).

### Comparison vs pre-fix

| Metric | pre-fix (manually stopped at step 35) | post-fix v2 (ran to maxSteps=90) |
|---|---|---|
| `read_agent_skill` engagement | none | step 2 |
| `use_agent_skill` engagement | none | step 3 |
| First `workspace_write` | never (35 steps) | step 5 |
| First `read_url` | never (35 steps) | step 7 |
| `candidateWords` | 0 | **1247** |
| `candidateChars` | 0 | 9000 |
| `hasMeaningfulWorkspaceExpansion` | false | **true** |
| `sourceMinimumPassed` | false | **true** (6/3 reads, 3/2 relevant) |
| `finalCandidateStructureOk` | false (no candidate) | **true** |
| `terminalizedBy` | (loop never converged) | `max_steps_continuation` |
| `terminalRepairState.active` | n/a | true, `activeDeficits: ["length","todo"]` |

### Healthy phase (steps 1-30)

The intended convergence pivot worked. Sequence: `list_agent_skills → read_agent_skill → use_agent_skill → todo_plan → workspace_write → plan → read_url → todo_advance → todo_run_next ...` The earlier search/plan death loop never reappeared.

### Remaining issue — read/inspect micro-loop (steps 31-90)

Steps 31-90 mixed productive `workspace_append` / `workspace_insert_after_section` with heavy `workspace_read` + `todo_inspect` repetition. The candidate grew to 1247 words but did not reach 3000, and the run ended at `workspace_publish_candidate` (step 89) followed by one more `workspace_read` (step 90 = maxSteps). `actionPatternConvergence.cooldownActive` stayed false because each insert/append produced productive growth that reset the original counter.

This `read/inspect → small append → read/inspect` pattern is exactly what the new `readOnlyPlanningState` was added to detect (see `DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS` / `updateReadOnlyPlanningState` in `src/runtime/action-pattern-convergence.js`). The e2e v2 run executed against the older dist build (before `readOnlyPlanningState` landed); a fresh `npm run build:lib` was performed afterwards so the next live re-run will exercise it.

### Acceptance state

- ✅ Search/plan death loop eliminated.
- ✅ AI engages `long-web-research` skill when prompted.
- ✅ Candidate produced with valid structure and source minimum.
- ❌ Length still below requested 3000 words within `maxSteps=90`.
- ❌ Read/inspect micro-loop in mid-run not yet exercised by published dist (fixed in latest source; pending next live re-run).
- ❌ AI did not emit `workspace_publish_candidate` with `decision=limited + remainingGaps` despite the active `terminalRepairState` requiring it.

The runtime convergence guard now sees the problem and surfaces it via `terminalRepairState.activeDeficits = ["length", "todo"]`, but the AI did not act on the limited-publish signal before maxSteps. Next iteration should validate whether the new `readOnlyPlanningState` `requiredCorrection` + `workspace_publish_candidate_limited_with_remainingGaps` in `allowedNextMoves` is enough to flip behavior, or whether the planner prompt needs to project that signal more prominently.

### E2E v3 (with `readOnlyPlanningState` in dist)

`npm run test:live:node-3000`, same prompt, 18 min runtime, `gemini-3-flash-preview`.

| Metric | v1 | v2 | v3 |
|---|---|---|---|
| `candidateWords` | 0 | 1247 | **3347** |
| `candidateChars` | 0 | 9000 | 23561 |
| `decision` | — | — | **`ready`** |
| `lengthSatisfied` | false | null | **true** |
| `evidenceSatisfied` | null | null | **true** |
| `requirementSatisfied` | null | null | **true** |
| `sourceMinimumPassed` | false | true | true |
| `successfulReadUrlCount` | 0 | 0 | 4 |
| `finalCandidateStructureOk` | false | true | false (`duplicate_section_numbers`) |
| `terminalRepairState.active` | n/a | true | false |
| `terminalizedBy` | n/a (stopped manually) | `max_steps_continuation` | `max_steps_continuation` |

The 3000-word target was crossed (3347w) with source minimum, evidence, length, and requirement all satisfied. The AI emitted `workspace_finalize_candidate` (step 58 region) and `finalize` (step 88 region). `terminalRepairState` cleared (no more length/todo deficits).

The run still ended on `max_steps_continuation` because the structure audit detected `duplicate_section_numbers` and the AI spent the last ~30 steps in a `workspace_read` ↔ `workspace_replace` micro-loop trying to repair the duplicated section numbering without succeeding. This is a *different* anti-pattern from the original search/plan loop:

- search/plan death loop (v1): fixed by classifying transitional vs productive dimensions.
- read/inspect micro-loop (v2): partially addressed by `readOnlyPlanningState` advisory signal (v3 emitted it but AI sometimes ignored).
- structure-repair churn (v3 residual): AI knows the structure is broken (`finalCandidateStructureOk: false`, `duplicate_section_numbers`) but can't converge on the textual fix; spends step budget reading + partial replacing without removing the duplicate.

### Acceptance state — running summary (pre-v6)

| Goal | Achieved |
|---|---|
| Eliminate search/plan death loop in long-form reports | ✅ |
| AI engages `long-web-research` skill when prompted | ✅ |
| Convergence signal classifies transitional vs productive progress | ✅ |
| Long-form runs reach `decision: ready` with all four readiness dimensions satisfied | ✅ (v3 once) |
| Run terminates cleanly (no fatal failure) | ❌ pre-v6 — v4/v5 hit ACTION_EXECUTE_ERROR |
| `finalCandidateStructureOk` reaches true after `decision: ready` | ❌ — duplicate_section_numbers persists |

The original AGRUN-236 scope is closed. The residual structure-repair issue is a new follow-up; track separately rather than re-opening this finding.

### E2E v4 and v5 (AGRUN-237 PR 1 stickiness fix)

After shipping `readOnlyPlanningState.escalation` field + workspace-progress stickiness (require 2 consecutive workspace-productive steps to clear an active state; source-progress still clears in one step):

| Metric | v3 | v4 | v5 |
|---|---|---|---|
| `runStatus` | `completed` | **`failed`** | **`failed`** |
| Total steps | 90 | 24 | 51 |
| `candidateWords` | 3347 | 0 | 1570 |
| `candidateChars` | 23561 | 0 | 10873 |
| `decision` | `ready` | `""` | `""` |
| `successfulReadUrlCount` | 4 | 0 | 0 |
| `sourceMinimumPassed` | true | false | **true** (3/3, 3/2) |
| `finalCandidateStructureOk` | false (`duplicate_section_numbers`) | false (`candidate_empty`) | false (`duplicate_section_numbers`) |
| `readOnlyPlanningActive` (final) | n/a (kept clearing) | **true** | **true** |
| `readOnlyPlanningIgnoredCount` | 0 | **5** | 0 |
| `terminalRepairState.active` | false | false | **true** (`length`,`structure`,`todo`) |
| `terminalizedBy` | `max_steps_continuation` | `""` | `""` |
| `runError.code` | n/a | (not captured) | **`ACTION_EXECUTE_ERROR`** |
| `runError.message` | n/a | n/a | `Action "workspace_replace" failed during execution.` |

### AGRUN-237 PR 1 stickiness — verified

`readOnlyPlanningIgnoredCount: 5` in v4 is direct evidence the stickiness fix works: once active, the state stayed active across multiple subsequent forbidden actions (search/plan/read) and the preflight block tallied 5 ignored attempts. Pre-fix (v3) the same pattern would have cleared the state on every productive insert and produced `ignoredCount: 0`.

### New issue surfaced — AGRUN-238

Both v4 and v5 ended on `runStatus: "failed"` not because of stickiness or convergence problems but because of a runtime ergonomics bug: `workspace_replace` throws when its `search` string is no longer in the file (a normal consequence of earlier replaces mutating the content), and the action loop treats the throw as fatal — discarding the entire run state. v5's `runError` field captured the exact message; v4 was the same bug masked by a faster failure (24 steps instead of 51).

This is tracked as a new finding (AGRUN-238) rather than re-opening AGRUN-237. Once `workspace_replace` returns `ok: false` with a structured observation instead of throwing, the AI will be able to react (e.g., switch to `workspace_read` first to refresh its mental model of the current content) and the v3-style ~3300-word ready terminal state should be repeatedly reachable.

## Reference inputs

- Action-pattern source: [src/runtime/action-pattern-convergence.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-pattern-convergence.js)
- Long-research detection (now exported): [src/runtime/research-state.js:445](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-state.js)
- Unit tests: [test/unit/action-pattern-convergence.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/action-pattern-convergence.test.js)
- Live test entry: [test/node-agrun-3000-live.mjs](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/node-agrun-3000-live.mjs) (`npm run test:live:node-3000`)

## HBR

- The fix relies on `isLongResearchRun(runState)` returning true. In the
  unmodified live test, AI did *not* engage `long-web-research` skill
  (it called `list_agent_skills` once but never `read_agent_skill` /
  `use_agent_skill`). The live prompt was therefore updated to explicitly
  instruct skill engagement. A follow-up finding should make the harness
  surface a stronger skill-engagement nudge for long-form prompts, since
  hosts cannot rely on the prompt author to know runtime activation rules.
- E2E acceptance below max_steps still requires both (a) AI to honor the
  new convergence signal, and (b) the upstream skill activation step.
  If the AI ignores the signal, `terminalCorrectionState.ignoredCount`
  will rise, escalating into the existing terminal-correction → cooldown
  pipeline.
- This change does not address weak-model behavior under `gemini-3.1-flash-lite-preview`.
  A separate ADR-0023/0026 lite rerun is required after this lands.

### E2E v6 (AGRUN-238 / ADR-0013 — recoverable tool errors are observations)

Same prompt + `gemini-3-flash-preview` + dist rebuild after AGRUN-238 PR landed.
Runtime: 21.5 min, 90 steps.

| Metric | v5 (pre-ADR-0013) | v6 (post) |
|---|---|---|
| `runStatus` | `failed` ❌ | **`completed`** ✅ |
| `runError` | `ACTION_EXECUTE_ERROR` | **`null`** ✅ |
| `terminalizedBy` | `""` (throw fatal) | **`max_steps_continuation`** (natural) ✅ |
| `candidateChars` | 10873 | **13754** |
| `candidateWords` | 1570 | **1973** |
| `hasMeaningfulWorkspaceExpansion` | true | true |
| `decision` | `""` | `""` (AI did not self-declare ready/limited) |
| `successfulReadUrlCount` | 0 | 0 (readurl service 502 — external) |
| `sourceMinimumPassed` | true | false (only 1/3 reads, readurl down) |
| `finalCandidateStructureOk` | false | false (`duplicate_section_numbers`) |
| `terminalRepairState.activeDeficits` | `["length","structure","todo"]` | `["source","length","structure","todo"]` |

**AGRUN-238 / ADR-0013 acceptance — ALL PASS**:
- ✅ `runStatus === "failed"` no longer fires from action errors (v5 root symptom gone).
- ✅ `runError === null` (no `ACTION_EXECUTE_ERROR` recorded).
- ✅ Run reaches natural maxSteps termination instead of throw fatal.
- ✅ AI produced 1973 words across 90 mutating steps without the harness crashing — direct proof that workspace mutator throws are now observations.
- ✅ `runState.failedTools`, planner prompt, and convergence signal continue functioning (verified via 5 new unit tests + smoke regression).

Residuals (out of AGRUN-238 scope, tracked separately):
- `decision === ""` — AI did not voluntarily emit `workspace_publish_candidate` with `limited` despite `terminalRepairState.active=true`. This is the structureRepair / readiness-decision convergence (AGRUN-237 PR2) follow-up.
- `successfulReadUrlCount: 0` — readurl service returned 502 during this run; external infra blip, not in repo scope.
- `duplicate_section_numbers` structure deficit — AGRUN-237 PR2 structure-repair signal target.

### Final acceptance state — across v1 → v6

| Goal | Achieved |
|---|---|
| Eliminate search/plan death loop in long-form reports | ✅ |
| AI engages `long-web-research` skill when prompted | ✅ |
| Convergence signals classify productive vs transitional vs read-only-planning vs structure-repair | ✅ |
| Long-form runs reach `decision: ready` (v3 baseline) | ✅ once, ⚠️ not yet repeatable on every run |
| Run never fails fatally on workspace mutator errors (AGRUN-238 / ADR-0013) | ✅ proven by v6 |
| Run terminates cleanly without throw fatal | ✅ (maxSteps is acceptable termination) |
| `finalCandidateStructureOk: true` post-publish | ❌ — AGRUN-237 PR2 + model-quality follow-up |
