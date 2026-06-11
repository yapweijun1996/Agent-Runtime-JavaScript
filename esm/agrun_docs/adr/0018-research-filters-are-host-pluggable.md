# ADR-0018 — Research filters are host-pluggable; cultural / language hardcode default-English

Status: Proposed (2026-05-07)
Builds on: ADR-0014..0017 (recovery, workspace, simple-research, topic regex)
Ticket: AGRUN-226 (parent epic AGRUN-221)

## Context

AGRUN-221 audit listed two cultural / language hardcode rows:

- **V8 — `.gov` / `.edu` domain bonuses in
  `research-source-authority.js`.** *Re-grep at draft time
  (2026-05-07 evening) found NO `.gov` / `.edu` literal in the
  current `src/runtime/research-source-authority.js` (or anywhere
  under `src/runtime/`).* The audit claim was inaccurate — most
  likely a mis-recall or carryover from older `compileResearchReport*`
  prose paths that were deleted by ADR-0012. The current authority
  scoring works on structural cues (registry / official / advertorial
  / owner-controlled / independent) — no Western-academia bias.
  V8 is closed by re-verification, not by code change.

- **V9 — `STOP_WORDS`, `NOISE_RE`, `UI_NAV_LABEL_RE`, `UI_EMOJI_RE`
  in `research-evidence-graph.js`.** Real violation: the four
  constants at
  [src/runtime/research-evidence-graph.js:33-62](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-evidence-graph.js)
  filter snippet candidates and tokens with English-only patterns.
  Mandarin / non-English snippets pass through unfiltered (sometimes
  helping, sometimes letting noise through). The bug is asymmetry, not
  presence.

5-question audit verdict on V9:
- Q3 partial — these are filters, not prose authoring; runtime is
  cleaning evidence not writing it.
- Q4 ✅ — English-only regex on observed evidence text (not user
  prompt, but still language-specific runtime regex).

## Decision

**Both rows close in this ADR with minimal code change.**

### V8 (no code change)

Re-verification confirms `.gov` / `.edu` is not in the current code.
The audit row is marked "RESOLVED — verified absent 2026-05-07".

### V9 (documentation + future-epic)

The four constants stay as **English-default conventions** and are
explicitly documented as such. Host overrides become a future epic
(AGRUN-227, deferred) when a real non-English deployment surfaces a
concrete failure case. Today's evidence:

- AGRUN-220 4-cell matrix (2026-05-07) C2 (Mandarin × lite): AI
  authored a complete 5-file workspace report in Mandarin. The
  English-only filters did NOT visibly degrade the output. The
  evidence graph populated because Gemini lite returned snippets
  that survived `NOISE_RE` (the regex matches English-keyword
  banners; Mandarin nav labels typically pass).

- The genuine i18n risk is the asymmetry: an English nav banner
  ("Sign In | Privacy Policy") is filtered out, but a Mandarin nav
  banner ("登录 | 隐私政策") passes through and may be quoted as
  evidence. This is a quality regression, not a correctness bug.

Decision:

1. **Add documentation comment** at the top of the four constants
   acknowledging they are English-default and listing the future host
   override path (`runtimeConfig.researchEvidenceFilters.stopWords`,
   etc.).
2. **Mark constants as `export`** so future hosts can introspect /
   replace them programmatically without touching runtime code.
3. **No deletion, no replacement** — the filters do real work for
   English snippets and removing them would regress English quality
   without delivering Mandarin parity.
4. **Future epic AGRUN-227 (deferred)** captures the host-pluggable
   refactor when concrete evidence (a Mandarin deployment with
   regression) lands.

## Tool surface (no public API change)

`runtimeConfig` schema is unchanged. The constants become exported
for introspection:

```ts
import {
  RESEARCH_EVIDENCE_STOP_WORDS,
  RESEARCH_EVIDENCE_NOISE_RE,
  RESEARCH_EVIDENCE_UI_NAV_LABEL_RE,
  RESEARCH_EVIDENCE_UI_EMOJI_RE
} from "agrun/runtime/research-evidence-graph";
```

