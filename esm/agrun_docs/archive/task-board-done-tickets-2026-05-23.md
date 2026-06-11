# Active Roadmap — Done Tickets Archive 2026-05-23

Archived from `task.md` Active Roadmap on 2026-05-23. These tickets are marked Done / Completed / Implemented; they remain here as historical record. New work should reference them by ticket id, not duplicate them.

Predecessor archives: [task-board-done-tickets-2026-05-14.md](./task-board-done-tickets-2026-05-14.md), [task-board-archive-2026-04-25.md](./task-board-archive-2026-04-25.md).

---

### AGRUN-244 | Long-form loop redesign — query-driven read/explore/patch loop, retire word-count padding
| Field | Value |
|---|---|
| Priority | High |
| Status | DONE 2026-05-22. Phase 3 shipped — word count retired as a loop-exit deficit across all 5 sites (terminal-repair, publish-readiness, WMG convergence, action-loop length guard, requirement-recovery). `npm test` 905 green, build/dist green. Live-verified 3× flash-lite: padding ELIMINATED (clean single-pass reports, honest `limited`). HBR: reports are short (426-667w) — flash-lite now fails honestly instead of padding. AGRUN-244 complete. |
| Builds on | AGRUN-243 live validation FINAL finding; sample-folder research (claude-code / codex / opencode) |
| Goal | Make long-form generation a query-driven read→explore→patch loop, so progress is measured against the user's request — not a word-count target a weak model can fake by padding. |

**Core issue.** AGRUN-243 live validation (2026-05-22) read the actual report
prose and found gemini-3.1-flash-lite pads: it writes a ~1200-word core report,
then appends renamed duplicate sections ("Extended Concrete Patterns", 4×
Conclusion) to hit the word target. The root cause is NOT only the blind
`workspace_append` tool — it is the LOOP SHAPE: agrun grows a long document
across cycles with the loop's continuation/exit driven by a word-count target
(`lengthProgress.remainingLength` → planner prompt says "append more"). That
exit condition is a number the model controls and can fake. Padding is the
model faking the exit condition.

**Research (2026-05-22).** Claude Code and Codex source were read in full:
NEITHER has an "append chunks to reach a length" loop — it does not exist as a
tool, a prompt instruction, or a workflow. They loop read→explore→edit, never
"append to a count"; Codex's `update_plan` explicitly bans filler steps. An
earlier framing of this ticket ("swap blind append for anchored insert") was
REJECTED — anchored insert keeps the broken word-count loop alive (the model
can still insert a renamed `## 7` duplicate). The fix is the loop's DRIVER, not
the mutation tool alone. One-shot whole-document writing was also rejected: the
project owner explicitly wants the agent to LOOP (read → explore → patch),
not write in one call.

**Intended model (project owner, 2026-05-22).** Keep the loop — long-form is
iterative. Each cycle: read the current draft state → explore (web_search /
read_url for real material) when the draft is thin → patch (anchored, targeted
edit). The loop continues because the user QUERY is not yet fully addressed,
and stops when it is. A thin draft is a signal to FIND MORE REAL MATERIAL and
patch it in — never to append filler. Word count is part of the query (it sets
scope/depth) but is a read-only observation, not the loop's exit gate.

**Design.**
1. **Loop driver = query coverage, not word count.** Replace the
   `remainingLength` → "append more prose" prompt pressure with query-coverage
   framing: what the user asked for, which parts the draft covers, which are
   thin or missing. The planner continues because coverage is incomplete, not
   because a number is unmet. Word count stays a read-only observation.
2. **Thin section → explore, then patch.** When part of the draft is thin, the
   prompted next move is web_search / read_url for real material, then an
   anchored patch — not a blind append of prose.
3. **Mutation = patch, not pad.** Promote `workspace_replace` /
   `workspace_insert_after_section` (anchored to observed text,
   Claude-Code-Edit style). Remove / deprecate blind `workspace_append`.
4. NOT in scope: a runtime semantic-duplication judge (push-mode content
   judgement the runtime must not do); one-shot whole-document writing.

**Phased plan.**

Phase 1 — prompt + loop-driver reframe (prompt-only, reversible; measure first):
- Rewrite the ~12 guidance/prompt strings that frame progress as
  "remainingLength large → append more": `virtual-workspace-actions.js`
  93/197/224; `planner-prompt.js` 57/180/188/193/781/823/954/956;
  `terminal-repair-strings.js` 107. New framing: a thin draft → explore for
  real material → anchored patch; loop on query coverage.
- Surface a read-only query-coverage observation (what the request asks for vs
  what the draft already covers) in place of a bare `remainingLength` number.
- Re-run 3× flash-lite (`thinkingLevel=high`), READ the prose, confirm padding
  drops before Phase 2. Signal: with `workspace_append` still available expect
  at most a PARTIAL drop — any drop validates the direction; zero drop means
  the tool itself does all the damage and doubly justifies Phase 2.

Phase 2 — retire blind append (larger blast radius, after Phase 1 proves out):
- Delete `workspaceAppendAction` + `executeWorkspaceAppendAction` +
  `appendWorkspaceFile` + aliases (`append_workspace`, `draft_append`).
