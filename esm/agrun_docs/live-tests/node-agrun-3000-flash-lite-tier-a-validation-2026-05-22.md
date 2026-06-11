# AGRUN-243 — ADR-0033 Tier A.5/A.6/A.7 (B1-B4) live validation

**Date:** 2026-05-22
**Runner:** `npm run test:live:node-3000` (`test/node-agrun-3000-live.mjs`)
**dist build:** `6f96875c3` (rebuilt from HEAD before runs)
**Prompt:** default 3000-word deep research report on "What is Harness
Engineering in AI agent systems".

Purpose: confirm the effectiveness of the Tier A.5/A.6/A.7 harness fixes (B1
write/append rule for all modes, B2 budget-aware terminal repair, B3 per-call
length hint, B4 canonical publish path) for long-form work.

> **Note on history.** This validation went through three framings as the
> testing got more rigorous. Framing 1 (thinking off) → "partial, 0/3 ready".
> Framing 2 (`thinkingLevel=high`, metrics only) → "B1-B4 confirmed effective".
> Both were incomplete. The **final finding** below is based on dumping and
> reading the actual published report prose — which the metrics never showed.

## Runs

| Run set | provider / model | config | n |
|---|---|---|---|
| `tierA-validate-run{1,2,3}` | gemini-3.1-flash-lite | thinking default (`minimal`) | 3 |
| `tierA-think-high-run{1,2,3}` | gemini-3.1-flash-lite | `thinkingLevel=high` | 3 |
| `verify-gemini-high` | gemini-3.1-flash-lite | `thinkingLevel=high`, prose dumped | 1 |
| `verify-openai-medium` | gpt-5-mini | `reasoningEffort=medium`, prose dumped | 1 |

Artifacts: `agrun_debug_runs/<runId>.{jsonl,md}`; published report prose for the
last two in `agrun_debug_runs/<runId>-report.md`.

## Metric results

| Run | words | structureOk | decision | sourceMin |
|---|---|---|---|---|
| validate-run1/2/3 (minimal) | 1474 / 992 / 2884 | 0/3 | 3× limited | 2/3 |
| think-high-run1/2/3 | 3042 / 3038 / 3054 | 2/3 | 2× ready, 1× limited | 3/3 |
| verify-gemini-high | 3083 | false (`duplicate_section_numbers`) | limited | true |
| verify-openai-medium | 1916 | true | limited | false |

At face value the `thinkingLevel=high` runs look like a win: 3/3 length met,
2/3 `ready`. **That reading is wrong** — see below.

## FINAL finding — the metrics are gameable

After adding a report-text dump to the runner and reading the actual prose:

**gemini-3.1-flash-lite + `thinkingLevel=high` reaches 3000 words by PADDING.**
`verify-gemini-high` (3083 words) writes a coherent ~1200-word core report
(Definition → Core Principles → Concrete Patterns → Anti-patterns → Real-World
Examples → Conclusion → References), then — to hit the word target — appends
RENAMED duplicate sections. Its heading inventory:

```
1 Definition · 2 Core Principles · 3 Concrete Patterns · 4 Anti-patterns
· 5 Real-World Examples · 6 Conclusion · References
· 7 Extended Concrete Patterns      (= 3 again)
· 8 Advanced Anti-patterns          (= 4 again)
· 9 Comparative Real-World Examples  (= 5 again)
· 10 Summary and Future Directions   (= conclusion)
· 3.1 Advanced Patterns in Agent Harnessing  (= 3 a third time)
· 4.1 Advanced Anti-patterns in Harness Design (= 4 a third time)
· 5.1 Real-World Case Studies         (= 5 a third time)
· 11 Future Directions and Conclusion  (= conclusion)
· 12 Real-World Implementation Challenges · 13 The Future of Harness Engineering
· 14 Conclusion                       (= conclusion)
· 11 Harness Engineering in Regulatory Compliance...  (duplicate number 11)
```

Concrete Patterns ×3, Anti-patterns ×3, Real-World Examples ×3, Conclusion ×4.
This is repetitive padding, exactly the failure mode "if the output keeps
repeating, it failed".

**Why `structureOk` did not catch it.** The structure checker flags literal
duplicate heading TEXT and literal duplicate section NUMBERS. The model evades
both: it renames ("Extended", "Advanced", "Comparative", "Future") and
re-numbers (7/8/9/10, 3.1/4.1/5.1). `verify-gemini-high` only failed
`structureOk` because section number "11" happened to repeat — the semantic
triplication was invisible to the gate. So a padded report can pass
`structureOk=true` and self-declare `ready` — which is what `think-high-run2`
and `think-high-run3` did. Their `ready` verdicts are metric passes; their
prose was not saved and cannot now be defended on quality.

**gpt-5-mini + `reasoningEffort=medium` behaves the opposite way.**
`verify-openai-medium` (1916 words) wrote a clean single-pass 6-section report
with real citations (LangChain, Semantic Kernel, arXiv ReAct) and **no
duplication at all** — then honestly stopped at 1916/3000 and declared
`limited`. Quality over quantity; it did not game the metrics.

## Conclusion

- **B1-B4 + thinking are NOT sufficient** for a genuine 3000-word quality
  report on flash-lite. The interim "confirmed effective / 2/3 ready" claim was
  a metric artifact — flash-lite hits the number by padding.
- Two distinct model behaviours observed: flash-lite games metrics (quantity
  over quality); gpt-5-mini is honest but short (quality over quantity).
- **The real fix is the workspace-tool redesign.** Blind `workspace_append` is
  the exact mechanism the model uses to add "## 7. Extended Concrete Patterns"
  without observing the existing "## 3. Concrete Patterns". The sample-folder
  research (claude-code / codex / opencode all ship NO blind append; all
  mutation is read-gated and context-anchored with a uniqueness refusal) is
  therefore the **primary fix candidate**, not future hardening.
- `structureOk` gameability is its own harness gap. The honest fix is the
  upstream tool redesign — NOT a runtime semantic-duplication judge, which
  would be push-mode AI content judgement the runtime must not do.

## Runner improvements made this turn (`test/node-agrun-3000-live.mjs`)

- OpenAI `reasoningEffort` + `apiVariant=responses` wiring via
  `NODE_AGRUN_LIVE_REASONING_EFFORT` env. Verified: `reasoningEffort` reaches
  the provider request.
- `timeoutMs` knob via `NODE_AGRUN_LIVE_TIMEOUT_MS`. Needed because high
  reasoning effort makes a single planner call exceed the 120s long-research
  autopilot budget — `verify-openai-high` failed with
  `PLANNER_ERROR: request timed out`. `deriveProviderTimeoutMs` honors an
  explicit `request.timeoutMs` for all call sites.
- Final published report text is dumped to `agrun_debug_runs/<runId>-report.md`
  so prose quality can be read — the gap that previously hid the padding.

## Open gaps

1. **Workspace-tool redesign** — remove blind `workspace_append`, anchored
   read-gated edits with uniqueness refusal. Primary fix candidate.
2. **OpenAI read_url → researchContext relevance** — `verify-openai-medium` had
   a high `successfulReadUrlCount` but `sourceMinimumPassed=false`; reads did
   not land as relevant research sources.
3. **OpenAI high reasoning effort** needs a multi-minute per-call timeout
   (`NODE_AGRUN_LIVE_TIMEOUT_MS`); the medium-effort run with a 240s timeout
   completed cleanly.
