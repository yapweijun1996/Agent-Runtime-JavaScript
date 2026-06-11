# Skill catalog AI-tool-only — REAL LLM matrix 2026-05-08

Ticket: AGRUN-229 PR 2 follow-up — real `gemini-3.1-flash-lite-preview`
Mandarin run via chrome-devtools MCP.
ADR: [ADR-0020](../adr/0020-skill-catalog-ranking-is-ai-tool-only.md).
Prior evidence: [skill-catalog-ai-tool-only-2026-05-07.md](./skill-catalog-ai-tool-only-2026-05-07.md)
(static + plumbing).

## Goal

Verify ADR-0020 PR 1+2 architecturally fixes the
"`skill_catalog_ranking` 5×score=0 collapse" failure mode under the
EXACT prompt the user originally hit:

> "用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告"

This is pure Mandarin — pre-PR `tokenizeSkillCatalogText` regex
`/[^a-z0-9_+-]+/i` would strip every Chinese character as a separator,
producing 0 tokens, score=0 for every skill, and an empty
`bundledAgentSkills` list pushed to the planner prompt.

Same prompt, same provider, same model — only the runtime architecture
changed.

## Method

End-to-end live run via Chrome DevTools MCP against
`http://localhost:3000/?qa_reset_settings=1&debug=y&qa=adr0020-pr1-lite-zh-3000`.
Auto-approve initScript injected to handle web_search / read_url
approval prompts.

- Provider: `gemini`
- Model: `gemini-3.1-flash-lite-preview`
- Runtime build: `a052685b-dirty` (post-PR HEAD `b280e6a5` ≈ HEAD,
  built from PR 1 + PR 2 source).
- Run ID: `run-4`
- Wall time: ~2m 30s (cycle 1 → cycle 18 finalized).
- Screenshot: `skill-catalog-ai-tool-only-2026-05-08-final-answer.png`
  (full-page, attached alongside this doc).

## Results — Architectural acceptance ✅

The four push-mode surfaces ADR-0020 deletes are confirmed gone in
both runtime telemetry and browser inspector:

| Surface | Pre-PR | Post-PR (this run) |
|---|---|---|
| `[skill_catalog_ranking]` block in inspector text bundle | 5 entries × `score=0 \| fields=none` | **absent** ✅ |
| `runState.skillCatalogRanking` in `planner-requested` step detail | present every cycle | **0 mentions in 367 KB / 378 step events** ✅ |
| `loopState.bundledAgentSkillCount` shape | 0 (collapsed by ranking) | not surfaced — `availableActions` lists `list_agent_skills` directly ✅ |
| Inspector panel "Skill Ranking" section + Skill Top-K / Skill Policy / Ranking Health metric cards | rendered every turn | **DOM grep `pageContainsSkillRankingSection` / `Skill Top-K` / `Ranking Health` all return false** ✅ |

`evaluate_script` payload at run completion:

```json
{
  "runStatus": "Assistant is idle",
  "cycle": "18",
  "totalTokens": "6,835",
  "pageContainsOldSkillRanking": false,
  "pageContainsSkillTopK": false,
  "pageContainsRankingHealth": false,
  "pageContainsSkillRankingSection": false,
  "answerHas": {
    "mandarinReport": true,
    "sixSections": 6,
    "hasSources": true,
    "hasWorkspaceFiles": true
  }
}
```

`stepTypes` collected (38 distinct kinds across 378 step events):

```
run-started, cycle-started, phase-observe-{started,completed},
phase-orient-{started,completed}, continuity-resolved,
phase-decide-{started,completed}, phase-act-{started,completed},
phase-evaluate-{started,completed}, action-{executing,executed},
approval-resolved, read-url-{requested,failed},
observation-recorded, finalize, before-finalize-veto,
todo-state-mutated, todo-state-reconciled-on-terminal,
planner-{requested,responded,repair-requested,repair-failed,
fallback-skipped-duplicate,mode-resolved},
session-budget-breach, todo-plan-verifier-nudge,
provider-{requested,responded}, action, text, string, object
```

**Notably absent**: `skill-catalog-ranking-failed`,
`skill-policy-filtered` (only when manifests exist), and any
`skillCatalogRanking` field on `planner-requested`.

## ⚠️ Caveats — broader system is still broken