- Sweep the ~40 reference sites: `terminal-repair-state.js` 523/610/641/659;
  `action-pattern-convergence.js`; `action-loop-action.js` (~10 sites);
  `requirement-recovery-evaluator.js`; `research-acceptance-evaluator.js` 275;
  `action-loop-plan-actions.js` 323; `todo-autopilot-rules.js` 69 — replace
  with `workspace_insert_after_section` / `workspace_replace`.
- Update ~11 test files; `test/node-agrun-3000-live.mjs` 404 allowed list.
- Keep `virtual_workspace_append` in historical op-log kinds
  (`planner-prompt-projection.js` 148, `inspectWorkspacePublishProtocol`) for
  back-compat with old run records.

**Open question — genuine material exhausted below requested length.** If the
query asks 3000 words and honest explore+patch yields only ~1900 words of real,
non-duplicated content (as gpt-5-mini did in AGRUN-243), the loop should keep
exploring for more genuine sub-topics while sources remain; when exploration is
genuinely exhausted, publish honest `limited` with the gap disclosed — never
pad. Confirm this exit matches intent.

**Headingless drafts** (minor): removing append leaves a headingless draft with
only `workspace_write` to grow. `workspace_write` is the legitimate bootstrap
(it establishes headings); not a blocker.

**Phase 1 RESULT (2026-05-22).** Shipped: ~12 prompt/guidance strings reframed
(`virtual-workspace-actions.js`, `planner-prompt.js`, `terminal-repair-strings.js`)
away from "remainingLength large → append more" toward "thin draft → explore →
anchored patch; do not pad"; `npm test` 914 PASS / 0 FAIL (one test contract
updated: `x2-research-phase-contract.test.js`). Live: 3× flash-lite
`thinkingLevel=high` (`p1-run{1,2,3}`), prose READ — **padding NOT reduced**.
All 3 still pad: p1-run1 Core Principles ×4 / Conclusion ×4; p1-run2 each topic
×3; p1-run3 each topic ×3; 3/3 `structureOk=false` (`duplicate_section_numbers`).
The model ignores the reframed prompt and still reaches for `workspace_append`
under length pressure. This is the ticket's predicted "zero drop → the tool
itself does the damage" outcome — consistent with the project lesson that weak
models need STRUCTURAL enforcement, not prompt instructions. Phase 2 (remove the
tool) is confirmed necessary; prompt-only is insufficient. Evidence:
`agrun_debug_runs/p1-run{1,2,3}{,-report}.*`.

**Phase 2 RESULT (2026-05-22).** Shipped: `workspace_append` action +
`executeWorkspaceAppendAction` + `appendWorkspaceFile` + registry entry deleted;
~40 reference sites swept (allowed-action sets, convergence/terminal-repair
moves, prompt strings) across ~10 src files; ~9 test files updated to the new
contract; `npm test` 913 PASS / 0 FAIL; `npm run build` + `dist:check` (250 md)
+ `test:long-task-lab` all green. Live: 3× flash-lite `thinkingLevel=high`
(`p2-run{1,2,3}`), prose READ — **padding NOT reduced**. 3/3 still pad: the
model simply pads via `workspace_insert_after_section` instead — inserting
renamed duplicate sections ("Additional/Further/Extended Anti-patterns",
"Extended Concrete Patterns", 2-3× Conclusion). 3/3 `structureOk=false`
(`duplicate_section_numbers`).

**AGRUN-244 thesis DISPROVEN by live evidence.** The thesis — "blind
`workspace_append` is the padding mechanism; remove it → padding stops" — is
WRONG. The tool was never the root cause. The model pads with whatever growth
tool exists, because the LOOP'S EXIT/CONTINUATION is still driven by a
word-count target: the runtime computes `lengthProgress.remainingLength`,
terminal-repair fires a `length` deficit when observed < requested, and the
publish-readiness checks gate on `observedLength < requestedLength`. The model
sees "length deficit" → keeps growing → pads. Removing append (Phase 2) and
reframing prompts (Phase 1) addressed the MECHANISM and the WORDING but never
the INCENTIVE. Phase 2 is a correct narrowing (matches Claude Code / Codex,
which ship no blind append) and is kept — but it is NOT the fix.

Phase 2 acceptance:
- [x] `workspace_append` removed, blast radius swept, `npm test` + build/dist +
  long-task-lab smoke green.
- [x] Live e2e 3× flash-lite, prose READ. RESULT: padding NOT reduced — see
  Phase 2 RESULT above. Goal NOT met.

**Phase 3 (the actual fix) — retire word count as a loop-exit deficit; the
loop ends on query coverage.** DESIGN 2026-05-22, implementation-ready below.

Root cause (proven by Phase 1+2 live failure): the loop keeps pushing growth
because the runtime treats `observedLength < requestedLength` as a repairable
DEFICIT. `terminal-repair-state.js` builds `observableDeficits` and at the
`length` branch (currently ~line 401-417) does
`if (lengthStatus.requested > 0 && lengthStatus.observed < lengthStatus.requested) { deficits.push("length"); ... }`.
That `deficits.push("length")` is the exit-condition the model fakes by padding.

Key finding that makes Phase 3 tractable: a `todo` deficit ALREADY exists in the
same function — `if (todo.unfinishedCount > 0) { deficits.push("todo"); }`.
todoState items (`{label, status: pending|active|done|blocked|abandoned}`) are
already the natural coverage tracker, and `todo-auto-planner-guidance.js` /
`todo-autostart.js` already nudge a `todo_plan` for substantial tasks. So
"coverage" is mostly the existing `todo` deficit — Phase 3 mainly DELETES the
`length` deficit and lets `todo` carry loop continuation.

