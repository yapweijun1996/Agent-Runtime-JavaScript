# Live-Test Tooling Unification Design — one trace, one helper, one scorer, one output

**Status:** PROPOSAL (maintainer review, 2026-06-09). Plan-first; spawn chunked tasks after sign-off. No edits land from this doc.
**Goal:** make agrun's live-test tools easy to **debug / monitor / trace** for harness-engineering optimization, by unifying the *plumbing substrate* — NOT by collapsing the test styles.

---

## TL;DR

agrun already ships a production-grade trace SSOT — `agrun.trace.v1` (`src/runtime/live-trace.js`, `buildLiveTraceContract`) — and the browser **Inspector already renders it** (`examples/browser/src/runtime/agent-debug.ts:43`). **Every live test is blind to it.** They each reinvent an ad-hoc jsonl/metrics format, so there is no single trace viewer and no common debug surface.

The highest-leverage fix is one line of adoption: have the live tools emit `agrun.trace.v1` via the already-public `buildLiveTraceContract`. Then the Inspector you already ship becomes the universal trace viewer for **both production and tests**. Four smaller hygiene items support it.

**Do NOT merge the three test frameworks.** They serve different jobs. Unify the substrate beneath them.

---

## What exists today (verified map)

### The good SSOT already in `src/` (production + Inspector use it; tests don't)
- `src/runtime/live-trace.js` — `buildLiveTraceContract({result, events})` → canonical `agrun.trace.v1` = `{ meta, input, output, trace[], otel.spans[] }`. Redaction-safe (previews/hashes/token-metrics/OTel span tree). **Public API** (`src/index.js:120`).
- `src/runtime/runtime-event-ledger.js` + `runtime-event-classifier.js` — the event bus + visibility/phase SSOT (`subscribeEvents(cb, {visibility})`).
- `src/runtime/llm-trace.js` — redaction primitives (`safe_summary_no_secrets_no_image_bytes`).
- **Consumers today:** browser Inspector (`agent-debug.ts:43`) + `test/unit/live-trace.test.js` ONLY. **No live test calls it.**

### The test-side zoo (each reinvents)
| Layer | Files | Emits | SSOT? |
|---|---|---|---|
| Observe | `test/live-observe.mjs` + `test/live/observer.mjs` | own dual-stream `.jsonl` + `.md` + opt-in `.bodies/` | reuses observer.mjs internally; **ignores `agrun.trace.v1`** |
| Scorecard | `test/live-standard.mjs` → spawns `test/bench-one.mjs` | `progress.jsonl` + `metrics.json` + `SCORECARD.md` + `scorecard-trend.jsonl` | quality scorer IS SSOT but **buried in a test file** (see below) |
| E2E suite | `test/live.test.mjs` (52KB, 46 scenarios, procedural) | inline asserts | uses `test/live-helpers.mjs` |
| Registry engine | `test/live/` (runner + scenario-registry + assert + observer) | observer jsonl | uses `test/live/helpers.mjs` |
| Repro kit | `test/livekit/` (cases + runner + repro-*.mjs) | own dumps | uses `test/live-helpers.mjs` |
| Standalone e2e | 7× `test/node-*-live.mjs` (87KB..8KB) | per-script metrics | each **reinvents** loadEnv/chooseProvider/readProviderConfig |
| Older bench | `bench-research-3way.mjs`, `bench-gemini-rerun.mjs` | raw metrics | do **not** use SSOT scorer |

### The four concrete duplication smells (verified)
1. **No common trace.** `buildLiveTraceContract` exists, is public, the Inspector renders it — yet `grep` shows **zero** live tests import it.
2. **Two near-identical helper modules.** `test/live-helpers.mjs` (369 LOC) vs `test/live/helpers.mjs` (311 LOC). The latter is a strict superset (deepseek support, readUrl fields, **public** `resolveProviderConfig`, extracted `buildProviderRunInput`). 7 standalone scripts reinvent the env/provider/arg boilerplate (~560 LOC) because the superset isn't the shared one.
3. **Canonical quality scorer buried in a 87KB test file.** `computeNodeLiveQualitySummary` (the SSOT length/structure/source gate scorer) lives in `test/node-agrun-3000-live.mjs`, imported by `bench-one.mjs` + a unit test. A test file should not be a library.
4. **~20 scattered output dirs.** `benchmark-out`, `benchmark-out2/3/4`, `benchmark-out-tno*` (gem-confirm-1..4, lrAB-1..3, measure-0606*), `live-observe-out`, `live-standard-out`. Symptom of "no output convention." (All gitignored.)

---

## The scope guardrail (read first)

**Three test architectures are intentional, keep all three:**
- `live.test.mjs` — procedural regression suite (fast, many small scenarios).
- `test/live/` — data-driven scenario registry (scenarios as data objects).
- `test/livekit/` — deterministic repro kit (forced failures, e.g. read_url 502).

Merging these is the over-engineering trap. The user's pain is **debug/monitor/trace**, solved by common *plumbing*, not one test style. Every chunk below unifies the substrate beneath the frameworks and leaves the authoring paradigms alone.

---

## Chunk 1 (HEADLINE) — One trace contract: adopt `agrun.trace.v1`

