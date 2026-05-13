# Non-AI-first audit — 2026-05-07

Parent ticket: AGRUN-221. Method: 5-question test (Q1 runtime decides instead of AI / Q2 prompt-injection / Q3 prose authoring / Q4 regex-on-prompt / Q5 fallback that "fixes" AI).

## Grep tally

| # | Pattern | Hits | Severity |
|---|---|---|---|
| G1 | `Fallback\|fallback\|synthetic\|hardcode\|hardcoded` | 236 | mostly comments; high-signal sites listed below |
| G2 | runtime regex on user prompt | 3 (research-state.js) | **HIGH** |
| G3 | runtime markdown headings (`"## "` / `"# "`) | 22 | **HIGH** (virtual-workspace + plan-synthesize) |
| G4 | runtime URL/query selection symbols | 6 (mostly tombstone comments) | LOW |
| G5 | runtime workspace materialization | 10 (virtual-workspace.js) | **HIGH** |
| G6 | skill-ranking injection | 8 (telemetry-only post AGRUN-220) | LOW |

## P1 — Hard violations (open ADR immediately)

### V1 — `planner-recovery.js` regex-driven fallback decisions — RESOLVED by AGRUN-222 PRs 1+2+3 (2026-05-07)
File: `src/runtime/planner-recovery.js:40-103`
- Q4 ✅ — `looksLikeResearchRequest(prompt)` runs `/research|report|sources?|evidence|search|investigate|deep dive/i` on raw user prompt.
- Q4 ✅ — `looksLikeTopicPrompt(prompt) && /\b\d{4}\b/.test(prompt)` — runtime regex.
- Q5 ✅ — `createWebSearchFallbackDecision` synthesizes a `web_search` action when AI returns invalid envelope. Runtime "fixes" AI by guessing the next move.
- Callers: [action-loop-session-loop.js:8-9,559,569,605,617](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-session-loop.js), [action-loop-planner.js:28-29,388,399](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/action-loop-planner.js), [planner.js:17-18,399,410](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/planner.js).
- Verdict: **policy → ADR-0014**. English-only regex. Mandarin / non-English prompts silently bypass fallback. Same root cause as deleted `isLongResearchRun`.