Implementation steps:
1. **terminal-repair-state.js** — delete the `length` deficit block (~401-417):
   no more `deficits.push("length")`. `observableDeficits.length` may stay as a
   display-only fact (not in `deficits`). Remove `length` from allowed-action /
   valid-publish-contract / required-repair branches that key on it.
2. **action-pattern-convergence.js** — DELICATE, surgical not bulk-delete. The
   length-deficit guards do two things: (a) catch a `workspace_write` that
   SHRINKS the existing draft (a real regression — KEEP this branch), and
   (b) push growth because `observed < requested` (the word-count target —
   DELETE this branch). Remove only the target-comparison part; keep the
   anti-shrink part.
3. **virtual-workspace-actions.js `inspectPublishReadiness`** — delete the
   chains that BLOCK publish on `observedLength < requestedLength` (the
   `lengthSatisfied must be false` / `cannot publish limited while observed <
   requested` / `internally inconsistent` length blocks). The AI still declares
   `finalReadiness` honestly; runtime stops forcing continuation on length.
4. **research-report-loop.js / final-readiness.js** — `requestedLength` becomes
   display-only; remove it from any deficit/gate computation.
5. **Keep** `lengthStatus` / `remainingLength` computed and shown to the planner
   as a plain observation ("observed N words, the request mentioned M") — facts,
   not a target.
6. **Retire `structureOk` as a publish BLOCK** (proven gameable — renamed
   duplicates evade it). Keep it as a displayed observation only.
7. **Also retire the `structure` deficit** in terminal-repair-state.js (the
   `if (structure.ok === false) { deficits.push("structure"); }` branch). Same
   reasoning as `length`: Phase 2 runs were 3/3 `structureOk=false` and the
   deficit fired every cycle with zero effect — it is noise, and the literal
   duplicate-heading check it rests on is gameable. Structure stays a displayed
   observation; it is not a repairable deficit.

Coverage exit (what ends the loop instead): all todoState items reach a
terminal status (`done`/`abandoned`) → no `todo` deficit → AI may finalize. If
genuinely short, AI publishes honest `limited`; runtime never pads.

OPEN QUESTION — RESOLVED 2026-05-22: user chose **(b)** — when a long-form
request has no todoState plan, the AI self-governs (decides when the query is
answered); the harness does not force a todo_plan.

**Phase 3 DONE 2026-05-22 — padding eliminated, live-verified.**
- [x] Step 1 — `terminal-repair-state.js`: `length`/`structure` no longer
  pushed into `deficits` (display-only `observableDeficits`).
- [x] Step 2 — `action-pattern-convergence.js`: `computeMinimumEffectiveWorkspaceGrowth()`
  returns a fixed anti-noop/anti-shrink floor, not a word-count-target proportion.
- [x] Step 3 — `virtual-workspace-actions.js` `inspectPublishReadiness`: removed
  all `observedLength < requestedLength` publish blocks + the `structureAudit`
  block; kept `observedLength !== actualObserved` and `ready && evidenceSatisfied
  === false`. Removed orphan `canPublishLimitedWithStructureDeficit` + the
  `inspectWorkspaceCandidateStructure` import.
- [x] Step 3b (found mid-implementation) — `action-loop-action.js`
  `computeMinimumEffectiveLengthDeficitGrowth()`: fixed `30` floor, not a
  target proportion (the `length_deficit_rewrite` guard is now pure
  anti-noop/anti-shrink).
- [x] Step 3c (found mid-implementation) — `requirement-recovery-evaluator.js`:
  deleted the `lengthDeficit` recoverable-deficit branch. A short candidate no
  longer sets `validLimitedAllowed=false`; only an unmet SOURCE minimum does.
- [x] Step 5 — `test/node-agrun-3000-live.mjs` `assertLiveAcceptance`: dropped
  the stale word-count / structure pass-fail assertions (kept runStatus /
  publish-path / decision / source-evidence / publish-loop checks).
- [x] Test churn — `terminal-repair-state.test.js`,
  `action-pattern-convergence.test.js`, `workspace-actions.test.js`,
  `requirement-recovery-evaluator.test.js` re-expressed to the new contract.
  `npm test` 905 PASS / 0 FAIL; `npm run build` + `dist:check` (250 md) green.

**Phase 3 RESULT (live-verified, 3× gemini-3.1-flash-lite `thinkingLevel=high`,
prose READ):** padding ELIMINATED. p3-run1 667w, p3-run2b 483w (structureOk=true),
p3-run3 426w (structureOk=true) — all 3 are clean single-pass reports with each
requested section (Definition…Conclusion) appearing ONCE, no renamed duplicate
sections, terminated as honest `limited` via `workspace_publish_candidate`.
Contrast Phase 2 (3/3 gross padding: Concrete Patterns ×3, Conclusion ×4, 3000+
words of renamed-duplicate filler). The word-count-driven loop exit condition
was the root cause; removing it fixed the padding.

