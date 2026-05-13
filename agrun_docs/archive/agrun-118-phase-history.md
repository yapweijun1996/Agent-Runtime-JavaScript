# AGRUN-118 phase history

Archive of the 19-phase incremental refactor that split
`test/smoke.test.js` (~6230 lines, one giant `main()`) into 16
concern files under `test/concerns/`. After Phase 19 retired
the last pre-IIFE block, `main()` itself collapsed to a thin
orchestrator (~120 lines including the region map header).

Closed: 2026-04-26. Final state: `npm test` runs across 16
concerns + the unit suite + a thin smoke orchestrator.

This document is the historical record of why each phase happened
in the order it did and what each one taught. The active task
board (`task.md`) carries only a one-line summary.

---

## Acceptance closure

- ✅ Split smoke tests by concern: runtime, session, skills, providers, approval, memory.
- ✅ Keep helper modules in `test/helpers/`.
- ✅ `npm test` still runs all non-live tests.

---

## Phase 1 — region map (2026-04-26)

- Inserted a region map comment block at the top of `test/smoke.test.js`,
  above `main()`: 16 concern regions, line ranges, anchor descriptions,
  and a future-split priority list (compaction → memory → session →
  approval → planner → providers/web-search).
- Single source of truth strategy: one table beats scattered
  `// region:` markers, which would drift on every reorder.
- Verification: `npm test` still green.

## Phase 2 — first concern extraction (2026-04-26)

- Reflected and corrected: the original plan to extract `compaction`
  was flawed because that region lives inside the `withMockedFetch`
  IIFE and shares mock state — not a "minimal independent" template.
  Extracted `skills (worldtime)` instead (~11 lines, pre-fetch-mock,
  zero shared state).
- New file: `test/concerns/skills-worldtime.test.js`. Followed the
  `test/unit/*.test.js` require-at-load contract; failures
  `process.exit(1)`.
- main() body replaced with pointer comment; `withMockedDate`
  import retained (planner region still consumed it).
- Updated split order in the region map: runtime (basic) →
  skills (hooks/limits) → lift `withMockedFetch` to helpers/ →
  IIFE-internal concerns.

## Phase 3 — runtime (basic) extraction (2026-04-26)

- New file: `test/concerns/runtime-basic.test.js` (~155 lines).
  Covers echo / memory / fallback routing, skill execution +
  canHandle failures, web_search routing safety, and
  `runtime.getState()` introspection.
- ~125 lines of inline code (original 225..348) replaced with a
  single pointer comment.
- Dependencies: only `createRuntime, echoSkill, memorySkill,
  fallbackSkill, timeSkill, webSearchSkill, openaiBrowserSkill`
  (all from dist) — no fetch mock, no session/memory store.

## Phase 4 — skills (hooks/limits) extraction (2026-04-26)

- New file: `test/concerns/skills-hooks-limits.test.js` (~190 lines).
  Covers planner→task chain via `continueWith`, orient/evaluate
  hook plumbing, `SKILL_ORIENT_ERROR` / `SKILL_EVALUATE_ERROR`
  error sources, and `MAX_STEPS_EXCEEDED` gate.
- `continueWith` import dropped from smoke.test.js (now
  consumer-less).
- All pre-fetch-mock concerns now extracted. Next phase had to lift
  `withMockedFetch` to `test/helpers/` first, otherwise the IIFE-
  internal concerns could not be split independently.

## Phase 5 — research (2026-04-26)

- Design document landed at
  `agrun_docs/agrun-118-phase-5-mocked-fetch-extraction.md`.
- Key findings:
  - `mockState` only carries one field
    (`geminiProxyApprovalPlannerCalls`), zero IIFE-external readers.
    Helper still exposes the `(mockState) => …` callback signature
    so future per-concern extractions can assert on counters.
  - 4 internal helpers must move with `withMockedFetch`:
    `assertGeminiProxyRequestIsServerAuthenticated`,
    `createGeminiGroundingMockResponse`,
    `createGeminiProxyGenerateResponse(body, mockState)`,
    `createMockGeminiSseResponse`.
  - The 3 nested `withReadUrl*MockedFetch` wrappers do NOT share
    `mockState`; deferred to Phase 16.

