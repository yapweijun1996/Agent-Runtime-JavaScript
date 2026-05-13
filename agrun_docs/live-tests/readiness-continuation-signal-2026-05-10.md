# Readiness Continuation Signal QA - 2026-05-10

## Goal

Verify that agrun can explain why a research agent finalized after seeing an unmet user requirement without adding runtime-owned source, length, or content sufficiency gates.

## Change Verified

- Runtime records `readiness_continuation_signal` when AI declares `finalReadiness.decision="limited"` or `requirementsAssessment.requirementSatisfied=false` / `lengthSatisfied=false` / `evidenceSatisfied=false`.
- The signal is fed back as the next OODAE observation once, while AI still owns whether to continue research or finalize with limitations.
- Inspector exposes the signal in Support > Debug Index, Debug Gates, Debug Report, AI Workflow, OODAE Cycles, Runtime Lifecycle, and Support Bundle.
- Inspector now flags AI self-audit gaps such as `lengthSatisfied=true` without an AI-declared `observedLength`.

## Verification

- `node test/unit/action-loop-session-terminals.test.js`
- `npx tsx examples/browser/test/inspector-debug-report.smoke.ts`
- `npm --prefix examples/browser run lint`
- `npm --prefix examples/browser run build`
- `npm run build:lib`
- `npm test`
- `npm run build`
- `npm run dist:check`
- `git diff --check -- <changed files>`

## Chrome Real QA

URL:

```text
http://127.0.0.1:3000/?debug_yn=y&qa_auto_approve_tier1=y
```

Prompt:

```text
用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告
```

Result:

- Run completed in 14 cycles with `selectedSkill=deep-research-writer`.
- Read URL succeeded for 3 sources.
- First finalize with limited readiness emitted `readiness_continuation_signal`.
- Inspector showed `Readiness Continuation: emitted`.
- Debug Index showed `emitted=yes | cycle=13 | decision=limited`.
- Final AI decision still finalized with limitations.
- Final visible response was about 2693 chars / 1241 CJK chars.
- Workspace final candidate stats were 1344 chars / 694 CJK chars.

## HBR

The runtime workflow now exposes the issue clearly, but the final answer still under-delivered the 3000 Chinese-character request. This is not fixed by runtime hardcoding. The next improvement belongs in AI skill/planner workflow quality: the model should continue drafting when its own workspace stats and user requirement show the report is short, or honestly finalize with limitations after exhausting useful work.

## Harness Notes

This is AI-first harness behavior: runtime observes and returns the AI-authored readiness declaration as context. It does not parse the prompt for a 3000-character threshold, does not decide source sufficiency, and does not rewrite the final answer.
