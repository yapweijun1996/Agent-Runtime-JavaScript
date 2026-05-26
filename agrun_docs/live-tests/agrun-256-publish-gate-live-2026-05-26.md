# AGRUN-256 — workspace_publish_candidate Mode Gate Live E2E

Date: 2026-05-26
Provider: Gemini 3.1 Flash-Lite (thinking=low)
Runner: `test/node-agrun-publish-gate-live.mjs`

## Globe3 reproducer (BEFORE — from 2026-05-26 email)

Prompt: "What is our current stock level for the most popular items?"

| Job ID | Duration | stepCount | finalAnswerSource | tokens | final_answer |
|---|---|---|---|---|---|
| a7cabafe-3355 | 72s | 731 | workspace_publish_candidate | 0/0 | "I could not access..." (fabricated) |
| 9c823103-a3f3 | 61s | 646 | workspace_publish_candidate | 0/0 | "Failed tool: globe3-inventory..." (fabricated) |
| fa539267-bcf2 | 73s | 700 | workspace_publish_candidate | 0/0 | "Failed tool: stock_inquiry..." (fabricated) |
| fc175fcd-d85b | 90s | 792 | workspace_publish_candidate | 0/0 | "system tool access restriction..." (fabricated) |
| (2 more) | similar | similar | similar | similar | similar |

Signature on every broken run:
- `runState.terminalRepairState.active === false` (NOT a terminal repair trip)
- `runState.terminalRepairState.activeDeficits === []`
- `runState.failedTools === []` OR tool succeeded earlier
- `runState.usedRuntimeFinalize === false`
- tokens in/out = 0 (audit blind spot)

Globe3 host workaround verified working: `disabledActions: [...existing, 'workspace_publish_candidate']` plus a paired planner directive teaching `finalize` as the alternative terminal action.

## AGRUN-256 gate (AFTER — verified 2026-05-26)

Prompt (parity with Globe3, slightly shorter for live runner): "I need the current stock level for our most popular items. Use the bundled ERP tool to read inventory and respond with a short summary. Keep the answer concise — no draft documents, no research report."

Setup:
- Provider: Gemini Flash-Lite via `.env.local` (`NODE_AGRUN_LIVE_PROVIDER=gemini NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite NODE_AGRUN_GEMINI_THINKING_LEVEL=low`).
- `disabledActions: ['read_url','web_search','todo_plan','todo_advance','todo_cancel','todo_run_next','todo_inspect']` (parity with Globe3 production minus the manual `workspace_publish_candidate` entry — the gate replaces it).
- `agentSkills: [erpAgentSkill]` (override default bundled list so no `deep-research-writer` is reachable).
- NO `publishCandidateGate` opt-out flag — gate defaults to enabled.

Result:

```json
{
  "durationMs": 6793,
  "cycleCount": 4,
  "finalAnswerSource": "planner_finalize",
  "terminalizedBy": "planner_finalize",
  "usedRuntimeFinalize": true,
  "actionNames": ["list_agent_skills", "use_agent_skill", "execute_skill_tool"],
  "publishGateStep": false,
  "plannerRepairStep": false,
  "plannerInvalidStep": false,
  "finalText": "The current stock levels for our most popular items as of May 26, 2026, are as follows:\n\n*   **Cash Customer Pack (A10001):** 120 units\n*   **Jewel Changi Airport Kit (A19400):** 87 units\n*   **Main Outlet Display (B20210):** 54 units",
  "usage": { "totalTokens": 1792 }
}
```

### Before/After comparison

| Metric | Globe3 BEFORE | AGRUN-256 AFTER | Delta |
|---|---|---|---|
| Duration | 60–90s | **6.8s** | ~10× faster |
| stepCount | 646–792 | **4** | ~170× fewer |
| finalAnswerSource | workspace_publish_candidate | **planner_finalize** | structural |
| usedRuntimeFinalize | false | **true** | audit restored |
| tokens (totalTokens) | 0/0 | **1792** | audit/billing restored |
| Output quality | fabricated "system unavailable" | real LLM-grounded markdown table with actual SKU + quantities | ground truth |

### Step ledger interpretation

