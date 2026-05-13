# ADR-0014 — Empty-response & invalid-envelope recovery is AI's job, not runtime's

Status: Proposed (2026-05-07)
Builds on: ADR-0012 (long-research belongs to skill), ADR-0013 (skill discovery is a tool)
Supersedes: implicit "runtime auto-recovery" pattern from `planner-recovery.js`
Ticket: AGRUN-222 (parent epic AGRUN-221)

## Context

After AGRUN-217 (ADR-0012) and AGRUN-220 (ADR-0013) deleted runtime-side
*long-research policy* and *skill ranking injection*, the AGRUN-221 audit
(2026-05-07, [agrun_docs/audits/non-ai-first-2026-05-07.md](../audits/non-ai-first-2026-05-07.md))
found a third high-severity push-mode policy still active in
`src/runtime/planner-recovery.js`:

1. **Lexical regex on user prompt** — `looksLikeResearchRequest` runs
   `/research|report|public[-\s]?source|sources?|evidence|web\s+search|search|read\s+url|read_url|look\s+up|investigate|deep\s+dive/i`
   ([planner-recovery.js:78](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-recovery.js)).
   English-only; Mandarin / German / Japanese / Spanish prompts silently
   fall to `false`, even when they obviously want research.
2. **Lexical regex on AI response** — `/web_search|search the web|search web|look up|lookup|search first/`
   ([planner-recovery.js:57](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-recovery.js))
   parses the LLM's free-form text to guess intent. Fails the same way
   on non-English LLM output.
3. **Synthetic web_search decision** — `createWebSearchFallbackDecision`
   ([planner-recovery.js:81-103](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-recovery.js))
   manufactures `{ name: "web_search", args: { query: activeQuery || activeGoal || prompt } }`
   when the planner returns invalid / empty envelopes. Runtime "fixes"
   AI by guessing the next move.
4. **Year-presence heuristic** — `looksLikeTopicPrompt(prompt) && /\b\d{4}\b/.test(prompt)`
   ([planner-recovery.js:69](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-recovery.js)) —
   runtime decides "this looks like a research request because it has a
   year in it." Pure heuristic.

This violates 5-question audit:
- Q4 ✅ — three regexes on raw user prompt + AI response.
- Q5 ✅ — runtime substitutes a synthetic `web_search` decision when AI
  output is invalid.

Callsites:
- [action-loop-session-loop.js:161,185,338,552-589,591-650](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js)
  — `requestPlannerWithEmptyResponseFallback` (empty-response retry then
  fallback) + `maybeCreateInvalidPlannerWebSearchFallback`
  (invalid-envelope fallback).
- [action-loop-planner.js:28-29,388-410](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-planner.js)
  — repeats the pattern at the planner-loop layer.
- [planner.js:17-18,399-420](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner.js) — same
  fallback at the lowest planner-call layer.

Live evidence: AGRUN-220 4-cell matrix (2026-05-07) showed C2 / C4
(Mandarin × any model) failing recovery; the AI returned an
unstructured Mandarin clarification, runtime regex returned `false`,
and the loop terminated without retry. C1 (English × lite) passed
because the regex matched the English prompt.

## Decision

**Runtime owns recovery mechanism. AI owns recovery policy.**

Concrete contract:

1. **Empty / invalid planner response → structured retry signal, not
   synthetic decision.** Runtime emits a `recovery_signal` envelope to
   the next planner call with structured fields:

   ```jsonc
   {
     "kind": "planner_invalid_envelope" | "planner_empty_response" | "planner_action_invalid",
     "reason": "schema_validation_failed" | "missing_decision" | "unknown_action_name",
     "previousResponseText": "<verbatim AI output>",
     "schemaHint": "<allowed actions list, JSON of valid envelope shapes>",
     "retryCount": <integer>
   }
   ```

   The next planner call carries this signal in its prompt. AI decides
   whether to retry, switch action, or finalize with current evidence.
   Runtime no longer manufactures the next move.

