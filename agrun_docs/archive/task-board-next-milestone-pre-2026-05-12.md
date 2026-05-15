# Next Milestone — Archive (pre 2026-05-12)

Archived from `task.md` on 2026-05-14. Cutoff: 2026-05-12.

Contains the 'Recent decisions:' historical log from the Next Milestone section. These decisions are now landed in commits and ADRs; this file is read-only narrative history.

---

## Recent decisions (pre 2026-05-12)

- 2026-05-11 Task progress long Goal UI fix: the expanded Task progress panel
  let very long goal prompts consume too much vertical space and push Todo
  list content below the visible area. Updated
  `examples/browser/src/components/TodoProgressPanel.tsx` so the Goal paragraph
  has a bounded height (`max-h-32`, `lg:max-h-40`), independent vertical
  scrolling, and long-token wrapping via `overflow-wrap:anywhere`. Browser QA
  injected a long 3000-word harness report goal and active TodoState; DevTools
  measured Goal client height 160px, scroll height 520px, Todo list visible,
  and no horizontal page overflow. Mobile sheet quick check measured Goal
  client height 128px, scroll height 240px, Todo list visible, and no
  horizontal overflow. Verification:
  `npm --prefix examples/browser run build`. Evidence:
  `agrun_docs/live-tests/task-progress-goal-scroll-2026-05-11.md` and
  `agrun_docs/live-tests/task-progress-goal-scroll-2026-05-11.png`,
  `agrun_docs/live-tests/task-progress-goal-scroll-mobile-2026-05-11.png`.
- 2026-05-11 MCP Chrome 3000-word rerun5/rerun6 inspector follow-up:
  reviewed the latest support bundles for the harness engineering report
  failure. Rerun5 proved workspace expansion could exceed 3000 visible words,
  but terminal formatting was bad: the exact final marker appeared multiple
  times and did not end the answer cleanly; TodoState was stale at terminal.
  Rerun6 completed via `workspace_publish_candidate` with fresh TodoState and
  final candidate `harness_engineering_report.md`, but the candidate was only
  2575 words while the AI declared length satisfied by comparing 18602 chars
  against a 3000-word request. Inspector also showed 2 `read_url` attempts, 0
  successful reads, 502 errors, and a lost long-research gate
  (`researchFinalReason=not_long_research`). Fixes: terminal publish now
  checks explicit final suffix contracts, blocks stale TodoState before
  publish, rejects chars-as-words readiness for explicit word-count requests,
  and persists `researchActivation:"long_research"` across thread
  resume/continuation. `test/helpers/mocked-fetch.js` and planner concern
  assertions were updated so mocks model AI-owned TodoState synchronization
  before publish. Verification passed: `workspace-actions`,
  `research-thread-sync`, `research-state`, `planner.test`, and `npm test`.
  HBR: `read_url` service remains externally failing with 502 in inspector
  evidence, and no post-fix real Gemini browser rerun has yet proven the full
  3000-word prompt now passes. Evidence:
  `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-rerun5-rerun6-2026-05-11.md`.
- 2026-05-11 MCP Chrome rerun4 after custom workspace continuation fix:
  attempted one more real browser verification at
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-3000word-harness-report-rerun4&qa_clean=y&qa_auto_approve_tier1=y`.
  The run did not reach workspace/finalize behavior because Gemini returned
  no text output or function calls at Step 1/4. HBR: this is not valid
  evidence for or against the fix; it is a provider empty-response failure.
  Unit coverage verifies the fix:
  `action-loop-session-terminals.test.js` now checks that custom `report.md`
  workspace drafts redirect direct finalize into the same-path workspace
  publish protocol. Evidence:
  `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-rerun4-provider-empty-2026-05-11.md`.
- 2026-05-11 MCP Chrome 3000-word rerun after prompt/skill path guidance:
  reran the same prompt at
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-3000word-harness-report-rerun3&qa_clean=y&qa_auto_approve_tier1=y`
  after clarifying custom workspace path publish guidance. Result still
  failed: visible answer was 7194 chars / 1008 words and missed
  `MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE`. New evidence: the guidance
  improved workspace expansion (`report.md` v4 reached 18924 chars), but
  Gemini Lite still chose direct `finalize`; existing
  `workspace_publish_path_required` only detected `final_candidate.md` or
  `draft.md`, so custom `report.md` did not trigger continuation. Fixed
  `maybeContinueOnWorkspacePublishPath` to detect non-empty custom
  user-facing draft paths from recent workspace content operations and feed
  back the same AI-first protocol signal: use the same path for
  `workspace_finalize_candidate` / `workspace_read` /
  `workspace_publish_candidate`, or promote it to `final_candidate.md`. This
  is a protocol mismatch signal only; runtime still does not judge source,
  length, or content sufficiency. Evidence:
  `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-rerun3-2026-05-11.md`.
