# Requirement Recovery Convergence Live QA — 2026-05-14

## Goal

Strengthen `requirementRecoveryEvaluator` so repeated terminal attempts without source or workspace progress become planner-visible convergence facts, not just hidden publish blocks.

## Implementation Summary

- Added `requirementRecoveryEvaluator.convergence` with:
  - `dimensionStates.source`
  - `dimensionStates.length`
  - `repeatedInvalidTerminalCount`
  - `budgetState`
  - `recommendedContract`
  - `terminalPattern`
- Source progress and workspace progress are tracked separately.
- Candidate growth resets length convergence only; it does not invent source progress.
- Blocked `workspace_publish_candidate`/`finalize` attempts are counted even when valid limited is already allowed.
- Planner prompts now tell the AI to stop repeating the same terminal payload and either do recovery work or publish with corrected valid limited readiness.
- Inspector debug report and support bundle now expose requirement recovery convergence counters.

## Verification

Commands:

```bash
node test/unit/requirement-recovery-evaluator.test.js
node test/unit/workspace-actions.test.js
node test/unit/research-report-loop.test.js
node test/unit/action-loop-session-terminals.test.js
npm test
npm run build
npm run dist:check
git diff --check
```

All passed.

Build warnings were existing Rollup/Vite warnings:

- OpenTelemetry ESM `this` rewrite warning.
- Zod circular dependency warning.
- Browser bundle chunk-size warning.

## Browser Live QA

Command:

```bash
BROWSER_READ_URL_LIVE_PORT=3330 BROWSER_READ_URL_LIVE_CDP_PORT=9350 node examples/browser/test/read-url-live-smoke.mjs --mode=long-report
```

Result:

```json
{
  "provider": "gemini",
  "candidateWords": 3037,
  "decision": "ready",
  "evidenceSatisfied": true,
  "lengthSatisfied": true,
  "readUrlRecoveryStatus": "none",
  "readUrlStatus": "ok 200",
  "remainingGaps": [],
  "sourceMinimumPassed": true,
  "terminalizedBy": "workspace_publish_candidate"
}
```

The run used `workspace_append` after below-target drafting and terminalized through `workspace_publish_candidate`, not direct planner finalize.

Repeated publish improved from the first rerun's long sequence of repeated `workspace_publish_candidate` attempts to 4 total publish attempts in the second run.

## HBR

The first live rerun after the initial implementation still repeated `workspace_publish_candidate` many times. Root cause: the first convergence patch counted terminal no-progress only while `validLimitedAllowed=false`. Once the evaluator considered honest limited allowed, blocked publish attempts no longer incremented `repeatedInvalidTerminalCount`.

Follow-up fix: count blocked terminal output as no-progress even when valid limited is allowed, and tighten planner prompt guidance so repeated terminal attempts must either perform recovery work or correct the final readiness payload.
