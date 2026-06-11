# ADR-0019 — Final-response quality is a signal, not a veto

Status: Proposed (2026-05-07)
Builds on: ADR-0014 (recovery), ADR-0015 (workspace), ADR-0017 (topic regex)
Ticket: AGRUN-228 (parent epic AGRUN-221)

## Context

Live evidence 2026-05-07 evening: a real `gemini-3.1-flash-lite-preview` run with a Mandarin "3000-word report" prompt produced an 11-cycle / 60-second loop with 8+ `before-finalize-veto` events. Root cause: `maybeCreateFinalResponseQualityVeto` in
[src/runtime/final-response-quality.js:158](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/final-response-quality.js)
checks AI's finalize answer for 7 quality issues and rejects with synthetic observation prose. AI re-emits finalize → veto fires again → `planner-fallback-skipped-duplicate` → `planner-repair-failed` → loop until `session-budget-breach` (count=5) forces runtime finalize.

This is the same anti-pattern shape as ADR-0014's recovery regex and ADR-0015's workspace veto:
- Q3 ✅ — runtime authors `buildFinalResponseRepairInstruction` repair-text prose injected as observation.
- Q5 ✅ — runtime "fixes" AI by re-asking; AI loops on the same issues until budget breach.

Severity: HIGH. Per audit-method tag, this is V11 — the audit's first-pass grep used keyword "research" which missed `final-response-quality.js`. Surfaced only after live evidence on lite × Mandarin × long-form.

User principle (locked 2026-05-07): "we must let weak model also can support, this is harness engineering, dont blame model weakness". A weak model rejected 8+ times in 60 seconds will exhaust its turn budget instead of producing the 3000-word report. The fix is harness, not model.

## Decision

**Final-response quality is a signal AI reads, not a veto runtime enforces.**

Concrete contract:

1. **Rename** `maybeCreateFinalResponseQualityVeto(runState, context) → veto`
   to **`noteFinalResponseQualityIssues(runState, context) → null`**.
   The function still runs `analyzeFinalResponseQuality`, still records the
   per-run veto count and last-issues fields on `runState.finalResponseQuality`
   (for diagnostics surface). It NEVER returns a veto envelope. Callers
   that previously got a veto get `null` and proceed to finalize.

2. **Drop the call from `action-loop-session-terminals.js`** that turns
   the return value into a `before-finalize-veto` step. Replace with
   a `note` step that emits `final-response-quality-noted` with the
   issue codes for diagnostics, without aborting finalize.

3. **Surface in `result.diagnostics.finalResponseQuality`** so hosts
   that want the "too short / placeholder / claim-coverage" signal can
   use it for UX (badge / banner / link to "expand this section").

4. **Surface in next planner prompt** when `runState.finalResponseQuality.issues`
   is populated: a one-block `qualityContext` (kind: "final_response_quality",
   issues: [enum codes], retryCount). AI reads enums (language-neutral), decides
   to expand / repair / accept. Same pattern as ADR-0014 PR 3 `recoveryContext`.

5. **Delete or keep `buildFinalResponseRepairInstruction`?** Keep for now.
   It is still used by `runtime-finalize.js:134` and `action-loop-session-terminals.js:167`
   inside the `runtime_finalize` repair path (one-shot, not a loop).
   Those are separate anti-patterns (runtime-authored repair prose) and
   slated for follow-up ADR-0019 PR 2 if user wants to push further.
   PR 1 scope is the LOOP only.

## Tool surface (no public API breakage)

`runState.finalResponseQuality` keeps its current shape:
```ts
{
  vetoCount: number,        // counts notes, not vetoes (legacy field name)
  lastIssues: string[],     // issue codes from last analysis
  lastSource: string | null // e.g. "planner_final"
}
```

`result.diagnostics` gains:
```ts
finalResponseQuality: {
  issues: string[],         // last analysis's issue codes
  vetoCount: number,        // total notes this run (additive)
  lastSource: string | null
}
```

Planner prompt gains a one-block `qualityContext` rendered by `buildSystemPromptLines`:
> "Your previous final answer triggered runtime quality issues:
> [enum codes]. Read the codes and either expand the answer
> (via workspace_replace or a fresh finalize) or accept and re-emit
> if you disagree. Runtime no longer blocks finalize on these issues."

## Design principles (locked)

1. **No runtime-driven re-emit loops.** Issue codes go to AI; AI decides.
2. **Quality analysis is mechanism (kept).** `analyzeFinalResponseQuality`
   stays — issue detection is structural pattern matching, not policy.
3. **Issue codes are language-neutral enums.** AI sees `placeholder_artifact`,
   not English prose.
4. **Diagnostics surface is read-only.** Hosts can show UX based on
   `result.diagnostics.finalResponseQuality`; cannot influence runtime
   behavior through it.

## Alternatives

