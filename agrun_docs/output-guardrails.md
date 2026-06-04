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
- `block: true` → returns the non-terminal `virtual_workspace_publish_blocked` result; the
  `reason` reaches the AI's next planner cycle. The runtime never authors content, never
  fills `remainingGaps`, never picks the candidate.
- A guardrail that **throws** is recorded (`output-guardrail-error` step) and treated as
  **non-blocking** — a host bug cannot crash the run.
- With **no** `outputGuardrails`, behavior is exactly as before (the built-in sensors are
  the default gate).
- Guardrails respect the [ADR-0048](./adr/0048-publish-loop-escape-valve.md) escape valve: on
  budget exhaustion the run still delivers the artifact rather than loop forever.

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

Defaults: `duplicate_headings` / `duplicate_section_numbers` are **blocking**;
the cosmetic `non_monotonic_section_numbers` / `gapped_section_numbers` are **advisory**.

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
