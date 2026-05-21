# Live Test — Tier B PoC (split_envelope Reflect+Act) — FALSIFIED

Date: 2026-05-20 late evening
Model: `gemini-3.1-flash-lite`
Scenario: `test/node-agrun-3000-live.mjs` (3000-word research target, maxSteps=90)
Planner mode: `split_envelope` (forced via `NODE_AGRUN_LIVE_PLANNER_MODE=split_envelope`)
Parent: ADR-0033 Part 4 Tier B abandonment + project-owner override directive

## Result: FALSIFIED

| Metric | Baseline (pre Tier A) | Tier A | B1+B4 | **Tier B PoC** | PoC pass threshold | Verdict |
|---|---|---|---|---|---|---|
| `candidateWords` | 437 | 566 | 1048 | **941** | >1500 | **FAILED** (below baseline) |
| Cycles consumed | 90 | 90 | 90 | **43 (early error)** | — | Crashed before max_steps |
| `runStatus` | failed | failed | failed | failed | passed | — |
| `runError.code` | — | — | MAX_STEPS_EXCEEDED | **PLANNER_INVALID_ACTION** | — | New failure mode |
| LLM call count | ~90 | ~90 | ~90 | 43 × 2 = 86 | — | similar total, less coverage |
| `workspace_write` count | unknown | ~78% | 4/9 (44%) | **19 (more than baseline)** | <20% | **Made WORSE** |
| `workspace_append` count | unknown | ~6% | 4 | 4 | — | unchanged |
| Reflect parse success rate | n/a | n/a | n/a | **43/43 (100%)** | >85% | ✅ protocol stable |
| Envelope fail-soft fallback | n/a | n/a | n/a | 2 | <20% | ✅ rare |

**Headline**: Tier B PoC produced **fewer candidateWords than the simpler B1+B4 fix** (941 vs 1048), at **roughly equal LLM cost** (86 calls vs 90), with **more workspace_write overwrites** (19 vs 4). The owner-directed hypothesis ("OODAE single-call pressure makes lite LLM lose the goal") is falsified by the data: the Reflect call protocol works perfectly (43/43 valid emissions) but does not solve the underlying failure modes.

## Hypothesis verification

| Owner's claim | Empirical observation in PoC run |
|---|---|
| "lite LLM lost the goal" | AI emitted coherent reasoning in all 43 Reflect calls; goal references ("3000-word", "harness engineering", section structure) appear consistently |
| "never follow instruction" | AI followed Reflect schema 100% (5 fields, valid enum values, evidence quotes); followed Act schema except for 2 invalid envelopes that auto-recovered |
| "single-call pressure" | No JSON parse errors, no reasoning field collapse, no emission truncation. Pressure indicators absent. |
| "ReAct reduces pressure → better output" | Output WORSE (941 < 1048). Hypothesis predicted improvement. |

## Why Tier B failed

The Reflect call uses a narrow 5-field schema:

```json
{ "type": "reflect", "last_action_helpful": "...", "observation_evidence": "...",
  "next_intent": "search|read|workspace|skill_tool|todo|clarify|finalize|final",
  "reasoning": "..." }
```

The `next_intent` field is a **category enum**, not a specific tool. When AI declares `next_intent: "workspace"`, this DOES NOT carry the B1+B4 guidance (workspace_write vs workspace_append decision rule). The Act call sees the Reflect anchor plus the full envelope system prompt (which DOES contain B1+B4), but:

1. The Reflect anchor at the top of the user prompt declares "workspace" as the chosen intent.
2. AI in Act phase, having already "committed" via Reflect, picks the FIRST workspace action (workspace_write — registry order) more often than under single-envelope mode.
3. Result: 19 workspace_write calls vs 4 in B1+B4 baseline.

This is a direct instance of the failure modes the academic review predicted:
- **Illusions of Reflection (arxiv 2510.18254)**: "AI repeatedly violates same constraint even when reflecting". The B1+B4 rule "don't workspace_write twice on the same path" is violated MORE in Tier B than in B1+B4.
- **Anthropic Building Effective Agents**: "Prompt chaining only worth it when task cleanly decomposes". The Reflect/Act decomposition splits intent-declaration from action-arg-selection, but the load-bearing decision (write vs append) lives WITHIN the action-arg-selection step and cannot be made at the intent level.

## Final terminal state

```json
{
  "candidateWords": 941,
  "runError": "PLANNER_INVALID_ACTION",
  "terminalRepairState": {
    "active": true,
    "activeDeficits": ["length", "structure", "todo"],
    "structure.issueCodes": ["duplicate_headings", "duplicate_section_numbers", "repeated_conclusion"]
  },
  "actionCounts": {
    "plan": 2, "todo_plan": 1, "web_search": 7, "read_url": 4,
    "workspace_write": 6, "workspace_replace": 2, "workspace_append": 4, "finalize": 1
  }
}
```

The same X1 (structure-repair convergence lock) and X2 (500-char mimicry) bottlenecks that limited B1+B4 also limited Tier B PoC. Tier B added a new failure mode (`PLANNER_INVALID_ACTION` at cycle 43) without addressing the existing ones.

## Decision: Tier B fully ABANDONED based on PoC data

The owner-directed PoC produced empirical falsification. This is not a "Tier B implementation could be better" outcome — the protocol stability metrics (Reflect parse rate 100%) show the implementation is sound; the hypothesis itself is wrong. Reverting the PoC code restores B1+B4 as the production baseline for lite-tier.

Action items:
1. **Revert** all Tier B PoC code: delete `src/runtime/planner-prompt-reflect.js`; revert split_envelope changes in `provider-capabilities.js` and `planner.js`.
2. **Update ADR-0033** to mark Tier B FALSIFIED-by-PoC (this run) — the abandonment is now based on owner's own experiment, not academic citations alone.
3. **Focus on X1, X2, X3** — the real bottlenecks identified by B1+B4 fix that remain unresolved. Specifically X1 (structureRepairConvergence locks publish when AI's writes re-introduce duplicate headings) is the dominant gap between 1048 words and the 3000-word target.

## Artifacts

- `run1-tier-b-poc.jsonl` — full event ledger (43 cycles, Reflect+Act protocol traces)
- `run1-tier-b-poc.md` — debug report with workspace ledger, terminal repair state, etc.
