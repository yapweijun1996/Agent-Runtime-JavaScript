// ADR-0029 — Cost Ledger (read-only fact layer)
//
// Records per-provider-call token usage + latency, with optional host-supplied
// pricing join. Runtime never decides whether a run is "too expensive" — it
// only records facts. AI never sees cost data (debug_only projection).
//
// SSOT for: cost observability (#11 of harness_engineering.txt typical
// components). Sibling of `metrics` (counters) and `sessionBudget` (prompt
// token budget). Not a policy engine.

const DEFAULT_PRICING_PER = 1_000_000;
const PHASE_BY_STEP_TYPE = {
  "planner-responded": "planner",
  "provider-responded": "finalize",
  "provider-requested": "other"
};

function createCostLedger() {
  return {
    entries: [],
    totals: createEmptySubTotals(),
    byPhase: {},
    byModel: {},
    pricingHits: 0,
    pricingMisses: 0,
    pricingResolver: null
  };
}

function attachPricingResolver(ledger, pricing) {
  if (!ledger || typeof ledger !== "object") return;
  ledger.pricingResolver = normalizeCostPricing(pricing);
}

function normalizeCostPricing(value) {
  if (typeof value === "function") {
    return (provider, model, callKind) => {
      try {
        return readPricingEntry(value(provider, model, callKind));
      } catch {
        return null;
      }
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const lookup = new Map();
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) continue;
    const entry = readPricingEntry(raw);
    if (entry) lookup.set(key.trim().toLowerCase(), entry);
  }
  if (lookup.size === 0) return null;
  return (provider, model) => {
    const k1 = compositeKey(provider, model);
    if (k1 && lookup.has(k1)) return lookup.get(k1);
    const k2 = compositeKey("*", model);
    if (k2 && lookup.has(k2)) return lookup.get(k2);
    return null;
  };
}

function recordCostEntry(ledger, params) {
  if (!ledger || typeof ledger !== "object") return null;
  if (!params || typeof params !== "object") return null;

  const provider = readString$1L(params.provider);
  const model = readString$1L(params.model);
  const inputTokens = readFiniteNumber$8(params.inputTokens);
  const outputTokens = readFiniteNumber$8(params.outputTokens);
  const totalTokens = readFiniteNumber$8(params.totalTokens)
    ?? sumTokens(inputTokens, outputTokens);
  const latencyMs = readFiniteNumber$8(params.latencyMs);

  if (
    inputTokens == null &&
    outputTokens == null &&
    totalTokens == null &&
    latencyMs == null
  ) {
    // Nothing measurable — skip silently.
    return null;
  }

  const cost = resolveCost(ledger, {
    provider,
    model,
    callKind: readString$1L(params.callKind) || null,
    inputTokens,
    outputTokens
  });

  if (cost) {
    ledger.pricingHits += 1;
  } else if (ledger.pricingResolver) {
    ledger.pricingMisses += 1;
  }

  const entry = {
    ts: Number.isFinite(params.ts) ? params.ts : Date.now(),
    phase: normalizePhase(params.phase),
    callKind: readString$1L(params.callKind) || null,
    provider: provider || null,
    model: model || null,
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs,
    cost
  };

  ledger.entries.push(entry);

  applyToSubTotals(ledger.totals, entry);
  applyToBucket(ledger.byPhase, entry.phase || "other", entry);
  const modelKey = compositeKey(entry.provider || "n/a", entry.model || "n/a");
  applyToBucket(ledger.byModel, modelKey, entry);

  return entry;
}

