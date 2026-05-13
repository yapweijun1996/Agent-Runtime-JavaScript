# ADR-0016 — Simple research follows ADR-0012, no auto-read / auto-finalize

Status: PROPOSED — BLOCKED on test cascade (2026-05-07)

> **Implementation blocker discovered 2026-05-07 evening:** PR 1 attempted
> `git rm src/runtime/research-continuation.js`, but
> `test/concerns/approval-resume.test.js:175-181` and the dense-search
> approval-resume cell explicitly assert on the auto-read flow. After
> `web_search` is approved, the test expects:
> 1. Runtime auto-picks the next URL (`continuity-resolved` step with
>    `selectedUrl: "https://investor.example/gopro-update"`).
> 2. That `read_url` triggers another approval gate
>    (`pendingApproval.actionName === "read_url"`).
>
> Without runtime auto-read, AI mock returns no `read_url` envelope and
> the run terminates with `status: "failed"` instead of `status:
> "blocked"`. The test cascade requires either:
> - (A) Rewriting the mock planner in `test/helpers/mocked-fetch.js` so
>   AI explicitly issues `read_url` after `web_search` returns. Touches
>   ~5 mocked planner replies; non-trivial.
> - (B) Keeping runtime auto-read for approval-resume traffic only, via
>   a new `runtimeConfig.approvalAutoRead = true` opt-in. Half-measure
>   but preserves backward UX.
>
> ADR-0016 is **deferred** until ADR-0017 lands (smaller scope, no test
> cascade). After ADR-0017, revisit ADR-0016 with option (A) — the
> proper AI-first fix.
Builds on: ADR-0012 (long-research belongs to skill), ADR-0014 (recovery), ADR-0015 (workspace authorship)
Ticket: AGRUN-224 (parent epic AGRUN-221)

## Context

ADR-0012 deleted long-research push-mode policy. The audit
(2026-05-07, [agrun_docs/audits/non-ai-first-2026-05-07.md](../audits/non-ai-first-2026-05-07.md))
found V3: `src/runtime/research-continuation.js` keeps the same push-
mode pattern alive for *simple* research traffic, gated only by
`longResearchActive === true`. That bypass means:

- AI in long-research mode picks its own next URL (correct).
- AI in any other mode (the default for short research questions)
  still gets a synthetic `read_url` decision pushed by runtime
  (`selection.nextCandidate.url`).
- When search results are thin, runtime synthesises a `finalize`
  envelope with English prose injected via
  `buildSummarizeLimitsInstruction(prompt, query, readSources)`.

Q1 ✅ — runtime decides which URL to read.
Q3 ✅ — runtime authors the finalize instruction text.
Q5 ✅ — runtime pushes a decision when AI has not asked for one.

ADR-0012's scope was deliberately narrow ("long-research only");
ADR-0016 generalises the same push→pull conversion to the simple-
research path. After ADR-0014 (Mandarin recovery) and ADR-0015
(Mandarin workspace), simple-research auto-read is the last
remaining English-leaning push-mode in the runtime.

Single consumer: [src/runtime/action-loop-session-cycle.js:79](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-cycle.js)
calls `resolveResearchContinuation` once per turn and writes the
result into `contextSnapshot.continuityResolution`.

## Decision

**Runtime never picks the next URL or synthesises a `finalize`
envelope on AI's behalf.** AI sees the search results in
`runState.researchContext.searchResults` and chooses the next action
itself.

Concrete contract:

1. Delete `resolveResearchContinuation` entirely. The function and its
   helpers (`selectResearchContinuation`, `scoreSearchCandidate`,
   `shouldSummarizeLimits`, `buildSummarizeLimitsInstruction`,
   `readDomain`, `countTokenOverlap`, `normalizeSearchResults`,
   `normalizeLimit`, `isHttpUrl`, `tokenize`) are all push-mode
   policy. The whole `src/runtime/research-continuation.js` file is
   removed.

2. Update [src/runtime/action-loop-session-cycle.js:30,79-99](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-cycle.js):
   drop the import; pass `continuityResolution: null` to
   `createContextSnapshot`. Downstream consumers already handle null
   safely (line 101 checks
   `continuityResolution && continuityResolution.pendingClarification`).

3. The `executionClass` branch that sets `"research_loop"` keeps its
   meaning (an AI-driven research run); it just no longer triggers
   runtime auto-read.

4. `result.workspace` and `result.diagnostics` shapes are unchanged.
   Hosts that read `continuityResolution` from `contextSnapshot` see
   `null` going forward (additive, no field rename).

## Tool surface (no public API change)

`web_search` / `read_url` actions keep their current signatures. AI
already has these tools and uses them. The deletion only removes the
runtime-authored decisions that pre-empted AI's choice.

## Design principles (locked)

1. **No runtime URL selection.** AI reads search results and decides.
2. **No runtime finalize prose.** AI writes its own finalize text in
   the user's language.
3. **`executionClass` survives** as a classifier (mechanism); it just
   no longer drives push-mode action selection.
4. **`continuityResolution` field stays on contextSnapshot** but is
   always `null` post-PR. Reserved for future structured signals if
   needed (e.g. duplicate-search detection).

## Alternatives

1. **Keep `resolveResearchContinuation` but make it return null when
   `executionClass !== "research_loop"`.** Rejected — the field
   `executionClass` is heuristic too; better to remove the whole
   path. Same anti-pattern as ADR-0014's "make `shouldFallback`
   return false sometimes" half-measure.
