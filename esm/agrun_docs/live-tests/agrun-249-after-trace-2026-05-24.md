# AGRUN-249 after-trace: long-form expansion + structure repair

Date: 2026-05-24

Scope: verify AGRUN-249 signal/action-surface changes against real providers. The runtime must not author report prose, choose sources, synthesize queries, or gate by model name. It may expose observable facts, action surfaces, patch previews, and protocol signals for the AI to use.

## Changes Under Test

- Terminal repair block text now uses structured `allowedActions` and observable deficit facts instead of imperative allowed-action prose.
- Length deficit is an observable workspace-recovery signal while budget remains; early limited publish is withheld for recoverable last-mile length gaps.
- `lengthExpansionSignal`, `budgetRemainingForExpansionSignal`, `multi_write_iteration_nudge`, and advisory persistence signals are visible to the planner.
- Observable structure deficits surface `workspace_propose_patch` / `workspace_apply_patch` with `normalize_headings` guidance.
- Structure + length deficits expose expansion/rewrite actions instead of patch-only loops.
- Repeated blocked structure patch previews increment terminal repair ignoredCount and can escalate.
- CJK length contracts parse prompts such as `3000 \u5b57` as `cjk_chars`.
- Node live summaries expose `userGoalSatisfied` and `qualityScore`.

## Live Results

| run | provider/model | prompt cell | result | length | structure | source | userGoalSatisfied | artifact |
|---|---|---|---|---|---|---|---|---|
| `2026-05-24T06-17-47-285Z` | Gemini `gemini-3.1-flash-lite`, thinking high | English | failed max steps | 2281/3000 words | false | true | false | `agrun_debug_runs/2026-05-24T06-17-47-285Z.md` |
| `2026-05-24T06-42-55-277Z` | Gemini `gemini-3.1-flash-lite`, thinking high | English | completed limited | 2913/3000 words | true | true | false | `agrun_debug_runs/2026-05-24T06-42-55-277Z.md` |
| `2026-05-24T07-08-36-808Z` | Gemini `gemini-3.1-flash-lite`, thinking high | English | completed ready | 3230/3000 words | true | true | true | `agrun_debug_runs/2026-05-24T07-08-36-808Z.md` |
| `2026-05-24T07-13-04-620Z` | Gemini `gemini-3.1-flash-lite`, thinking high | Mandarin | failed max steps | 322 words / 2903 CJK chars | false | true | false | `agrun_debug_runs/2026-05-24T07-13-04-620Z.md` |
| `2026-05-24T07-25-15-132Z` | Gemini `gemini-3.1-flash-lite`, thinking high | Mandarin | completed ready | 3232/3000 CJK chars | true | true | true | `agrun_debug_runs/2026-05-24T07-25-15-132Z.md` |
| `2026-05-24T07-33-58-079Z` | OpenAI `gpt-5-mini` | English capable regression | completed ready | 3162/3000 words | true | true | true | `agrun_debug_runs/2026-05-24T07-33-58-079Z.md` |

## Key HBR Iterations

1. `06-17-47-285Z` proved the structure signal was still insufficient: the run reached 2281 words and source passed, but structure remained broken and the run exhausted steps.
2. `06-42-55-277Z` proved the last-mile length gate was too permissive: 2913/3000 words, structure/source passed, but the AI was allowed to end with limited too early.
3. `07-13-04-620Z` proved Mandarin needed CJK-aware length and blocked-preview escalation: the candidate had 2903 CJK chars but only 322 Latin-token words, then repeated `workspace_propose_patch` / `normalize_headings` previews until max steps.
4. `07-25-15-132Z` passed after CJK length extraction and blocked-preview recovery fixes, but it still required 58 cycles, 17 `workspace_write` actions, and multiple patch/apply attempts.
5. `07-33-58-079Z` passed the capable model regression, but after the first ready publish the AI still performed extra finalize/read/read_url/publish protocol churn before terminal completion.

## Verification

- `node --check src/runtime/terminal-repair-state.js`
- `node --check src/runtime/terminal-final-contract.js`
- `node test/unit/terminal-final-contract.test.js`
- `node test/unit/node-live-quality.test.mjs`
- `node test/unit/terminal-repair-state.test.js`
- `npm test`
- `npm run build`
- `npm run dist:check`

## Decision

AGRUN-249 acceptance is satisfied. The fix remains harness-side: the runtime exposes facts, action surfaces, patch contracts, and quality summaries; the AI still writes every report sentence, chooses edits, and declares final readiness.

## Remaining HBR

- Weak-model efficiency is still poor on Mandarin: ready is achieved, but through many writes and patch cycles.
- OpenAI capable regression passes but still shows post-ready protocol churn.
- Source minimum passed in all passing cells, but source quality varies by provider/read_url availability.
