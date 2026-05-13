# AGRUN-217 Policy Split Verification — 2026-05-11

## Scope

This slice removes long-research workflow policy from planner/native runtime
prompt surfaces and moves it to `skills/long-web-research/SKILL.md`.

Implemented:

- Planner/native prompts now keep tool mechanics, action contracts, read-only
  state, and envelope shape.
- `long-web-research` skill now owns workspace packet workflow, blocked publish
  recovery, and limited-publish `finalReadiness` shape.
- TodoState detection defaults are structural only; semantic task-domain
  matching requires host-injected patterns.
- Virtual workspace internal-section stripping has one SSOT in
  `src/runtime/virtual-workspace.js` and supports free-form filenames.

## Verification

Targeted command passed:

```bash
node test/unit/todo-detection.test.js \
  && node test/unit/todo-autopilot.test.js \
  && node test/unit/todo-autostart.test.js \
  && node test/unit/todo-plan-progress.test.js \
  && node test/unit/virtual-workspace.test.js \
  && node test/unit/final-answer-internal-progress.test.js \
  && node test/unit/workspace-actions.test.js \
  && node test/unit/planner-native-system-prompt.test.js \
  && node test/unit/planner-prompt-envelope-lines.test.js
```

## Honest Bad Result

No real provider browser e2e was run for this slice. The result proves the
harness boundary and regression behavior, not model output quality.

