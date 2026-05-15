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

### Acceptance state — final

| Goal | Achieved |
|---|---|
| Eliminate search/plan death loop in long-form reports | ✅ |
| AI engages `long-web-research` skill when prompted | ✅ |
| Convergence signal classifies transitional vs productive progress | ✅ |
| Long-form runs reach `decision: ready` with all four readiness dimensions satisfied | ✅ (v3) |
| Run terminates cleanly (no `max_steps` / `max_steps_continuation`) | ❌ — structure-repair micro-loop remains |
| `finalCandidateStructureOk` reaches true after `decision: ready` | ❌ — duplicate_section_numbers persists |

The original AGRUN-236 scope is closed. The residual structure-repair issue is a new follow-up; track separately rather than re-opening this finding.

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
