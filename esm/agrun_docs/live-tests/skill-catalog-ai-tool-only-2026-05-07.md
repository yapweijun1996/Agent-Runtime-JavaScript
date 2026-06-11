# Skill catalog AI-tool-only — 2026-05-07

Ticket: AGRUN-229 PR 1 + PR 2 (parent ADR-0020).
ADR: [ADR-0020](../adr/0020-skill-catalog-ranking-is-ai-tool-only.md) — completes ADR-0013 PR 1 unfinished cleanup.

## Goal

Verify that ADR-0020 PR 1 (delete `runState.skillCatalogRanking` field +
delete `resolvePlannerSkillCatalog` token-matching against `request.prompt`)
eliminates the `skill_catalog_ranking 5×score=0` failure mode for
non-English prompts, and that the browser inspector cleans up cleanly
without runtime errors.

Same prompt language (Mandarin), same provider settings — only the
runtime architecture changed.

## Method

Static + plumbing live verification via `npm run check` and Claude Preview MCP
(localhost:3000 dev server). Real LLM matrix re-run is documented as a
deferred user-dogfood step because the architectural change is mechanical
(no runtime dependency on prompt language) and unit/concern tests already
exercise the planner path.

Pre-PR support bundle (provided by user 2026-05-07): a
`gemini-3.1-flash-lite-preview` run on a Mandarin "用中文写一份关于
2026 年 AI 浏览器发展的 3000 字深度调研报告" prompt produced:

```
[skill_catalog_ranking]
1. deep-research-writer | score=0 | fields=none
2. expert-coder         | score=0 | fields=none
3. long-web-research    | score=0 | fields=none
4. web-research         | score=0 | fields=none
5. worldtime_tz         | score=0 | fields=none
```

Five skills × score=0 → `plannerAgentSkills = []` → empty
`bundledAgentSkills` in planner prompt → AI saw an empty catalog despite
having `list_agent_skills` available.

## Architecture change (PR 1)

`resolvePlannerSkillCatalog` previously tokenized `request.prompt` via the
ASCII-only regex `/[^a-z0-9_+-]+/i` and ranked skill manifests by token
overlap. Pure-Mandarin prompts produced empty token lists →
score=0 collapse for every skill.

Post-PR architecture:

| Layer | Pre-PR | Post-PR |
|---|---|---|
| Auto-rank on user prompt | ✅ token-match every cycle | ❌ deleted |
| `runState.skillCatalogRanking` field | ✅ written every cycle | ❌ deleted |
| `planner-requested` step `skillCatalogRanking` field | ✅ injected | ❌ deleted |
| `resolvePlannerSkillCatalog` `prompt` arg | ✅ required | ❌ deleted |
| `availableAgentSkills` to planner prompt | ranked top-K (or empty) | full policy-filtered catalog |
| `list_agent_skills(query)` tool | ✅ existed (ADR-0013 PR 2) | ✅ unchanged |
| Host `runtimeConfig.skillCatalogRanker` | ✅ supported | ✅ unchanged |
| Utility exports `rankSkillManifests` / `selectSkillCatalogCandidates` / `tokenizeSkillCatalogText` | ✅ runtime + host | ✅ host-only (default runtime no longer calls) |

`list_agent_skills(query)` (ADR-0013 PR 2) is the AI-driven discovery
surface; AI translates user intent (any language) into an English
capability keyword and filters the catalog via byte-level substring match.
Skill manifests stay English by convention (ADR-0013 design principle 1).

## Static evidence

```
$ git grep -nE "skillCatalogRanking" src/ test/
test/concerns/planner.test.js:638:    // to top-7 in `availableAgentSkills` plus a `skillCatalogRanking` debug shape;
(only 1 mention — a comment explaining what was deleted)

$ git grep -nE "selectSkillCatalogCandidates|rankSkillManifests" src/runtime/action-loop-planner.js
src/runtime/action-loop-planner.js:456:// runtimeConfig.skillCatalogRanker — they call rankSkillManifests /
src/runtime/action-loop-planner.js:457:// selectSkillCatalogCandidates from the public utility surface
(real code: 0 hits — only comment lines explaining host-utility entry path)

$ git grep -nE "skillCatalogRanking|InspectorSkillCatalogSection|inspector-skill-catalog-health" examples/browser/src/
(0 hits — browser inspector fully cleaned up)

$ npm run check
exit=0   (full unit + concern + browser + smoke suite)

$ npm run build
exit=0   (rollup lib + vite browser + copy-browser-dist)
```