2. **Delete lexical regex.** Remove `looksLikeResearchRequest`,
   `looksLikeTopicPrompt && \d{4}` heuristic, and the AI-output regex
   `/web_search|search the web|.../`. Replace with: AI sees
   `recovery_signal` and decides.

3. **Delete `createWebSearchFallbackDecision`.** No runtime-synthesized
   `web_search` decisions. If AI returns invalid envelope twice in a row,
   runtime emits a structured `give_up` signal back to the host (via
   `result.diagnostics.recovery`) — the host decides whether to log /
   retry / surface to user. Runtime never invents a tool call.

4. **Retry budget = mechanism, kept.** `MAX_RECOVERY_RETRIES = 2` in
   runtime is a bounded loop guard (mechanism). Default = 2; host can
   override via config. After budget exhausted, runtime emits
   `recovery_exhausted` signal and returns to host with current state.

5. **`buildStrictRetryPrompt` survives** as the structured-context
   builder (mechanism). It already does the right thing — formats
   `availableActions` + `envelopeExamples` + `searchResults` for the AI.
   Keep as-is. The regex-driven heuristic is the part being removed.

## Tool surface (no public API change)

`recovery_signal` is internal harness state passed via planner prompt
context. Hosts do NOT need to know about it. Public API
(`runActionLoop`, `result.diagnostics`) gains:

```ts
result.diagnostics.recovery: {
  retries: number,
  lastSignal: "planner_invalid_envelope" | "planner_empty_response" | "planner_action_invalid" | "recovery_exhausted" | null,
  exhaustedAt?: { turn: number, reason: string }
}
```

This is read-only telemetry; hosts can show "AI is having trouble
parsing the envelope" UX but cannot influence runtime behavior through
it.

## Design principles (locked)

1. **No regex on user prompt for routing.** Already the rule for
   ADR-0012 and ADR-0013; ADR-0014 closes the last regex hole.
2. **No synthetic action decisions.** Runtime never manufactures
   `web_search` / `read_url` / `finalize` payloads. AI authors all
   actions; runtime relays + bounds.
3. **Retry budget is bounded.** 2 retries default. After budget,
   surface to host. No infinite loop.
4. **Recovery signal is structured, language-neutral.** `kind` /
   `reason` / `retryCount` — AI reads enums, not English keywords.
5. **`buildStrictRetryPrompt` stays.** It is mechanism (formatting
   helper), not policy.

## Alternatives

1. **Keep regex, add Mandarin synonyms.** Rejected — every new language
   needs runtime patch. Scales linearly with languages, never reaches
   parity.
2. **Run a small classifier model in runtime to detect "research
   intent."** Rejected — heavier dependency, still a runtime decision,
   just dressed up. Same harness anti-pattern.
3. **Move regex to host config (host-pluggable filter).** Rejected —
   pushes the i18n problem onto every host. AI already has language
   capability; let it decide.
4. **Delete recovery entirely; let host handle invalid envelopes.**
   Rejected — bounded retry loop is genuine mechanism (prevents single
   network blip from killing a turn). Keep the loop, delete the policy.

## Consequences

Pros:
- Mandarin / non-English prompts now recover identically to English.
- Removes ~120 lines from `planner-recovery.js` + `action-loop-session-loop.js`.
- `4-cell live matrix` should improve from 1/4 → at least 2/4 usable
  (Mandarin cells unblocked).
- Clean push → pull split: runtime emits structured signal, AI replies.

Cons:
- Hosts that consume `result.diagnostics.recovery` need the new shape
  (additive — no breaking field rename).
- 5 unit tests in `test/unit/planner-recovery.test.js` need rewrite
  (assertions on `createWebSearchFallbackDecision` deleted, replaced
  with assertions on `recovery_signal` envelope shape).
- Small models that already struggle with valid envelopes will see
  more `recovery_exhausted` outcomes. Documented as expected: small
  models are not the target for production long-research.

