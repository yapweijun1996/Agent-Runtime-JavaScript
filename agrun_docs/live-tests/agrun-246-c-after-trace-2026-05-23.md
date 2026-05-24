# AGRUN-246-C After-Trace: C1 Fix (terminal-repair-strings.js)

**Date**: 2026-05-23  
**Run ID**: `2026-05-23T13-42-15-279Z`  
**Fix**: Removed action-prescribing prose from `buildTerminalRepairDeficitHint` — now exposes deficit facts only (type + numbers). Commit `12ed42e2e`.  
**Baseline**: AGRUN-246-J run `2026-05-23T13-23-32-528Z`

---

## Run Comparison

| metric | before (J baseline) | after (C1 fix) | delta |
|---|---|---|---|
| candidateWords | 85 | 59 | -31% |
| successfulReadUrlCount | 3 | 1 | -67% |
| sourceMinimumPassed | true | false | ⬇ |
| runStatus | completed | completed | = |
| terminalizedBy | workspace_publish_candidate | workspace_publish_candidate | = |
| hard_veto_fired | yes (ignoredCount=7) | yes (ignoredCount=6) | ≈ |
| duration | 52.5s | 72.6s | +38% |

---

## Action Pattern Comparison

| phase | before (J) | after (C1 fix) |
|---|---|---|
| Research | web_search×2, read_url×2 | web_search×2, read_url×1 |
| First write | cycle 9 (candidateWords=85) | cycle 17 (candidateWords=59, AFTER hard_veto) |
| terminal_repair start | after first publish attempt (cycle 10) | before any write (cycle 8) |
| Publish-block loop | cycles 10-23 (terminal_repair_invalid_publish) | cycles 10-16 (finalize blocked) |

**Key behavioral difference**: In the J baseline, the model wrote 85 words then tried to publish. In the after-trace, the model tried to finalize **before writing anything** (candidateWords=0 through cycles 1-16), and only wrote the document at cycle 17 after hard_veto forced a new action.

---

## HBR (Honest Bad Result)

**The C1 fix shows regression for flash-lite.**

1. **Source-deficit guidance removal caused fewer URL reads**: Before: "Source deficit (have X of Y required authoritative sources): run web_search for an authoritative page, then read_url." After: "Source deficit (have X of Y required authoritative sources)." → Model read only 1 URL (vs. 3 in baseline). The prose "run web_search then read_url" was directly guiding URL-reading behavior.

2. **Different failure mode emerged**: Without prose guidance, the model attempted to finalize BEFORE writing a document, triggering terminal repair with candidateWords=0. In the J baseline, the model wrote first then tried to publish. Removing the prose may have inadvertently disrupted the write-first pattern.

3. **Single run caveat**: This is a single data point. Run-to-run variance for flash-lite is high. The regression may partially be model variance. However, the 67% reduction in URL reads is consistent with the prose removal specifically affecting that behavior.

---

## Analysis

The action-prescribing prose in C1.4 was compensating for flash-lite's weak planning ability. The prose "run web_search for an authoritative page, then read_url" was acting as an explicit instruction that the model followed. Without it, the model:
- Defaulted to fewer URL reads
- Tried to finalize without content (candidateWords=0)

This confirms the AGRUN-246-J HBR concern: "Without J first, fixes may break weak-model scaffolding that genuinely helps lite-tier."

**The fix is architecturally correct** (harness should not prescribe actions — that's the AI's job). However, flash-lite is too weak to self-determine the correct recovery action from structured deficit facts alone.

**Resolution**: The C1 fix (removing prose) exposes a deeper gap in C3 (terminal repair → expansion guidance). The underlying problem is that the harness's recovery signaling (structured state + allowedActions) is insufficient to guide flash-lite toward effective content expansion. Fixing C3 (guidance to take concrete repair action) is the prerequisite for C1 to work well for weak models.

---

## Status

C1 fix (`12ed42e2e`) is committed but shows regression. The fix is kept because:
1. It's architecturally correct (removes hardcode action prescription)
2. The run still completes successfully
3. The regression points to C3 as the next priority

**C3 fix is the critical path for improving flash-lite performance.**