### V2 — `virtual-workspace.js` materialised report template — RESOLVED by AGRUN-223 PRs 1+2 (2026-05-07)
File: `src/runtime/virtual-workspace.js:525-609,622-635`
- Q3 ✅ — runtime literally writes `# Research Report: ${topic}` / `## Summary` / `## What is supported` / `## Source quality` / `## Evidence gaps` / `## Claim coverage` / `## Sources`.
- Q1 ✅ — runtime decides which 5 files exist (`outline.md` / `evidence.json` / `draft.md` / `critique.md` / `final_candidate.md`) and their order.
- Trigger: `materializeVirtualWorkspaceFromFinalAnswer` at [runtime-finalize.js:180](https://github.com/yapweijun1996/agrun/blob/main/0_development/src/runtime/runtime-finalize.js).
- Verdict: **policy → ADR-0015**. Direct contradiction of ADR-0012 spirit (skill owns prose). Survived AGRUN-217 because the deletion targeted `compileResearchReportFromEvidence` only, missed this twin path.

### V3 — `research-continuation.js` simple-research auto-read + auto-finalize
File: `src/runtime/research-continuation.js:8-101`
- Q1 ✅ — runtime picks the next URL from search results (`selection.nextCandidate.url`).
- Q3 ✅ — runtime authors `buildSummarizeLimitsInstruction` prose injected as finalize instruction.
- Bypass: only `longResearchActive === true` skips runtime decisions. All non-long-research traffic still flows through push-mode.
- Verdict: **policy → ADR-0016**. ADR-0012 scope was deliberately narrow ("long-research only"); user now wants AI-first across all research traffic. Same removal pattern as ADR-0012.

### V4 — `research-state.js` lexical topic / research extraction — RESOLVED by AGRUN-225 PR 1 (2026-05-07)
File: `src/runtime/research-state.js:547-551`
- Q4 ✅ — three regexes on user prompt:
  - `\btopic\s*[:=]?\s*[…](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/audits/[^…]{2,160})[…]/i`
  - `[…](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/audits/[^…]{2,120})[…]` (quoted phrase)
  - `\b(?:research|investigate|look\s+up|find\s+out)\s+(.+?)…` — English-only research verb match.
- Verdict: **policy → ADR-0017**. After ADR-0012 deleted `isLongResearchRun`, residual lexical extraction still picks the topic. Should be replaced by AI declaring topic explicitly via plan envelope (mirrors `mode: "long_research"` from ADR-0012 PR 1).

## P2 — Policy-flavored mechanism (downgrade or wrap)

### V5 — `final-answer-internal-progress.js:274` runtime-prefixed `# Title`
- Q3 partial — wraps AI answer with `# ${title}${topic ? ': ' + topic : ''}` heading.
- Verdict: minor. Likely OK since it's last-mile UX hint, but should be opt-in.

### V6 — `action-loop-plan-synthesize.js:176,269` synthesised `## Section N` titles
- Q3 partial — only fires when AI did not provide a section title.
- Verdict: borderline. Preserve as fallback default OR delete and let AI iterate.

### V7 — Workspace quality signals
- `virtual-workspace.js:611-620` `evaluateWorkspaceQuality` — runtime decides "ready / not ready".
- Verdict: mechanism (gate signal). Acceptable IF ADR-0015 strips prose authoring while keeping the structural gate.

## P3 — Cultural / language hardcode (lower priority)

### V8 — `research-source-authority.js` — RESOLVED 2026-05-07 (verified absent in current code; ADR-0018)
- `.gov` / `.edu` domain bonuses → Western-academia bias.
- Verdict: host-pluggable scorer (out of `src/runtime/`). Scope: ADR-0018.

### V9 — `research-evidence-graph.js` noise filters — RESOLVED 2026-05-07 (documented as English-default convention; constants exported; host-pluggable refactor deferred to AGRUN-227 per ADR-0018)
- `STOP_WORDS`, `NOISE_RE`, `UI_NAV_LABEL_RE`, `UI_EMOJI_RE` (English-only).
- Verdict: bundled with V8 → ADR-0018.

### V10 — `planner-prompt.js` English-only template strings + examples
- All system instructions, action descriptions, envelope examples are English literals.
- Verdict: i18n epic, not a runtime architecture issue. Out of scope for ADR-0014..0018.

### V11 — `final-response-quality.js` veto loop — RESOLVED by AGRUN-228 PR 1 (2026-05-07)

Discovered post-audit via real-LLM live evidence: lite × Mandarin × 3000-word prompt produced 8+ `before-finalize-veto` events / 11-cycle loop / 60s wasted because `maybeCreateFinalResponseQualityVeto` rejected AI's finalize and `buildFinalResponseRepairInstruction` injected English repair prose.
- Q3 ✅ runtime authored repair-instruction prose.
- Q5 ✅ runtime "fixed" AI by re-asking; AI looped on the same answer until session-budget breach.

ADR-0019 PR 1: converted `maybeCreateFinalResponseQualityVeto` to `noteFinalResponseQualityIssues` (records issue codes, returns null = never blocks). Issue codes surface via `result.diagnostics.finalResponseQuality.issues` and `loopState.qualityContext` planner-prompt block. AI reads codes and decides expand / repair / accept.

Lesson for future audits: G7 grep (`maybeCreate.*Veto|repair.*Instruction|fallback.*Decision`) catches this pattern. First-pass audit missed because grep used keyword "research" — `final-response-quality.js` lives outside that namespace.

## ADR candidates

| ADR | Title | Removes | Files | PR cadence |
|---|---|---|---|---|
| ADR-0014 | Empty-response & invalid-envelope recovery is AI's job | regex-driven `shouldFallbackToWebSearch` + synthetic `createWebSearchFallbackDecision` | planner-recovery.js, action-loop-session-loop.js, action-loop-planner.js, planner.js | 3 |
| ADR-0015 | Workspace files are AI-authored, runtime is storage | `materializeVirtualWorkspaceFromFinalAnswer` + `buildWorkspaceResearchReportDraft` + `buildWorkspaceActionScaffold` | virtual-workspace.js, runtime-finalize.js | 3 |
| ADR-0016 | Simple research follows ADR-0012, no auto-read / auto-finalize | `resolveResearchContinuation` push-mode branches | research-continuation.js, action-loop-session-cycle.js | 3 |
| ADR-0017 | Topic extraction is declared by AI, not regex'd | `inferResearchTopic` regex paths | research-state.js, planner-tools.js | 2 |
| ADR-0018 | Authority scoring + noise filters are host-pluggable | `.gov/.edu` bonuses + STOP_WORDS / NOISE_RE / UI_*_RE | research-source-authority.js, research-evidence-graph.js | 2 |

Total: ~5 ADRs, ~13 PRs spread over 3-4 sprints. Acceptance gradient: 1/4 (current) → measure after each ADR.

## Suggested order

1. **ADR-0014 first** — biggest UX win (Mandarin prompts no longer silently fail recovery).
2. **ADR-0015** — removes the last hard-coded `# Research Report` template, completes ADR-0012 spirit.
3. **ADR-0016** — generalises ADR-0012 to simple-research mode.
4. **ADR-0017** — small surface, removes residual prompt regex.
5. **ADR-0018** — i18n / host-customisation (lowest urgency for end-user UX).

## Out of scope for AGRUN-221

- Pure-comment hits in the 236 G1 matches (most are tombstones from AGRUN-217 deletions).
- `planner-prompt.js` English-only system instructions — i18n project.
- `final-answer-internal-progress.js` heading wrap — UI hint, not policy.

## V14 — Push-mode residue post-ADR-0023 — RESOLVED by ADR-0026 (2026-05-08)

ADR-0023 deleted 8 push-mode sites and explicitly preserved two as "fail-safes":
1. `maybeEnforceConsecutiveFailureGuard` — force-finalize after 2 consecutive same-action failures.
2. `maybeApplySingleToolFastPath` — skip cycle-2 planner after first successful `execute_skill_tool`.

Live grep against ADR-0023's invariants showed both still firing in test paths (`single-tool-fast-path` step + `action-consecutive-failure-guard` step). ADR-0025 made them telemetry-distinguishable but did not delete them.

**ADR-0026 (AGRUN-233) deletes both.** Replacement is a read-only signal (`runState.actionFailureSignal` + `loopState.actionFailureSignal`); AI decides whether to switch tactics, finalize, or keep retrying. If AI keeps retrying, the loop terminates via `maxSteps`. Runtime is now a pure tool provider with no force-finalize sites at all.

Verified: `git grep -n "maybeEnforceConsecutiveFailureGuard\|maybeApplySingleToolFastPath\|single-tool-fast-path\|action-consecutive-failure-guard" src/` returns 0 hits in src/ source modules. `npm run check` exits 0.

**ADR-0027 (AGRUN-234) closes the live-e2e A10 acceptance** with real LLM evidence on `9431f6b25-dirty`: `finalAnswerSource === "planner_finalize"`, `metrics.plannerCallCount === 2`, `actionFailureSignal === null`. Push-mode 0 残留 holds in production-like conditions. Live test: [`agrun_docs/live-tests/zero-residual-push-mode-2026-05-08.md`](../live-tests/zero-residual-push-mode-2026-05-08.md). V14 fully resolved.

**Reopened by ADR-0028 finding (2026-05-08 evening):** the third live e2e exposed `autoReadAttemptCount: 2` + `autoReadStoppedReason: "auto_read_limit_reached"` + `usedSummarizeLimits: true` — `resolveResearchContinuation` is the LAST runtime push site missed by ADR-0023+0026. ADR-0028 supersedes deferred ADR-0016 with the same target: delete the function entirely, replace with `runState.readAttemptSignal` read-only signal.

**RESOLVED 2026-05-08:** ADR-0028 landed in a single PR (AGRUN-235): source-side delete + 6-file test cascade rewrite. `npm run check` exit 0 — 676 PASS, 0 FAIL. `git grep` confirms only tombstone comments + intentional legacy-reason-string return remain. Push-mode 0 残留 invariant fully closed across 11 deletion sites total (8 from ADR-0023 + 2 fail-safes from ADR-0026 + 1 from ADR-0028). V14 fully resolved.
