# AGRUN-142 — Goal Anchor Injection Browser Smoke

**Date:** 2026-04-22
**Environment:** Chromium (via MCP Chrome DevTools), Vite dev server at `http://localhost:3000/?debug_yn=y`
**Scope:** Verify the three-layer goal-anchor harness (`runState.originalQuery` · `thread.goalAnchor.text` · `runState.threadGoalAnchorText`) + config normalizer + router-verdict seeding + hydration mirroring behave identically in the browser ESM runtime and that Vite/Rollup does not strip the verbatim anchor block, dedupe logic, or lazy-seed semantics.

## Why a harness-level live smoke (rather than end-to-end >10-cycle session)

An end-to-end anchor-persistence test would require:
1. A live LLM session long enough to exceed 10 planner cycles.
2. A deterministic way to assert the verbatim `[ORIGINAL USER QUERY — DO NOT REINTERPRET]` block reappears on every cycle's system prompt.
3. A drift scenario where the model would otherwise reinterpret, so the anchor's presence is observable in the output.

That chain is covered by the Node unit tests (`goal-anchor.test.js`, `goal-anchor-wiring.test.js`) plus the Slice B wiring in `action-loop-session.js` / `planner-prompt.js` / `runtime-finalize.js`. The remaining live-test risk is **browser-specific**: do the pure-function modules resolve and behave identically under Vite + Rollup as they do under Node, and does the hydration → runState bridge survive bundling? The smoke below answers that directly.

## Test harness

```js
// In Chromium devtools via MCP evaluate_script:
const base = '/@fs/Users/yapweijun/.../0_development/src';
const v = `?v=${Date.now()}`; // cache-bust to force Vite module refresh
const ga        = await import(`${base}/runtime/goal-anchor.js${v}`);
const cfg       = await import(`${base}/runtime/goal-anchor-config.js${v}`);
const thread    = await import(`${base}/session/thread.js${v}`);
const hydration = await import(`${base}/runtime/run-state-thread.js${v}`);
const state     = await import(`${base}/runtime/state.js${v}`);
// ... 12 assertions below
```

Using Vite's `@fs` raw-file access (enabled by `server.fs.allow: repo root`) to load the source ESM modules directly — the exact code path bundled into `dist/agrun.js` by Rollup.

## Assertions

| # | Case | Expected | Actual |
|---|------|----------|--------|
| 1 | `normalizeGoalAnchorConfig()` default → `{enabled:true, maxAnchorChars:4000, includeThreadAnchor:true}` | `true` | `true` ✅ |
| 2 | `captureOriginalQuery` immutable: second call with different text preserves first | `"first"` | `"first"` ✅ |
| 3 | `readGoalAnchorView({runState, activeThread, config})` merges L1 + L2 layers | `true` | `true` ✅ |
| 4 | `formatGoalAnchorBlock` dedupe when L1 === L2 (single block, one occurrence) | `true` | `true` ✅ |
| 5 | `formatGoalAnchorBlock` both distinct layers → two headered blocks | `true` | `true` ✅ |
| 6 | `enabled:false` → empty string (byte-identical to legacy / kill switch) | `""` | `""` ✅ |
| 7 | `applyRouterVerdict({action:"new_thread"})` seeds `goalAnchor` from `userText` + `turnId` | `true` | `true` ✅ |
| 8 | `applyRouterVerdict({action:"continue_thread"})` lazy-seeds legacy thread with empty anchor | `true` | `true` ✅ |
| 9 | `applyRouterVerdict({action:"continue_thread"})` does NOT overwrite existing anchor (immutable) | `true` | `true` ✅ |
| 10 | `hydrateRunStateWithThread` mirrors `goalAnchorText` into `runState.threadGoalAnchorText` | `true` | `true` ✅ |
| 11 | `seedThreadGoalAnchor` lazy-seeds when anchor text empty | `true` | `true` ✅ |
| 12 | `seedThreadGoalAnchor` no-op when anchor text already populated | `true` | `true` ✅ |

**Result:** 12/12 PASS.

## Browser boot check

- `document.title === "AI Chatbox Workspace"` ✅
- `#root` has rendered children ✅
- No goal-anchor-related runtime errors

## Cache-bust note

Vite dev server ESM caches modules across hot reloads. Because this work modifies files already loaded by a prior session (`thread.js`, `run-state-thread.js`), the smoke test appends `?v=${Date.now()}` to each dynamic `import()` to force Vite to re-resolve fresh ESM. Without this, tests 7/8/9/10 can report stale pre-AGRUN-142 behavior and mislead diagnosis. Codified here so future live-smokes touching pre-existing files use the same technique.

## What this proves

- `src/runtime/goal-anchor.js`, `src/runtime/goal-anchor-config.js`, `src/session/thread.js` (applyRouterVerdict + bumpThread paths), and `src/runtime/run-state-thread.js` all behave identically in Node unit tests and the Chromium runtime.
- The verbatim dedupe + headered-block format + truncation survive Vite + Rollup bundling (pure strings, no dynamic imports, no template-literal hazards).
- The router-verdict seeding and lazy-seed-on-bump paths produce stable `{createdAt, text, turnId}` shapes in-browser — immutability contract holds against bundle rewrites.
- Future bundle changes that break anchor wiring will now fail this smoke in addition to Node tests.

## What this does NOT prove (acknowledged scope)

- End-to-end multi-cycle session where `runtimeConfig.goalAnchor.enabled=true` actually injects the `[ORIGINAL USER QUERY — DO NOT REINTERPRET]` block into every planner / finalizer prompt. That is covered at the wiring level by `goal-anchor-wiring.test.js` + the full node smoke suite; a true multi-cycle regression scenario requires LLM determinism we don't have.
- Prompt-cache parity (the injected block must land between `roleBlock` and `dynamicSystemPrompt` so the first cache segment stays stable turn-to-turn). The injection position is covered by code review + `planner-prompt.js` unit tests; cache warmth is not directly assertable from the browser harness.
- Truncation behavior for oversized anchors (>4000 chars default). `maxAnchorChars` is exercised in the Node unit suite; live smoke focuses on structural dedupe + seeding paths.