## Phase 6 — withMockedFetch extraction (2026-04-26)

- New file: `test/helpers/mocked-fetch.js` (3072 lines). Encapsulates
  `withMockedFetch(async (mockState) => …)` + the 4 Gemini proxy
  internal helpers + `planToolEnvelope` / `sectionSpec` (the latter
  two surfaced as missing on the first dry-run because the hoisting
  assumption was wrong; recorded as "lessons learned" in the design
  doc).
- smoke.test.js dropped from ~6000 lines to 3015 (-2985), keeping
  only `require("./helpers/mocked-fetch")` + an IIFE signature
  change to `async (_mockState) =>`.
- Dead-import cleanup: 12 helper symbols (`createMockDataUrlResponse`,
  `isPlannerRepairJudgeRequest`, `isCompactionRequest`,
  `isGeminiPlannerRequest`, `isGeminiSemanticJudgeRequest`,
  `normalizeOpenAIMessageContent`, `readSessionContextMessage`,
  `buildPlannerRepairJudgeResponse`, `assertPlannerSystemPrompt`,
  `assertPlannerPrompt`, `readPlannerLoopState`,
  `readLastNonEmptyLine`) removed from smoke.test.js — every one of
  them was uniquely consumed by helpers that moved.

## Phase 7 — compaction concern + concurrency-safety template (2026-04-26)

- New file: `test/concerns/compaction.test.js` (~95 lines). Internally
  uses `withMockedFetch(async (_mockState) => …)` to construct
  `compactionRuntime`, verifying `sessionPolicy`-triggered compaction
  and post-compaction `session_memory` recall.
- **Concurrency bug discovered**: phases 2-6 used `require()` with
  fire-and-forget `run().catch(…)`, which raced `main()` for
  ownership of `global.fetch`. Whoever mutated first won, causing
  the compaction concern to fail under `npm test` while passing in
  isolation.
- **Unified concurrency pattern**: every concern file now exports
  `module.exports = { run }; if (require.main === module) run()…`,
  and smoke.test.js's tail wires `main()` + each concern in a
  serial `(async () => { await main(); await concern.run(); ... })()`.
  Guarantees that `withMockedFetch` / `withMockedDate` never stomp
  `global.fetch` / `global.Date` across overlapping contexts.
- Phases 2/3/4 missed this bug by accident — their globals (Date /
  routing) had no write conflict with `main()`.

## Phase 8 — memory concern (2026-04-26)

- New file: `test/concerns/memory.test.js` (~230 lines). Merges the
  region map's "memory (recall)" + "memory (overflow)" into one
  concern; recreates `sessionRuntime` (skills = memory + openai/
  gemini browser + web-search + fallback) instead of depending on
  main()'s closure.
- Coverage: seeded session recall, auto_extract slot=car_color,
  preference + decision extraction, ambiguous prompts NOT writing
  fact, broken fact-extract skill isolating memory,
  `createInMemorySessionStore` + a large note degrading inside
  prompt budget, `PROMPT_BUDGET_EXCEEDED` guardrail.
- 122-line recall + 55-line overflow inline blocks replaced with
  pointer comments. The `reopenedSession` / `isolatedSession` block
  in between stayed (it depends on prior `session` / `sessionSecond`,
  belongs to session concern, Phase 9).
- Dead-import cleanup: `createInMemorySessionStore` removed from
  smoke.test.js's top-level require (sole consumer was now the
  memory concern).
- Concurrent event: this phase landed alongside AGRUN-212a Phase G.
  The first attempt (commit `99977195`) accidentally bundled 212a
  files due to staging contention; reset + re-committed cleanly.

## Phase 9 — session (continuity + reopen + isolated) (2026-04-26)