**Read this section first before celebrating.** The architectural acceptance
table above only proves the **specific surface** ADR-0020 deletes is gone.
The same 18-cycle run also exhibits multiple unhealthy signals that are
**outside ADR-0020 scope** but materially affect run quality. Honest
disclosure (corrected from prior turn's overclaim):

| Signal | Healthy target | This run | Status |
|---|---|---|---|
| Final-answer source | `planner_final` (AI's own) | **`runtime_finalize`** (runtime forced finalize on cycle 18 after AI failed) | ❌ |
| Cycles AI emitted finalize before runtime gave up | 1 | **17 attempts blocked by veto** | ❌ |
| `before-finalize-veto` count | < 5 | **23** | ❌ |
| `planner-repair-failed` | 0 | **14** | ❌ |
| `planner-fallback-skipped-duplicate` | 0 | **14** | ❌ |
| `session-budget-breach` | 0 | **9** | ❌ |
| Source quality (read_url) | strong / medium | **thin:2 / strong:0 / medium:0** (both `read_url` returned HTTP 502) | ❌ |
| `Selected Skill` | populated when prompt warrants it (深度调研 should match `deep-research-writer`) | **`n/a`** (AI never engaged any skill) | ⚠️ |
| `draft.md` size | ≥ user-requested word count (~3000 中文字) | **919 chars** (~25% of requested) | ❌ |
| Final answer source authoring | AI authored | **runtime_finalize re-prompt** generated the visible ~3000-char prose from sparse evidence + workspace stub | ❌ |
| `read_url` failure rate | < 30% | **10 attempts, ~80% failed (502 / unreachable)** | ⚠️ (network/service) |

**Honest read of what happened:**

1. AI saw populated `availableActions` (including `list_agent_skills` /
   `read_agent_skill`) and full skill catalog.
2. AI chose a general research workflow (`todo_plan` → `web_search` →
   `read_url` ×10) instead of loading any skill.
3. Most `read_url` calls returned 502 / unreachable; AI accumulated
   `thin:2` evidence and `strong:0`.
4. AI tried to `finalize` 17 times. Each attempt was blocked by
   `before-finalize-veto` (NOT from `final-response-quality` — that
   stays at 0 thanks to ADR-0019 PR 1; the vetoes come from
   `todo-state-required-completion` + `planner-repair-failed` +
   `planner-fallback-skipped-duplicate` chains, which are exactly the
   push-mode loops the prior audit V12 / ADR-0019 PR 2 / ADR-0021 / 0022
   were drafted to fix).
5. After 9 `session-budget-breach` triggers, runtime forced its own
   finalize (`runtime_finalize` source). The runtime re-prompted gemini
   with workspace + research context; gemini fabricated a polished
   ~3000-char Mandarin report **with thin source backing**. Most
   numerical claims (12.3亿用户 / 65% CAGR / 第一季度数据) are not
   grounded in the read_url results — they are LLM hallucinations made
   plausible by the report's structure.

**This is the SAME anti-pattern shape ADR-0019 PR 1 partially fixed**
(quality-veto loop) and that ADR-0019 PR 2 + ADR-0021 are scoped to
finish. ADR-0020 did NOT fix it; ADR-0020 only fixed the upstream
"empty bundledAgentSkills" cause that previously made things worse.

**Verdict on this run:**
- ✅ ADR-0020 specific surface (skillCatalogRanking deletion): verified.
- ❌ Run as a whole is **runtime-rescued, not AI-driven**, and
  **largely fabricated** rather than grounded.

## Why AI didn't engage any skill

- AI did **not** call `list_agent_skills` (count: 0).
- AI did **not** call `read_agent_skill` (count: 0).
- `Selected Skill: n/a` in inspector.

This is **partly** consistent with
[ADR-0013](../adr/0013-skill-discovery-is-a-tool.md) design principle 1
("AI decides whether the prompt needs a skill at all"), but on a
"深度调研报告" prompt this is also a **harness gap**: the system
prompt's `list_agent_skills` hint paragraph is in English; lite Mandarin
prompts may not connect "深度调研" to the English keyword "research"
without explicit nudging.

Possible levers (none implemented yet, all out of ADR-0020 scope):

- SKILL.md authoring: add common Chinese task verbs (`调研`, `研究`,
  `报告`) to `description` / `tags`. Per ADR-0013 design principle 2,
  this is the right place for language coverage — not runtime push-rank.
- System-prompt nudge: add a one-line Chinese hint to the
  `list_agent_skills` paragraph for non-ASCII prompts.
- Stronger model: gpt-5-mini and gemini-pro both engage skills more
  reliably on the same prompt; lite is on the edge.

## Pre-PR vs post-PR run shape

| Metric | User support bundle (pre-PR, prior agent's review) | Post-PR (this run, 2026-05-08) | Δ |
|---|---|---|---|
| Cycles | 24 | **18** | -25% |
| `before-finalize-veto` events (any source) | 36 | 23 | -36% |
| `planner-repair-failed` | 15 | 14 | -7% |
| `planner-fallback-skipped-duplicate` | 15 | 14 | -7% |
| `session-budget-breach` | 16 | 9 | -44% |
| `final-response-quality-repair` | n/a (post-ADR-0019 PR 1) | **0** | held |
| `skillCatalogRanking` in steps | every planner-requested | **0** | **-100%** ✅ |
| Final answer | 1512 chars (forced runtime_finalize, partial) | ~3000 chars rendered (forced runtime_finalize, fabricated) | longer but **same forced-finalize anti-pattern** |
| Final answer language | Mandarin | Mandarin | held |
| Final answer source | runtime_finalize (forced) | **runtime_finalize (forced)** | **same — NOT improved** |

**ADR-0020 specifically targeted `skillCatalogRanking` collapse → 0% remaining ✅.**

**What did NOT improve (on purpose — out of ADR-0020 scope):**
The remaining 23 `before-finalize-veto` + 14 repair-failed + 14
fallback-skipped + 9 budget-breach events are still here, slightly
reduced from pre-PR but not gone. They come from at least three other
push-mode anti-patterns the prior agent's review surfaced:

- audit V12 `todo-state-required-completion-veto` (ADR-0021 candidate)
- ADR-0019 PR 2 (still has `buildFinalResponseRepairInstruction` in two
  call sites — `runtime-finalize.js:134` + `action-loop-session-terminals.js:180`)
- `plan-validation-standalone-recovery` (ADR-0022 candidate)

Until those land, **runs on the same prompt will continue to be
runtime-rescued rather than AI-driven**, even though the visible answer
looks polished.

## Acceptance update

ADR-0020 PR 1+2's **specific surface** is verified. The broader
"system health" target (AI-driven completion of a Mandarin long-form
prompt) is **not** met by ADR-0020 alone — it requires the follow-up
ADRs above.

ADR-0020 PR 2 acceptance (literal lines from the ADR):

- [x] `git grep -n "skillCatalogRanking" src/` returns 0 actual code hits.
- [x] `git grep -n "selectSkillCatalogCandidates|rankSkillManifests" src/runtime/action-loop-planner.js` returns 0 actual code hits.
- [x] `npm run check` green.
- [x] `npm run build` green.
- [x] Browser dev server boots without errors after fresh restart.
- [x] Browser inspector renders cleanly without `<InspectorSkillCatalogSection>` / Skill Top-K / Skill Policy / Ranking Health surfaces.
- [x] Browser smoke test (`inspector-debug-report.smoke.ts`) updated + passes within `npm run check`.
- [x] Live LLM Mandarin re-run with cycles + before/after metrics — captured here, see Caveats section for honest read.

Acceptance lines from the ADR are met. **This does NOT mean the system
is healthy on this prompt**; it means the surface ADR-0020 was scoped
to delete is gone.

## Reproduction

```bash
# 1. Start dev server (vite, port 3000)
npm --prefix examples/browser run dev

# 2. Open browser at:
#    http://localhost:3000/?qa_reset_settings=1&debug=y&qa=adr0020-pr1-lite-zh-3000

# 3. (Optional) auto-approve script in DevTools console:
window.__autoApprove = setInterval(() => {
  const b = [...document.querySelectorAll('button')].find(b =>
    b.textContent.trim() === 'Approve' && !b.disabled);
  if (b) b.click();
}, 1500);

# 4. Send the prompt verbatim:
#    用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告

# 5. After ~2m30s, click "Copy Runtime Steps" + grep:
#    grep -E '"skillCatalogRanking|skill_catalog_ranking' steps.json
#    → expected: 0 matches
```

## Conclusion (corrected)

**Narrow scope (what ADR-0020 set out to fix):** ✅ verified.
- 0 `skillCatalogRanking` references in src/.
- Full unit + concern + browser smoke green.
- Browser inspector cleaned up.
- 0 `skillCatalogRanking` mentions in 367 KB / 378 step events of a
  real lite × Mandarin run.

**Broader system health on this prompt:** ❌ still broken.
- AI emitted finalize 17 times, all blocked by veto.
- `runtime_finalize` forced cycle 18 with sparse evidence
  (`thin:2 / strong:0 / medium:0`); the polished ~3000-char Mandarin
  answer is largely **runtime-fabricated**, not AI-grounded.
- 23 `before-finalize-veto` + 14 `planner-repair-failed` + 14
  `planner-fallback-skipped-duplicate` + 9 `session-budget-breach`
  remain. Same push-mode loop shape as ADR-0019 PR 1's pre-fix state,
  just with skill-ranking taken out.

**Honest framing for future readers:** ADR-0020 deleted ONE push-mode
surface. Three more (ADR-0019 PR 2 / ADR-0021 / ADR-0022) need to land
before lite × Mandarin × long-form runs are AI-driven instead of
runtime-rescued.

The harness no longer gates non-English prompts on a runtime-internal
**ranker** specifically. It still gates them on
`todo-state-required-completion-veto`, `runtime_finalize` repair
re-prompt, and `planner-fallback-skipped-duplicate` chains. Those are
the next targets.

## Amendment log

This document was rewritten on 2026-05-08 after the user pointed out
that the original phrasing
("verified end-to-end" / "AI-authored Mandarin report" /
"output quality is acceptable") was overclaiming. Original text framed
ADR-0020's narrow-scope success as broader system success, hid the
`runtime_finalize` forced finalize, hid the 919-char draft vs 3000-char
rendered answer gap, and excused the 23 vetoes / thin sources as
"out of scope" without flagging that the run was therefore unreliable.

Honesty is part of the audit trail. Do not bury bad numbers under
ADR-scope footnotes.
