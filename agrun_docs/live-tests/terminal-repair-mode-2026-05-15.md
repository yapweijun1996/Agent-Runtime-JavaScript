# Terminal Repair Mode Live QA - 2026-05-15

## Goal

Validate first-class `terminalRepairState` for the 3000-word harness report flow. The expected behavior is:

- clean `ready` only when source, length, structure, and TodoState facts allow it;
- if a core fact cannot be satisfied, terminal output must use valid `limited` readiness with concrete `remainingGaps`;
- direct `finalize` / `final_answer` and plain `workspace_publish_candidate` cannot bypass repair mode;
- messy structure, duplicate headings, or repeated append fragments should block publish until repaired.

## Implementation Summary

- Added `src/runtime/terminal-repair-state.js`.
- Wired `terminalRepairState` into run state, approval resume state, planner prompt, native prompt, planner tool suppression, action surface filtering, runtime preflight, finalize continuation, Inspector, and support bundle.
- Added valid limited publish validation:
  - `finalReadiness.decision === "limited"`;
  - non-empty `requirementsAssessment.remainingGaps`;
  - `evidenceSatisfied=false` when source/readiness deficits exist;
  - `lengthSatisfied=false` when length deficit exists;
  - `requirementSatisfied=false` while any core deficit exists;
  - structure deficits must be repaired before terminal publish.
- Added follow-up repair after first Chrome QA bad result:
  - planner action surface hides an action when `actionPatternConvergence.convergenceSignal` forbids repeating the same exact action during terminal repair;
  - runtime preflight blocks structure-deficit `workspace_read` / `workspace_replace` no-progress loops and requires a meaningful workspace mutation.

## Verification Commands

```bash
node test/unit/terminal-repair-state.test.js
node test/unit/planner-action-surface.test.js
node test/unit/planner-tools-schema.test.js
node test/unit/action-loop-session-terminals.test.js
cd examples/browser && npx tsx ./test/inspector-debug-report.smoke.ts
npm test
npm run build
npm run dist:check
```

Result: all commands passed on 2026-05-15.

## Chrome MCP Live QA

Prompt used:

```text
Generate a 3000-word report about AI agent harness engineering information. The report should explain what harness engineering is, why it matters for AI agents, architecture patterns, runtime contracts, observability, tool/action governance, testing, recovery loops, anti-hardcode principles, and practical implementation guidance. Use web search and read URL evidence if useful. The final answer must be around 3000 words, not 3000 characters. End exactly with MCP_CHROME_TERMINAL_REPAIR_DONE
```

### Run 1

Result: failed by `maxSteps`.

Important Inspector facts:

- Debug Index firstBadSignal: `Terminal repair mode active`.
- Active deficit: `structure`.
- Candidate: `final_candidate.md`, 3050 words.
- Source evidence: read sources 3/3, relevant 2/2.
- Structure audit: duplicate headings / duplicate section numbers.
- Last action loop: repeated `workspace_read final_candidate.md`.

Conclusion: terminal repair activated correctly and Inspector made the issue visible, but the allowed repair action surface still let the model repeat a no-progress read instead of mutating the workspace.

Patch after this run:

- filtered repeated no-progress actions from planner action surface during repair;
- added structure-deficit no-progress preflight block for `workspace_read` / `workspace_replace`.

### Run 2

Result: did not validate terminal repair. The isolated Chrome tab routed the turn as a continuation/resume flow:

- Debug Index: `Planner / Clarification Loop`.
- Planner prompt became: `Resume the paused long-running task from the current TodoTask/TodoState...`.
- Final response asked the user to describe the task because `todo_inspect` returned `itemCount: 0`.

Conclusion: this exposed a separate approval-resume/thread routing issue. It is not terminal repair logic, but it prevented a clean second live proof in Chrome MCP.

## Honest Bad Result

The deterministic repair implementation and unit/integration checks pass, but Chrome MCP live QA is not clean yet:

1. First run proved terminal repair visibility but still hit maxSteps due a structure repair read loop.
2. Second run was hijacked by resume/continuation routing and ended in clarification.

## Next Follow-Up

The next fix should target approval-resume / long-run continuation routing so a fresh end-user prompt cannot be rewritten into a stale "resume paused task" request when there is no TodoState. After that, rerun the same Chrome MCP 3000-word live QA and require a clean terminal result.