**HBR:** the reports are SHORT — 426-667 words for a "3000-word" request.
Freed from word-count pressure, gemini-3.1-flash-lite writes a genuine ~500-word
report covering all sections once and honestly publishes `limited` rather than
padding to 3000. This is the user-chosen (b) tradeoff (quality/honesty over
faked quantity) working as designed: the model now FAILS HONESTLY (short
`limited`) instead of FAILING DECEPTIVELY (padded 3000). It also confirms the
session-long finding — flash-lite genuinely cannot produce a quality 3000-word
report; the harness can stop it lying about that, not manufacture the capability.

Minor follow-up (not blocking): dead `hasLength`/`hasStructure` branches remain
in `terminal-repair-state.js` `buildAllowedActions` (unreachable now that
`length`/`structure` never enter `deficits`) — harmless, can be swept later.

Risk note: Phase 1+2 shipped clean (suite/build green) but did NOT reduce
padding — Phase 3 is the actual fix and must be live-verified by reading prose.

---

### AGRUN-240 | Session lineage via parentSessionId
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Done |
| Builds on | Hermes long-running agent research 2026-05-19 |
| Commit | `d7362a531` |
| Goal | `sessionRecord` carries a `parentSessionId` field; callers can pass `parentSessionId` into `session.run()` to establish a task tree, enabling debugging of multi-turn orchestrator-worker flows. |

What changed (3 atomic edits):
1. `src/session/messages.js` — `createSessionRecord`: added `parentSessionId: null` to schema.
2. `src/session/handle.js` — `executeSessionTurn`: reads `parentSessionId` from input object, latches onto `sessionRecord`, projects into `result.runState.parentSessionId` after `runLoop`.
3. `test/concerns/agrun-240-parent-session-id.test.js` (new): 3 assertions (schema, set, null).

Scope:
- Add optional `parentSessionId` to `sessionRecord` schema.
- Add `parentSessionId` option to `session.run()` input.
- Project `parentSessionId` in `snapshotRunState` → `result.runState`.
- No change to OODAE loop, planner, or compaction logic.
- Non-goal: cross-session checkpoint/resume (future server-side feature).

Acceptance:
- [x] `session.run({ ..., parentSessionId: 'abc' }, opts)` stores `parentSessionId` in result.
- [x] `sessionRecord.parentSessionId` is `null` when not provided.
- [x] Unit test covers both cases — `test/concerns/agrun-240-parent-session-id.test.js` (3 assertions).
- [x] `npm test` 827 pass, 0 fail. `npm run build` pass.

---

### AGRUN-239 | Stabilize planner system prompt for prompt caching
| Field | Value |
|---|---|
| Priority | High |
| Status | Done |
| Builds on | Hermes long-running agent research 2026-05-19; code research 2026-05-19 |
| Commits | `699f3da50` (implementation), `35ad7fcc1` (test) |
| Goal | Remove all per-cycle dynamic content from `buildPlannerSystemPrompt` so the system prompt is byte-stable across cycles within a session, enabling OpenAI automatic prompt caching (≥1024 tokens, cached after first cycle). |

Background (2026-05-19 code research):
- Original premise "skills out of system prompt" was WRONG — skills are already in user message `loopState.bundledAgentSkills` JSON (`planner-prompt.js:325-327`).
- Real caching blocker: `todoStateBlock` (windowed TodoState, active item ±2) injected at `buildPlannerSystemPrompt:135` changes every cycle.
- Only one caller of `buildPlannerSystemPrompt`: `planNextActionWithEnvelope` (`planner.js:357`). `readOnlyPlanning` path uses `buildNativeToolsSystemPrompt`, unaffected.
- `buildEnvelopeLines` receives dead `todoState` param that it never uses — clean up.
- `runState.virtualWorkspace` in envelope lines changes once per session (workspace files appear), not every cycle — leave for Phase 2.

What changed (4 atomic edits):
1. `src/runtime/planner-prompt.js` — `buildPlannerSystemPrompt`: removed `todoStateBlock` variable and its inject line.
2. `src/runtime/planner-prompt.js` — `buildPlannerPrompt`: injects `todoStateBlock` as "Plan state:" labeled text section after "Loop state:" block, using existing `compactDuplicateTodoStateBlock` helper.
3. `src/runtime/planner.js` — `planNextActionWithEnvelope`: removed `todoStateBlock: options.todoStateBlock` from `buildPlannerSystemPrompt` call.
4. `src/runtime/planner-prompt.js` — `buildPlannerSystemPrompt`: removed dead `todoState: opts.todoState` from `buildEnvelopeLines` call.

Note: `selectPlannerSystemPromptProfile` in `planner.js:563` still reads `options.todoStateBlock` for compact-mode selection — unchanged.

Acceptance:
- [x] System prompt byte-identical across cycles — `test/unit/agrun-239-system-prompt-stability.test.js` (4 assertions, `npm test` pass).
- [x] `npm test` 819 pass, 0 fail.
- [x] `npm run build` clean.
- [ ] OpenAI live: `prompt_tokens_details.cached_tokens > 0` after cycle 2 (pending live test).

HBR: OpenAI live cache verification (`cached_tokens > 0`) is not yet confirmed — requires real API session with active TodoPlan and ≥1024 token system prompt. Unit test confirms byte-stability contract; live cache hit depends on provider-side behavior.

Out of scope: Anthropic `cache_control` headers (no Anthropic provider), workspace `allowFinalize` envelope refactor (Phase 2).

