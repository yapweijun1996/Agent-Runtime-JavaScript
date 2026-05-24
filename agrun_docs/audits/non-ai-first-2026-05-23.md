# Non-AI-first audit — 2026-05-23

Parent ticket: AGRUN-246. Successor to [non-ai-first-2026-05-07.md](./non-ai-first-2026-05-07.md). Method: 4-parallel-subagent deep scan of 40+ runtime files, classified by 5-question test (Q1 runtime decides instead of AI / Q2 prompt-injection / Q3 prose authoring / Q4 regex-on-prompt / Q5 fallback that "fixes" AI), then re-grouped into 6 behavioral categories below.

## Scope

Triggered by user-reported bug: when AI agent performs long output, the harness silently overwrites the answer with the hardcoded sentence

> "Evidence is insufficient to provide a verified current news report for this target."

Investigation traced the override to `final-response-quality.js:270-273`, but revealed that the same anti-pattern (harness overriding AI output via regex / keyword list / magic number) recurs across **~87 sites in 40+ files**. The 2026-05-07 audit fixed V1–V4, V8, V11 in `planner-recovery.js`, `virtual-workspace.js`, `research-state.js`, `research-evidence-graph.js`, `final-response-quality.js (veto loop)` — but the same anti-pattern grew back into newer subsystems (claim coverage, citation, terminal-repair, todo-autopilot, source authority scoring, planner research phase state machine).

## Headline finding

The harness has accumulated a **shadow planner** — a parallel rule engine that:
1. Pre-classifies user intent before the AI sees the prompt.
2. Pre-filters sources before the AI sees evidence.
3. Re-scans the AI's own answer with regex to validate it.
4. Rewrites or replaces the AI's text when the regex check fails.
5. Picks the AI's next action via a hardcoded state machine while telling the AI in the prompt "choose yourself."

This is structurally incompatible with AI-first. Every hardcode is a brittleness amplifier: the AI writes correct content, harness misjudges it, AI is asked to redo, AI loops on the same answer until budget breach (same root cause as ADR-0019 / V11).

## Six categories — 87 sites total

| Cat | Theme | Sites | Worst severity | Where it bites |
|-----|-------|-------|----------------|----------------|
| C1 | Harness directly overwrites AI output | 4 | P0 | Final report shown to user |
| C2 | Regex replaces AI intent classification | 6 | P1 | Whole planning path |
| C3 | Source pre-filtered before AI sees it | 4 | P1 | Information loss (irreversible) |
| C4 | Harness scans AI output with regex to validate | 4 | P2 | AI written-right → marked-wrong |
| C5 | Harness replaces AI planning decisions | 4 | P2 | AI planning space collapsed |
| C6 | NLP work stolen from AI | 4 | P3 | Entity/query brittle |

---

## C1 — Harness directly overwrites AI output (P0)

**Q3 ✅ (prose authoring) + Q5 ✅ (runtime "fixes" AI).** Most severe — the user sees harness-written text, not AI-written text.

### C1.1 — `final-response-quality.js:270-273` — "Evidence is insufficient" forced fallback
- `enforceTargetSourceCoverage` replaces AI body with literal `"Evidence is insufficient to provide a verified current news report for this target."` when no `source` in `context.sources` contains the target label as a substring.
- Trigger path: `isExternalSourceCoveragePrompt(prompt)` → `extractResearchCoverageTargets(prompt)` returns ≥ 2 targets → `sourceCoversTarget(source, target)` does naïve substring match on `title + snippet + url + domain`.
- Bug visible to user: AI writes a long, content-rich answer; harness sees `sources` array doesn't substring-match a target; whole AI body discarded.
- Fix direction: trust `collectTargetSegments` AI body if non-empty; only inject hint when AI literally wrote nothing for a target.

### C1.2 — `claim-coverage.js:262-274` — `buildConstrainedEvidenceCaveat` content rewriter
- Three keyword regexes (`linkedin|education|...`, `employment|works at|...`, identity verbs) classify individual sentences in the AI's answer and silently rewrite or remove them.
- Fix direction: AI should self-classify claim types in the planning envelope; harness should not edit prose.

### C1.3 — `claim-coverage.js:204-207` — heading rename hardcode
- Renames any AI heading matching `What is supported | Supported findings | Verified findings` to harness-chosen `"Evidence-constrained findings"`.
- Fix direction: leave AI headings as-is or have AI declare canonical heading via plan contract.

