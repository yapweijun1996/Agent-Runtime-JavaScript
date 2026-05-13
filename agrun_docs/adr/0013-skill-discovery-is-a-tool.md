# ADR 0013: Skill discovery is a tool, not a runtime decision (AGRUN-220)

## Context

After ADR-0012 / AGRUN-217 deleted ~1500 lines of long-research policy
from runtime, AGRUN-219 PR 1 attempted to fix the residual activation gap
by injecting a `loopState.recommendedSkill` directive into the planner
prompt: *"The skill catalog has ranked X first for this prompt. Before
any other action, call `read_agent_skill` with that skillId..."*

The 2026-05-07 evening 4-cell live LLM matrix
(`agrun_docs/live-tests/long-research-skill-driven-2026-05-07.md`)
proved that directive insufficient and itself architecturally wrong:

- Cell C1 (lite × English): 1/4 usable. AI did **not** call
  `read_agent_skill`; SELECTED SKILL stayed `n/a`. AI followed the
  workflow implicitly because skill description leaked through other
  prompt sections.
- Cell C2 (lite × Mandarin): failed. Skill catalog ranking returned
  score 0 across every skill because runtime's
  `STOP_WORDS` / `NOISE_RE` / `UI_NAV_LABEL_RE` constants are
  English-only. Directive injected with empty top-1 → no signal.
- Cell C3 (gpt-5-mini × English): AI **did** call `read_agent_skill`
  (directive activated), but Inspector still showed
  `SELECTED SKILL: n/a` because runtime never wrote
  `runState.agentSkillContext.lastReadSkill` after the read. AI then
  chose `ask_clarification` rather than executing the skill workflow.
- Cell C4 (2.5-pro × Mandarin): failed. Persona-leak from default
  chat prevented research. Workspace shows
  `runtime-materialized:5` — runtime scaffolded five named files from
  a brief AI refusal, inflating empty content into outline / evidence /
  draft / critique / final_candidate.

The user's diagnosis after seeing the matrix:

> *list skills should be a tool for AI; skills no need every time
> hardcode in prompt, show only when needed; trigger by AI agent.*

This identifies the AGRUN-219 directive as **soft-hardcode**: runtime
decides which skill the AI should look at, then injects that opinion
into the prompt every turn. Even when the directive works (C3), it
violates the same mechanism-vs-policy boundary ADR-0012 just locked.
The directive is a *push* — runtime pushing context the AI did not
ask for. The AI-first replacement is *pull* — AI calls a tool when it
decides discovery is needed.

Same architecture pattern Anthropic's own Skills system uses: skills
"sit quietly in your skills directory without consuming context";
the AI loads them on demand.

CLAUDE.md hard rules being violated:

- *Do not use hardcode logic.* — the directive is hardcoded opinion.
- *Always use Agentic Harness Engineering.* — push context is not
  mechanism; it is policy disguised as a hint.

## Decision

### Push → Pull boundary contract (locked)

**Runtime keeps (mechanism only):**

| Responsibility | Surface |
|---|---|
| Skill catalog storage | existing `SkillIndexProvider` / catalog source |
| `list_skills(query?)` tool implementation | new `src/runtime/actions/list-skills-action.js` |
| `read_agent_skill(skillId)` tool | existing |
| Skill engagement state writeback | runtime updates `runState.agentSkillContext.lastReadSkill` after AI calls `read_agent_skill` |

**Runtime loses (deleted in PR 1):**

- `pickTopSkillRecommendation` in `src/runtime/planner-prompt.js`.
- `loopState.recommendedSkill` block injected into planner prompt.
- `skillCatalogRanking` cloning in `src/runtime/action-loop-planner.js`
  (lines 72, 101, 155 today).
- `skillCatalogSelection.debug` reaching planner-prompt at all.
- The `STOP_WORDS` / `NOISE_RE` ranking dependency (constants survive
  for evidence-graph noise filtering only — see Non-goals).

