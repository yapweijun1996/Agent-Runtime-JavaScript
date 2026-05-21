# Live Test — Tier A.5 (B1 + B4 + B2 + B3 prompt-level fixes)

Date: 2026-05-20 evening
Model: `gemini-3.1-flash-lite` (provider: gemini)
Scenario: `test/node-agrun-3000-live.mjs` (3000-word research target, maxSteps=90)
Parent ADR: [0033-oodae-as-single-call-structured-emission.md](../../adr/0033-oodae-as-single-call-structured-emission.md) Part 4

## Result: PARTIAL PASS — cleared 1000-word target, new bottleneck identified

| Metric | Baseline (pre Tier A) | Tier A | **B1+B4 fix (this run)** | Tier A target | Delta vs baseline |
|---|---|---|---|---|---|
| `candidateWords` | 437 | 566 (median) | **1048** | >1000 | **+140%** |
| Final file path | mixed | mixed | `final_candidate.md` only | canonical | ✅ |
| `workspace_write` share | unknown | ~78% | 4/9 = 44% | <20% | improved |
| Total file size | unknown | 426 chars (last run) | 7945 chars / 1065 words | n/a | — |
| `hard_veto_fired` count | unknown | 56-71 | 72 | <5 | regressed numerically |
| `ignoredCount` (final) | 21 | 66 (median) | 77 | <10 | regressed numerically |
| `runStatus` | failed | failed | failed (MAX_STEPS_EXCEEDED) | passed | — |

**Headline**: this is the first `gemini-3.1-flash-lite` run on the 3000-word scenario to clear the original ADR-0033 Tier A acceptance criterion of `candidateWords > 1000`. The +140% improvement vs baseline confirms the B1/B4 root cause diagnosis (Tier A's compact mode dropped load-bearing workspace guidance).

## What worked (vs Tier A)

1. **Canonical path adherence (B4 fix)** — every workspace operation targeted `final_candidate.md`. No more split between `report.md` and `final_candidate.md` like the prior run (which scored 426 despite writing 1007 total words across two files).
2. **workspace_append usage (B1 fix)** — 4 appends out of 9 mutations (44% write / 44% append / 11% replace). Tier A run was ~78% workspace_write (overwrite). The "use workspace_write only for the first write" rule is being followed.
3. **No source deficit at end** — `observableDeficits.source: null`. AI successfully ran `read_url` to satisfy source minimum.

## Remaining bottlenecks (new — beyond B1/B4 scope)

### Bottleneck X1: Structure-repair convergence lock

`activeDeficits` at run end: `["length", "structure"]`.
`structure.issueCodes`: `["duplicate_headings", "duplicate_section_numbers"]`.

When structureRepairConvergence is active, `allowedActions` shrinks to `["workspace_write", "workspace_replace", "workspace_finalize_candidate"]` — `workspace_publish_candidate` is BLOCKED.

AI's only path: workspace_write/replace to remove duplicates. But every workspace_write that flash-lite produces (capped at ~500 chars / ~70 words by mimicry — see X2 below) re-introduces a "# Definition" or similar duplicated heading because the model defaults to a section-opening template.

Net effect: AI writes content (good!) but each write creates new duplicates (bad). Structure check stays failing. Publish stays blocked. Finalize gets hard_veto'd 72 times.

**This is OUT OF SCOPE for B1/B4 prompt-level fix.** Resolving it requires either:
- Loosening `structureRepairConvergence` thresholds for lite-tier
- Allowing `workspace_publish_candidate` with structure=fail when budget is near-exhausted
- A separate ADR for "structural repair on lite models"

### Bottleneck X2: 500-char mimicry persists

Every workspace_write/append/replace `content` arg was exactly 500 characters, even though the new B1 prompt line explicitly says "the `content` field accepts text of any length; write substantial chunks (typical 200-2000+ characters per call)".

flash-lite continues to mimic the `serializePromptValue(plannerState.lastResolution, 500)` truncation marker visible in the prompt. The explicit counter-instruction is not strong enough.

**Possible runtime-level fixes (out of B1-B4 scope):**
- Change `serializePromptValue(value, 500)` to use a non-numeric ellipsis (e.g. "[truncated]") so model has nothing to mimic
- Move loopState field summarization to a non-visual abstraction
- Raise the loopState truncation to a different number (e.g. 2000) so the mimicked chunk size is closer to useful

### Bottleneck X3: Terminal repair high-water-mark too aggressive for "AI making progress"

The `TERMINAL_REPAIR_HIGH_WATER_MARK = 6` (`terminal-repair-state.js:14`) was tuned in v8/v9 data when AI was writing very little. Now that AI writes more (1048 words instead of ~400), it hits structure issues, hits structure repair convergence, can't publish, retries finalize, hard_veto fires after 6 retries.

The lock prevents the agent from ever recovering. Possible mitigation:
- Reset ignoredCount when AI takes a non-terminal action (so AI can "earn back" finalize attempts by doing real work)
- OR raise HIGH_WATER_MARK to 15+ for lite models

## Code changes shipped in this fix

File: `src/runtime/planner-prompt.js`
- New unconditional block at line ~173: workspace_write rule + read-before-write rule (when `hasAction("workspace_write")`)
- New unconditional block: canonical publish rule + structural cleanliness rule (when `hasAction("workspace_publish_candidate")`)
- The original verbose lines remain gated on `!compactSystemPrompt`

File: `src/runtime/terminal-repair-strings.js`
- `hardVetoActionNotAllowed` now accepts `activeDeficits`, `allowedActions`, `observableDeficits`
- Emits deficit-specific recovery hints (length deficit → workspace_append, source deficit → web_search/read_url, etc.)
- Only falls back to "publish limited NOW" when `budgetState === "exhausted"`
- New helper `buildTerminalRepairDeficitHint` for per-deficit messaging

Files: `src/runtime/action-loop-session-loop.js`, `src/runtime/action-loop-action.js`
- Both `hardVetoActionNotAllowed` call sites pass through `activeDeficits`, `allowedActions`, `observableDeficits` from `repair` object

## Tests

- Unit suite: 876 PASS / 0 FAIL after each fix (B1, B2, B3 combined, B4)
- Direct verification via `node --import virtual-stubs-loader`:
  - Compact prompt includes `Workspace write rule:`
  - Compact prompt includes `Canonical publish rule:`
  - Compact prompt includes read-before-write rule
  - Compact prompt length grew 7279 → 8144 chars (+865, ~12%)
  - Non-compact prompt also includes all four lines

## Artifacts

- `run2-b4.jsonl` — full event ledger
- `run2-b4.md` — debug report with workspace ledger, terminal repair state, etc.

## Status

ADR-0033 Tier A.5 (B1+B4) and Tier A.6 (B2) shipped. Tier A.7 (B3) shipped as combined prompt note but ineffective (mimicry persists). Three new bottlenecks (X1-X3) identified for future work — these are out of scope for the original B1/B2/B3/B4 root-cause diagnosis.

**Recommendation**: commit this milestone. The 1048-word result vindicates the harness audit approach (find load-bearing lines, restore them in compact mode) over the previously-proposed Tier B / Alt 5 / Reflect+Act architecture changes. Open a separate task for X1 (structure repair convergence) and X3 (terminal repair recovery) as those require runtime-level changes, not prompt-level audit.
