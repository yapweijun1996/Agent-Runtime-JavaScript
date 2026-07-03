# Node live-test findings — 2026-06-25 (short-tier 4-provider matrix)

Bundle: `dist/agrun.js` (built from `src/`, includes AGRUN-549).
Harness: `node test/live-standard.mjs --tier short` (real API keys via `.env.local`).
Task per cell: "find Node LTS + codename via web_search/read_url, ~150-word cited answer".

## Scorecard

| model | status | qScore | words | $cost | min | billed calls | max input tok / call | terminal-blocked | workspace_write |
|---|---|---|---|---|---|---|---|---|---|
| gemini-3.1-flash-lite low | ✅ completed | 75 | 160 | **$0.0099** | **0.26** | 4 | 33k | 0 | ✅ ×1 |
| deepseek-v4-flash default | ✅ completed | 75 | 171 | $0.025 | 4.64 | 16 | 210k | 1 | ✅ ×4 |
| openai gpt-5.4-mini low | ✅ completed | 75 | 159 | **$0.167** | 1.66 | 23 | 280k | 5 | ✅ ×1 |
| deepseek-v4-flash **high** | ❌ **failed** | 0 | **0** | $0.023 | **5.06** (deadline) | 31 | 318k | **22** | ❌ **0** |

gemini was the clear winner (4 calls, 15s, $0.01). This matches the standing
production recommendation (gemini-flash low for this task class).

---

## Issue 1 (P1) — Terminal-repair livelock → EMPTY output, on the "no-candidate / direct-finalize" path

**Symptom.** `deepseek-v4-flash` at `reasoningEffort:high` on a 150-word task ran
**31 provider calls / 572 OODAE steps**, chose `finalize` and got
`terminal-repair-direct-terminal-blocked` (control=`blocked`,
reason=`terminal_repair_blocked`) **22 times in a row**, then hit
`terminal_run_deadline` (5 min) and returned **0 words / qScore 0**. A production
browser chatbot on this model would show a 5-minute spinner → blank.

**Mechanism.** The model's `read_url` calls mostly failed (CORS / "thin"
nodejs.org pages; only the githubusercontent schedule.json read ok), so the
**source deficit was never satisfied** → terminal-repair stayed active → a direct
`finalize` is (correctly) blocked because the terminal contract requires
write-to-workspace-then-publish (or a valid `limited` publish). But the model
**never did a single `workspace_write`** — it kept re-issuing plain `finalize`.
The runtime escalates the block message to a `HARD VETO` string, but there is **no
hard circuit-breaker**: 22 identical vetoes, no forced salvage, no early abort →
deadline → empty.

**Why AGRUN-548 does NOT cover this.** AGRUN-548 (2026-06-18) fixed the *sibling*
livelock where the model HAS written a 100/100 candidate but the review→publish
handshake keeps going stale. Its `candidate_publish_readiness` observation only
renders **when the mechanical gates all pass (length+structure+source) and the
only blockers are handshake codes** — i.e. a candidate exists. Today's failure has
**no candidate at all** (length/structure/source all false), so the AGRUN-548
observation's precondition is not met and it never fires. This is the same family,
a different precondition: **empty-workspace + repeated direct-finalize**.

This is also a **repeat**: the 2026-06-10 matrix already recorded deepseek-high
blowing the short-tier 5-min deadline (5.29 min). Today it degraded further (full
livelock to empty output) and the mechanism is now characterized.