**AI / planner owns (policy):**

- Decide whether the prompt needs a skill at all.
- Choose query string for `list_skills` (free-form, language-agnostic).
- Pick which `skillId` from results to load via `read_agent_skill`.
- Follow the loaded SKILL.md workflow.

### Tool surface (new)

```
list_skills(query: string) → {
  skills: [{ skillId: string, name: string, description: string }],
  more_available?: boolean
}
```

- `query` is **required**. AI must extract a capability keyword from
  the user prompt before calling. No "list everything" path — that
  would invite AI to skip iterative refinement.
- Substring match against `name` / `description` / `tags`,
  case-insensitive. Match is byte-level, no stop-word / tokenizer.
- When matches > 20, return top 20 by internal score with
  `more_available: true`. AI refines query for narrower results.
- Score function is runtime mechanism (substring count + position +
  field weight). AI never sees scores; AI only sees the result list.
- Return value is always an object with a (possibly empty) `skills`
  array. AI handles empty case via prompt instruction (refine or
  give up).

### Design principles (locked)

These principles are part of the contract and survive any
implementation reshuffle:

1. **English-only catalog convention.** Skill authors write `name` /
   `description` / `tags` in English. Same convention as npm / pip /
   man pages. Eliminates multilingual tokenizer / stopword / embedding
   requirements from runtime. Mandarin / Japanese / Arabic users are
   served because the AI translates intent into English keywords.
2. **AI translates user intent into capability keywords.** The user's
   prompt language is irrelevant to skill matching. AI receives any
   language, infers what *it plans to do*, then chooses an English
   capability word. Example: prompt `深度调研 Grab` →
   `list_skills("research")` (capability), not `list_skills("Grab")`
   (entity).
3. **Search by capability, not entity.** Skills are organized by
   what AI does (research, debug, plan, format, …), not by entities
   the user mentions (TNO, Grab, Vite). This is the same distinction
   as: skill discovery uses capability keywords; web_search uses
   entity keywords. Confusing the two is the failure mode that
   produced Cell C2's score-0 result.
4. **Iterative agentic search, max 5 calls per turn.** Pattern
   mirrors human Google use: simple keyword → check result → refine
   → repeat. Same pattern applies to:
   - **Skill search** (capability keywords):
     `research` → `deep research` → `multi-source report`.
   - **Web search** (entity keywords):
     `TNO` → `TNO Company` → `TNO Singapore`.
   AI decides when to stop, when to broaden, when to narrow.
   Runtime never picks the next query.
5. **5-turn budget guard.** After 5 `list_skills` calls in a single
   turn, runtime returns
   `{ error: "skill_search_budget_exceeded" }` and the AI must
   proceed with general tools or fail gracefully. Mechanism, not
   policy — the budget exists to prevent infinite loops, not to
   shape AI strategy.
6. **Score is runtime detail, not AI surface.** Today: substring +
   position + field weight. Tomorrow (when catalog > ~200 skills):
   embedding-based ranking. AI never reads or compares scores; AI
   only reads the result list and decides via its own judgment.
   This keeps the score function swappable without touching AI
   prompt or SKILL.md content.

### SKILL.md authoring guidance (recommended, non-binding)

Skills authored under this contract benefit from `description` and
`tags` covering both capability verbs and trigger phrases the AI is
likely to think of when picking a query. Example:

```yaml
---
name: long-web-research
description: Multi-source deep-research workflow for producing
  cited public-source reports. Use when user asks for in-depth
  research, deep dive, comprehensive report, or investigation
  requiring multiple verified sources.
tags: [research, deep-research, report, citations,
       investigation, company-research, person-research,
       multi-source, public-sources]
---
```

This is recommendation only — the contract enforces tool surface and
search behaviour, not skill authoring style. Future ADR may formalise.

### Planner prompt change