Phase 2 residual cache-busters (identified 2026-05-19 code research):
- `buildEnvelopeLines` line 119: terminal policy reason string `"workspace_publish_path_required"` appears/disappears when workspace files are created — this flips system prompt text mid-session.
- `standaloneActionNames` embedded in system prompt (both `buildSystemPromptLines` L152 and `buildNativeToolsSystemPrompt` L40) — stable only if `availableActions` doesn't change between cycles; not yet verified for skill-load path where `execute_skill_tool` may be conditionally injected.
- Corrected P2 framing: "skills out of system prompt" was a wrong diagnosis; the real fix class is "remove remaining dynamic-per-cycle content from system prompt".

---

### AGRUN-DEAD-DOCS-CLEANUP-2026-05-17 | Clean likely dead/docs-only files from Codeloom dogfood
| Field | Value |
|---|---|
| Priority | P2 |
| Status | Done |
| Builds on | Codeloom T-365 dogfood / `find_dead_files` actionable review |
| Goal | Safely remove or formally reclassify only the three likely dead/docs-only files identified by Codeloom review, without touching live or test-contract files. |

Scope:
- Candidate files only:
  - `src/runtime/action-loop-session-result-kind.js`
  - `src/runtime/planner-final-preference.js`
  - `src/session/prompt-anchors.js`
- Before deleting, rerun `rg` for each exported symbol, basename, and relative import path across `src`, `test`, `build`, `agrun_docs`, `examples`, and `node`.
- If a candidate is deleted, remove or update stale docs/ADR references that point readers at the deleted file.
- Non-goals: do not touch `agrun_docs/manifest.cjs`, `node/repo-file-tools.cjs`, `src/runtime/before-finalize-veto-detail.js`, or `src/runtime/improvement-reflection.js`; those were reviewed as live or test/ADR-only and need separate product decisions.

Acceptance:
- [x] `rg` evidence confirmed the three candidate files had no current runtime import or dynamic load path; `planner-final-preference.js` only had a unit test for the now-unwired helper, so the paired test was removed with the helper.
- [x] Deleted only the three confirmed files plus the stale helper-only test and smoke require.
- [x] Updated current docs that pointed readers at `src/session/prompt-anchors.js`; historical archive mention for `action-loop-session-result-kind.js` was left intact as archive evidence.
- [x] `npm test`, `npm run build`, and `npm run dist:check` passed.

HBR:
- `npm run build` still emits the existing Rollup dependency warnings and Vite chunk-size warning. The generated browser asset hash/build-id churn is not part of this cleanup commit.

---

### AGRUN-CODELOOM-TEST-ADR-CONTRACT-REVIEW-2026-05-17 | Decide remaining Codeloom actionable test/ADR contract files
| Field | Value |
|---|---|
| Priority | P2 |
| Status | Completed |
| Builds on | Codeloom T-369 dogfood / `find_dead_files` actionable review |
| Goal | Decide whether the two remaining Codeloom actionable source files are intended runtime contracts, test/support helpers, or removable legacy code. |

Candidates:
- `src/runtime/before-finalize-veto-detail.js`
  - Current evidence: imported by `test/unit/todo-autopilot.test.js`; referenced by ADR-0010 as the event-shape detail helper.
  - **Decision: MOVED to `test/helpers/before-finalize-veto-detail.mjs`** (2026-05-19). Pure test infrastructure — ADR-0010 confirms it exists so event-shape tests can verify without importing the full action-loop. Zero production imports. Updated: test import path, ADR-0010 source + dist.
- `src/runtime/improvement-reflection.js`
  - Current evidence: imported by improvement reflection/fixture/long-running tests; referenced by ADR-0011 as AGRUN-210 Phase C.
  - **Decision: KEEP in `src/runtime/`** (2026-05-19). Active ADR-0011 Phase C contract (366 lines, 4 reflection rules). AGRUN-210 is closed but the module is a standing test contract and candidate for future public API elevation.

Acceptance:
- [x] For each candidate, rerun `rg` for basename, exported symbols, ADR references, smoke requires, and package/public API exposure.
- [x] For each candidate, record one explicit decision: keep in `src/runtime`, move to test/support, or delete.
- [x] If moved/deleted, update tests, ADRs, public docs, smoke requires, and generated dist docs consistently.
- [x] Run the focused affected tests plus `npm test`, `npm run build`, and `npm run dist:check`.
- [x] Record HBR with any remaining Codeloom actionable false positives or deliberate test/ADR-only contracts.

HBR:
- Codeloom `find_dead_files` is a structural probe (static ESM import graph only). Both files appeared "dead" because their consumers use `path.resolve()` + dynamic `import()` — a pattern Codeloom cannot trace. Pre-action `rg` verification is mandatory before acting on Codeloom dead-file results.
- `improvement-reflection.js` deliberately stays in `src/runtime/` as a standing contract. Codeloom will continue to flag it as zero-import — that is expected and correct.

---

### AGRUN-MOCK-PROVIDER-L1-2026-05-16 | MockProvider seam + L1 plan-loop reproduction
| Field | Value |
|---|---|
| Priority | P1 |
| Status | Completed with HBR |
| Builds on | `NODE-FIXED-PROMPT-LENGTH-TERMINAL-REPAIR-2026-05-16`, `STRUCTURE-LIMITED-PUBLISH-CONTRACT-2026-05-16` |
| Goal | Make the blocked 3000-word search/plan loop reproducible offline at provider seam level in under two minutes, without live API tokens. |

