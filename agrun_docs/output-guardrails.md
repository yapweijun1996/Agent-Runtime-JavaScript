# Output guardrails (host-defined publish policy)

> ADR: [adr/0051-output-guardrail-host-policy.md](./adr/0051-output-guardrail-host-policy.md)

agrun's runtime is a **sensor**: it computes deterministic facts about a candidate
(structure, citations, length — see [candidate-quality-signal.md](./candidate-quality-signal.md))
and exposes them; the AI self-reviews and decides. The runtime never rewrites content
and holds no opinion about what is "good enough" to publish.

**Output guardrails** let a **host** add its own publish-acceptance policy on top, without
forking the runtime. They follow the OpenAI Agents SDK `defineOutputGuardrail` shape,
adapted to agrun's OODAE loop: a guardrail **blocks** (it does not halt or author content);
the block reason is surfaced to the AI's next cycle so the AI repairs and re-publishes.

## Division of labor

| Layer | What it checks | Where |
| --- | --- | --- |
| Runtime sensor | machine-**precise** facts: exact `duplicate_headings`, citation integrity (cited URL was actually read), word count, AI's own review | `candidate-quality-signal.js` (built-in) |
| Host guardrail | **semantic / soft** judgment: near-duplicate (re-titled) sections, padding, tone, domain rules | `runtimeConfig.outputGuardrails` (you write it) |

## API

```js
createRuntime({
  outputGuardrails: [
    {
      name: "min-sources",
      // execute({ candidate, candidateQualitySignal, finalReadiness, runState })
      //   -> { block: boolean, reason?: string, info?: any }
      execute: ({ candidateQualitySignal }) =>
        candidateQualitySignal.successfulReadUrlCount < 3
          ? { block: true, reason: "needs >= 3 read sources" }
          : { block: false }
    }
  ]
});
```

- Runs as the **last check** in `workspace_publish_candidate`, after all built-in gates pass.
  It also runs during ADR-0048 `publishLoopEscape`; the escape valve can bypass stale
  protocol/readiness repair loops, but it cannot bypass host publish policy.
- `block: true` → returns the non-terminal `virtual_workspace_publish_blocked` result; the
  `reason` reaches the AI's next planner cycle. The runtime never authors content, never
  fills `remainingGaps`, never picks the candidate.
- A guardrail that **throws** is recorded (`output-guardrail-error` step) and treated as
  **non-blocking** — a host bug cannot crash the run.
- With **no** `outputGuardrails`, behavior is exactly as before (the built-in sensors are
  the default gate).
- A blocking guardrail remains authoritative even on budget exhaustion. If the host
  verifier says "do not publish", agrun returns `output_guardrail_blocked` instead of
  calling the blocked candidate successful.

## Configuring the built-in structure severity

The built-in structure sensor's severity is also host-configurable (you do not need a
guardrail for this):

```js
createRuntime({
  candidateQuality: {
    // codes: duplicate_headings, duplicate_section_numbers,
    //        non_monotonic_section_numbers, gapped_section_numbers
    structureIssueSeverity: { non_monotonic_section_numbers: "blocking" }
  }
});
```

Defaults: `duplicate_headings` is **blocking**. Cosmetic section-numbering facts
(`duplicate_section_numbers`, `non_monotonic_section_numbers`, and
`gapped_section_numbers`) are **advisory** unless the host explicitly makes them
blocking.

## Shipped recipe: `nearDuplicateSectionsGuardrail`

A weak model often pads to a word target by **re-titling** the same section
("Core Principles" → "Core Principles (Continued)", "Concrete Patterns" → "Advanced
Concrete Patterns"). The runtime's `duplicate_headings` sensor only matches **exact**
strings, so these pass. This recipe catches them via generic, language-agnostic signals
(token-set Jaccard + subset). One-line opt-in:

```js
import { createRuntime, nearDuplicateSectionsGuardrail } from "agrun";

createRuntime({
  outputGuardrails: [ nearDuplicateSectionsGuardrail() ]
  // tunable: nearDuplicateSectionsGuardrail({ threshold: 0.6, minSubsetTokens: 2, name: "..." })
});
```

**Heuristic + limitations:** it normalizes headings (lowercase, alphanumeric, drops a
small generic stopword set) and flags a pair when token-set Jaccard ≥ `threshold` (default
`0.6`) **or** one heading's tokens are a non-trivial subset of another's. It is English-
oriented and intentionally simple — tune `threshold` or replace it. It is opt-in policy,
not a runtime default, so the runtime holds no opinion. See
`test/unit/output-guardrail-near-duplicate.test.js` for verified behavior (blocks the real
padded report, no false positive on a clean one).

## Shipped recipe: `reportQualityGuardrail` / `aiVerifierGuardrail`

`reportQualityGuardrail()` is an optional deterministic report-quality verifier for common
long-form failures found in live tests:

- placeholder section bodies such as parenthetical "principles/patterns/examples" filler;
- terminal/debug artifact leakage such as "Last updated" or "terminal repair";
- final sections that are not actually last, for example `Conclusion` followed by more
  main sections;
- section rehash padding, where a model first lists overview bullets and then repeats the
  same labels as subsections, repeats the same bold list labels inside one section, or
  starts multiple paragraphs in the same section with near-identical opener tokens;
- optional near-duplicate heading blocking through the same heading-similarity signal.

```js
import { createRuntime, aiVerifierGuardrail } from "agrun";

createRuntime({
  outputGuardrails: [
    aiVerifierGuardrail({
      checkNearDuplicateHeadings: true,
      blockNearDuplicateHeadings: true,
      // default true; set false to report section-rehash issues as advisory
      blockSectionRehash: true
    })
  ]
});
```

`aiVerifierGuardrail()` is the host adapter name for future AI verifier integration. If the
host does not provide a `verify` function, it falls back to `reportQualityGuardrail()`; if a
host verifier is provided, agrun still only asks it to validate. The verifier never writes
the report, edits sections, or invents content.

`section_rehash_overview_repeated_by_subheadings` and
`section_rehash_repeated_list_labels` and
`section_rehash_repeated_paragraph_openers` are host-side quality policy signals. They
are intended for strict report-quality modes where "3000 words" should not be satisfied
by duplicating the same outline material under slightly different local structure or
restarting nearby paragraphs with the same setup sentence. Hosts can disable the check
with `checkSectionRehash:false` or keep the issue advisory with
`blockSectionRehash:false`.

The repeated-paragraph-opener check is deliberately a guardrail recipe, not a runtime
default. It reports a compact issue sample so the next AI cycle can rewrite the affected
section; agrun still does not merge, shorten, or author paragraphs itself.
