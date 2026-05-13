# AGRUN-118 Phase 5 — `withMockedFetch` Extraction Design

Status: design / research only. No code changes yet.
Owner: AGRUN-118 (Test suite split).
Date: 2026-04-26.

## Context

Phases 2..4 of AGRUN-118 extracted three pre-fetch-mock concerns out of
`test/smoke.test.js`:

| Phase | Concern | Target file |
|-------|---------|-------------|
| 2 | skills (worldtime) | `test/concerns/skills-worldtime.test.js` |
| 3 | runtime (basic) | `test/concerns/runtime-basic.test.js` |
| 4 | skills (hooks/limits) | `test/concerns/skills-hooks-limits.test.js` |

All remaining region-map concerns (compaction, memory, session,
approval, planner, providers, web-search) live inside a single
`withMockedFetch(async () => { ... })` IIFE that wraps roughly lines
236..2549 of `main()`. They share a `mockState` counter (today: one
field, future-extensible) and the same global `fetch` replacement.
Extracting them into `test/concerns/<name>.test.js` files first
requires lifting the fetch-mock infrastructure into a reusable helper.

## Inventory

### `mockState` shape (today)

| Field | Semantic | Read sites | Write sites |
|-------|----------|-----------|------------|
| `geminiProxyApprovalPlannerCalls` | counts how many times the Gemini proxy approval planner has been hit (drives action→final transition in mock) | line 5480 (`> 1` branch) | line 5479 (increment) |

Zero reads outside the IIFE. The field is purely an internal state
machine for the Gemini approval-flow mock; no test assertion observes
it after `withMockedFetch` returns.

### Co-extraction set

These four helpers are defined later in `test/smoke.test.js` but are
referenced ONLY from within the body of `withMockedFetch`:

| Function | Lines | Use sites in IIFE |
|----------|-------|--------------------|
| `assertGeminiProxyRequestIsServerAuthenticated` | 5408..5416 | 2567, 2572, 2577 |
| `createGeminiGroundingMockResponse` | 5418..5466 | 2579 |
| `createGeminiProxyGenerateResponse` (takes `mockState`) | 5468..5513 | 2568 |
| `createMockGeminiSseResponse` | 5515..5542 | 2573 |

They MUST move with `withMockedFetch` to avoid forward-reference
artefacts. None of them is referenced anywhere else, so no parallel
import path needs to be preserved.

### Untouched neighbours

`withReadUrlMockedFetch` (5558), `withReadUrlServiceMockedFetch`
(5735), and `withChallengedReadUrlMockedFetch` (5834) each stash and
restore `global.fetch` on their own and do NOT read `mockState`. They
are nested inside `withMockedFetch` at the call sites in `main()` but
they are functionally independent. Phase 5 leaves them in place; a
follow-up phase can extract them if needed.

### Already-extracted helpers (referenced via `require`)

- `mock-response`: `createMockResponse`, `createMockTextResponse`,
  `createMockDataUrlResponse`, `normalizeMockFetchUrl`.
- `request-classifiers`: `isPlannerRequest`,
  `isSemanticTurnJudgeRequest`, `isSemanticRecallJudgeRequest`,
  `isSemanticMemoryJudgeRequest`, `isPlannerRepairJudgeRequest`,
  `isCompactionRequest`, `isGeminiPlannerRequest`,
  `isGeminiSemanticJudgeRequest`.
- `message-utils`: `normalizeOpenAIMessages`,
  `normalizeOpenAIMessageContent`, `readSessionContextMessage`,
  `readSessionContentText`.
- `judge-builders`: `buildSemanticTurnJudgeResponse`,
  `buildSemanticRecallJudgeResponse`,
  `buildSemanticMemoryJudgeResponse`,
  `buildPlannerRepairJudgeResponse`.
- `planner-assertions`: `assertPlannerSystemPrompt`,
  `assertPlannerPrompt`, `readPlannerLoopState`,
  `readLastNonEmptyLine`, `assertSourcesSection`.

`mocked-fetch.js` will re-import these from the same `test/helpers/*`
modules — no fork, no duplication.

## Proposed module shape

`test/helpers/mocked-fetch.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const { createMockResponse, createMockTextResponse, createMockDataUrlResponse, normalizeMockFetchUrl } = require("./mock-response");
const { isPlannerRequest, isSemanticTurnJudgeRequest, /* … */ } = require("./request-classifiers");
const { normalizeOpenAIMessages, /* … */ } = require("./message-utils");
const { buildSemanticTurnJudgeResponse, /* … */ } = require("./judge-builders");
const { assertPlannerSystemPrompt, /* … */ } = require("./planner-assertions");

async function withMockedFetch(run) {
  const originalFetch = global.fetch;
  const mockState = { geminiProxyApprovalPlannerCalls: 0 };
  global.fetch = async (url, options) => { /* …routing… */ };
  try {
    await run(mockState);
  } finally {
    global.fetch = originalFetch;
  }
}

function assertGeminiProxyRequestIsServerAuthenticated(options, body) { /* … */ }
function createGeminiGroundingMockResponse() { /* … */ }
function createGeminiProxyGenerateResponse(body, mockState) { /* … */ }
function createMockGeminiSseResponse(text) { /* … */ }

module.exports = { withMockedFetch };
```

