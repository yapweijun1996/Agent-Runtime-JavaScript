# Readiness Packet + Deep Research Skill Workflow QA — 2026-05-10

## Goal

Make the research workflow easier to debug without adding runtime-owned
answer-quality gates.

## Changes

- Added `Copy Readiness Packet` in the browser Inspector Support panel.
- Added a focused `readiness_failure_packet` export containing:
  - `finalReadiness`
  - `finalReadinessAssessment`
  - `requirementsAssessment`
  - `readinessContinuationSignal`
  - virtual workspace quality / `workspaceStats`
  - `final_candidate.md` content when present
  - compact read_url source summaries
- Updated `deep-research-writer` in both active skill locations:
  - Use `evidence.json`, matching virtual workspace quality SSOT.
  - Keep TodoState synchronized when a todo plan exists.
  - Treat `readiness_continuation_signal` as an OODAE continuation, not
    permission to repeat the same final.
  - Do not finalize from memory or a prose instruction when
    `final_candidate.md` is missing or empty.
  - Populate concrete `requestedLength` / `observedLength` values when
    `workspace_read` textStats are available.

## Real Browser QA

Target: `http://127.0.0.1:5173/?debug_yn=y`

Prompt:

```text
用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告
```

### Gemini run

- Provider/model: `gemini / gemini-3.1-flash-lite-preview`
- Status: completed.
- Inspector issue: `Research Contract Warning`.
- `Readiness Continuation`: emitted.
- `declaredUnsatisfied`: `decision`, `requirement`, `length`.
- `read_url`: 2 successful strong reads.
- Visible answer: about 2625 chars / 1330 CJK chars.
- HBR: Gemini still finalized under the requested 3000 Chinese characters.
- HBR: one Gemini run finalized with `final_candidate.md` missing and
  workspace stats at zero, which proved the new readiness packet is useful.

### OpenAI run

- Provider/model: `openai / gpt-5-mini`.
- Status: interrupted manually after about 5m52s to avoid wasting budget.
- Cycle count at interrupt: 39/80.
- LLM trace: 39 requests, 38 responses.
- Behavior: repeatedly searched instead of advancing from Phase A or drafting.
- `read_url`: one attempted source, read_url service returned 502/thin.
- Virtual workspace: `questions.md` and `outline.md` existed; no `draft.md` or
  `final_candidate.md`.
- HBR: OpenAI avoided early finalize but got stuck in a search loop and left
  Todo progress stale.

## Conclusion

This is not a missing-tool problem. The agent can search, read_url,
workspace_write, and inspect runtime state. The observed failure is workflow
discipline:

- Gemini: too willing to finalize after seeing its own limited readiness.
- OpenAI: too willing to continue searching and not advance Todo / draft.

The fix stays AI-first:

- Runtime exposes facts and continuation signals.
- Skill owns the workflow contract.
- Inspector gives a focused export so Codex can debug the exact readiness /
  workspace / final candidate state.

No runtime length threshold or source-count sufficiency gate was added.