**Why first:** it is what "easy to debug/monitor/trace" literally asks for, and the payoff is concrete — **the shipped Inspector becomes the test trace viewer for free.** Zero new infra: `buildLiveTraceContract` is public and takes exactly what the tools already hold (run result + event stream).

**Verified fidelity (the load-bearing check):** `agrun.trace.v1` carries the full *structured* fetch boundary — provider request/response summaries, finishReason, tool-choice, token metrics, redacted message previews+hashes, and the OTel span tree. It is **intentionally lossy on raw bodies** (redaction-safe design). The observer's `AGRUN_DUMP_BODIES=1` full-body dump is the ONE thing v1 won't inline → keep it as an **opt-in sidecar** the trace references, not inlines. So this is **adopt v1 for the structured trace + keep body-dump as opt-in sidecar**, NOT "extend v1 to hold raw bodies" (that would break its redaction contract).

**Work:**
1. In `test/live/observer.mjs` (the shared dual-stream observer), at `teardown()`, additionally call `buildLiveTraceContract({ result, events })` and write `<run>.trace.v1.json` next to the existing jsonl. Keep the existing jsonl during transition (no big-bang).
2. Point `test/live-observe.mjs`, `test/live-standard.mjs`/`bench-one.mjs`, and the `node-*-live.mjs` e2e scripts at the same emit (via the observer or a tiny `emitTraceV1(result, events, outPath)` helper).
3. Confirm the browser Inspector loads a `.trace.v1.json` produced by a CLI run (it already renders the shape). Document the "drop a test trace into the Inspector" flow in `agrun_docs/live-observe-harness.md`.
4. Keep `AGRUN_DUMP_BODIES` sidecar; add a pointer field in the emitted trace meta to the `.bodies/` dir when present.

**Acceptance:** one CLI live run emits a valid `agrun.trace.v1.json`; the browser Inspector renders it unmodified; `summarizeLiveTrace` over it matches the run's observed counts.

---

## Chunk 2 — One helper module (collapse the two)

**Work:** make `test/live/helpers.mjs` (the superset) canonical. Convert `test/live-helpers.mjs` to a thin **re-export** of the canonical module (avoids touching the ~9 importers in one churn). Verify `live.test.mjs`, `livekit/runner.mjs`, and the `node-*-live.mjs` scripts still resolve. Then (optional later) delete the inline `loadEnv/chooseProvider/readProviderConfig` copies from the 7 standalone scripts, importing the canonical `resolveProviderConfig`/`buildProviderRunInput` instead.

**Acceptance:** all live entry points import one helper module; `npm test` + one live smoke green; no behavior change.

---

## Chunk 3 — Lift the canonical quality scorer out of the test file

**Work:** move `computeNodeLiveQualitySummary` (+ its length-unit helpers) from `test/node-agrun-3000-live.mjs` into a shared `test/helpers/live-quality.mjs` (or, if it's genuinely product logic, a `src/` export). Update the 3 importers (`node-agrun-3000-live.mjs`, `bench-one.mjs`, `test/unit/node-live-quality.test.mjs`). A canonical scorer must not live inside one e2e script.

**Acceptance:** scorer importable without loading the 87KB e2e; unit test + scorecard run unchanged.

---

## Chunk 4 — One output convention

**Work:** standardize on `test/live-out/<tool>/<run-id>/` (e.g. `observe/`, `standard/`, `e2e/`). Migrate the active tools (`live-observe-out`, `live-standard-out`) to the convention; leave a one-line note in each old dir. Confirm `.gitignore` covers `test/live-out/`. **Verify-then-remove** the ~18 stale `benchmark-out*` dirs (they're disposable run artifacts, but confirm nothing reads them first).

**Acceptance:** new runs land under `test/live-out/`; `.gitignore` updated; stale dirs removed only after a no-reader check.

---

## Chunk 5 (DONE — verify-then-remove) — retire older benches

`bench-research-3way.mjs` + `bench-gemini-rerun.mjs` don't use the SSOT scorer and are superseded by `live-standard.mjs --only`. **"Doesn't use SSOT" ≠ "dead"** — so before removal a reference check was run: zero npm scripts, zero code/doc/task.jsonl references (only a self-comment in bench-gemini-rerun and this doc), and their only import (`importRuntimeBundle`) is shared and used elsewhere (not orphaned). Confirmed unused → both removed. `live-standard.mjs --only <model>` covers the single-model fairness rerun they provided.

---

## Sequencing & risk

1. **Chunk 1** (trace) — highest leverage, additive (writes a new file alongside existing), lowest risk. Do first, verify in Inspector.
2. **Chunk 2** (helper) — re-export shim = near-zero churn.
3. **Chunk 3** (scorer lift) — pure move + import rewire.
4. **Chunk 4** (output) — cosmetic + cleanup.
5. **Chunk 5** — verify-then-remove, optional.

Each chunk: build + `npm test` green + one live smoke; spawn as its own worktree task; main-session verify between. No `git add -A`; commit only touched files.

## What this buys

- **One trace viewer** (the shipped Inspector) for production AND every live test → debug/monitor/trace becomes a single surface.
- **One helper, one scorer** → no drift, no 7× boilerplate.
- **One output root** → trends and diffs are findable.
- Test-authoring styles untouched → no over-engineering, no regression risk to the suites.
