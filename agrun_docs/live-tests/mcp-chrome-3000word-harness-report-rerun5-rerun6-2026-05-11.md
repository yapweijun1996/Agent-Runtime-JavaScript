# MCP Chrome 3000-word harness report rerun 5/6 inspector review — 2026-05-11

## Goal

Review the latest inspector logs for the 3000-word AI agent harness
engineering report flow and identify why the agent still failed to produce a
clean final result after workspace expansion improvements.

## Rerun 5 Result

The real Gemini browser run expanded farther than previous attempts and
produced more than 3000 visible words, but the terminal answer was malformed.

Observed issues:

- The required suffix marker `MCP_CHROME_3000_WORD_HARNESS_REPORT_DONE`
  appeared multiple times.
- The final answer did not end exactly with the required marker.
- TodoState was stale at terminal; the AI had not synchronized unfinished
  work before publishing/finalizing.

Interpretation: workspace expansion was working, but terminal publish still
needed stronger action-contract discipline. Runtime should not complete the
TodoState for the AI, but publish should refuse terminal success when the AI
has left an unfinished plan visible.

## Rerun 6 Result

The rerun completed through `workspace_publish_candidate`, and TodoState was
fresh. However, the inspector still showed a failing quality picture:

- Final candidate path: `harness_engineering_report.md`
- Final candidate stats: 18602 chars / 15910 non-whitespace chars / 2575 words
- Published: yes
- Final marker ended correctly, but appeared 5 times in the answer body.
- `read_url`: 2 attempted sources, 0 successful, HTTP 502
- `successfulReadUrlCount`: 0
- `researchFinalAllowed`: true
- `researchFinalReason`: `not_long_research`
- `researchQualityGateRequired`: false
- `finalReadiness`: AI declared ready, evidence/length/requirements satisfied

## Diagnosis

This was not primarily a web_search failure. Search could return leads; the
blocking evidence problem was `read_url` returning 502, so the agent could not
convert search leads into usable read evidence.

The larger runtime issue was a contract mismatch:

1. The prompt explicitly requested around 3000 words, but the candidate had
   only 2575 words.
2. The AI declared length satisfied because it compared 18602 chars against
   3000, i.e. it treated a word requirement as a character requirement.
3. The resumed/continued run lost long-research activation, so the research
   quality gate became `not_long_research` even though the original task used
   `long-web-research`.
4. The final marker requirement was checked only by AI judgement, not by the
   terminal publish action contract, so repeated markers could still pass as a
   terminal answer.

## Changes

- `workspace_publish_candidate` now checks explicit final suffix contracts
  before terminal publish. If the user says to end exactly with a token, the
  published text must end with that exact token.
- `workspace_publish_candidate` now blocks terminal publish when TodoState
  still has active, pending, or blocked items. The AI must choose
  `todo_run_next`, `todo_advance`, `todo_plan`, or `todo_cancel`; runtime does
  not auto-complete the plan.
- `workspace_publish_candidate` now checks explicit numeric length contracts
  in `finalReadiness.requirementsAssessment`. If the user asks for words, an
  AI declaration using chars is rejected as a length-unit mismatch.
- Thread research sync now persists `researchActivation: "long_research"`
  across resume/continuation turns so long-research quality gate state does
  not silently downgrade to `not_long_research`.
- Planner concern mocks were updated to model the new AI-owned TodoState
  contract: the mock planner now advances its own TodoState before publishing.

## Verification

- `node test/unit/workspace-actions.test.js`
- `node test/unit/research-thread-sync.test.js`
- `node test/unit/research-state.test.js`
- `node test/concerns/planner.test.js`
- `npm test`

## HBR

The Mac mini / browser `read_url` path is still returning 502 in the provided
inspector evidence. This change does not fix the external read_url service; it
prevents the AI from treating zero successful reads, character count, stale
TodoState, or malformed suffix placement as a clean terminal pass.

No post-fix real Gemini browser rerun has yet proven the 3000-word prompt now
passes end to end.
