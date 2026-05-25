# AGRUN-246-M — Source Relevance Scorer Permissiveness (2026-05-25)

## Status

**INVESTIGATION + DESIGN PROPOSAL.** No runtime code yet. Closes the
`task.md` deferred item 0b that was flagged after AGRUN-246-K's
6-trace distribution sampling.

## Issue

The 246-K rerun5 trace (`2026-05-25T01-57-51-053Z`) showed:

- 4 read URLs total: `wiki/Software_testing`, `wiki/Evaluation`,
  `lilianweng.github.io`, `harness.io`.
- 2 counted as "relevant" by the source-minimum gate
  (`sourceMinimum.relevantSources = 2`), so the source gate **passed**.
- But the final report's structure failed (duplicate section numbers)
  and the user-goal evaluator returned false. The 2 "relevant" sources
  were `lilianweng.github.io` (legitimate — Lilian Weng's LLM agent
  essay is exactly on topic) and **`wiki/Software_testing` (false
  positive)**. The other wiki page (`wiki/Evaluation`) was correctly
  tiered as `weak` via `query_no_overlap`.

The user goal was: "解释 AI Agent 系统中的 Harness Engineering".
`wiki/Software_testing` is a general article about software testing
that has nothing specific to do with AI agents, harness engineering,
or the user's actual topic. The scorer accepted it as `usable` based
on substring overlap alone.

## Root cause

`src/runtime/read-source-quality.js:78-80` is the final fallback path
when neither `isTopicOwnedSource` nor `read_url_service` strong-tier
applies:

```js
return overlap >= 2 && text.length >= 240
  ? createQualityDetail("usable", "overlap_usable", ...)
  : createQualityDetail("weak", "weak_overlap_or_short", ...);
```

The `overlap` is computed by `countTokenOverlap(query, haystack)`
where the haystack is the page body text and the count uses a
substring `.includes()` test for each query token:

```js
// read-source-quality.js:273
for (const token of queryTokens) {
  if (haystackText.includes(token)) count += 1;
}
```

For the rerun5 trace, the read recorded
`qualityReason: "overlap_usable"` with `overlap:2` on
`wiki/Software_testing` (`textChars: 118137`). The triggering query
was a 246-K trace search like `"test harness design for LLM
autonomous agent systems evaluation framework"`. Its tokens (after
`tokenize`) include `"test"`, `"harness"`, `"design"`, `"llm"`,
`"autonomous"`, `"agent"`, `"systems"`, `"evaluation"`,
`"framework"`. A 118KB Wikipedia article about software testing
trivially contains the substrings `"test"`, `"evaluation"`,
`"framework"`, etc., so `overlap >= 2` is reached without any of the
TOPIC-DISTINCTIVE tokens (`"harness"`, `"AI"`, `"agent"`, `"LLM"`,
`"autonomous"`) appearing in the page title or URL path.

**Root cause in one line: token-overlap with substring matching plus
no length normalization makes any long page trivially clear the
`overlap >= 2` bar.**

This is structurally similar to the topical-relevance issue AGRUN-249
addressed for source ranking, but in the per-read quality tier path.

## Why this matters beyond rerun5

The scorer is the SSOT for which read URLs feed
`sourceMinimum.relevantSources`. A permissive scorer means:

1. The source-minimum gate passes on weak evidence, so terminal
   repair allows the AI to publish a `limited` report based on
   loosely-related sources.
2. AI-side evaluation (`research-acceptance-evaluator.js`) trusts
   the runtime tier label and may stop searching for primary sources
   too early.
3. Strict-pass rate is bounded by the noise this introduces. Even a
   perfect AGRUN-246-N orthogonality lever cannot push past the
   ceiling imposed by false-positive relevance counts.

## Constraints — what the fix MUST NOT do

Per project rules (no hardcoding) and KB feedback memories:

- **Do NOT block wikipedia by domain.** Wikipedia primary topic pages
  are legitimately strong for many goals (e.g. "What is X?"). The
  problem is general subject pages getting accepted for narrow agent
  topics, not Wikipedia per se.
- **Do NOT add topic-token allowlists/denylists.** That is exactly
  the hardcode pattern that 246-L offline calibration already
  rejected.
- **Do NOT add a runtime LLM classifier call.** That makes runtime
  do AI work and increases cost on every read.
- **Do NOT change the tier semantics** (`strong / usable / weak /
  thin / blocked`). Other parts of the runtime depend on them.

## Proposed fix — distinctive-token density gate

**REVISED 2026-05-25** after auditing the existing
`test/unit/read-source-quality.test.js`. The earlier "title-anchor"
proposal would have broken the legitimate cross-language case where
the user's query is Mandarin (`harness`, `engineering` plus CJK
tokens) and the page title is in English (`Agent evaluation
overview`). In that case the title contains topically-on-target
English words (`agent`, `evaluation`) but does NOT contain the
user's distinctive query tokens — so title-anchor would have
wrongly rejected a legitimate hit. The revised lever uses
distinctive-token DENSITY in the body, not title anchoring.

