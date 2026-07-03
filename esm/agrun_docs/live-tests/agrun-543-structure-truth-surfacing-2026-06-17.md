# AGRUN-543 Structure-Truth Surfacing (AI-first) Live Report

Date: 2026-06-17

## Result First

The earlier AGRUN-542 "semantic structure hard terminal contract" (force a
rewrite via terminal-repair) was **reverted** — it was a hardcoded content-repair
state machine that fought AGRUN-244 ("structure is an observable signal, not a
forced-repair deficit") and, per the full trace, never even engaged (the model
never read its candidate, so structure was never observable in terminal-repair).

AGRUN-543 replaces it with a general **AI-first, mechanical truth-surfacing**
approach, validated by a 3-model real-key benchmark:

| Model | Duration | Calls | Tokens | Words | Cites | length | structure | source | Score |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: |
| **gpt-5.4-mini (low)** | 155s | 15 ✅ | 213k ✅ | 2161 | 3 | ✅ | **✅** | ✅ | **100** |
| **deepseek-v4-flash (high)** | 173s | 10 ✅ | 156k ✅ | 1640 | 3 | ✅ | **✅** | ✅ | **100** |
| gemini-3.1-flash-lite (low) ×3 | 216–287s | 32/70/41 | — | 1517–1595 | 0–3 | ✅ | ❌ | mixed | 50–75 |

Both capable models now reach **score 100 / all quality gates true / zero report
red flags**. gpt-5.4-mini's decision trace shows the mechanism working end to
end: `write → read → write → read → workspace_replace (merges the duplicate) →
finalize → read → publish`. The model SAW the duplicate via the structure echo,
then self-repaired with a content rewrite — no hardcoded runtime repair.

## Root Cause (corrected via full trace)

The publish protocol (finalize → read → review) is correct and DOES block a
bare `write → publish` (reproduced deterministically). The real gap was two-fold:

1. **Models never read their candidate.** All three spammed
   `workspace_publish_candidate` straight after writing. Each bounced on
   `missing_finalize_after_latest_write`; `ignoredCount` climbed to hard_veto;
   then `publishLoopEscapeGranted` (the AGRUN-307/309/310 anti-infinite-loop
   escape) **bypassed ALL gates including read-after-write**, terminalizing a
   candidate the model had never inspected — so the duplicate-section structure
   observation never reached the planner.
2. **Mutations don't echo structure.** `workspace_write`/`replace`/`multi_edit`
   returned length/diff stats but not the current heading structure, so even a
   model that wanted to self-check could not see its own duplicate sections
   until a separate `workspace_read`/finalize recomputed
   `quality.finalCandidateStructure`.

## The Fix (mechanical, AI-first, no content judgment)

1. **Post-mutation structure echo** — `buildWorkspaceStructureEcho(content)`
   (virtual-workspace.js), wired onto `workspace_write`/`replace`/
   `insert_after_section`/`multi_edit` outputs as `structureEcho`. A mechanical
   heading scan surfaces `duplicate_headings` / `semantic_duplicate_headings` /
   `body_after_final_section` / `duplicate_section_numbers` with samples and an
   advisory guidance line. Returns null for clean content (no noise). It NEVER
   forces a repair — the AI owns the dedup decision (AGRUN-244).
2. **Escape read-anchor** — `publishLoopEscapeGranted` no longer bypasses the
   read-after-latest-write anchor. If the candidate was never read after its
   last edit, the escape forces exactly ONE `workspace_read` first (bounded once
   per run via `publishEscapeForcedReadCount`) so the structure echo + citation
   coverage reach the model before a limited publish. Runs AFTER the host output
   guardrail (ADR-0051 stays authoritative). Bounded → no infinite loop.

Verification: focused `test/unit/workspace-structure-echo.test.js` (4 cases),
`npm run build`, `npm test` (all 228 discovered tests).

## Remaining Gaps

- **Duration SLO (90s)** still fails for the capable models (155s / 173s) — but
  provider calls (15 / 10) and tokens (213k / 156k) PASS. The wall is per-call
  reasoning latency (~10–17s/call), which the harness cannot reduce. The QUALITY
  goal (the actual AGRUN-542/543 target) is met.
- **gemini-3.1-flash-lite churn (AGRUN-544)** — surfacing the duplicate now makes
  the weakest model TRY to fix it, fail, and churn (32–70 calls; one run hit
  maxSteps). Each non-improving rewrite bumps workspaceVersion and is counted as
  "progress", so the convergence machinery never escalates. Needs a mechanical
  bound: N consecutive content rewrites that do NOT reduce the structure
  issue-code count = no-progress → feed the existing ignoredCount → hard_veto →
  publishLoopEscape path so the weak model converges to an honest limited publish
  fast. Must stay mechanical (count issue codes) and not regress AGRUN-540/541.
