# AGRUN-250 Terminal Churn Follow-up 2026-05-24

## Goal

Reduce terminal-stage churn found after AGRUN-249 without moving AI work into
runtime logic.

## Starting Evidence

AGRUN-249 passed the quality bar in three live cells:

- Gemini flash-lite English: ready, 3230/3000 words, qualityScore 100.
- Gemini flash-lite Mandarin: ready, 3232/3000 CJK chars, qualityScore 100.
- OpenAI gpt-5-mini: ready, 3162/3000 words, qualityScore 100.

The HBR was performance/churn:

- Mandarin still used 58 cycles and 17 workspace writes.
- OpenAI reached a good candidate, but post-ready retries continued after a
  `successfulReadUrlCount` mismatch: the model declared 8 while runtime
  observed 6.

## Fix

- `workspace_publish_candidate` now emits structured readiness issues for
  `observed_length_mismatch` and `successful_read_url_count_mismatch`.
- Terminal repair stores `observableDeficits.readiness`.
- When readiness is the only active deficit and source/length/structure/Todo
  are clean, the allowed action surface is only
  `workspace_publish_candidate`; source search/read churn is not exposed.
- Publish protocol blocks such as `missing_finalize_after_latest_write`,
  `missing_latest_workspace_read`, and `todo_state_not_synced` are no longer
  misclassified as readiness payload deficits.
- Readiness-only corrected publish retries are allowed through preflight, but
  publish execution still validates the payload against real runtime facts.
- The length rewrite guard now measures proposal size by the requested unit:
  `words`, `chars`, or `cjkChars`.

## Verification Plan

- Focused unit tests:
  - `node test/unit/workspace-actions.test.js`
  - `node test/unit/terminal-repair-state.test.js`
  - `node test/unit/action-pattern-convergence.test.js`
- Full checks:
  - `npm test`
  - `npm run build`
  - `npm run dist:check`
  - `git diff --check`
  - task JSONL parse and docs manifest syntax check
- Live matrix:
  - Gemini flash-lite English, thinking high
  - Gemini flash-lite Mandarin, thinking high
  - OpenAI gpt-5-mini

## Results

- Focused unit tests passed:
  - `node test/unit/workspace-actions.test.js`
  - `node test/unit/terminal-repair-state.test.js`
  - `node test/unit/action-pattern-convergence.test.js`
- Full checks passed:
  - `npm test`
  - `npm run build`
- Initial live matrix passed:
  - Gemini flash-lite English, thinking high:
    `2026-05-24T10-54-44-434Z`, completed, `ready`,
    `3229/3000` words, qualityScore `100`, `30` cycles, source minimum
    passed (`3` read / `2` relevant).
  - Gemini flash-lite Mandarin, thinking high:
    `2026-05-24T10-58-11-503Z`, completed, `ready`,
    `3529` CJK chars, qualityScore `100`, `45` cycles, source minimum
    passed (`10` read / `2` relevant).
  - OpenAI gpt-5-mini:
    `2026-05-24T11-04-53-728Z`, completed, `ready`,
    `3078/3000` words, qualityScore `100`, `18` cycles, source minimum
    passed (`5` read / `4` relevant).
- Follow-up OpenAI stress rerun after protocol persistence work:
  `2026-05-24T11-22-56-277Z` failed with `MAX_STEPS_EXCEEDED`.
  The candidate itself reached `3080/3000` words, structure/source/quality
  all passed (`qualityScore=100`, source minimum `6/6`), but the runtime did
  not terminalize because the model applied a final patch, finalized at cycle
  `59`, then tried `workspace_publish_candidate` at cycle `60` without the
  required `workspace_read` after the latest content change.

## HBR

AGRUN-250 fixed the scoped readiness mismatch and CJK growth accounting issues,
and the three-cell matrix passed. The remaining bad result is last-mile
terminal efficiency: OpenAI can still burn most of the 60-cycle budget on
TodoState/publish retries, then reach a valid-length candidate too late to
complete the finalize -> read -> publish protocol. This is not solved by
readiness-only retry. It should become a follow-up focused on length/Todo
repair ordering and maxSteps-adjacent protocol recovery, without auto-reading
or auto-publishing for the AI.