Risks:
- AI may use the recovery signal to retry the same broken envelope.
  Mitigation: include `previousResponseText` so AI sees its own output
  and can self-correct; budget cap of 2 prevents infinite loop.
- `result.diagnostics.recovery.lastSignal` adds a new field. Hosts
  currently reading `diagnostics` should ignore unknown keys (already
  documented contract per ADR-0011 improvement-harness).

## Implementation cadence — 3 sequential PRs

Mirror AGRUN-217 and AGRUN-220 cadence. Each PR runs `npm run check` +
4-cell live matrix gate before merge. No squash; bisect-friendly.

### PR 1 — Delete lexical regexes; introduce `recovery_signal` envelope

Files modified:
- `src/runtime/planner-recovery.js`
  - Delete `shouldFallbackToWebSearch` (line 40-74) and
    `looksLikeResearchRequest` (line 76-79). Keep `buildStrictRetryPrompt`
    (line 3-38) and supporting helpers (line 126-195).
  - Add `buildRecoverySignal({ kind, reason, previousResponseText, retryCount, schemaHint })`
    that returns the structured envelope.
- `src/runtime/action-loop-session-loop.js`
  - Replace `maybeCreateInvalidPlannerWebSearchFallback` with
    `pushRecoverySignal` that adds the structured signal to the next
    planner call's `loopState.recoveryContext`. No `decision` synthesis.
  - Same replacement for the empty-response path
    (`requestPlannerWithEmptyResponseFallback` becomes
    `requestPlannerWithRecoverySignal`).
- `src/runtime/action-loop-planner.js` + `src/runtime/planner.js`
  - Remove `createWebSearchFallbackDecision` import. Use the new
    `pushRecoverySignal` path instead.
- Tests:
  - `test/unit/planner-recovery.test.js` — delete the 5 fallback-decision
    tests. Add tests for `buildRecoverySignal` shape.
  - `test/concerns/planner-recovery.test.js` (if exists) — port
    assertions to recovery_signal shape.

Acceptance:
- [ ] No regex anywhere in `planner-recovery.js` matches user prompt
      content.
- [ ] No `createWebSearchFallbackDecision` callsite in `src/runtime/`.
- [ ] `npm run check` green.
- [ ] Mandarin prompt: `深度调研 [中文公司名]` triggers retry with
      structured signal (proven by unit test, not just live).

### PR 2 — Bounded retry budget + diagnostics surface

Files modified:
- `src/runtime/action-loop-session-loop.js`
  - Add `recoveryRetryCount` to session state. Increment on each
    invalid envelope. After 2, emit `recovery_exhausted` signal and
    break out of action-loop turn (per existing budget pattern).
- `src/runtime/result.js`
  - Add `diagnostics.recovery: { retries, lastSignal, exhaustedAt? }`.
- `src/runtime/state.js`
  - Add `recoveryRetryCount: 0` default; reset per turn in
    `action-loop-session-cycle.js` (next to existing `listSkillsCallsThisTurn` reset).
- Tests:
  - `test/unit/recovery-budget.test.js` (new) — assert 2-retry cap,
    `recovery_exhausted` signal shape, reset between turns.
- Documentation:
  - `agrun_docs/public-runtime-api.md` — add `diagnostics.recovery`
    field.

Acceptance:
- [ ] After 3rd invalid envelope, runtime emits `recovery_exhausted`
      and returns; no infinite loop.
- [ ] Counter resets at start of each turn.
- [ ] Diagnostics surface documented in public API doc.

### PR 3 — Live matrix verification + planner system instruction update

Files modified:
- `src/runtime/planner-prompt.js`
  - Add 1-line instruction: *"If your previous response was invalid,
    runtime sends `recoveryContext` with kind/reason. Read it and
    return a corrected envelope. After 2 retries the run will surface
    diagnostics; do not exceed."*