- 2026-05-11 MCP Chrome 3000-word rerun after workspace expansion tools:
  reran the exact prompt in MCP Chrome at
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-3000word-harness-report-rerun2&qa_clean=y&qa_auto_approve_tier1=y`.
  Result still failed the user requirement: visible answer was 8691 chars /
  1267 words and missed `MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE`.
  Important new finding: workspace expansion itself worked. Inspector
  showed `workspace_append` succeeded and `report.md` reached 13323 chars,
  but AI then chose direct `finalize` instead of
  `workspace_finalize_candidate` + `workspace_read` +
  `workspace_publish_candidate`, so the finalizer LLM compressed the
  workspace artifact into a shorter answer. Root cause is custom workspace
  path + direct finalize bypassing verbatim publish, not lack of workspace
  mutation tools. read_url also remains blocked by browser CORS to the
  Mac mini read_url endpoint (`net::ERR_FAILED`, surfaced as 502). Fixed
  the AI-first guidance in `planner-prompt.js`,
  `planner-native-system-prompt.js`, and `skills/long-web-research/SKILL.md`
  so custom report paths must be finalized/read/published by the same path
  or promoted to `final_candidate.md`; direct finalize is explicitly
  described as a model rewrite path that may shorten the artifact. Evidence:
  `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-rerun2-2026-05-11.md`.
- 2026-05-11 Workspace expansion + read_url recovery follow-up:
  inspected the MCP Chrome 3000-word harness report support bundle again.
  Root cause is not just web_search/read_url. The agent had enough
  observable facts to know the final candidate was short (`words=1215`
  against requested 3000 words), but the available workspace mutation path
  was brittle: `workspace_replace` depended on exact text and repeated
  finalize/publish became the lowest-friction path. Added
  `workspace_append` and `workspace_insert_after_section` so AI can expand
  a final candidate or specific Markdown section without rewriting the
  artifact. Publish protocol now treats write/replace/append/section-insert
  as content changes requiring a fresh finalize/read before terminal
  publish. `read_url` failures now include AI-facing recovery guidance:
  refine web_search, read an alternate strong source, retry only when
  retryable, and publish with limitations when no successful read source is
  available. Updated `long-web-research` and browser skill bundle. Targeted
  tests passed: `virtual-workspace`, `workspace-actions`,
  `read-url-window`; skill manifest/browser copy regenerated. HBR: no real
  Gemini browser rerun has proven the 3000-word request now passes. Evidence:
  `agrun_docs/live-tests/workspace-expansion-readurl-recovery-2026-05-11.md`.
- 2026-05-11 MCP Chrome 3000-word harness engineering report live test:
  user asked to test the browser AI agent by requesting a 3000-word
  report about AI agent harness engineering information. Ran the flow in
  MCP Chrome at
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-3000word-harness-report&qa_clean=y&qa_auto_approve_tier1=y`
  with real Gemini (`gemini-3.1-flash-lite-preview`). The run completed,
  selected `long-web-research`, terminalized via
  `workspace_publish_candidate`, and produced the required marker
  `MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE` with no user-facing internal
  action/TodoState/finalReadiness leakage. HBR: it failed the actual user
  requirement. DOM answer count was 1133 words; Inspector final candidate
  stats showed 1215 words, only ~38-41% of the requested 3000 words.
  Inspector still showed `Research Contract Warning`, `read_url error
  502`, weak/thin evidence gates, stale Todo progress at terminal, and an
  AI-declared `finalReadiness=ready` despite failing the requested word
  count. Evidence:
  `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-2026-05-11.md`
  and
  `agrun_docs/live-tests/mcp-chrome-3000word-harness-report-2026-05-11.png`.
- 2026-05-11 MCP Chrome long-research live test after AGRUN-217:
  ran the browser example through MCP Chrome DevTools at
  `http://127.0.0.1:3331/?debug_yn=y&qa=mcp-chrome-long-research&qa_clean=y&qa_auto_approve_tier1=y`
  using real Gemini (`gemini-3.1-flash-lite-preview`) with seeded
  read_url/web_search settings. The run completed with
  `selectedSkill=long-web-research`, terminalized by
  `workspace_publish_candidate`, final candidate `final_candidate.md`,
  `chars=2833`, `words=357`, final marker
  `MCP_CHROME_LONG_RESEARCH_OK`, and no user-facing leakage of
  `TodoState`, workspace action names, or `finalReadiness` JSON.
  Actions observed: `list_agent_skills`, `read_agent_skill`,
  `todo_plan`, `web_search`, `read_url`, second `web_search`,
  `workspace_write`, `workspace_finalize_candidate`, `workspace_read`,
  `workspace_publish_candidate`. `publishBlockHistory=[]`, so this run
  did not exercise publish-block recovery; instead, the model satisfied
  finalize/read/readiness protocol before publish. HBR: MCP Chrome console
  showed read_url CORS failure to
  `https://readurl.yapweijun1996.com/read-url`, network showed
  `net::ERR_FAILED`, Inspector summarized `read_url error 502`, research
  gate reported weak/thin evidence gaps, AI self-audit declared
  `finalReadiness.decision=ready` despite runtime-observed
  `successfulReadUrlCount=0`, and TodoState was stale at terminal
  (`2/3 done`, active item `Finalize and publish candidate`). Evidence:
  `agrun_docs/live-tests/mcp-chrome-long-research-2026-05-11.md` and
  `agrun_docs/live-tests/mcp-chrome-long-research-2026-05-11.png`.
