# Terminal Correction State Live QA — 2026-05-15

## Goal

Verify sticky terminal correction for repeated `workspace_publish_candidate` / direct finalize loops.

The harness must keep a correction contract visible when semantic terminal no-progress repeats, count ignored terminal attempts, surface the active correction in Inspector, and still leave action choice to the AI.

## Implementation Verified

- `actionPatternConvergence.terminalCorrectionState`
- `actionPatternConvergence.ignoredTerminalCorrectionCount`
- `actionPatternConvergence.latestCorrectionSignal`
- Inspector Support Bundle `[terminal_correction_state]`
- Debug Index firstBadSignal `kind="terminal_correction_active"`
- Planner prompt guidance for sticky terminal correction
- TodoState-aware allowed moves: `todo_advance`, `todo_run_next`, `todo_cancel`

## Regression Tests

Commands run:

```bash
node test/unit/action-pattern-convergence.test.js
node test/unit/action-loop-session-terminals.test.js
node test/unit/workspace-actions.test.js
node test/unit/requirement-recovery-evaluator.test.js
node test/unit/planner-native-system-prompt.test.js
node test/unit/planner-prompt-envelope-lines.test.js
cd examples/browser && npx tsx ./test/inspector-debug-report.smoke.ts
node --check examples/browser/test/read-url-live-smoke.mjs
npm run dist:check
npm test
npm run build
```

Result: passed.

Known non-blocking warnings:

- Node `MODULE_TYPELESS_PACKAGE_JSON` warning for ESM-style runtime files under a CommonJS package.
- Rollup `this` rewrite warnings from `@opentelemetry/api`.
- Rollup circular dependency warning from `zod`.
- Vite large browser chunk warning.

## Failed Live Smoke Before Follow-up Patch

Command:

```bash
npm --prefix examples/browser run test:live:read-url -- --mode long-report
```

Result: failed.

Observed:

- `candidateWords=3094`
- `finalReadinessDecision=ready`
- `sourceMinimumPassed=true`
- `maxConsecutivePublishCandidate=5`
- `terminalCorrectionState.ignoredTerminalCorrectionCount=5`
- `semantic_terminal` recent patterns were visible
- AI repeatedly retried `workspace_publish_candidate`

Root cause:

The sticky correction worked, but its correction contract was too generic. The real blocker was unfinished TodoState, so the AI needed `todo_advance` / `todo_run_next` / `todo_cancel`, not only generic "change action" guidance.

Fix:

When `runState.todoState` has active/pending work, semantic terminal correction now adds TodoState recovery moves and a TodoState-specific `requiredCorrection`.

## Passing Scripted Live Smoke

Command:

```bash
npm --prefix examples/browser run test:live:read-url -- --mode long-report
```

Result: passed.

Key output:

```json
{
  "provider": "gemini",
  "candidateWords": 3188,
  "decision": "ready",
  "evidenceSatisfied": true,
  "lengthSatisfied": true,
  "maxConsecutivePublishCandidate": 1,
  "readUrlRecoveryStatus": "none",
  "readUrlStatus": "ok 200",
  "remainingGaps": [],
  "semanticTerminalNoProgressObserved": false,
  "sourceMinimumPassed": true,
  "terminalCorrectionIgnoredCount": 0,
  "terminalizedBy": "workspace_publish_candidate"
}
```

## Chrome MCP DevTools Live QA

Target:

```text
http://127.0.0.1:3000/?debug_yn=y&qa=terminal-correction-mcp-rerun-20260515&qa_clean=y
```

End-user prompt:

```text
I am preparing an engineering brief for my team. Please write a detailed technical report, around 3000 words, about AI agent harness engineering. Explain what harness engineering is, why it matters for AI agents, architecture patterns, runtime contracts, observability, tool/action governance, testing, recovery loops, anti-hardcode principles, and practical implementation guidance. Use web research and read_url evidence where useful. If read_url evidence is unavailable or source coverage remains insufficient, publish limited with concrete remainingGaps instead of clean ready. End exactly with MCP_CHROME_TERMINAL_CORRECTION_RERUN_DONE
```

Observed in Chrome DevTools MCP:

```json
{
  "idle": true,
  "hasDone": true,
  "terminalPublishVisible": true,
  "candidateWords": 3098,
  "directReadSources": 3,
  "reads": { "observed": 3, "min": 3 },
  "relevant": { "observed": 3, "min": 2 },
  "hasTerminalCorrectionFirstBad": false
}
```

Console check:

```text
no console warnings/errors found
```

Inspector visible facts:

- `workspace_publish_candidate` was the terminal path.
- `final_candidate.md` was reviewed at `words=3098`.
- Read URL evidence succeeded for 3 sources.
- Source minimum passed: reads `3/3`, relevant `3/2`.
- No active terminal correction remained because no repeated no-progress terminal loop occurred in the final run.

## Follow-up Guard Tightening

After the first passing run, stricter scripted live smoke exposed two more convergence issues:

1. A clean `ready` publish could still slip through when the source-minimum gate was stale before `workspace_publish_candidate` evaluated readiness.
2. Sticky terminal correction blocked too late because preflight only stopped plain publish after ignored count reached 2.

Fixes:

- `workspace_publish_candidate` now refreshes the Research Report Loop gate before publish when AI declares clean `ready` or claims `evidenceSatisfied=true`.
- Terminal correction preflight now blocks plain `workspace_publish_candidate` as soon as `terminalCorrectionState.active=true`; only valid `limited` with concrete `remainingGaps` may pass while correction is active.
- `terminal_correction_preflight_block` no longer inflates ignored count; observable progress and terminal completion clear the active ignored count.
- Long-report live smoke assertions now treat two consecutive terminal actions as acceptable when outcome changes into final valid limited, but require semantic convergence visibility for longer repeated publish runs.

Latest scripted Chrome live result:

```json
{
  "provider": "gemini",
  "candidateWords": 3106,
  "decision": "limited",
  "evidenceSatisfied": false,
  "lengthSatisfied": true,
  "maxConsecutivePublishCandidate": 3,
  "readUrlStatus": "ok 200",
  "remainingGaps": [
    "Source coverage is limited to 2/3 required sources.",
    "Additional independent academic or practitioner perspectives would further validate the architectural patterns discussed."
  ],
  "semanticTerminalNoProgressObserved": true,
  "sourceMinimumPassed": false,
  "terminalCorrectionIgnoredCount": 0,
  "terminalizedBy": "workspace_publish_candidate"
}
```

Verdict: pass. Source coverage was insufficient, so the correct terminal state was honest `limited`, not clean `ready`.

## Verdict

Pass.

The runtime now exposes sticky terminal correction when needed, the Inspector can surface it as firstBadSignal, and the long-report live path no longer burns cycles repeating publish/finalize after the TodoState-specific recovery guidance was added.

## HBR

The first sticky-state implementation still allowed 5 ignored publish attempts because the correction contract did not explain the TodoState blocker. The follow-up source-gate run then exposed stale source-minimum evaluation before publish. The final fix keeps source readiness fresh before clean ready and blocks plain terminal retry as soon as sticky correction is active.