These are read-only references; mutating them would not affect
runtime behavior because the filters are referenced by closure.
A real "replace" path needs the future AGRUN-227 epic.

## Design principles (locked)

1. **Document English-default conventions.** Hide nothing.
2. **Don't delete useful filters to chase i18n parity** without
   evidence the asymmetry causes user-visible regression.
3. **Defer host-pluggable refactor** until a deployment proves the
   asymmetry hurts.
4. **Export constants for introspection** so hosts who care can
   measure the gap before requesting AGRUN-227.

## Alternatives

1. **Translate STOP_WORDS / NOISE_RE for Mandarin / Spanish / etc.**
   Rejected — same anti-pattern as ADR-0014 alternative 1; per-
   language patches don't scale and the audit V9 issue is asymmetry,
   not English presence.
2. **Delete all four constants entirely.** Rejected — English
   filtering does real work; English deployments would regress
   without a replacement.
3. **Move to host config now (AGRUN-227 immediate).** Rejected —
   refactor is non-trivial (constants are referenced by 6+ closures
   inside research-evidence-graph.js) and the user-visible benefit
   is not yet proven by live evidence.
4. **Move filters into a dedicated SKILL.md so AI handles
   filtering.** Rejected — these are mechanism (token math, regex
   filters), not policy. AI shouldn't be responsible for stopword
   filtering on every read.

## Consequences

Pros:
- Closes audit V8/V9 cleanly without invasive code changes.
- Documents the known English-default behavior so future audits
  don't re-flag the same rows.
- Exports the constants for future host inspection.
- Preserves working English quality.

Cons:
- Mandarin / non-English deployments still hit the asymmetric
  filter behavior. Documented as known limitation.
- AGRUN-227 (host-pluggable filters) becomes future work.

Risks:
- A future deployment hits the asymmetry hard and demands the
  host-pluggable path. Mitigation: AGRUN-227 ticket already exists
  with concrete file pointers.

## Implementation cadence — single PR

ADR-0018 is documentation-heavy; one PR suffices.

### PR 1 — Documentation + export the constants

Files modified:
- `src/runtime/research-evidence-graph.js`: add a doc comment block
  above the four constants explaining English-default + AGRUN-227
  pointer; add `export` to all four.
- `agrun_docs/audits/non-ai-first-2026-05-07.md`: V8 marked RESOLVED
  (verified absent), V9 marked RESOLVED (documented as English-default
  convention).
- `task.md`: AGRUN-226 in flight, AGRUN-227 added as deferred.

Acceptance:
- [ ] `git grep -n "RESEARCH_EVIDENCE_STOP_WORDS" src/` returns ≥1
      hit (the export).
- [ ] `npm run check` green.
- [ ] V8/V9 rows marked RESOLVED in audit doc.

## Rollback

If a host reports user-visible regression from the asymmetric
filtering: open AGRUN-227 immediately and prioritize the
host-pluggable refactor.

## Files to modify (full list)

```
agrun_docs/adr/0018-research-filters-are-host-pluggable.md       (new — this file)
agrun_docs/audits/non-ai-first-2026-05-07.md                     (V8/V9 marked RESOLVED)
src/runtime/research-evidence-graph.js                           (export constants + doc comment)
task.md                                                          (AGRUN-226 in flight + AGRUN-227 deferred)
```

## Verification

1. `npm run check` per PR-1 acceptance.
2. Grep gates: V8 absence verified; V9 constants exported.

## Non-goals

- No host-pluggable filter refactor (that is AGRUN-227, deferred).
- No translation of stopwords or noise patterns.
- No removal of any filter — they survive as English-default.
- No change to authority scoring (already structural, not domain-
  TLD-driven).

## Confirmed decisions

1. **V8 closed by re-verification** — `.gov`/`.edu` not in code.
2. **V9 closed by documentation** — English-default acknowledged;
   host override deferred to AGRUN-227.
3. **No deletion** — preserve working English quality; do not
   regress to chase i18n parity without concrete evidence.
4. **Exports added** so future hosts can introspect.