One small change to `read-source-quality.js`, purely content based,
no domain knowledge, no taxonomy:

### Change — Distinctive-token density floor for `usable`

For the fallback `overlap >= 2` path, additionally require:

1. At least one DISTINCTIVE query token (from
   `extractDistinctiveTokens`) appears in the page BODY.
2. The DENSITY of distinctive body hits (matches per kB of text) is
   above a small floor.

Concretely, replace lines 78-80 with:

```js
const distinctiveTokens = extractDistinctiveTokens(query);
let distinctiveBodyHits = 0;
if (distinctiveTokens.length > 0) {
  const haystackLower = readString(text).toLowerCase();
  for (const token of distinctiveTokens) {
    if (haystackLower.includes(token)) distinctiveBodyHits += 1;
  }
}
const textKb = Math.max(1, text.length / 1000);
const distinctiveDensity = distinctiveBodyHits / textKb;
const passDistinctive =
  // legacy path: if the query produced zero distinctive tokens
  // (all generic), fall back to the original overlap-only gate
  distinctiveTokens.length === 0 ||
  // primary lever: at least one distinctive token in body AND
  // density above the floor
  (distinctiveBodyHits >= 1 && distinctiveDensity >= 0.1);

if (overlap >= 2 && text.length >= 240 && passDistinctive) {
  return createQualityDetail(
    "usable",
    "overlap_usable",
    [
      `overlap:${overlap}`,
      `text:${text.length}`,
      `distinctive:${distinctiveBodyHits}`,
      `density:${distinctiveDensity.toFixed(3)}`
    ],
    metrics
  );
}
return createQualityDetail(
  "weak",
  overlap >= 2 && text.length >= 240
    ? "overlap_low_distinctive_density"
    : "weak_overlap_or_short",
  [
    `overlap:${overlap}`,
    `text:${text.length}`,
    `distinctive:${distinctiveBodyHits}`,
    `density:${distinctiveDensity.toFixed(3)}`
  ],
  metrics
);
```

### Worked examples

For rerun5's `wiki/Software_testing` case:

- Query: `"写一篇3000字的深度研究报告，主题：人工智能代理系统中的Harness Engineering。"`
- Distinctive tokens (after `extractDistinctiveTokens`, slice(0,4)):
  `["写一篇3000字的深度研究报告", "人工智能代理系统中的", "harness",
  "engineering"]`.
- Body: 118137 chars of general software testing.
- Distinctive body hits: `"harness"` and `"engineering"` are likely
  substrings (test harness / software engineering mentioned in the
  article). CJK tokens absent. `distinctiveBodyHits = 2`.
- Density: `2 / 118.1 = 0.017` hits per kB.
- `0.017 < 0.1` → distinctive density FAIL → tier drops to `weak`
  with reason `overlap_low_distinctive_density`. ✓

For the existing test case (`https://example.org/agent-evaluation`,
title "Agent evaluation overview", body ~520 chars about harness
engineering for AI agents):

- Same query, same distinctive tokens.
- Body contains `"harness"` and `"engineering"` (literal). CJK
  absent. `distinctiveBodyHits = 2`.
- Density: `2 / 0.52 = 3.85` hits per kB.
- `3.85 >= 0.1` → distinctive density PASS → tier stays `usable`. ✓

For a topic-owned legitimate hit
(`lilianweng.github.io/posts/2023-06-23-agent/`):

- The existing `isTopicOwnedSource` path catches it BEFORE reaching
  the fallback overlap gate. Tier remains `strong`/`usable` per
  `topic_owned_*`. The density gate is bypassed. ✓

### Density threshold rationale

The `0.1` floor (1 distinctive match per 10 kB of text) is a tuning
constant, not a hardcoded topic value. Calibration data points:

| Page type | Approx body | Distinctive hits | Density |
|---|---|---|---|
| Wikipedia general topic | 100-200 kB | 1-2 | 0.005-0.02 |
| Wikipedia primary topic | 50-100 kB | 5-10 | 0.05-0.2 |
| Focused blog post | 3-15 kB | 2-5 | 0.13-1.67 |
| Test fixture / short note | 0.3-2 kB | 1-3 | 0.5-10 |

The threshold lies between the "general topic" band (median ~0.01)
and the "primary topic" band (median ~0.1). At 0.1 we mostly accept
focused blog posts and topic-primary wiki pages and mostly reject
general-topic wiki pages. The boundary is not perfect (a 30 kB
wiki primary page with 2 distinctive hits sits at density 0.067 and
would be rejected) but it errs toward FALSE NEGATIVES on borderline
cases, which is the conservative direction for source minimum.