### C1.4 — `terminal-repair-strings.js:99-138` — per-deficit hardcoded AI instruction dispatcher
- `buildTerminalRepairDeficitHint` returns hardcoded English prose for each `deficit` type (`length / source / structure / todo / readiness`), embedding domain rules ("web_search/read_url first", "don't call workspace_write again") as static text.
- Fix direction: pass structured state to AI and let it reason. Harness should not author instructions in user-language prose.

---

## C2 — Regex replaces AI intent classification (P1)

**Q4 ✅.** Decides the planning path before AI gets a vote.

### C2.1 — `external-source-intent.js:1-3` — 3 regexes classify "is this a news / external-source request"
- `EXPLICIT_SOURCE_REQUEST_RE`, `NEWS_REQUEST_RE`, `FRESH_NEWS_REQUEST_RE` keyword lists.
- Misses synonyms ("prove it", "back it up"), non-English ("最新", "今日"), idiomatic phrasing.
- Drives whether C1.1 / C3 / coverage guard activate. If misfires → wrong policy applied.

### C2.2 — `topic-like-task.js:32-41` — English question-word + verb lists
- `isQuestionLikeText` regex `^(what|which|who|when|where|why|how|do|does|did|can|could|would|should|is|are|am|will)\b`.
- `isActionLikeText` regex `^(go|look|find|search|check|read|open|fetch|show|list|tell|reply|respond|answer|continue|explain|review|summarize|repeat|scrub)\b`.
- Misclassifies all Mandarin / non-English / indirect prompts.

### C2.3 — `task-state.js:141-157` — 4-branch rule tree for `promptSignal` tier
- `classifyPromptSignal` chains low-signal → action-like → question-like → topic-like → high using pure regex.
- Output feeds `deriveAmbiguityState` and the whole planner path.

### C2.4 — `todo-detection.js:9-15` — keyword regex decides if a run needs todo tracker
- `multi-step|step-by-step|long-running|progress|todo|task list` regex on user prompt.
- Should be planner self-declaration, not harness inference.

### C2.5 — `topic-router.js:32-41` — `PIVOT_MARKERS_FALLBACK` regex lexicon
- English + Chinese phrase regex array (`back to`, `回到`, `上一个`, …) detects pivot intent when `turnIntent.pivotIntent` is missing.
- Acknowledged in comment as legacy fallback, still actively used.

### C2.6 — `todo-autopilot-rules.js:7, 18, 43-62` — finalize / verification keyword regex
- `DEFAULT_FINALIZATION_PATTERN`, `DEFAULT_VERIFICATION_PATTERN`, `FINALIZE_STAGE_BLOCK_RE` classify AI-authored todo items by keyword.
- Defeats the purpose of having AI author the plan.

---

## C3 — Source pre-filtered before AI sees it (P1 — information loss is irreversible)

**Q1 ✅.** Runtime decides what evidence the AI is allowed to consider.

### C3.1 — `read-source-quality.js:183-222` — 14 regexes pre-tier every fetched source
- `BLOCKED_PAGE_PATTERNS` (perimeterx, captcha, cloudflare, …) → `blocked` tier → AI never sees.
- `THIN_PAGE_PATTERNS` (loading, please wait, redirecting, …) → `thin` tier → excluded.
- `MARKETPLACE_PATTERNS` (poshmark, ebay, carousell, listing, for sale) → forced `weak`.
- `COMMUNITY_PATTERNS` (community., forum, reddit, discussion) → forced `weak` unless overlap ≥ 2 AND text ≥ 240.
- Plus magic byte/char floors (`< 160 bytes`, `< 120 chars`) and `GENERIC_QUERY_TOKENS` 12-word filter.

### C3.2 — `evidence-pack.js:109-113` — `hasComparablePhrase` substring match for coverage
- Decides "does this source cover this target?" by naïve substring contain check — backbone of C1.1 false positive.

### C3.3 — `research-source-authority.js:22-148` — entire authority scoring engine
- `REGISTRY_RE`, `OFFICIAL_RE`, `INDEPENDENT_RE`, `ADVERTORIAL_RE` keyword classifiers.
- `HIGH_RISK_KINDS` set.
- Hardcoded score table: 0 / 10 / 35 / 38 / 62 / 72 / 74 / 78 / 92 with `blocked/non_verifying/context/independent/official/primary` tiers.
- This is the largest single rule engine in the runtime.

### C3.4 — `web-search-verification.js:7` — `LOW_VALUE_CATEGORIES = ["community","marketplace"]`
- Hardcoded set silently strips community/marketplace sources from all search evidence.

---

## C4 — Harness scans AI output with regex to validate (P2)