function projectCostLedger(ledger) {
  if (!ledger || typeof ledger !== "object") {
    return {
      entries: [],
      totals: createEmptySubTotals(),
      byPhase: {},
      byModel: {},
      pricingHits: 0,
      pricingMisses: 0,
      pricingConfigured: false
    };
  }
  return {
    entries: ledger.entries.map(cloneEntry),
    totals: { ...ledger.totals, cost: cloneCost(ledger.totals.cost) },
    byPhase: cloneBucket(ledger.byPhase),
    byModel: cloneBucket(ledger.byModel),
    pricingHits: ledger.pricingHits,
    pricingMisses: ledger.pricingMisses,
    // Clone-robust: result.runState may be projected from a cloneValue copy
    // where the resolver function was stripped. Hits/misses only ever move
    // while a resolver is attached, so they are equivalent evidence.
    pricingConfigured: typeof ledger.pricingResolver === "function"
      || (ledger.pricingHits || 0) > 0
      || (ledger.pricingMisses || 0) > 0
  };
}

function phaseFromStepType(stepType) {
  if (typeof stepType !== "string") return "other";
  return PHASE_BY_STEP_TYPE[stepType] || "other";
}

// ---------- internals ----------

function readPricingEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = readFiniteNumber$8(raw.input);
  const output = readFiniteNumber$8(raw.output);
  if (input == null && output == null) return null;
  const per = readPositiveNumber$2(raw.per) || DEFAULT_PRICING_PER;
  const currency = readString$1L(raw.currency) || "USD";
  return { input, output, per, currency };
}

function resolveCost(ledger, params) {
  if (typeof ledger.pricingResolver !== "function") return null;
  const pricing = ledger.pricingResolver(params.provider, params.model, params.callKind);
  if (!pricing) return null;
  const inputUsed = params.inputTokens != null && pricing.input != null
    ? (params.inputTokens / pricing.per) * pricing.input
    : null;
  const outputUsed = params.outputTokens != null && pricing.output != null
    ? (params.outputTokens / pricing.per) * pricing.output
    : null;
  if (inputUsed == null && outputUsed == null) return null;
  return {
    input: inputUsed,
    output: outputUsed,
    total: (inputUsed || 0) + (outputUsed || 0),
    currency: pricing.currency
  };
}

function createEmptySubTotals() {
  return {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    cost: null
  };
}

function applyToSubTotals(target, entry) {
  target.callCount += 1;
  target.inputTokens += entry.inputTokens || 0;
  target.outputTokens += entry.outputTokens || 0;
  target.totalTokens += entry.totalTokens || 0;
  target.latencyMs += entry.latencyMs || 0;
  if (entry.cost) {
    if (!target.cost) {
      target.cost = { input: 0, output: 0, total: 0, currency: entry.cost.currency };
    }
    target.cost.input += entry.cost.input || 0;
    target.cost.output += entry.cost.output || 0;
    target.cost.total += entry.cost.total || 0;
  }
}

function applyToBucket(bucket, key, entry) {
  if (!key) return;
  if (!bucket[key]) bucket[key] = createEmptySubTotals();
  applyToSubTotals(bucket[key], entry);
}

function normalizePhase(value) {
  if (typeof value !== "string") return "other";
  const trimmed = value.trim().toLowerCase();
  return trimmed || "other";
}

function compositeKey(provider, model) {
  const p = readString$1L(provider).toLowerCase();
  const m = readString$1L(model).toLowerCase();
  if (!p && !m) return "";
  return `${p || "n/a"}:${m || "n/a"}`;
}

function cloneEntry(entry) {
  return { ...entry, cost: cloneCost(entry.cost) };
}

function cloneCost(cost) {
  if (!cost) return null;
  return { ...cost };
}

function cloneBucket(bucket) {
  const out = {};
  for (const [key, value] of Object.entries(bucket)) {
    out[key] = { ...value, cost: cloneCost(value.cost) };
  }
  return out;
}

function sumTokens(input, output) {
  if (input == null && output == null) return null;
  return (input || 0) + (output || 0);
}

function readString$1L(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber$8(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPositiveNumber$2(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export { attachPricingResolver, createCostLedger, normalizeCostPricing, phaseFromStepType, projectCostLedger, recordCostEntry };
