# Todo Progress Panel Live Test — 2026-04-26

## Scope

Validate that the browser example can support a long-running student-style task with a visible todo list, current status, progress, and next step.

## Scenario

1. Open `http://localhost:3000/`.
2. Start a new chat.
3. Ask the agent to create a long research assignment todo list, perform only Step 1 and Step 2, and keep visible `Current status`, `Progress`, and `Next step` sections.
4. Continue with `Do Step 3 now...` and ask it to keep the same direction.

## Result

Passed.

- The assistant created a clear todo list.
- It performed only the requested steps.
- The continuation preserved task direction and updated progress from `2/8` to `3/8`.
- The new `Long task progress` panel extracted and displayed:
  - current status
  - todo list with done/pending state
  - progress notes
  - next step

## Verification

Commands:

```bash
cd examples/browser
npm run lint
npm run test:smoke
npm run build
```

Browser:

- Reloaded the Vite app in the in-app browser.
- Confirmed the `Long task progress` complementary region appears.
- Confirmed the panel shows `3/8` and the next step points to Step 4.
- Confirmed mobile collapsed mode renders as a compact `Task progress 3/8` control.
- Confirmed mobile expanded mode opens as a bottom sheet with backdrop and close button, instead of pushing into the chat/composer flow.
- Confirmed the bottom-sheet title/action row is sticky so `Task progress`, progress count, and close remain visible while panel content scrolls.
- Re-ran the UI/UX layout audit checklist from `ui-ux-layout-review`:
  - Desktop `1280x800`: right-side progress rail remains visible and readable.
  - Mobile `390x844`: collapsed control is compact; expanded sheet uses `role="dialog"` and `aria-modal="true"`.
  - Mobile long-scroll state: title, count, and close action remain sticky at the sheet top.
  - Close paths: header close button, backdrop click, and Escape key all collapse the sheet.
  - Composer layering: the sheet overlays the composer and does not resize the chat flow.
  - Console: no Todo panel runtime errors; form-field audit noise was cleared by adding `id` and `name` to the chat composer textarea.
- Re-ran the desktop rail polish audit:
  - Expanded desktop rail starts at 320px and exposes an accessible vertical resize separator.
  - Drag resize changed the rail from 320px to 380px without hiding chat content or panel actions.
  - Collapsed desktop rail uses a compact 56px icon/progress strip instead of a wide text bar.
  - Mobile collapsed/open behavior still works after the desktop rail changes.
- Follow-up desktop simplification:
  - Desktop collapsed/idle state no longer shows a persistent right rail.
  - Desktop progress panel is treated as an in-use surface; when the assistant is idle, the panel collapses out of the wide layout.
  - Mobile keeps the compact `Task progress` entry so the small-screen position stays familiar and discoverable.
- TodoState live harness test:
  - Initial run exposed a UX blocker: `todo_plan` / `todo_advance` / `todo_inspect` were tier 2, so long-running local state updates required approval.
  - Fixed by classifying the TodoState actions as tier 0 internal runtime state actions.
  - Re-ran the live prompt in the in-app browser: no approval card appeared, `todo_plan` + `todo_advance` completed, and the panel showed `2/6`.
  - Confirmed the panel is using structured TodoState: goal, done items, active item, and next step came from the runtime plan.
  - Fixed active-item UX: when Step 3 is active, `NEXT STEP` now remains Step 3 instead of jumping to the first later pending item.
- Auto-start TodoState follow-up:
  - Added planner guidance so semantically complex / long-running tasks choose `todo_plan` before work starts when no active plan exists.
  - Added a runtime invariant in `applyTodoPlan`: if the planner omits `activeItemId`, the first pending item becomes active and other active items are reconciled back to pending.
  - Live-tested a new student-style prompt that did not name todo tools: the browser panel appeared with a 4-step structured TodoState, current status `Explain the agent runtime lifecycle`, and progress `1/4`.
