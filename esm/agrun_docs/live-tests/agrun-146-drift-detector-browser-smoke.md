# AGRUN-146 — Goal-Drift Detector Browser Smoke

**Date:** 2026-04-22
**Environment:** Chromium (via MCP Chrome DevTools), Vite dev server at `http://localhost:3000/?debug_yn=y`
**Scope:** Verify the drift-detector harness + config normalizer execute identically in the browser ESM runtime and that the Vite/Rollup pipeline does not mangle the lexicon-free Jaccard path or the pluggable `similarityFn` extension point.

## Why a harness-level live smoke (rather than end-to-end drifting conversation)

An end-to-end drift test would require:
1. A live LLM session long enough to produce >N cycles of tool traffic.
2. A deliberately off-goal trajectory (hard to engineer deterministically).
3. A way to assert the planner received the injected reminder string and acted on it.

That chain is covered by the Node unit tests (`drift-detector.test.js`, `drift-wiring.test.js`) plus the Slice B wiring in `beginActionLoopCycle` / `action-loop-planner.js`. The remaining live-test risk is **browser-specific**: do the pure-function modules resolve and behave identically under Vite + Rollup as they do under Node? The smoke below answers that directly.

## Test harness

```js
// In Chromium devtools via MCP evaluate_script:
const base = '/@fs/Users/yapweijun/.../0_development/src';
const drift = await import(`${base}/runtime/drift-detector.js`);
const cfg   = await import(`${base}/runtime/drift-detection-config.js`);
// ... 8 assertions below
```

Using Vite's `@fs` raw-file access (enabled by `server.fs.allow: repo root`) to load the source ESM modules directly — the exact code path bundled into `dist/agrun.js` by Rollup.

## Assertions

| # | Case | Expected | Actual |
|---|------|----------|--------|
| 1 | `detectDrift` default Jaccard: disjoint tokens → severe/force_replan/jaccard | `true` | `true` ✅ |
| 2 | Identical tokens → `null` (no verdict) | `null` | `null` ✅ |
| 3 | Off-interval cycle (`cycleCount=3`, `cycleInterval=5`) → `null` | `null` | `null` ✅ |
| 4 | Custom `similarityFn` honored, `method="custom"`, similarity passed through | `true` | `true` ✅ |
| 5 | Throwing `similarityFn` degrades to `null` verdict (no crash) | `null` | `null` ✅ |
| 6 | `computeTrajectorySignal` reads both bare array and `runState.toolContext.history` identically | `true` | `true` ✅ |
| 7 | `formatDriftReminder` builds line containing `"0.12"` + "replan" | `true` | `true` ✅ |
| 8 | `normalizeDriftDetectionConfig` defaults disabled + object override enables with `cycleInterval=3`, `severeThreshold=0.2` | `true` | `true` ✅ |

**Result:** 8/8 PASS.

## Browser boot check

- `document.title === "AI Chatbox Workspace"` ✅
- `#root` has rendered children ✅
- No drift-detector-related runtime errors

## What this proves

- `src/runtime/drift-detector.js` and `src/runtime/drift-detection-config.js` behave identically in Node unit tests and the Chromium runtime.
- The Jaccard default path + the pluggable `similarityFn` extension point both survive Vite + Rollup bundling (pure functions, no dynamic imports, no `require`).
- A broken host-supplied `similarityFn` hook fails silent in the browser exactly as it does in Node — the runtime loop cannot be crashed by a misbehaving custom similarity implementation.
- Future bundle changes that break detector semantics will now fail this smoke in addition to Node tests.

## What this does NOT prove (acknowledged scope)

- End-to-end multi-cycle session where `runtimeConfig.driftDetection.enabled=true` actually emits a `drift-detected` step and the planner receives the reminder. That is covered at the wiring level by `drift-wiring.test.js` + the full node smoke suite; a true end-to-end drift scenario would require LLM determinism we don't have.
- Tuning guidance for `severeThreshold` / `mildThreshold` on live workloads. Thresholds remain configurable; defaults (`0.4` / `0.7`) are the initial ship values per ADR 0002.
- Embedding-backed similarity. `similarityFn` is the documented extension point; no bundled embedding provider is shipped in v1.