### Signature decision: callback receives `mockState`

```js
await withMockedFetch(async (mockState) => { /* tests */ });
```

vs. the simpler `await withMockedFetch(async () => { ... })`.

Today, no in-tree assertion reads `mockState` post-IIFE. We still
recommend exposing `mockState` to the callback for two reasons:

1. **Future concern splits will need it.** Once memory / planner /
   compaction concerns move into their own `test/concerns/*.test.js`
   files, each will pass its callback to `withMockedFetch`. Some will
   want to assert "the planner was called N times" or "compaction
   was triggered K times" — exposing the state object now keeps the
   helper signature stable.
2. **Symmetry with `withMockedDate(iso, run)` and the various
   `withReadUrl*MockedFetch(run)` helpers** — all already pass run
   their captured context; mock-fetch should not be the odd one out.

The cost is a one-line callsite change: the existing
`async () => {` opener becomes `async (_mockState) => {` (or
`async (mockState) => {`). Until any concern actually inspects it
the parameter stays unused — `_mockState` underscores that.

## Risks and mitigations

| Risk | Surface | Mitigation |
|------|---------|------------|
| `global.fetch` not restored on test failure | nesting + sibling tests after the IIFE | Keep `try…finally` exactly as today; helper-level test calls `withMockedFetch` with a thrown error and asserts `global.fetch === originalFetch` after. |
| Nested `withReadUrl*MockedFetch` breaks because outer `global.fetch` is now a different reference | inside extracted body | Each Read URL wrapper independently snapshots and restores `global.fetch`; nesting still works. Smoke test post-extraction is the proof. |
| Unexpected `mockState` mutation across consecutive `withMockedFetch` calls | multiple callers in same Node process | `mockState` is a fresh `{}` literal per call; no module-level cache. No mitigation needed beyond keeping that pattern. |
| Co-extracted `createGemini*` helpers diverge from their inline twins | rename / future drift | Hard delete from `smoke.test.js` after move (no `// kept for compatibility` shim). |
| `assert` import path drift | `node:assert/strict` vs. `node:assert` | Helper imports `node:assert/strict` directly — same module identity as `smoke.test.js`. |

## PR shape and order

Recommended single PR:

1. Create `test/helpers/mocked-fetch.js` with the four bodies cut from
   smoke.test.js verbatim (no logic edits).
2. Update `test/smoke.test.js`:
   - Add `const { withMockedFetch } = require("./helpers/mocked-fetch");`.
   - Remove the local `async function withMockedFetch(run)` (line 2556).
   - Remove the four co-extracted `assert*` / `create*` helpers (lines
     5408..5542).
   - Change the IIFE callsite from `withMockedFetch(async () => {` to
     `withMockedFetch(async (_mockState) => {` and propagate
     `mockState` through internal `assertGemini*` / `createGemini*`
     calls (the only mockState consumer is
     `createGeminiProxyGenerateResponse(body, mockState)` — the closure
     used to capture this from the outer scope; now it gets it via the
     parameter).
3. Update region map header in `smoke.test.js` to mark "withMockedFetch
   lifted" and add a row to the future-split priority block listing
   the next IIFE-internal concern (recommended: `compaction`, ~55
   lines; smallest IIFE-internal block).
4. Run `npm test`. Diff should be: `+ test/helpers/mocked-fetch.js`,
   `- ~3000 lines from smoke.test.js`, with no behavioural change.

After this lands, each subsequent IIFE-internal concern can be
extracted in its own PR following the phase 2..4 template:

1. Create `test/concerns/<name>.test.js`.
2. Wrap body in `withMockedFetch(async (mockState) => { ... })` from
   the new helper, plus its own dist imports.
3. Replace the original block in `main()` with a pointer comment.
4. Add `require("./concerns/<name>.test")` to `smoke.test.js`.

## Out of scope for phase 5

- Splitting any IIFE-internal concern.
- Extracting `withReadUrl*MockedFetch` helpers.
- Touching the `mock-response` / `request-classifiers` / etc. helper
  modules.
- Adding unit-level coverage for `mocked-fetch.js` itself (the smoke
  suite is the regression test for this PR).
