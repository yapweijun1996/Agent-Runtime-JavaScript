# ADR-0029 — Cost Ledger as Observability, Not Governance

- **Status:** Accepted (2026-05-11)
- **Owner:** AGRUN — Harness completeness gap #11
- **Related:** ADR-0019 (final-response quality is signal, not gate), ADR-0023 (harness is a tool provider), ADR-0026 (zero residual push-mode), ADR-0027 (debug-only vs agent-projection split)
- **Audit basis:** `sample project for study logic/harness_engineering.txt` — Typical Components #11 (Cost tracker), Practical Design Principle #9 ("Treat cost and latency as first-class runtime signals")

## Context

The 12 "Typical Components" of a production harness (per `harness_engineering.txt`) audit showed agrun complete on 8, partial on 3, and **fully missing on #11 — Cost tracker**. Existing surfaces covered prompt token budget (`session-budget.js`, `token-budget.js`) and per-call usage accumulation (`runtime-events.js → metrics.usage`), but there was no:

- per-provider-call ledger entry (only running totals);
- per-phase / per-model breakdown;
- join with host-supplied pricing to surface dollar/currency cost;
- read-only projection that hosts could render in an Inspector tab.

This blocks two real workflows:

1. **Engineering** — debug "why did this run cost more than expected"; identify which phase / model consumed the bulk of tokens; spot pricing-tier mismatches.
2. **Host product** — surface per-session cost to end users / billing systems without scraping `runtime_steps` and re-deriving the math.

## Decision

Add `src/runtime/cost-ledger.js` as a **pure observability fact layer**, sibling of `metrics` and `sessionBudget`. The ledger:

- Records one entry per provider call with `{ts, phase, callKind, provider, model, inputTokens, outputTokens, totalTokens, latencyMs, cost}`.
- Pre-aggregates `totals`, `byPhase`, and `byModel` sub-totals (kept on the hot path; projection is just clone).
- Joins host-supplied pricing **only** if `costPricing` config is provided. When absent, `entry.cost` is `null` and the ledger still records tokens + latency — runtime never invents a price.
- Is exposed via:
  - `runState.costLedger` (hot, includes `pricingResolver` function reference);
  - `snapshotRunState(...).costLedger` and `createLastRunSummary(...).costLedger` — both call `projectCostLedger()` which strips the resolver and clones entries (safe for `cloneValue`, IPC, and host inspection).

## What runtime DOES NOT do

This ADR makes two explicit non-decisions, in keeping with ADR-0023:

1. **No cost gate.** Runtime never aborts, force-finalizes, or vetoes a plan because cost crossed a threshold. If hosts want a hard cap they wire it through `actionPolicy` or `onStep`. The ledger is read-only.
2. **No cost in planner prompt.** Cost data is `debug_only` (per ADR-0027). The planner system prompt / projection does not render `costLedger`. Letting AI optimize for cost is push-mode in disguise — the AI starts skipping required work to "save money". Cost discipline belongs to the host, not the model.

## Pricing contract (host-supplied, never hardcoded)

```js
createRuntime({
  costPricing: {
    "openai:gpt-4o-mini":      { input: 0.15,  output: 0.60, currency: "USD", per: 1_000_000 },
    "gemini:gemini-2.0-flash": { input: 0.075, output: 0.30, currency: "USD", per: 1_000_000 },
    "*:gpt-4o-mini":           { input: 0.15,  output: 0.60 }   // wildcard provider
  }
});
// OR functional resolver:
createRuntime({
  costPricing: (provider, model, callKind) => hostPricingService.lookup(provider, model)
});
```

Rules:

- Key shape `"<provider>:<model>"` (lower-cased, exact match) with `"*:<model>"` wildcard fallback for the provider segment.
- `per` defaults to `1_000_000` (industry-standard per-million-token pricing). Hosts wanting per-1k pricing set `per: 1000`.
- Function resolvers that throw are caught — recording continues, `pricingMisses` increments. Runtime never crashes a turn because pricing lookup failed.
- `currency` is a label only; runtime does not convert currencies. Hosts mixing currencies must normalize upstream.

## Ledger shape

```js
runState.costLedger = {
  entries: [
    {
      ts: 1715420000000,
      phase: "planner" | "finalize" | "other",
      callKind: "planner-responded",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801,
      latencyMs: 842,
      cost: null | { input: 0.000185, output: 0.000340, total: 0.000525, currency: "USD" }
    }
  ],
  totals: { callCount, inputTokens, outputTokens, totalTokens, latencyMs, cost },
  byPhase: { planner: {...subTotals}, finalize: {...} },
  byModel: { "openai:gpt-4o-mini": {...subTotals} },
  pricingHits: 0,
  pricingMisses: 0,
  pricingResolver: fn | null   // stripped in projection
};
```

## Wire-in points

