# AI Workflow Finalize Audit Live QA - 2026-05-09

## Goal

Verify the Inspector can answer the debug question: why did the AI finalize even when the report did not meet the end-user requirement?

This is an AI-first observability fix. The runtime records model declarations and raw state. It does not hardcode a 3000-character gate, source minimum, or automatic rewrite.

## Code Changes

- `src/runtime/agent-workflow-packets.js`
  - Preserves sanitized AI-authored `reasoning`, `instruction`, and `finalReadiness.limitations` previews in planner response packets.
- `src/runtime/runtime-finalize.js`
  - Propagates true terminal source through provider request/response steps, so AI-driven finalization is labelled `planner_finalize` instead of always `runtime_finalize`.
- `examples/browser/src/runtime/oodae-packet-ledger.ts`
  - Adds derived `workflow_warning` rows for limited final readiness, missing readiness, and readiness/raw-state conflicts.
  - Shows model-authored rationale/instruction previews in AI Workflow details.
- `examples/browser/src/components/InspectorAiWorkflowSection.tsx`
  - Adds warning metric and tone for `workflow_warning`.
- `examples/browser/src/components/inspector-support.ts`
  - Classifies research/report runs with `finalReadiness=limited` or unsatisfied AI requirements as `Research Contract Warning`.
- `test/helpers/mocked-fetch.js`
  - Updates the per-action synthesize research fixture to recognize `missing_ai_readiness` through structured observation output, `research_finalize_contract` kind, and projected contract-signal text.

## Live QA

Command:

```bash
BROWSER_DEV_AUTOSEED_KEYS=true DISABLE_HMR=true npm --prefix examples/browser run dev -- --host=127.0.0.1 --port=3015
```

URL:

```text
http://127.0.0.1:3015/?debug_yn=y&skill_provider=public&qa=ai-workflow-audit-cn-3000-limited-warning-2026-05-09&qa_clean=y&qa_auto_approve_tier1=y&cache_bust=2
```

Prompt:

```text
用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告
```

Observed Inspector result:

- Issue type: `Research Contract Warning`
- Research Gate: active, research contract incomplete
- Contract detail: `readUrl=1`, `aiReady=yes`, `finalReadiness=limited`, `requirementsAssessment=declared`, `requirementSatisfied=no`
- Diagnosis: AI declared the requirement was not fully satisfied because the report was shorter than requested.
- AI Workflow warning count: `1`
- AI Workflow warning title: `AI finalized with declared limitations`
- Warning detail includes `finalReadiness=limited`, `requirementSatisfied=false`, `lengthSatisfied=false`, `evidenceSatisfied=true`, `successfulReadUrls=1`, and the AI limitation preview.
- Planner response detail includes model-authored `reasoning` and `instruction` previews.
- Provider rows now show `source=planner_finalize`.
- Virtual workspace row shows `final_candidate.md` stats around `chars=1093`, `cjk=715`, `words=44`.

## Verification Commands

```bash
node test/unit/agent-workflow-packets.test.js
node test/unit/action-loop-session-terminals.test.js
npx tsx examples/browser/test/inspector-debug-report.smoke.ts
npm --prefix examples/browser run lint
npm --prefix examples/browser run build
npm run build:lib
npm test
```

Result: all passed.

Known non-failing build warnings:

- Vite chunk-size warning for the browser example bundle.
- Rollup warning from OpenTelemetry ESM `this` rewrite.
- Rollup circular dependency warning from Zod.

## HBR

The user-facing report is still shorter than requested. This work does not force the AI to keep writing or block finalization. It makes the failure visible and auditable: the AI declared limited readiness, the workspace stats were short, and Inspector now reports that as a warning instead of a healthy run.

## Harness Logic

Harness supplies observable state and records AI declarations. AI owns the research judgment and final prose. Inspector makes the workflow debuggable without replacing model judgment with runtime hardcoded sufficiency rules.
