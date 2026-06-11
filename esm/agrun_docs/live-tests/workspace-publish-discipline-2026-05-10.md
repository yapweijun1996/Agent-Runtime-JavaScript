# Workspace Publish Discipline Follow-up — 2026-05-10

## Goal

Confirm the correct long-answer architecture for agrun: the AI agent should not
generate a full long report in one final model response. It should build and
revise virtual workspace artifacts over OODAE turns, then publish the selected
candidate directly to the end user.

## Fix

- `workspace_publish_candidate` now shares terminal Todo observation behavior
  with planner/finalize terminal paths. If the AI publishes while TodoState
  still has active or pending items, runtime records
  `todoTerminalObservation.status="unfinished_at_terminal"`, emits
  `todo-state-terminal-observed`, and clears live `todoState` so the next turn
  is not steered by stale progress.
- `deep-research-writer` and `long-web-research` now state the intended
  workflow more directly: build `evidence.json`, `draft.md`, `critique.md`,
  and `final_candidate.md` over multiple turns, promote a substantive draft
  when critique has no blocking evidence gap, then use
  `workspace_publish_candidate`.
- Planner native/envelope guidance now tells AI that long answers do not need
  to be generated in one model response and that promotion/publish should win
  over more broad search once the workspace draft is substantive.
- Inspector Support now exposes `Copy Workspace Packet`, which includes
  workspace file stats/content for key artifacts, operations, publication
  state, Todo progress, terminal Todo observation, and recent workflow/action
  rows for tuning.

## Follow-up Fix After Real Provider QA

Real Gemini QA showed that prompt guidance alone was not enough. Gemini could:

- write `final_candidate.md` and publish without first calling
  `workspace_finalize_candidate`;
- write only `draft.md` and then use `planner_finalize`, causing the finalizer
  path to generate a long answer outside the workspace candidate;
- publish without reading back `final_candidate.md` stats;
- leave TodoState at Phase A even after search/read/draft/publish work.

The harness now enforces source-path protocol, not content quality:

- `workspace_publish_candidate` requires `workspace_finalize_candidate` after
  the latest write/replace/promote of the candidate.
- `workspace_publish_candidate` also requires `workspace_read` after
  `workspace_finalize_candidate`, so the AI sees deterministic text stats
  before publishing.
- If `finalize` / `final` is chosen while a workspace `final_candidate.md`
  already exists and `workspace_publish_candidate` is available, runtime emits
  `workspace_publish_path_required` and continues the OODAE loop.
- If `finalize` / `final` is chosen while `draft.md` exists but
  `final_candidate.md` is missing, runtime emits the same continuation signal,
  asking AI to create the candidate and publish through the workspace path.
- This signal is about terminal source correctness only. Runtime still does not
  decide whether 3000 Chinese characters, source count, evidence depth, or
  report quality are sufficient.

## Real Provider QA

Prompt:

`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告`

Gemini before source-path protocol:

- Improved from `planner_finalize` to `workspace_publish_candidate`.
- Still skipped `evidence.json` / `critique.md` in some runs.
- Published short candidates around 1901 chars / 1021 CJK chars.
- Todo remained unfinished at terminal.

Gemini after source-path + read checkpoint:

- Terminal source: `workspace_publish_candidate`.
- Action path included
  `workspace_finalize_candidate -> workspace_read -> workspace_publish_candidate`.
- Workspace files: `questions.md`, `evidence.json`, `draft.md`,
  `final_candidate.md`.
- Final candidate stats: 1630 chars, 887 CJK chars, 1507 non-whitespace chars.
- Read sources: 3 successful `read_url` URLs.
- Visible source URLs: 3.
- Todo terminal observation: `unfinished_at_terminal`, 0 done / 5 unfinished.
- Missing artifact: `critique.md`.

OpenAI latest attempted rerun:

- The corrected QA script failed before submit while waiting for the app to
  reach ready state with `settings.defaultProviderId === "openai"`.
- Earlier valid OpenAI QA, before the final source-path/read checkpoint,
  reached `workspace_publish_candidate` and produced 3161 chars / 2410 CJK
  chars, but still had stale TodoState and weak source evidence
  (`readSources.successful=0` in that run's captured packet).
- Therefore the latest OpenAI result is not a valid post-fix comparison.

## Verification

- `npm --prefix examples/browser run lint`
- `npx tsx examples/browser/test/inspector-debug-report.smoke.ts`
- `npm run build`
- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/concerns/planner.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `node test/unit/todo-state-finalize-sync.test.js`
- `npm test`
- `npm run dist:check`
- `git diff --check`

All commands passed.

## HBR

This fixes the harness source path and Inspector debug surface, but it does not
make the AI reliably satisfy the user's quality requirement. The latest Gemini
run now uses the correct workspace terminal path and exposes exact stats before
publish, but it still published only 887 CJK chars for a 3000 字 request, skipped
`critique.md`, and left TodoState stale. That is a real remaining AI workflow
discipline problem, not a hidden runtime issue.

## 2026-05-10 Follow-up: Publish Self-audit Continuation

User clarified the intended architecture: long answers should be built through
virtual workspace turns and then published; the model should not have to emit
3000 Chinese characters in one finalizer response.

Changes made:

- `workspace_publish_candidate` now records the AI's `finalReadiness` self-audit
  against the latest `workspace_read` stats.
- If publish protocol or self-audit is internally inconsistent, the action
  returns `control: "continue"` with a `virtual_workspace_publish_blocked`
  observation instead of terminalizing or throwing a user-visible runtime error.
- The gate is mechanical only: it checks AI-declared fields against observed
  workspace stats and source counts. It does not decide answer quality.
- Repeated `workspace_finalize_candidate` no longer invalidates an earlier read
  when candidate content has not changed; SSOT is "read after latest content
  change", not "read after every finalize marker".
- Browser QA can force provider with `qa_provider=openai|gemini`, and built-in
  OpenAI now uses the Responses API path for GPT-5 models. The OpenAI provider
  call also passes both `abortSignal` and SDK `timeout`.

Latest live QA HBR:

- Gemini no longer publishes an inconsistent `workspace_publish_candidate` packet
  as ready. The final run moved to `planner_finalize` with
  `finalReadiness.decision="limited"`, concrete `remainingGaps`, and
  `requirementSatisfied=false`.
- It still did not complete the desired workspace packet:
  `final_candidate.md` was missing in the final run, TodoState stayed unfinished,
  and the visible answer remained under the requested 3000 Chinese characters.
- OpenAI provider-ready is fixed, but live OpenAI deep-research QA still did not
  complete within the 5-minute debug window; it stayed in an executing run after
  entering workspace activity. This remains a provider/model workflow latency
  HBR, not a provider selection bug.

Verification added in this follow-up:

- `node test/unit/workspace-actions.test.js`
- `node test/concerns/planner.test.js`
- `node test/unit/planner-native-system-prompt.test.js`
- `node test/unit/openai-transport.test.js`
- `node test/unit/openai-streaming.test.js`
- `npm --prefix examples/browser run lint`
- Real Gemini QA:
  `tmp/workspace-publish-live-gemini-continuation-gate.log`
