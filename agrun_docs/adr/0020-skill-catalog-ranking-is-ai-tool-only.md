# ADR-0020 — Skill catalog ranking is AI-tool-only; runtime no longer auto-ranks user prompt

Status: Proposed (2026-05-07)
Builds on: ADR-0013 (skill discovery is a tool — completes its PR 1 acceptance)
Ticket: AGRUN-229 (parent epic AGRUN-221, non-AI-first audit)

## Context

Live evidence 2026-05-07 evening: a real `gemini-3.1-flash-lite-preview`
run with a Mandarin "用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告"
prompt produced a `skill_catalog_ranking` debug block where every skill
scored 0:

```
[skill_catalog_ranking]
1. deep-research-writer | score=0 | fields=none
2. expert-coder         | score=0 | fields=none
3. long-web-research    | score=0 | fields=none
4. web-research         | score=0 | fields=none
5. worldtime_tz         | score=0 | fields=none
```

Root cause is **not** the tokenizer. ADR-0013 PR 1 had already locked the
correct architecture:

- `list_agent_skills(query)` is the AI-callable tool (PR 2 shipped 2026-05-07).
- AI translates user intent (any language) into an English capability keyword.
- Substring match (`applyListSkillsQuery`) — no tokenizer, no STOP_WORDS.
- Skill manifests stay English by convention (ADR-0013 design principle 1).

But ADR-0013 PR 1 **acceptance was not met**:

> `git grep -n "pickTopSkillRecommendation\|recommendedSkill\|skillCatalogRanking"` returns 0 hits in `src/`.

Today's grep returns 5 sites:

| File | Line | Surface |
|---|---|---|
| `src/runtime/action-loop-planner.js` | 25 | `import { rankSkillManifests, selectSkillCatalogCandidates }` |
| `src/runtime/action-loop-planner.js` | 75 | `runState.skillCatalogRanking = cloneValue(skillCatalogSelection.debug)` |
| `src/runtime/action-loop-planner.js` | 153 | `skillCatalogRanking: cloneValue(skillCatalogSelection.debug)` in `planner-requested` step |
| `src/runtime/action-loop-planner.js` | 485-516 | `resolvePlannerSkillCatalog` — passes `request.prompt` as ranker `prompt` param |
| `src/runtime/state.js` / `research-state.js` | 33, 155 / 505 | `skillCatalogRanking` runState field + reads |

The full call chain still alive in production:

```
action-loop-planner.js:63
  → resolvePlannerSkillCatalog({ prompt: request.prompt, ... })
  → selectSkillCatalogCandidates({ prompt, ... })
  → rankSkillManifests({ prompt, ... })
  → tokenizeSkillCatalogText(prompt) [regex /[^a-z0-9_+-]+/i strips Chinese]
  → score=0 for all skills
  → ranked.filter(score>0) = []
  → plannerAgentSkills = []
action-loop-planner.js:85
  → buildPlannerPrompt({ availableAgentSkills: [], ... })
  → planner-prompt.js:198
  → loopState.bundledAgentSkills = []
  → AI sees empty catalog
```

Runtime is still autoranking the user prompt every cycle, then injecting
the top-K (or empty list) into `loopState.bundledAgentSkills`. Even though
`list_agent_skills` exists as a pull-mode tool, the empty `bundledAgentSkills`
in the prompt leads weak models (lite × Mandarin) to behave as if no skills
were available.

This is **push + pull hybrid**, which ADR-0013 Alt 1 explicitly rejected:

> *Hybrid push + pull. Runtime keeps recommending top-1 skill in prompt
> and exposes `list_skills` for AI overrides. Rejected: still violates push
> principle. AI sees the recommendation and treats it as authority.*

Severity: HIGH. Surfaced by lite × Mandarin × long-form live evidence.
Audit-method tag: V13 (cross-language live test, missed by static grep).

User principle (locked 2026-05-07):