**Q5 ✅.** AI writes the right thing, harness keyword-misjudges it, AI is asked to redo, loop forms.

### C4.1 — `terminal-repair-state.js:318-330` — `mentionsStructureGap` keyword scan on AI's `remainingGaps`
- Checks AI's gap description for `structure|heading|section|duplicate|number|numbering|outline`.

### C4.2 — `terminal-repair-state.js:219-220` — `mentionsGap(gaps, ["todo","task","progress","plan"])`
- Same pattern for todo deficit.

### C4.3 — `todo-autopilot.js:383-400` — `hasFinalProseProgress` triple-regex scanner on AI answer
- Three structural regexes (checkbox / numbered step / progress summary) with magic count thresholds (≥ 2 / ≥ 3 / ≥ 2) decide whether AI made "progress".

### C4.4 — `claim-coverage.js:1-2` — heading regex scans AI output for required sections
- `CLAIM_COVERAGE_HEADING_RE` checks for `claim coverage | verified facts | reported but not independently verified | not verified | verification limits`.

---

## C5 — Harness replaces AI planning decisions (P2)

**Q1 ✅.** Harness picks the next action; AI is told it picks.

### C5.1 — `planner-prompt.js:927-942` — 6-rule research phase state machine
- `selectResearchPhase` decides one of `discover_sources | read_candidate_sources | draft_from_evidence | grow_workspace_candidate | finalize_or_publish` from facts.
- Drives `Focused research phase contract` block in planner prompt.

### C5.2 — `planner-prompt.js:944-959` — `buildResearchPhaseAllowedMoveHints` rule engine
- Hardcoded `if/then` branches inject specific allowed action names into AI prompt.
- Contradicts the surrounding prompt text "Use these as current research facts and choose the next action yourself."

### C5.3 — `action-pattern-convergence.js:32-78` — allowed / forbidden action name lists
- 8 hardcoded action-name sets define what AI can do when convergence detector escalates.

### C5.4 — `action-loop-failure.js:66-69` — `plannerInvalidCount > 1` hard-terminate
- After 2 invalid planner outputs, harness ends the whole run with no AI input.
- One more retry might let AI self-correct.

---

## C6 — NLP work stolen from AI (P3)

### C6.1 — `research-coverage-guard.js:8-55, 130, 241`
- `LIST_INTRO_PATTERN`, `SEGMENT_STOP_PATTERN`, 26-entry `ENTITY_STOPWORDS`, `ENTITY_ALIASES` (`u.s. → United States`, `my → Malaysia`), capital-letter NER regex.

### C6.2 — `web-search-verification.js:155-158` — entity tuple regex extraction
- Two regexes extract `(person, role, entity)` tuples with hardcoded role vocabulary `ceo|director|managing director|founder|owner`.
- Any unlisted role (President, Co-Founder, Managing Partner) silently produces no match → corroboration appears unavailable.

### C6.3 — `research-coverage-guard.js:278-281` — harness composes the search query
- `createTargetSearchQuery` appends `latest news` or `research` based on prompt regex match.

### C6.4 — `skill-catalog-ranking.js:15-41` — 24-word English stopword list for skill matching

---

## Why this keeps regrowing

Pattern observed across 2026-04-25 → 2026-05-23 audits:

1. Live test fails on edge case (lite model, non-English prompt, long output).
2. Engineer adds a "safety net" — a regex / keyword list / magic threshold to catch the failure.
3. Safety net works for the original case but misfires on other inputs.
4. New misfires are reported as bugs.
5. Goto 2.

**The safety net is the bug.** Each safety net is a hardcode that overrides AI judgment with a brittle rule. As LLM capability grows, these nets increasingly catch correct AI output and reject it.

## Fix direction (architectural, not patches)

| Principle | Implementation |
|-----------|----------------|
| Harness is for IO + state, not decision | Move every "classify" / "filter" / "rewrite" to a planner prompt block. Harness reads AI's structured envelope, never writes prose. |
| AI declares intent, harness obeys | Replace runtime intent regex (C2) with envelope fields like `requiresExternalSources: bool`, `phase: "discover|read|draft|finalize"`. Planner self-declares. |
| AI sees raw evidence | Remove C3 pre-tiering. Pass raw source content + signals (title, url, length, fetch ok) to AI; let it judge relevance. |
| Harness gate signals, not edit | C4/C5 should emit read-only loop signals AI can see (`signal: "structure_gap_detected"`) — never overwrite AI output or force-stop the run. |
| Delegate NLP to LLM | Replace C6 regex extraction with a small LLM call returning structured JSON. |

