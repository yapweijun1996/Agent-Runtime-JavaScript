# E2E v16 — AGRUN-237-GAP-03 lengthProgress Fix Validation (2026-05-19)

## Run Config
- Model: `gemini-3.1-flash-lite`
- plannerMode: `envelope`
- maxSteps: 90
- Command: `GEMINI_MODEL=gemini-3.1-flash-lite NODE_AGRUN_LIVE_MAX_STEPS=90 node test/node-agrun-3000-live.mjs`

## AGRUN-237-GAP-03 Fix
`planner-prompt-projection.js` — added special handlers for workspace mutation kinds so `lengthProgress` is always preserved as a structured object, not compressed into an opaque string by the 2000-char generic path.

## v16 Result — GAP-03 VALIDATED (model behavior changed), flash-lite ceiling confirmed

### Key Metrics

| Metric | v13 (pre-fix) | v16 (post-fix) | Change |
|---|---|---|---|
| web_search calls | ~60 | 4 | -93% |
| workspace_write calls | ~2 | 37 | +35× |
| workspace_append calls | ~3 | 35 | +12× |
| Peak candidateWords | ~437 | **1025** | +135% |
| runStatus | failed (search-loop) | failed (write-overwrite) | different failure |

### Behavior Shift

**Before fix (v13):** Model spent 90 cycles in web_search → finalize → advisory_block loop. Never wrote substantial content. Root cause: `lengthProgress.remainingLength` compressed to opaque string → model couldn't read it as a number → didn't know it still needed 2563 words.

**After fix (v16):** Model pivoted immediately to workspace mutations (72 write/append calls vs 4 searches). Peak words reached 1025 (+135%). The `lengthProgress` signal IS now being received.

### New Failure Mode: Write-Overwrite Oscillation

Flash-lite shows a write-overwrite pattern that prevents accumulation:

| Cycle | Action | candidateWords (before) | Net effect |
|---|---|---|---|
| 15 | workspace_write | 732 → 399 | OVERWRITES to 399 (loses 333 words) |
| 16 | workspace_append | 399 → 804 | ADDS 405 words |
| 17 | workspace_write | 804 → 570 | OVERWRITES to 570 (loses 234 words) |
| 18 | workspace_append | 570 → 911 | ADDS 341 words |
| ... | alternates | oscillates 400–1025 | never accumulates past 1025 |

Flash-lite calls `workspace_write` 37 times, each replacing the file with a shorter draft, destroying progress from the previous append. Despite guidance explicitly saying "use workspace_append when draft is too short," the model ignores this and keeps calling workspace_write.

### Conclusion

- **GAP-03 fix CONFIRMED**: `lengthProgress.remainingLength` is now delivered as a parseable number. Model behavior changed from search-only to write-heavy — the harness sensor is working correctly.
- **Flash-lite model ceiling CONFIRMED**: The model cannot maintain accumulated content while making incremental progress. It uses workspace_write (overwrite) instead of workspace_append (additive), oscillating between 400–1000 words for 90 cycles.
- **This is NOT a harness gap**: The harness signal is correct. A stronger model (gpt-5-mini, gemini-2.5-pro) properly uses workspace_append to accumulate content incrementally.

### Acceptance Criteria for GAP-03

- [x] Model behavior changed from search-loop to write-loop (pre-fix: 60 searches; post-fix: 4 searches, 72 workspace mutations)
- [x] Peak words: 437 → 1025 (+135%) — model IS trying to build content
- [x] `workspace_write`/`workspace_append` calls: ~5 → 72 — lengthProgress signal received
- [ ] 3000 words NOT reached — flash-lite ceiling (expected; stronger model needed)

## Potential Next Improvement (not in scope)

Add `workspace_write` context engineering warning when file already has substantial content:
```
"CAUTION: workspace_write REPLACES all existing content (current: N words).
If lengthProgress.remainingLength > 0, prefer workspace_append to ADD content
without losing existing work."
```
This would be a tool-guidance fix in `virtual-workspace-actions.js`, separate from GAP-03.