- 2026-05-11 AGRUN-217 prompt policy split + structural Todo detection:
  moved long-research/workspace workflow policy out of
  `planner-prompt.js`, `planner-native-system-prompt.js`, action
  guidance, and envelope examples into `skills/long-web-research/SKILL.md`.
  Runtime prompt now keeps only tool contracts, read-only state, and
  action-contract feedback; the skill owns evidence workflow, workspace
  packet shape, blocked publish recovery, and limited-publish
  `finalReadiness` JSON. `todo-detection.js` no longer ships English
  semantic defaults such as research/news/report/debug/build; default
  detection is structural only (multi-step/progress/todo/task-list),
  while hosts may still opt in with `corePattern` / `extendedPattern` or
  nested `detection.*` patterns. Virtual workspace internal-section
  stripping now has one SSOT in `virtual-workspace.js`; final-answer
  normalization re-exports and uses that implementation, including
  free-form filenames. Targeted verification passed:
  `todo-detection`, `todo-autopilot`, `todo-autostart`,
  `todo-plan-progress`, `virtual-workspace`,
  `final-answer-internal-progress`, `workspace-actions`,
  `planner-native-system-prompt`, and `planner-prompt-envelope-lines`.
  HBR: no real Gemini/OpenAI browser e2e was run for this slice; this is
  a prompt/contract cleanup plus unit coverage, not a live quality proof.
- 2026-05-11 Bug A fix - TodoState audit preserved at terminal: user
  reviewed Run #4 inspector and pointed out the runtime mismatch
  ("TodoState logic and activity log are not tally"). Inspector
  showed counts=4/5 done + activity log showed real todo_plan /
  todo_advance / todo_run_next, but chat-store session.todoState was
  null. Root cause: `observeTodoStateOnTerminal` did
  `runState.todoState = null`, which `handle.js:345` then mirrored
  back onto `activeThread.todoState`, destroying the audit snapshot.
  The "do not steer the next turn" intent was correct but conflated
  state ownership with prompt projection. Fix: annotate, do not
  destroy. `observeTodoStateOnTerminal` now sets
  `runState.todoState = { ...prev, terminatedAt, terminatedBy }` so
  items keep honest status and the audit snapshot survives in
  activeThread.todoState. The next-turn-not-steered responsibility
  moved to projection gates: `isTerminalTodoState` (run-state-thread.js)
  treats `terminatedAt != null` as terminal so hydration nulls
  runState.todoState; `summarizeTodoStateForPrompt` (todo-state.js)
  short-circuits at the central render site; `hasPromptTodoState`
  (planner-prompt.js) excludes from long-run-state classification.
  Tests: inverted finalize-sync test, new
  todo-state-terminated-projection test, extended thread-hydration
  test, updated planner.test workspace-publish-candidate assertion.
  Real Gemini e2e proof (post-fix, fresh chat, lite model): chat-store
  session.todoState is no longer null - 5 items with honest status
  (i-1/2/3 done, i-4 active, i-5 pending), terminatedBy =
  workspace_publish_candidate, terminatedAt timestamp set; runtime-store
  thread.todoState equally preserved; lastRun.todoTerminalObservation
  unchanged. No push-mode introduced (items not falsely marked done,
  annotation is pure observation).
  Evidence:
  `agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md`
  (Bug A fix section) and
  `agrun_docs/live-tests/todo-state-audit-preserved-2026-05-11.jpeg`.