Reference samples:
- `sample project for study logic/ai-ai-6.0.119/packages/ai/src/test/mock-language-model-v3.ts` — scripted MockProvider responses and call capture.
- `sample project for study logic/goose-1.27.2/crates/goose/src/providers/testprovider.rs` — provider record/replay boundary.
- `sample project for study logic/codex-main/codex-rs/core/src/rollout/recorder.rs` — JSONL rollout/resume inspectability pattern.

Acceptance:
- [x] `grep -nE "request\.provider|providerCall" src/runtime/action-loop-planner.js` reviewed and seam documented in `agrun_docs/provider-seam-2026-05-16.md`.
- [x] `src/runtime/mock-provider.js` exports `createMockProvider({ responses })`, records `calls[]`, throws `MockProvider exhausted`, and supports complete/stream call shapes.
- [x] `test/unit/mock-provider-plan-loop.test.js` scripts five `web_search` / `todo_plan` responses, no `workspace_write`, no `read_url`, no API calls.
- [x] L1 fixture asserts `terminalRepairState.active === true` and `actionPatternConvergence.readOnlyPlanningState.active === true` by cycle 4 in under one second.
- [x] Full `npm test` green in this commit.
- [x] Follow-up documents the direct `src/index.js` import blocker and why real `createRuntime` source import is deferred to `AGRUN-TEST-IMPORT-SEAM`.
- [x] Follow-up adds a sample-first design comparison with cited line ranges for AI SDK, Goose, and Codex recorder patterns.
- [x] `src/package.json` marks source files as ESM so Node no longer emits `MODULE_TYPELESS_PACKAGE_JSON` in source-level tests/import probes.

HBR:
- Full action-loop source import is still blocked by Rollup-only `virtual:agrun-agent-skills` / `virtual:agrun-agent-roles` imports. The L1 test still uses the provider seam plus real convergence/terminal-repair evaluators instead of real `createRuntime`; `AGRUN-TEST-IMPORT-SEAM` tracks the required source-import seam.

---

### AGRUN-TEST-IMPORT-SEAM | Make source-level createRuntime importable in Node tests
| Field | Value |
|---|---|
| Priority | P1 |
| Status | Done (2026-05-18) |
| Builds on | `AGRUN-MOCK-PROVIDER-L1-2026-05-16` |
| Goal | Replace the L1 provider-seam fake action loop with a real `createRuntime` source-level Node test once bundler-only virtual modules have a Node-safe import seam. |

Shipped 2026-05-18:
- `test/helpers/virtual-stubs-hooks.mjs` — Node.js ESM loader hooks: `resolve()` intercepts `virtual:agrun-agent-skills` + `virtual:agrun-agent-roles`, `load()` generates module source by reading real `skills/` and `roles/` directories.
- `test/helpers/virtual-stubs-loader.mjs` — preload script using `module.register()`.
- `test/live-helpers.mjs` — added `resolveSourcePath()`, `importRuntimeSource()`, `importRuntime()` (auto-selects src vs dist via `--src` flag or `process.argv`).
- `test/live.test.mjs` — added `useSrc` flag; `ensureDistExists()` skipped in `--src` mode.
- `package.json` — added `test:live:src`, `test:live:src:openai`, `test:live:src:gemini`, `test:live:src:approval`, `test:live:src:skills`.

Acceptance:
- [x] `node --import ./test/helpers/virtual-stubs-loader.mjs -e 'import("./src/index.js").then(m=>console.log(Object.keys(m)))'` succeeds.
- [x] `npm run test:live:src:openai` runs real OpenAI API call against `src/index.js` without `npm run build`.
- [x] Bundled skills (5) and roles (5) correctly loaded from `skills/` and `roles/` directories.
- [x] `npm test` (smoke) still passes — no regressions.
- [ ] `test/unit/mock-provider-plan-loop.test.js` uses real `createRuntime` (deferred follow-up).

---

### AGRUN-DEBUG-01 | Improve node live E2E debug + fine-tune experience
| Field | Value |
|---|---|
| Priority | Medium |
| Status | Implemented (2026-05-19) — Layer 1 + Layer 2 shipped in `test/node-agrun-3000-live.mjs` |
| Motivation | E2E v8 review: `planner_decision` JSONL stream only emits `{actionName, event, index}`. Cannot answer: (1) Is candidateWords growing per step? (2) Which step did hard_veto fire? (3) Which step did readOnlyPlanningState activate? Must read deep `interestingSteps` array — not streamable. |

Goal: make per-step JSONL stream self-sufficient for real-time debug and fine-tune without post-processing.

Changes implemented (2026-05-19):
1. **`planner_decision` event** — `onPlannerDecision(decision, runState)` now uses second arg and emits `candidateWords`, `budgetState`, `terminalRepairActive`, `terminalRepairEscalation`, `terminalRepairIgnoredCount`, `readOnlyPlanningIgnoredCount`, `cycleCount` inline
2. **`hard_veto_fired` event** — `onStep(step, runState)` subscriber added; emits structured event when step.type is `terminal-repair-hard-veto-blocked` or `structure-repair-hard-veto-blocked`
3. **`convergence_block` event** — emitted by `onStep` for advisory blocks (`read-only-planning-action-blocked`, `terminal-repair-direct-terminal-blocked`, `terminal-repair-action-blocked`, `structure-repair-action-blocked`)
4. **`summarizeStepDiagnostics` interestingTypes** — added `terminal-repair-hard-veto-blocked` and `structure-repair-hard-veto-blocked`