- New file: `test/concerns/session.test.js` (~390 lines). Recreates
  `sessionRuntime` and runs the full session flow:
  hello/memory/usage, cumulativeUsage, getHistory/getMemory shape,
  continuity planner-requested step, dynamic-goal clarification,
  topic promotion, clarification reset, option resolution, finalize
  guardrail, reopenedSession by id, isolatedSession empty memory.
- 308-line continuous block (original 1011..1318) replaced with one
  marker; 16 lines of reopen/isolated (original 1607..1622) moved
  with continuity — they depended on `session.id` /
  `sessionSecond.runState.runId`, naturally part of the same
  concern.
- `sessionRuntime` declaration left inline for approval-resume +
  topic-guardrails (Phases 10/11) to consume.

## Phase 10 — approval-resume (2026-04-26)

- New file: `test/concerns/approval-resume.test.js` (~250 lines).
  Recreates `sessionRuntime`; runs two resume flows:
  `approvalResumeSession` (blocked → approve → search → read →
  final, with 3-step bookkeeping) and `denseApprovalResumeSession`
  (dense plan with interleaved search + multi-page reads, no
  goal-instability fallback).
- 207 inline lines (original 1025..1231) replaced with a marker.
  `sessionRuntime` declaration still inline pending Phase 11.

## Phase 11 — session-topic-guardrails + sessionRuntime cleanup (2026-04-26)

- New file: `test/concerns/session-topic-guardrails.test.js`
  (~125 lines). Recreates `sessionRuntime` + `denseTopicLikeRuntime`
  (the latter using `newsBriefSkill`); covers short-topic prompt
  → stable goalQuality + web_search approval (no unstable-goal
  fallback) and dense topic-like enquiry → 4-cycle research
  (search → read → read → finalize) + `summarize_limits`
  terminalize.
- 74 lines (original 1020..1093) removed AND the 7-line
  `sessionRuntime` declaration retired — this concern was the
  last inline consumer.
- Dead-import cleanup: `memorySkill` removed from smoke.test.js
  (only served `sessionRuntime`, now consumer-less).
- Session arc closed: continuity / approval-resume /
  topic-guardrails are now three independent concern files;
  main() carries no sessionRuntime / sessionPolicy traces.

## Phase 12 — approval-finalize (2026-04-26)

- New file: `test/concerns/approval-finalize.test.js` (~190 lines).
  Recreates `directFinalAgentSkill` (single tool, four variants:
  base / extras / missing / resolution) + `directFinalRuntime`;
  runs four fast-path flows:
  - direct final base: `finalAnswerSource = "direct_final"` +
    `terminalizedBy = "direct_final"`, onToken fires once,
    `direct-final-emitted` step appears, `provider-requested
    (source=runtime_finalize)` does not.
  - direct final extras: provenance / followups / drill_hints
    rendered into markdown fenced blocks.
  - missing markdown: falls back to `runtime_finalize`,
    `direct-final-skipped(reason=missing_markdown)` step appears.
  - non-terminal `resultKind=resolution`: also runtime_finalize,
    no `single-tool-fast-path` step.
- Two non-contiguous deletions: `directFinalAgentSkill` definition
  (original 347..412) + `directFinalRuntime` test block (original
  532..611). The `planAgentSkill` between them stayed for Phase 13.

## Phase 13 — planner (2026-04-26)

- New file: `test/concerns/planner.test.js` (~565 lines). The
  largest single block extracted in this whole sprint. Covers the
  full plan envelope flow:
  - parallel `plan_part` (3-way concurrent + tool-call ordering
    asserts);
  - validation failure / action-limit / partial-plan /
    continuation-plan / drill-hints / direct-plan / plan-final;
  - skill-mutator synthesis (section-scope mutator rewriting one
    markdown segment);
  - tool/date planner (`withMockedDate` wrapping
    `toolPlannerRuntime` to make currentTime / iso output
    deterministic).
- 515 lines of continuous inline code (original 353..867) replaced
  with a merged pointer comment.