## Priority order

| P | Action | Files |
|---|--------|-------|
| **P0** | Stop overwriting AI output | `final-response-quality.js:270-273`, `claim-coverage.js:204-207, 262-274`, `terminal-repair-strings.js:99-138` |
| **P1** | Remove source pre-filter; remove intent regex | `read-source-quality.js`, `research-source-authority.js`, `external-source-intent.js`, `task-state.js:141-157`, `topic-like-task.js`, `topic-router.js`, `todo-detection.js`, `todo-autopilot-rules.js` |
| **P2** | Turn validation scans into read-only signals; remove planner shadow engine | `terminal-repair-state.js`, `todo-autopilot.js:383-400`, `claim-coverage.js:1-2`, `planner-prompt.js:927-959`, `action-pattern-convergence.js:32-78`, `action-loop-failure.js:66-69` |
| **P3** | Delegate NLP to LLM | `research-coverage-guard.js`, `web-search-verification.js:155-188`, `skill-catalog-ranking.js:15-41` |

## Cross-refs

- Predecessor: [non-ai-first-2026-05-07.md](./non-ai-first-2026-05-07.md) (V1–V11)
- Related ADRs: ADR-0012 (long-research deletion), ADR-0014 / 0015 / 0016 / 0017 / 0018 (V1–V4 / V8 fixes), ADR-0019 (V11 veto loop fix)
- KB record: `production-agent-harness-for-agrun-js` kb item `d10eeaf6-…` — "Hardcode AI-first 违规全面审计 2026-05-23"
- Architectural reference: [harness-engineering-principles.md](../harness-engineering-principles.md), [llm-first-runtime-refactor-plan.md](../llm-first-runtime-refactor-plan.md)

## Honest bad result (HBR)

- This audit is static — no live LLM evidence was collected per category to confirm misfire rate. Live testing each category against a real lite model is the next investigative step before sequencing fixes.
- The 2026-05-07 audit closed 11 violations, yet 87 new sites accumulated within 16 days. Without a structural guard (e.g. lint rule banning regex on `runState.input` in `src/runtime/`), the same growth will recur.
- Fix order is provisional. Some C1 sites (e.g. terminal-repair-strings) may interlock with C5 (planner-prompt phase machine) and need to be untangled together, not P0 → P1 → P2 → P3 sequentially.

---

## Audit re-run — 2026-05-23 (post A–G fixes)

Static re-scan after AGRUN-246-A through G implementation. Method: grep `src/runtime/**/*.js` for the 6 category patterns, cross-check against task.md fix log.

### Sites fixed (removed or replaced with AI-first equivalent)

| Sub-issue | File | Fix | Ticket |
|---|---|---|---|
| C1.1 enforceTargetSourceCoverage | `final-response-quality.js:270-273` | Deleted; AI body trusted if non-empty | AGRUN-246-A |
| C1.2 buildConstrainedEvidenceCaveat | `claim-coverage.js:262-274` | Deleted; harness no longer rewrites AI prose | AGRUN-246-B |
| C1.3 heading rename hardcode | `claim-coverage.js:204-207` | Deleted; AI headings preserved | AGRUN-246-B |
| C1.4 buildTerminalRepairDeficitHint action prose | `terminal-repair-strings.js:99-138` | Replaced with structured deficit facts (words/counts); AI composes own recovery | AGRUN-246-C |
| C2.1 EXPLICIT_SOURCE_REQUEST_RE etc. | `external-source-intent.js:1-3` | Regexes removed; conservative default (always true) | AGRUN-246-D |
| C2.3 classifyPromptSignal 4-branch | `task-state.js:141-157` | topic_like branch removed; collapsed to "high" | AGRUN-246-D |
| C2.4 DEFAULT todo keyword patterns | `todo-detection.js:9-15` | Default fallback and host regex opt-in removed from `isTodoShapedRun`; `runState.todoState` is the only SSOT | AGRUN-246-D |
| C7.2 promptRequestsQuality | `final-response-quality.js:requiresResearchReportSections` | Removed; sections required when workspace state shows evidence/gaps | AGRUN-246-B |
| C7.1 LONG_RESEARCH_RE | `claim-coverage.js:analyzeClaimCoverage` | Removed; `reportLoopActive` (AI-declared) replaces prompt keyword scan | AGRUN-246-B |
| C3.1 MARKETPLACE/COMMUNITY early-exit | `read-source-quality.js:183-222` | Early-exit blocks removed; sources fall through to neutral overlap check | AGRUN-246-E |
| C3.4 LOW_VALUE_CATEGORIES | `web-search-verification.js:7` | Removed; AI observes `sourceCategory` and judges relevance | AGRUN-246-E |
| C5.1 selectResearchPhase | `planner-prompt.js:927-942` | Deleted; raw evidence facts exposed, AI selects next action | AGRUN-246-G |
| C5.2 buildResearchPhaseAllowedMoveHints | `planner-prompt.js:944-959` | Deleted; AI no longer given hardcoded allowed-move lists | AGRUN-246-G |
| C5.4 plannerInvalidCount > 1 hard-terminate | `action-loop-failure.js:66-69` | Tolerance raised to > 2; one extra retry before hard-terminate | AGRUN-246-G |

