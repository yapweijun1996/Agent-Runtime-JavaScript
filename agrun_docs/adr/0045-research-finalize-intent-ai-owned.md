# ADR-0045: Research finalize-vs-more-research intent is AI-owned (drop prompt regex + force-finalize bypass)

Ticket: AGRUN-246-E/J (staged from AGRUN-294I #2). Audit: [non-ai-first-2026-05-23.md §C2](../audits/non-ai-first-2026-05-23.md). Skill: `ai-first-push-deletion`.

## Context

`src/runtime/research-state.js` ran three English-only regex helpers over the
user's follow-up prompt:

- `hasFinalizeExistingEvidenceIntent(prompt)` — `/\bfinali[sz]e\b/`, "existing/available/collected evidence", etc.
- `hasExplicitMoreResearchIntent(prompt)` — "search/research … more/additional/new".
- `hasExplicitNewTopicIntent(runState, options)` — a stable-vs-prompt topic-token diff gated by `/\b(?:research|investigate|look up|find out)\b/`.

They drove `detectFinalizeOnlyResearchRecovery` → `researchState.recoveryMode = "finalize_existing_evidence"`.
Two sites consumed the verdict, and a third site weaponised it:

1. `createResearchWorkspace` switched the report goal/topic source to the thread anchor when recovery was armed.
2. `extractResearchTopic` preferred the stable thread topic when recovery was armed.
3. **`maybeCreateFinalizeOnlyResearchRecoveryFinal` (action-loop-session-loop.js)** ran at the TOP of every action-loop cycle, BEFORE the planner, refreshed research state with a `finalize_existing_evidence` phase, and emitted a `research-recovery-mode-armed` step to pre-arm a finalize FOR the AI. This is push-mode: the runtime classified intent before the AI saw the prompt, then steered toward finalize — exactly what the harness contract forbids ("runtime must not auto-finalize for the AI"), and brittle for Mandarin / non-English / idiomatic phrasing (the same i18n failure mode the 2026-05-07 and 2026-05-23 audits kept finding).

This was the last positive entry (count 9) on `research-state.js` in the AGRUN-246-I regrowth-guard allowlist (`test/unit/no-regex-on-prompt.test.js`).

## Decision

Make the finalize-vs-more-research choice **AI-owned**, the runtime expose only **facts**:

- **Deleted** the three regex helpers, the orphaned `normalizeTopicKey` / `readCurrentPrompt`, the `hasFinalizeExistingEvidenceIntent(topic)` guard inside `isUsableStableTopic`, and the `maybeCreateFinalizeOnlyResearchRecoveryFinal` force-finalize bypass (plus its dead `handleDirectFinal` block, the `research-recovery-mode-armed` step, and the write-only `runState.researchRecoveryMode`).
- **Replaced** `detectFinalizeOnlyResearchRecovery` with `detectContinuedResearchThread(runState, options)` — a pure FACT predicate with NO prompt regex: existing research artifacts AND not a declared new topic (`turnIntent.kind === "new_task"`, an AI/router-owned signal) AND (a follow-up turn OR a stable cross-turn topic). It re-keys the workspace topic/goal to the thread anchor and feeds a read-only planner signal; it never forces an action.
- **Renamed** the mode value `"finalize_existing_evidence"` → `"continued_research_thread"` so the label is a fact, not a verdict name.
- **Exposed** the fact read-only in the planner's focused research-phase contract (`planner-prompt.js`): `continuedResearchThread { active, existingReadSources, searchPassCount, stableTopic, choice }`. The `choice` line states options, not a command ("You may finalize on this existing evidence, gather more, or refine — decide from the user's request; do not re-gather by default"). The AI's next action (finalize/final_answer vs web_search/read_url) is the decision; `maxSteps` is the fail-stop.

The "search more" vs "finalize" distinction is no longer a runtime classification at all. Because the force-finalize bypass is gone, arming the continued-thread fact can never finalize a "search more" turn.

## Alternatives

1. Add a `finalize-vs-more` field to `turn-intent-planner.js` (CONTEXT suggested "a new planner-owned signal is needed"). Rejected per the APPROACH: that builds a new parallel detector; the AI's action choice already IS the decision.
2. Keep the regex as an "advisory signal". Rejected — a forbidden downgrade; an advisory lexical classifier is still a lexical classifier.
3. Pure deletion with no signal. Rejected — on a fresh "finalize what you have" follow-up a weak model could re-search; the read-only continued-thread fact + existing-read-source count de-risks acceptance (b) without commanding the AI.

## Consequences

- Pros: 0 regex-on-prompt in `research-state.js` (allowlist 9 → 0); finalize-vs-more is AI-owned and language-neutral; one push-mode force-finalize site removed; honest fact label.
- Cons / Risks: a weak model could ignore the user's "finalize" instruction and re-search (mitigated by the fact + existing-source count in the prompt; not by a runtime override). Acceptance (b)/(c) require live confirmation — mocks cannot prove the AI finalizes on "finalize" yet keeps researching on "search more".

## Rollback

Restore `detectFinalizeOnlyResearchRecovery` + the three helpers from git history, restore `maybeCreateFinalizeOnlyResearchRecoveryFinal`, revert the mode value rename, and bump the `research-state.js` allowlist back to 9. No data migration — `recoveryMode` is run-scoped state.

## Verification

- `npm test` exit 0; `node test/unit/no-regex-on-prompt.test.js` PASS with `research-state.js: 0`.
- `npm run build` + `npm run dist:check` exit 0.
- Live (real `.env.local`): (a) `test:live:node-3000` completes; (b)/(c) `test/node-research-followup-live.mjs --scenario finalize|more`. See [live-tests/adr-0045-research-finalize-ai-owned-2026-05-29.md](../live-tests/adr-0045-research-finalize-ai-owned-2026-05-29.md).