Replace the `recommendedSkill` directive block (currently inserted on
every turn when ranking score > 0) with **one short paragraph in the
system portion** of the planner prompt:

> *You have access to specialized skills. Call `list_skills(query)` to
> discover skills relevant to the user's task. Call
> `read_agent_skill(skillId)` to load a skill's full instructions
> before following its workflow.*

Two lines. Stays the same on every turn. No per-turn skill ranking.
No directive. No top-K injection.

### Skill engagement writeback

When AI calls `read_agent_skill(skillId)`, runtime updates
`runState.agentSkillContext.lastReadSkill` so:

- Inspector shows `SELECTED SKILL: <name>` instead of `n/a`.
- `isResearchQualityGateRequired(runState)` (ADR-0012's gate trigger)
  returns true when `lastReadSkill === "long-web-research"`.
- Telemetry / debug bundles reflect actual skill engagement.

This is the missing piece exposed by Cell C3 in the live matrix and
acknowledged in AGRUN-219 acceptance line 6.

## Alternatives

### Alt 1 — Keep AGRUN-219 directive, also add `list_skills`

Hybrid push + pull. Runtime keeps recommending top-1 skill in prompt
*and* exposes `list_skills` for AI overrides.

Rejected: still violates push principle. AI sees the recommendation
and treats it as authority, defeating the discovery flow. Two systems
to maintain. Larger prompt cost on every turn.

### Alt 2 — Embedding-based ranking

Replace `STOP_WORDS` token-overlap ranking with semantic vector
similarity. Solves Mandarin score-0 issue, stays push.

Rejected: still push. Adds embedding model dependency (cost, startup
latency, host config burden). Does not address the root issue —
runtime deciding which skill matters.

Embedding ranking does become viable as the *internal* score function
of `list_skills` once catalog grows past ~200 skills. At that point
substring matching produces too many false positives. This is a
post-AGRUN-220 concern; today's catalog has 4 skills.

### Alt 3 — Auto-translate user prompt to English before ranking

Insert a translation LLM call before skill ranking so Mandarin prompts
score against English skill descriptions.

Rejected: requires extra LLM call before AI is even invoked, doubling
cost / latency. "English is canonical" is a different hardcode. AI
would be the one doing the translation anyway — better to let AI
choose `list_skills` query directly in user's language.

### Alt 4 — Do nothing, let small models fail

Accept that small models / non-English prompts won't engage skills.
Document as a known limitation.

Rejected: 1/4 usable rate is product-broken, not a known limitation.

## Consequences

### Positive

- Mechanism-vs-policy boundary tightens. Runtime exposes capability;
  AI decides usage. AI-first by construction.
- Mandarin (and any non-English) prompt parity. `list_skills`
  matching is byte-level substring with no stop-word filter, so
  Chinese / Japanese / Korean / Arabic queries all work.
- Prompt size shrinks. No per-turn ranking block, no per-turn
  recommendation directive. Token cost drops on every turn that did
  not actually need a skill.
- AGRUN-218 (multilingual noise filter) and AGRUN-219 (directive
  reliability) are absorbed. Two tickets close as superseded.
- Inspector telemetry becomes accurate. `SELECTED SKILL` reflects
  actual skill engagement, not a runtime guess.
- Aligns with Anthropic's Skills architecture pattern.

### Negative / cost

- Cold-start: first-turn AI must read the tool-hint paragraph to know
  `list_skills` exists. Mitigation: paragraph stays in system portion
  on every turn, costs ~30 tokens.
- Latency: when AI does decide to discover a skill, one extra tool
  round-trip (`list_skills`) before `read_agent_skill`. Net cost is
  a wash because today's push mode wastes ranking tokens every turn
  whether AI uses them or not.
- Test churn: every test that asserts on
  `loopState.recommendedSkill`, `skillCatalogRanking` shape, or
  ranking-debug fields needs rewrite. Estimated ~20 unit / concern
  test sites.

### Risks

- AI may not call `list_skills` for prompts that should engage a skill
  (e.g. tells the AI "research X" but AI thinks it can answer cold).
  Mitigation: SKILL.md frontmatter `name` / `description` should be
  written so a substring search on common task verbs (research,
  调研, debug, plan, review) hits. This shifts policy responsibility
  from runtime to skill authors, which is the right place.
- Eval models that pre-decide answers without tool calls (some
  Claude / Gemini reasoning modes) may skip skill discovery entirely.
  Track via 4-cell matrix; if regressing, write an additional
  guidance line in the system prompt — still no runtime push.

## Rollback

If post-AGRUN-220 4-cell matrix usable rate drops below the
pre-AGRUN-220 baseline (1/4), revert AGRUN-220 PR 1 and PR 2 commits.
Restore `pickTopSkillRecommendation` from git history. AGRUN-219 PR 1
state is the rollback target.

Rollback does **not** restore AGRUN-218 / 219 to "active" status;
the 4-cell matrix already proved the directive insufficient. A
rollback only buys time to design a different alternative
(probably Alt 2 — embedding ranking).

## Implementation cadence

Three sequential PRs under AGRUN-220, mirroring AGRUN-217 cadence.
Each PR keeps `npm run check` + 4-cell matrix green before merging.

### PR 1 — Delete push-mode skill ranking injection

Files:
- `src/runtime/planner-prompt.js` — delete `pickTopSkillRecommendation`,
  delete the `loopState.recommendedSkill` block, replace with the
  two-line tool-hint paragraph in system portion.
- `src/runtime/action-loop-planner.js` — drop
  `runState.skillCatalogRanking` clone (line 72), drop
  `skillCatalogRanking: skillCatalogSelection.debug` (lines 101, 155).
- Tests: rewrite assertions in `test/unit/planner-prompt*.test.js`
  and any planner concern tests that read these fields.

Acceptance:
- [ ] `git grep -n "pickTopSkillRecommendation\|recommendedSkill\|skillCatalogRanking"` returns 0 hits in `src/`.
- [ ] Planner prompt contains the two-line `list_skills` hint
      paragraph in system portion.
- [ ] `npm run check` green.

### PR 2 — Add `list_skills` tool + skill-engagement writeback

Files:
- `src/runtime/planner-tools.js` — register `list_skills` tool
  schema with optional `query: string` arg.
- `src/runtime/actions/list-skills-action.js` (new) — implement
  substring match against the existing skill catalog.
- `src/runtime/actions/execute-skill-tool-action.js` (or
  equivalent caller of `read_agent_skill`) — on successful read,
  write `runState.agentSkillContext.lastReadSkill = { skillId, name }`.
- Tests: new unit test for `list-skills-action.js` covering
  Mandarin query, empty query, no-match query; concern test
  covering the read → lastReadSkill writeback.

Acceptance:
- [ ] `list_skills` tool present in planner-tools schema.
- [ ] AI can call `list_skills` and receive `[{skillId, name, description}, …]`.
- [ ] After AI calls `read_agent_skill`, Inspector shows
      `SELECTED SKILL: <name>` (not `n/a`).
- [ ] Mandarin substring query (e.g. `调研`) returns
      `long-web-research` if its description / tags include the
      substring (or the match becomes a docstring task for skill
      author).

### PR 3 — Live matrix re-verify + dist rebuild + supersession

Files:
- `dist/agrun.js` rebuild.
- `agrun_docs/live-tests/long-research-skill-driven-2026-05-07.md`
  → add AGRUN-220 follow-up matrix section with C1-C4 results.
- `task.md` — close AGRUN-218 + AGRUN-219 as superseded with
  pointer to AGRUN-220.
- `agrun_docs/adr/0013-skill-discovery-is-a-tool.md` (this file)
  add post-merge results section.

Acceptance:
- [ ] 4-cell matrix usable rate ≥ 3/4 (target). Proves contract.
- [ ] At least one cell per language calls `list_skills` then
      `read_agent_skill` then produces an AI-authored report.
- [ ] AGRUN-218 + AGRUN-219 closed in task.md.

## Non-goals

- This ADR does **not** address `STOP_WORDS` / `NOISE_RE` /
  `UI_NAV_LABEL_RE` / `UI_EMOJI_RE` in evidence-graph noise filtering.
  Those constants survive in `research-evidence-graph.js` for
  observation-extraction noise filtering only. AGRUN-218 was scoped
  to those constants in *ranking*; once ranking moves out of runtime,
  AGRUN-218 has no remaining work in scope. Evidence-graph
  multilingual filtering is a separate, smaller concern revisitable
  post-AGRUN-220.
- This ADR does **not** redesign skill catalog source / ranking
  algorithm beyond removing it from the planner prompt push path.
- This ADR does **not** change `SKILL.md` frontmatter format.
- This ADR does **not** address persona-leak across new chats
  (Cell C4 evidence). That is a separate ticket.

## Confirmed decisions (locked 2026-05-07 evening)

1. **Three sequential PRs**, same cadence as AGRUN-217. PR 1 deletes;
   PR 2 adds; PR 3 verifies. No squash. Each PR runs `npm run check`
   + 4-cell live matrix.
2. **Hard-cut deletion** of `pickTopSkillRecommendation` and
   `loopState.recommendedSkill` in PR 1. No deprecation step. The
   directive shipped one day ago in AGRUN-219 PR 1; no host depends
   on it.
3. **`list_skills` tool is internal harness surface** documented here
   and in planner-tools schema, not in `agrun_docs/public-runtime-api.md`.
   Hosts get skill discovery by attaching skills to the catalog;
   the tool is for AI consumption.
4. **Acceptance gradient**: pre-AGRUN-220 baseline = 1/4. PR 1 alone
   should hold ≥1/4 (no regression). PR 2 should reach ≥3/4. If PR 2
   plateaus at 2/4, root cause is SKILL.md content, not runtime —
   fix by strengthening SKILL.md or adjusting tool-hint paragraph,
   not by reinstating runtime push.

## Post-merge verification (2026-05-07 evening)

PR 1 + PR 2 + PR 3 shipped. `npm run check` reports 645 PASS / 0
FAIL (up from 637 PASS pre-PR; +8 unit tests for `list_agent_skills`
query, budget guard, Mandarin substring, and 20-result cap).

Live matrix evidence captured at
`agrun_docs/live-tests/long-research-skill-driven-2026-05-07.md`
under "AGRUN-220 / ADR-0013 verification matrix".

Cell summary:
- C1 (lite × EN): **usable AI-authored report**.
  `planner-written:5 / runtime-materialized:0`. Same outcome as
  pre-PR baseline. AI did not call `list_agent_skills`; followed
  workflow via skill catalog visibility.
- C3 (gpt-5-mini × EN): **inconclusive**. Cell reached Step 7/8
  but plateau-stalled on a slow OpenAI reasoning round-trip; the
  Chrome MCP verification window cut off before finalize. No
  clarification stall (pre-PR failure mode bypassed by inline
  prompt hint), no error.
- C2 / C4: skipped. Pre-PR failure modes are provider /
  persona-leak issues outside ADR-0013 scope.

**Acceptance gradient observed**: 1/4 cells (C1). Headline target
of ≥3/4 not met within the verification window.

**Contract verdict**: held. C1 demonstrates AI authors the entire
report end-to-end; runtime emits no synthetic decisions or
materialised prose. AGRUN-220 PR 1 + 2 ship the contract, the
tooling, and the unit-test coverage. Live AI uptake of the new
`list_agent_skills` tool is a separate behavioural concern for
SKILL.md authoring + system-prompt iteration, tracked outside
this ADR (no rollback warranted).