| Site | Behavior |
|---|---|
| `src/runtime/cost-ledger.js` | New SSOT module. `createCostLedger`, `attachPricingResolver`, `recordCostEntry`, `projectCostLedger`, `normalizeCostPricing`, `phaseFromStepType`. |
| `src/runtime/state.js` | `createRunState()` adds `costLedger: createCostLedger()`. `snapshotRunState()` and `createLastRunSummary()` project the ledger (strips resolver). |
| `src/runtime/runtime-events.js` | `recordRuntimeMetrics()` calls `recordCostLedgerEntry()` whenever `detail.usage` is present; phase is inferred via `phaseFromStepType(stepType)`. No new step types. |
| `src/runtime/action-loop-session.js` | After `createRunState`, `attachCostPricingToRunState(runState, runtimeConfig)` binds the host-supplied resolver to the ledger once per run. |
| `src/runtime/config.js` | `normalizeCostPricingConfig(config.costPricing)` exposed on `runtimeConfig.costPricing`. |
| `src/index.js` | Public API exports `createCostLedger`, `projectCostLedger`, `normalizeCostPricing`, `recordCostEntry`, `phaseFromStepType`. |

## Phase mapping

```
planner-responded   → "planner"
provider-responded  → "finalize"   (covers runtime-finalize and direct-final provider calls)
provider-requested  → "other"
(everything else)   → "other"
```

The mapping is intentionally coarse. Hosts wanting finer-grained phases (e.g. distinguishing `runtime_finalize` vs `planner_final`) can derive that from `entry.callKind` + run state.

## Backwards compatibility

- `runState` consumers that previously read `metrics.usage` continue to work — `metrics.usage` still accumulates exactly as before.
- `runState` consumers that didn't have a `costLedger` field will not see it set; the wire-in checks `if (!ledger || typeof ledger !== "object") return` and silently no-ops. Test `runtime-events.test.js` exercises this path unchanged.
- Hosts that do not pass `costPricing` get token + latency entries with `cost: null`. No behavioral change beyond an extra read-only field on the run summary.

## Acceptance criteria

- ✅ `test/unit/cost-ledger.test.js` covers: phase mapping, no-pricing facts-only mode, dict pricing, per-1k pricing override, pricing miss, function resolver, resolver-throws safety, wildcard, empty input ignored, projection strips resolver and clones, integration with `prepareRuntimeStepDetail`, back-compat with old runState shape.
- ✅ `runtime-events.test.js` still passes (regression check — runState without `costLedger` is allowed).
- ✅ `npm run build:lib` succeeds with no new warnings.

## Alternatives rejected

1. **Bundle a hardcoded pricing table for known models.** Rejected: pricing changes monthly; agrun.js would ship stale data. Host configures or it stays unpriced.
2. **Surface cost to the planner so AI can self-limit.** Rejected: violates ADR-0023 (harness is tool provider, not decision maker). AI optimizing for cost cuts corners on requirements.
3. **Make ledger writes opt-in via config flag.** Rejected: token + latency facts cost ~microseconds to record; gating them adds config surface for no win. Pricing join is naturally opt-in via `costPricing`.
4. **Persist ledger across runs in IndexedDB for daily/monthly totals.** Rejected for v1: needs schema migration + cross-run identity decisions. Deferred to a future ADR if hosts ask.

## Consequences

- Hosts that pass `costPricing` get per-run cost surfaced in `result.lastRun.costLedger` and `result.runState.costLedger` with `pricingHits` / `pricingMisses` counters for instrumentation.
- Hosts that do not pass pricing get token + latency entries; no behavioral or perf change beyond a small per-call append (`O(1)` per provider call).
- New public API surface: five exports from `src/index.js` (`createCostLedger`, `projectCostLedger`, `normalizeCostPricing`, `recordCostEntry`, `phaseFromStepType`). These are stable contracts going forward.
- `runtimeConfig.costPricing` is a function reference; consumers cloning the config via `cloneValue` retain the reference (cloneValue passes non-plain objects through).
- AI planner prompt is unchanged. AI cannot see, optimize for, or react to cost — by design.

## Rollback

The change is purely additive and gated by host config.

1. Remove `costLedger` and `attachCostPricingToRunState` wire-in from `action-loop-session.js` (1 import, 1 call).
2. Remove `recordCostLedgerEntry` from `runtime-events.js` (1 import, 1 call site).
3. Remove `costLedger` field from `state.js` (`createRunState`, `snapshotRunState`, `createLastRunSummary`).
4. Remove `costPricing` from `config.js`.
5. Remove exports from `src/index.js` and delete `src/runtime/cost-ledger.js` + `test/unit/cost-ledger.test.js` + this ADR.

No data migration needed. Hosts that never set `costPricing` see no behavioral change either way.

## Future extensions (deliberately out of scope)

- Inspector "Cost" tab UI in `examples/browser/` — data layer is ready; UI lands separately.
- Prompt-cache pricing (Anthropic / OpenAI `cached_tokens`) — host can handle inside their resolver function for now.
- Cross-run cumulative totals (per session / per thread / daily) — would require store extension.
- Cost-aware `actionPolicy` rules — possible host-side composition; runtime stays out.
