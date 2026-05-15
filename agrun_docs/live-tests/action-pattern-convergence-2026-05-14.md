# Action Pattern Convergence Live Test - 2026-05-14

## Goal

Add a generic, AI-first action fingerprint convergence layer so repeated identical `action+args` patterns without observable progress become planner-visible before the older session budget fallback.

## Implementation Summary

- Added `src/runtime/action-pattern-convergence.js`.
- Runtime state is additive: `runState.actionPatternConvergence`.
- The evaluator reuses `fingerprintAction()` and records:
  - latest action fingerprint
  - repeated fingerprint count
  - steps without observable progress
  - compact progress snapshot
  - capped recent patterns
  - `convergenceSignal` when the same fingerprint repeats without progress
- Progress is based only on observable facts:
  - successful `read_url` count, distinct read URLs, relevant source count
  - search pass/result URL growth
  - workspace candidate stats or workspace operation/version growth
  - Todo done/completed growth
  - memory/tool/skill progress
- Duplicate failed reads of the same URL do not count as source progress.
- Planner prompt, native system prompt, Inspector debug report, and support bundle now expose the compact convergence state.

## Verification

Commands run:

```bash
node test/unit/action-pattern-convergence.test.js
node test/unit/session-budget.test.js
node test/unit/read-url-action.test.js
node test/unit/requirement-recovery-evaluator.test.js
node test/unit/workspace-actions.test.js
npm test
npm run build
npm run dist:check
node examples/browser/test/read-url-live-smoke.mjs --mode=long-report
```

Result:

- Unit and targeted runtime tests passed.
- `npm test` passed.
- `npm run build` passed with existing dependency/chunk warnings.
- `npm run dist:check` passed.
- Browser 3000-word live QA passed.

Live QA summary:

```json
{
  "provider": "gemini",
  "candidateWords": 3133,
  "decision": "limited",
  "evidenceSatisfied": false,
  "lengthSatisfied": true,
  "readUrlStatus": "ok 200",
  "sourceMinimumPassed": false,
  "terminalizedBy": "workspace_publish_candidate",
  "remainingGaps": [
    "Independent third-party peer-reviewed validation of specific 'harness engineering' terminology",
    "Direct industry-wide standardized architectural blueprints for agent harnesses"
  ]
}
```

## Honest Bad Result

The live run still repeated `workspace_publish_candidate` several times. That is not an exact same-fingerprint loop because the `finalReadiness` payload can change between attempts, so the new exact action+args evaluator does not classify every repeated terminal attempt as identical. Existing `requirementRecoveryEvaluator.convergence` remains the better layer for semantic terminal no-progress loops; a future follow-up can add a normalized terminal-action pattern if needed.

## Harness Boundary

Runtime does not write report text, select sources, pick queries, or force finalization. It only records action fingerprints, progress deltas, repeated no-progress facts, and a correction contract.