2. **Replace with a structured `continuity_signal` envelope passed to
   AI.** Rejected — same reasoning as ADR-0015 PR 2: AI can already
   read `runState.researchContext.searchResults` directly via tool
   results in the next planner prompt; no need for new infrastructure.
3. **Keep the auto-read path as opt-in via host config.** Rejected —
   re-introduces push-mode through a config switch; users who want
   "AI picks URL" get inconsistent behavior across hosts.

## Consequences

Pros:
- Removes ~331 lines from `research-continuation.js` (the entire
  file).
- Mandarin / non-English research prompts get parity with English:
  no English-only instruction text injected as a finalize override.
- Closes the last simple-research push-mode hole.
- Combined with ADR-0014/0015: AI owns recovery, workspace, and
  next-URL selection.

Cons:
- AI on small models may finalize with thinner evidence than the
  auto-read used to provide. Acceptable per ADR-0012 risk register
  (small models not the production target).
- 4 unit tests in `test/unit/research-continuation.test.js` need
  rewrite or deletion — the function under test is being removed.
- `contextSnapshot.continuityResolution` always `null` after PR;
  hosts that read it now see a stable null instead of structured
  decision objects (which were undocumented).

Risks:
- A small fraction of "search-then-stuck" cases that auto-read used
  to handle will now stall until AI explicitly issues a `read_url`.
  Mitigation: SKILL.md `long-web-research` already instructs AI to
  read top results; for simple research, planner-prompt (line ~110)
  can carry one-line guidance "after web_search, choose read_url for
  promising sources or finalize with the search snippets".

## Implementation cadence — 2 sequential PRs

ADR-0016 is smaller scope than ADR-0014/0015, so 2 PRs suffice.

### PR 1 — Delete `resolveResearchContinuation` and its helpers

Files modified:
- Delete `src/runtime/research-continuation.js` entirely.
- Update `src/runtime/action-loop-session-cycle.js`: drop import +
  call; pass `continuityResolution: null`.
- Update `test/unit/research-continuation.test.js`: delete (the
  function under test is gone).
- Update `test/smoke.test.js`: remove the `require("./unit/research-continuation.test")`.
- Sanity-grep `src/` for stale references to `resolveResearchContinuation`,
  `buildSummarizeLimitsInstruction`, `DEFAULT_AUTO_READ_URL_LIMIT`,
  `DEFAULT_AUTO_READ_DOMAIN_LIMIT`.

Acceptance:
- [ ] `git grep -n "resolveResearchContinuation\|buildSummarizeLimitsInstruction\|DEFAULT_AUTO_READ_URL_LIMIT" src/` returns 0 hits.
- [ ] `npm run check` green.

### PR 2 — Live matrix verification

Files modified:
- `agrun_docs/live-tests/simple-research-2026-05-XX.md` (new)
- `agrun_docs/audits/non-ai-first-2026-05-07.md`: V3 marked RESOLVED.

Acceptance:
- [ ] 4-cell matrix re-run (lite/gpt-5-mini × EN/ZH); AI handles
      web_search → read_url decision itself; runtime never injects.
- [ ] Combined with ADR-0014/0015 matrices: usable rate target
      ≥3/4 stays; no regression.

## Rollback

If post-PR matrix shows regression vs baseline:
1. `git revert` PR 1.
2. SKILL.md instructions for AI-driven URL selection stay (they are
   useful regardless).
3. Re-open ticket and document the failure mode in the audit doc.

## Files to modify (full list)

```
agrun_docs/adr/0016-simple-research-belongs-to-ai.md             (new — this file)
agrun_docs/audits/non-ai-first-2026-05-07.md                     (PR 2 — mark V3 resolved)
agrun_docs/live-tests/simple-research-2026-05-XX.md              (new — PR 2)
src/runtime/research-continuation.js                             (DELETED — entire file)
src/runtime/action-loop-session-cycle.js                         (drop import + call)
test/unit/research-continuation.test.js                          (DELETED)
test/smoke.test.js                                               (drop require)
task.md                                                          (mark AGRUN-224 in flight)
```

## Verification

1. Static checks per PR: `npm run check` (709 unit + concern tests
   minus the deleted research-continuation cases).
2. Grep gates per PR-1 acceptance.
3. Live 4-cell matrix per PR-2 acceptance.

## Non-goals

- No change to `runState.researchContext.searchResults` or
  `researchPasses` shapes — those remain the AI's read-only view of
  research history.
- No change to `web_search` / `read_url` action signatures.
- No new public host config.
- No removal of `executionClass` classification (it is still used by
  other consumers).

## Confirmed decisions

1. **Hard-cut deletion.** No graceful deprecation window. Same
   rationale as ADR-0013/0014/0015.
2. **Whole-file delete.** Easier to audit and bisect than partial
   refactor. The file's only consumer (`action-loop-session-cycle.js`)
   gets a 5-line edit.
3. **No replacement signal.** AI already reads research context via
   tool results; introducing `continuity_signal` would only add
   infrastructure for self-derivable state.

## Post-merge verification

- AGRUN-220 4-cell matrix re-run: target `runtime-materialized: 0`
  AND no synthetic `read_url` / `finalize` decisions in any cell.
- AGRUN-217 3-topic Chrome MCP E2E: must remain green.
- AGRUN-221 audit V3 row marked "resolved by ADR-0016".
- Combined with ADR-0014 + ADR-0015: 4-cell usable rate target
  ≥3/4 (was 1/4 baseline).
