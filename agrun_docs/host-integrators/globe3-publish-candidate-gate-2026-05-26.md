# Reply to Globe3 — `workspace_publish_candidate` Mode Gate (AGRUN-256)

Subject: Re: Feature Request — Mode-Gate workspace_publish_candidate (your 2026-05-26 email)

---

Thanks for the detailed write-up — runState dump + before/after job IDs + line references made this trivial to diagnose and ship the same day. The diagnosis is exactly right: `workspace_publish_candidate` was a designed terminal action for `mode: 'long_research'`, and without a mode gate any envelope-mode planner could treat it as a generic "give up" escape. Your `disabledActions` + paired planner-directive workaround caught both halves of the trap (host catalog AND the resulting planner-invalid loop).

## What shipped

We took your Option 2 (structural invariant), with a small refinement after auditing the code path:

- The structural signal is **mode (long_research-shape), not workspace mutation count**. Mutation count fails as a gate because a planner incentivized to publish will fabricate workspace content to pass the precondition — exactly the failure mode you observed.
- The gate hides `workspace_publish_candidate` from the planner action surface when ALL of the following hold:
  1. `runtimeConfig.publishCandidateGate.enabled !== false` (default on),
  2. `runState.terminalRepairState.active !== true` — the repair surface owns the action when it is active, and its `allowedActions` list is authoritative,
  3. `isLongResearchRun(runState) === false` — i.e. no `researchActivation === "long_research"` AND no active/selected/last-read long-research skill (`deep-research-writer`, `long-web-research`).
- A **per-decision runtime guard** in `action-loop-session-loop.js` catches hallucinated emissions (planner names the action despite the catalog hiding it). It routes through the existing `handleInvalidPlannerDecision` pipeline so `runState.plannerInvalidSignal` is set with a helpful detail — your "use finalize instead" directive is now the runtime default rather than a host concern. This is the half your post-workaround note flagged ("disabling alone causes the planner to loop on planner-invalid-action until maxSteps").
- `runtimeConfig.publishCandidateGate.enabled = false` is the host opt-out for any deployment that intentionally publishes-direct outside `long_research`.

The gate detail string the planner sees on rejection is:

> workspace_publish_candidate is reserved for long_research mode (skill activation such as deep-research-writer / long-web-research, or `mode: "long_research"` declared on the plan envelope). End this turn with a finalize envelope to deliver the answer through the runtime finalizer. If your host intentionally needs publish-direct outside long_research, set runtimeConfig.publishCandidateGate.enabled=false.

## Migration for Globe3

Once you pick up the next agrun bundle:

```js
// BEFORE (your 2026-05-26 workaround):
disabledActions: [
  'read_url', 'web_search',
  'todo_plan', 'todo_advance', 'todo_cancel', 'todo_run_next', 'todo_inspect',
  'workspace_publish_candidate'   // ← can drop this
]
// AFTER:
disabledActions: [
  'read_url', 'web_search',
  'todo_plan', 'todo_advance', 'todo_cancel', 'todo_run_next', 'todo_inspect'
]
```

Your paired planner directive can also be removed — the runtime now emits the equivalent message via `plannerInvalidSignal` on its own.

Expected behavior on the canonical reproducer ("What is our current stock level for the most popular items?"):
- `finalAnswerSource === "planner_finalize"`, NOT `"workspace_publish_candidate"`,
- step ledger contains either `planner-repair-requested` (catalog-aware path) or `workspace-publish-candidate-gated` (runtime-guard backstop), with the same detail string,
- token usage is non-zero (audit pipelines key on `tokens > 0` should fire normally),
- duration / stepCount match the post-workaround envelope (8–14s, 48–113 steps), not the pre-workaround maxSteps continuation.

## On your secondary and tertiary asks

- **Secondary (`onStep` WARN when publish runs in a structurally suspect state):** The gate makes this unreachable on the suspect-state path — if there were zero workspace writes, the action is hidden, so it cannot fire. Inside `long_research` the action is the documented terminal action, so a WARN there would be noisy. We did not add a separate WARN event; the `workspace-publish-candidate-gated` step covers the host-observability requirement.
- **Tertiary (`usage.skippedReason` for `usedRuntimeFinalize=false` paths):** Not in this change. It is an independent improvement and we have it backlogged. If your audit pipelines need to keep keying on `tokens > 0`, the workaround for now is to filter on `finalAnswerSource === "workspace_publish_candidate"` instead of `tokens > 0`; the gate ensures this only happens on intentional long_research publishes.

## Honest caveats (HBR)

- **Long Task Lab live e2e for the deep-research-writer path was not rerun for this change.** Unit tests prove the catalog filter exposes the action when `deep-research-writer` is the active skill, but a full 3000-word long_research live run remains a recommended follow-up before we declare full regression coverage.
- **The per-decision runtime guard is verified at the unit-test layer only.** Our integration test exercises the planner-repair convergence path (catalog filter hides the name → repair → finalize) because our mocked-fetch fixture respects the catalog. If your real Gemini Flash-Lite emits `workspace_publish_candidate` despite the catalog (which it might, lite-tier hallucination is well documented in our KB), the runtime guard kicks in and you should see the `workspace-publish-candidate-gated` step in the ledger. Please share a runState dump if you observe behavior that does not match.

## Acknowledgements

Two specific things about your report made this fast:

1. The runState dump (`terminalRepairState.active`, `terminalizedBy`, `usedRuntimeFinalize`, `tokens`, line-numbered source references) ruled out alternative hypotheses inside one read pass.
2. You filed this as a **feature request, not a bug**, and explicitly described why the action's existing behavior is correct for the long_research workflow it was designed for. That framing led us to a gate (host-friendlier defaults) rather than a behavior change (which would have regressed real long_research hosts).

Side note: the runState introspection surface you used (`terminalRepairState`, `finalAnswerSource`, `terminalizedBy`, `stepCount`) is exactly what we want hosts to grow into. If there is anything additional you want exposed for diagnostics, send a list and we will scope it.

Ticket: AGRUN-256. Verification: `npm test` 1086 PASS / 0 FAIL, `npm run build` PASS. Docs in `agrun_docs/feature-toggles.md` under "Publish Candidate Mode Gate". KB write-up in production-agent-harness-for-agrun-js (item id be30dcb9-3392-4142-9fd4-9706cbe0ff68).

— agrun.js team