> *Skills 是英文 manifest;end user 中文输入,翻译应该是 AI 做不是 runtime。
> Runtime 直接拿用户 prompt 当 query 去英文 manifest 里 token 匹配,本身就是越权。*

This is also the architecture pattern Anthropic's own Skills system uses:
"Skills sit quietly in your skills directory without consuming context;
the AI loads them on demand." Today's agrun runtime auto-loads up to top-K
into the planner prompt every cycle, defeating that pattern.

## Decision

**Skill catalog ranking is AI-tool-only.** Runtime never auto-ranks the
user prompt against skill manifests. Runtime never injects ranked top-K
into the planner prompt. Skill discovery happens exclusively through the
`list_agent_skills(query)` tool, where AI provides the English capability
keyword.

Concrete contract (locked):

### 1. Delete auto-rank-on-user-prompt path

Delete or rewrite the following in `src/runtime/action-loop-planner.js`:

- Line 63-69: `resolvePlannerSkillCatalog({ prompt: request.prompt, ... })`
  call — replace with a non-ranking path that returns the policy-filtered
  full catalog (today: 6 skills) or an empty array if the host wants
  zero-injection mode. **No `prompt` argument. No tokenization. No scoring.**
- Line 75: `runState.skillCatalogRanking = cloneValue(skillCatalogSelection.debug)`
  — delete the runState field write entirely.
- Line 153: `skillCatalogRanking: cloneValue(skillCatalogSelection.debug)`
  inside `planner-requested` pushStep — delete the field.
- Line 485-516: `resolvePlannerSkillCatalog` function body — rewrite to
  return `{ skills: policyFilteredManifests, debug: { totalSkillCount, policyFilteredCount, policyFilteredReasons } }`.
  No call to `selectSkillCatalogCandidates` or `rankSkillManifests`.

### 2. Delete `runState.skillCatalogRanking` field

- `src/runtime/state.js:33` — remove from `createRunState` initial shape.
- `src/runtime/state.js:155` — remove from `cloneRunState`.
- `src/runtime/research-state.js:505-507` — delete the consumer that reads
  `runState.skillCatalogRanking.matches`. (Telemetry that *needs* skill
  engagement reads `runState.agentSkillContext.lastReadSkill` instead —
  mechanism already in place per ADR-0013.)

### 3. Keep `availableAgentSkills` as the un-ranked full catalog

`buildPlannerPrompt({ availableAgentSkills })` keeps receiving the full
policy-filtered catalog so:

- The `loopState.bundledAgentSkillCount` figure remains accurate.
- Compact catalog summary (`toSkillCatalogCompact`) is rendered when no
  skill is active. **This compact view is by-name only** — AI sees skill
  names + brief descriptions, not scores, not ranked top-K, not "this
  one is best for you" runtime opinion.
- AI still has free choice to call `list_agent_skills(query)` for richer
  filter, or `read_agent_skill(skillId)` to load.

This preserves ADR-0013 design principle 6 (score is runtime detail, not
AI surface) and principle 1 (English-only catalog convention).

**Trade-off acknowledged:** Today's catalog has 6 skills × ~200 tokens
each compact = ~1200 tokens per cycle. When catalog grows past ~50 skills,
the compact-everyone-every-turn approach becomes costly. Mitigation path
(out of scope for this ADR): `bundledAgentSkills` becomes opt-in via
`runtimeConfig.skillCatalogInjection: "compact" | "names_only" | "off"`,
default `"compact"` while catalog is small. This is a future ADR.

### 4. Keep `rankSkillManifests` / `selectSkillCatalogCandidates` / `tokenizeSkillCatalogText` as host-pluggable utility exports

These functions stay exported from `src/index.js` as **opt-in utilities**
for hosts that want to build their own custom skill ranker (via
`runtimeConfig.skillCatalogRanker`). The default runtime path no longer
calls them.

Tokenizer behavior (ASCII-only regex) is **not fixed in this ADR**. Hosts
that pass a non-English prompt to these utilities still get score=0; that
is now a host concern, not a runtime concern, because the runtime no
longer uses these utilities by default.

