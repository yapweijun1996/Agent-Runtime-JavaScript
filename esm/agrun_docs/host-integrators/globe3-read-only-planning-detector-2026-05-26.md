# Reply to Globe3 — `read_only_planning_with_observable_deficits` detector (separate from AGRUN-256)

Subject: Re: Follow-up — read_only_planning_with_observable_deficits terminal_repair trigger (separate from publish_candidate gate)

---

Thanks for the clean separation in your subject line — and for the trust on the publish_candidate framing. You're right that this is a separate thread; let's not confuse the two.

## Direct answer to your Q1

**No, AGRUN-256 does not touch the `read_only_planning_with_observable_deficits` detector.** The bundle you'll receive modifies only the planner action surface filter and a per-decision runtime guard for `workspace_publish_candidate` (commits `77b4189dd` + `43ef84915` + `f56593b75`). The detector you're hitting lives in `src/runtime/action-pattern-convergence.js` + `src/runtime/action-pattern-progress.js` + `src/runtime/terminal-repair-state.js`, and those files are unchanged in this bundle.

So the AGRUN-256 ship will not make this failure better or worse — it is its own bug.

## Where the failure is coming from (our read of the code path)

We have not seen your runState yet (please send — see end), but the static-read diagnosis based on your symptom description:

**1. The "read-only planning" classification is action-name based, not result-based.**

`DEFAULT_READ_ONLY_PLANNING_FORBIDDEN_ACTIONS` (in `action-pattern-convergence.js:33`) lists nine action names. For a tool-loop ERP host like Globe3, the relevant ones are:

```js
"list_agent_skills",
"read_agent_skill",
"use_agent_skill",
"execute_skill_tool"
```

**Every step that calls your ERP tool via the bundled skill flow is classified as "read-only planning" regardless of whether the tool returned 200 + real data.** A successful `execute_skill_tool` that fetches inventory rows from your ERP is, to this detector, indistinguishable from a `workspace_list` that returns an empty listing.

**2. The `PRODUCTIVE_PROGRESS_DIMENSIONS` whitelist is narrow.**

`action-pattern-progress.js:1`:

```js
const PRODUCTIVE_PROGRESS_DIMENSIONS = ["workspace", "source"];
```

Only two things clear the read-only-planning state:
- **workspace** = candidate text grew (chars/words/cjkChars increased) OR workspace version grew without an active length deficit.
- **source** = `successfulReadUrlCount` grew, OR `readSourceUrlCount` grew, OR `relevantSourceCount` grew, OR `sourceMinimumPassed` flipped to true.

A successful `execute_skill_tool` adds a `toolHistoryCount` (line 29) and a `memory_or_skill` dimension (line 67), but **neither is in the productive whitelist**. So the detector does not recognize "you just successfully called the ERP and got rows back" as progress.

**3. Threshold and escalation values.**

- `TRANSITIONAL_ONLY_THRESHOLD = 3` (line 18) — 3 read-only-planning actions without a productive dimension activates the state.
- `READ_ONLY_PLANNING_HARD_VETO_THRESHOLD = 3` (line 19) — once active, 3 more read-only actions ignore the advisory and escalate to `hard_veto`.
- `READ_ONLY_PLANNING_CLEAR_THRESHOLD = 2` (line 20) — when active, **workspace-only** productive progress requires 2 consecutive productive steps to clear (source progress clears immediately).

For a Globe3-shape tool-call sequence:

```
list_agent_skills → use_agent_skill → execute_skill_tool
       (1)               (2)                  (3)
```

At step 3 the threshold is hit, and even though `execute_skill_tool` returned real ERP rows, the detector activates `read_only_planning_with_observable_deficits` with `forbiddenDecisions: ['finalize']`. The planner then can't finalize → hard_veto loop → maxSteps or your host circuit breaker.

## Direct answers to your three sub-questions

**(a) Does AGRUN-256 tighten the threshold (e.g. >2 read-only ops)?**
No. The threshold stays at 3, unchanged.

**(b) Does it consider tool success (200 + non-empty result) as productive progress?**
No. The whitelist is still `["workspace", "source"]`. This is the design gap your bundle is hitting.

**(c) What's the recommended host-side mitigation while we wait?**

Honest answer: **there is no config-level opt-out for this detector.** `runtimeConfig` does not currently expose `actionPatternConvergence` parameters; `PRODUCTIVE_PROGRESS_DIMENSIONS` and the thresholds are module-level constants. So there is nothing as clean as the `publishCandidateGate: { enabled: false }` knob we just landed.

