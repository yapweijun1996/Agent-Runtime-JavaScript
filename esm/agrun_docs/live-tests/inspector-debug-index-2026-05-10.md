# Inspector Debug Index Review - 2026-05-10

## Goal

Make the browser Inspector easier to debug when a completed AI run is visibly bad, especially research/workspace runs where the AI saw weak evidence or short draft stats but still chose `finalize`.

## Issue

Before this review, Inspector had useful panels (`AI Workflow`, `LLM Trace`, `Research Gate`, raw runtime steps), but the first debugging pass still required manual correlation:

- Was the terminal answer from `planner_finalize`, direct planner final, or runtime finalizer?
- Did the AI declare `finalReadiness` and limitations?
- Did observed read_url/workspace stats conflict with the AI declaration?
- Which panel should be inspected first?
- Should a completed research warning appear in "Copy Latest Failed Run"?

This made the workflow harder to debug than necessary even though the raw data existed.

## Change

- Added `userReport.debugIndex` to the Support Bundle as the first-pass debug SSOT.
- Rendered Debug Index in the Support panel with:
  - first bad signal,
  - finalize source and finalReadiness decision,
  - requirement/length/evidence/AI-ready booleans,
  - OODAE cycle, AI Workflow, and LLM trace counts,
  - suggested Inspector sections to inspect first.
- Added `Copy Debug Index` beside `Copy Support Bundle`, with explicit copied
  and copy-failed button states, so small debug payloads can be shared without
  the whole bundle when the first-pass issue is enough.
- Added a dedicated `OODAE Cycles` Inspector panel and `trace.oodaeCycleDebugLedger`
  Support Bundle projection. It groups runtime steps by cycle and shows
  observe/orient/decide/act/evaluate status, planner request/response, decision,
  action, observation, evaluation, repair, and warning signals.
- Made `Research Contract Warning` take precedence over read_url tool errors after a research run finalizes with incomplete or contradictory readiness.
- Made latest failed-run detection include completed-but-bad Inspector classifications, not only transport/runtime errors.
- Fixed a live QA false positive where a healthy simple first-turn final answer was
  classified as `Planner / Clarification Loop` only because the session was fresh.

## Verification

```bash
npm --prefix examples/browser run lint
npx tsx examples/browser/test/inspector-debug-report.smoke.ts
npm --prefix examples/browser run build
```

All commands passed. Live browser QA also passed on `http://localhost:3001/?debug_yn=y`
with prompt `Say hi in one sentence, then stop.` The Inspector rendered `Healthy Run`,
Debug Index, OODAE Cycles, AI Workflow, and LLM Trace together.

Additional real research QA on
`http://localhost:3001/?debug_yn=y&qa_auto_approve_tier1=y` with prompt
`用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告` reproduced the original
quality failure while confirming the Inspector debug path:

- Support classified the completed run as `Research Contract Warning`.
- Debug Index first signal: `AI finalized with declared limitations`.
- Finalize row: `source=planner_finalize`, `terminalizedBy=planner_finalize`,
  `decision=limited`.
- AI-declared readiness: `requirementSatisfied=false`,
  `lengthSatisfied=false`, `evidenceSatisfied=true`, `aiDeclaredReady=true`.
- Research Gate: contract observed, `finalAllowed=false`, gap
  `insufficient_relevant_sources`.
- AI Workflow warnings showed the useful mismatch:
  `claimedReadUrls=4 observedReadUrls=1`.
- Virtual Workspace exposed the short output: `final_candidate.md` about
  1463 chars, 1322 non-whitespace chars, 794 CJK chars, and 76 word tokens.
- OODAE Cycles exposed early plan validation mistakes where the AI tried to put
  standalone state-mutating actions inside a plan, then recovered and later
  chose `finalize`.
- LLM Trace exposed payload pressure: 15 requests/responses, about 155k total
  tokens, and repeated large message/system prompt signals.

## HBR

This improves observability only. It does not force the AI to continue research, read workspace files, meet word count, or block a weak final answer. That behavior must remain AI/tool-contract driven, with Inspector showing the mismatch clearly.