If a future host needs CJK-aware ranking for a custom catalog of 200+
English skill manifests with non-English prompts, the right fix is for
that host to install a custom `skillCatalogRanker` (e.g. Intl.Segmenter,
embedding-based, or LLM-translation pre-step). agrun runtime stays
mechanism-only.

### 5. `list_agent_skills` is the only AI-driven discovery surface

No new tool. ADR-0013 PR 2 already shipped it. AGRUN-229 is purely a
deletion ADR — completes ADR-0013 PR 1's unfinished cleanup.

## Tool surface (no public API change)

| Surface | Status |
|---|---|
| `list_agent_skills(query?)` action | **Unchanged** (ADR-0013 PR 2) |
| `read_agent_skill(skillId)` action | **Unchanged** |
| `runtimeConfig.skillCatalogRanker` | **Unchanged** (host-pluggable; default unused) |
| `runtimeConfig.skillCatalogTopK` | **Deprecated** (no longer consumed by default path; kept for back-compat with custom rankers — rename in a later ADR) |
| `runtimeConfig.skillCatalogMaxK` | **Deprecated** (same as above) |
| `runState.skillCatalogRanking` | **Deleted** (engineer telemetry; replace with `runState.agentSkillContext` reads) |
| `result.diagnostics.skillCatalogRanking` | **Deleted** if exposed (verify in PR 1) |
| `bundledAgentSkills` in planner prompt | **Unchanged shape** — still compact summary, just not ranked |

No public-facing host config breaks. No `agrun_docs/public-runtime-api.md`
change. `skillCatalogRanker` hosts keep working (their custom function
still gets called via the host-set `selectSkillCatalogCandidates`); only
the **default** path stops calling the ranker.

## Alternatives

### Alt 1 — Make tokenizer CJK-aware (Intl.Segmenter)

Replace `[^a-z0-9_+-]+` regex with `Intl.Segmenter` for proper CJK word
segmentation. Mandarin prompts then produce real tokens that match English
manifest descriptions via cross-language overlap.

**Rejected.** This is the substring/CJK-bigram path the prior agent and
the first review iteration both proposed. It is still **runtime doing AI
work** — semantic translation between Chinese user intent and English
skill metadata. Even with perfect Chinese tokenization, "深度调研" tokens
will not naturally overlap with `deep-research-writer` English manifest
text (different languages, different word boundaries, different stems).

The user's principle is the right cut: **AI translates user intent into
English capability keywords; runtime never does language work.**

Alt 1 is a patch, not a fix.

### Alt 2 — Embedding-based default ranker

Replace token-overlap with semantic vector similarity. Solves Mandarin
score-0 issue, stays cross-language.

**Rejected.** Same root problem as Alt 1: still push (runtime auto-ranks
on user prompt). Adds embedding model dependency (cost, startup latency,
host config burden). Embedding ranking remains viable as the *internal*
score function of `list_agent_skills` once catalog grows past ~200 skills,
but that is invoked by AI's English query, not the user's prompt.

### Alt 3 — Auto-translate user prompt to English before ranking

Insert a translation LLM call before runtime skill ranking.

**Rejected** (already rejected by ADR-0013 Alt 3 with the same reasoning).
Doubles cost / latency. AI is the right place to do the translation, and
the AI is already invoked anyway. Better to let AI choose
`list_agent_skills` query directly.

### Alt 4 — Do nothing, document as known limitation

**Rejected.** The defect is reproducible on real lite × Mandarin runs.
Real users get a broken skill discovery flow because runtime push-rank
gives them an empty catalog. The fix is a 5-site delete; opportunity
cost of doing nothing exceeds the implementation cost.

### Alt 5 — Keep ranking in runtime but feed it a derived English keyword instead of raw user prompt

Runtime extracts English capability keywords from user prompt (regex,
heuristic, or short LLM call) and uses those for ranking.

**Rejected.** Brings back ADR-0017's topic-extraction anti-pattern under
a new name. AI must do this extraction; runtime cannot. Same push problem.

