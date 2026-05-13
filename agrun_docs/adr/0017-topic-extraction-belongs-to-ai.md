# ADR-0017 — Topic extraction is AI-declared, not regex-extracted

Status: Proposed (2026-05-07)
Builds on: ADR-0012, ADR-0013, ADR-0014, ADR-0015
Ticket: AGRUN-225 (parent epic AGRUN-221)

## Context

After ADR-0012 deleted `isLongResearchRun` and friends, audit V4
([agrun_docs/audits/non-ai-first-2026-05-07.md](../audits/non-ai-first-2026-05-07.md))
found `extractTopicFromPrompt` in
[src/runtime/research-state.js:546-563](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-state.js)
still runs three regex on the user prompt to derive a research topic:

1. `\btopic\s*[:=]?\s*[…](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/adr/[^…]{2,160})[…]/i` — match `topic: "..."`.
2. `[…](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/adr/[^…]{2,120})[…]` — match any quoted phrase.
3. `\b(?:research|investigate|look\s+up|find\s+out)\s+(.+?)…/i` —
   English-only research verb extraction.

Plus an English-filler-word strip in the fallback branch:
`/\b(?:please|make|do|run|create|write|generate|give|reliable|...)\b/gi`.

Q4 ✅ — runtime regex on raw user prompt for routing. Mandarin /
non-English prompts always fall through the English-only branches and
end up using the filler-stripped tail (which strips English fillers
but leaves Mandarin verbs intact). The asymmetry is the real bug.

Single consumer pattern: `extractTopicFromPrompt` is called 6 times
inside `research-state.js` to derive `topic` when the structured
field is empty.

## Decision

**Runtime never runs language-specific regex on user prompts.** AI
declares topic explicitly via plan envelope (`{ mode: "long_research",
topic: "..." }`, already on the planner-tools schema since ADR-0012);
runtime reads the structured field. When AI has not declared, the
fallback is "use the first 160 chars of the prompt as topic" —
language-neutral and trivially explainable.

Concrete contract:

1. **Delete the English research-verb regex** (`\b(?:research|investigate|look\s+up|find\s+out)\s+(.+?)…/i`).
2. **Delete the English filler-word strip**
   (`\b(?:please|make|do|run|create|write|generate|give|reliable|...)\b/gi`).
3. **Keep the quoted-phrase regex** as a structural cue (matches
   straight + curly + CJK quote characters; language-neutral).
4. **Keep the `topic:` regex** because it's a structural cue from
   programmatic callers (e.g. test fixtures that pass `topic="..."`
   directly).
5. **Fallback path** becomes `prompt.slice(0, 160).trim()` — no
   English-only filler removal.

`extractTopicFromPrompt` keeps its name and signature; only the
implementation simplifies.

## Tool surface (no public API change)

`runState.researchState.topic` and `runState.researchEvidenceGraph.topic`
remain the canonical structured topic fields. AI populates them via
the `mode: "long_research", topic: "..."` plan envelope (already
schema'd) or via `workspace_write` to a `research_topic` workspace
file (free-form filename). Runtime no longer "guesses" topic from
prompt regex.

## Design principles (locked)

1. **No language-specific regex on user prompts.** Quoted-phrase and
   `topic:` keyword regex survive because they are structural cues
   (any language).
2. **Fallback is language-neutral.** Truncate to 160 chars; do not
   strip filler words.
3. **AI declares topic explicitly** via plan envelope when it
   matters; runtime no longer infers.

## Alternatives

1. **Delete `extractTopicFromPrompt` entirely.** Rejected — 6
   callsites would all need rewiring, and the structural quoted-
   phrase extraction is genuinely useful (e.g. `research the topic
   "TNO Systems"` → topic = `TNO Systems`).
2. **Add Mandarin synonyms** (`调研|研究|查找|了解`) to the verb
   regex. Rejected — same anti-pattern as ADR-0014 alternative 1
   (per-language patches don't scale).
3. **Move regex to host config**. Rejected — pushes i18n problem
   onto every host.

## Consequences

Pros:
- Removes ~12 lines of English-only regex from
  `research-state.js`.
- Mandarin / non-English prompts get parity: same fallback path
  as English, no special English-verb extraction.
- Closes audit V4.

Cons:
- Pure English research prompts that previously got a clean
  verb-extracted topic (`research X` → `X`) now get `prompt.slice(0,
  160)` → `research X` (with the verb prefix still attached). Topic
  comparison logic must tolerate this.
- The 6 callsites that invoke `extractTopicFromPrompt(originalQuery)`
  for canonical-topic projection will produce slightly less clean
  topics until ADR-0012 PR 2 enforces explicit AI declaration. Live
  acceptance gradient may shift slightly; documented as known.

Risks:
- `isUsableStableTopic` filter may need tuning if it currently
  rejects topics with English filler words. Audit grep confirms
  `isUsableStableTopic` checks length and stop-words via
  `STOP_WORDS` set in `research-evidence-graph.js` — that set
  lives in ADR-0018 territory and stays for now.

## Implementation cadence — 2 sequential PRs

ADR-0017 is the smallest scope of the ADR-0014..0018 series; 2 PRs
suffice (no live-matrix-only PR needed because no model-facing
behavior changes; only internal topic-derivation does).

### PR 1 — Delete English regex + filler strip

Files modified:
- `src/runtime/research-state.js`: simplify `extractTopicFromPrompt`
  to keep only the quoted-phrase and `topic:` regex; replace fallback
  with `prompt.slice(0, 160).trim()`.
- `test/unit/research-state.test.js` (if any assertion on
  English-verb extraction): update to match new behavior.

Acceptance:
- [ ] `git grep -nE "(research|investigate|look\\\\s\\+up|find\\\\s\\+out).*\\(\\.\\+\\?\\)" src/runtime/research-state.js` returns 0 hits.
- [ ] `npm run check` green.

### PR 2 — Audit row + live matrix sanity (optional)

Files modified:
- `agrun_docs/audits/non-ai-first-2026-05-07.md`: V4 marked RESOLVED.
- Optional: a 2-cell mini matrix prompt that confirms Mandarin
  prompt produces a usable topic via the structural fallback.

## Rollback

If post-PR matrix or unit tests show regression:
1. `git revert` PR 1.
2. Re-open ticket and document the failure mode.

## Files to modify (full list)

```
agrun_docs/adr/0017-topic-extraction-belongs-to-ai.md            (new — this file)
agrun_docs/audits/non-ai-first-2026-05-07.md                     (PR 2 — mark V4 resolved)
src/runtime/research-state.js                                    (~12 lines deleted)
test/unit/research-state.test.js                                 (if affected)
task.md                                                          (mark AGRUN-225 in flight)
```

## Non-goals

- No removal of `STOP_WORDS` / `NOISE_RE` / `UI_NAV_LABEL_RE` /
  `UI_EMOJI_RE` from `research-evidence-graph.js` — that is ADR-0018
  territory.
- No change to plan-envelope schema (already supports `mode:
  "long_research", topic: "..."` per ADR-0012 PR 1).
- No change to `isUsableStableTopic` filter — depends on STOP_WORDS
  which lives in ADR-0018 scope.

## Confirmed decisions

1. **Hard-cut deletion** of the English verb regex and filler strip.
2. **Keep quoted-phrase + `topic:` regex** as structural cues
   (language-neutral by virtue of matching any quote character +
   any verb-keyword `topic`).
3. **Fallback is `prompt.slice(0, 160).trim()`** — no further
   processing.
