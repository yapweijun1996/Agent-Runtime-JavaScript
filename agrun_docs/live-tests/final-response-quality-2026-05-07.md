# Final-response-quality live re-test — 2026-05-07

Ticket: AGRUN-228 PR 1 (parent ADR-0019).
Pre-PR commit: `b3fae3f4` (baseline failure: 60s / 11-cycle loop).
Post-PR commit: `bed6451f` (ADR-0019 PR 1: veto → note).

## Goal

Verify that ADR-0019 PR 1 (convert
`maybeCreateFinalResponseQualityVeto` to a non-blocking note) actually
eliminates the 8+ `before-finalize-veto` loop seen on the original
support-bundle (lite × Mandarin × 3000-word prompt).

Same prompt, same provider, same model — only the runtime code
changed.

## Method

Single-cell live test via Chrome DevTools MCP, dev server on
localhost:3000, real `gemini-3.1-flash-lite-preview` provider with
`.env.local` keys.

Prompt (verbatim from the user's original support bundle):
> Find the latest AI browser news and give me 3 links worth reading
> today. reply me mandarin and i need a 3000 words report

QA URL: `?qa=adr0019-pr1-lite-zh-3000&qa_clean=1&qa_reset_settings=1&debug=y`

## Results

| Metric | Pre-PR (`b3fae3f4`, support-bundle) | Post-PR (`bed6451f`, this run) | Delta |
|---|---|---|---|
| Total wall time | 60s | **21s** | **-65%** |
| Total cycles | 11 | 4 | -64% |
| `before-finalize-veto` events | 8 | 2 (todo-state pacing only, decision=`todo_run_next`) | -75% |
| `final-response-quality` veto events | 4+ | **0** | -100% |
| `final-response-quality-noted` (PR 1 new step) | n/a | 0 (final answer was OK so analysis returned ok) | n/a |
| `planner-fallback-skipped-duplicate` | 3 | **0** | -100% |
| `planner-repair-failed` | 3 | **0** | -100% |
| `session-budget-breach` triggers | 5+ | **0** | -100% |
| Terminal path | `runtime_finalize` (forced) | **`planner_final`** (AI's own) | qualitative win |
| Workspace files authored | 1 (draft.md only, ~200 字) | 0 (single-shot) | n/a — different path |
| Final-answer length | ~300 中文字 (truncated, garbled) | **~700 中文字, 4 sections, with Sources** | +130%+ structure |
| Token usage | 6.7K in · 0.9K out | 13.7K in · 1.0K out | larger context, similar output |
| Final-answer language | Mandarin | **Mandarin** ✅ | unchanged |

## Final-answer excerpt (post-PR)

```
您好！很高兴为您整理关于 2026 年 AI 浏览器领域的最新动态与深度报告。
…
推荐阅读链接
- AI Browser Landscape 2026: Atlas vs Comet vs Arc vs Dia …
- Best AI Browsers in 2026 — Arc, Dia, Comet, and What's Next …
- Digital Applied Agentic SEO Audit …

2026 年 AI 浏览器发展深度报告 (综述)
一、 行业背景：从"门户"到"智能助手"
…
二、 核心竞争矩阵
…
三、 AI 浏览器的核心进化趋势
…
四、 结论与建议
…
注：本报告基于 2026 年 Q2 的公开技术动态及行业分析汇总。
```

The answer is structured (header + 3 links + 4 numbered analytical
sections + caveat) and entirely in Mandarin, authored end-to-end by
lite without runtime template injection.

## Why the answer is not yet 3000 字

PR 1 only fixes the LOOP. It does not address output length engineering.
3000-word output requires:

1. A `long-form-writer` skill (proposed ADR-0020, not yet shipped) that
   instructs AI to `todo_plan` 5+ sections and `workspace_write` each.
2. Or an explicit prompt: "todo_plan 5 sections, workspace_write each
   ~600 字, then assemble."

Both follow the principle: **harness must support weak models**
(KB item `45c8eadb`). PR 1 was the prerequisite — without it, even
explicit prompts would loop in the veto path.

## Veto sources after PR 1

The 2 remaining `before-finalize-veto` events on this run are NOT from
`final-response-quality`. They are from the `todo-state-required-completion`
guard (`todoState` mechanism that advances AI through declared plan
steps before letting it finalize):

```
decision: { type: "action", name: "todo_run_next",
            args: { note: "..." } }
maxRequiredCompletionVetoes: 6
```

This is mechanism (advance AI through plan), not push-mode policy. It
emits a `todo_run_next` advancement, not a synthetic `workspace_write`
or finalize-with-prose. Out of scope for ADR-0019.

## Acceptance

- [x] `before-finalize-veto` from `final-response-quality` source: 0
- [x] `planner-fallback-skipped-duplicate`: 0
- [x] `planner-repair-failed`: 0
- [x] `session-budget-breach`: 0
- [x] Terminal path: `planner_final` (AI's own, not runtime_finalize)
- [x] Wall time ≤30s (target was ≤30s, hit 21s)
- [x] Cycles ≤4 (target was ≤4, hit 4)
- [x] Final answer in user's language (Mandarin) ✅
- [x] Final answer is structured prose, not template prose ✅
- [ ] Final answer is 3000 字 — DEFERRED to ADR-0020 (long-form-writer
      skill) per the harness-must-support-weak-models principle.

## Reproduction

```bash
# 1. Build runtime + start dev server
npm run build
npm --prefix examples/browser run dev

# 2. Open Chrome via DevTools MCP at:
#    http://localhost:3000/?qa=adr0019-pr1-lite-zh-3000&qa_clean=1&qa_reset_settings=1&debug=y

# 3. Auto-approve script (paste in DevTools console):
window.__autoApprove = setInterval(() => {
  const b = [...document.querySelectorAll('button')].find(b =>
    b.textContent.trim() === 'Approve' && !b.disabled);
  if (b) b.click();
}, 1500);

# 4. Send prompt: the verbatim text above.

# 5. After ~21s, click "Copy Runtime Steps" and grep for
#    before-finalize-veto / planner-fallback-skipped / session-budget-breach
#    counts.
```

## Conclusion

ADR-0019 PR 1 is verified: the final-response-quality veto loop is
gone. Lite × Mandarin runs that previously took 60s in budget-breach
loops now complete in 21s with AI's own finalize. The veto codepath
that authored English repair-instruction prose is dead. AI now sees
issue codes via `result.diagnostics.finalResponseQuality.issues`
(read-only telemetry) and `loopState.qualityContext` (planner-prompt
block); both surface enums, not English prose.

Next: ADR-0020 (long-form-writer skill) to take this from "21s 700 字"
to "30-60s 3000 字" by adding section decomposition.