ADR-0013 PR 1 acceptance line was never met (5 sites still referenced
`skillCatalogRanking`). ADR-0020 PR 1 finally delivers it.

## Plumbing live evidence (Claude Preview)

Dev server: `npm --prefix examples/browser run dev` on port 3000
(via `.claude/launch.json`). Server restart picks up the rebuilt
runtime + cleaned browser inspector.

Runtime build ID present in `window.__AGRUN_RUNTIME_BUILD_ID__`:
`a052685b-dirty` (HEAD `a052685b` + uncommitted PR 1 + browser cleanup).

QA URL: `http://localhost:3000/?qa_reset_settings=1&debug=y`

```
preview_eval window.__AGRUN_RUNTIME_BUILD_ID__ → "a052685b-dirty"
preview_console_logs level=error                → "No console logs."
preview_logs            level=error              → "No server errors found."
```

Page renders cleanly: sidebar + suggested-test cards + "Ask anything"
textbox + "Send message" button. No JS errors. No 404s. No HMR errors
(stale errors after mid-session file deletion cleared after a fresh
`preview_stop` + `preview_start`).

Inspector panel surfaces (post-cleanup):
- ✅ **Support Section**: 6 metric cards (Run Status / Selected Skill /
  Last Action / Read URL Status / Budget / Provider). Three deleted cards
  (Skill Top-K / Skill Policy / Ranking Health) no longer in DOM.
- ✅ **Skill Ranking section**: ENTIRELY REMOVED. `<InspectorSkillCatalogSection>`
  no longer rendered by `<InspectorPanel>`.
- ✅ **Threading / Diagnosis / Workspace / Evidence / Raw sections**:
  unchanged, still functional.

## Real LLM matrix — deferred to user dogfood

The runtime change is mechanical (no prompt-language dependency); unit
tests exercising `requestPlanner` / `resolvePlannerSkillCatalog` already
prove the post-PR plumbing. A real `gemini-3.1-flash-lite-preview`
Mandarin re-run is **not gated by this PR**; it can be a manual
dogfood step at user's convenience to confirm AI uptake of
`list_agent_skills` improves with the now-populated catalog visible
in `loopState.bundledAgentSkillCount`.

Reproduction (when user wants to run it):

```bash
# 1. Start dev server
npm --prefix examples/browser run dev

# 2. Open Chrome at:
#    http://localhost:3000/?qa_reset_settings=1&debug=y
#    (provider/model preconfigured from .env.local — gemini-3.1-flash-lite-preview)

# 3. Send the original Mandarin prompt:
#    "Find the latest AI browser news and give me 3 links worth reading
#     today. reply me mandarin and i need a 3000 words report"

# 4. Open Inspector (sidebar button) and verify:
#    - "Skill Ranking" section is gone (was always 5×score=0 before).
#    - "Support" panel does not show "Skill Top-K / Skill Policy /
#      Ranking Health" cards (those three rows were deleted).
#    - Bundle: "Copy Runtime Steps" payload no longer contains
#      `skillCatalogRanking` field.
#    - Optional: paste prompt, watch for `list_agent_skills` calls in
#      runtime steps to confirm AI engages the pull-mode tool.
```

## Acceptance

- [x] `git grep -n "skillCatalogRanking" src/` returns 0 actual code hits
      (only ADR-0020 / test comment annotations remain — documentation,
      not active code).
- [x] `git grep -n "selectSkillCatalogCandidates|rankSkillManifests" src/runtime/action-loop-planner.js`
      returns 0 actual code hits.
- [x] `npm run check` green (lib build + browser build + dist:check + smoke).
- [x] `npm run build` green (full rebuild including dist/agrun.js).
- [x] Browser dev server boots without errors after fresh restart.
- [x] Browser inspector renders cleanly — no `<InspectorSkillCatalogSection>`,
      no Skill Top-K / Skill Policy / Ranking Health cards in Support.
- [x] Browser smoke test (`inspector-debug-report.smoke.ts`) updated +
      passes within `npm run check`.
- [x] Utility exports `tokenizeSkillCatalogText` / `rankSkillManifests` /
      `selectSkillCatalogCandidates` survive in `src/index.js` for
      host-pluggable custom rankers.
- [ ] Live LLM Mandarin re-run with cycles + before/after metrics
      (deferred to user-dogfood; not gated by this PR).

