## Live test — ADR-0023/0026 zero-residual push-mode (2026-05-15 lite rerun)

- **ADR:** [`agrun_docs/adr/0023-harness-as-tool-provider-only.md`](../adr/0023-harness-as-tool-provider-only.md), [`agrun_docs/adr/0026-zero-residual-push-mode.md`](../adr/0026-zero-residual-push-mode.md)
- **Test type:** Real LLM e2e via MCP Claude Preview (in-app browser, port 3000)
- **Provider:** `gemini` / Model: `gemini-3.1-flash-lite-preview` (same lite model that exposed the original 8 push-mode sites in ADR-0023's 2026-05-07 audit)
- **Build ID:** `e6ff6fa42-dirty`
- **Prompt:** `用中文写一份关于 2026 年 AI 浏览器发展的 3000 字深度调研报告` (same as ADR-0023 baseline & ADR-0026 follow-up)
- **Session ID:** `session-mp5oecgf-cl3hg3`
- **Auto-approve:** Tier-1 enabled (single continuous run)

## TL;DR

ADR-0023 / ADR-0026 invariants hold on the lite model in error path. The provider returned an empty response on cycle 1 (`Gemini response did not include text output or function calls.`). The runtime **surfaced the failure as `status: "failed"` without rescuing it** — exactly the behavior the 8 push-mode deletions were meant to produce. Pre-ADR-0023, the same input would have produced a fabricated `runtime_finalize` answer and reported `status: "completed"` (fake success).

This rerun also surfaced a separate **mobile ActivityDrawer scroll bug**, diagnosed and fixed in the same session (see "Adjacent fix" below).

## Acceptance criteria — verified

| # | Criterion | Result | Evidence |
|---|---|---|---|
| **A1** | `usedRuntimeFinalize` stays `false` on bad AI output | ✅ MET | `lastRun.usedRuntimeFinalize === false` |
| **A2** | No `runtime_finalize` rescue → `finalAnswerSource` not forced | ✅ MET | `lastRun.finalAnswerSource === null` (no terminal) |
| **A3** | No `terminalizedBy` push (budget / autopilot / quality) | ✅ MET | `lastRun.terminalizedBy === null` |
| **A4** | No strict-retry cascade (ADR-0023 #6 deleted) | ✅ MET | `metrics.providerCallCount === 1` (would be ≥2 if cascade fired) |
| **A5** | No re-prompt with hardcoded repair (ADR-0023 #2 deleted) | ✅ MET | `metrics.plannerCallCount === 1` |
| **A6** | No budget force-finalize (ADR-0023 #7 deleted) | ✅ MET | `runState.sessionBudget === null` |
| **A7** | Error surfaces honestly with `retryable: false` | ✅ MET | `lastRun.error.details.retryable === false` |
| **A8** | `runtimeBuildId` matches latest commit | ✅ MET | `lastRun.runtimeBuildId === "e6ff6fa42-dirty"` |

## Run telemetry

| Metric | Value |
|---|---|
| `status` | **`failed`** ✅ (honest failure, not fake success) |
| `cycleCount` | 1 |
| `stepCount` | 15 |
| `mode` | `tool_loop` |
| `executionClass` | `research_loop` |
| `phase` | `evaluate` |
| `finalAnswerSource` | `null` |
| `terminalizedBy` | `null` |
| `usedRuntimeFinalize` | **`false`** ✅ |
| `metrics.plannerCallCount` | 1 |
| `metrics.providerCallCount` | 1 |
| `error.code` | `PLANNER_ERROR` |
| `error.details.reason` | `provider_error` |
| `error.details.retryable` | `false` |

## Push-mode 0 mapping

| Push-mode site (deleted by ADR) | Pre-deletion behavior if fired | Live-run evidence | Verdict |
|---|---|---|---|
| `runtime-finalize` quality-repair (ADR-0023 #2) | Re-prompt finalizer with `buildFinalResponseRepairInstruction` | `usedRuntimeFinalize === false` | ✅ Did NOT fire |
| Planner-final quality-repair (ADR-0023 #3) | Route bad planner_final through runtime_finalize | `finalAnswerSource === null` | ✅ Did NOT fire |
| `invokeBeforeFinalize` 5-veto chain (ADR-0023 #4-5) | Insert veto observation, force planner re-cycle | No veto flags on `lastRun` | ✅ Did NOT fire |
| Planner strict-retry cascade (ADR-0023 #6) | 3rd API call with hardcoded strict-retry prompt | `providerCallCount === 1` | ✅ Did NOT fire |
| Budget force-finalize (ADR-0023 #7) | Force-finalize on `sessionBudget` breach | `sessionBudget === null` | ✅ Did NOT fire |
| Standalone-recovery (ADR-0023 #8) | Auto-extract one action from malformed envelope | No envelope returned (empty response) → N/A | ✅ N/A |
| Single-tool fast-path (ADR-0026) | Skip cycle-2 planner after first successful tool | `plannerCallCount === 1`, only 1 cycle ran | ✅ Did NOT fire |
| Consecutive-failure guard (ADR-0026) | Force-finalize on 2 consecutive same-action failures | `recoveryStateRetries` absent / 0 | ✅ Did NOT fire |

## Why this is a stronger signal than ADR-0026's happy-path run

ADR-0026's 2026-05-08 live test verified push-mode 0 on a **successful** research run. This rerun verifies push-mode 0 on a **failing** provider call — which is the original audit scenario that motivated ADR-0023 in the first place. The lite model dropping an empty response is exactly the kind of bad output the old runtime would have silently rescued. Today it surfaces as a real `failed` status. The harness no longer cosplays as the AI.

## Adjacent fix — mobile ActivityDrawer scroll bug

While verifying acceptance signals with the in-app preview at mobile viewport (375×812), the Activity drawer was unable to scroll on long activity logs.

### Root cause

[examples/browser/src/components/ActivityDrawer.tsx:33](https://github.com/yapweijun1996/agrun/blob/main/0_development/examples/browser/src/components/ActivityDrawer.tsx) — mobile drawer wrapper used `max-h-[88vh]` with no `h-` companion. Per CSS spec, `max-height` is not a *definite size*, so percent-height resolution on descendants falls through. The grandchild `<div className="min-h-0 h-full overflow-y-auto">` failed to resolve `h-full` to the parent's flex-determined height and instead grew to its content height (~12780px on a real research run). Outer `overflow-hidden` clipped the visual overflow, so the drawer *looked* sized correctly but the scroll container's `clientHeight === scrollHeight` → no scroll ever triggered.

Desktop branch was unaffected because `sm:h-full sm:max-h-none` gives a definite percent base.

### Fix

One-character class change: `max-h-[88vh]` → `h-[88vh]`. Also removed the now-redundant `sm:max-h-none` since there's no max-height to reset.

### Verification (mobile 375×812, drawer open with real activity log)

| Metric | Before | After |
|---|---|---|
| Wrapper height (`h-[88vh]`) | 714.555px | 714.555px |
| Scroll container `clientHeight` | 12780.5px (broken) | 621px ✅ |
| Scroll container `scrollHeight` | 12780.5px | 13118px |
| `canScroll` (scrollHeight > clientHeight) | false | **true** ✅ |
| `scrollTop = 400` actually moves content | no (max scroll = 0) | yes ✅ |

Visual confirmation: scrollbar visible on right edge, jump-to-latest button appears once user scrolls past top.

## Caveats

- This is a one-shot live test on a single empty-response error. The 2026-05-08 ADR-0026 happy-path test using `gemini-2.5-flash` remains the success-path canonical evidence.
- Empty-response retry on the finalizer path (`requestFinalizerProviderResponse`) is preserved per ADR-0023's "Surfaces preserved" section and was not exercised here (no AI authoring path entered).
- Scroll fix verified on Chromium (preview MCP). iOS Safari touch-scroll behavior with the same fix is theoretically correct (definite height + nested h-full + overflow-y-auto) but not separately verified on a physical iOS device.