Acceptance:
- [x] `planner_decision` events in JSONL include `candidateWords` + `budgetState` + `cycleCount`
- [x] `convergence_block` event fires correctly with correct `budgetState` and `candidateWords` (v9c verified: cycleCount=13, budgetState="enough", candidateWords=423)
- [x] `hard_veto_fired` event wired up (fires when hard_veto escalation detected in step type)
- [x] `npm test` green after changes (810+ PASS 0 FAIL)
- [x] Hard_veto live validation: AGRUN-237-GAP-01 HIGH_WATER_MARK=6 fires `hard_veto_fired` at cycle 57 with `budgetState="enough"` (33 cycles remaining) — v13 E2E 2026-05-19

Key fix (2026-05-19): `onStep` second param is `createStepSnapshot(runState)`, NOT raw runState. State is nested at `snapshot.runState.cycleCount` etc. `terminalRepairState` and `actionPatternConvergence` NOT in copyFields — budgetState computed from `snapshot.runState.cycleCount` + `maxSteps` (closure). See `agrun_docs/live-tests/node-agrun-3000-v9-gemini-flash-lite-debug01-2026-05-19.md`.

**AGRUN-237-GAP-01 (implemented 2026-05-19, two-part fix):**

Fix 1 (`terminal-repair-state.js`): Added `TERMINAL_REPAIR_HIGH_WATER_MARK = 6`. Escalation now `(ignoredCount >= 3 && exhausted) || (ignoredCount >= 6)` → hard_veto.

Fix 2 (`action-loop-session-loop.js`): Root cause found via v11 E2E — `maybeBlockDirectTerminalDuringRepair` blocked direct `finalize/final` WITHOUT checking `repair.escalation`, always pushing `"terminal-repair-direct-terminal-blocked"` (advisory). Fixed: checks `repair.escalation === "hard_veto"`, pushes `"terminal-repair-hard-veto-blocked"` with hard veto message when threshold reached. Includes `escalation` + `ignoredCount` in step detail and observation.

3 new unit tests in `terminal-repair-state.test.js`. `npm test` 810 PASS 0 FAIL. E2E v12 launched to verify `hard_veto_fired` appears at cycle ~40 (ignoredCount=6).

**AGRUN-237-GAP-02 (context engineering fix, shipped 2026-05-19):**

Root cause: `maybeBlockReadOnlyPlanningLoop` in `action-loop-action.js` used generic kind/stepType/message, so the model could not distinguish it from advisory blocks. Fix: added `"HARD VETO — ..."` prefix to message, `kind: "read_only_planning_hard_veto_block"`, pushStep `"read-only-planning-hard-veto-blocked"`, and `escalation: "hard_veto"` in detail. Fully mirrors terminalRepair/structureRepair hard_veto pattern.

Unit test validation (2026-05-19): 3 new tests added to `test/unit/action-pattern-convergence.test.js`:
- `readOnlyPlanningState escalation=hard_veto when ignoredCount>=3` ✅
- `readOnlyPlanningState escalation=advisory when ignoredCount<3` ✅
- `readOnlyPlanningState escalation resets to advisory on source progress clear` ✅
`npm test` 810 PASS 0 FAIL.

E2E v15 analysis (2026-05-19): Designed E2E prompt to force 8+ consecutive web_search calls. Root cause found why direct E2E cannot trigger readOnlyPlanning hard_veto in non-longFormMode:
1. `todo_advance` generates "todo" dimension progress → `hasProgress=true` in non-productiveOnlyMode → resets `stepsWithoutObservableProgress` to 0 after every `todo_advance`
2. `web_search` itself generates "search" dimension → also resets counter in non-productiveOnlyMode
3. `productiveOnlyMode=true` (needed to accumulate counter) only activates for `isStructuredReadOnlyPlanningLoop` actions (read-only planning actions with unfinished todos) or `isLongResearchRun` (longFormMode)
4. longFormMode (`isLongResearchRun`) requires `runState.researchActivation === "long_research"` OR active `long-web-research`/`deep-research-writer` skill — neither available in standard E2E test

Conclusion: readOnlyPlanning hard_veto is designed for longFormMode (long-web-research/deep-research-writer skills). Unit tests are the correct validation path. E2E validation would require `runState.researchActivation = "long_research"` via thread hydration (not exposed in public `runtime.run()` API).

**AGRUN-237-GAP-03 (context engineering fix — lengthProgress compression, shipped 2026-05-19):**

Root cause: `planner-prompt-projection.js` `summarizeObservationOutputForPrompt` had NO special handler for workspace mutation kinds (`virtual_workspace_write`, `virtual_workspace_append`, `virtual_workspace_replace`, `virtual_workspace_insert_after_section`, `virtual_workspace_read`). These fell through to `summarizeGenericOutputForPrompt` (2000-char JSON cap). When workspace file content causes `quality.checks` to push JSON past 2000 chars, the entire output — including structured `lengthProgress` — gets serialized to an opaque string. The AI can no longer read `lengthProgress.remainingLength` as a number, so it writes 6–7 words per `workspace_append` call instead of substantive prose.