- Auto-continue TodoState follow-up:
  - Initial live retry exposed the remaining blocker: the model wrote a prose `Progress Tracker` while the structured panel stayed at `0/4`; the planner hint alone was not enough to force continuation.
  - Added tier-0 `todo_run_next` as the harness continuation action. It marks the current active item done, promotes the next pending item, and marks the plan completed when no pending item remains.
  - Upgraded Todo autopilot's before-finalize veto to carry a concrete `todo_run_next` action decision, and the runtime now executes that action directly before continuing the loop.
  - Re-ran the same student-style prompt in the in-app browser after reload. Final state: assistant idle, structured panel collapsed as `Task progress 4/4`.
- Real research + approval follow-up:
  - Ran a live long research prompt asking for latest AI browser / browser-agent links with visible progress.
  - First run exposed a real harness gap: approval resume dropped `TodoState`, so web_search/read_url completion produced sources but left the panel stuck at `0/3`.
  - Fixed runtime approval resume tokens to preserve `runState.todoState`, and fixed the browser approval view-model sanitizer to keep `resumeToken.todoState` when the user approves gated actions.
  - Added regression coverage:
    - `test/unit/approval-todo-state.test.js`
    - `examples/browser/test/approval-view-model.smoke.ts`
  - Final live rerun after page reload:
    - `web_search` approval requested and approved.
    - follow-up `web_search` / `read_url` approvals requested and approved.
    - final answer included three source links.
    - structured panel ended at `Task progress 3/3`.
    - browser console warnings/errors: none.
- Incremental progress follow-up:
  - User review exposed a UX/runtime gap: while a first TodoState item was already active, the collapsed panel showed `0/3`, then jumped to `3/3` during finalization.
  - Fixed the panel label to show the active step (`Step 1/3`, `Step 2/3`) instead of only completed count when a plan is in progress.
  - Added `todo-action-progress` runtime wiring so successful evidence actions (`web_search` / `read_url`) can advance compatible active TodoState items through the same `todo_run_next` harness transition.
  - Added regression coverage:
    - `test/unit/todo-action-progress.test.js`
    - `examples/browser/test/todo-progress.smoke.ts` active-step label assertions
- Internal progress leak follow-up:
  - User review clarified that TodoState is internal runtime context, not answer content. End users should see progress in the host `Task progress` surface, not a duplicated `TodoState Progress` / checklist section in the assistant response.
  - Tightened planner/finalizer instructions so final answers focus on the result and evidence while the host UI renders task progress separately.
  - Added a final-output guard that strips TodoState-derived progress/checklist sections when a structured TodoState exists.
  - Added regression coverage: `test/unit/final-answer-internal-progress.test.js`.
- Planner-owned TodoState follow-up:
  - Live test exposed that a long research turn could complete with a good final answer while the browser session still had `todoState: null`; progress was not visible because no structured TodoState was created early enough.
  - Initial fix used runtime autostart with a generic 3-step research plan, but review found this was the wrong ownership boundary: TodoState should be an agent planning tool, not hardcoded runtime content.
  - Current contract: the planner must call `todo_plan` with task-specific ordered items for complex / long-running work. Runtime autostart placeholder injection is now opt-in only via `{ enabled: true, autostart: true }`.
  - If the opt-in placeholder is used, the runtime blocks search/read/finalize until the planner replaces it with a real task-specific `todo_plan`.
  - `todo_plan` caps planner-generated lists at `todoAutopilot.maxItems` (default `10`) so a broad prompt cannot flood the panel with too many steps.
  - Added `todoState` to step snapshots and browser streaming updates, so the UI receives structured progress while the run is executing rather than only after final result persistence.
  - Routed session-budget finalization through the same before-finalize guard, preventing budget fallback from bypassing unfinished TodoState.
  - Re-ran in-app browser live test after reload:
    - During execution, the panel showed `Step 1/3` with first item active and remaining items pending.
    - Mid-run, it advanced to `Step 3/3` with synthesis active.
    - Final IndexedDB inspection showed `todoState.status = completed`, `done = 3`, `total = 3`.
    - Final answer did not include `TodoState Progress`, `Progress Tracker`, `TODO LIST`, or `Task progress` text.
  - Follow-up unit verification passed after planner-owned change:
    - `test/unit/todo-actions.test.js`
    - `test/unit/todo-autostart.test.js`
    - `test/unit/todo-autopilot.test.js`
    - `test/unit/todo-state-prompt-budget.test.js`
