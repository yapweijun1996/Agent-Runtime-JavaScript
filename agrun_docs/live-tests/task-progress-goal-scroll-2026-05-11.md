# Task progress long Goal scroll fix — 2026-05-11

## Issue

The Task progress panel could become hard to use when the active goal was a
long prompt. The Goal text expanded vertically, pushed Todo list content below
the visible area, and long suffix tokens could create horizontal overflow.

## Change

`TodoProgressPanel` now constrains the Goal paragraph height and lets the Goal
text scroll independently:

- `max-h-32` on small layouts and `lg:max-h-40` on desktop.
- `overflow-y-auto` and `overscroll-contain` on the Goal paragraph.
- `break-words` plus `overflow-wrap:anywhere` so long final-marker tokens wrap
  instead of forcing horizontal scrolling.

This keeps the Task progress title, progress count, current status, and Todo
list reachable while preserving the full Goal text.

## Browser Verification

Test URL:

`http://127.0.0.1:3331/?debug_yn=y`

Injected a QA session with the same long 3000-word harness report goal and an
active TodoState.

Measured result in Chrome DevTools:

- Goal client height: 160px
- Goal scroll height: 520px
- Goal overflow-y: `auto`
- Todo list visible in viewport: yes
- Horizontal page overflow: false

Screenshot:

`agrun_docs/live-tests/task-progress-goal-scroll-2026-05-11.png`

Mobile sheet quick check:

- Viewport: 500px x 733px
- Goal client height: 128px
- Goal scroll height: 240px
- Goal overflow-y: `auto`
- Todo list visible in viewport: yes
- Horizontal page overflow: false

Mobile screenshot:

`agrun_docs/live-tests/task-progress-goal-scroll-mobile-2026-05-11.png`

## Verification

- `npm --prefix examples/browser run build`

## Real Gemini Long-Run Check — 2026-05-12

Test URL:

`http://127.0.0.1:3331/?debug_yn=y&qa=task-progress-real-long-goal-2026-05-12&qa_clean=y&qa_auto_approve_tier1=y`

Result:

- Expanded Task progress panel remained usable during Step 3/5 and Step 4/5.
- Goal client height: 160px
- Goal scroll height: 520px
- Goal overflow-y: `auto`
- Current status visible in viewport: yes
- Todo list visible in viewport: yes
- Horizontal page overflow: false

Screenshots:

- `agrun_docs/live-tests/task-progress-real-long-goal-running-2026-05-12.png`
- `agrun_docs/live-tests/task-progress-real-long-goal-step4-2026-05-12.png`
- `agrun_docs/live-tests/task-progress-real-long-goal-final-2026-05-12.png`

HBR from this run:

- The first live prompt was accidentally duplicated by the QA driver because
  DevTools `fill` modified the DOM value without updating React state, then
  keyboard typing appended the same prompt again. This run remains useful as a
  layout stress test, but not as clean end-user prompt evidence.
- The AI still published with `read_url` failures and a short word count in
  some inspector runs. That exposed a runtime consistency gap outside the UI:
  `workspace_publish_candidate` needed to read original goal/Todo/session
  contract text during resume, compare declared read_url counts with observed
  evidence, reject `ready/evidenceSatisfied=true` while Research Gate says
  `finalAllowed=false`, and reject repeated explicit final suffix markers.

## Clean End-User Prompt Check — 2026-05-12

Test URL:

`http://127.0.0.1:3331/?debug_yn=y&qa=task-progress-clean-end-user-keyboard-2026-05-12&qa_clean=y&qa_auto_approve_tier1=y`

Submitted once by keyboard only:

`I'm preparing an engineering brief for my team. Please write a detailed technical report, around 3000 words, about AI agent harness engineering. Explain what it is, why it matters, architecture patterns, runtime contracts, observability, tool governance, testing, recovery loops, anti-hardcode principles, and implementation guidance. End exactly with MCP_CHROME_TASK_PROGRESS_CLEAN_PROMPT_DONE`

Result:

- User prompt appeared once in the chat transcript.
- The Goal appeared once in the Task progress panel, as expected.
- Goal max height: 160px
- Goal scroll height: 300px
- Goal overflow-y: `auto`
- Current status visible: yes
- Todo list visible: yes
- Horizontal page overflow: false

Screenshot:

`agrun_docs/live-tests/task-progress-clean-end-user-running-2026-05-12.png`

HBR from this run:

- The UI layout passed.
- The agent output still repeated the requested final marker multiple times
  before the final line. A follow-up runtime fix now blocks repeated explicit
  final suffix markers so the AI must revise before publishing.

Additional targeted verification after the runtime consistency fix:

- `node test/unit/workspace-actions.test.js`
- `npm run build:lib`

## Clean Rerun Follow-Up — Final Todo Sync

Test URL:

`http://127.0.0.1:3331/?debug_yn=y&qa=task-progress-clean-publish-gate-rerun-2026-05-12&qa_clean=y&qa_auto_approve_tier1=y`

Submitted once by keyboard only:

`I'm preparing an engineering brief for my team. Please write a detailed technical report, around 3000 words, about AI agent harness engineering. Explain what it is, why it matters, architecture patterns, runtime contracts, observability, tool governance, testing, recovery loops, anti-hardcode principles, and implementation guidance. End exactly with MCP_CHROME_TASK_PROGRESS_RERUN_DONE`

Result:

- User prompt appeared once in the chat transcript.
- The expanded Task progress Goal stayed bounded and scrollable.
- Current status and Todo list stayed visible.
- The long-run task reached Step 4/4 with a ready `report.md` candidate above
  the requested length.

HBR from this run:

- The agent then looped on workspace drafting/finalization actions while Todo
  items stayed active.
- Root cause: Todo action progress only advanced read/search work. It had no
  default rules for workspace write/append/replace/finalize actions.
- Fix: workspace write/append/replace actions now advance non-finalization Todo
  labels, and `workspace_finalize_candidate` advances only Todo labels matching
  the configurable finalization pattern. This keeps runtime out of content
  judgment while allowing the AI's explicit workspace actions to synchronize
  TodoState.

Targeted verification:

- `node test/unit/todo-action-progress.test.js`
- `node test/unit/todo-autopilot.test.js`

Additional HBR:

- A follow-up browser rerun after adding workspace drafting rules did not
  exercise the TodoState workspace path because Gemini chose direct
  `planner_finalize` after one failed `read_url`. Inspector showed no
  TodoState attached to that run, so the browser check was useful for UI/read
  evidence visibility but not conclusive for the workspace Todo sync branch.
  The workspace Todo sync behavior is currently covered by the targeted unit
  tests above.

## HBR

The original 2026-05-11 check used an injected QA TodoState. The 2026-05-12
follow-up used real Gemini browser runs and confirmed the layout still holds.
The clean run also exposed non-UI runtime quality issues around repeated final
markers and publish readiness consistency; those are covered by the
workspace publish unit tests listed above.