## Consequences

### Positive

- **ADR-0013 PR 1 acceptance is finally met.** `git grep -n "skillCatalogRanking"`
  in `src/` returns 0 hits.
- **Mandarin / Japanese / Korean / Arabic prompt parity.** Ranking is
  no longer in the user-prompt → catalog path; AI's own English
  `list_agent_skills` query drives discovery for any user language.
- **Push-mode count drops by 1.** Audit V13 closes. AGRUN-221 epic
  progresses.
- **Smaller planner prompt cycles when no skill is active.** No more
  `skillCatalogRanking.debug` clone in `planner-requested` pushStep
  metadata.
- **Inspector telemetry simplifies.** `SELECTED SKILL` continues to
  reflect `runState.agentSkillContext.lastReadSkill` (already correct
  per ADR-0013); the irrelevant `skillCatalogRanking` matches table
  goes away.
- **Hosts retain customization escape.** `runtimeConfig.skillCatalogRanker`
  still works for hosts who want their own ranker; default just stops
  using it.

### Negative / cost

- **Compact catalog injection still costs ~1200 tokens / cycle today**
  (6 skills × ~200 tokens). Acceptable while catalog ≤ 50 skills.
  Future config option `skillCatalogInjection` can shrink this.
- **Telemetry surface change.** Any host inspecting
  `runState.skillCatalogRanking` or `result.diagnostics.skillCatalogRanking`
  breaks. No known hosts depend on these (internal harness fields).
- **Test churn.** Estimated ~10-15 unit tests assert on
  `skillCatalogRanking` shape, ranking debug, `selectSkillCatalogCandidates`
  call counts. All need rewrite to assert ranking is **not** called and
  the field is **absent**.

### Risks

- **AI may not call `list_agent_skills` for prompts that should engage
  a skill** (e.g. user says "research X" but AI thinks it can answer
  cold). Mitigation: SKILL.md `description` / `tags` should include
  capability verbs ("research", "deep-dive", "report", "investigate").
  This is the same risk ADR-0013 identified; remains a SKILL.md authoring
  concern, not a runtime concern.
- **Lite models may need stronger system-prompt nudge to discover
  `list_agent_skills`.** The two-line system-prompt hint already exists
  ([planner-prompt.js:97-98](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner-prompt.js)); track
  via 4-cell live matrix. If lite × Mandarin still bypasses the tool
  after ADR-0020 ships, the fix is prompt-engineering the hint paragraph,
  not reinstating runtime push-rank.

## Rollback

If post-ADR-0020 4-cell matrix usable rate (lite × Mandarin × long-form)
drops below the pre-ADR-0020 baseline, revert AGRUN-229 PR commits.
Restore `resolvePlannerSkillCatalog` body and `skillCatalogRanking` field
from git history.

Rollback target: ADR-0013 PR 2 final state (push + pull hybrid). No
further regression possible because that hybrid is what we are leaving.

## Implementation cadence

Two sequential PRs under AGRUN-229. Each PR keeps `npm run check` +
4-cell live matrix green before merging.

### PR 1 — Delete auto-rank-on-user-prompt path

Files:
- `src/runtime/action-loop-planner.js` — rewrite `resolvePlannerSkillCatalog`
  to return policy-filtered manifests without ranking; delete line-25 import
  if `rankSkillManifests` / `selectSkillCatalogCandidates` are no longer
  used in this file; delete line-75 `runState.skillCatalogRanking` write;
  delete line-153 `skillCatalogRanking` from `planner-requested` step.
- `src/runtime/state.js` — delete `skillCatalogRanking` from
  `createRunState` and `cloneRunState`.
- `src/runtime/research-state.js` — delete the `runState.skillCatalogRanking`
  reader (lines 505-507) and refactor any dependent inspector serializer.