- Dead-import cleanup: `withMockedDate` dropped from smoke.test.js
  — only used by Phase 2 worldtime (already extracted) and the
  planner concern (now extracted).

## Phase 14 — providers (2026-04-26)

- New file: `test/concerns/providers.test.js` (~233 lines).
  Recreates `providerRuntime` + `providerSkillPriorityRuntime`.
  Covers 11 PASS lines: custom-skill `canHandle` short-circuits
  the planner, OpenAI basic / 4 unsupported sampling parameters
  (temperature, max_output_tokens, maxOutputTokens, maxTokens) /
  image multimodal, Gemini basic / image multimodal / server-auth
  non-streaming / server-auth streaming + onToken capture /
  missing-endpoint short-circuit, failed provider PLANNER_ERROR +
  non-empty cause string.
- 213 inline lines (original 248..461) deleted, leaving only a
  pointer comment + a minimal `providerRuntime` declaration. The
  multimodal-session, planner-repair, and web-search blocks
  downstream still consumed `providerRuntime`; the declaration
  was kept inline pending those concerns' extractions (P11
  sessionRuntime pattern).

## Phase 15 — web-search (2026-04-26)

- New file: `test/concerns/web-search.test.js` (~155 lines).
  Recreates `providerRuntime`. Covers 6 PASS lines:
  - SearXNG round-trip: explicit endpoint + limit + first item
    title + `web-search-requested` step.
  - Gemini grounding (client mode): `groundingQueries` +
    `groundingSupportsCount` appear in `searchPasses[0]`.
  - Gemini grounding (server-auth): URL rewrite reaches
    `output.requestUrl` (AGRUN-205 / AGRUN-207 path).
  - Missing server-auth endpoint: short-circuits with cause
    matching `/endpoint/`.
  - Missing apiKey (client mode): SKILL_EXECUTE_ERROR with cause
    matching `/apiKey/`.
  - news-brief regression: `today news` no longer regex-matches;
    falls through to planner-driven tool_loop / skill_loop.
- 80 lines (original 805..883) replaced with a merged pointer
  comment.

## Phase 16 — read-url + 3 helpers (2026-04-26)

- New file: `test/concerns/read-url.test.js` (~590 lines = 134
  body + 366 helpers + 90 wrapper / imports). Recreates
  `allowedResearchRuntime` + `blockedResearchRuntime`; runs
  direct / fallback / service / failed read-url variants +
  blocked → approved approval flow + challenged 403.
- The 3 inline helpers (`withReadUrlMockedFetch`,
  `withReadUrlServiceMockedFetch`,
  `withChallengedReadUrlMockedFetch`, ~366 lines in
  smoke.test.js) moved with the concern — they were this
  concern's sole consumers.
- 134 inline body lines + 366 helper lines = ~500 lines net
  removed from smoke.test.js.
- First dry-run blew up with ReferenceError because the helpers
  used `normalizeOpenAIMessages` / `isPlannerRequest` /
  `assertSourcesSection` / `createReadUrlServiceFetch`; imports
  added. Same lesson as Phase 12: large-block extractions need a
  grep of helper / dist symbol usage before commit.

## Phase 17 — research-flows + IIFE retirement (2026-04-26)

- New file: `test/concerns/research-flows.test.js` (~470 lines).
  Recreates `providerRuntime` + `allowedResearchRuntime` +
  `blockedResearchRuntime` + `serverAuthApprovalRuntime` +
  `denyPolicyRuntime`. Covers research / summarize-limits /
  multimodal / approvalFlow / Gemini server-auth approval /
  denied / scrubbed-finalize / hard-block / planner-repair
  (repaired / strictRetry / fallback) / goproMandarin /
  naturalLanguagePlanner.
- 412 inline lines + the IIFE wrapper itself deleted —
  **main() now contains no `withMockedFetch` call at all**.