`publishGateStep: false`, `plannerRepairStep: false`, `plannerInvalidStep: false` — the gate worked **silently**. The planner never attempted to emit `workspace_publish_candidate` because the catalog filter in `selectPlannerActions` hid the action upstream, and Gemini Flash-Lite picked a sensible action sequence (`list_agent_skills` → `use_agent_skill` → `execute_skill_tool`) without resorting to the publish escape hatch.

This is the **best-case path** for the gate: the planner never even has the option to misuse the action.

If a stronger lite-tier model (or one less inclined to follow the catalog) had hallucinated `workspace_publish_candidate` by name, the per-decision runtime guard in `action-loop-session-loop.js` would have caught it, routed through `handleInvalidPlannerDecision`, and the next planner cycle would have seen a `plannerInvalidSignal` carrying the "use finalize instead" directive. We did not observe this path in this run because Flash-Lite respected the catalog.

## Acceptance

- [x] `finalAnswerSource !== "workspace_publish_candidate"` — passed (`planner_finalize`).
- [x] `finalAnswerSource !== "continuation_required"` — passed (no maxSteps hit).
- [x] `cycleCount <= maxSteps` — passed (4 ≤ 20).
- [x] Real LLM tokens > 0 — passed (1792 total).
- [x] Output is grounded in real ERP tool data — passed (actual SKU + quantities echoed).

## Long-research regression check

To verify the gate does NOT block the legitimate long_research publish path, the existing 3000-word live runner was re-run on the same model. The bundled `deep-research-writer` agentSkill activates `isLongResearchRun(runState)` → gate defers → `workspace_publish_candidate` stays in the planner catalog.

Command (shorter 1500-word variant for faster verification):

```bash
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=low \
NODE_AGRUN_LIVE_WORDS=1500 \
NODE_AGRUN_LIVE_MAX_STEPS=60 \
node test/node-agrun-3000-live.mjs
```

Result (run 1, completed with exit code 0):

```json
{
  "candidateWords": 1535,
  "userGoalSatisfied": true,
  "qualityScore": {
    "score": 100,
    "maxScore": 100,
    "gates": { "length": true, "structure": true, "source": true }
  }
}
```

A repeat run (run 2) hit `max_steps_continuation` at cycle 60 because lite-tier model workspace_write stalled (`wmgEscalation=hard_veto at cycle 14`, candidate stuck at 1059 words). This is a known flash-lite ceiling documented in prior KB memos (`bc940294-…:14a7132f` — flash-lite vs flash-3.5 same wiring 1228 → 4765 words), not a regression from AGRUN-256. Crucially, the planner_decision telemetry from run 2 shows `terminalRepairActive=true` from cycle 11 onwards with the gate correctly **deferring to the terminalRepair surface** — `workspace_publish_candidate` was visible to the planner; it simply did not get chosen because the model emitted workspace_write/workspace_insert_after_section instead.

Conclusion: gate does not block legitimate long_research publish flow. Run 1 published-and-finalized normally at high quality; run 2 model-variability failure showed the gate correctly stepping aside when `terminalRepairState.active === true`.

## Reproduce

```bash
NODE_AGRUN_LIVE_PROVIDER=gemini \
NODE_AGRUN_LIVE_MODEL=gemini-3.1-flash-lite \
NODE_AGRUN_GEMINI_THINKING_LEVEL=low \
NODE_AGRUN_GATE_LIVE_MAX_STEPS=20 \
node test/node-agrun-publish-gate-live.mjs
```

Requires `GEMINI_API_KEY` in `.env.local`.

## Related

- AGRUN-256 ticket in [task.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/task.md) and [task.jsonl](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/task.jsonl).
- Feature toggle docs: [agrun_docs/feature-toggles.md — Publish Candidate Mode Gate](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/feature-toggles.md#publish-candidate-mode-gate).
- Globe3 reply draft: [agrun_docs/host-integrators/globe3-publish-candidate-gate-2026-05-26.md](https://github.com/yapweijun1996/agrun/blob/main/0_development/agrun_docs/live-tests/host-integrators/globe3-publish-candidate-gate-2026-05-26.md).
- KB write-up: production-agent-harness-for-agrun-js item `be30dcb9-3392-4142-9fd4-9706cbe0ff68`.
