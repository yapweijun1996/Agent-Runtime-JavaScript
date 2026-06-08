# Live monitor session — DeepSeek-flash-high (2026-06-06)

Real-API live observation of `deepseek-v4-flash` at `reasoning_effort: high` through
`test/live-observe.mjs`, run → observe → debug → fix → verify loop. Live-only (real
`.env.local` key, no mock).

## Summary

Quick scenario: the agent is **healthy** (clean convergence). Report scenario (3000-word
research report) surfaced **two harness/config problems (fixed)**, **one suspected runtime
gap (falsified)**, and **one model-behaviour limitation (not a code bug)**.

## Problem 1 — live monitor could not show which action ran (FIXED, commit 432a570f)

- **Symptom:** every `action_executed` line printed `⚙ ACTION ?` — actionName/control/status null.
- **Root cause:** the SSOT event ledger delivers the step detail under `payload`
  (`runtime-event-ledger.js:115`), but `live-observe.mjs onRuntimeEvent` read `ev.detail`.
- **Also:** the harness only supported `openai`/`gemini` — no DeepSeek. DeepSeek is
  OpenAI-compatible: provider `openai` + `endpoint https://api.deepseek.com/v1` +
  `apiVariant "chat"`, key `DEEPSEEK_API_KEY`.
- **Fix:** read `ev.payload` (detail fallback); add a `deepseek` provider.
- **Verified:** re-run shows `⚙ ACTION web_search success` / `read_url success`; JSONL carries
  `actionName/control/status`.

## Problem 2 — report scenario looped on workspace-publish-candidate-gated (FIXED, commit bdfd828c)

- **Symptom:** `workspace_publish_candidate → workspace-publish-candidate-gated → read/finalize →
  publish → gated → …` (5× gated, 3× fingerprint-repeat) — the agent burned the budget on a
  publish it could never land.
- **Root cause:** `agrun` gates `workspace_publish_candidate` behind **long_research**
  (AGRUN-256 anti-"give-up") and has **NO prompt auto-detection** — the host must declare it
  (`isLongResearchRun`: explicit `researchActivation === "long_research"` or a long-research
  skill, `research-state.js:457`). The live-observe report scenario ran a research-report task
  **without declaring it**, so the workspace publish path was correctly hidden and the model
  fixated on the gated action.
- **Fix:** the report scenario now passes `researchActivation: "long_research"`.
- **Verified live:** re-run produced **0** `publish-candidate-gated` events (was 5).

> **Reusable rule:** any research-report test / host integration MUST declare
> `researchActivation: "long_research"` (or activate a long-research skill) or
> `workspace_publish_candidate` stays hidden. agrun never infers it from the prompt.

## Problem 3 — suspected "runtime never converges the gated-publish loop" (FALSIFIED, repro)

- A gated publish is **not** unhandled: `action-loop-session-loop.js` routes it through
  `handleInvalidPlannerDecision` with `invalidKind "workspace_publish_candidate_gated"`;
  `plannerInvalidCount` increments and the planner-invalid signal escalates to **hard_veto by
  the 3rd repeat** (`planner-recovery.js`: `count > 2`), carrying a `requiredEnvelope` that
  steers the model to finalize.
- **Deterministic repro** (`test/unit/gated-publish-convergence.test.js`):
  `escalations = [advisory, advisory, hard_veto, hard_veto]`. The runtime is not silent — a
  stubborn model that ignores the escalation is the residual (same AI-first boundary as
  AGRUN-306/307/309).

## Problem 4 — DeepSeek-flash-high is slow + churns on the readiness contract (MODEL behaviour, not a code bug)

- **Speed:** ~21.7s/action average, 57.5s max — ~30 min for a 3000-word report (matches the TNO
  benchmark 31 min). gpt-5.4-mini high does the same in ~9.6 min.
- **Convergence:** after the mode-gate was fixed (publish reachable), DeepSeek entered the
  **candidate-quality / readiness repair churn** (5× `workspace_publish_candidate`, 37×
  `terminal-repair`, 6× `fingerprint-repeat`, never converged before kill). This is the
  AGRUN-309 family: the runtime steers (readiness contract + terminal repair), but a weak model
  does not comply. Not fixable in the runtime without crossing the AI-first boundary
  (do not fabricate a quality-broken report).
- **Production recommendation (unchanged):** use **gpt-high** for heavy research reports;
  DeepSeek-flash is suited to light tasks only. `runDeadlineMs` (AGRUN-308) bounds the
  worst-case cost.

## Artifacts

- Harness: `test/live-observe.mjs`, `test/live-helpers.mjs` (DeepSeek + payload fixes).
- Repro: `test/unit/gated-publish-convergence.test.js` (smoke-registered).
- Commits: `432a570f` (monitor fixes), `bdfd828c` (long_research + gated-publish repro).
- Live JSONL streams: `test/live-observe-out/` (gitignored run artifacts).