- Require-plan guard follow-up (2026-04-27):
  - Live US/MY/SG news-report test showed the agent could jump straight to `web_search` with no visible TodoState, proving planner guidance alone was insufficient.
  - Added `requireTodoPlanBeforeTools` behavior in the action loop: complex TodoState-shaped turns with no structured plan now block tool/finalize decisions and return a planner hint requiring `todo_plan`.
  - Allowed before a plan exists: `todo_plan`, `todo_inspect`, `ask_clarification`.
  - Blocked before a plan exists: `web_search`, `read_url`, `plan`, `final`/`finalize`, and other tool actions.
  - Regression coverage added to `test/unit/todo-autopilot.test.js`; root `npm run build` passed.
- False-progress / max-step follow-up (2026-04-27):
  - Live retest proved the first visible state is now structured TodoState, not direct `web_search`.
  - The same retest exposed the prior false-progress mechanism: `before-finalize` could inject `todo_run_next`, causing work to be marked complete without verifying the active item was actually done.
  - Removed the injected `todo_run_next` decision from autopilot. The runtime now only blocks premature finalization and instructs the planner to continue the actual active work before calling `todo_advance` / `todo_run_next`.
  - Fixed planner prompt wiring so `lastObservation` is always included in loop state, not only when the skill surface is visible.
  - Updated the TodoState prompt footer to say: do actual work first, then advance TodoState only after genuine completion.
  - Live retest after this change showed task-specific progress at `Step 4/5` with three country-collection items done and synthesis active; no sudden completed jump occurred.
  - That retest then hit `Action loop exceeded maxSteps` at `Step 4/5`, so the browser demo cap was raised from `16` to `40`.
  - A follow-up 7-step US/MY/SG run progressed honestly to `Step 4/7` but still exhausted the cap, so the browser demo cap was raised again to `80` to support realistic 7-10 item TodoState research.
  - Added blocked TodoState fallback for planner failure before `todo_plan` and a Gemini empty-response retry.
- Long-run continuation follow-up (2026-04-27):
  - Added a runtime continuation terminal for active TodoState plans that hit `maxSteps`.
  - Instead of hard-failing with `MAX_STEPS_EXCEEDED`, the runtime now returns `kind: "continuation_required"`, keeps the active TodoState, and records `runState.longRunContinuation`.
  - This preserves direction for the next user/host continuation turn; non-TodoState loops still hard-fail on max steps.
- Host continuation boundary follow-up (2026-04-27):
  - Browser host now detects the runtime continuation signal from assistant debug metadata (`finalAnswerSource: "continuation_required"` / `terminalizedBy: "max_steps_continuation"`).
  - The initial browser host auto-continue experiment was rejected because it created hidden user-message submission.
  - The accepted contract is host-level auto-resume: when the assistant is idle and the latest assistant message has `continuation_required`, the browser resumes the same TodoTask without adding a user `continue` message.
  - Compatibility fallback detects older persisted continuation turns by pause text only; new turns still prefer debug metadata.
  - Browser host now injects the dynamic current host date into the system prompt so `today` / `latest` tasks are anchored by the host runtime instead of provider-internal date assumptions.
  - Open WebUI comparison updated the architecture lesson: long-running chat needs task IDs, event-driven status, cancellation, reload recovery, and message queue semantics; it should not rely on synthetic user prompts.
  - Verification:
    - root `npm test`
    - root `npm run build`
    - browser `npm run build`
    - in-app browser observation confirmed the app can resume from persisted `continuation_required` without adding a visible user `continue` bubble.
  - Residual live-test observation: the specific Gemini news run still produced a weak final answer after continuation, but the runtime behavior under test no longer hard-fails and no longer loses TodoState direction.

## Follow-up

