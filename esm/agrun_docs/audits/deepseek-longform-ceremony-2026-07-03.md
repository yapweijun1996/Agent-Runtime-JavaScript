# Why deepseek burns 15 steps on a plain 1500-word article (AGRUN-588)

**Verdict first**: this is NOT text degeneration and NOT an infinite loop. The
2026-07-03 bench outlier (220 s, 396-char "answer") was agrun's **max-steps
long-run pause message** being mistaken for an answer by the bench harness.
Underneath it, deepseek-v4-flash chooses the ceremony-heavy todo+workspace
authoring route for a plain writing task and executes it inefficiently, so 15
steps run out before publish. openai/gemini answer the same prompt in 1 call.

## Evidence (4 live probe runs, dist bundle, maxSteps=15)

| Run | Outcome | Wall | Words |
|---|---|---|---|
| probe iter 0 | finalize on step 15 (just made it) | 171 s | 1678 |
| probe iter 1 | max_steps_continuation pause | 283 s | pause msg |
| probe iter 2 | max_steps_continuation pause | 304 s | pause msg |
| guard probe | max_steps_continuation pause | 268 s | pause msg |

Step budget breakdown of the failing pattern (guard probe run):

1. **4 consecutive `plan-validation-failed` → `plan-validation-rejected`**
   (at 4.8 s / 10.8 s / 17 s / 23 s) — deepseek's native parallel tool batches
   (C3b) were rejected by plan validation four times in a row, each followed
   by a `todo_plan` retry. ~4 of 15 steps burned before any content existed.
   Rejection code captured live: **`skill_mutator_in_plan`** — the batch was
   `["todo_advance","todo_advance"]`. todo/workspace mutators are
   standalone-only (`plan: STANDALONE_PLAN_ACTION`), so ANY parallel batch
   containing them was a guaranteed rejection: the C3b batch reader excluded
   only terminals, not standalone-only actions — a contract mismatch between
   `readParallelActionBatch` and plan validation.
2. **Bookkeeping tax** — todo_plan re-planning (2-3×), `list_agent_skills`
   lookups, `todo_advance`/`todo_run_next` sync steps. In the SUCCESSFUL
   iter 0, only 2 of 15 steps produced content.
3. **Slow content steps** — each `workspace_propose_patch` call takes 25-50 s
   of deepseek generation, and 3 calls across the probe set were
   `action-args-invalid` (missing required fields), each wasting a full
   model round.
4. **Convergence guards silent** — `action-pattern-convergence-refreshed`
   never fired across the whole run: the read-only-planning guard never
   surfaced an advisory despite repeated planning without content progress.
   (The guard's productive-progress model counts todo mutations as progress,
   so the ceremony never looks stalled to it.)

## What was fixed today

- **Guaranteed-rejection batches** (`src/runtime/planner-tools.js` +
  `planner.js`): the native batch reader now derives a standalone-only
  exclusion set from the SAME plan-contract SSOT the validator uses
  (`readPlanActionContract`). A parallel batch containing todo/workspace
  mutators falls back to first-call-decides — the first mutator executes
  standalone (valid), instead of the whole batch burning a cycle on
  `skill_mutator_in_plan`. Unit-tested in
  `test/unit/planner-native-parallel-batch.test.js`.
- **Denied tools removed from the model surface**
  (`src/runtime/planner-action-surface.js`): re-running the probe on the
  first fix exposed a second guaranteed-rejection family — deepseek batched
  `[web_search, web_search]` while web_search was policy `"deny"`, burning 3
  cycles on `action_policy_denied_in_plan`. A static "deny" (explicit or
  tier-3 inferred) is final — the permission judge can only escalate
  "allow" — so `selectPlannerActions` now filters those actions out of the
  planner catalog entirely (both envelope and native doors share this exit).
  "ask" actions stay visible (approval can grant them); execution-side policy
  checks stay (a model can still hallucinate an unoffered tool name).
- **Bench false-OK** (`examples/agent-sdk-benchmark/`): a run whose
  `output.kind === "continuation_required"` is now flagged
  `**PAUSED (max-steps continuation, not an answer)**` and marked
  `incomplete` — it previously passed as OK because the runtime reports the
  pause with `status: "completed"` (signal lives in `output.kind` /
  `runState.finalAnswerSource === "continuation_required"` /
  `terminalizedBy === "max_steps_continuation"`).

## Follow-ups — RESOLVED same day (AGRUN-589 / AGRUN-590)

1. **Directive nudge (AGRUN-589, SHIPPED)**: the workspace-authoring directive
   (both native and envelope copies) now says a deliverable that fits in ONE
   response — "even a long, multi-section one, like a ~1500-word article from
   knowledge you already have" — should be answered directly; workspace
   authoring is for genuinely multi-turn work (evidence integration, revision
   across steps, self-review). A/B on the same article prompt: deepseek went
   from 3/4 paused-at-15-steps to **3/3 direct planner_final (1 planner call,
   0 actions, 34-73 s, 1326-2239 words)**; openai unchanged (23 s direct).
   gemini flash-lite kept choosing the ceremony route (3/3 runs, 13-15
   calls) — but the CONTROL (old directive, n=2) was WORSE: both control runs
   burned all 15 steps into budget_exhaustion_salvage, while under the new
   directive 2/3 finalize normally within budget. Ceremony preference is
   pre-existing flash-lite behavior, not a regression; the nudge mildly
   improves its completion health too. Research flows are protected by the
   existing "follow the skill's SKILL.md over native planner defaults"
   directive.
2. **Guard coverage (AGRUN-590, SHIPPED)**: the plan-validation-failure path
   now refreshes the action-pattern convergence evaluator with a blocked
   outcome (mirroring the session-loop web_search_repeat_blocked precedent),
   so consecutive rejections accumulate `stepsWithoutObservableProgress` and
   the normal advisory → hard_veto ladder can engage. The other suspected
   blind spot — repeated `todo_plan` re-planning — turned out NOT to be one:
   `diffProgress` only counts the todo dimension when done/completed
   increases, so re-planning already accumulates; the guard was blind solely
   because rejections never reached the evaluator.

## Provenance

Probe scripts + JSONL step traces: session scratchpad `probe-deepseek-long*.mjs`,
`probe-deepseek-guard*.jsonl` (2026-07-03). Bench rows:
`examples/agent-sdk-benchmark/bench-multi-provider-results.2026-07-03T01-48-59-131Z.json`.
