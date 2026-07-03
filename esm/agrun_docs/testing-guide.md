# Testing Guide

How agrun's tests are structured, how to run them, and how to add a new one. Grounded in the actual harness (`test/smoke.test.js`, `package.json` scripts) as of 2026-06-14.

> Companion to [live-standard-test.md](./live-standard-test.md) (the live-standard scenario harness) and [result-schema.md](./result-schema.md) (the run result shape tests assert against).

## Quick start

```bash
npm test          # the full deterministic suite (smoke + all unit tests)
npm run check     # build + dist:check + npm test — run this before every PR
npm run build     # rebuild dist/ from src/ (single core bundle; the @agrun/* packages were removed in AGRUN-522)
```

`npm run check` is the gate for any `src/runtime/` change. It (1) rebuilds the bundle, (2) verifies the docs/dist links, and (3) runs the full deterministic suite. A green `npm run check` is the minimum bar to merge.

## Test layers

| Layer | Location | Runner | Network / API key? |
| --- | --- | --- | --- |
| **Smoke** | `test/smoke.test.js` | `npm test` | No |
| **Unit** | `test/unit/*.test.js` (~314 files) | auto-discovered by smoke | No |
| **Invariant guards** | a subset of unit tests | auto-discovered | No |
| **Live E2E** | `test/*live*.mjs`, `test/node-*.mjs` (~26 files) | `npm run test:live:*` | **Yes — real provider key** |

### Smoke + unit (deterministic, no network)

`test/smoke.test.js` is the entry point. It **auto-discovers every `test/unit/*.test.js`** and runs each in its own subprocess (`cp.execFileSync`, best isolation). You do not register a new test anywhere — dropping a file into `test/unit/` is enough.

Most unit tests run plain (`node test/unit/<file>`). A small allow-list inside `smoke.test.js` runs with `--import virtual-stubs-loader` instead — those are tests that import through the `src/` ESM path and need the loader to mock `dist/` bundle dependencies. If your test imports directly from `src/` and fails to resolve a dist dependency, add it to that list.

### Invariant guards (regrowth guards)

Several unit tests exist purely to **stop a past mistake from regrowing**. They will fail your PR if you reintroduce a forbidden pattern. Know them before you fight them:

| Guard test | Enforces |
| --- | --- |
| `english-codebase.test.js` | No visible CJK characters in source/test files. Write non-ASCII fixtures via `String.fromCharCode(...)`. |
| `no-regex-on-prompt.test.js` | No new regex-on-prompt intent classifiers in `src/runtime/` (AI-first: the runtime must not lexically classify the user prompt). |
| `planner-prompt-action-leak-inventory.test.js` | The planner prompt's action-name surface stays byte-identical to a locked baseline (catches accidental prompt drift). |
| `no-fire-and-forget-test-async.test.js` | No unawaited async at test-module load (catches silently-skipped assertions). |
| `goal-quality.test.js` | Goal-quality classification behavior is pinned. |

If one of these fails, the fix is almost always **don't do the forbidden thing**, not "edit the guard."

### Live E2E (real API key)

Live tests hit real providers and cost money/time. They read credentials from `.env.local` (see `.env.example`). The node harness is the sanctioned real-key path (the browser example does **not** auto-load `.env.local`).

```bash
npm run test:live              # test/live.test.mjs (all suites)
npm run test:live:openai       # --suite openai
npm run test:live:gemini       # --suite gemini
npm run test:live:node-3000    # the 3000-word research E2E (see GOAL.md)
npm run test:live:multiturn-standard # 5-turn simple-chat performance/quality monitor
```

Live runs are **not** part of `npm run check` and are not required for a result-schema-only or additive-telemetry change (a deterministic unit test covers those). Run them when a change touches loop behavior, planning, tool execution, or prompt content. Judge live results against the criteria in [live-standard-test.md](./live-standard-test.md), not "looks good".

For quick chatbox/runtime monitoring, use `npm run test:live:multiturn-standard`.
It runs 5 turns in one session with real provider keys, disables web tools,
disables virtual workspace, skips cross-session memory extraction through the
browser simple-chat profile, injects trusted host time, and writes redacted
payload/response JSONL plus a summary report under `test/live-observe-out/`.
It is the standard for checking multi-turn UX latency and continuity without
spending a full long-research matrix.

The monitor uses the standard low-thinking provider roster unless a CLI model
override is supplied: OpenAI `gpt-5.4-mini` through the Responses API with
`reasoningEffort: "low"`, and Gemini `gemini-3.1-flash-lite` with
`thinkingLevel: "low"`. It pins `plannerMode: "native_tools"` but disables the
native `plan` and `finalize` terminal tools plus external actions for this
profile, so the measured path is direct chat finalization through
`final_answer`, not a planning/action/finalizer loop.

General live helpers also read provider-thinking settings from `.env.local`:
`OPENAI_API_VARIANT`, `OPENAI_REASONING_EFFORT`, `GEMINI_THINKING_LEVEL`,
`GEMINI_THINKING_BUDGET`, `GEMINI_INCLUDE_THOUGHTS`, and
`DEEPSEEK_REASONING_EFFORT`. Per-test options still override env values.

## Adding a unit test

A unit test is a plain CommonJS file that exports `run` and self-invokes. It prints a `PASS` line per assertion group (the smoke runner surfaces these) and sets a non-zero exit code on failure. Pattern:

```js
"use strict";

// AGRUN-XXX — one-line statement of WHAT behavior this pins and WHY.

const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function run() {
  const url = pathToFileURL(path.resolve(__dirname, "../../src/runtime/<module>.js")).href;
  const { someExport } = await import(url);

  {
    assert.deepEqual(someExport(input), expected);
    console.log("  PASS <what this case proves>");
  }

  console.log("<module> tests passed.");
}

module.exports = { run };

run().catch((error) => {
  console.error("<module> tests failed", error);
  process.exitCode = 1;
});
```

Notes:
- Import the **source** (`src/runtime/...`), not the bundle, so the test fails on a source change before a rebuild.
- Keep fixtures ASCII (see the `english-codebase` guard).
- One file per module/behavior; the smoke runner discovers it automatically.

## Neuter-verification (required for behavior-pinning tests)

A green test only proves "the code passes the test"; it does not prove "the test would catch a regression." The project convention is to **neuter-verify**: temporarily break the code under test, confirm the test goes red, then restore byte-identically and confirm it goes green again.

```bash
cp src/runtime/<module>.js /tmp/<module>.bak
# edit the module to break the exact behavior the test pins
node test/unit/<your>.test.js          # expect exit 1 (red)
cp /tmp/<module>.bak src/runtime/<module>.js
shasum src/runtime/<module>.js /tmp/<module>.bak  # expect identical hashes
node test/unit/<your>.test.js          # expect exit 0 (green)
```

Record the neuter result in the PR/commit ("neuter-verified: neutering X reds the test; byte-identical restore; green"). This is what distinguishes a real pin from a test that silently passes regardless of the code.

## Pre-PR checklist

1. `npm run check` → exit 0 (build + dist:check + full suite green).
2. New/changed behavior has a unit test, neuter-verified.
3. If you touched `src/runtime/`, the planner-prompt snapshot stayed byte-identical (or the change is intentional and the baseline updated).
4. For loop/planning/prompt changes: a live E2E judged against [live-standard-test.md](./live-standard-test.md).
5. Commit only the files you changed; `dist/agrun.js` is gitignored, `packages/*/dist` are tracked build artifacts (rebuild and include them when your `src/` change affects the package bundle).