Fix (`src/runtime/planner-prompt-projection.js`):
- Added `WORKSPACE_MUTATION_KINDS` set for write/append/replace/insert_after_section
- Added `summarizeWorkspaceMutationForPrompt()` helper: always preserves `lengthProgress` as structured top-level field; trims `quality` to `{finalCandidateReady, status}` only (drops `checks`/`finalCandidateStructure`); preserves `mutationStats.delta.words` + `file.textStats`; includes per-action fields (status, changed, matchCount, suggestion, heading, availableHeadings)
- Added special case for `virtual_workspace_read`: preserves `lengthProgress` + truncates content to 2000 chars with marker instead of opaque JSON dump

6 new unit tests in `test/unit/planner-prompt-workspace-observation.test.js`, registered in `smoke.test.js`. `npm test` 816 PASS 0 FAIL. `npm run build` success.

**AGRUN-237-GAP-04 (write-overwrite oscillation — DONE 2026-05-19, convergence bypass fixed 2026-05-19):**

Root cause: Flash-lite models fall into a write-overwrite oscillation loop — calling `workspace_write` repeatedly on the same file, each time replacing ~70-100 words of content, never accumulating to the 3000-word target.

Investigation timeline:
1. GAP-03 fix delivered `lengthProgress` signal correctly
2. `preflightWorkspaceWriteProtect` gate and transparent redirect approach — both reverted (redirect violated AI-first; introduced `terminalRepairActive=False` regression)
3. `workspaceMutationGrowthConvergence` was already implemented but NOT reaching hard_veto due to TWO bugs found via E2E JSONL analysis

**E2E v15 (2026-05-19) root cause analysis (from JSONL):**
- Bug 1 (bypass): `maybeBlockReadOnlyPlanningLoop` at line 1050 bypassed hard_veto when `workspace_write` was in `terminalRepairState.allowedActions` → `readOnlyPlanningState.ignoredCount` reached 8 but `workspace_write` was NEVER blocked
- Bug 2 (bypass): `selectPlannerActions` early-returned on `allowedRepairActions` before checking `readOnlyPlanningForbiddenActions` → hard_veto forbidden actions were silently bypassed
- Bug 3 (stall counter): `workspaceMutationGrowthConvergence.stallCount` reset to 0 when `workspace_append` had positive delta → write→append oscillation meant stall counter oscillated 0→1→0→1, never reaching activation threshold of 2

**Fixes shipped 2026-05-19:**
- `planner-action-surface.js`: hard_veto forbidden checks moved BEFORE `allowedRepairActions` early-return; added `resolveWorkspaceMutationGrowthForbiddenActions()` function
- `action-loop-action.js` `maybeBlockReadOnlyPlanningLoop()`: bypass removed for hard_veto — when `readOnlyPlanningState.escalation=hard_veto` for the specific action, hard_veto wins over repair allowlist
- `action-pattern-convergence.js` `updateWorkspaceMutationGrowthConvergence()`: non-workspace_write mutations (append/replace/insert) now passthrough without resetting stall counter; destructive overwrites (deltaWords < 0) activate advisory immediately (not after 2 stalls)
- Tests: 5 new unit tests in `planner-action-surface.test.js` + 2 updated/new tests in `action-pattern-convergence.test.js`
- `npm test` 875 PASS 0 FAIL

**AGRUN-237-GAP-04 follow-up (repairAllowedActions bypass fix + unit test — 2026-05-19):**

Bug discovered via live E2E Run v1: `maybeBlockActionPatternRepeat()` in `action-loop-action.js` had a second bypass path — `repairAllowedActions.includes(actionName) return null` at line 968 ran AFTER the `workspaceMutationGrowthConvergence` guard, so when `terminalRepairState.active=true` and `allowedActions` included `workspace_write`, the hard_veto was never returned.

Fix: added early hard_veto check for `workspaceMutationGrowthConvergence` BEFORE the `repairAllowedActions` bypass. Hard_veto on write-overwrite oscillation is not overridable by terminal repair allowlist (oscillation indicates AI confusion that repair cannot resolve).

Added unit test (Test F in `action-pattern-convergence.test.js`): verifies `maybeBlockActionPatternRepeat` returns hard_veto even when `terminalRepairState.active=true` and `allowedActions` includes `workspace_write`. Required adding `export` to `maybeBlockActionPatternRepeat` and a `test/unit/virtual-stub-loader.mjs` to shim `virtual:agrun-*` Rollup aliases in the Node test context.

- `npm test` 876 PASS 0 FAIL

**E2E v16 (2026-05-19) validation:**
- v15: tight 10-write × 9-append oscillation, never published, API timeout at cycle 29
- v16 (with fix): no tight oscillation; model did substantive research (5+ web_search, 2 read_url); candidateWords grew to 2043 (vs v15 max ~2145 in brief flashes); only 1 destructive write at cycle 27 after readOnlyPlanningState was cleared by source progress; API timeout (unrelated to logic)
- Fix validated: `readOnlyPlanningIgnoredCount` hard_veto correctly interrupted the oscillation pattern; oscillation cycle count 10→1
