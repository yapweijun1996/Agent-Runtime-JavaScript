# Requirement Recovery Evaluator Live-Test Notes

Date: 2026-05-13

## Goal

Add an AI-first requirement recovery layer above the existing acceptance
packet/evaluator so the planner cannot treat a recoverable deficit as a valid
terminal state too early.

This is not a report writer, query generator, or runtime-owned quality judge.
It is a read-only convergence contract: runtime exposes observable deficits,
remaining recovery budget, and the correction moves that could still be tried.

## Implemented Contract

- New runtime state: `runState.requirementRecoveryEvaluator`.
- New planner projection: `loopState.requirementRecoveryEvaluator`.
- New support/debug exposure through the browser runtime debug state.
- The evaluator classifies deficits as recoverable or no longer recoverable:
  - source/evidence deficit
  - length/workspace deficit
- If a deficit is still recoverable, clean `ready` remains inconsistent and
  `limited` is blocked unless the AI can name a concrete unrecoverable blocker.
- Workspace growth no longer makes a below-target length deficit disappear
  while workspace operation/size budget remains.
- Snippets and candidate writing still do not count as successful read_url
  evidence.

## AI-Owned Recovery Moves

The evaluator only exposes facts and allowed recovery classes. The AI still
chooses the next action:

- Continue source work with `web_search` / `read_url`.
- Continue workspace work with `workspace_append`,
  `workspace_insert_after_section`, or meaningful `workspace_replace`.
- Publish `limited` only when it includes concrete `remainingGaps` and the
  observable unsatisfied booleans match the deficit.

## Regression Coverage

Commands run:

```bash
node test/unit/requirement-recovery-evaluator.test.js
node test/unit/workspace-actions.test.js
node test/unit/research-report-loop.test.js
node test/unit/action-loop-session-terminals.test.js
node test/concerns/planner.test.js
npm test
npm run build
npm run dist:check
```

Observed result: all commands passed.

Notable test-fixture correction:

- The planner concern fixture previously treated a `web_search` result URL as
  if it were a successful `read_url` source.
- The fixture now only treats the URL as read evidence when it appears in
  `Last read source` or `Read URL evidence`.
- This matches the production contract: search snippets are candidate leads,
  not successful source evidence.

## Browser Live QA

Command:

```bash
BROWSER_READ_URL_LIVE_PORT=3328 BROWSER_READ_URL_LIVE_CDP_PORT=9348 node examples/browser/test/read-url-live-smoke.mjs --mode=long-report
```

Observed result:

```json
{
  "provider": "gemini",
  "candidateWords": 3062,
  "decision": "limited",
  "evidenceSatisfied": false,
  "lengthSatisfied": true,
  "readUrlRecoveryStatus": "none",
  "readUrlStatus": "ok 200",
  "sourceMinimumPassed": false,
  "terminalizedBy": "workspace_publish_candidate",
  "remainingGaps": [
    "Minimum of 3 independent, highly relevant technical sources required (only 2 achieved).",
    "Verification of proprietary commercial platform internal harness specifications is limited."
  ]
}
```

Action trace included evidence and workspace recovery:

- `web_search`
- two `read_url` actions
- multiple `workspace_append` actions
- `workspace_read`
- `workspace_finalize_candidate`
- terminal `workspace_publish_candidate`

## Result

The long-report flow now converges correctly:

- requested length was met (`3062` words)
- read_url worked (`ok 200`)
- source minimum still failed
- AI did not clean `ready`
- AI published `limited` with `evidenceSatisfied=false`
- `remainingGaps` were concrete
- no `planner_finalize` bypass
- no maxSteps loop

## HBR

The model still repeated `workspace_publish_candidate` many times before final
terminalization. The result is contract-correct, but the planner could become
more efficient by reacting faster to the recovery/evaluator packet.

The live run proved successful read_url and honest limited behavior, but it did
not prove alternate-source switching under a real blocked source in the exact
long-report scenario. That path remains covered by unit and failure smoke
tests.
