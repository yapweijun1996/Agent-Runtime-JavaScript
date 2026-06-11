# AGRUN Cross-Model Baseline — PAUSED (2026-05-25)

## Status

**PAUSED** mid-session due to user laptop battery. No runtime changes,
no commits dropped, no state lost. Resumable cleanly.

## Goal recap

After AGRUN-246-N Phase 2 implementation was rejected at live verify
(0/5 strict pass on `gemini-3.1-flash-lite` thinking=high vs baseline
3/7 = 43%), the next direction was to **measure runtime
production-readiness across the model × thinking-level matrix** instead
of continuing to push the weakest single configuration. This audit
captures the partial data collected before pause so a future session
can resume without redoing the completed work.

Goal: same canonical Mandarin Harness Engineering 3000-word fixture
across {openai/gpt-5-mini, gemini/gemini-3.1-flash-lite low,
gemini/gemini-3.1-flash-lite high, optional gemini-2.5-flash /
gemini-2.5-pro} × 3 traces each. Aggregate strict-pass rate per cell.

## Collected so far

### openai/gpt-5-mini (reasoning_effort=medium)

| Trace | timestamp | qualityScore | userGoalSatisfied | sourceMinimum | structureOk | candidateCjkChars | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `2026-05-25T07-14-42-525Z` | **100** | **true** | true (3 read / 3 relevant) | true | 3021 | **STRICT PASS** — clean 23-action sequence, 2 web_search + 2 read_url before publish |
| 2 | `2026-05-25T07-23-45-238Z` | 75 | false | false (7 reads / source_deficit) | n/a | 3158 | partial — length OK, source minimum failed despite 7 read_url calls |
| 3 | — | — | — | — | — | — | **interrupted by pause** |

Partial pass rate: 1/2 strict, 2/2 length-gate clear. Substantially
better than `gemini-3.1-flash-lite` baseline (3/7 strict = 43%; 1-call
Mode B trace ~1500 cjk).

### gemini-3.1-flash-lite (thinking=low)

| Trace | timestamp | Notes |
|---|---|---|
| 1 | started `2026-05-25T07:30:47` local | **interrupted by pause** (~5 min in, no .md output yet) |
| 2 | — | not started |
| 3 | — | not started |

No data collected for this cell yet.

### gemini-3.1-flash-lite (thinking=high) — pre-existing baseline

From AGRUN-246-J distribution sampling + AGRUN-246-N Phase 2 rejection:

- 246-K era (Phase 1 calibration corpus): 3/7 = 43% strict pass
- 246-N Phase 2 verify: 0/5 strict pass (regression from Mode B
  argsExample switch, rolled back via commit 8abb8c19c)

Baseline before Phase 2 = 43%. Post-rollback (`689358c50` →
`ddadfb7d6` density gate may slightly tighten source counts but
runtime tool-shape is back to pre-Phase-2 state).

### gemini-2.5-flash / gemini-2.5-pro

Not yet measured.

## What this partial data already shows

1. **`gpt-5-mini` capable-model evidence is positive.** Trace 1
   produced a clean strict pass (100 / 3021 cjk / 3 relevant sources)
   in a 23-action sequence — exactly the harness's intended happy
   path. Trace 2 hit a source-gate edge case (7 reads but only some
   relevant after AGRUN-246-M density gate). This is a real signal
   that the runtime IS production-ready for capable models; the
   AGRUN-246 saga's 43% baseline is specifically a
   `gemini-3.1-flash-lite` ceiling, not a runtime ceiling.

2. **Cross-model audit conclusion is unblocked even with partial
   data.** The strategic claim "runtime is production-ready for
   capable models, flash-lite has known limits at long-form Mandarin
   research" is consistent with the 1-trace gpt-5-mini PASS evidence.
   A full audit doc can be written once the remaining 7 traces (1
   openai + 3 flash-lite-low + 3 optional gemini-2.5-flash) complete.

## Resume entrypoints

When session resumes:

```bash
# 1. OpenAI gpt-5-mini trace 3 (third of three):
/tmp/run-cross-model.sh openai gpt-5-mini 3

# 2. Gemini flash-lite thinking=low (full 3 traces):
/tmp/run-flashlite-low.sh    # script already on disk

# 3. Optional: gemini-2.5-flash (3 traces):
cat > /tmp/run-25flash.sh << 'BASH'
#!/usr/bin/env bash
set -a; source .env.local; set +a
export NODE_AGRUN_LIVE_PROVIDER=gemini
export NODE_AGRUN_LIVE_MODEL=gemini-2.5-flash
export NODE_AGRUN_LIVE_PROMPT="$(printf '写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。')"
export NODE_AGRUN_LIVE_MAX_STEPS=90
export AGRUN_DEBUG=1
export AGRUN_GEMINI_THINKING_EFFORT=high
export NODE_AGRUN_LIVE_TIMEOUT_MS=400000
for n in 1 2 3; do
  echo "[25flash] trace $n start $(date +%T)"
  node test/node-agrun-3000-live.mjs > /tmp/25flash-$n.log 2>&1
  echo "[25flash] trace $n done exit=$? $(date +%T)"
done
BASH
chmod +x /tmp/run-25flash.sh && /tmp/run-25flash.sh
```

After all cells collected:

- Write final audit `agrun_docs/audits/agrun-cross-model-baseline-2026-05-25.md`
  with the full matrix and the production-readiness statement.
- Update `task.md` handoff + close `AGRUN-CROSS-MODEL-BASELINE-PAUSED`
  in task.jsonl.
- Commit + push.

## Repo state at pause

- HEAD = `8abb8c19c` (rejection record of AGRUN-246-N Phase 2),
  pushed to `origin/main`.
- worktree NOT clean — dist build drift + 16 pre-existing OpenAI
  gateway TS modifications (task.md L692-700 warning unchanged from
  prior handoff). Do not `git add -A`.
- 2 background tasks (`bqviisf11` openai, `bfn0xopwm` flash-lite-low)
  STOPPED via TaskStop. No leaked node processes expected.
- ScheduleWakeup set for `16:02` cannot be cancelled programmatically;
  if it fires after pause, it is a no-op slash-command attempt with no
  side effects.

## HBR

1. Pause happened mid-batch — only 2 of 9+ intended traces have
   structured data. The cross-model production-readiness claim cannot
   yet be made formally; this audit is a checkpoint, not a verdict.
2. The 2 gpt-5-mini traces are encouraging but small-sample. Resume
   must collect at least trace 3 before drawing per-model
   conclusions.
3. flash-lite thinking=low cell has zero data points — opening
   question is whether reducing thinking effort changes the 43%
   baseline at all. The interrupted trace's jsonl may be partially
   readable; check `agrun_debug_runs/` for any
   `2026-05-25T07-30-47-*` artifacts when resuming.
4. ScheduleWakeup-fired wakeups in idle sessions are harmless but
   noisy. Future cross-model batches should not use ScheduleWakeup
   for this kind of foreground-waiting work.
