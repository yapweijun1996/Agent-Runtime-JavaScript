# Semantic Terminal Fingerprint Live/Regression Notes — 2026-05-14

## Goal

Reduce repeated `workspace_publish_candidate` / direct `finalize` loops where the AI changes `finalReadiness` wording but keeps the same failed terminal intent.

## Runtime Change

- `actionPatternConvergence` now keeps exact action fingerprint detection and adds:
  - `outcomeHash`
  - `semanticFingerprint`
  - `repeatedSemanticFingerprintCount`
  - `patternKind=semantic_terminal`
- The semantic terminal fingerprint covers `workspace_publish_candidate` and direct finalize continuations.
- Hash inputs are compact facts only: terminal action, candidate stats/path, source/length deficits, source minimum, issue codes, and block status.
- Candidate version and `finalReadiness` payload fields are intentionally excluded from the semantic terminal fingerprint because live publish attempts can mutate version/readiness prose without changing the terminal intent or observable outcome.
- Raw report text, raw messages, and full `remainingGaps` strings are not hashed or projected.

## Verification

Targeted deterministic checks:

```bash
node test/unit/action-pattern-convergence.test.js
node test/unit/action-loop-session-terminals.test.js
node test/unit/workspace-actions.test.js
node test/unit/requirement-recovery-evaluator.test.js
```

Project checks:

```bash
npm test
npm run build
npm run dist:check
```

Browser live checks:

```bash
node examples/browser/test/read-url-live-smoke.mjs
node examples/browser/test/read-url-live-smoke.mjs --mode=long-report
```

Observed browser long-report result:

```json
{
  "provider": "gemini",
  "candidateWords": 3065,
  "decision": "limited",
  "evidenceSatisfied": false,
  "lengthSatisfied": true,
  "maxConsecutivePublishCandidate": 17,
  "readUrlStatus": "ok 200",
  "semanticTerminalNoProgressObserved": true,
  "sourceMinimumPassed": false,
  "terminalizedBy": "workspace_publish_candidate"
}
```

## Result

- Unit coverage proves semantic terminal convergence fires for repeated publish/finalize intent even when exact action args differ.
- Direct `planner_finalize` workspace-publish-path continuation refreshes the same convergence state.
- Browser live QA completed through `workspace_publish_candidate`, not direct finalize.
- The final live run was contract-valid limited: length target met, source minimum not met, and remaining gaps were concrete.
- Browser live QA now asserts that if repeated `workspace_publish_candidate` happens, `actionPatternConvergence.recentPatterns` must show `patternKind=semantic_terminal` with `status=repeated_no_progress`.

## HBR

The live run proved the semantic terminal signal is emitted in the support/debug state, but the model still repeated `workspace_publish_candidate` 17 consecutive times after the signal appeared. The detector works; the remaining issue is planner obedience / stronger no-progress terminal correction after `repeat_same_terminal_intent`.