TodoState is now the structured runtime source of truth for this panel; the prose parser remains a fallback. The next validation target is a fresh US/MY/SG news-report run after host-date injection, checking final answer quality separately from TodoState continuation mechanics.

## 2026-04-27 Continuation Retest

Prompt used:

> Run this as a long research task. Generate today's news report for US, Malaysia, and Singapore. Use the host current date from your system prompt as today's date. First create a task-specific TodoState plan, then perform the steps one by one. Search the web, select important current stories for each country, cite sources, explain why each matters, and keep internal TodoState out of the final answer.

Findings:

- Refresh recovery exposed a visibility bug: with `showTaskProgress` OFF, a paused long-run task could show the pause prose but no host progress UI.
- Fixed the browser panel contract: active / paused / blocked TodoTask now renders a compact bottom progress bar even when the detailed developer panel is OFF.
- Fixed desktop collapsed layout: the compact bar is visible on desktop in the same bottom position as mobile, instead of hiding behind `lg:hidden`.
- Added TodoTask snapshot fallback so persisted `todoTask` / assistant debug `runtime.todoTask` can restore progress when structured `todoState` is unavailable.
- Fixed a runtime finalization edge: source labels such as `planner_finalize` are now tokenized, so the final synthesis TodoState item can complete through `todo_run_next` before final answer generation.

Observed result:

- After reload, compact bar appeared as `Task progress · Step 2/4`.
- Host-level resume advanced to `Step 3/4`; no `0/3 -> 3/3` jump.
- A later resume produced the final news report and hid the progress bar after completion.
- Browser build passed. Current browser console showed old Vite HMR error records by timestamp, but no fresh blocking UI failure was observed after reload.

Residual quality issue:

- The mechanics worked, but the generated news report still had weak source citation quality. That should be tested as a separate final-answer/evidence-grounding issue, not mixed with TodoState UI mechanics.

## 2026-04-27 Resume Boundary Retest

User review rejected visible `continue` bubbles as non-agentic. The accepted boundary is:

- The host auto-resumes the existing TodoTask/TodoState when continuation is required.
- The transcript must not receive a synthetic user message whose content is `continue`.
- Legacy persisted `continue` bubbles are hidden only when they exactly follow a long-run continuation assistant message.

Verification:

- Browser build passed.
- Root build passed after runtime continuation text changed.
- In-app browser reload of the existing news-report session no longer showed the old visible `continue` bubbles.

## 2026-04-27 Auto-Resume Retest

Follow-up review rejected the manual Continue button too: it interrupts the end-user experience. The revised behavior is:

- No visible Continue button.
- No visible or hidden user-message `continue` bubble.
- Browser host auto-resumes the same TodoTask/TodoState after `continuation_required`.
- Auto-resume is bounded per session to prevent runaway loops.
- Legacy persisted assistant prose that said `Say "continue"` is display-normalized to the automatic continuation message, so old chats no longer present a stale manual instruction.
- Runtime `continuation_required` assistant messages are treated as status events and hidden from the chat transcript; the Todo panel owns progress visibility.

Verification:

- TodoState autopilot unit test passed.
- Root build passed.
- Browser build passed.
- Browser reload check found no exact visible `continue` text/button after the display normalization path.

## 2026-04-27 Fresh Auto-Resume Research Test

Prompt:

> Run this as a long-run research task with up to 10 TodoState steps. Today is 2026-04-27. Generate a current news report for the United States, Malaysia, and Singapore...

Observed:

- Fresh prompt created a task-specific long-running research flow.
- The run hit the 80-step budget more than once.
- The host resumed automatically; no user clicked a Continue button and no user `continue` bubble appeared.
- The transcript still showed intermediate `I paused...` runtime status messages before the transcript filter was tightened.

Fix:

- Hide `continuation_required` assistant messages from `ChatWorkspaceMessageList`; they are runtime status events, not user-facing answer content.
- Reload verification after the fix: visible `I paused...` count = 0, exact `continue` count = 0, final answer still visible.

## 2026-04-27 Citation UX Fix

