# AGRUN-246-N — Phase 2 Tool-Shape Design (2026-05-25)

## Status

**DESIGN ONLY. NO RUNTIME CODE.** Gated by Phase 1 calibration
(CONDITIONAL PASS — see
[`agrun-246-n-orthogonality-lever-research-2026-05-25.md`](./agrun-246-n-orthogonality-lever-research-2026-05-25.md)).
The simulator test described below is the next gate. Phase 2
implementation is only authorized if the simulator shows the lite
model can produce 3-aspect orthogonal plans naturally when given the
new argsExample.

## Goal recap

Replace the rejected AGRUN-246-L distinct-angle signal with a
**structural forcing function**: extend `web_search` so the planner
must commit to ≥3 orthogonal queries in one action at the start of a
research phase. The runtime verifier checks pairwise Latin token
Jaccard (calibrated threshold 0.556 from Phase 1) and rejects narrow
plans with a structured diagnostic envelope. The AI owns the rewrite.

## Tool shape — `web_search` Mode A (single) + Mode B (plan)

### Schema (additive, backwards compatible)

```
web_search args (planner-facing):
  // Mode A (existing — single query, unchanged):
  query: string          // required if searchPlan absent
  limit?: number
  maxPasses?: number
  provider?: string
  searchProvider?: string
  siteHints?: string[]
  strategy?: string
  deadlineMs?: number

  // Mode B (new — upfront plan):
  searchPlan?: Array<{
    query: string,        // required when entry exists
    aspect: string        // required when entry exists, AI-authored
                          // short topical aspect label
  }>
  // minimum entries = 3 (enforced by validator)
  // maximum entries = 8 (validator caps to limit cost)
```

Validator behavior (in `web-search-action.js` preflight, no skill
change required):

- Reject if neither `query` nor `searchPlan` is provided.
- Reject if both `query` and `searchPlan` are provided.
- Reject if `searchPlan` length < 3 or > 8.
- Reject if any entry lacks `query` or `aspect`.

These are protocol errors, not orthogonality rejections. They are
caught by the standard validation envelope path.

### argsExample for the planner registry

