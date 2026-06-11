# AGRUN-306 — gpt-5.4-mini-low terminal-repair / publish non-convergence (investigation)

Date: 2026-06-05
Type: investigation (NOT a regression report)
Status: root cause OPEN — blocked on inspector reason-capture
Related: AGRUN-305 (014bd575, the ready-publish loop fix), AGRUN-300/301 (terminal-repair)
Evidence: `test/benchmark-out4/` (research-report benchmark #3), `test/benchmark-out-tno/` (16-run TNO batch, in progress)

## Summary

Across three independent live runs and two different long-report tasks, **gpt-5.4-mini at `reasoning_effort: low` fails to converge** on the publish/terminal-repair path — burning 30–47 minutes and millions of tokens — even though the AGRUN-305 fix is present in the build and the runs do eventually publish. This is a **sibling non-convergence AGRUN-305 did not cover**, not a regression of the bug it fixed.

## Cross-run evidence (same model + same knob)

| Run | Task | Time | Cost | calls | steps |
|---|---|---:|---:|---:|---:|
| benchmark #2 | in-browser-LLM report | 6.7 min | $0.557 | — | — |
| benchmark #3 | in-browser-LLM report | 29.93 min | $2.008 | 125 | 2639 |
| TNO batch | Globe3/TNO report | 46.86 min | $3.526 | 234 | 5122 |

Same model, same `low` knob, **4.5–7× variance** in time/cost. By contrast, in the same TNO batch:

| gpt-5.4-mini knob | Time | Cost | calls | steps |
|---|---:|---:|---:|---:|
| low | 46.86 min | $3.526 | 234 | 5122 |
| medium | 10.39 min | $0.757 | 47 | 1144 |
| **high** | **9.62 min** | **$0.526** | **24** | **620** |
| xhigh | 36.58 min | $1.249 | 25 | 657 |

**Counter-intuitive finding: `low` is the SLOWEST and MOST EXPENSIVE** — low reasoning causes the agent to churn instead of converge. `high` converges cleanly with a direct publish. This contradicts benchmark-3's "production default = gpt-5.4-mini low" recommendation; the data favors **`high`** for this workload.

## Loop shape (benchmark-3 gpt-low progress JSONL)

Parsed from `test/benchmark-out-tno/progress-openai-gpt-5.4-mini-low.jsonl` (6052 events, 213 cycles):

- `terminal-repair-state-refreshed` ×**504** ← the dominant churn engine (an order of magnitude above all else)
- `workspace-publish-path-required` ×34 ← downstream symptom, not root
- `workspace-publish-candidate-gated` ×4 ← model only attempted publish 4 times
- `terminal-repair-direct-terminal-blocked` ×13
- `action-fingerprint-repeat` ×11, `action-pattern-repeat-blocked` ×3 ← runtime detected repeats but did not terminalize
- non-convergence window: event 729→3304 (11:06:54→11:36:37) ≈ **30 minutes** of one 46-min run

The earlier framing ("34 publish-path-required = the problem") was an anchoring error. The engine is **terminal-repair-state (504×)**; publish-path-required is a tail symptom.

## Why "regression" is the wrong word

1. The AGRUN-305 fix IS in the tested build (dist/agrun.js clean vs 014bd575; the commit modified dist + virtual-workspace-actions.js + planner-action-surface.js).
2. AGRUN-305 fixed a *ready-candidate-not-publishing* finalize/review loop. This run **did publish** (status completed, 3395 words) — the old bug did not return.
3. What remains is convergence *speed* on the terminal-repair path — related but distinct.

Honest statement: *the fix is present, yet gpt-5.4-mini-low still exhibits a severe terminal-repair/publish non-convergence (~30 min, 504 repair-state refreshes) for this workload.*

## Root cause: OPEN (telemetry is reason-blind)

The progress JSONL events carry **no reason field** — `control`, `status`, `actionName` are all null on the gated/blocked events. No stepType names the blocking condition (no `source`/`length`/`structure`/`duplicate` token). So from current telemetry it is impossible to distinguish:

- (a) a legit gate failure (source minimum / structure duplication / blocked cited source — the same failure family as the Gemini AGRUN-300/301 runs), vs
- (b) a mechanical oscillation (runtime re-refreshing repair-state without advancing).

Length is excluded: gpt-low produced 3395 words > gpt-high's 3163, so the block is not under-length.

**You cannot diagnose root cause from data that cannot show the cause.** This is the concrete basis for the inspector reason-capture ask.

## Asks (priority order)

1. **[unblocker] Inspector reason-capture.** `terminal-repair-state-refreshed` / `workspace-publish-path-required` / `*-gated` / `direct-terminal-blocked` must carry a redacted reason (which gate, which readiness contract, what mechanical field is missing). The new `test/live-observe.mjs` harness already captures the **fetch boundary** (llm_request/llm_response), which is the model-side half; the runtime-side half (why the gate fired) still needs to be emitted on the SSOT event stream. See `agrun_docs/live-observe-harness.md`.
2. Re-run gpt-5.4-mini-low with reason fields, locate which contract the 504 refreshes loop on.
3. Deterministic terminal-repair cap: after N `terminal-repair-state-refreshed` with no material candidate improvement → force terminal `limited`/`fail`. (Mature agents bound every loop — OpenHands `_is_stuck`, open_deep_research `max_*_iterations`; see `agrun_docs/open-source-agent-projects-study.md`.)
4. Enforce `timeoutMs` as a runtime hard-stop (the TNO batch only stopped DeepSeek flash low/medium via external SIGTERM at 47 min, losing final metrics).

## Production recommendation (interim)

For trusted long reports, prefer **gpt-5.4-mini `high`** (fastest + cheapest + clean publish in the TNO batch), not `low`. Revisit once the terminal-repair cap (ask #3) lands.

## TODO (owner of task.jsonl)

Add a formal AGRUN-306 entry to `task.jsonl` / `task.md` mirroring this investigation. (Not added here to avoid colliding with the concurrent benchmark agent editing those files.)
