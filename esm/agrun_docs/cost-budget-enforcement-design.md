# Cost Budget Enforcement (`maxCostUsd`) — Design

**Status:** DONE (implemented 2026-06-10). Single implementation chunk. Implementation note: verification exposed a latent usage double-normalization — `prepareRuntimeStepDetail` re-sanitizes step details whose `usage` was already snapshotted by `createUsageDetail`, and `createUsageSnapshot` (src/session/token-budget.js) had a camelCase alias for `totalTokens` but not for input/output/model, so every planner/finalize cost-ledger entry lost its input/output token splits and `totals.cost` (USD) could never populate. Fixed by completing the alias symmetry in `createUsageSnapshot` (raw provider keys keep priority), which this feature depends on.
**Gap:** GAP 5 of the general-runtime capability audit (see KB direction review 2026-06-10). agrun production runs in client browsers on the **user's API keys** — money is the user-facing resource, yet the runtime has a time bound (`runDeadlineMs`), a step bound (`maxSteps`), and a cost **recorder** (`cost-ledger.js`), but **no cost bound**. `grep maxCostUsd src/` is empty.

## Design constraints (standing decisions this must respect)

1. **cost-ledger.js stays a pure recorder.** Its header is explicit: "Runtime never decides whether a run is 'too expensive' — it only records facts... Not a policy engine." Enforcement therefore lives at the **loop boundary**, driven by **host config** — the runtime enforces a host-declared resource bound (same class as `maxSteps`/`runDeadlineMs`), it does not invent a cost opinion. No changes to cost-ledger.js.
2. **AI never sees cost data** (debug_only projection, same header). The cap is a pure hard-stop like `runDeadlineMs` — no prompt exposure, no dollar amounts to the model. (A coarse "resource pressure" prompt signal is a possible FUTURE extension; it would require revisiting that standing decision — out of scope here.)
3. **AI-first check:** a host-configured resource ceiling is generic mechanism (loop bound), not a domain judgment. Same legitimacy class as `runDeadlineMs`. Not hardcode.

## The mirror: `runDeadlineMs` (all anchors verified)

| Piece | runDeadlineMs (existing) | maxCostUsd (new, mirror) |
|---|---|---|
| Config normalize | `config.js:143` `normalizeRunDeadlineMs` (throw at `:546` on invalid) | `maxCostUsd`: positive finite number; throw on invalid. **Extra rule:** if `maxCostUsd` is set but `costPricing` is absent/empty, **throw at createRuntime** — without pricing the ledger's `totals.cost` stays null and the cap could never fire; failing loud beats a silent no-op. |
| Error code | `errors.js:19` `RUN_DEADLINE_EXCEEDED` | add `COST_BUDGET_EXCEEDED` to `ERROR_CODES` |
| Loop entry read | `action-loop-session-loop.js:68-71` | read `maxCostUsd` from `session.runtimeConfig` next to it |
| Cycle-boundary check | `:94` `if (runDeadlineAtMs && session.runState.cycleCount > 0 && Date.now() >= runDeadlineAtMs) return finalizeRunDeadlineExceeded(...)` | immediately after it: read `session.runState.costLedger?.totals?.cost?.total`; if it's a finite number `>= maxCostUsd` (and `cycleCount > 0`) → push a `cost-budget-exceeded` step (detail: `{ maxCostUsd, spentUsd, currency }`) and return `finalizeCostBudgetExceeded(session, maxCostUsd)` mirroring `finalizeRunDeadlineExceeded` (~`:663-682`, `finalizeActionLoopFailure` with the new code, result carries `runState.costLedger` like the deadline path) |
| Failure message | `action-loop-utils.js:90` | add mapping: `"Action loop exceeded the configured maxCostUsd budget without reaching a terminal output."` |
| Warning signal | (none for deadline) | one-time `cost-budget-warning` step when `spent >= 0.8 * maxCostUsd` (local `let costBudgetWarned = false` in the loop function — no state.js change). Debug visibility; hosts/Inspector surface it; NOT in the prompt. |

Notes:
- `totals.cost` shape is `{ input, output, total, currency }` (cost-ledger.js:201-203), populated by `recordCostEntry` via `runtime-events.js:91` whenever host pricing is configured. Currency defaults "USD"; the cap assumes host pricing is per-USD (document in config jsdoc).
- The `cycleCount > 0` guard mirrors the deadline's reason: at least one full cycle always runs; a boundary check cannot interrupt an in-flight provider call.

## Out of scope

- Prompt exposure of cost/budget (standing AI-invisibility decision).
- Per-phase or per-provider sub-budgets (no demonstrated need; Simplicity First).
- cost-ledger.js changes of any kind.

## Acceptance

1. `npm run build && npm test` green.
2. New unit test `test/unit/cost-budget.test.js` (use the existing runDeadlineMs unit test as the template if one exists — grep `RUN_DEADLINE` under test/): (a) runtime with `costPricing` + tiny `maxCostUsd` + mocked provider usage → run ends with structured `COST_BUDGET_EXCEEDED`, result carries `runState.costLedger`, a `cost-budget-exceeded` step exists; (b) `cost-budget-warning` fires once (not每cycle) when crossing 80%; (c) `createRuntime({ maxCostUsd: 1 })` without `costPricing` throws; (d) invalid `maxCostUsd` (0, negative, NaN) throws; (e) no cap configured → behavior unchanged (no new steps).
3. `grep -n maxCostUsd` shows config normalize + loop check + utils message + errors entry, nothing else.
4. Docs: one paragraph in `agrun_docs/public-runtime-api.md` next to wherever `runDeadlineMs` is documented.