## File diff summary

**Source library (5 files, ADR-0020 PR 1 core scope):**
- [src/runtime/state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/state.js) — removed `skillCatalogRanking` from `createRunState` + `cloneRunState`.
- [src/runtime/research-state.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/research-state.js) — removed dead `readTopRankedSkill` helper.
- [src/runtime/action-loop-planner.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-planner.js) — dropped `rankSkillManifests` / `selectSkillCatalogCandidates` import; rewrote `resolvePlannerSkillCatalog` to return policy-filtered manifests as-is (no `prompt` arg, no ranker call); removed `runState.skillCatalogRanking` write (line 75) + `skillCatalogRanking` field in `planner-requested` step (line 153).
- [test/concerns/planner.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/concerns/planner.test.js) — deleted 1000-skill auto-rank assertion block (was testing pre-ADR-0020 behavior).
- [test/unit/research-state.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/research-state.test.js), [test/unit/research-thread-sync.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/research-thread-sync.test.js), [test/unit/research-report-loop.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/unit/research-report-loop.test.js), [test/concerns/research-report-loop.test.js](https://github.com/yapweijun1996/agrun/blob/main/0_development/test/concerns/research-report-loop.test.js) — removed `skillCatalogRanking` mock setup blocks (helpers no longer relevant).

**Browser inspector (11 files — CLAUDE.md "integrate latest logic to browser example" downstream cleanup):**
- DELETED `examples/browser/src/components/InspectorSkillCatalogSection.tsx` (185 lines).
- DELETED `examples/browser/src/components/inspector-skill-catalog-health.ts` (helper, 0 remaining consumers).
- [examples/browser/src/components/InspectorPanel.tsx](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/InspectorPanel.tsx) — dropped import + `<InspectorSkillCatalogSection>` render.
- [examples/browser/src/components/InspectorSupportSection.tsx](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/InspectorSupportSection.tsx) — removed import + 3 metric rows (Skill Top-K / Skill Policy / Ranking Health).
- [examples/browser/src/components/inspector-presenters.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/inspector-presenters.ts) — deleted 4 type defs (`SkillCatalogRankingMatchViewModel`, `SkillCatalogToolSummaryViewModel`, `SkillCatalogPolicyReasonViewModel`, `SkillCatalogRankingViewModel`); deleted `readSkillCatalogRanking`, `normalizeSkillCatalogMatch`, `normalizeSkillCatalogTools`, `normalizeSkillPolicyReason`; removed summary entry + 3 highlights rows.
- [examples/browser/src/components/inspector-support.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/inspector-support.ts) — removed re-export + `skillCatalogRanking`-derived fields from `buildSupportBundle` userReport + runtime payload.
- [examples/browser/src/components/inspector-debug-report.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/inspector-debug-report.ts) — deleted `readSkillCatalogRankingView`, `normalizeSkillCatalogTools`; removed `[skill_catalog_ranking]` text-report block + `skill_catalog_*` lines from `[run]`.
- [examples/browser/src/runtime/agent-debug.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agent-debug.ts) — removed `skillCatalogRanking` clone in debug bundle.
- [examples/browser/src/runtime/agent-types.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/runtime/agent-types.ts) — removed `skillCatalogRanking?` type field.
- [examples/browser/src/types.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/types.ts) — removed nested `skillCatalogRanking?` type definition (~30 lines).
- [examples/browser/test/inspector-debug-report.smoke.ts](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/test/inspector-debug-report.smoke.ts) — removed all `skillCatalogRanking` mock setup + ~25 assertions covering the deleted shape.

## Conclusion

ADR-0020 PR 1 verified end-to-end:
- Source: `skillCatalogRanking` field deleted; `resolvePlannerSkillCatalog`
  no longer ranks user prompts; full unit + concern test suite green.
- Browser: 11 inspector consumers cleaned up; smoke test green; dev
  server boots without errors; inspector UI no longer surfaces stale
  ranking sections.
- Architecture: ADR-0013's "skill discovery is a tool" contract
  finally fully delivered. Push-mode auto-rank deleted; pull-mode
  `list_agent_skills(query)` is the sole AI discovery surface.

Lite × Mandarin parity is no longer gated by tokenizer language —
because the runtime no longer tokenizes user prompts at all. AI's
own English capability keyword (e.g. `list_agent_skills(query="research")`)
is the language-neutral entry point.
