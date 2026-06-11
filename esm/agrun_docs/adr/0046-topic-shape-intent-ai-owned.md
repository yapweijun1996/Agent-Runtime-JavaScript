# ADR-0046: Prompt-shape intent (question/action/executable-topic) is AI/turnKind-owned

Ticket: AGRUN-246-D C2.2. Audit: [non-ai-first-2026-05-23.md §C2.2](../audits/non-ai-first-2026-05-23.md). Skill: `ai-first-push-deletion`. Follows [ADR-0045](./0045-research-finalize-intent-ai-owned.md).

## Context

`src/runtime/topic-like-task.js` ran five English-lexicon regexes over the user
prompt to classify its *shape* (question vs command vs bare topic), and that
shape drove the planner path (clarification, goal-quality, ambiguity):

- `isQuestionLikeText`: `/\?$/` (A1) **+** `/^(what|which|who|when|where|why|how|do|does|did|can|could|would|should|is|are|am|will)\b/i` (A2).
- `isActionLikeText`: `/^(go|look|find|search|check|read|open|fetch|show|list|tell|reply|respond|answer|continue|explain|review|summarize|repeat|scrub)\b/` (B1) **+** `/\b(search|lookup)\b/` (B2).
- `isExecutableTopicLikeTurn`: `/\b\d+\b/` (C) digit-presence substance heuristic.

A2/B1/B2 are English word-lists that misclassify Mandarin / non-English /
indirect prompts — the i18n failure the 2026-05-07 and 2026-05-23 audits kept
re-finding. The user's directive: *"topic-like is a hardcode; this kind of
topic decision should let the AI agent decide, not by regex."*

These functions feed **two distinct layers** (only the first is this ticket's
mandate; conflating them is what deferred C2.2 before):

1. **Planner-path intent** — `task-state.js classifyPromptSignal` (prompt-signal
   tier + `isActionLike`/`isQuestionLike` booleans), `goal-quality.js`
   (`goalLooksLikeQuestion`, `stable`/`topic_only`). This is where the runtime
   classifies the *user's* intent to drive clarify/research/readiness. The
   genuine AI-first violation.
2. **Thread routing** — `topic-router.js` consumes `looksLikeTopicPrompt` as a
   *no-LLM* structural fallback where the AI signal (`turnIntent.divergentIntent`
   / `pivotIntent`) is already the authoritative override (24 router tests
   enshrine this; the audit itself blessed the sibling `PIVOT_MARKERS_FALLBACK`
   as a legitimate structural fallback). A separate subsystem, separate
   allowlist entry.

## Decision

Make the **planner-path prompt-shape decision AI/turnKind-owned**; keep
fallbacks **language-neutral structural primitives** (token overlap, length,
`?` punctuation), never English lexicons:

- **`isQuestionLikeText` → `value.endsWith("?")`.** A1+A2 removed. Question
  detection is now universal trailing-`?` punctuation, not an English word-list.
  Real question-vs-task intent is AI/router-owned via `turnIntent.kind`; this
  helper only feeds `looksLikeTopicPrompt`'s routing fallback and the
  assistant-prose loop-risk scan in `clarification-state.js` (assistant text,
  out of mandate, kept).
- **`isExecutableTopicLikeTurn` digit `/\b\d+\b/` → `hasDigit()` char scan.** C
  removed from the regex count via a language-neutral character scan; behavior
  preserved (a number in a short topic still signals specificity). The function
  already gates on `turnIntent.kind === "new_task"` (AI/router-owned).
- **`task-state.js classifyPromptSignal`:** dropped both lexicon calls. The
  signal tier was always `"high"` for non-low input regardless, and the
  `isActionLike`/`isQuestionLike` booleans are never read downstream — only
  `"low"` vs not-low matters (clarification low-signal gating), and that is
  owned by `isLowSignalPrompt` (a length/triviality check). Booleans pinned
  `false` (vestigial).
- **`goal-quality.js`:** the `isActionLikeText(prompt) → "stable"` branch is now
  `turnIntent.kind === "follow_up" || "drill_down" → "stable"`. `new_task` is
  covered by the existing research_loop branch + the executable-topic branch,
  `approval_resolution` by its branch — so the kinds map exactly to the
  definite-relationship cases the lexicon used to approximate. `isQuestionLikeText`
  (now `endsWith("?")`) and `isExecutableTopicLikeTurn` retained as above.