- Massive dead-import cleanup: 14 helper symbols removed from
  smoke.test.js's top-level require (`createMockResponse`,
  `createMockTextResponse`, `normalizeMockFetchUrl`,
  `isPlannerRequest`, three `isSemantic*JudgeRequest` flavors,
  `normalizeOpenAIMessages`, `readSessionContentText`, three
  `buildSemantic*JudgeResponse` flavors, `assertSourcesSection`,
  `withMockedFetch`).
- smoke.test.js net shrink: from ~798 lines (post-Phase 16) to
  ~370 lines. **Cumulative: ~6230 → 370 lines, a 94% reduction.**

## Phase 19 — bundled skills + read-url service (final) (2026-04-26)

- New file:
  `test/concerns/bundled-skills-and-read-url-service.test.js`. Lifts
  the very first block of main() — the only assertions left after
  Phase 17 retired the IIFE and Phase 18 swept providers-extra. Two
  orthogonal contracts:
  - Bundled agent skills registry: `bundledAgentSkills` array
    contains expert-coder + worldtime_tz; `getBundledAgentSkill`
    resolves by name and exposes `worldtime_now`.
  - `createReadUrlServiceFetch` wrapper: happy-path GET→POST
    rewrite + `x-api-key` injection + meta-header surfacing,
    passthrough URL bypass, 403 BLOCKED_HOST surfacing via
    `x-agrun-read-url-*` response headers, partial-forbidden 403
    origin with recovered markdown still returns 200 +
    `originStatus` + recovered body.
- main() retired to a thin orchestrator: it `require()`s every
  concern module, runs them in serial after the unit tests
  finish, then runs the browser-debug-report smoke and prints the
  completion banner.
- Massive dead-import / constant cleanup: `assert`, the entire
  dist destructuring import, `TEST_IMAGE_DATA_URL` — all gone
  from smoke.test.js. The file is now a navigation document
  rather than an assertion stream.
- AGRUN-118 acceptance fully satisfied; arc closed.

## Phase 18 — providers-extra (cleanup) (2026-04-26)

- New file: `test/concerns/providers-extra.test.js` (~140 lines).
  Recreates `providerRuntime` (skills = newsBrief + openai/gemini
  browser + web-search + fallback). Covers 3 PASS lines:
  - Multimodal-session continuity: turn 1 attaches alpha.png;
    turn 2 ("what is this") surfaces the most-recent image; turn
    3 ("what about alpha.png") matches the filename.
  - Planner repair: invalid envelope → repair-requested →
    repair-completed, no planner-invalid-action.
  - Planner strict retry: repair-failed → strict-retry-requested
    → strict-retry-completed.
- Concurrent with Phase 17. Together they moved every IIFE
  consumer of `providerRuntime` into concern files, so P17 was
  free to delete the local declaration.
- AGRUN-118 closure: all region-map concerns extracted, IIFE
  retired, `providerRuntime` declaration retired.

---

## Cross-cutting lessons (referenced from later sprints)

1. **Concurrency**: any test that mutates `global.*` must serialize
   via the `(async () => { await main(); await concern.run(); })()`
   tail pattern (Phase 7). This rule was eventually formalized as
   AGRUN-208's `withPatchedGlobals` helper (`test/helpers/global-
   isolation.js`).
2. **Dependency grep before extraction**: Phase 12 + Phase 16 both
   tripped on missing imports the first time a large block moved.
   Pattern: `grep -n '<symbol>' file.js` for every helper / dist
   symbol the block uses, BEFORE replacing the inline block with
   a pointer comment.
3. **Declaration retirement is separate from concern extraction**:
   a runtime-anchor `const` (sessionRuntime, providerRuntime) only
   retires when ALL inline consumers are extracted. Phase 11
   formalized this rule via the sessionRuntime cleanup; Phase 14
   re-applied it to providerRuntime; Phase 18 finally retired
   providerRuntime once both Phase 17 and Phase 18 land.
4. **Region map ≠ commit boundary**: the region map is for
   navigation; commit boundaries follow reviewer cognition. P11
   (session split into 3 concerns) and P15+P16 (web-search vs
   read-url) both demonstrated that one region row can decompose
   into multiple phases when the underlying concerns differ.