Two ugly options that exist today, neither of which we recommend long-term:

1. **Stuff a workspace_write between consecutive read-only actions.** Have your planner directive instruct: "After any successful tool result, write a one-line acknowledgement to workspace_write before finalizing." This produces a `workspace` productive dimension. **Caveat:** if the same content is written twice, the second write may produce `workspace_churn` instead of `workspace` (line 60), so write distinct content (e.g. include the tool result summary in the line). This is exactly the kind of fabrication-to-pass-a-precondition we warned against in the AGRUN-256 write-up; it works but it is a band-aid.

2. **Increase your host's `maxSteps`.** Doesn't fix the loop, just delays the timeout. Not a real mitigation.

Both are workarounds, not solutions. The real fix is detector-side.

## What we'd like to do

We'd like to track this as a separate ticket: **AGRUN-263**. Two concrete code changes we're scoping:

1. **Recognize new successful tool results as a productive dimension.** Add a `tool_result` dimension when `toolHistoryCount` grows AND the new entry is not a duplicate of a recent entry (action name + serialized args fingerprint within the last N steps). The dedup is important — the AGRUN-256 trap was a planner gaming a structural signal, and we don't want to add a productive dimension that the same planner can game by re-calling the same tool with the same args.
2. **Make the productive-dimensions whitelist configurable via `runtimeConfig`.** So a host who knows their workload (e.g. Globe3 — tool-loop ERP, no long-form drafting) can declare `productiveProgressDimensions: ["workspace", "source", "tool_result"]` explicitly. This avoids us imposing the choice on long-form research hosts where adding `tool_result` could mask real read-only loops.

We have not implemented either yet, and we have not reproduced your failure shape in our test suite — our unit tests cover the detector on synthetic action sequences but not on a Globe3-shape `list_agent_skills → use_agent_skill → execute_skill_tool` flow with a successful tool result.

## What we need from you

Please send the runState fields you offered, for **both** jobs:

- `terminalRepairState.activatedBy`
- `terminalRepairState.forbiddenDecisions`
- `terminalRepairState.activeDeficits`
- `plannerHistory[].action` (or full action sequence — first 20 + last 20 if very long)
- `toolHistory[]` with `name`, `args` (or a hash if sensitive), `success` flag, byte length of result
- `stepCount`
- `actionPatternConvergence.readOnlyPlanning.stepsWithoutProductiveProgress` at the moment of activation
- `actionPatternConvergence.readOnlyPlanning.consecutiveProductiveSteps` at the moment of activation

The fields we're most interested in: **did `workspace_write` actually grow workspace.version, or was it idempotent?** Our static read predicts your sequence trips the detector at the `execute_skill_tool` step (item 3 above), but you mentioned `workspace_write twice` was in the sequence, and that should have produced a `workspace` productive dimension. We need to know whether the writes happened *before* the threshold was hit (and got reset by subsequent read-only actions, line 710-712 — the planning-action-resets-productive-streak rule), or *after* terminal_repair already locked finalize. The runState dump tells us which.

## Honest caveats (HBR)

- **We have not reproduced your failure pattern yet.** Our diagnosis is static-read of the code, not a live run. If your runState reveals a different shape, we will revise.
- **The `tool_result` dimension fix has a real risk.** Naive implementations let the planner call the same tool repeatedly to defeat the detector — exactly the structural-signal-gaming pattern we just closed in AGRUN-256. The dedup-by-args fingerprint mitigates this, but only if `toolContext.history` actually preserves args (it does today — `cloneValue(actionResult.output)` is stamped, but we'd need to verify the args side too). This needs to be designed carefully.
- **Config-surface expansion is not free.** Adding `productiveProgressDimensions` to `runtimeConfig` means another knob hosts can misconfigure (e.g. a long-form research host with `productiveProgressDimensions: ["tool_result"]` would defeat the detector entirely for their workload). We are weighing this trade-off.

## Side note on observability

Your offer to dump those eight runState fields is, again, exactly the diagnostic surface we want hosts to use. If you can add `actionPatternConvergence.readOnlyPlanning.activatedAtCycle` and `actionPatternConvergence.readOnlyPlanning.ignoredCount` to your host's failure-log payload, you'll have everything to localize this kind of detector trip without us asking next time.

— agrun.js team

(Ticket: AGRUN-263 — `read_only_planning_with_observable_deficits` blind spot for tool-loop hosts.)
