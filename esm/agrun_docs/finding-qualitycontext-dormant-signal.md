# Finding: `qualityContext` self-correction signal is dormant end-to-end

- **Status:** Draft for maintainer review (found via OODAE signal A/B spike, branch `spike/oodae-ablation`)
- **Severity:** Medium — a documented AI self-correction capability does not work; no crash, no data loss.
- **Date:** 2026-06-03
- **Component:** runtime final-response quality pipeline (`src/runtime/final-response-quality.js`, `planner-prompt.js`, `action-loop-session-terminals.js`)

## Summary

The final-response **quality self-correction** loop — "AI finalizes a weak answer → runtime records issue codes → AI reads them next cycle via `loopState.qualityContext` and expands/fixes" (per ADR-0019 PR1 comment) — **never reaches the in-loop AI**. It is broken in two independent places. As a result, the `qualityContext` planner-prompt instruction points at a field that is, in practice, always empty.

This means the only consumer of finalize quality issues is the **host** (via `result.diagnostics.finalResponseQuality`), not the AI itself. The AI is told (planner prompt) to read codes it can never see.

## Gap A — value never injected into the planner prompt

- `planner-prompt.js` (instruction line, ~259) tells the AI:
  *"runtime emits enum codes via `loopState.qualityContext` … read the codes and expand the answer."*
- But **no code anywhere assigns a value to `loopState.qualityContext`**. `grep -rn "qualityContext" src/` returns only the instruction string; `action-loop-planner.js` never passes `finalResponseQuality` into `buildPlannerPrompt`.
- Recorded issues (`runState.finalResponseQuality.lastIssues`) are consumed only by:
  - `action-loop-session-terminals.js` (store + `pushStep`)
  - `result.js` (~287) → `result.diagnostics.finalResponseQuality` (host-facing)

**Evidence (no API):**
```
buildPlannerPrompt({ runState:{ finalResponseQuality:{ lastIssues:["placeholder_artifact","claim_count_exceeds_source_coverage"] } }, ... })
→ output contains "placeholder_artifact": false   // codes never reach the prompt
```

## Gap B — analysis often never runs (the deeper one)

- `noteFinalResponseQualityIssues(runState, { decision })` reads `decision.answer` and **returns early before setting `runState.finalResponseQuality`** when the answer is empty:
  ```js
  const answer = readString(decision && decision.answer);
  if (!answer) return null;   // <-- short-circuits; finalResponseQuality stays undefined
  ```
- The **`finalize` envelope path** (`handlePlannerFinalizeDecision`) carries `.instruction`, **not** `.answer`; the user-facing text is synthesized downstream. So `decision.answer` is empty → analysis is skipped entirely.
- The **`final` envelope path** (`handlePlannerFinalDecision` → `handlePlannerFinal`, `action-loop-terminal.js:176`) does carry `decision.answer`, so analysis runs there — but only there.

**Evidence (live, Gemini, 2-turn):** turn1 returned `status=completed`, `outputKind=final_response`, 2933-char answer that literally contained `pending search results` (matches the `placeholder_artifact` regex) — yet `turn1.runState.finalResponseQuality === undefined`, proving the analysis never ran because the AI used the `finalize` path (empty `decision.answer`).

## Why it matters

- The quality self-correction signal is **inert for the AI** in the common `finalize` path. Any expectation that "the model will see a placeholder/coverage warning and fix it on the next turn" does not hold.
- It is also a **trust-boundary inconsistency**: the prompt asserts a runtime behavior (`qualityContext` is present) that the runtime does not provide.

## Proposed fix (two parts — both needed)

1. **Make analysis run on the real final text, not `decision.answer`.**
   Run `analyzeFinalResponseQuality` against the **synthesized final output text** (`output.text` / `terminalText.text`) at the result-construction point of *both* terminal paths (`handlePlannerFinal` and the `finalize` synthesis path), then store to `runState.finalResponseQuality`. (Or: have `noteFinalResponseQualityIssues` fall back to the synthesized text when `decision.answer` is empty.)
2. **Inject the recorded codes into the prompt.**
   In `action-loop-planner.js`, pass `runState.finalResponseQuality.lastIssues` to `buildPlannerPrompt`; in `planner-prompt.js`, set `loopState.qualityContext = { issues, noteCount }` when present. *(This half is prototyped on `spike/oodae-ablation` behind `AGRUN_SPIKE_WIRE_QUALITYCONTEXT=1` and verified at the prompt level.)*

After both, re-run the 2-turn A/B to measure whether delivering the signal actually improves self-correction.

## Reproduction (on `spike/oodae-ablation`)

- Prompt-level wiring proof (no API): `node test/spike-oodae-prompt-diff.mjs` (and the inline `WIRE=0/1` check).
- 2-turn A/B harness (currently VOID due to Gap B): `node test/spike-oodae-quality-signal-live.mjs --provider gemini --repeat 3`.
- Dormancy diagnostic: a single 2-turn session shows `runState.finalResponseQuality === undefined` despite a placeholder-containing finalize.

## Related context

- This was found while testing whether OODAE orient/evaluate read-only signals change AI behavior. Companion result: stripping the wired signals (`readAttemptSignal`, `evidenceState`) showed **no robust behavioral effect** at N=5 on single-turn research tasks — consistent with "keep runtime simple, AI is strong now". `qualityContext` is the one that is not merely inert but structurally dormant.
- The OODAE decision layer remains **AI-first** (audit: orient/evaluate classifiers are read-only SIGNALs, 0 GATEs); this finding is about a signal that never reaches the AI, not about the runtime overriding it.