- 2026-05-11 Honest e2e baseline post-revert (Run #4): same prompt /
  same lite model / current AI-first runtime (no hardcoded user-prompt
  parsing) delivered 1327 cjk_chars = 44% of requested 3000. Workflow:
  AI made evidence.json -> draft.md -> critique.md -> final_candidate.md
  with 7 reads + 5 writes/replaces of draft.md before finalize+publish.
  AI did NOT load any skill (activeSkill=null) yet still reproduced the
  multi-artifact deep-research pattern from the planner prompt's
  general workspace guidance. terminalizedBy=workspace_publish_candidate,
  no error. Four-run comparison on identical prompt + lite model:
  Run #1 (throw bug) 0% / failed; Run #2 (post throw->blocked refactor)
  17%; Run #3 (with hardcoded signals, REVERTED) 71% (disowned);
  Run #4 (honest baseline) 44%. The 2.6x lift from Run #2 to Run #4
  comes purely from the publish-push-mode deletion letting AI iterate.
  Beating 44% with AI-first follow-ups (skill workflow text + model
  selection) is the next sprint; beating it with runtime hardcode is
  forbidden.
  Evidence:
  `agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md`
  (Honest baseline section + four-run comparison table) and
  `agrun_docs/live-tests/workspace-readiness-real-e2e-honest-baseline-2026-05-11.jpeg`.
- 2026-05-11 REVERT user-request signals (hardcode violation): user
  flagged that `parseRequestedLength` (regex-parsing "3000" + CJK char
  unit etc. out of the user's prompt) and `findRelevantSkillMatch`
  (runtime ranking which catalog skill fits the user prompt) were both
  runtime doing AI's semantic interpretation of the user query. Same
  shape as the deleted English-only research-trigger regexes from
  prior push-mode sprints. Reverted in the same session: deleted
  `src/runtime/user-request-signals.js`, deleted the unit test, removed
  the `userRequestSignals` option + the
  `user_requested_length` / `relevant_skill_match` lines from
  `buildVirtualWorkspacePromptBlock`, removed the import + call in
  `planner-prompt.js`, removed the smoke runner registration. Added a
  guard assertion in `virtual-workspace-readiness-prompt.test.js` that
  asserts the ABSENCE of those two prompt lines so future contributors
  do not re-introduce the same hardcode. The Run #3 e2e result that
  showed 71% delivery (AI activating long-web-research, revising at
  cycle 27) was real but bought with hardcode and is therefore
  disowned. True root cause restated: AI sees the user's requested
  length verbatim at the top of every planner prompt and sees
  workspace observed-length facts in the workspace block; the
  comparison is AI's work, not runtime's. Next AI-first work is model
  selection baseline (`gemini-2.5-pro`) and skill workflow text
  tightening, NOT runtime intent parsing.
  Evidence:
  `agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md`
  (REVERT section + reverted Update section retained as record of
  what was attempted and why it was wrong).
- 2026-05-11 (REVERTED — see entry above) User-request signals (length + relevant skill) in workspace
  prompt block: real Chrome MCP e2e of the same Chinese 3000 字 prompt
  AFTER the publish push-mode deletion exposed a still-unmet user
  requirement: AI delivered only 17% (503 cjk_chars) of the requested
  length and never even loaded any agent skill. Inspector forensics
  showed the chain `agentSkillContext.activeSkill=null` ->
  `isLongResearchRun=false` -> `isResearchPublishReadinessRequired=false`
  -> readiness audit skipped -> AI saw `final_candidate_cjkChars=503`
  with no `user_requested_length=3000` anchor in the prompt.
  Fix (AI-first observation, no push): new module
  `src/runtime/user-request-signals.js` with `parseRequestedLength`
  (language-neutral regex for cjk_chars/chars/words/tokens) and
  `findRelevantSkillMatch` (token-overlap ranker). Workspace prompt
  block now ships two new fact lines when the parse succeeds:
  `user_requested_length=<N> <unit>` and
  `relevant_skill_match=<name> (loaded:yes|no, score:<N>)`. Source CJK
  invariant kept via `new RegExp("\\u5B57", "u")` and
  `String.fromCharCode(0x5B57, ...)` in tests. Real e2e re-run AFTER
  signals: cycleCount=41/80 (3.2x deeper), AI activated long-web-research
  skill, made outline.md + draft.md + final_candidate.md (proper artifact
  discipline), AI revised final_candidate at cycle 27 after seeing the
  length gap, terminalizedBy=workspace_publish_candidate, final candidate
  2127 cjk_chars / 71% of requested. HBR: 71% is a real improvement
  (4.2x cjk_chars, 3.5x total chars vs prior 17%) but still short of
  100%. Two remaining gaps documented for the next sprint: (a) AI did
  not declare finalReadiness.requirementsAssessment so publish readiness
  audit could not auto-compare requestedLength to observedLength;
  (b) lite model plateau. Both have AI-first follow-ups in the live-test
  doc; do NOT add runtime auto-revise hardcoded thresholds.
  Evidence:
  `agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md`
  (Update sections 2 + 3) and
  `agrun_docs/live-tests/workspace-readiness-real-e2e-after-signals-2026-05-11.jpeg`.
- 2026-05-11 Workspace publish push-mode deletion + real Gemini e2e pass:
  Real Chrome MCP e2e of the same Chinese 3000-character deep-research prompt
  surfaced a previously-missed runtime push-mode site:
  `executeWorkspacePublishCandidateAction` had four hardcoded throws
  (#1 empty content, #2 finalize-after-write, #3 read-after-finalize,
  #4 readiness-check) that killed the entire 53-cycle run when AI's call
  sequence did not match the rigid write→finalize→read→publish protocol.
  Fix: kept throw #1 (legitimate I/O guard for empty content), converted
  throws #2/#3/#4 to non-throwing `control:"continue"` returns with
  `kind:"virtual_workspace_publish_blocked"` + an explanatory `message`
  field. AI sees the block as its next observation and decides recovery,
  runtime never erases prior cycles. Promoted `inspectWorkspacePublishProtocol`
  to a `virtual-workspace.js` SSOT export. Workspace prompt block now also
  surfaces `publish_protocol_state=finalized_after_write:yes|no,
  read_after_finalize:yes|no` so AI sees the protocol state every cycle.
  Real e2e re-run AFTER fix: cycleCount=13/80, runStatus=completed,
  finalAnswerSource=workspace_publish_candidate,
  terminalizedBy=workspace_publish_candidate, no error, full pipeline
  ran end-to-end. HBR: published candidate is short (899 chars / 503
  cjk_chars vs requested 3000 字) — but that is now an AI quality call,
  not a runtime crash. Lite model + skill encouragement of explicit
  `limited` declaration is the next AI follow-up, NOT a runtime change.
  Evidence:
  `agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md` (Update
  section) and
  `agrun_docs/live-tests/workspace-readiness-real-e2e-after-2026-05-11.jpeg`.
- 2026-05-11 Plan-args fallback SSOT + workspace readiness facts: extracted
  the duplicated alias chain (toolArgs / tool_args / toolArguments /
  tool_arguments + JSON variants + `arg_`-prefixed flat fields) from
  `planner-tools.js` and `action-loop-utils.js` into a single
  `src/runtime/plan-args-fallback.js` module. Both call sites now import
  `readPlanActionFallbackArgs` + `mergeMissingArgs`; future alias additions
  no longer require synchronizing two files. Removed the residual
  "For Gemini" wording in the plan-tool description text — capability
  registry (`toolArgsJsonRequired`) is the SSOT, the description text is now
  provider-neutral. Workspace prompt block in `virtual-workspace.js` now
  surfaces fact-only readiness fields to AI (without runtime decisions):
  `final_candidate_status` (missing|empty|drafted|ready),
  `final_candidate_chars` / `cjkChars` / `words`, plus `cycles_used` /
  `cycles_max` (wired from `runState.cycleCount` / `runState.maxSteps` in
  `planner-prompt.js`). Trailing prose rewritten to emphasize "Facts above
  are read-only observations. AI owns the next move..." with no imperative
  "you should publish" verbs. New units: `plan-args-fallback.test.js` (13
  PASS), `virtual-workspace-readiness-prompt.test.js` (8 PASS) including a
  fact-only invariant assertion. Full `npm test` exits 0; build clean; dev
  server boots and serves the new module bytes.
  HBR: the original 80-step real-Gemini deep-research e2e from 2026-05-10
  was NOT re-run in this session (multi-minute wall-time, non-deterministic).
  Whether the readiness facts actually shorten the "draft.md exists but
  final_candidate.md missing" gap is the next manual live question. If the
  rerun still fails, the next step is splitting SKILL.md Phase G into
  G1 Publish path / G2 Finalize fallback — DO NOT add a runtime
  auto-publish trigger or strengthen prompt verbs.
  Evidence:
  `agrun_docs/live-tests/workspace-readiness-ssot-2026-05-11.md`.
- 2026-05-10 Workspace publish discipline follow-up: confirmed the right
  architecture for long end-user reports is workspace-first, not one-shot
  final-token generation. `workspace_publish_candidate` now also records
  terminal Todo observation (`unfinished_at_terminal`) and emits
  `todo-state-terminal-observed` before clearing stale live TodoState, so direct
  workspace publish cannot hide unfinished AI progress. `deep-research-writer`,
  `long-web-research`, native planner prompt, and envelope prompt now tell AI to
  build `evidence.json` / `draft.md` / `critique.md` / `final_candidate.md`
  across OODAE turns, then promote and publish the selected candidate when the
  draft is substantive and critique has no blocking evidence gap. Inspector
  Support now has `Copy Workspace Packet` for workspace files, operations,
  publication state, Todo terminal observation, and recent workflow/action rows.
  HBR: this fixes harness/debug workflow discipline, but a real Gemini/OpenAI
  rerun is still needed to prove provider behavior improves.
  Evidence:
  `agrun_docs/live-tests/workspace-publish-discipline-2026-05-10.md`.
- 2026-05-10 Real Gemini workspace publish QA: real Chinese 3000-character
  AI-browser research runs proved the new direct publish action exists but also
  exposed a lower-level payload wiring issue. Gemini native plan actions put
  valid normal action arguments in `toolArgsJson` while also emitting `args:{}`
  for actions such as `read_url`; runtime executed the empty args, producing
  repeated `invalid_url` reads. Plan parsing/validation now treats
  `toolArgsJson` / `toolArgs` as generic argument fallback for all plan action
  names, not only `execute_skill_tool`. After the fix, real read_url calls used
  non-empty URLs and succeeded. `deep-research-writer` was also simplified to
  remove numeric evidence-exhaustion thresholds, require workspace updates after
  evidence batches, move from usable evidence to drafting, and move from a
  usable draft to critique/final candidate instead of broad search. HBR:
  45-step real Gemini QA reached `draft.md` with 3828 chars but still did not
  reach `final_candidate.md` / `workspace_publish_candidate` before budget.
  Evidence:
  `agrun_docs/live-tests/workspace-publish-real-gemini-2026-05-10.md`.
- 2026-05-10 Workspace publish candidate: added
  `workspace_publish_candidate` so AI can draft in virtual workspace, mark the
  selected candidate, then publish that exact candidate content to the end user
  without a second finalizer LLM rewrite. Planner/native prompts and
  `deep-research-writer` now prefer direct workspace publish when the selected
  candidate is the user-facing answer; `finalize` remains a fallback for cases
  where AI intentionally wants finalizer synthesis. Inspector Debug Index now
  shows candidate path/readiness/published state and text stats. Evidence:
  `agrun_docs/live-tests/workspace-publish-candidate-2026-05-10.md`.
- 2026-05-10 Workspace candidate SSOT fix: `workspace_finalize_candidate(path)`
  now preserves the selected final candidate path through virtual workspace
  quality, stats, finalizer prompt projection, and Readiness Packet export.
  This removes the hidden fallback where free-form candidates such as
  `answer.md` were marked ready by the action but quality/Inspector later
  looked back at `final_candidate.md`. The finalizer prompt now always includes
  the selected final candidate when it has content, even when other workspace
  files are omitted by prompt projection limits. Evidence:
  `agrun_docs/live-tests/workspace-candidate-ssot-2026-05-10.md`.
- 2026-05-10 Readiness Packet + skill workflow QA: Support panel now has
  `Copy Readiness Packet`, a focused export for `finalReadiness`,
  `finalReadinessAssessment`, `requirementsAssessment`,
  `readinessContinuationSignal`, workspace quality/stats, `final_candidate.md`
  content when present, and compact read_url source summaries. The
  `deep-research-writer` skill now uses `evidence.json` to match virtual
  workspace SSOT, tells AI to keep TodoState synchronized, requires
  `final_candidate.md` to exist/read back before finalizing, and treats
  readiness continuation as a normal OODAE continuation. Real browser QA:
  Gemini completed but still under-delivered and sometimes finalized with
  missing `final_candidate.md`; OpenAI ran for 5m52s, reached 39 cycles, and
  was interrupted after repeated search loops with stale Todo progress. HBR:
  the issue is not missing tools; it is model workflow discipline. Evidence:
  `agrun_docs/live-tests/readiness-packet-skill-workflow-2026-05-10.md`.
- 2026-05-10 Runtime Lifecycle follow-up: Support panel now exposes `Copy
  Lifecycle`, a smaller debug payload containing Debug Index, Runtime
  Lifecycle, action result envelopes, and Todo progress. Debug Index now
  promotes `todo_progress_stale` as the first signal when a work action happens
  after the last Todo progress action, adds visible `Task Progress` and
  `Action Results` rows, and Raw tabs include `Todo Progress Debug`. This keeps
  the harness AI-first: runtime observes that progress did not advance, but AI
  still decides whether to continue, advance todo, replan, or finalize with
  limitations. Chrome MCP was recovered by restarting the stale
  `chrome-devtools-mcp` server after its dedicated Chrome process exited; a
  real Gemini turn verified `Copy Lifecycle` changed to `Copied`, Debug Index
  showed `Task Progress`/`Action Results`, and Raw included `Todo Progress
  Debug`. Evidence:
  `agrun_docs/live-tests/chrome-mcp-copy-lifecycle-ui-2026-05-10.md`.
- 2026-05-10 Runtime Lifecycle Inspector slice: added a browser-side
  `runtimeLifecycle` projection and `actionResultEnvelopes` projection over
  existing `runtime_steps`. Inspector now has a visible Runtime Lifecycle
  section, Debug Report includes `[runtime_lifecycle]` and
  `[action_result_envelopes]`, Support Bundle exposes
  `trace.runtimeLifecycle` / `trace.actionResultEnvelopes`, Raw tabs include
  `Runtime Lifecycle` and `Action Results`, and Debug Index summarizes latest
  lifecycle/action envelope state. This is no-guess observability only; runtime
  still does not judge answer length/source sufficiency or auto-decide research
  direction. Real headless Chrome/CDP Gemini QA on the Chinese 3000-character
  AI-browser prompt passed after opening Inspector correctly: headings included
  Runtime Lifecycle, OODAE Cycles, AI Workflow, LLM Trace, Virtual Workspace,
  and Evidence; issue type was `Healthy Run`; visible output had about 3045 CJK
  characters. HBR: Chrome DevTools MCP itself returned `selected page has been
  closed`, so the live check used local headless Chrome CDP instead.
- 2026-05-10 sample project research for OODAE/Inspector debugging: reviewed
  LangGraph, Goose, Hermes Agent, and Open WebUI sample logic for a solution to
  "Activity shows drafting/running but task progress does not explain itself".
  Decision: keep runtime simple and AI-first. The reusable pattern is one
  `runtime_steps` event log with derived Inspector trace modes, explicit
  interrupt/resume/abort/task lifecycle events, stable action result envelopes,
  action availability metadata, and a hard boundary between debug-only records
  and agent-visible prompt projection. Runtime may validate protocol shape and
  expose raw facts, but must not decide whether a 3000-character report or
  source set is sufficient.
- 2026-05-10 sample project workflow review for weak finalize: reviewed
  `swarm-main`, `ai-ai-6.0.119`, `agents-js`, `goose-1.27.2`,
  `openclaw-2026.3.8`, and `langgraph-cli-0.4.14` against the case where AI
  sees weak evidence/short workspace output, declares limited readiness, then
  still finalizes. Decision: the reusable solution is an AI-owned
  `readiness_continuation_signal`. Runtime can feed back the AI's own
  limited/unsatisfied `finalReadiness` declaration as a next-cycle observation
  when budget remains; AI still decides whether to continue tools/workspace or
  finalize with limitations. This borrows AI SDK step/stop-condition thinking,
  agents-js minimal TurnState/evaluator shape, Goose result-envelope validation,
  and Swarm's compact loop without importing their hardcoded completion rules.
- 2026-05-10 real research Inspector QA (`1 3`): reran the Chinese
  3000-character AI-browser research prompt in Chrome on
  `http://localhost:3001/?debug_yn=y&qa_auto_approve_tier1=y`. Inspector now
  exposed the actual reason path without guessing: `Research Contract Warning`,
  first signal `AI finalized with declared limitations`, `finalReadiness=limited`,
  `requirementSatisfied=false`, `lengthSatisfied=false`,
  `evidenceSatisfied=true`, workspace `final_candidate.md` about 1463 chars
  / 794 CJK chars, and an observed mismatch where AI claimed 4 successful
  reads while runtime observed 1 successful `read_url`. HBR: the answer still
  under-delivered the end-user requirement; this confirms the next fix is
  AI/skill workflow quality, while Inspector now makes the failure path easy
  to locate.
- 2026-05-10 Inspector copy UX: Support panel now includes `Copy Debug Index`
  next to `Copy Support Bundle`, with visible copied/failed feedback. This lets
  debugging start from the small first-pass SSOT instead of sending the full
  Support Bundle when the issue is already visible in `debugIndex`.
- 2026-05-10 live Inspector QA correction: a real browser run on
  `http://localhost:3001/?debug_yn=y` using Gemini for a simple first-turn
  prompt confirmed Debug Index, OODAE Cycles, AI Workflow, and LLM Trace render
  together. HBR found and fixed: simple completed first-turn final answers were
  incorrectly classified as `Planner / Clarification Loop` because fresh
  session diagnostics were treated as an issue. Completed non-clarification
  final answers now classify as `Healthy Run`; true `ask_clarification` and
  continuity faults still classify as issues.
- 2026-05-10 OODAE Inspector correction: Inspector now has a dedicated
  `OODAE Cycles` section and support-bundle/debug-report
  `oodaeCycleDebugLedger` projection. It groups existing runtime steps by
  cycle and shows observe/orient/decide/act/evaluate state, planner request
  prompt size/hash/preview, planner response type/preview, AI decision,
  action result, observation, evaluate outcome, repair status, and block/error
  signals. This is browser debug projection only; runtime still does not judge
  whether a report is long enough or whether evidence is sufficient.
- 2026-05-10 real Chrome/Gemini QA for OODAE Inspector: the Chinese 3000
  character AI-browser prompt completed and the new Inspector section showed
  4 cycles, 7 LLM requests/responses, approval-resume block signals, large
  prompt sizes, final `decision=finalize`, `source=planner_finalize`, and
  AI-declared `finalReadiness=ready`. HBR remains: visible report was still
  materially shorter than 3000 Chinese characters, while the AI claimed the
  requirement was satisfied.
- 2026-05-10 LLM Trace optimization follow-up: `read_url` now supports
  AI-selected text windows via `textStart` and `textLength`, so prompt
  compaction does not cut off the agent's ability to inspect later source
  text. Inspector LLM Trace now shows first-to-latest request comparison plus
  JSON/CSV copy export. Finalizer session context uses a compact projection
  that preserves goal/topic/memory/read-source metadata while dropping raw
  history/read_url body duplication.
- 2026-05-10 read_url continuation follow-up: browser read-url service
  requests now forward `maxBytes`, `timeoutMs`, `textStart`, and `textLength`;
  service responses can declare an already-applied `textRange` so runtime does
  not double-crop later windows. Inspector Evidence now shows `Read URL
  Windows` with `range`, `next`, `more`, status, and text length. Support no
  longer treats AI-requested source windows as Tool/Read URL failures just
  because `truncated=true`. Project `web-research` skill now also reminds AI to
  use `textRange.nextTextStart` when later page text may matter.
- 2026-05-10 Inspector debug index review: Support Bundle now includes a
  `debugIndex` SSOT that points to the first bad signal, terminal/finalize
  source, AI Workflow warning count, finalReadiness booleans, read_url evidence
  counts, LLM trace counts, Todo progress state, and the Inspector sections to
  inspect first. The Support panel also renders this index so debugging
  completed-but-bad research runs no longer requires manual correlation across
  Raw, AI Workflow, Research Gate, and LLM Trace. `Research Contract Warning`
  now takes precedence over read_url tool errors when a research run finalized
  with an incomplete/contradictory contract.
- 2026-05-10 AI-first Todo/finalize correction: runtime no longer blocks
  `finalize` simply because Gemini Lite is in envelope mode with unfinished
  TodoState. TodoState remains guidance and Inspector state; AI owns whether to
  continue, advance Todo, replan, or finalize with limitations. Planner repair
  also accepts `finalize.answer` as an alias for `instruction`, matching the
  real Gemini output observed in Chrome QA.
- 2026-05-10 Inspector debugging correction: Support Bundle / debug report now
  expose `todo_progress_debug` with active Todo item, last work action, last
  `todo_advance` / `todo_run_next`, and `missing_progress_after_work`. This
  makes stuck `Step 1/N` visible without runtime auto-completing progress.
- 2026-05-10 prompt payload correction: later long-running planner cycles use
  compact prompt projections for read sources, search results, last
  observation, tool history, and virtual workspace previews. This is token
  budget management only, not content sufficiency judgment.
- 2026-05-10 real Chrome/Gemini QA: the Chinese 3000-character AI-browser
  prompt now completes after the AI chooses `finalize limited`; runtime records
  AI-declared `requirementSatisfied=false` and `lengthSatisfied=false` instead
  of rejecting the terminal decision. HBR remains: visible answer was still
  short (`textChars=2169`) with only two source links and weak/uneven source
  quality.
- 2026-05-10 correction: `named fallback` is not an acceptable runtime or
  skill product mode. Removed `old fallback mode`, `named fallback heading`,
  `old constrained-evidence mode`, and `old budget-exhausted fallback config` wording from
  source, active skills, tests, docs, and generated dist. Use neutral
  `final_with_limitations` state only for Inspector/debug metadata. User-facing
  output remains a normal AI-authored answer/report with an explicit
  Limitations section when needed.
- 2026-05-09 streaming Inspector correction: running Support Bundles must use
  real runtime `onStep` state, not the pending assistant placeholder. Browser
  streaming debug now carries `runtime.mode=tool_loop`, `agrunSessionId`,
  selected skill, Research Gate, workspace, TodoState, and OODAE state while
  the run is still active; abort now marks the debug snapshot interrupted.
- 2026-05-09 plan AI-first correction: `type:"plan"` is no longer permission
  for runtime to call the finalizer after tool execution. Normal plans execute
  their actions and return `plan_result` so AI decides the next step. AI must
  explicitly choose `finalize` with `finalReadiness` to terminate a research
  workflow.
- 2026-05-09 HBR from real Chrome/Gemini QA: plan auto-finalize is fixed, but
  the Chinese 3000-character report still did not finish cleanly. Task progress
  stayed `Step 1/4` because the AI did not call `todo_advance` /
  `todo_run_next` after workspace/search work. Prompt guidance now reminds AI
  to advance TodoState after visible work actions, but runtime must not
  auto-complete TodoState items for AI.
- 2026-05-09 AI Workflow audit follow-up: Inspector must show the visible
  agent workflow around finalize, including sanitized AI-authored
  `reasoning`, `instruction`, `finalReadiness.limitations`, true terminal
  source (`planner_finalize` versus `runtime_finalize`), workspace/read_url raw
  stats, and non-blocking warnings when the AI finalizes with declared
  limitations or missing/contradictory readiness. This is observability only:
  runtime records the AI declaration and raw state; it does not judge or block
  final answer sufficiency.
- 2026-05-09 AI-first cleanup: runtime must not parse requested report length,
  compare output length, decide source sufficiency, or emit
  `length_below_requested` / runtime-authored AI Workflow warning rows.
  `finalReadiness.requirementsAssessment` is AI-authored and display-only;
  Inspector shows raw `read_url` count and `finalCandidateStats` so the AI/user
  can judge quality.