**Fix shape (AI-first, both doors).** When terminal-repair is active AND no
workspace candidate exists AND direct-finalize has been blocked K times, surface a
**fact-only observation** (mirroring AGRUN-548's pattern, NOT a forced action):
"no workspace candidate exists; a direct finalize cannot pass terminal repair; a
limited `workspace_publish_candidate` with decision=limited is valid when reads
failed." If the model still ignores it past a hard K, deterministically **salvage**
(wrap the planner's last drafted answer text into a `limited` publish) so the run
**never returns empty after the deadline**. Render at the single path-agnostic
prompt-block point so both dispatch doors are covered (per Dispatch-Path Parity).

### Root cause (confirmed) — `ignoredCount` pinned at 0 by an active-oscillation

The live trace settled it: all 22 blocks carried `ignoredCount: 0` /
`escalation: advisory`, and there was **no** `terminal-repair-state-refreshed`
step. So escalation **never reached `hard_veto`** and none of the existing escape
valves (all hard_veto-gated) could fire. Mechanism: the `before_planner` refresh
**clears** `terminalRepairState` (`active:false`, snapshot preserved) and the
`onResponse` refresh **reactivates** it via `forceActive`. But `ignoredTerminal`
— and therefore both `ignoredCount` and the run-level `cumulativeIgnoredCount`
(the AGRUN-307 safety net) — gate on `previous.active === true`, which the
oscillation flips to `false` at the exact `onResponse` cycle the finalize is
suppressed. A blocked terminal is **never counted**, so escalation never advances.
Even if it had: `sourceUnresolvable` needs 0 successful reads (deepseek had ≥1)
and `publishLoop`/`candidateQuality` need a drafted candidate (deepseek had none),
so the "≥1 read + no candidate" corner had **no exit**. AGRUN-548 does not cover
it (its readiness observation requires a candidate to exist).

### Fix (implemented) — AGRUN-550, both doors

1. `src/runtime/terminal-repair/core.js` — feed `cumulativeIgnoredCount` from a
   `suppressedTerminalThisCycle` signal keyed on `shouldActivate` (not
   `previous.active`), so the active-oscillation can no longer pin it at 0; it
   climbs to `absoluteIgnoredCap` (8) → `hard_veto`.
2. `core.js` — new escape `terminalThrashUnresolvable` = `hard_veto` + **no
   candidate content** + no other escape → opens `final`/`finalize` (mirrors
   `sourceUnresolvable`; there is no candidate to publish) and sets
   `terminalThrashEscapeGranted`.
3. `src/runtime/hooks/terminal-repair-hook.js` — the `onResponse` door now honors
   the finalize escapes (`sourceDeficitEscapeGranted || candidateQualityUnresolvable
   || terminalThrashEscapeGranted`) and returns without blocking, emitting
   `terminal-repair-finalize-escape-granted`. It previously gated purely on
   `repair.active`, silently ignoring the escapes — a Dispatch-Path Parity gap
   (final/finalize decisions arrive only here; the action door already honors the
   escape via `allowedActions`). `core.js` is shared by both doors.

**Verification.** `test/unit/agrun-550-terminal-thrash-escape.test.js` 4/4 PASS
(counting climbs across the oscillation; escape fires by the cap; the hook stops
blocking — livelock broken; no over-fire when a candidate exists). Full smoke
suite green. Live (4 deepseek-v4-flash high short runs, high-variance model):
- **repro-2 = the live proof**: entered terminal-repair (**7 blocks**), the new
  escape **fired** (`terminal-repair-finalize-escape-granted` × 1), and the run
  **completed 120 words** instead of thrashing to empty.
- re-run + repro-3: completed (153 / 137 words) via natural convergence (never
  entered the loop) — no-regression signal.
- **repro-1: a DIFFERENT failure** (see AGRUN-551 below) — still 0 words / deadline,
  but via the invalid-action-convergence path, not the terminal-thrash livelock.

### Sibling finding (AGRUN-551, open) — invalid-action-convergence livelock

repro-1 surfaced a distinct mechanism with the **same symptom** (empty output on
deadline). The model **drafted a candidate** but then looped on invalid actions —
`planner-invalid-action` ×6, invalidKind `workspace_publish_candidate_gated` ×3 +
`terminal_finalize_not_allowed` ×2 + `unknown_action_name` ×1 — alternating gated
publish-direct and disallowed finalize, each rejected, never reaching terminal-repair
`hard_veto` where `publishLoopUnresolvable` (candidate + hard_veto) would have
rescued it.

**Root cause (confirmed) + fix (implemented).** `readEnvelopeTerminalPolicy`
(`planner-envelope-lines.js`) disabled finalize whenever a candidate existed and
`workspace_publish_candidate` was in the surface — **without checking the publish
gate**. `publishCandidateGate` defaults enabled, so publish-direct is gated unless
an opt-in is active (gate disabled / evidence-convergence run / publish-readiness
skill / terminal-repair owns the surface). Candidate + gated publish + no opt-in →
**no terminal at all** (publish rejected, finalize disabled) → invalid-action loop
to the deadline. This even contradicted the runtime's own plan-validation guidance
("publish-direct is gated by default; to deliver, end with a finalize envelope").
Fix: `readEnvelopeTerminalPolicy` now disables finalize **only when publish is
actually executable** (consults the SSOT gate `isWorkspacePublishCandidateGatedForMode`);
when publish is gated, finalize stays available. The gate inputs are threaded into
all three call sites (main planner prompt, repair prompt, finalize-rejection check)
so they agree. Surgical: only the buggy cell flips; the research flow
(evidence-convergence → publish open → finalize suppressed) is unchanged. Verified
by `test/unit/agrun-551-finalize-available-when-publish-gated.test.js` (4/4) + full
smoke. deepseek-v4-flash at **high** effort is genuinely multi-failure-mode.

> **Correction (user input):** deepseek is a **production model** and supports
> **only `high`/`max`** effort — there is no low/default tier to fall back to. So
> its high-variance terminal thrash cannot be dodged by config; the runtime must be
> robust to it. AGRUN-552 was therefore not a "tail to ignore" — it is fixed
> universally by AGRUN-553 below.

## Issue 1c (P1, FIXED) — AGRUN-553 universal "never return empty" backstop

Rather than keep patching each livelock variant (550 → 551 → 552 → …), add one
backstop at the boundary they all funnel through.

**The empty response is NOT a model token/length limit.** The OODAE loop has three
budget-exhaustion exits — `MAX_STEPS_EXCEEDED`, `RUN_DEADLINE_EXCEEDED`,
`COST_BUDGET_EXCEEDED` (all in `action-loop-session-loop.js`) — that returned a
failure with `output: null`. The pre-existing `maybeFinalizeMaxStepsContinuation`
only handles active-TodoState *pausing* (a paused message, not content) and returns
null for simple runs. So when a terminal livelock or a slow run ate the budget
**after** the model had drafted a workspace candidate, the candidate was thrown away
and the user got a blank.

**Fix:** `maybeSalvageBudgetExhaustedCandidate(session, code)`
(`action-loop-terminal.js`), wired at all three exits. On the exhaustion codes only,
if a non-empty final workspace candidate exists, it delivers that candidate as a
**COMPLETED** result (`finalAnswerSource="budget_exhaustion_salvage"`,
`output.kind="final_response"`, `output.salvagedFrom=<code>`, with a limitations
note) instead of the empty error. Sets the terminal runState directly (mirrors the
max-steps continuation; no OODAE phase machinery). **Universal:** subsumes AGRUN-552
and any future terminal-handshake livelock variant as long as the model drafted
content. **Contract preserved:** a no-candidate exhaustion still returns the
structured error (`run-deadline.test.js` stays green).

**Verification:** `test/unit/agrun-553-budget-exhaustion-salvage.test.js` 6/6
(salvages on all three codes; no salvage when no candidate / workspace disabled /
non-exhaustion code). Full smoke green incl. `run-deadline.test.js`. Live: 4 more
deepseek-high runs all **completed** (180/119/110/227 words) — the 550/551 fixes
have already cut the livelock-to-empty rate enough that none of this batch hit the
exhaustion-with-candidate path; salvage is the deterministic backstop for when they
do, and the unit test is its proof.

---

## Issue 2 (P2) — Per-cycle context bloat drives cost & latency

Max single-call **input** tokens for a 150-word answer: gemini 33k →
deepseek-default 210k → openai 280k → deepseek-high 318k. openai cost **$0.167
(16× gemini)** at 43% cache; deepseek $0.023 at 66% cache. Output was ~160 words
everywhere — cost/latency is **entirely input-side context accumulation**.

Even a simple factual ask is routed through the **heavyweight workspace document
pipeline** (deepseek-default did 9 workspace ops — write×4, read×2, replace,
propose_patch, apply_patch — for 171 words). "Short" tier latency: gemini 15s
(good), others **1.7–5 min** (poor for a browser chatbot).

Not a single-bug fix; it is the OODAE re-send-growing-context cost curve. Worth a
design pass on (a) context windowing / summary compaction per cycle, and (b)
letting trivially-short factual asks skip the full document pipeline.

---

## Not implicated

AGRUN-549 reasoning streaming (`onReasoning` / planner `reasoning`) is not
involved in either issue. The `cited-unread-urls` red flags on gemini(3) and
deepseek-default(1) are the known AGRUN-458 model-behavior detector working as
designed (models cite from search snippets when reads fail), not a new regression.

---

## Issue 2b (2026-06-26) — the "all long reports fail source" alarm was a MEASUREMENT ARTIFACT (AGRUN-553-B)

Investigating why the full live matrix showed `gates.source=false` on **every** long
report across **every** provider, an adversarial Workflow (8 agents) **rejected its
own first synthesis** (a body-vs-Sources citation desync — 2 of 3 skeptics refuted
it) and pinned the real cause, confirmed by re-grading the live data:

- **AGRUN-522 removed the research-report-loop producer**, so
  `runState.researchReportLoop.sourceMinimum` is **null in every run**
  (`kernel-report-loop.js` is gutted — only config-normalize + an all-null initial
  state; no step/evaluate). ~15 consumer files read it null-guarded; the
  `terminal-repair/facts.js:79-94` source-deficit branch can never execute.
- `bench-one.mjs:393` **coerced that null to `false`**, and
  `live-quality.mjs:33-35` treats `sourceMinimumPassed === false` as an
  authoritative fail that **short-circuits before the `citedReadableUrlCount >= 3`
  SSOT**. Proof it was not a count problem: **long-openai and long-deepseek-default
  had `citedReadableUrlCount=3` yet `source=false`.**

So the scorecard was lying: the source gate was structurally `false` for 100% of
long reports regardless of grounding. The runtime's count-based source-**breadth**
gate is likewise dead (same null), while citation-**integrity** signals survive as
`ISSUE_ADVISORY`.

**Design decision (user):** source **breadth** (how much to read) is the **model's**
responsibility per AI-first / AGRUN-244/246-C ("expose facts, AI decides"), **not** a
hardcoded runtime gate. The gutting was the right direction; the defect is an
**unfinished migration**. The harness's source job is **integrity** (don't let the
model claim a source it never read), not depth.

**Fix (AGRUN-553-B):** `test/bench-one.mjs` emits `null` (the unknown sentinel the
grader was designed for), matching `node-agrun-3000-live.mjs:817` (Dispatch-Path
Parity). The gate then grades on `citedReadableUrlCount`. **Safe** — it does NOT
credit the runtime Sources footer (rejected as unsafe by the workflow skeptic): a
re-grade flips long-openai/deepseek-default to `source=true` (cited=3) and keeps
long-gemini/deepseek-high `false` (cited=0, genuinely ungrounded). Verified by
`test/unit/agrun-553b-source-gate-null-sentinel.test.js` (5/5) + full smoke.
**Follow-up AGRUN-554 (open):** clean up the ~15-file vestigial sourceMinimum machinery.