**Residual (documented, not a violation we can close here):** `isActionLikeText`
(B1/B2) survives as a **no-LLM structural fallback only**, reachable via
`looksLikeTopicPrompt` → `topic-router.js` and `inquiry-context-resolution.js`'s
`follow_up_command` continuity (the single-thread / no-classifier path derives
`turnIntent.kind` from this very check). Removing it safely requires a
cross-turn AI-populated `turnIntent.kind` everywhere and a topic-router that is
AI-owned rather than a pure heuristic — that is the follow-up (see Consequences).

The `no-regex-on-prompt` regrowth-guard allowlist entry for `topic-like-task.js`
shrinks **5 → 2** (the two surviving lines are exactly B1/B2 in `isActionLikeText`).

## Alternatives

1. Remove B1/B2 now by rewriting `topic-router.js`'s `looksLikeTopicPrompt`
   branches + `inquiry-context` continuity onto `turnIntent.kind`. Rejected for
   this ticket: it changes a 24-test routing subsystem the mandate never names,
   regresses single-thread continuity (the no-classifier path has no AI signal
   to fall back to), and is exactly the multi-file change the 2026-05-23 audit
   deferred. Filed as follow-up.
2. Digit-only removal (5 → 4). Rejected — cosmetic; dodges the actual i18n
   violation (the English word-lists), which the user explicitly rejected.
3. Rename the internal `text` variable to dodge the guard's var-name match.
   Rejected — gaming the guard, dishonest; the guard's intent is no-lexicon, and
   the regexes genuinely still run.
4. Keep B1/B2 as an "advisory" lexical signal. Rejected — a forbidden downgrade
   (an advisory lexical classifier is still a lexical classifier).

## Consequences

- Pros: the English question-word lexicon (the most-cited i18n offender) is
  gone; planner-path prompt-shape intent is AI/turnKind-owned and
  language-neutral; the prompt-signal tier (clarification low-signal gating) is
  provably unchanged (driven only by `isLowSignalPrompt`).
- Cons / Risks: an English question phrased **without** `?` is no longer flagged
  question-like — it now reads as `"high"` / topic-like (mitigated: real intent
  is AI/router-owned; most questions punctuate with `?`; verified across 24
  router tests + live). The action-lexicon residual (B1/B2) remains as a
  structural routing/continuity fallback.
- Follow-up: **AGRUN-246-K** — make `topic-router.js` + `inquiry-context`
  `follow_up_command` continuity AI-owned (populate `turnIntent.kind` cross-turn,
  retire `isActionLikeText`), closing `topic-like-task.js` to 0.

## Rollback

Restore the A1/A2 disjunction in `isQuestionLikeText`, the `/\b\d+\b/` regex in
`isExecutableTopicLikeTurn`, the two `classifyPromptSignal` lexicon branches, and
the `isActionLikeText(prompt)` branch in `goal-quality.js`; bump the
`topic-like-task.js` allowlist back to 5. No data migration — all run-scoped.

## Verification

- `npm run build` + `npm run dist:check` + `npm test` exit 0 (modulo a
  pre-existing, unrelated `store-indexeddb-migration` fake-IndexedDB timeout
  flake — passes on re-run, 1198 assertions).
- `node test/unit/no-regex-on-prompt.test.js` PASS with `topic-like-task.js: 2`.
- `test/unit/goal-quality.test.js` (new, registered in smoke) pins the
  turnKind-owned `stable`/`topic_only` matrix + the `classifyPromptSignal` tier
  invariant (incl. a CJK prompt → `"high"`).
- 24 `topic-router.test.js` cases stay green (every question prompt ends with
  `?`).
- Live (real `.env.local`, weak `gemini-3.1-flash-lite` + strong `gpt-5-mini`):
  see [live-tests/adr-0046-topic-shape-ai-owned-2026-05-29.md](../live-tests/adr-0046-topic-shape-ai-owned-2026-05-29.md).