### Strong-tier still protected

The `topic_owned_strong` path (which requires
`isTopicOwnedSource` matching title/URL/domain) is unchanged.
`read_url_service` strong tier is unchanged. Only the fallback
body-overlap `usable` path tightens.

## Verification plan

### Unit tests (offline, no LLM)

Add `test/unit/read-source-quality-permissiveness.test.js` with:

1. `wiki/Software_testing` body × 246-K query → expect `weak`,
   reason includes `overlap_no_title_anchor`.
2. `lilianweng.github.io` body × 246-K query → expect `usable` or
   `strong`, reason includes title-anchored signal.
3. A focused short blog post with 2 query tokens including a
   distinctive one in title → expect `usable`.
4. A long unrelated page (e.g. wikipedia "Evaluation") with 2 query
   tokens but zero distinctive title overlap → expect `weak`.
5. Cold-start regression: existing topic_owned and read_url_service
   strong paths still produce `strong` tier (no behavior change for
   those).

### Trace-level offline verification

Reuse the 246-K rerun5 trace. Re-classify the 4 read URLs through
the updated `classifyReadSourceTier`:

| URL | Old tier | Expected new tier |
|---|---|---|
| `lilianweng.github.io/posts/2023-06-23-agent/` | usable | usable (unchanged) |
| `harness.io` | weak | weak (unchanged) |
| `wiki/Software_testing` | usable (false positive) | **weak** |
| `wiki/Evaluation` | weak | weak (unchanged) |

After the fix, `sourceMinimum.relevantSources` would have been `1`
(lilianweng only), not `2`. The source-minimum gate (typically
requires 2 relevant) would have FAILED, terminal repair would have
required more reads, and the trace would have either kept reading
(potentially finding real sources) or honestly publish `limited`
without false-positive evidence. Either is a more honest outcome
than the false-positive PASS that rerun5 produced.

### Live verification

Single canonical Mandarin Gemini `gemini-3.1-flash-lite` rerun
against the Harness Engineering fixture. Expectation: source-minimum
gate behavior changes for traces where wikipedia general pages were
previously the marginal-pass sources. Do not promise a strict-pass
improvement — the fix removes false positives, which may make some
runs honestly fail the source gate rather than spuriously pass it.

## Risks / HBR

1. **Backwards compatibility on existing fixtures.** Some unit tests
   may rely on the current permissive `usable` behavior. Each
   `read-source-quality` test must be re-audited to confirm the new
   tier matches the test's intent. Tests that depended on the false
   positive must be updated to reflect honest classification, not
   pinned to the old behavior.
2. **Strict-pass rate may drop in the short term.** Removing false
   positives from `sourceMinimum.relevantSources` means traces that
   previously borderline-passed via wiki general pages will now
   honestly fail source gate. That is a correctness fix, not a
   regression — but it can make the production-readiness baseline
   look worse on paper.
3. **Title can be noisy.** Some pages have generic titles like
   "About us" / "Home". The title-anchor check uses TITLE plus URL
   path, so URL slug provides a secondary signal. Pages with both
   generic title AND no distinctive URL token will drop to `weak` —
   which is the correct behavior.
4. **Density floor at 0.05 hits/kB is a tuning constant.** It is
   not a hardcoded topic value, but it is a numeric threshold that
   may need recalibration if user goals change drastically (e.g.
   single-character tokens dominant in queries). Document this
   constant with rationale.
5. **246-N orthogonality lever interaction.** Closing 246-M means
   the 246-N Phase 2 live verify labels become more reliable —
   strict_pass and source_fail labels will no longer be polluted by
   wikipedia false positives. This is the main reason 246-M should
   close BEFORE 246-N Phase 2.

## Out of scope

- Domain-specific allowlists/denylists for wikipedia / forum / blog
  classes (rejected pattern).
- Per-language topic-token taxonomies (rejected pattern).
- Runtime LLM-based relevance classifier (rejected pattern).
- Changes to `isTopicOwnedSource` (already has title/URL/domain
  awareness via `extractDistinctiveTokens` against
  `domainCompact + pathCompact + titleCompact`).
- Changes to the search-ranking scorer (different code path,
  separate ticket).

## Sources

- `src/runtime/read-source-quality.js` (current implementation)
- `agrun_debug_runs/2026-05-25T01-57-51-053Z.{md,jsonl}` (rerun5 evidence)
- `agrun_docs/live-tests/agrun-246-k-distribution-sampling-2026-05-25.md`
  (HBR that flagged this as a separate ticket)
- KB feedback memory `bc940294-…:49a738b4-…` (no model-tier gating)
- KB reflective memory `bc940294-…:8f899626-…` (argsExample is
  strongest behavioral signal — relevant to: tier reason strings
  are observation-side, not action-side)
