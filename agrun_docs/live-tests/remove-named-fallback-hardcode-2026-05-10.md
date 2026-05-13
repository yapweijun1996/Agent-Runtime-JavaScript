# Remove Limited Brief Hardcode - 2026-05-10

## Goal

Remove the named `named fallback` product mode from agrun. The runtime may still record that AI finalized with limitations, but it must not prescribe a fixed answer format such as `named fallback heading`.

## Changes

- Replaced internal final mode `old fallback mode` and status `old fallback-only status` with neutral `final_with_limitations`.
- Replaced config naming `old budget-exhausted fallback config` with `allowFinalWithLimitationsOnBudgetExhausted`.
- Removed `named fallback heading`, `named fallback`, and `old constrained-evidence mode` wording from active runtime source, skills, tests, docs, and generated dist.
- Updated `deep-research-writer` and `long-web-research` to ask for a normal user-facing answer/report with explicit Limitations when evidence is constrained.
- Kept AI-owned `finalReadiness.decision="limited"` because that is a readiness declaration, not a named output format.

## Verification

```bash
node test/unit/research-evidence-graph.test.js
node test/unit/research-thread-sync.test.js
node test/unit/final-answer-internal-progress.test.js
node test/unit/final-response-prompt.test.js
node test/unit/final-response-quality.test.js
node test/unit/research-quality-benchmark.test.js
node test/unit/approval-todo-state.test.js
npx tsx examples/browser/test/inspector-debug-report.smoke.ts
npm --prefix examples/browser run lint
npm run build
npm run dist:check
npm test
rg -n "old fallback mode|named fallback|named fallback heading|named fallback|named-fallback|old fallback-only status|old budget fallback config|old constrained-evidence mode|shorter answer|named fallback" . --glob '!node_modules/**'
```

Result: all commands passed. The final `rg` scan returned zero matches.

Known non-blocking warnings:

- Rollup dependency warnings from OpenTelemetry and Zod during build.
- Browser bundle chunk-size warning from Vite.

## HBR

This removes the hardcoded named output mode. It does not solve the separate model-quality issue where AI may still finalize too early; that remains visible through `finalReadiness`, raw workspace stats, read_url counts, and AI Workflow warnings.