- `agrun_docs/live-tests/recovery-2026-05-XX.md` (new)
  - Run 4-cell matrix (lite/gpt-5-mini × EN/ZH) with deliberately
    induced invalid-envelope scenario (e.g. force planner via prompt
    to return malformed JSON once).
  - Document acceptance gradient: pre-PR baseline 1/4 (EN-only) →
    post-PR target ≥3/4.

Acceptance:
- [ ] At least 3/4 cells recover from a single invalid envelope.
- [ ] No cell loops indefinitely; budget cap holds.
- [ ] Inspector telemetry shows `diagnostics.recovery.retries=1` after
      successful recovery.
- [ ] Live matrix report committed.

## Rollback

If post-PR matrix shows regression vs baseline:
1. `git revert` the PR 1 deletion (regex paths return).
2. Recovery_signal infrastructure (PR 2) stays — it is additive and
   does not break legacy paths if PR 1 is reverted.
3. Re-open ticket and document failure mode in
   `agrun_docs/audits/non-ai-first-2026-05-07.md`.

## Files to modify (full list)

```
agrun_docs/adr/0014-recovery-belongs-to-ai.md            (new — this file)
agrun_docs/live-tests/recovery-2026-05-XX.md             (new — PR 3)
agrun_docs/public-runtime-api.md                         (PR 2)
src/runtime/planner-recovery.js                          (~80 line deletion + ~30 line addition)
src/runtime/action-loop-session-loop.js                  (~40 line deletion + ~30 line addition)
src/runtime/action-loop-planner.js                       (drop fallback import + 22 line block)
src/runtime/planner.js                                   (drop fallback import + 22 line block)
src/runtime/planner-prompt.js                            (1-line instruction)
src/runtime/result.js                                    (diagnostics.recovery field)
src/runtime/state.js                                     (recoveryRetryCount default)
src/runtime/action-loop-session-cycle.js                 (reset counter per turn)
test/unit/planner-recovery.test.js                       (rewrite 5 tests)
test/unit/recovery-budget.test.js                        (new)
task.md                                                  (mark AGRUN-222 in flight)
```

## Verification

1. Static checks per PR: `npm run check` (645 unit + concern tests).
2. Grep gates:
   - `git grep -n "looksLikeResearchRequest\|createWebSearchFallbackDecision\|shouldFallbackToWebSearch" src/` returns zero hits after PR 1.
   - `git grep -n "web_search.*reasoning.*Fallback" src/` returns zero hits.
3. Live 4-cell matrix per PR 3 acceptance.

## Non-goals

- No change to skill discovery (ADR-0013 territory).
- No change to long-research policy (ADR-0012 territory).
- No change to simple-research auto-read path (ADR-0016 territory).
- No new public host config beyond optional retry budget override.
- No i18n of `planner-prompt.js` system strings (separate epic).

## Confirmed decisions

1. **Hard-cut retry policy** — no graceful deprecation of
   `createWebSearchFallbackDecision`. Removed atomically in PR 1.
   Rationale: same as ADR-0013 — soft deprecation only delays churn.
2. **2-retry cap is mechanism, not config-only.** Hosts may override
   via `actionLoopOptions.recovery.maxRetries`, but the cap exists
   unconditionally. Prevents infinite-loop from a misbehaving model.
3. **`buildStrictRetryPrompt` formatting helper survives.** It is the
   structured-context builder, not the policy. Used by the new
   `pushRecoverySignal` path.
4. **`diagnostics.recovery` is additive.** Existing hosts that read
   `result.diagnostics` ignore unknown keys per ADR-0011.

## Post-merge verification

- AGRUN-220 4-cell matrix re-run: target ≥3/4 usable (was 1/4).
- AGRUN-217 3-topic Chrome MCP E2E (TNO / yapweijun1996 / Vite): must
  remain green; recovery path is dormant in happy-path runs.
- `agrun_docs/audits/non-ai-first-2026-05-07.md` V1 row marked
  "resolved by ADR-0014".