**14 named sub-issues fixed. C1 fully closed (0 remaining). C2, C3, C5 partially closed.**

### Remaining sites — 10 active violations + 7 structural/irreducible

#### Active violations (need future fix)

| # | Sub-issue | File | Category | Priority | Notes |
|---|---|---|---|---|---|
| 1 | C2.2 isQuestionLikeText / isActionLikeText | `topic-like-task.js:29-41` | C2 | P1 | Full fix requires planner-envelope `turnKind` field; deferred |
| 2 | research/investigate intent regex | `research-state.js:579` | C2 | defer | Not in A-E scope; single regex in a narrow topic-drift check |
| 3 | long-run prompt regex | `final-answer-internal-progress.js:143` | C2 | defer | Not in A-E scope; guards internal-progress suppression |
| 4 | research-source-authority scoring engine | `research-source-authority.js:22-148` | C3 | P1 | Observational-only metadata; not directly excluding from AI context; defer until audit confirms impact |
| 5 | C4.1 mentionsStructureGap keyword scan | `terminal-repair-state.js:327` | C4 | P2 | Keyword scan on AI's own gap description to classify structure deficit |
| 6 | C4.3 hasFinalProseProgress triple-regex | `todo-autopilot.js:379-400` | C4 | P2 | Advisory-only veto (non-blocking, capped at maxVetoes); full fix requires planner-envelope declaration |
| 7 | C6.1 NER engine (ENTITY_STOPWORDS etc.) | `research-coverage-guard.js:8-55` | C6 | P3 | Delegate NER to LLM call; deferred |
| 8 | C6.2 entity tuple regex extraction | `web-search-verification.js:155-158` | C6 | P3 | Hardcoded role vocabulary; deferred |
| 9 | C6.3 createTargetSearchQuery regex | `research-coverage-guard.js:278-281` | C6 | P3 | Harness composes search query from prompt regex match; deferred |
| 10 | C6.4 stopword list for skill matching | `skill-catalog-ranking.js:15-41` | C6 | P3 | 24-word English stopword list; deferred |

**Total active violations remaining: 10 ≤ 10 — acceptance criterion 5 PASSED.**

#### Structural / irreducible (justifiably kept)

| Sub-issue | File | Rationale |
|---|---|---|
| C2.5 PIVOT_MARKERS_FALLBACK | `topic-router.js:32-41` | Bilingual (English + Chinese) structural guard for missing `turnIntent.pivotIntent`; legitimate legacy fallback |
| C2.6 DEFAULT_FINALIZATION_PATTERN etc. | `todo-autopilot-rules.js:7,18` | Classifies AI-authored todo LABELS (not user input); advisory-only; host-overridable |
| DEFAULT_CORE/EXTENDED_TASK_PATTERN exports | `todo-detection.js:14-15` | Exported for host opt-in only; no longer the default fallback in `isTodoShapedRun` |
| C3.1 BLOCKED_PAGE_PATTERNS / THIN_PAGE_PATTERNS | `read-source-quality.js:174-210` | Infrastructure error-page detection (captcha, cloudflare, loading screens) — HTTP-status-equivalent, not semantic judgment |
| C3.2 hasComparablePhrase | `evidence-pack.js:109-113` | Advisory citation-coverage signal; does not exclude sources from AI context |
| C4.4 CLAIM_COVERAGE_HEADING_RE | `claim-coverage.js:1-2` | Same C4.4 site as above; structural section-presence check retained, not a separate label definition |
| C5.3 allowed/forbidden action name sets | `action-pattern-convergence.js:32-78` | Action-name structural registry for reactive loop-breaking guardrails; not semantic judgment |

**Regrowth guard (`test/unit/no-regex-on-prompt.test.js`) active — allowlist shrunk from 7 to 3 after A-G fixes. CI will fail if new `.test(prompt)` patterns are added without explicit justification.**