- Tests:
  - `test/unit/action-loop-planner.test.js` — drop assertions on
    `skillCatalogRanking` shape; add assertion that ranker is **not**
    called by default.
  - `test/unit/skill-catalog-ranking.test.js` — keep (utility tests
    survive); mark as host-utility-only via test description.
  - Concern tests touching `runState.skillCatalogRanking` — rewrite or
    delete.

Acceptance:
- [ ] `git grep -n "skillCatalogRanking" src/` returns 0 hits.
- [ ] `git grep -n "selectSkillCatalogCandidates\|rankSkillManifests" src/runtime/action-loop-planner.js` returns 0 hits.
- [ ] `npm run check` green.
- [ ] Lite × Mandarin × long-form 4-cell matrix re-run shows
      `bundledAgentSkillCount: 6` (or whatever the catalog size is)
      instead of `0` for Chinese prompts.

### PR 2 — Live matrix verify + dist rebuild + supersession

Files:
- `dist/agrun.js` rebuild (matches src after PR 1).
- `agrun_docs/live-tests/2026-05-07-skill-catalog-ai-tool-only.md` —
  new live evidence document showing:
  - Pre-ADR: `skill_catalog_ranking` 5×score=0 with Mandarin prompt.
  - Post-ADR: no `skill_catalog_ranking` block; `bundledAgentSkills`
    populated with full catalog; AI either calls `list_agent_skills`
    or proceeds without skill (depending on lite judgment).
- `task.md` — close AGRUN-229; mark ADR-0013 PR 1 acceptance finally met
  with cross-link to AGRUN-229.
- `agrun_docs/adr/0020-skill-catalog-ranking-is-ai-tool-only.md` (this
  file) — add post-merge "Verification" section with matrix results.

Acceptance:
- [ ] Live matrix lite × Mandarin × long-form shows skill catalog visible
      to AI (`bundledAgentSkills` populated) and AI's discovery flow is
      either tool-driven (`list_agent_skills` called) or skipped by AI's
      own judgment — no runtime push.
- [ ] `dist/agrun.js` rebuild passes; browser example still works.
- [ ] AGRUN-229 closed in `task.md`; ADR-0013 PR 1 acceptance line ticked.

## Non-goals

- This ADR does **not** redesign the `tokenizeSkillCatalogText` regex.
  It stays ASCII-only because it is now a host-utility default, not a
  runtime default path. Hosts that need CJK tokenization wire a
  custom `skillCatalogRanker`.
- This ADR does **not** add/remove SKILL.md authoring conventions.
- This ADR does **not** change `list_agent_skills` substring matcher
  behavior. Existing matcher already handles non-English query (per
  ADR-0013 line 99-100: "Substring match against name / description /
  tags, case-insensitive. Match is byte-level, no stop-word / tokenizer.").
- This ADR does **not** introduce `skillCatalogInjection` config (compact
  / names_only / off). That is a future ADR for when catalog size
  > 50 skills.
- This ADR does **not** address `STOP_WORDS` / `NOISE_RE` constants in
  `research-evidence-graph.js` — those are observation-extraction noise
  filters covered by ADR-0018 / AGRUN-227, separate concern.

## Confirmed decisions (locked 2026-05-07)

1. **Two sequential PRs**, smaller cadence than ADR-0013's three because
   ADR-0020 is purely deletion (no new tool surface). PR 1 deletes; PR 2
   verifies.
2. **Hard-cut deletion** of `runState.skillCatalogRanking` field. No
   deprecation period — the field is internal harness telemetry, no
   public-runtime-api.md mention, no host known to depend on it.
3. **Utility exports survive.** `tokenizeSkillCatalogText`,
   `rankSkillManifests`, `selectSkillCatalogCandidates` stay exported
   from `src/index.js` for host-pluggable custom rankers, even though
   the default runtime path stops calling them.
4. **Acceptance gradient.** Pre-ADR-0020 baseline = lite × Mandarin
   produces empty `bundledAgentSkills` (score=0 collapse). Post-ADR-0020
   target: same prompt produces full `bundledAgentSkills` (6 skills);
   AI uptake of `list_agent_skills` tool tracked separately.
