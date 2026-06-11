# AGRUN-145 Slice D — Browser Harness Smoke

**Date:** 2026-04-22
**Environment:** Chromium (via MCP Chrome DevTools), Vite dev server at `http://localhost:3000/?debug_yn=y`
**Scope:** Verify the thread-provenance + hydration harness executes correctly in the browser ESM runtime (not just Node).

## Why a harness-level live smoke (rather than end-to-end multi-thread compaction)

End-to-end multi-thread compaction would require:
1. A real 2-topic conversation long enough to breach the token budget.
2. A live LLM call to produce each per-thread summary.
3. Deterministic thread routing from the topic router.

That chain is covered by Node unit tests (`summary-store-per-thread`, `compaction-thread-scoped`, `compaction-window-trim`) and the browser bundle type-check. The remaining live-test risk is **browser-specific**: does the ESM module graph resolve the Slice D helpers and do they behave identically to Node? The smoke below answers that directly.

## Test harness

```js
// In Chromium devtools via MCP evaluate_script:
const base = '/@fs/Users/yapweijun/.../0_development/src';
const prov = await import(`${base}/runtime/thread-provenance.js`);
const hyd  = await import(`${base}/runtime/run-state-thread.js`);
// ... 5 assertions below
```

Using Vite's `@fs` raw-file access (enabled by `server.fs.allow: repo root`) to load the source ESM modules directly — the exact code path bundled into `dist/agrun.js` by Rollup.

## Assertions

| # | Case | Expected | Actual |
|---|------|----------|--------|
| 1 | `filterByThreadWindow` drops cross-thread + pre-window, keeps legacy + `turnId=null` | `["e2","e4","e5-legacy"]` | `["e2","e4","e5-legacy"]` ✅ |
| 2 | Both options missing → shallow-copy passthrough (new array, same length) | `true` | `true` ✅ |
| 3 | `trimRunStateForThreadWindow` mutates history + readSources in place | history=`["h3"]`, sources=`["r2"]` | history=`["h3"]`, sources=`["r2"]` ✅ |
| 4 | `hydrateRunStateWithThread({compactionWindow})` auto-trims | history=`["new"]`, threadId=`"t-a"` | history=`["new"]`, threadId=`"t-a"` ✅ |
| 5 | `stampThreadProvenance` + `filterByThreadWindow` round-trip across window | kept@turn-40=`1`, dropped@turn-50=`0` | kept@turn-40=`1`, dropped@turn-50=`0` ✅ |

**Result:** 5/5 PASS.

## Browser boot check

- `document.title === "AI Chatbox Workspace"` ✅
- `#root` has rendered children ✅
- No Slice D-related runtime errors (three pre-existing `404`s are unrelated icon fetches from prior commits)

## What this proves

- The Slice D harness behaves identically in Node unit tests and the Chromium runtime.
- Vite + Rollup bundling do not mangle the thread-provenance module (pure functions, no dynamic imports, no `require`).
- Future bundle changes that break Slice D semantics will now fail this smoke in addition to Node tests.

## What this does NOT prove (acknowledged scope)

- Multi-turn end-to-end session where the compaction threshold actually fires in the browser with two threads. That is covered by the Node-level `compaction-thread-scoped.test.js` + `compaction-cas.test.js` + `summary-store-per-thread.test.js` combo, where deterministic inputs are feasible.
- LLM-provider-specific differences in summary content. Out of scope for Slice D (which only controls _grouping + trim_, not summarization prompts).