Mode B argsExample is the strongest behavioral signal for lite-tier
models per the standing KB reflective memory (`bc940294-…:8f899626-…`,
"argsExample is the strongest behavioral signal for lite-tier
models — they literally copy the example"). The new argsExample must
demonstrate **3 visibly orthogonal aspects** in concrete queries:

```jsonc
{
  "searchPlan": [
    {
      "query": "<topic> definition fundamentals introduction",
      "aspect": "definition_fundamentals"
    },
    {
      "query": "<topic> production reliability case studies real-world",
      "aspect": "production_reliability"
    },
    {
      "query": "<topic> evaluation methodology measurement framework",
      "aspect": "evaluation_methodology"
    }
  ]
}
```

The placeholder `<topic>` must be filled with concrete topic words at
prompt-build time — argsExample must be valid-when-copied per the KB
lesson. Three aspects (`definition`, `production`, `evaluation`) are
chosen to demonstrate visible lexical orthogonality. The model is
free to pick different aspects in production; this is a shape
example, not a template constraint.

### Mode selection rule

The planner-prompt template should set Mode B as the **first**
research-phase argsExample. After the first plan is accepted, Mode A
becomes acceptable for follow-up refinements. This is implemented by
the planner prompt builder, not by a hard runtime gate, so AI may
still issue a Mode B plan later if appropriate.

## Orthogonality verifier

Runs in `executeWebSearchAction` (or a new preflight helper)
**BEFORE any search executes**.

### Algorithm

```
1. If args.searchPlan absent → skip verifier, run Mode A path.
2. Tokenize each query.query via the same `tokenize` function used by
   read-source-quality.js (mixed-script boundary split, length>=3,
   slice(0,12), no stop-word removal — the existing helper).
3. For each pair (i, j), compute Jaccard over the tokenized sets.
4. maxPairwise = max over all pairs.
5. If maxPairwise >= 0.556 (the Phase 1 calibrated threshold):
   → Return planRejected envelope with diagnostic.
6. Else → Accept plan, execute each plan entry sequentially.
```

The Jaccard threshold (`0.556`) is the Phase 1 calibrated boundary
on the `>=3 Q` subset. It is encoded as a single named constant
`SEARCH_PLAN_ORTHOGONALITY_THRESHOLD` so future tuning is one-line.

### Reject envelope shape

```jsonc
{
  "actionName": "web_search",
  "kind": "plan_rejected_orthogonality",
  "status": "rejected",
  "reason": "search_plan_orthogonality_below_threshold",
  "message": "Two queries in your searchPlan are too similar (Jaccard 0.71 >= 0.556 threshold). Revise the plan so each entry covers a different aspect of the topic.",
  "diagnostic": {
    "threshold": 0.556,
    "maxPairwise": 0.71,
    "pairs": [
      {
        "i": 0,
        "j": 1,
        "iQuery": "<query a>",
        "jQuery": "<query b>",
        "iAspect": "<aspect a>",
        "jAspect": "<aspect b>",
        "jaccard": 0.71,
        "sharedTokens": ["evaluation", "framework", "harness"]
      }
    ],
    "rejectionAttempt": 1,
    "rejectionBudgetRemaining": 1
  }
}
```

The envelope is consumed as a standard observation by the next
planner cycle. The AI sees concrete shared tokens and the threshold,
and is expected to author a revised plan.

### Retry budget

`MAX_PLAN_REJECTIONS_PER_RESEARCH_PHASE = 2` (constant in the same
file as the threshold). After 2 rejections, the third plan is
accepted with a `searchQueryDiversificationSignal=elevated` annotation
in the observation. This prevents lite-model reject loops. The
budget is tracked per research phase (reset when the AI publishes
candidate or transitions out of search phase).

The elevated signal is **observation-only** — runtime does not auto-
issue different searches. The AI sees the signal and can choose to
read existing results, expand workspace, or accept that searches
were exhausted.

## Backwards compatibility

- `news-brief-skill`, `web-search-skill`, and any host-provided skill
  that calls `web_search({ query })` continues to work unchanged
  (Mode A path).
- The planner registry's argsExample changes to Mode B for the first
  research-phase action, but `argsSchema.query` remains valid and
  the protocol accepts Mode A submissions.
- Host skills that wrap web_search via internal Mode A continue to
  work — verifier only fires on Mode B submissions.
- Unit tests against `web-search-action` must add Mode B coverage
  without removing Mode A coverage.

## Implementation scope

When Phase 2 simulator passes, the implementation slice is:

1. `src/runtime/actions/web-search-action.js` — extend `argsSchema`,
   `argsExample`, add Mode B branch in `executeWebSearchAction`,
   wire verifier preflight.
2. `src/runtime/search-plan-orthogonality.js` (new, ~80 lines) —
   pure function: `verifySearchPlanOrthogonality(searchPlan,
   { threshold, rejectionAttempt }) -> { accepted, diagnostic }`.
3. `src/runtime/research-state.js` — track `searchPlanRejectionCount`
   per research phase; reset on phase transition.
4. Planner prompt builder — switch argsExample to Mode B for first
   research-phase action.
5. Unit tests: orthogonality verifier mathematical correctness;
   reject envelope shape; retry budget; backwards compatibility
   path; existing Mode A tests untouched.
6. Skill updates (if any) — none required if skills use Mode A
   internally. Long-research skills may opt into Mode B by emitting
   `searchPlan` themselves.

Estimated diff size: ~250-350 lines added, ~10 lines touched in
existing paths.

## Out of scope for AGRUN-246-N Phase 2

- Embedding-based orthogonality (deferred — host hook design).
- AI-judge orthogonality call (rejected — runtime AI work).
- Topic-token allowlists (rejected per project rules).
- Auto-search alternate query (rejected — same anti-pattern as
  AGRUN-246-K).
- Auto-block read_url until plan diverse (rejected).
- Mode B enforcement as hard runtime gate (rejected — AI may have
  legitimate Mode A reasons after first plan).
- Cross-language tokenizer beyond existing `tokenize` (deferred —
  the current mixed-script-boundary helper covers CJK + Latin
  already per existing 246-J fixes).

## Simulator gate result (2026-05-25 — PASS 10/10)

Ran two batches of 5 trials each on `gemini-3.1-flash-lite` using
`scripts/simulate-agrun-246-n-search-plan.mjs`. Result:

| Metric | Batch 1 | Batch 2 | Combined |
|---|---|---|---|
| Mode B emission rate (≥3 entries) | 5/5 = 100% | 5/5 = 100% | 10/10 = 100% |
| Orthogonal (max pairwise Jaccard < 0.556) | 5/5 = 100% | 5/5 = 100% | 10/10 = 100% |
| Pass rate (both above) | 5/5 = 100% | 5/5 = 100% | 10/10 = 100% |

Sample queries from one trial:

```
Q1: "Harness Engineering for AI agents definition and core concepts"
A1: definition_fundamentals
Q2: "AI agent evaluation frameworks and harness design best practices"
A2: evaluation_methodology
Q3: "challenges in building robust AI agent test harnesses"
A3: technical_challenges
Q4: "industry standards for agentic workflow testing and simulation environments"
A4: industry_standards
maxPairwiseJaccard = 0.154 (well below 0.556 threshold)
```

The lite model reliably produced 3-5 aspect plans with distinct
aspect labels in every trial. Max pairwise Jaccard ranged from 0.154
to 0.400 across all 10 trials — well below the 0.556 verifier
threshold.

**Interpretation:** When the argsExample directly demonstrates the
3-aspect plan shape and the system prompt names the topic as a
shared root, the lite model copies the shape AND fills it with
visibly diverse aspects. This contradicts the pessimism inherited
from AGRUN-246-L (where retrofitted `queryAngle` labels were narrow)
and confirms the Phase 2 design hypothesis: **forcing function at
the tool surface (argsExample) is more effective than retrofit
labels on individual queries**.

**Phase 2 implementation is authorized.** Live verify gate (≥5 trace
Mandarin canonical Harness Engineering fixture) remains mandatory
before commit.

### Caveats / HBR for the simulator result

1. **Cold-start only.** The simulator uses a fresh planner prompt
   with no prior researchContext, no terminal repair, no observation
   history. AGRUN-246-L v2's production failure happened in fuller
   context. Phase 2 live verify is the only way to know if
   real-cycle context preserves the simulator's behavior.
2. **Topic specificity.** Only tested with the canonical Mandarin
   Harness Engineering goal. Other topic shapes (handle research,
   short-task lookups, multi-language goals) may behave differently.
   Backwards-compat Mode A path must remain intact.
3. **Variance bound.** 10 trials at temperature 0.7 is small. True
   pass rate could be 85-100% with high confidence; not 100%
   guaranteed. The 80% gate bar accommodates this variance.
4. **Argument-example placement.** The simulator places Mode B
   argsExample directly in the system prompt. The production planner
   prompt builder must place argsExample in the same high-attention
   position; if it gets buried, the behavior may degrade.

## Simulator gate (mandatory before any code change)

`scripts/simulate-agrun-246-n-search-plan.mjs` runs `N=5` trials on
`gemini-3.1-flash-lite` with the proposed Mode B argsExample injected
into a cold-start research planner prompt. Each trial parses the
response and computes:

- `searchPlanProvided` — did the model emit a `searchPlan` field
  at all?
- `planCount` — number of entries in the plan.
- `maxPairwiseJaccard` — orthogonality of the AI-authored plan.
- `wouldPass` — would the verifier accept this plan?

Pass criteria (must hit all three):

| Metric | Target |
|---|---|
| % trials emitting searchPlan with ≥3 entries | ≥ 80% (4/5) |
| % trials with maxPairwiseJaccard < 0.556 | ≥ 80% (4/5) |
| % trials where the verifier would accept | ≥ 80% (4/5) |

If any metric is < 80%, AGRUN-246-N is **rejected at Phase 2
simulator gate**, same way AGRUN-246-L was rejected at calibration
when offline data showed no metric separation. We do not change the
tool surface without simulator evidence.

If 80-95% but consistent, may proceed to live verify with extra
trace budget. If 100%, may proceed with standard ≥5 trace live
verify gate.

## Risks (Phase 2 specific)

1. **Lite model may ignore the Mode B argsExample** and emit Mode A
   anyway, because it's optional. If the simulator shows < 80% Mode
   B emission, the design must add explicit guidance in the system
   prompt (not just argsExample), or change Mode B to required for
   first-phase, both of which complicate backwards compatibility.
2. **Lite model may emit 3 narrow same-cluster queries** even with
   the orthogonal argsExample. The argsExample shows 3 visibly
   different aspects, but the model is not guaranteed to generalize
   the pattern.
3. **Verifier rejection diagnostic may not produce a better plan on
   retry.** AGRUN-246-L v2 had the model see the signal and still
   not pivot. The retry budget mitigates loops, but if every retry
   produces another narrow plan, the final accepted plan is no
   better than baseline.
4. **Mode A interactions during research phase.** If the AI does a
   Mode B plan, then a Mode A query, then another Mode B plan —
   does the verifier track rejection count across these? The design
   says yes (per research phase), but research phase boundaries
   need clear definition (probably: research phase begins on first
   research-aligned action and ends on first publish or terminal).

## HBR

1. The design depends on Phase 1 calibration's >=3 Q subset PASS.
   That calibration showed 5 source_fail / 2 strict_pass cleanly
   separated, but only 8 traces. Real production distribution may
   differ.
2. The Mode B argsExample uses 3-aspect plan; the verifier permits
   up to 8. If the lite model writes >3 queries (e.g. 5), the
   max-pairwise Jaccard could still pass even if 2 of the queries
   are narrow. The verifier checks max, not mean — that errs toward
   rejecting plans with one bad pair, even if the rest are diverse.
   This is intentionally strict; a less strict variant (mean
   Jaccard) may need calibration if rejection rate is too high.
3. Retry budget = 2 is chosen by guess. No data supports it. May
   need adjustment after Phase 2 live verify.
4. Mode-A backwards-compat path means `news-brief-skill` and other
   non-research callers don't benefit from the orthogonality
   pressure. The fix only helps when the AI is in research phase
   and uses Mode B. This is acceptable — non-research callers don't
   exhibit the failure mode.

## Sources / internal references

- `agrun_docs/audits/agrun-246-n-orthogonality-lever-research-2026-05-25.md`
  (Phase 1 calibration)
- `agrun_docs/audits/agrun-246-m-source-relevance-scorer-permissiveness-2026-05-25.md`
  (related fix that sharpens source-relevance baseline)
- `agrun_docs/audits/agrun-246-l-verify-rejected-2026-05-25.md`
  (AGRUN-246-L rejection precedent and Mode-A-only learnings)
- `src/runtime/actions/web-search-action.js` (existing schema)
- `scripts/calibrate-agrun-246-n-orthogonality.mjs` (Phase 1
  calibration script — corpus + thresholds reused here)
- KB reflective memory `bc940294-…:8f899626-…` (argsExample is the
  strongest behavioral signal)
- KB procedural memory `b4a36d34-…:9015b078-…` (AGRUN-246-L
  required-vs-optional lesson)
