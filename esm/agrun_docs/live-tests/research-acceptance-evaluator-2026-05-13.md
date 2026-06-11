# Research Acceptance Evaluator Live-Test Notes

Date: 2026-05-13

## Goal

Implement the sample-project-style convergence layer for agrun long research:
track acceptance progress and repeated readiness conflicts without letting
runtime write reports, choose queries, or decide content quality.

## Implemented Contract

- New read-only runtime state: `runState.researchAcceptanceEvaluator`.
- New planner-visible compact projection:
  `loopState.researchAcceptanceEvaluator`.
- New convergence signal:
  `acceptanceConvergenceSignal`.
- Signal forbids clean `ready` only when repeated AI readiness declarations
  conflict with observable facts, such as:
  - `researchFinalAllowed=false`
  - `sourceMinimum.passed=false`
  - repeated `readiness_audit_failed`
- Follow-up hardening split conflict dimensions:
  - source/research-gate readiness conflicts are counted separately from
    length/workspace conflicts.
  - candidate word/char growth no longer clears source readiness conflicts.
  - source conflicts clear only on successful read/source-minimum progress or a
    valid limited declaration with `evidenceSatisfied=false` and concrete
    `remainingGaps`.

## AI-Owned Next Moves

When the convergence signal is present, the AI must choose one of these:

- Continue targeted evidence work with `web_search` / `read_url`.
- Continue workspace expansion or correction.
- Publish `limited` with `evidenceSatisfied=false` and concrete
  non-empty `remainingGaps`.

Runtime does not choose these moves.

## Targeted Regression Coverage

- `test/unit/research-acceptance-evaluator.test.js`
  - repeated ready conflict emits convergence signal.
  - new read_url evidence resets counters.
  - candidate length growth resets length conflict but not source conflict.
  - valid limited with concrete `remainingGaps` clears forbidden-ready signal.
  - invalid limited with `evidenceSatisfied=true` does not clear source signal.
  - prompt summary is compact and does not include report/query text.
- `test/unit/workspace-actions.test.js`
  - Research Gate limited exit requires concrete `remainingGaps`.
  - source minimum failure blocks clean ready even if Research Gate finalAllowed
    is true.
- `test/unit/action-loop-session-terminals.test.js`
  - repeated planner finalize readiness conflict updates evaluator state.
- `test/unit/research-report-loop.test.js`
  - planner prompt source includes evaluator projection and no-clean-ready
    contract.

## Verification

- `node test/unit/research-acceptance-evaluator.test.js`
- `node test/unit/research-report-loop.test.js`
- `node test/unit/workspace-actions.test.js`
- `node test/unit/action-loop-session-terminals.test.js`
- `node test/unit/planner-prompt-envelope-lines.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`

## Live QA Result

Scenario:

- Browser QA URL: `?debug_yn=y&qa=research-acceptance-evaluator-live-rerun5-2026-05-13&qa_clean=y&qa_provider=gemini&qa_auto_approve_tier1=y`
- Prompt: 3000-word AI agent harness engineering report with exact terminal
  marker.

Observed:

- Final terminal output completed through `workspace_publish_candidate`, not
  `planner_finalize`.
- Final workspace candidate: `draft.md`, 22,704 chars, 3,179 words.
- AI selected `finalReadiness.decision=limited`.
- AI provided `evidenceSatisfied=false` and concrete `remainingGaps`.
- No maxSteps failure in the final rerun.

## Current HBR

The final live QA now converges, but it took a limited exit with no successful
read sources in that particular run. That is acceptable by contract because the
AI disclosed evidence gaps, but a stronger model or better search/read strategy
should still prefer gathering sources before limited publication when budget
allows.

## Dimension Split Live QA

Scenario:

- Browser QA URL: `?debug_yn=y&qa=research-acceptance-dimensions-clean-keyboard-2026-05-13&qa_clean=y&qa_provider=gemini&qa_auto_approve_tier1=y`
- Prompt entered with keyboard input only. This avoided the React state mismatch
  seen when DevTools `fill` was followed by typing into the composer.

Observed:

- Run completed through `workspace_publish_candidate`, not `planner_finalize`.
- Final workspace candidate: `draft.md`, 22,916 chars, 3,133 words.
- AI selected `finalReadiness.decision=limited`.
- AI declared `requirementSatisfied=false`, `lengthSatisfied=true`,
  `evidenceSatisfied=false`.
- AI supplied concrete `remainingGaps` for missing independent/source authority.
- Research Gate remained incomplete: source minimum `0/3` reads and `0/2`
  relevant sources.
- The AI performed meaningful workspace expansion after below-target reads:
  `workspace_append` actions increased the draft from 2,684 words to 3,133
  words.

Dimension split result:

- Source deficit did not get hidden by candidate growth.
- Clean `ready` was not published while source minimum failed.
- The final exit was contract-valid limited because source evidence was still
  unavailable and disclosed.

Dimension split HBR:

- `read_url` returned HTTP 400 for the selected OpenDataScience source, so the
  run still had no successful read sources.
- One intermediate `workspace_finalize_candidate` action reported
  `Cannot read properties of undefined (reading 'pushStep')`, then the planner
  recovered and later finalized successfully. Targeted Node/unit execution of
  `workspace_finalize_candidate` does not reproduce the error, so this remains
  a live-run anomaly to keep watching rather than a confirmed deterministic
  regression.