User review caught the final answer showing `Sources:` with publication names but no URLs. This is confusing because the user cannot tell whether the sources are real, clickable, or verified.

Fix:

- Finalizer prompt now requires Markdown links in `Sources:` and forbids source-name-only entries.
- Runtime `appendSourcesSection` now strips model-written `Sources:` blocks and appends canonical URL-backed Markdown links from structured evidence.
- Planner-final and runtime-final paths both use the same source normalizer.
- Browser display now hides legacy persisted `Sources:` blocks when the section contains no URL, so old chats do not keep showing fake citations.

Fresh citation QA:

- Prompt asked for one current news item each for United States, Malaysia, and Singapore, with clickable Markdown links only.
- Result no longer showed source-name-only entries.
- `Sources:` rendered URL-backed links, and exact visible `continue` count remained 0.
- The answer correctly used "Evidence is insufficient" for countries where retrieval failed instead of inventing source names.

Residual issue:

- Source relevance is still weak: some URL-backed sources came from provider grounding redirects and were not clearly tied to the final country summaries. This needs a separate evidence-selection guard so `Sources:` only includes URLs actually used by the final answer.

## 2026-04-27 Multi-Target Research Coverage Guard

Follow-up review found a more serious citation QA failure:

- The runtime searched Singapore news only.
- The source read then failed on a provider grounding redirect.
- The final answer claimed Malaysia and United States evidence was unavailable because of a technical retrieval error, even though no executed search query covered those targets.

Fix:

- Added `research-coverage-guard` to the before-finalize path.
- For multi-target research/news/report prompts, the guard extracts the requested targets from the prompt and compares them with executed `web_search` queries.
- If a target is missing, finalization is vetoed and the runtime issues a targeted `web_search` for that target before allowing final answer generation.
- Tightened finalizer guidance so user-facing answers do not say "paused task" / "resumed task" / "partially completed task" unless the user explicitly asked for runtime status.

Verification:

- `node test/unit/research-coverage-guard.test.js`
- `node test/unit/evidence-provenance.test.js`
- `node test/unit/todo-autopilot.test.js`
- root `npm run build`
- browser `npm run build`
- Clean in-app browser coverage test no longer showed the misleading technical-error language for unverified countries; remaining weakness is provider/source quality, not target coverage.

## 2026-04-27 US/MY/SG Long-Run QA Retest

Prompt:

> Long-run QA test. Today is 2026-04-27. Generate a concise current news report for the United States, Malaysia, and Singapore. Treat this as a long-running task with visible TodoState progress. First create a task-specific TodoState plan with up to 8 steps. Search each country separately before finalizing. Use clickable Markdown source links only. Do not expose internal TodoState or runtime pause/resume wording in the final answer.

Observed:

- TodoState progress appeared during execution (`Step 3/4` observed).
- The run completed without a visible `continue` bubble or manual Continue button.
- Final answer included sections for United States, Singapore, and Malaysia.
- No `technical error`, `paused task`, `resumed task`, or `partially completed task` wording leaked into the final answer.

Remaining issue:

- Source grounding is still weak. The final `Sources:` list used provider redirect URLs and did not clearly provide a source for the United States section. This confirms the next fix should be a source relevance / citation coverage guard, separate from TodoState and multi-target search coverage.

## 2026-04-27 Citation Source Coverage Guard Retest

Prompt:

> Citation/source coverage QA. Today is 2026-04-27. Generate a concise current news report for the United States, Malaysia, and Singapore. Search each country separately. Final answer must have a section per country. Only make a concrete claim for a country if there is a direct, user-verifiable source URL for that country. Do not cite provider redirect URLs.

Fix:

- Added `citation-source-coverage` to the before-finalize path.
- Added direct-source filtering to canonical final response sources.
- Provider grounding redirect URLs such as `vertexaisearch.cloud.google.com/grounding-api-redirect/...` are no longer accepted as user-verifiable sources.
- Finalizer prompt receives citation coverage warnings and must mark targets evidence-insufficient instead of writing concrete claims without direct sources.

Observed:

- TodoState appeared during execution.
- The runtime attempted to gather evidence, but the available provider evidence only exposed redirect-style source URLs.
- Final answer did not show `Sources:`, did not expose redirect URLs, and did not make concrete country news claims without direct URLs.
- No `technical error`, `paused task`, `resumed task`, `partially completed task`, or visible `continue` wording was observed.

Remaining issue:

- This is now honest but not yet product-good. To generate a useful news report, the browser app needs a search backend/result normalizer that returns direct publisher URLs for each source, or a redirect resolver that can safely resolve provider grounding redirects before they enter the citation harness.

## 2026-04-27 Direct Source Backend + Target-Aware Sources Retest

Prompt:

> Direct source QA. Today is 2026-04-27. Generate a concise current news report for the United States, Malaysia, and Singapore. Search each country separately. Final answer must have one short section per country and a Sources section with clickable publisher/source links only. Do not cite provider redirect URLs. Do not write Source: Web Search.

Fix:

- Browser search backend `auto` now prefers configured SearXNG direct publisher URLs before Gemini grounding fallback.
- Gemini grounding results resolve `vertexaisearch.cloud.google.com/grounding-api-redirect/...` through a safe no-body redirect resolver before entering search results.
- Final response source handling strips generic `Source: Web Search` labels.
- Thread-scoped citation filtering now augments its allow-list with current-run direct research URLs, preserving provenance without dropping fresh search sources.
- Canonical source selection is target-aware for multi-target reports, so each requested country gets a direct source when available.
- Multi-target canonical source selection no longer falls back to unrelated global top results when target matching fails.

Observed:

- Browser QA no longer showed provider redirect URLs.
- Browser QA no longer showed technical-error wording.
- Final `Sources:` rendered clickable links when target-matched direct sources were available.
- A follow-up clean QA exposed unrelated search-result pollution; the harness now refuses unrelated canonical sources instead of displaying them.
- Remaining product-quality risk is search freshness/ranking, not the citation harness contract.

## 2026-04-27 Final Citation Scrub Retest

Follow-up issue:

- Live QA still exposed unsupported model-written source text such as `Sources Malay Mail...` and `Source: planned tool results`.
- The terminal source collector could miss the user prompt if `runState` prompt fields were empty, making target-aware source selection fall back to global source ranking.

Fix:

- Terminal source collection now falls back to `request.prompt`.
- Runtime source scrubbing removes unsupported inline source blocks, not only `Sources:` headings.
- Browser display applies the same unsupported inline source stripping for persisted or streamed assistant messages.

Verification:

- Evidence provenance unit test passed.
- Browser citation-display smoke passed.
- Root build passed.
- Browser build passed.
- Browser live retest no longer showed redirect URLs or bad unrelated source text in the latest answer area.

Blocked:

- The final live retest did not reach a full report because Gemini returned `response did not include text output or function calls` during Step 3/4. This is provider reliability, not the citation sanitizer path.

## 2026-04-27 Gemini Empty Streaming Retry

Issue:

- The non-streaming Gemini path already retried once after an empty text/tool response.
- Runtime finalization uses streaming when the browser supplies `onToken`, so empty Gemini streams still failed with `Gemini response did not include text output or function calls`.

Fix:

- `requestGeminiContentStreaming` now mirrors the non-streaming semantic retry.
- If the first stream completes with no text and no tool calls, it retries once with an explicit instruction requiring non-empty text or a valid tool call.
- Retry tokens are forwarded to the UI; the empty first stream produces no user-visible content.

Verification:

- `node test/unit/gemini-empty-retry.test.js`
- `node test/unit/gemini-streaming.test.js`
- root build
- browser build

## 2026-04-27 Final Response Quality Repair

Issue:

- Live US/MY/SG QA recovered from the Gemini empty-stream failure, but the final answer could still be confusing.
- The failing draft repeated country sections, included `(Pending search results...)`, and mixed source-list boilerplate into the answer.

Fix:

- Added `final-response-quality` as a runtime harness check before terminalizing `runtime_finalize`.
- The check detects empty final text, placeholder artifacts, repeated requested-target headings, and bare `Sources` sections without Markdown links.
- When the check fails, runtime finalization retries synthesis once from the same evidence with a repair instruction and keeps the higher-quality answer.
- The same quality guard now blocks bad `planner_final` direct answers and routes them through runtime finalization.
- `plan_synthesize` output now uses the same structural normalizer, so plan-based answers cannot leak repeated country sections or trailing model-written `Sources:` boilerplate.
- Finalizer/source selection uses the effective original task prompt from runtime state / TodoState goal instead of host auto-resume prompts.

Verification:

- `node test/unit/final-response-quality.test.js`
- `node test/unit/gemini-empty-retry.test.js`
- `node test/unit/citation-source-coverage.test.js`
- `node test/unit/research-coverage-guard.test.js`
- root build
- browser build
- In-app browser QA: no Gemini empty-response error, no `Pending search results`, no provider redirect URL, no generic `Source: Web Search`, one United States section, one Malaysia section, one Singapore section. Follow-up exposed remaining evidence-selection weakness when only broad or unrelated search results are available.

Residual:

- The report was now readable and structurally clean, but still used broad news/source pages for some countries. A future evidence-quality guard should prefer concrete article pages and require source-tied headline claims for "today/latest news report" prompts.

## 2026-04-27 Concrete Article Evidence Guard

Issue:

- Follow-up live QA still surfaced unrelated canonical citations such as resume/Zhihu links when the search backend returned broad or irrelevant pages.
- This made the answer look cited even when no country-specific concrete article evidence was available.

Fix:

- `collectFinalResponseSources` now treats news/latest/report prompts as article-like source requests.
- Source selection rejects generic news homepages, topic/search/category pages, broad headline portals, provider redirects, and unrelated pages.
- Multi-target source selection only appends target-matching concrete article/source URLs.
- If no concrete article evidence is available, `Sources:` is omitted instead of showing fake or confusing citations.
- Direct-final output now passes through the same final-response normalizer, closing another terminal-path escape hatch.

Verification:

- `node test/unit/evidence-provenance.test.js`
- `node test/unit/final-response-quality.test.js`
- `node test/unit/citation-source-coverage.test.js`
- root build
- browser build
- In-app browser QA: no `Pending search results`, no provider redirect URL, no generic `Source: Web Search`, no resume/Zhihu source links, one United States section, one Malaysia section, one Singapore section. `Sources:` was omitted because no sufficient concrete article evidence was available.

Residual:

- The answer is now safer, but still not a strong news report when search/read cannot retrieve concrete articles. Next improvement should make the agent actively fetch/verify article pages per target instead of relying on broad search snippets.

## 2026-04-27 Direct Publisher Backend + Source-Kind Guard

Issue:

- Follow-up QA still allowed a specific-looking Q&A URL (`zhihu.com/question/...`) to appear as a final `Sources:` item.
- The prior article guard rejected generic/topic pages, but treated any specific path as potentially concrete article evidence.

Fix:

- Browser web-search `auto` prefers configured SearXNG direct publisher URLs before Gemini grounding fallback.
- Gemini grounding redirect chunks are resolved with bounded `HEAD` redirect following before entering evidence.
- Article-like news/report prompts now reject Q&A/forum/social/wiki/profile/resume-style sources even when the path looks specific.

Verification:

- `node test/unit/gemini-grounding-redirect.test.js`
- `npx tsx examples/browser/test/search-backend.smoke.ts`
- `node test/unit/evidence-provenance.test.js`
- `node test/unit/citation-source-coverage.test.js`
- root build
- browser build
- In-app browser QA: latest assistant answer had United States, Malaysia, and Singapore sections; no provider redirect URL, no generic `Source: Web Search`, and no Zhihu/resume/Q&A/forum source links. `Sources:` was omitted because direct country-level source coverage was still insufficient.

Residual:

- The guard now prevents bad citations, but it does not guarantee a strong news report. Product quality still depends on improving search ranking / article retrieval per country.
