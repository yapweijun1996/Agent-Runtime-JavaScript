# ADR-0047: Topic-routing + follow-up continuity is AI-owned (isActionLikeText deleted)

Ticket: AGRUN-246-K. Audit: [non-ai-first-2026-05-23.md §C2.2](../audits/non-ai-first-2026-05-23.md). Skill: `ai-first-push-deletion`. Follows [ADR-0046](./0046-topic-shape-intent-ai-owned.md) (predecessor [ADR-0045](./0045-research-finalize-intent-ai-owned.md)).

## Context

ADR-0046 removed four of the five English-lexicon regexes from
`src/runtime/topic-like-task.js` and made the **planner-path** prompt-shape
intent (clarification / goal-quality) turnKind/AI-owned. It left **one**
residual — `isActionLikeText`, an English action-verb list (B1/B2):

```js
/^(go|look|find|search|check|read|open|fetch|show|list|tell|reply|respond|answer|continue|explain|review|summarize|repeat|scrub)\b/
/\b(search|lookup)\b/
```

`isActionLikeText` was the last `.test(prompt)` in the file (allowlist count 2)
and fed exactly two fallback-tier consumers:

1. **`looksLikeTopicPrompt`** (`!isActionLikeText`) → `topic-router.js`
   thread routing (L143/L195).
2. **`inquiry-context-resolution.js`** `follow_up_command` branch (L167):
   `if (currentTopic && isActionLikeText(prompt))` → preserve the prior
   `activeTopic` on a follow-up command instead of resetting to the bare
   command words.

ADR-0046 deferred its removal because of a documented circularity: in a
**no-classifier** run `turnIntent.kind` is not populated by an LLM, and the
no-classifier `turnKind` is *derived* partly by this very `isActionLikeText`
check — so a naïve deletion was thought to reset the topic AND drop `kind` to
`new_task` (a continuity regression).

### What the empirical characterization actually showed

Running the real two-turn pipeline (`extractTurnIntent` → `routeTopic` →
`resolvePromptInquiryContext`) on the live continuity sequence proved the
problem is **not** a clean layer split:

- The follow-up `"Find more details about its waterproof depth rating."` and the
  genuine switch `"bratwurst recipes berlin"` are **structurally identical** —
  both have **zero token overlap** with the prior topic, both are short
  non-questions, both make `extractTurnIntent` emit `divergentIntent` and
  `routeTopic` spawn `new_thread`. The **only** thing that ever told them apart
  was the English action-verb lexicon.
- `inquiryContext` is **session-global**, not reset on a `new_thread` route
  (`applyRouterVerdict` in `session/thread.js` never touches it). So continuity
  is decided by `resolvePromptInquiryContext`, independent of routing.
- The Mandarin follow-up `"再找一下它的防水深度规格"` **already reset today** —
  the English lexicon never matched it. Continuity-via-lexicon was an
  **English-only half-feature**; the i18n failure C2.2 names was live in this
  exact path.

Conclusion: "command vs new topic" on a zero-overlap turn is a **semantic**
judgement no language-neutral structural primitive can make. It must be the
AI's (`turnIntent.kind`), with a conservative structural default otherwise.

## Decision

