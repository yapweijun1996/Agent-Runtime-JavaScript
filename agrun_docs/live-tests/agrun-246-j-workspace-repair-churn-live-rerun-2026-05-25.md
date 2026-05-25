# AGRUN-246-J Workspace Repair Churn — Live Rerun 2026-05-25

## Scope

Close the HBR on `agrun_docs/audits/agrun-246-j-workspace-repair-churn-2026-05-25.md`
by re-running the canonical Mandarin Gemini flash-lite / high-thinking
Harness Engineering report on current HEAD `b8d424ab8` and measuring real
planner-decision / workspace patch-cycle cost across **three live traces**, not
one. Baseline pre-change: `2026-05-24T23-59-12-542Z`.

Initial single-trace pass (Rerun 1) showed a large cycle drop, so two more
identical reruns (Rerun 2, Rerun 3) were captured to expose distribution
variance. All four runs share the same env, prompt, model, step budget, and
timeout.

## Command

```bash
AGRUN_DEBUG=1 \
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=high \
NODE_AGRUN_LIVE_MAX_STEPS=60 \
NODE_AGRUN_LIVE_TIMEOUT_MS=300000 \
NODE_AGRUN_LIVE_PROMPT="写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。使用网络检索和网页阅读为每个章节引用真实来源。至少引用3个权威网址。结构：定义、核心原则、具体模式、反面案例、真实世界示例、结论。" \
node test/node-agrun-3000-live.mjs
```

## Live Evidence

Run artifacts:

- Baseline: `agrun_debug_runs/2026-05-24T23-59-12-542Z.{md,jsonl,-report.md}`
- Rerun 1: `agrun_debug_runs/2026-05-25T01-11-49-375Z.{md,jsonl,-report.md}`
- Rerun 2: `agrun_debug_runs/2026-05-25T01-21-38-039Z.{md,jsonl,-report.md}`
- Rerun 3: `agrun_debug_runs/2026-05-25T01-21-47-172Z.{md,jsonl,-report.md}`

## Strict Quality Gate Distribution

| Run | runStatus | candidateCjkChars | sourceMinimum (read/relevant) | structure | qualityScore | userGoal |
|---|---|---|---|---|---|---|
| Baseline | completed | 3032 | 3 / 2 PASS | PASS | **100** | true |
| Rerun 1 | completed | 3274 | 3 / 2 PASS | PASS | **100** | true |
| Rerun 2 | completed | 3156 | 16 / 1 **FAIL** | PASS | **75** | **false** |
| Rerun 3 | completed | 3069 | 3 / 3 PASS | PASS | **100** | true |

3-trace post-change pass rate: **2 / 3** on the strict gate. The one failure
failed only the source gate (`1` relevant source vs minimum `2`) despite reading
`16` URLs. Structure, length, applyIfValid, and run completion were all healthy
in the failed run.

## Planner-Decision Distribution

| Action | Baseline `23-59-12` | Rerun 1 `01-11-49` (PASS) | Rerun 2 `01-21-38` (FAIL) | Rerun 3 `01-21-47` (PASS) |
|---|---|---|---|---|
| `workspace_propose_patch` | 9 | 3 | 3 | 9 |
| `workspace_apply_patch` | 4 | 0 | 0 | 2 |
| **`propose + apply` pair** | **13** | **3** | **3** | **11** |
| `workspace_insert_after_section` | 7 | 2 | 2 | 4 |
| `workspace_multi_edit` | 1 | 3 | 0 | 3 |
| `workspace_replace` | 0 | 0 | 0 | 3 |
| `workspace_write` | 4 | 4 | 5 | 4 |
| `workspace_read` | 2 | 3 | 1 | 1 |
| `workspace_publish_candidate` | 2 | 2 | 3 | 1 |
| `workspace_finalize_candidate` | 1 | 1 | 1 | 1 |
| `web_search` | 2 | 3 | 3 | 6 |
| `read_url` | 1 | 4 | **18** | 3 |
| `todo_plan` | 1 | 1 | 1 | 1 |
| `todo_run_next` | 5 | 5 | 0 | 4 |
| `todo_advance` | 0 | 0 | 0 | 3 |
| **Total `planner_decision`** | **39** | **31** | **37** | **45** |