1. **Keep the veto, raise the cap from 2 to 5.** Rejected — same loop,
   just longer. Weak models still hit the cap; fundamental fix is
   "no loop", not "longer loop".
2. **Remove the analysis entirely.** Rejected — the issue codes are
   genuinely useful diagnostic signal for hosts and AI. Removing them
   loses information.
3. **Replace with a deterministic post-processor** (auto-strip placeholders,
   auto-add Sources). Rejected — runtime-authored prose by another name.

## Consequences

Pros:
- Live evidence pain (60s veto loops on lite × Mandarin) goes away.
  AI gets one finalize attempt; runtime never blocks.
- Weak models can now produce long-form output without runtime interference.
- Issue codes surface to hosts for UX, to AI for self-revision.
- Mirrors ADR-0014/0015 patterns; consistent harness shape.

Cons:
- AI may finalize with quality issues that the previous veto would have
  caught. Mitigation: planner-prompt surfaces issue codes; SKILL.md
  (long-form-writer, future) can teach AI to self-check before finalize.
- The 1 unit test in `test/unit/final-response-quality.test.js` that
  asserts on veto behavior needs rewrite.

Risks:
- Hosts that build UX assuming runtime "will always strip placeholders
  before finalize" need to start handling `result.diagnostics.finalResponseQuality.issues`.
  Documented as additive behavior change in CHANGELOG.

## Implementation cadence — 2 PRs

### PR 1 — Convert veto to note + drop the loop call

Files modified:
- `src/runtime/final-response-quality.js`: rename + simplify
  `maybeCreateFinalResponseQualityVeto` to `noteFinalResponseQualityIssues`
  (records issues, returns null).
- `src/runtime/action-loop-session-terminals.js`: drop veto check (lines
  67-71); replace with `note` step.
- `src/runtime/result.js`: add `diagnostics.finalResponseQuality` field
  in `createResultDiagnostics`.
- `src/runtime/state.js`: ensure `runState.finalResponseQuality` is
  initialized in default state and projected by snapshot.
- `src/runtime/planner-prompt.js`: render `qualityContext` block when
  issues present.
- `test/unit/final-response-quality.test.js`: replace veto assertion
  with note-shape assertion.

Acceptance:
- [ ] `git grep -n "maybeCreateFinalResponseQualityVeto" src/` returns
      0 hits.
- [ ] `git grep -n "before-finalize-veto.*final_response" src/` returns
      0 hits in code (allow tombstone comments).
- [ ] `npm run check` green.
- [ ] Live re-test: lite × Mandarin × 3000-word prompt does NOT loop;
      finalize completes in ≤2 cycles after AI emits final.

### PR 2 (optional) — Remove `buildFinalResponseRepairInstruction` from runtime_finalize repair

Defer. Lower priority. The runtime_finalize repair is one-shot (not a
loop) and provides genuine repair value for the rare case AI's first
finalize is genuinely broken. Delete only if live evidence shows it
hurts weak models too.

## Files to modify (full list)

```
agrun_docs/adr/0019-final-response-quality-belongs-to-ai.md      (new — this file)
src/runtime/final-response-quality.js                            (~30 line change)
src/runtime/action-loop-session-terminals.js                     (drop veto check)
src/runtime/result.js                                            (add diagnostics field)
src/runtime/state.js                                             (init + projection)
src/runtime/planner-prompt.js                                    (add qualityContext block)
test/unit/final-response-quality.test.js                         (rewrite veto assertion)
agrun_docs/audits/non-ai-first-2026-05-07.md                     (add V11 row, mark RESOLVED)
task.md                                                          (mark AGRUN-228)
```

## Verification

1. `npm run check` per PR-1 acceptance.
2. Grep gates: zero `maybeCreateFinalResponseQualityVeto` callsites.
3. Live re-test: same prompt that produced 60s / 11-cycle loop should
   complete in <30s / ≤4 cycles after PR 1.

## Non-goals

- No removal of `analyzeFinalResponseQuality` (mechanism stays).
- No change to `chooseHigherQualityFinalResponse` (post-runtime-finalize
  comparator; not the loop).
- No change to runtime_finalize repair path (separate concern, possibly
  future PR 2).
- No new public host config.

## Confirmed decisions

1. **Hard-cut the veto in PR 1.** No graceful deprecation.
2. **Keep `buildFinalResponseRepairInstruction`** for runtime_finalize
   repair path; revisit only if it shows up in live evidence as harmful.
3. **Issue codes are stable contract** — hosts can rely on them being
   string enums, additive only.

## Origin

User's "harness must support weak models" principle (2026-05-07) +
support-bundle live evidence showing 8+ before-finalize-veto cycles
on lite × Mandarin × 3000-word prompt. Documented in audit as V11
(missed by first-pass grep). KB entry "Harness must support weak
models — long-form is decomposition, not model size" makes the
principle cross-project portable.