Delete `isActionLikeText`. Make routing + continuity **AI-owned with a
language-neutral conservative fallback** (the pattern the audit blessed for
`topic-router.js`'s `PIVOT_MARKERS_FALLBACK`).

- **`looksLikeTopicPrompt` → short + non-question only.** Drop the
  `!isActionLikeText` clause. A topic-shaped prompt is now a pure structural
  primitive: `1..10` words AND not `endsWith("?")`. Language-neutral. A
  command-shaped prompt now reads as topic-like; the routing/continuity layers
  rely on the AI signal (`divergentIntent`/`pivotIntent`/`kind`) or their own
  conservative default to tell follow-up from new topic.
- **`inquiry-context-resolution.js` follow_up_command → preserve-by-default.**
  Replace `if (currentTopic && isActionLikeText(prompt))` with
  `if (currentTopic)`: when an ongoing session has a prior topic and the turn is
  not an AI-declared `new_task` (handled at the top), not a clarification flow,
  and shares no overlap with the current direction (`topic_refinement` already
  caught overlapping follow-ups), **preserve** the prior topic anchor
  (`continuityKind: "follow_up_command"`, `turnKind: "follow_up"`). The active
  **goal still anchors to the new prompt** so the task is pursued correctly;
  only `activeQuery`/`activeTopic` keep the conversation's subject.

`turnIntent.kind === "new_task"` remains the AI's authoritative **reset**
override (the top branch, unchanged — this is the AGRUN-213 stale-anchor SSOT).

The `no-regex-on-prompt` allowlist entry for `topic-like-task.js` shrinks
**2 → 0**. C2.2 is fully closed.

## Why preserve-by-default (Design Y), not reset-by-default (Design X)

A no-classifier run **cannot discriminate** a follow-up command from a genuine
no-overlap switch (proven above). One default must be chosen:

- **Reset-default** would lose continuity for *every* no-overlap follow-up —
  exactly the regression the ticket forbids — and would "fix" i18n by leveling
  English *down* to Mandarin's already-broken behavior.
- **Preserve-default** keeps continuity language-neutrally (English **and**
  Mandarin follow-ups now preserve), and its only cost is that a genuine
  no-overlap switch in a no-classifier run keeps a stale `activeTopic`/
  `activeQuery` for one turn — while `activeGoal` still tracks the new prompt
  (task stays correct), recovered next turn via `topic_refinement`. This is
  *less* stale than the adjacent `topic_refinement` branch, which already keeps
  the OLD goal on a no-classifier overlapping turn (so no-classifier stale-anchor
  is a pre-existing, accepted limitation — not a new sin).

Harm is asymmetric (losing the whole subject ≫ a one-turn stale topic), the
residual is bounded and goal-correct, and **production resets correctly**: a
configured `threads.intentClassifier` emits `kind === "new_task"` on a genuine
switch → the top branch resets both routing and continuity.

## Alternatives rejected

1. **Reset-by-default (Design X).** Tidier (fewer test flips, cites the
   AGRUN-213 SSOT) but levels-down i18n and regresses the common follow-up case
   the ticket names. Rejected — confirmation-bias trap.
2. **Couple `inquiryContext` reset to a `new_thread` route.** Routing spawns
   `new_thread` for follow-ups *and* switches alike (both `divergentIntent`), so
   coupling would reset follow-ups too — same outcome as X, more code.
3. **Default provider-backed `intentClassifier`, or move turn-intent into the
   planner envelope.** Adds an LLM call / new surface; the envelope is
   chicken-and-egg (turnIntent feeds the prompt that would produce it). Not
   needed — `turnIntent.kind`/`divergentIntent` already exist.
4. **Keep `isActionLikeText` as an "advisory" lexical signal.** Forbidden
   downgrade — an advisory lexical classifier is still a lexical classifier, and
   it is still i18n-broken.

## Consequences

- Pros: the **last** English-lexicon regex-on-prompt in `topic-like-task.js` is
  gone (allowlist 2 → 0; C2.2 fully closed). Follow-up continuity is now
  **language-neutral** (the Mandarin follow-up that silently reset before this
  ticket now preserves — a real i18n fix). Routing/continuity are AI-owned via
  `turnIntent` with a conservative structural fallback.
- Cons / Risks:
  - No-classifier genuine no-overlap switch keeps a stale `activeTopic`/
    `activeQuery` for one turn (`activeGoal` is correct). Bounded; production
    resets via `kind === "new_task"`. Pinned by a deliberate unit test.
  - Broadened `looksLikeTopicPrompt` makes a command-shaped reply *during a
    pending clarification* with zero question-overlap break out to `new_task`
    (`clarification_breakout`, L134). Correct for a clearly-new subject; a
    referential command (`"find images of it"`) is the irreducible
    no-classifier ambiguity (the classifier resolves it in production). Pinned.
  - 24 `topic-router.test.js` cases are unaffected (every action-shaped case
    ends with `?` or carries an explicit `turnIntent`); verified, not assumed.

## Rollback

Restore `isActionLikeText` (B1/B2) in `topic-like-task.js`, re-add the
`!isActionLikeText(value)` clause to `looksLikeTopicPrompt`, restore the
`if (currentTopic && isActionLikeText(normalizedPrompt))` gate in
`inquiry-context-resolution.js`, and bump the `topic-like-task.js` allowlist
back to 2. No data migration — all run-scoped.

## Verification

- `npm run build` + `npm run dist:check` + `npm test` exit 0.
- `node test/unit/no-regex-on-prompt.test.js` PASS with `topic-like-task.js`
  removed from the allowlist (0 regex-on-prompt).
- New `test/unit/inquiry-context-continuity.test.js` (registered in smoke) pins
  the Design-Y matrix: EN + Mandarin follow-up preserve; `kind==="new_task"`
  resets; no-classifier genuine switch preserves-but-goal-tracks-new-prompt;
  overlap → `topic_refinement`; fresh turn → `prompt_anchor`;
  `clarification_breakout` edge.
- 24 `topic-router.test.js` + `goal-quality.test.js` stay green.
- Live (real `.env.local`, weak `gemini-3.1-flash-lite` + strong `gpt-5-mini`
  reasoningEffort=low): see
  [live-tests/adr-0047-topic-routing-continuity-ai-owned-2026-05-29.md](../live-tests/adr-0047-topic-routing-continuity-ai-owned-2026-05-29.md).