Post-change distribution: total planner decisions ∈ {31, 37, 45}, mean ≈ 37.7
vs baseline 39. Roughly **flat on average, high variance**, NOT a stable −21%.

## `applyIfValid:true` Adoption

| Run | propose calls | with `applyIfValid:true` | with `applyIfValid:false`/absent | apply follow-up |
|---|---|---|---|---|
| Rerun 1 | 3 | **3 (100%)** | 0 | 0 |
| Rerun 2 | 3 | **3 (100%)** | 0 | 0 |
| Rerun 3 | 9 | 6 (67%) | 3 | 2 |

When the model chooses `applyIfValid:true`, propose+apply pair cycles collapse
exactly as designed: Rerun 1 and Rerun 2 both reach `3 + 0 = 3` for the pair.
Rerun 3 shows the model also still picks the legacy preview-only path for some
patches — likely because those patches are content-bearing (not pure
`normalize_headings`), which is the intended safety boundary.

## Honest Read

**What the change does well:**

- The `applyIfValid:true` surface works exactly as designed. Across all 3
  reruns, **every** propose carrying `applyIfValid:true` collapsed into a
  single action with zero `workspace_apply_patch` follow-up.
- propose+apply pair cycles can drop to 3 (from baseline 13) — confirmed twice.
- Content-bearing patch operations correctly continue to use the
  preview-then-apply two-step path (Rerun 3 case).

**What the change does not do:**

- It does NOT measurably reduce total planner cycles on average. 3-trace post-
  change mean 37.7 ≈ baseline 39. The −21% headline from Rerun 1 alone was the
  optimistic tail, not the median.
- It does NOT improve source-relevance recovery. Rerun 2 burned 18 `read_url`
  cycles trying to satisfy the `2 relevant` source minimum and finished with
  only `1` relevant source — a separate failure surface that AGRUN-246-J
  source-relevance work was supposed to address but is still flaky on
  `gemini-3.1-flash-lite`.

## HBR (3-trace evidence)

1. **HBR 1 (single-trace caveat resolved, partially):** Total planner cycle
   reduction is NOT stable. 3-trace shows {31, 37, 45} vs baseline 39. The
   honest claim is: `applyIfValid:true` collapses propose+apply pair cycles
   when the AI uses it, but other surfaces (search/read recovery, multi_edit,
   replace, todo) absorb the freed budget so the total stays roughly flat.
2. **HBR 2 (new, separate from churn):** 1/3 reruns failed strict quality on
   the source gate. `gemini-3.1-flash-lite` got stuck reading 16 URLs without
   reaching 2 relevant sources. This is the same source-relevance class
   AGRUN-246-J source+structure closeout tried to fix — it is not a regression
   from `applyIfValid:true` but it shows the source-relevance fix is not
   robust on this model. Should open a follow-up ticket targeting recovery
   ranking / topic-relevance scoring on long read_url loops.
3. **HBR 3:** Rerun 3 used `workspace_replace` × 3 and `todo_advance` × 3 —
   action shapes not seen in baseline or other reruns. Worth understanding
   why the model chose `replace` over `propose_patch` on a passing run.

## Verification

- `node test/node-agrun-3000-live.mjs` exit 0 on all 3 reruns (real Gemini,
  real readurl, real SearXNG).
- Action counts derived from `agrun_debug_runs/*.jsonl` via
  `jq 'select(.event=="planner_decision") | .payload.actionName'`.
- `applyIfValid` adoption read from `.payload.args.applyIfValid`.
- `npm run dist:check` PASS (286 markdown files).
